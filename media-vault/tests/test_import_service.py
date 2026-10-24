import base64
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from task_store import TaskStore
from site_adapters import BY_ID, parse_search, player_choices, parse_reader, inspect_source
from source_parser import SourceError
from run_import import validate_job, plan_sources
from test_vault_drive import FakeDrive, PHRASE
from vault_drive import VaultDrive


class StoreTests(unittest.TestCase):
    def test_restart_recovers_queue_without_plaintext_keys_and_idempotent_submit(self):
        with tempfile.TemporaryDirectory() as directory:
            store=TaskStore(directory)
            secret=base64.b64encode(b'x'*32).decode()
            task=store.add('owner',{'job':{'collection':'private title'},'vault_key':secret},'same-request-123456')
            duplicate=store.add('owner',{'vault_key':secret},'same-request-123456')
            self.assertEqual(task['id'],duplicate['id'])
            self.assertNotIn('vault_key',json.dumps(task))
            self.assertIsNone(store.get(task['id'],'other-owner'))
            store.setting('google:owner',{'refresh_token':'private-refresh-fixture'})
            store.update(task['id'],status='running',progress={'saved':1,'total':3})
            store.close()
            raw=(Path(directory)/'tasks.sqlite').read_bytes()
            for value in [secret.encode(),b'private-refresh-fixture',b'private title']:
                self.assertNotIn(value,raw)
            store=TaskStore(directory)
            claimed=store.next()
            self.assertEqual(claimed['id'],task['id'])
            self.assertEqual(claimed['progress']['saved'],1)
            self.assertIsNone(store.next(),'Claiming a task is atomic; a second worker cannot take it')
            store.update(task['id'],status='completed',forget_key=True)
            self.assertNotIn('vault_key',store.get(task['id'],private=True)['data'])
            self.assertIsNone(store.next())
            self.assertEqual((Path(directory)/'service.key').stat().st_mode&0o777,0o600)
            store.close()


