"""Unattended, owner-only importer. Run with uvicorn api:app --port 7860.

Google offline consent happens once. Refresh credentials and queued encryption
keys are encrypted on the server's private volume; completed/cancelled tasks
discard their vault key. Public source clients never receive Google credentials.
"""
from __future__ import annotations

import base64
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from urllib.parse import urlencode, urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, SecretStr
import requests

from metadata_catalog import metadata
from run_import import run_job, validate_job
from site_adapters import inspect_source, search_sources, voice_availability
from source_parser import SourceError
from task_store import TaskStore
from vault_drive import ADMIN_EMAIL_SHA256, GoogleDriveAdapter, VaultDrive, VaultError


CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "262576202069-9gcrr64crhdubh2drhsspsnq9c0rtfri.apps.googleusercontent.com")
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")
ORIGIN = os.getenv("ALLOWED_ORIGIN", "https://onikri.github.io").rstrip("/")
REDIRECT = PUBLIC_URL + "/oauth/callback"
store = None
stopping = threading.Event()
wakeup = threading.Event()


def client_secret():
    configured = store.setting("configuration:google-oauth") if store else None
    return configured["client_secret"] if configured else CLIENT_SECRET


def b64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def session_token(subject):
    body = b64url(json.dumps({"sub": subject, "exp": int(time.time()) + 86400, "nonce": secrets.token_urlsafe(12)}, separators=(",", ":")).encode())
    return body + "." + b64url(hmac.digest(store.key, body.encode(), "sha256"))


def owner(authorization: str = Header(default="")):
    try:
        token = authorization.removeprefix("Bearer ")
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, b64url(hmac.digest(store.key, body.encode(), "sha256"))):
            raise ValueError()
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if payload["exp"] < time.time() or not payload.get("sub"):
            raise ValueError()
        return payload["sub"]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, "Войди через Google на сайте заново.") from None


def google_user(token):
    try:
        response = requests.get("https://www.googleapis.com/oauth2/v3/userinfo", headers={"Authorization": "Bearer " + token}, timeout=(6, 15))
        response.raise_for_status()
        user = response.json()
        digest = hashlib.sha256(str(user.get("email", "")).strip().lower().encode()).hexdigest()
        if user.get("email_verified") is not True or digest != ADMIN_EMAIL_SHA256 or not user.get("sub"):
            raise HTTPException(403, "Сервер доступен только владельцу MediaVault.")
        return user
    except (requests.RequestException, ValueError):
        raise HTTPException(401, "Google не подтвердил вход. Подключи аккаунт на сайте заново.") from None


def drive_credentials(subject):
    value = store.setting("google:" + subject)
    secret = client_secret()
    if not value or not secret:
        raise VaultError("Подключи Google Drive к серверу один раз в настройках импорта.")
    from google.oauth2.credentials import Credentials
    return Credentials(token=None, refresh_token=value["refresh_token"], token_uri="https://oauth2.googleapis.com/token",
                       client_id=CLIENT_ID, client_secret=secret,
                       scopes=["openid", "email", "profile", "https://www.googleapis.com/auth/drive"])


def worker():
    last_cleanup = 0
    while not stopping.is_set():
        if time.monotonic() - last_cleanup > 60:
            store.expire_keys()
            last_cleanup = time.monotonic()
        task = store.next()
        if not task:
            wakeup.wait(5)
            wakeup.clear()
            continue
        task_id, vault = task["id"], None
        if task["created"] < time.time() - 7 * 86400:
            store.update(task_id, status="cancelled", progress={"message": "Срок хранения задания истёк."}, forget_key=True)
            continue
        try:
            store.update(task_id, progress={"phase": "preparing"})
            data = task["data"]
            vault = VaultDrive(GoogleDriveAdapter.from_adc(drive_credentials(task["owner"])))
            vault.unlock_key(data["job"]["library_id"], base64.b64decode(data["vault_key"], validate=True))
            def progress(event):
                store.update(task_id, progress=event)
            def cancelled():
                return store.get(task_id)["status"] == "cancelling"
            result = run_job(data["job"], vault, log=lambda _: None, progress=progress, cancelled=cancelled,
                             temporary_dir=store.directory / "temporary")
            if cancelled():
                store.update(task_id, status="cancelled", progress={"phase": "cancelled"}, forget_key=True)
            elif result["failed"]:
                store.update(task_id, status="failed", progress={"phase": "failed", **result,
                    "message": "Некоторые файлы недоступны в источнике. Сохранённые уже в коллекции; задание можно продолжить."})
            else:
                store.update(task_id, status="completed", progress={"phase": "done", **result}, forget_key=True)
        except Exception as error:
            if store.get(task_id)["status"] == "cancelling":
                store.update(task_id, status="cancelled", progress={"phase": "cancelled"}, forget_key=True)
            elif error.__class__.__module__.startswith("google.auth") or isinstance(error, HTTPException):
                store.update(task_id, status="waiting_auth", progress={"message": "Серверу нужно повторное разрешение Google. Завершённые серии сохранены."})
            else:
                message = str(error) if isinstance(error, (SourceError, VaultError)) else "Импорт остановился. Завершённые файлы в Drive сохранены; задание можно продолжить."
                store.update(task_id, status="failed", progress={"phase": "failed", "message": message[:500]})
        finally:
            if vault:
                vault.close()


