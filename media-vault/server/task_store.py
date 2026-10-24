"""Private, encrypted task state for the unattended import service."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class TaskStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        key_path = self.directory / "service.key"
        try:
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as output:
                output.write(os.urandom(32))
        self.key = key_path.read_bytes()
        if len(self.key) != 32:
            raise RuntimeError("Invalid service encryption key.")
        key_path.chmod(0o600)
        self.lock = threading.RLock()
        self.database = sqlite3.connect(self.directory / "tasks.sqlite", check_same_thread=False)
        (self.directory / "tasks.sqlite").chmod(0o600)
        with self.database:
            self.database.executescript("""
                CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
                    created REAL NOT NULL, updated REAL NOT NULL, data BLOB NOT NULL,
                    progress BLOB NOT NULL, idempotency TEXT NOT NULL,
                    UNIQUE(owner,idempotency));
            """)
            # Episode manifests in Drive make a restart safe: completed episodes are skipped.
            self.database.execute("UPDATE tasks SET status='queued' WHERE status='running'")

    def seal(self, value, aad):
        nonce = os.urandom(12)
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        return nonce + AESGCM(self.key).encrypt(nonce, raw, aad.encode())

    def open(self, value, aad):
        return json.loads(AESGCM(self.key).decrypt(value[:12], value[12:], aad.encode()))

    def setting(self, name, value=None):
        with self.lock, self.database:
            if value is not None:
                self.database.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (name, self.seal(value, name)))
            row = self.database.execute("SELECT value FROM settings WHERE name=?", (name,)).fetchone()
        return self.open(row[0], name) if row else None

    def consume(self, name):
        with self.lock, self.database:
            value = self.setting(name)
            self.database.execute("DELETE FROM settings WHERE name=?", (name,))
        return value

    def add(self, owner, data, idempotency):
        with self.lock, self.database:
            existing = self.database.execute("SELECT id FROM tasks WHERE owner=? AND idempotency=?", (owner, idempotency)).fetchone()
            if existing:
                return self.get(existing[0], owner)
            if self.database.execute("SELECT count(*) FROM tasks WHERE status IN ('queued','running','waiting_auth')").fetchone()[0] >= 30:
                raise ValueError("В очереди уже 30 заданий. Дождись завершения или отмени лишние.")
            task_id, now = str(uuid.uuid4()), time.time()
            self.database.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)", (
                task_id, owner, "queued", now, now, self.seal(data, task_id),
                self.seal({"phase": "queued", "saved": 0, "total": 0}, task_id), idempotency))
        return self.get(task_id, owner)

    def get(self, task_id, owner=None, *, private=False):
        with self.lock:
            row = self.database.execute("SELECT id,owner,status,created,updated,data,progress FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row or (owner is not None and owner != row[1]):
            return None
        result = {"id": row[0], "status": row[2], "created": row[3], "updated": row[4],
                  "progress": self.open(row[6], row[0])}
        if private:
            result.update(owner=row[1], data=self.open(row[5], row[0]))
        return result

    def list(self, owner):
        with self.lock:
            ids = self.database.execute("SELECT id FROM tasks WHERE owner=? ORDER BY created DESC LIMIT 40", (owner,)).fetchall()
        return [self.get(row[0], owner) for row in ids]

    def next(self):
        with self.lock, self.database:
            row = self.database.execute("SELECT id FROM tasks WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row:
                self.database.execute("UPDATE tasks SET status='running',updated=? WHERE id=?", (time.time(), row[0]))
                return self.get(row[0], private=True)
        return None

    def expire_keys(self):
        with self.lock:
            rows = self.database.execute("SELECT id FROM tasks WHERE created<? AND status NOT IN ('completed','cancelled','running','cancelling')", (time.time() - 7 * 86400,)).fetchall()
        for row in rows:
            self.update(row[0], status="cancelled", progress={"message": "Срок хранения задания истёк. Завершённые файлы остаются в Drive."}, forget_key=True)

    def update(self, task_id, *, status=None, progress=None, forget_key=False):
        with self.lock, self.database:
            row = self.get(task_id, private=True)
            if not row:
                return
            if progress:
                row["progress"].update(progress)
            if forget_key:
                row["data"].pop("vault_key", None)
            self.database.execute("UPDATE tasks SET status=?,updated=?,data=?,progress=? WHERE id=?", (
                status or row["status"], time.time(), self.seal(row["data"], task_id),
                self.seal(row["progress"], task_id), task_id))

    def close(self):
        self.database.close()
