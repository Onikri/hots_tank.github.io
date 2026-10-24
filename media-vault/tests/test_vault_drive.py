"""Offline server uploader tests. No Google credentials, account, or network are used."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "server" / "vault_drive.py"
spec = importlib.util.spec_from_file_location("vault_drive_under_test", MODULE)
vault_drive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = vault_drive
spec.loader.exec_module(vault_drive)
PHRASE = "MediaVault test фраза 🔒"


class RemoteError(Exception):
    def __init__(self, status):
        super().__init__("fake Drive error")
        self.status = status


class FakeDrive:
    def __init__(self, email="roma.shevchenko2020@gmail.com", etags=True):
        self.email, self.etags = email, etags
        self.files, self.next_id = {}, 0
        self.upload_calls, self.patches, self.trashed = [], [], []
        self.fail_parts = False
        self.lose_part_response = False
        self.fail_patch = False
        self.before_patch = None
        self.after_manifest_metadata = None
        self.manifest_written = False
        self.metadata_reads_after_manifest = 0
        self.list_calls = 0

    def owner_email(self):
        return self.email

    def allocate_id(self):
        self.next_id += 1
        return "file-" + str(self.next_id)

    def _create(self, file_id, name, parent, mime_type, data=b""):
        if file_id in self.files:
            raise RemoteError(409)
        self.files[file_id] = {
            "id": file_id, "name": name, "mimeType": mime_type,
            "parents": [parent] if parent else [], "data": bytes(data), "version": 1,
            "ownedByMe": True, "capabilities": {"canEdit": True}, "trashed": False,
        }
        return {"id": file_id}

    def create_folder(self, file_id, name, parent=None):
        return self._create(file_id, name, parent, vault_drive.FOLDER_MIME)

    def metadata(self, file_id):
        if self.manifest_written and self.files[file_id]["name"] == "vault-catalog.enc.json":
            self.metadata_reads_after_manifest += 1
            if self.after_manifest_metadata:
                self.after_manifest_metadata(self.metadata_reads_after_manifest)
        metadata = {k: copy.deepcopy(v) for k, v in self.files[file_id].items() if k != "data"}
        if self.etags:
            metadata["_etag"] = '"v' + str(metadata["version"]) + '"'
        return metadata

    def download(self, file_id):
        return self.files[file_id]["data"]

    def upload_bytes(self, file_id, name, data, parent):
        self.upload_calls.append((file_id, name))
        if name.startswith("part-") and self.fail_parts:
            raise RemoteError(403)
        result = self._create(file_id, name, parent, vault_drive.BINARY_MIME, data)
        if name == "manifest.enc.json":
            self.manifest_written = True
            self.metadata_reads_after_manifest = 0
        if name.startswith("part-") and self.lose_part_response:
            self.lose_part_response = False
            raise RemoteError(503)
        return result

    def replace_bytes(self, file_id, data, *, etag=None):
        if self.before_patch:
            callback, self.before_patch = self.before_patch, None
            callback()
        if etag and etag != self.metadata(file_id).get("_etag"):
            raise RemoteError(412)
        if self.fail_patch:
            raise RemoteError(503)
        self.patches.append({"id": file_id, "etag": etag})
        self.files[file_id]["data"] = bytes(data)
        self.files[file_id]["version"] += 1
        return {"id": file_id}

    def trash(self, file_id):
        self.trashed.append(file_id)
        self.files[file_id]["trashed"] = True

    def list_children(self, parent, *, name=None, mime_type=None):
        self.list_calls += 1
        return [self.metadata(file_id) for file_id, entry in self.files.items()
                if parent in entry["parents"] and not entry["trashed"]
                and (name is None or entry["name"] == name)
                and (mime_type is None or entry["mimeType"] == mime_type)]


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.drive = FakeDrive()
        self.vault = vault_drive.VaultDrive(self.drive, sleep=lambda _: None)
        self.library = self.vault.initialize(PHRASE)

    def tearDown(self):
        self.vault.close()
        self.directory.cleanup()

    def file(self, name="private episode.mp4", size=31):
        path = Path(self.directory.name) / name
        path.write_bytes(bytes((index * 31 + 7) % 251 for index in range(size)))
        return path

    def remote_catalog(self):
        return vault_drive.open_catalog(json.loads(self.drive.download(self.library)), self.vault._key)

    def mutate_remote(self, change):
        catalog = self.remote_catalog()
        change(catalog)
        self.drive.files[self.library]["data"] = vault_drive._json(
            vault_drive.seal_catalog(catalog, self.vault._key, self.vault._salt))
        self.drive.files[self.library]["version"] += 1

    def test_admin_identity_checked_before_any_write(self):
        wrong = FakeDrive(email="somebody@example.test")
        with self.assertRaises(vault_drive.VaultError):
            vault_drive.VaultDrive(wrong)
        self.assertEqual(wrong.upload_calls, [])
        self.assertEqual(wrong.files, {})
        self.assertNotIn(self.vault._key.hex(), repr(self.vault))

    def test_season_reuses_recovery_manifest_scan(self):
        self.vault.upload_file(self.file(), collection="Season", episode=1, source_identity="episode-one")
        first_scan_calls = self.drive.list_calls
        self.assertGreater(first_scan_calls, 0)
        self.vault.upload_file(self.file("second.mp4"), collection="Season", episode=2, source_identity="episode-two")
        self.assertEqual(self.drive.list_calls, first_scan_calls,
                         "new episodes must not rescan every prior asset in the season")

    def test_private_initialization_and_phrase_unlock(self):
        root = self.drive.files[self.vault.catalog["folderId"]]
        self.assertEqual(root["parents"], [])
        self.assertEqual(root["mimeType"], vault_drive.FOLDER_MIME)
        other = vault_drive.VaultDrive(self.drive, sleep=lambda _: None)
        with self.assertRaises(Exception):
            other.unlock(self.library, "a deliberately wrong phrase")
        self.assertEqual(other.unlock(self.library, PHRASE), self.library)
        self.assertEqual(other.catalog["items"], [])
        other.close()
        self.assertIsNone(other._key)

    def test_nested_seasons_recover_without_losing_an_existing_season(self):
        first = self.vault.upload_file(self.file(), collection="Наруто", section="anime", part="Сезон 1", season=1,
                                       episode=1, source_identity="first-season")
        self.drive.fail_patch = True
        with self.assertRaises(vault_drive.RecoverableUploadError):
            self.vault.upload_file(self.file("second.mp4"), collection="Наруто", section="anime", part="Сезон 2", season=2,
                                   episode=1, source_identity="second-season")
        self.drive.fail_patch = False
        resumed = vault_drive.VaultDrive(self.drive, sleep=lambda _: None)
        try:
            resumed.unlock(self.library, PHRASE)
            recovered = resumed.completed("second-season", collection="Наруто", episode=1)
            catalog = resumed.refresh()
            self.assertEqual(len(catalog["items"]), 2)
            self.assertEqual(len(catalog["storage"]["collections"]), 1)
            group = catalog["storage"]["collections"][0]
            self.assertEqual([part["name"] for part in group["parts"]], ["Сезон 1", "Сезон 2"])
            self.assertEqual(first["collectionId"], recovered["collectionId"])
            self.assertNotEqual(first["partId"], recovered["partId"])
            self.assertEqual(self.drive.files[group["folderId"]]["parents"], [catalog["storage"]["sectionFolders"]["anime"]])
            self.assertEqual(self.drive.files[recovered["folderId"]]["parents"], [group["parts"][1]["folderId"]])
        finally:
            resumed.close()

    def test_real_chunks_folder_structure_and_existing_fields_preserved(self):
        self.mutate_remote(lambda catalog: catalog.update({
            "entries": [{"id": 52991, "title": "private saved metadata"}],
            "custom": {"untouched": True},
            "items": [{"id": "legacy", "name": "old.txt", "category": "book", "size": 1, "chunks": []}],
        }))
        path = self.file(size=2 * vault_drive.CHUNK_SIZE + 19)
        item = self.vault.upload_file(
            path, collection="Private series season", episode=7,
            source_identity="https://public.example/series/page?temporary=secret", metadata_id=52991)
        self.assertEqual(item["size"], path.stat().st_size)
        ciphertexts = [self.drive.download(chunk["fileId"]) for chunk in item["chunks"]]
        self.assertEqual(list(map(len, ciphertexts)),
                         [vault_drive.CHUNK_SIZE + 16, vault_drive.CHUNK_SIZE + 16, 35])
        plain = b"".join(vault_drive.open_chunk(
            data, self.vault._key, item["id"], index, item["chunks"][index]["iv"])
            for index, data in enumerate(ciphertexts))
        self.assertEqual(plain, path.read_bytes())
        self.assertEqual(item["sha256"], hashlib.sha256(plain).hexdigest())
        self.assertEqual(len({chunk["iv"] for chunk in item["chunks"]}), 3)
        catalog = self.remote_catalog()
        self.assertTrue(catalog["custom"]["untouched"])
        self.assertEqual(catalog["items"][0]["id"], "legacy")
        self.assertEqual(catalog["entries"][0]["id"], 52991)
        storage = catalog["storage"]
        media_id = storage["mediaFolders"]["video"]
        collection = storage["collections"][0]
        self.assertEqual(self.drive.files[media_id]["name"], "Видео")
        self.assertEqual(self.drive.files[collection["folderId"]]["parents"], [media_id])
        self.assertRegex(self.drive.files[collection["folderId"]]["name"], r"^collection-[0-9a-f-]{36}$")
        self.assertEqual(self.drive.files[item["folderId"]]["parents"], [collection["folderId"]])
        self.assertRegex(self.drive.files[item["folderId"]]["name"], r"^asset-[0-9a-f-]{36}$")
        remote_names = [entry["name"] for entry in self.drive.files.values()]
        self.assertNotIn(path.name, remote_names)
        self.assertNotIn("Private series season", remote_names)
        self.assertNotIn("temporary", json.dumps(catalog))
        self.assertEqual(item["metadataId"], 52991)
        self.assertEqual(self.drive.patches[-1]["etag"][:2], '"v')
        with self.assertRaises(Exception):
            vault_drive.open_chunk(ciphertexts[0], self.vault._key, item["id"], 1, item["chunks"][0]["iv"])

    def test_retry_with_generated_id_does_not_duplicate_lost_response_chunk(self):
        self.drive.lose_part_response = True
        item = self.vault.upload_file(self.file(), collection="Series", episode=1, source_identity="stable:series")
        parts = [entry for entry in self.drive.files.values() if entry["name"].startswith("part-")]
        self.assertEqual(len(parts), 1)
        self.assertEqual(item["chunks"][0]["fileId"], parts[0]["id"])
        chunk_calls = [file_id for file_id, name in self.drive.upload_calls if name.startswith("part-")]
        self.assertEqual(len(chunk_calls), 2)
        self.assertEqual(chunk_calls[0], chunk_calls[1])

    def test_completed_fingerprint_resumes_without_reuploading_signed_source(self):
        path = self.file()
        item = self.vault.upload_file(path, collection="Series", episode=1,
                                     source_identity="https://public.example/page?token=first")
        count = len(self.drive.upload_calls)
        resumed = self.vault.upload_file(path, collection="Series", episode=1,
                                        source_identity="https://public.example/page?token=renewed")
        self.assertEqual(resumed["id"], item["id"])
        self.assertEqual(len(self.drive.upload_calls), count)
        self.assertIsNone(self.vault.completed("https://public.example/page", collection="Series", episode=2))

    def test_failed_incomplete_asset_is_trashed_without_catalog_item(self):
        self.drive.fail_parts = True
        with self.assertRaises(RemoteError):
            self.vault.upload_file(self.file(), collection="Series")
        self.assertEqual(self.remote_catalog()["items"], [])
        assets = [entry for entry in self.drive.files.values() if entry["name"].startswith("asset-")]
        self.assertEqual(len(assets), 1)
        self.assertTrue(assets[0]["trashed"])
        self.assertFalse(any(entry["name"] == "manifest.enc.json" for entry in self.drive.files.values()))

    def test_encrypted_manifest_recovers_after_failed_catalog_write_without_etag(self):
        self.drive.etags = False
        self.drive.fail_patch = True
        with self.assertRaises(vault_drive.RecoverableUploadError):
            self.vault.upload_file(self.file(), collection="Series", episode=4, source_identity="stable:series")
        self.assertEqual(self.remote_catalog()["items"], [])
        manifests = [entry for entry in self.drive.files.values() if entry["name"] == "manifest.enc.json"]
        self.assertEqual(len(manifests), 1)
        manifest = vault_drive.open_catalog(json.loads(manifests[0]["data"]), self.vault._key)
        self.assertEqual(manifest["checkpoint"], "asset-v1")
        self.assertEqual(manifest["items"][0]["episode"], 4)
        count = len(self.drive.upload_calls)
        self.drive.fail_patch = False
        resumed = vault_drive.VaultDrive(self.drive, sleep=lambda _: None)
        resumed.unlock(self.library, PHRASE)
        item = resumed.completed("stable:series", collection="Series", episode=4)
        self.assertEqual(item["id"], manifest["items"][0]["id"])
        self.assertEqual(len(self.drive.upload_calls), count)
        self.assertEqual(self.remote_catalog()["items"][0]["id"], item["id"])
        resumed.close()

    def test_etag_conflict_reloads_and_merges_other_catalog_changes(self):
        self.drive.before_patch = lambda: self.mutate_remote(
            lambda catalog: catalog.update({"entries": [{"id": 11, "title": "concurrent metadata"}]}))
        self.vault.upload_file(self.file(), collection="Series")
        self.assertEqual(self.remote_catalog()["entries"][0]["id"], 11)
        self.assertEqual(len(self.remote_catalog()["items"]), 1)

    def test_no_etag_fallback_rechecks_version_and_keeps_intervening_metadata(self):
        self.drive.etags = False
        def race(read_count):
            if read_count == 3:
                self.drive.after_manifest_metadata = None
                self.mutate_remote(lambda catalog: catalog.update({"custom": {"parallel": "retained"}}))
        self.drive.after_manifest_metadata = race
        self.vault.upload_file(self.file(), collection="Series")
        self.assertEqual(self.remote_catalog()["custom"]["parallel"], "retained")
        self.assertIsNone(self.drive.patches[-1]["etag"])

    def test_strict_mode_is_explicit_and_retains_complete_asset_checkpoint(self):
        self.drive.etags = False
        self.vault.require_etag = True
        with self.assertRaises(vault_drive.RecoverableUploadError):
            self.vault.upload_file(self.file(), collection="Series")
        self.assertEqual(self.remote_catalog()["items"], [])
        self.assertTrue(any(entry["name"] == "manifest.enc.json" for entry in self.drive.files.values()))


class InteroperabilityTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the actual browser crypto.js test")
    def test_python_and_actual_browser_crypto_js_decrypt_each_other(self):
        salt = bytes(range(16))
        key = vault_drive.derive_key(PHRASE, salt)
        self.assertEqual(hashlib.sha256(key).hexdigest(),
                         "79c86f10384b9da5e2578b7895309e16d3c90cb4552fa0b29adea1dbf3cbd779")
        plain = b"MediaVault Python and browser\x00chunk"
        catalog = {"version": 1, "folderId": "root-test", "items": [
            {"id": "fixture", "name": "Проверка 🔒.mp4", "category": "video", "chunks": []}
        ], "entries": [{"id": 52991, "title": "Названия остаются зашифрованными"}]}
        envelope = vault_drive.seal_catalog(catalog, key, salt, iv=bytes(range(12)))
        chunk = vault_drive.seal_chunk(plain, key, "fixture", 0, iv=bytes(range(12, 24)))
        fixture = {"phrase": PHRASE, "salt": vault_drive._b64(salt), "envelope": envelope,
                   "chunk": {"ciphertext": vault_drive._b64(chunk["ciphertext"]), "iv": chunk["iv"]}}
        crypto_path = MODULE.parent.parent / "crypto.js"
        script = r"""