@asynccontextmanager
async def lifespan(application):
    global store
    store = TaskStore(os.getenv("DATA_DIR", "/data"))
    temporary = store.directory / "temporary"
    temporary.mkdir(exist_ok=True, mode=0o700)
    stopping.clear()
    thread = threading.Thread(target=worker, daemon=True, name="media-import")
    if os.getenv("MEDIA_VAULT_DISABLE_WORKER") != "1":
        thread.start()
    yield
    stopping.set()
    wakeup.set()
    if thread.is_alive():
        thread.join(timeout=2)
    # A live worker may still be finishing a bounded source request during shutdown.
    if not thread.is_alive():
        store.close()


app = FastAPI(title="MediaVault import service", version="4.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN], allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])


@app.middleware("http")
async def limits(request: Request, call_next):
    if request.method == "POST":
        if request.headers.get("origin") not in (None, ORIGIN):
            return JSONResponse({"detail": "Origin denied"}, status_code=403)
        try:
            if int(request.headers.get("content-length", "0")) > 512 * 1024:
                return JSONResponse({"detail": "Request too large"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "Invalid content length"}, status_code=400)
        if len(await request.body()) > 512 * 1024:
            return JSONResponse({"detail": "Request too large"}, status_code=413)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.exception_handler(SourceError)
@app.exception_handler(VaultError)
async def source_error(request, error):
    return JSONResponse({"detail": str(error)}, status_code=422)


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # FastAPI's default response can echo input values, including a submitted key.
    return JSONResponse({"detail": "Некорректные параметры запроса."}, status_code=422)


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


@app.get("/health")
def health():
    return {"application": "MediaVault", "version": 4, "oauthConfigured": bool(client_secret() and PUBLIC_URL.startswith("https://")),
            "origin": ORIGIN, "worker": "server", "paidServices": False}


@app.post("/auth/session")
def authenticate(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer ") or len(authorization) > 8192:
        raise HTTPException(401, "Нужен вход через Google.")
    user = google_user(authorization[7:])
    return {"token": session_token(user["sub"]), "driveConnected": bool(store.setting("google:" + user["sub"])),
            "oauthConfigured": bool(client_secret() and PUBLIC_URL.startswith("https://"))}


class GoogleOAuthConfiguration(StrictBody):
    client_id: str = Field(max_length=200)
    client_secret: SecretStr


@app.post("/admin/google-oauth")
def configure_google(body: GoogleOAuthConfiguration, subject=Depends(owner)):
    secret = body.client_secret.get_secret_value().strip()
    if body.client_id != CLIENT_ID or not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", secret):
        raise HTTPException(422, "Нужны настройки существующего Web OAuth-клиента MediaVault.")
    if not PUBLIC_URL.startswith("https://"):
        raise HTTPException(503, "Сначала настрой HTTPS сервера.")
    store.setting("configuration:google-oauth", {"client_secret": secret})
    return {"oauthConfigured": True, "redirectUri": REDIRECT}


@app.post("/oauth/start")
def oauth_start(subject=Depends(owner)):
    if not client_secret() or not PUBLIC_URL.startswith("https://"):
        raise HTTPException(503, "Администратору нужно завершить одноразовую настройку Google OAuth на сервере.")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    store.setting("oauth:" + state, {"sub": subject, "expires": time.time() + 600, "verifier": verifier})
    params = {"client_id": CLIENT_ID, "redirect_uri": REDIRECT, "response_type": "code",
              "scope": "openid email profile https://www.googleapis.com/auth/drive", "state": state,
              "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
              "code_challenge_method": "S256", "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest())}
    return {"url": "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)}


@app.get("/oauth/callback", response_class=HTMLResponse)
def oauth_callback(state: str = "", code: str = "", error: str = ""):
    pending = store.consume("oauth:" + state)
    if not pending or pending["expires"] < time.time() or error or not code:
        raise HTTPException(400, "Разрешение Google отменено или устарело. Повтори подключение на сайте.")
    try:
        response = requests.post("https://oauth2.googleapis.com/token", data={"code": code, "client_id": CLIENT_ID,
            "client_secret": client_secret(), "redirect_uri": REDIRECT, "grant_type": "authorization_code", "code_verifier": pending["verifier"]}, timeout=(6, 20))
        response.raise_for_status()
        tokens = response.json()
    except (requests.RequestException, ValueError):
        raise HTTPException(502, "Не удалось завершить разрешение Google. Повтори подключение.") from None
    user = google_user(tokens.get("access_token", ""))
    if user["sub"] != pending["sub"]:
        raise HTTPException(403, "Выбран другой Google-аккаунт.")
    scopes = set(tokens.get("scope", "").split())
    if "https://www.googleapis.com/auth/drive" not in scopes:
        raise HTTPException(403, "Для серверного импорта нужно разрешить запись в Google Drive.")
    old = store.setting("google:" + user["sub"]) or {}
    refresh = tokens.get("refresh_token") or old.get("refresh_token")
    if not refresh:
        raise HTTPException(400, "Google не выдал фоновый доступ. Повтори подключение с подтверждением разрешений.")
    store.setting("google:" + user["sub"], {"refresh_token": refresh})
    for task in store.list(user["sub"]):
        if task["status"] == "waiting_auth":
            store.update(task["id"], status="queued")
    wakeup.set()
    # No tokens, state, code or keys are included in the returned page.
    return "<!doctype html><meta charset=utf-8><title>MediaVault</title><p>Google Drive подключён. Можно вернуться в MediaVault.</p><script>if(window.opener){window.opener.postMessage({type:'mediavault-server-connected'}," + json.dumps(ORIGIN) + ");window.close();}</script>"


@app.get("/metadata/{provider}")
def catalogue(provider: str, q: str = "", kind: str = "anime", page: int = 1, identity: str | None = None, year: int | None = None):
    return metadata(provider, query=q, kind=kind, page=page, identity=identity, year=year)


@app.get("/sources/search")
def source_search(q: str, kind: str = "anime", subject=Depends(owner)):
    if not 2 <= len(q.strip()) <= 160:
        raise HTTPException(422, "Укажи название от 2 до 160 символов.")
    return search_sources(q.strip(), kind)


@app.get("/sources/availability")
def availability(q: str, subject=Depends(owner)):
    if not 2 <= len(q.strip()) <= 160:
        raise HTTPException(422, "Некорректное название.")
    return voice_availability(q.strip())


class Inspection(StrictBody):
    url: str = Field(max_length=8192)
    dub_url: str | None = Field(default=None, max_length=8192)
    season: int | None = Field(default=None, ge=1, le=1000)
    kind: str = "anime"


@app.post("/sources/inspect")
def source_inspect(body: Inspection, subject=Depends(owner)):
    if body.kind not in {"anime", "movie", "tv", "manga", "ranobe"}:
        raise HTTPException(422, "Неизвестный тип произведения.")
    return inspect_source(body.url, dub_url=body.dub_url, season=body.season, kind=body.kind)


class ImportTask(StrictBody):
    job: dict
    vault_key: str = Field(min_length=44, max_length=44)


@app.post("/jobs", status_code=202)
def submit(body: ImportTask, subject=Depends(owner), idempotency_key: str = Header(default="")):
    validate_job(body.job)
    try:
        if len(base64.b64decode(body.vault_key, validate=True)) != 32:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "Некорректный ключ открытой библиотеки.") from None
    if not re.fullmatch(r"[\w-]{16,100}", idempotency_key, re.ASCII):
        raise HTTPException(422, "Нужен уникальный идентификатор запроса.")
    if not store.setting("google:" + subject):
        raise HTTPException(409, "Подключи Google Drive к серверу один раз перед первым импортом.")
    try:
        task = store.add(subject, {"job": body.job, "vault_key": body.vault_key}, idempotency_key)
    except ValueError as error:
        raise HTTPException(429, str(error)) from None
    wakeup.set()
    return task


@app.get("/jobs")
def tasks(subject=Depends(owner)):
    return {"jobs": store.list(subject)}


@app.get("/jobs/{task_id}")
def task(task_id: str, subject=Depends(owner)):
    value = store.get(task_id, subject)
    if not value:
        raise HTTPException(404, "Задание не найдено.")
    return value


@app.post("/jobs/{task_id}/cancel")
def cancel(task_id: str, subject=Depends(owner)):
    value = task(task_id, subject)
    active = value["status"] == "running"
    store.update(task_id, status="cancelling" if active else "cancelled", forget_key=not active)
    return task(task_id, subject)


@app.post("/jobs/{task_id}/resume")
def resume(task_id: str, subject=Depends(owner)):
    value = task(task_id, subject)
    if value["status"] not in {"failed", "waiting_auth"}:
        raise HTTPException(409, "Это задание сейчас нельзя продолжить.")
    private = store.get(task_id, subject, private=True)
    if not private["data"].get("vault_key"):
        raise HTTPException(409, "Открой библиотеку и запусти новое задание: завершённые серии будут пропущены.")
    store.update(task_id, status="queued", progress={"message": "", "phase": "queued"})
    wakeup.set()
    return task(task_id, subject)
