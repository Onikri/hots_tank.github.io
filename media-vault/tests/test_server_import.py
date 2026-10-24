"""Real ffmpeg/AES-GCM fixtures with fake source HTTP and fake Drive, no accounts."""
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from source_parser import Page, SourceError, parse_page, playback_headers, public_url
from media_download import HlsDownload, download_episode, pick_stream, verify_video
from run_import import episode_selection, plan_sources, run_job, source_identity, validate_job
from vault_drive import VaultDrive, open_chunk
from test_vault_drive import FakeDrive, PHRASE


class FixtureHttp:
    def __init__(self, documents, media):
        self.documents, self.media, self.calls = documents, media, []

    def document(self, url, **options):
        self.calls.append(("document", url, options))
        if url not in self.documents:
            raise SourceError("Missing fixture document")
        return self.documents[url], url, {}

    def download(self, url, target, *, byte_range=None, maximum=None, **options):
        self.calls.append(("media", url, options))
        if url not in self.media:
            raise SourceError("Missing fixture segment")
        data = self.media[url]
        if byte_range:
            first, last = map(int, byte_range.removeprefix("bytes=").split("-"))
            data = data[first:last + 1]
        if maximum is not None and len(data) > maximum:
            raise SourceError("Fixture too large")
        Path(target).write_bytes(data)
        return len(data)


