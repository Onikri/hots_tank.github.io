"""Server-to-Drive MediaVault uploader; credentials and keys remain in process memory.

Google imports are lazy. Authenticate the notebook with its normal user account
before constructing GoogleDriveAdapter.from_adc(). No service-account JSON or
OAuth client secret is accepted by this module.

Drive v3 does not promise a Files.etag field. Catalog writes therefore reload,
merge, recheck version, write and read back. If an HTTP ETag is returned it is
also sent as If-Match, but simultaneous browser/server edits are not claimed to
be atomic. Each completed asset has an encrypted recovery manifest.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import mimetypes
import os
import random
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CHUNK_SIZE = 4 * 1024 * 1024
KDF = "PBKDF2-SHA256-310000"
CATALOG_AAD = b"mediavault-catalog-v1"
ADMIN_EMAIL_SHA256 = "4aeabbd305272323d256ba5fff0d7783536729bda8b1b06befeb0cea19f29b7c"
FOLDER_MIME = "application/vnd.google-apps.folder"
BINARY_MIME = "application/octet-stream"
CATEGORIES = {"video", "audio", "book", "manga", "image"}


class VaultError(RuntimeError):
    pass


class ConcurrentUpdateError(VaultError):
    pass


class RecoverableUploadError(VaultError):
    """A complete encrypted asset exists and can be recovered from its manifest."""


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value, validate=True)


def _json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def derive_key(passphrase: str, salt: bytes) -> bytes:
    # JavaScript String.length counts UTF-16 code units, including emoji pairs.
    if not isinstance(passphrase, str) or len(passphrase.encode("utf-16-le")) // 2 < 12:
        raise VaultError("The secret phrase must contain at least 12 characters.")
    if len(salt) != 16:
        raise VaultError("Invalid vault salt.")
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, 310000, dklen=32)


def seal_chunk(raw: bytes, key: bytes, item_id: str, index: int, *, iv=None) -> dict:
    nonce = os.urandom(12) if iv is None else iv
    if len(nonce) != 12:
        raise VaultError("Invalid chunk nonce.")
    data = AESGCM(key).encrypt(nonce, raw, f"{item_id}:{index}".encode("utf-8"))
    return {"ciphertext": data, "iv": _b64(nonce)}


def open_chunk(ciphertext: bytes, key: bytes, item_id: str, index: int, iv: str) -> bytes:
    return AESGCM(key).decrypt(_unb64(iv), ciphertext, f"{item_id}:{index}".encode("utf-8"))


def seal_catalog(catalog: dict, key: bytes, salt: bytes, *, iv=None) -> dict:
    nonce = os.urandom(12) if iv is None else iv
    ciphertext = AESGCM(key).encrypt(nonce, _json(catalog), CATALOG_AAD)
    return {"version": 1, "kdf": KDF, "salt": _b64(salt), "iv": _b64(nonce), "data": _b64(ciphertext)}


def open_catalog(envelope: dict, key: bytes) -> dict:
    if envelope.get("version") != 1 or envelope.get("kdf") != KDF:
        raise VaultError("Unsupported encrypted catalog format.")
    catalog = json.loads(AESGCM(key).decrypt(
        _unb64(envelope["iv"]), _unb64(envelope["data"]), CATALOG_AAD))
    if not isinstance(catalog.get("items"), list) or not catalog.get("folderId"):
        raise VaultError("Invalid catalog.")
    return catalog


def source_fingerprint(source_identity: str, *, collection="", episode=None, category="video") -> str:
    """Hash stable identity; URL query strings/fragments (signed CDN tokens) are discarded."""
    identity = str(source_identity).strip()
    if not identity or len(identity) > 16384:
        raise VaultError("A stable source identity is required for resume.")
    if identity.startswith(("https://", "http://")):
        parsed = urlsplit(identity)
        identity = urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, "", ""))
    return hashlib.sha256(_json({
        "source": identity, "collection": collection, "episode": episode, "category": category
    })).hexdigest()


def _status(error) -> int | None:
    value = getattr(error, "status", None)
    if value is None:
        value = getattr(getattr(error, "resp", None), "status", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _transient(error) -> bool:
    status = _status(error)
    return status in {408, 429, 500, 502, 503, 504} or (
        status == 403 and ("rateLimitExceeded" in str(error) or "userRateLimitExceeded" in str(error))
    ) or isinstance(error, (TimeoutError, ConnectionError, OSError))


class GoogleDriveAdapter:
    """Small Drive API v3 adapter; fake adapters implement the same methods in tests."""

    def __init__(self, service):
        self.service = service

    @classmethod
    def from_adc(cls, credentials=None):
        if credentials is None:
            import google.auth
            credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive"])
        if getattr(credentials, "service_account_email", None):
            raise VaultError("Use the owner's normal Google user account.")
        from googleapiclient.discovery import build
        return cls(build("drive", "v3", credentials=credentials, cache_discovery=False))

    @staticmethod
    def _execute(request):
        headers = {}
        if hasattr(request, "add_response_callback"):
            request.add_response_callback(lambda response: headers.update(dict(response)))
        result = request.execute(num_retries=0)
        if isinstance(result, dict):
            result = dict(result)
            etag = headers.get("etag") or headers.get("ETag")
            if etag:
                result["_etag"] = etag
        return result

    def owner_email(self):
        return self._execute(self.service.about().get(fields="user(emailAddress)"))["user"]["emailAddress"]

    def allocate_id(self):
        return self._execute(self.service.files().generateIds(count=1, space="drive", type="files"))["ids"][0]

    def metadata(self, file_id):
        return self._execute(self.service.files().get(
            fileId=file_id, fields="id,name,mimeType,version,parents,ownedByMe,capabilities(canEdit),trashed"))

    def download(self, file_id):
        return self._execute(self.service.files().get_media(fileId=file_id))

    def create_folder(self, file_id, name, parent=None):
        body = {"id": file_id, "name": name, "mimeType": FOLDER_MIME}
        if parent:
            body["parents"] = [parent]
        return self._execute(self.service.files().create(body=body, fields="id,version"))

    @staticmethod
    def _media(data):
        from googleapiclient.http import MediaIoBaseUpload
        return MediaIoBaseUpload(io.BytesIO(data), mimetype=BINARY_MIME, resumable=False)

    def upload_bytes(self, file_id, name, data, parent):
        return self._execute(self.service.files().create(
            body={"id": file_id, "name": name, "mimeType": BINARY_MIME, "parents": [parent]},
            media_body=self._media(data), fields="id,version"))

    def replace_bytes(self, file_id, data, *, etag=None):
        request = self.service.files().update(
            fileId=file_id, media_body=self._media(data), fields="id,version")
        if etag:
            request.headers["If-Match"] = etag
        return self._execute(request)

    def trash(self, file_id):
        return self._execute(self.service.files().update(
            fileId=file_id, body={"trashed": True}, fields="id,trashed"))

    def list_children(self, parent, *, name=None, mime_type=None):
        quote = lambda text: str(text).replace("\\", "\\\\").replace("'", "\\'")
        query = f"'{quote(parent)}' in parents and trashed = false"
        if name is not None:
            query += f" and name = '{quote(name)}'"
        if mime_type is not None:
            query += f" and mimeType = '{quote(mime_type)}'"
        result, page = [], None
        while True:
            data = self._execute(self.service.files().list(
                q=query, fields="nextPageToken,files(id,name,mimeType)", pageSize=1000, pageToken=page))
            result.extend(data.get("files", []))
            page = data.get("nextPageToken")
            if not page:
                return result


class VaultDrive:
    def __init__(self, drive, *, retry_attempts=5, sleep=time.sleep, require_etag=False):
        self.drive = drive
        self.retry_attempts = max(1, int(retry_attempts))
        self._sleep = sleep
        self.require_etag = bool(require_etag)
        self.library_id = None
        self.catalog = None
        self._key = None
        self._salt = None
        self._manifest_cache = None
        email = self._retry(self.drive.owner_email)
        digest = hashlib.sha256(str(email).strip().lower().encode("utf-8")).hexdigest()
        if digest != ADMIN_EMAIL_SHA256:
            raise VaultError("The connected Google account is not the configured MediaVault administrator.")

    def __repr__(self):
        return f"<VaultDrive unlocked={self._key is not None}>"

    def _retry(self, operation):
        for attempt in range(self.retry_attempts):
            try:
                return operation()
            except Exception as error:
                if attempt + 1 == self.retry_attempts or not _transient(error):
                    raise
                self._sleep(min(8, 0.4 * 2 ** attempt) + random.random() * 0.2)

    def _new_folder(self, name, parent=None):
        file_id = self._retry(self.drive.allocate_id)
        def create():
            try:
                self.drive.create_folder(file_id, name, parent)
            except Exception as error:
                if _status(error) != 409:
                    raise
                metadata = self._retry(lambda: self.drive.metadata(file_id))
                if metadata.get("name") != name or metadata.get("mimeType") != FOLDER_MIME:
                    raise VaultError("Drive generated-ID collision.") from None
        self._retry(create)
        return file_id

    def _new_bytes(self, name, data, parent):
        file_id = self._retry(self.drive.allocate_id)
        def create():
            try:
                self.drive.upload_bytes(file_id, name, data, parent)
            except Exception as error:
                if _status(error) != 409:
                    raise
                existing = self._retry(lambda: self.drive.download(file_id))
                if hashlib.sha256(existing).digest() != hashlib.sha256(data).digest():
                    raise VaultError("Drive generated-ID collision.") from None
        self._retry(create)
        return file_id

    def _read_raw(self, file_id):
        for _ in range(4):
            before = self._retry(lambda: self.drive.metadata(file_id))
            raw = self._retry(lambda: self.drive.download(file_id))
            after = self._retry(lambda: self.drive.metadata(file_id))
            if before.get("version") == after.get("version"):
                return json.loads(raw), after
        raise ConcurrentUpdateError("Catalog changed repeatedly while reading it.")

    def initialize(self, passphrase):
        salt = os.urandom(16)
        key = derive_key(passphrase, salt)
        root = self._new_folder("MediaVault — encrypted media library")
        catalog = {"version": 1, "folderId": root, "createdAt": _now(), "items": []}
        try:
            file_id = self._new_bytes("vault-catalog.enc.json", _json(seal_catalog(catalog, key, salt)), root)
        except Exception:
            self._retry(lambda: self.drive.trash(root))
            raise
        self.library_id, self.catalog, self._key, self._salt = file_id, catalog, key, salt
        self._manifest_cache = None
        return file_id

    def unlock(self, library_id, passphrase):
        envelope, metadata = self._read_raw(library_id)
        if metadata.get("ownedByMe") is False or metadata.get("capabilities", {}).get("canEdit") is False:
            raise VaultError("The owner account must be able to edit this catalog.")
        salt = _unb64(envelope["salt"])
        key = derive_key(passphrase, salt)
        catalog = open_catalog(envelope, key)
        self.library_id, self.catalog, self._key, self._salt = str(library_id), catalog, key, salt
        self._manifest_cache = None
        return self.library_id

    def _latest(self):
        if not self.library_id or self._key is None:
            raise VaultError("Initialize or unlock the library first.")
        envelope, metadata = self._read_raw(self.library_id)
        if _unb64(envelope["salt"]) != self._salt:
            raise VaultError("The vault encryption settings changed. Unlock it again.")
        catalog = open_catalog(envelope, self._key)
        self.catalog = catalog
        return catalog, metadata

    def refresh(self):
        return copy.deepcopy(self._latest()[0])

    def close(self):
        self._key = self._salt = self.catalog = self._manifest_cache = None
        self.library_id = None

    @staticmethod
    def _merge(latest, item, storage):
        merged = copy.deepcopy(latest)
        merged["items"].append(copy.deepcopy(item))
        target = merged.setdefault("storage", {})
        target["version"] = 1
        media = target.setdefault("mediaFolders", {})
        for category, folder_id in storage.get("mediaFolders", {}).items():
            media.setdefault(category, folder_id)
        collections = target.setdefault("collections", [])
        known = {entry.get("id") for entry in collections}
        collections.extend(copy.deepcopy(entry) for entry in storage.get("collections", [])
                           if entry.get("id") not in known)
        return merged

    def _commit_item(self, item, storage):
        fingerprint = item.get("importFingerprint")
        for _ in range(5):
            latest, metadata = self._latest()
            existing = next((entry for entry in latest["items"]
                             if entry.get("id") == item["id"] or (
                                 fingerprint and entry.get("importFingerprint") == fingerprint)), None)
            if existing:
                return existing
            etag = metadata.get("_etag")
            if self.require_etag and not etag:
                raise ConcurrentUpdateError("Drive returned no HTTP ETag; strict catalog writing is disabled.")
            merged = self._merge(latest, item, storage)
            encrypted = _json(seal_catalog(merged, self._key, self._salt))
            # Version is observable in Drive v3; it is a recheck, not an atomic CAS.
            current = self._retry(lambda: self.drive.metadata(self.library_id))
            if current.get("version") != metadata.get("version"):
                continue
            try:
                self.drive.replace_bytes(self.library_id, encrypted, etag=etag)
            except Exception as error:
                if _status(error) == 412 or _transient(error):
                    continue  # Read back before retrying; a previous PATCH may have succeeded.
                raise
            verified, _ = self._latest()
            if any(entry.get("id") == item["id"] for entry in verified["items"]):
                return next(entry for entry in verified["items"] if entry.get("id") == item["id"])
        raise ConcurrentUpdateError("Catalog is busy. The encrypted asset manifest permits recovery.")

    def _folders(self, catalog, category, collection):
        storage = copy.deepcopy(catalog.get("storage") or {})
        storage["version"] = 1
        media = storage.setdefault("mediaFolders", {})
        if category not in media:
            media[category] = self._new_folder(category, catalog["folderId"])
        collections = storage.setdefault("collections", [])
        group = next((entry for entry in collections if entry.get("category") == category
                      and entry.get("name") == collection), None)
        if group is None:
            collection_id = str(uuid.uuid4())
            group = {"id": collection_id, "category": category, "name": collection,
                     "folderId": self._new_folder("collection-" + collection_id, media[category])}
            collections.append(group)
        item_id = str(uuid.uuid4())
        asset_id = self._new_folder("asset-" + item_id, group["folderId"])
        return item_id, asset_id, group["id"], storage

    def _checkpoints(self):
        if self._manifest_cache is not None:
            return self._manifest_cache
        catalog, _ = self._latest()
        checkpoints = []
        media = self._retry(lambda: self.drive.list_children(catalog["folderId"], mime_type=FOLDER_MIME))
        for media_folder in media:
            if media_folder.get("name") not in CATEGORIES:
                continue
            groups = self._retry(lambda: self.drive.list_children(media_folder["id"], mime_type=FOLDER_MIME))
            for group in groups:
                if not group.get("name", "").startswith("collection-"):
                    continue
                assets = self._retry(lambda: self.drive.list_children(group["id"], mime_type=FOLDER_MIME))
                for asset in assets:
                    if not asset.get("name", "").startswith("asset-"):
                        continue
                    manifests = self._retry(lambda: self.drive.list_children(asset["id"], name="manifest.enc.json"))
                    for manifest in manifests:
                        envelope = json.loads(self._retry(lambda: self.drive.download(manifest["id"])))
                        data = open_catalog(envelope, self._key)
                        if data.get("checkpoint") == "asset-v1" and data.get("folderId") == catalog["folderId"]:
                            checkpoints.append(data)
        self._manifest_cache = checkpoints
        return checkpoints

    def completed(self, source_identity, *, collection="Без коллекции", episode=None, category="video", recover=True):
        fingerprint = source_fingerprint(source_identity, collection=collection, episode=episode, category=category)
        catalog, _ = self._latest()
        existing = next((entry for entry in catalog["items"]
                         if entry.get("importFingerprint") == fingerprint), None)
        if existing:
            return copy.deepcopy(existing)
        if recover:
            for checkpoint in self._checkpoints():
                item = next((entry for entry in checkpoint["items"]
                             if entry.get("importFingerprint") == fingerprint), None)
                if item:
                    return copy.deepcopy(self._commit_item(item, checkpoint.get("storage", {})))
        return None

    def upload_file(self, path, *, name=None, category="video", collection="Без коллекции",
                    episode=None, source_identity=None, mime=None, metadata_id=None, progress=None):
        if category not in CATEGORIES:
            raise VaultError("Unsupported media category.")
        file_path = Path(path)
        filename, collection = str(name or file_path.name).strip(), str(collection).strip()
        if not filename or len(filename) > 500 or not collection or len(collection) > 500:
            raise VaultError("Invalid file or collection name.")
        size = file_path.stat().st_size
        if size <= 0:
            raise VaultError("Empty files are not supported.")
        if source_identity:
            existing = self.completed(source_identity, collection=collection, episode=episode, category=category)
            if existing:
                return existing
        catalog, _ = self._latest()
        item_id, asset_id, collection_id, storage = self._folders(catalog, category, collection)
        checkpoint_written = False
        try:
            chunks, loaded, content_hash = [], 0, hashlib.sha256()
            with file_path.open("rb") as source:
                while True:
                    raw = source.read(CHUNK_SIZE)
                    if not raw:
                        break
                    content_hash.update(raw)
                    sealed = seal_chunk(raw, self._key, item_id, len(chunks))
                    remote_id = self._new_bytes(f"part-{len(chunks):06d}.enc", sealed["ciphertext"], asset_id)
                    chunks.append({"fileId": remote_id, "iv": sealed["iv"]})
                    loaded += len(raw)
                    if progress:
                        progress({"loaded": loaded, "total": size, "phase": "uploading"})
            if loaded != size or file_path.stat().st_size != size:
                raise VaultError("Source file changed while uploading.")
            item = {"id": item_id, "folderId": asset_id, "name": filename, "category": category,
                    "mime": mime or mimetypes.guess_type(filename)[0] or "application/octet-stream",
                    "size": loaded, "addedAt": _now(), "collectionId": collection_id, "chunks": chunks,
                    "sha256": content_hash.hexdigest()}
            if episode is not None:
                item["episode"] = episode
            if metadata_id is not None:
                item["metadataId"] = metadata_id
            if source_identity:
                item["importFingerprint"] = source_fingerprint(
                    source_identity, collection=collection, episode=episode, category=category)
            checkpoint = {"version": 1, "folderId": catalog["folderId"], "checkpoint": "asset-v1",
                          "items": [item], "storage": storage, "completedAt": _now()}
            self._new_bytes("manifest.enc.json", _json(seal_catalog(checkpoint, self._key, self._salt)), asset_id)
            checkpoint_written = True
            self._manifest_cache = None
            committed = self._commit_item(item, storage)
            if committed["id"] != item_id:
                self._retry(lambda: self.drive.trash(asset_id))
            if progress:
                progress({"loaded": loaded, "total": size, "phase": "done"})
            return copy.deepcopy(committed)
        except Exception as error:
            if not checkpoint_written:
                try:
                    self._retry(lambda: self.drive.trash(asset_id))
                except Exception:
                    pass  # Preserve the upload error; no incomplete item is published in the catalog.
                raise
            raise RecoverableUploadError(
                "Encrypted media is complete; rerun this episode to recover its manifest into the catalog."
            ) from error