class SiteAdapterTests(unittest.TestCase):
    def test_public_player_relay_and_modern_kodik_choices_preserve_the_selected_voice(self):
        root='https://yummyanime.tv/70-naruto.html'
        relay='https://yummyanime.tv/engine/ajax/controller.php?mod=player&id=70&slot=1'
        embed='https://kodikplayer.com/serial/10/hash0/720p'
        selected='https://kodikplayer.com/serial/12/hash2/720p'
        outer='<div data-player-anime-id="70"><div data-player-slot="1"></div></div>'
        choices='<div class="serial-translations-box"><select><option value="7" data-media-type="serial" data-media-id="11" data-media-hash="hash1" data-title="Studio A">Studio A (2 эп.)</option><option value="8" data-media-type="serial" data-media-id="12" data-media-hash="hash2" data-title="Studio B">Studio B (2 эп.)</option></select></div>'
        def episodes(identity):return f'<div class="serial-series-box"><select><option value="1" data-id="{identity}" data-hash="episodehash">1 серия</option></select></div>'
        pages={root:outer,relay:json.dumps({'status':True,'data':{'kind':'iframe','src':embed}}),embed:choices+episodes('101'),selected:choices+episodes('202')}
        class Http:
            def document(self,url,**kwargs):
                if url==selected:assert kwargs.get('headers',{}).get('Referer')==embed
                return pages[url],url,{}
        default=inspect_source(root,http=Http())
        self.assertEqual([x['name'] for x in default['dubs']],['Studio A','Studio B'])
        self.assertEqual(default['episodes'][0]['url'],'https://kodikplayer.com/seria/101/episodehash/720p')
        chosen=inspect_source(root,http=Http(),dub_url=selected)
        self.assertEqual(chosen['episodes'][0]['url'],'https://kodikplayer.com/seria/202/episodehash/720p')
        self.assertEqual(chosen['dubs'][1]['url'],selected)
        with self.assertRaises(SourceError):inspect_source(root,http=Http(),dub_url='https://unpublished.example.com/serial/999/hash/720p')
        dubs,seasons=player_choices('<div class="serial-translations-box"><select><option value="7">Numeric ID without a published player URL</option></select></div><div class="serial-seasons-box"><select><option value="2" data-serial-id="12" data-serial-hash="hash2">2 сезон</option></select></div>',embed)
        self.assertEqual(dubs,[]);self.assertEqual(seasons[0]['url'],selected)

    def test_each_site_reads_its_own_search_markup(self):
        fixtures={
            'yummy':'<div class="movie-item"><a href="/70-naruto.html"><img src="/poster.webp"><div class="movie-item__title">Наруто</div></a></div>',
            'animego':'<div class="animes-list-item"><div class="h5"><a href="/anime/naruto-1">Наруто</a></div></div>',
            'animevost':'<div class="shortstory"><div class="shortstoryHead"><h2><a href="/tip/tv/7-naruto.html">Наруто</a></h2></div></div>',
            'jutsu':'<a href="/naruto/"><div class="all_anime_global"><div class="aaname">Наруто</div></div></a>'}
        for identity,text in fixtures.items():
            with self.subTest(identity=identity):
                site=BY_ID[identity];results=parse_search(site,text,site.root,'Наруто')
                self.assertEqual(len(results),1);self.assertEqual(results[0]['title'],'Наруто')
                self.assertEqual(results[0]['dubs'],[],'Voice labels are not fabricated from the site name')
    def test_kodik_choices_and_reader_pages_use_only_ids_published_in_html(self):
        text='''<div class="serial-translations-box"><select><option value="7" data-id="111" data-hash="hash1">AniDub</option><option value="8" data-id="222" data-hash="hash2">Субтитры</option></select></div>'''
        dubs,seasons=player_choices(text,'https://kodikplayer.com/serial/3/h/720p')
        self.assertEqual([d['name'] for d in dubs],['AniDub','Субтитры'])
        self.assertEqual(dubs[1]['url'],'https://kodikplayer.com/serial/222/hash2/720p')
        self.assertEqual(seasons,[])
        pages,chapters=parse_reader('<script>rm_h.init([["https://images.example.com/","manga/","1.jpg"]]);</script><div class="chapters"><a href="/title/chapter-3">Глава 3</a></div>','https://readmanga.live/title')
        self.assertEqual(pages,['https://images.example.com/manga/1.jpg']);self.assertEqual(chapters[0]['number'],3)
    def test_v2_selection_never_invents_missing_episodes_and_retains_metadata(self):
        raw={'version':2,'library_id':'catalog-123','sources':['https://example.com/season'],'collection':'Тайтл','season':2,'episodes':'1-5','quality':'720','section':'anime','metadata':{'title':'Тайтл','cover':'https://example.com/a.jpg'},'dub':'AniDub','entries':[{'number':n,'url':f'https://example.com/episode-{n}','season':2} for n in [1,3,8]]}
        job=validate_job(raw);self.assertEqual([e['number'] for e in plan_sources(job,None)],[1,3]);self.assertEqual(job['metadata']['title'],'Тайтл')
        with self.assertRaises(SourceError):validate_job({**raw,'entries':[{'number':1,'url':'https://127.0.0.1/private'}]})
        drive=FakeDrive();vault=VaultDrive(drive,sleep=lambda _:None);library=vault.initialize(PHRASE);key=vault._key;vault.close();vault.unlock_key(library,key);self.assertEqual(vault.library_id,library)