import fs from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const lib=await import(process.argv[1]);
const f=JSON.parse(fs.readFileSync(0,'utf8'));
const salt=lib.base64ToBytes(f.salt),key=await lib.deriveVaultKey(f.phrase,salt);
const catalog=await lib.openIndex(f.envelope,key);
const raw=await lib.openChunk(lib.base64ToBytes(f.chunk.ciphertext),key,'fixture',0,f.chunk.iv);
const chunk=await lib.sealChunk(raw,key,'fixture',0);
process.stdout.write(JSON.stringify({
  catalog,digest:createHash('sha256').update(Buffer.from(raw)).digest('hex'),
  envelope:await lib.sealIndex(catalog,key,salt),
  chunk:{ciphertext:lib.bytesToBase64(chunk.ciphertext),iv:chunk.iv},
  extractable:key.extractable
}));
"""
        process = subprocess.run(
            ["node", "--input-type=module", "-e", script, crypto_path.as_uri()],
            input=json.dumps(fixture), text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(result["catalog"], catalog)
        self.assertEqual(result["digest"], "e206c1ef48eee0697e25f4c37fd4766be6ee61c5cf1db58624a2476e34cec995")
        self.assertFalse(result["extractable"])
        self.assertEqual(vault_drive.open_catalog(result["envelope"], key), catalog)
        self.assertEqual(vault_drive.open_chunk(
            vault_drive._unb64(result["chunk"]["ciphertext"]), key, "fixture", 0, result["chunk"]["iv"]), plain)


if __name__ == "__main__":
    unittest.main()