class ParserTests(unittest.TestCase):
    def test_page_extracts_only_published_episodes_and_real_sources(self):
        page = parse_page('''<title>Мой сезон</title>
          <a href="/show/episode-1">1 серия</a><a href="/show/episode-3">3 серия</a>
          <a href="/catalog/2026">2026</a><iframe data-src="//kodikplayer.com/serial/123/hash/720p"></iframe>
          <script>var x={file:"https:\\/\\/cdn.example.com/real.m3u8"}</script>''', 'https://anime.example.com/show/')
        self.assertEqual([entry['number'] for entry in page.episodes], [1, 3])
        self.assertEqual(page.players, ['https://kodikplayer.com/serial/123/hash/720p'])
        self.assertEqual(page.streams[0]['url'], 'https://cdn.example.com/real.m3u8')

    def test_kodik_episode_options_are_not_guessed_from_a_count(self):
        page = parse_page('''<div class="serial-series-box"><select>
          <option value="1" data-id="501" data-hash="aaa">1 серия</option>
          <option value="3" data-id="503" data-hash="ccc">3 серия</option></select></div>''',
                          'https://kodikplayer.com/serial/123/abc/720p')
        self.assertEqual([entry['number'] for entry in page.episodes], [1, 3])
        self.assertEqual(page.episodes[1]['url'], 'https://kodikplayer.com/seria/503/ccc/720p')

    def test_private_api_and_credentials_are_rejected(self):
        for url in ['http://example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
                    'https://user:pass@example.com/a', 'https://api.anilibria.app/x',
                    'https://example.com/api/v1/releases', 'https://example.com/graphql', 'https://thing.internal/a']:
            with self.subTest(url=url), self.assertRaises(SourceError):
                public_url(url, resolve_dns=False)
        headers = playback_headers({'Authorization': 'secret-google-token', 'Cookie': 'private-session',
                                    'Referer': 'https://example.com/'})
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('Cookie', headers)
        with self.assertRaises(SourceError):
            playback_headers({'Referer': 'https://example.com/\r\nAuthorization: secret'})
        with self.assertRaises(SourceError):
            parse_page('<title>Just a moment</title>', 'https://example.com/')

    def test_job_validation_and_resume_identity(self):
        job = {'version': 1, 'library_id': 'catalog-123', 'sources': ['https://example.com/season'],
               'collection': 'Сезон', 'episodes': '1,3-5', 'quality': '720', 'resume': True}
        self.assertEqual(validate_job(job)['selected'], {1, 3, 4, 5})
        for field in ['token', 'passphrase', 'key']:
            with self.assertRaises(SourceError):
                validate_job({**job, field: 'must-never-travel'})
        self.assertNotEqual(source_identity('https://example.com/embed/x?episode=1'),
                            source_identity('https://example.com/embed/x?episode=2'))
        self.assertEqual(source_identity('https://example.com/embed/x?episode=1&token=old'),
                         source_identity('https://example.com/embed/x?token=new&episode=1'))
        with self.assertRaises(SourceError):
            episode_selection('9-1')

    def test_plan_filters_actual_published_series(self):
        class Resolver:
            def inspect(self, url):
                return Page(title='Сезон', episodes=[{'number': n, 'url': f'https://example.com/episode-{n}'} for n in [1, 3, 8]])
        job = validate_job({'version': 1, 'library_id': 'catalog-123', 'sources': ['https://example.com/season'],
                            'episodes': '1-5', 'quality': '720'})
        self.assertEqual([entry['number'] for entry in plan_sources(job, Resolver())], [1, 3])
        job['selected'] = {2}
        with self.assertRaises(SourceError):
            plan_sources(job, Resolver())


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg is required')
class ServerMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.fixtures = {}
        for kind in ['ts', 'fmp4', 'range']:
            directory = cls.root / kind
            directory.mkdir()
            args = ['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2.4',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls',
                    '-hls_time', '1', '-hls_playlist_type', 'vod']
            if kind != 'ts':
                args += ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4']
            if kind == 'range':
                args += ['-hls_flags', 'single_file']
            args += ['-hls_segment_filename', str(directory / ('part.m4s' if kind == 'range' else 'part-%d.' + ('ts' if kind == 'ts' else 'm4s'))),
                     str(directory / 'index.m3u8')]
            subprocess.run(args, check=True, capture_output=True)
            base = 'https://cdn.example.com/' + kind + '/'
            cls.fixtures[kind] = FixtureHttp({base + 'index.m3u8': (directory / 'index.m3u8').read_text()},
                                            {base + file.name: file.read_bytes() for file in directory.iterdir() if file.suffix != '.m3u8'})

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_real_ts_and_fmp4_and_byte_ranges_become_valid_mp4(self):
        for kind, http in self.fixtures.items():
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                commands = []
                def run(args, **options):
                    commands.append(args)
                    self.assertFalse(any(str(arg).startswith(('https:', 'http:')) for arg in args), 'ffmpeg sees only local files')
                    return subprocess.run(args, **options)
                output = download_episode({'type': 'hls', 'url': f'https://cdn.example.com/{kind}/index.m3u8'},
                                          directory, http=http, run=run)
                info = verify_video(output)
                self.assertGreater(float(info['format']['duration']), 2)
                self.assertTrue(any(stream['codec_type'] == 'audio' for stream in info['streams']))
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(output), '-f', 'null', '-'],
                               capture_output=True, check=True)
                self.assertGreater(len(commands), 1)

    def test_master_selects_real_quality_and_preserves_alternate_audio(self):
        http = copy.deepcopy(self.fixtures['ts'])
        http.documents['https://cdn.example.com/master.m3u8'] = '''#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ru",NAME="Russian",DEFAULT=YES,URI="ts/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=854x480,AUDIO="ru"
ts/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x1080
unavailable.m3u8
'''
        with tempfile.TemporaryDirectory() as directory:
            output = download_episode({'type': 'hls', 'url': 'https://cdn.example.com/master.m3u8'}, directory, http=http, quality='720')
            self.assertTrue(output.exists())
            self.assertFalse(any('unavailable' in call[1] for call in http.calls))

    def test_drm_and_live_and_missing_segments_never_publish(self):
        for text in ['#EXTM3U\n#EXTINF:1,\na.ts\n',
                     '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n',
                     '#EXTM3U\n#EXTINF:1,\nmissing.ts\n#EXT-X-ENDLIST\n']:
            http = FixtureHttp({'https://example.com/list.m3u8': text}, {})
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(SourceError):
                HlsDownload(http, directory).materialize('https://example.com/list.m3u8')

    def test_full_server_import_encrypts_to_drive_then_resumes_without_media_transfer(self):
        drive = FakeDrive()
        vault = VaultDrive(drive, sleep=lambda _: None)
        library = vault.initialize(PHRASE)
        http = copy.deepcopy(self.fixtures['ts'])
        class Resolver:
            def __init__(self):
                self.http, self.resolves = http, 0
            def inspect(self, url):
                return Page(title='Тестовый сезон', episodes=[{'number': 1, 'url': 'https://example.com/episode-1'}])
            def resolve(self, url):
                self.resolves += 1
                return Page(streams=[{'type': 'hls', 'url': 'https://cdn.example.com/ts/index.m3u8', 'quality': 480}])
        resolver = Resolver()
        job = {'version': 1, 'library_id': library, 'sources': ['https://example.com/season'], 'collection': 'Тестовый сезон', 'quality': '720'}
        logs = []
        try:
            first = run_job(job, vault, resolver=resolver, log=logs.append)
            self.assertEqual(first, {'saved': 1, 'skipped': 0, 'failed': 0})
            item = vault.refresh()['items'][0]
            raw = b''.join(open_chunk(drive.download(chunk['fileId']), vault._key, item['id'], n, chunk['iv'])
                           for n, chunk in enumerate(item['chunks']))
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'decrypted.mp4'
                path.write_bytes(raw)
                verify_video(path)
            for remote in drive.files.values():
                self.assertNotIn('Тестовый сезон', remote['name'])
                if remote['name'].startswith('part-'):
                    self.assertNotIn(b'ftyp', remote['data'][:32])
            count = len(http.calls)
            second = run_job(job, vault, resolver=resolver, log=logs.append)
            self.assertEqual(second, {'saved': 0, 'skipped': 1, 'failed': 0})
            self.assertEqual(len(http.calls), count, 'resume does not fetch any video again')
            self.assertEqual(resolver.resolves, 1)
            self.assertFalse(any(PHRASE in line for line in logs))
            third = run_job({**job, 'season': 2}, vault, resolver=resolver, log=logs.append)
            self.assertEqual(third, {'saved': 1, 'skipped': 0, 'failed': 0})
            catalog = vault.refresh()
            self.assertEqual(len(catalog['storage']['collections']), 1)
            self.assertEqual([part['name'] for part in catalog['storage']['collections'][0]['parts']], ['Сезон 1', 'Сезон 2'])
            self.assertEqual([item['season'] for item in catalog['items']], [1, 2])
            metadata={'title':'Тестовый сезон','cover':'https://images.example.com/poster.jpg','description':'Private title description','genres':['Action'],'age':13}
            fourth=run_job({**job,'version':2,'season':3,'section':'anime','metadata':metadata,'dub':'Fixture Studio',
                            'entries':[{'number':1,'url':'https://example.com/episode-1','season':3}]},vault,resolver=resolver,log=logs.append)
            self.assertEqual(fourth['saved'],1)
            catalog=vault.refresh()
            self.assertEqual(catalog['storage']['collections'][0]['metadata'],metadata)
            self.assertEqual(catalog['items'][-1]['dub'],'Fixture Studio')
            self.assertNotIn(b'Private title description',drive.download(library))
        finally:
            vault.close()


if __name__ == '__main__':
    unittest.main()