class ApiTests(unittest.TestCase):
    def test_owner_can_save_private_google_configuration_encrypted_without_echo(self):
        from fastapi.testclient import TestClient
        import api
        secret='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e-0123456'
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'DATA_DIR':directory,'MEDIA_VAULT_DISABLE_WORKER':'1'}),patch.object(api,'CLIENT_SECRET',''),patch.object(api,'PUBLIC_URL','https://import.example.com'),patch.object(api,'REDIRECT','https://import.example.com/oauth/callback'):
            with TestClient(api.app) as client,patch.object(api,'google_user',return_value={'sub':'owner'}):
                body={'client_id':api.CLIENT_ID,'client_secret':secret}
                self.assertFalse(client.get('/health').json()['oauthConfigured'])
                self.assertEqual(client.post('/admin/google-oauth',json=body).status_code,401)
                session=client.post('/auth/session',headers={'Authorization':'Bearer google-fixture'}).json()
                headers={'Authorization':'Bearer '+session['token'],'Origin':api.ORIGIN}
                denied=client.post('/admin/google-oauth',headers={**headers,'Origin':'https://other.example.com'},json=body)
                self.assertEqual(denied.status_code,403)
                wrong=client.post('/admin/google-oauth',headers=headers,json={**body,'client_id':'another.apps.googleusercontent.com'})
                self.assertEqual(wrong.status_code,422);self.assertNotIn(secret,wrong.text)
                response=client.post('/admin/google-oauth',headers=headers,json=body)
                self.assertEqual(response.status_code,200);self.assertNotIn(secret,response.text)
                self.assertTrue(client.get('/health').json()['oauthConfigured'])
                self.assertNotIn(secret,client.get('/health').text)
                self.assertEqual(api.client_secret(),secret)
                self.assertEqual(client.post('/oauth/start',headers=headers).status_code,200)
            self.assertNotIn(secret.encode(),(Path(directory)/'tasks.sqlite').read_bytes())
            with TestClient(api.app) as client:
                self.assertTrue(client.get('/health').json()['oauthConfigured'],'Configuration survives a server restart')
                self.assertEqual(api.client_secret(),secret)

    def test_owner_auth_private_queue_and_no_credential_echo(self):
        from fastapi.testclient import TestClient
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'DATA_DIR':directory,'MEDIA_VAULT_DISABLE_WORKER':'1'}):
            import api
            with TestClient(api.app) as client,patch.object(api,'google_user',return_value={'sub':'owner','email':'fixture@example.test'}):
                self.assertEqual(client.get('/health').json()['worker'],'server')
                self.assertEqual(client.get('/jobs').status_code,401)
                session=client.post('/auth/session',headers={'Authorization':'Bearer google-fixture'}).json()
                headers={'Authorization':'Bearer '+session['token'],'Idempotency-Key':'request-fixture-12345'}
                api.store.setting('google:owner',{'refresh_token':'test-only-refresh'})
                key=base64.b64encode(b'v'*32).decode()
                job={'version':2,'library_id':'catalog-123','sources':['https://example.com/1.mp4'],'collection':'Тайтл','season':1,'episodes':'all','section':'anime'}
                response=client.post('/jobs',headers=headers,json={'job':job,'vault_key':key})
                self.assertEqual(response.status_code,202);task=response.json()
                self.assertNotIn(key,response.text);self.assertNotIn('vault_key',response.text)
                repeated=client.post('/jobs',headers=headers,json={'job':job,'vault_key':key});self.assertEqual(repeated.json()['id'],task['id'])
                self.assertEqual(len(client.get('/jobs',headers=headers).json()['jobs']),1)
                bad=client.post('/jobs',headers=headers,json={'job':job,'vault_key':key,'password':'must-never-be-echoed'})
                self.assertEqual(bad.status_code,422);self.assertNotIn('must-never-be-echoed',bad.text)
                denied=client.post('/jobs',headers={**headers,'Origin':'https://other.example.com'},json={'job':job,'vault_key':key});self.assertEqual(denied.status_code,403)
                cancelled=client.post('/jobs/'+task['id']+'/cancel',headers=headers).json();self.assertEqual(cancelled['status'],'cancelled')
                self.assertNotIn('vault_key',api.store.get(task['id'],private=True)['data'])
                with patch.object(api,'CLIENT_SECRET','oauth-test-fixture'),patch.object(api,'PUBLIC_URL','https://import.example.com'),patch.object(api,'REDIRECT','https://import.example.com/oauth/callback'):
                    from urllib.parse import urlsplit,parse_qs
                    login=client.post('/oauth/start',headers=headers).json()
                    parameters=parse_qs(urlsplit(login['url']).query)
                    self.assertEqual(parameters['code_challenge_method'],['S256'])
                    state=parameters['state'][0]
                    self.assertIsNotNone(api.store.setting('oauth:'+state))
                    with patch.object(api.requests,'post') as exchange:
                        exchange.return_value.json.return_value={'access_token':'oauth-access-fixture','refresh_token':'offline-refresh-fixture','scope':'openid https://www.googleapis.com/auth/drive'}
                        callback=client.get('/oauth/callback',params={'state':state,'code':'private-code-fixture'})
                    self.assertEqual(callback.status_code,200)
                    self.assertNotIn('private-code-fixture',callback.text);self.assertNotIn('offline-refresh-fixture',callback.text)
                    self.assertEqual(api.store.setting('google:owner')['refresh_token'],'offline-refresh-fixture')
                    self.assertEqual(client.get('/oauth/callback',params={'state':state,'code':'replayed'}).status_code,400)


if __name__=='__main__':unittest.main()
