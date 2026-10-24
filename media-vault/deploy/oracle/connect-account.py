#!/usr/bin/env python3
"""Register an explicitly authorized public API key using the signed-in OCI CLI.

This is a separate, opt-in access step, not the read-only account check. It
creates no compute/storage/network resources and changes no billing settings.
The matching private key remains with the assistant; it is never uploaded.
"""
from __future__ import annotations

import argparse
import base64
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import textwrap


class AccessError(RuntimeError):
    pass


def command(arguments, region, *, empty_list=False):
    try:
        # Identity query prevents a user CLI default from projecting away data.
        result = subprocess.run(["oci", "--region", region, "--output", "json", "--query", "@", *arguments],
                                capture_output=True, text=True, timeout=90, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise AccessError("OCI CLI не ответил. Открой новую сессию Cloud Shell.") from None
    if result.returncode:
        match = re.search(r'"code"\s*:\s*"([a-zA-Z0-9_-]{1,80})"', result.stderr)
        raise AccessError("Oracle отклонил запрос: " + (match[1] if match else "ошибка доступа") + ". Существующие ключи не изменялись.")
    # OCI CLI's render() omits an empty data list instead of printing {data:[]}.
    # Accept that only for the known list operation, after a successful exit.
    # Never turn a missing mutation response or a CLI error into success.
    if empty_list and not result.stdout.strip():
        return []
    try:
        payload = json.loads(result.stdout)
        if empty_list and payload == {}:
            return []
        return payload["data"]
    except (ValueError, KeyError, TypeError):
        operation = " ".join(arguments[:4])
        raise AccessError("Неизвестный ответ Oracle на шаге " + operation + ". Не повторяй команду вслепую: проверь API Keys своего пользователя.") from None


def connect(encoded_key):
    if not shutil.which("oci"):
        raise AccessError("Открой Oracle Cloud Shell: там OCI CLI уже авторизован.")
    try:
        der = base64.b64decode(encoded_key, validate=True)
        if not 270 <= len(der) <= 1600:
            raise ValueError()
    except ValueError:
        raise AccessError("Некорректный публичный ключ.") from None
    pem = "-----BEGIN PUBLIC KEY-----\n" + "\n".join(textwrap.wrap(base64.b64encode(der).decode(), 64)) + "\n-----END PUBLIC KEY-----\n"
    digest = hashlib.md5(der, usedforsecurity=False).hexdigest()
    fingerprint = ":".join(digest[index:index + 2] for index in range(0, len(digest), 2))
    profile = os.getenv("OCI_CLI_PROFILE", "DEFAULT")
    config_path = os.getenv("OCI_CLI_CONFIG_FILE", str(Path.home() / ".oci" / "config"))
    configuration = configparser.ConfigParser(interpolation=None)
    configuration.read(config_path)
    if profile not in configuration:
        raise AccessError("Активный профиль Cloud Shell не найден.")
    selected = configuration[profile]
    tenancy, region = selected.get("tenancy", "").strip(), selected.get("region", "").strip()
    environment_user, config_user = os.getenv("OCI_CS_USER_OCID", "").strip(), selected.get("user", "").strip()
    if environment_user and config_user and environment_user != config_user:
        raise AccessError("Пользователь Cloud Shell отличается от пользователя профиля. Доступ не добавлен.")
    user = environment_user or config_user
    if (not re.fullmatch(r"ocid1\.user\.[a-zA-Z0-9.]+", user)
            or not re.fullmatch(r"ocid1\.tenancy\.[a-zA-Z0-9.]+", tenancy)
            or not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+){2,}", region)):
        raise AccessError("Cloud Shell не сообщил нужные идентификаторы. Открой новую сессию из консоли Oracle.")
    subscriptions = command(["iam", "region-subscription", "list", "--tenancy-id", tenancy, "--all"], region)
    homes = [entry.get("region-name") for entry in subscriptions if entry.get("is-home-region") is True]
    if len(homes) != 1 or not homes[0]:
        raise AccessError("Домашний регион не определён. Доступ не добавлен.")
    region = homes[0]
    keys = command(["iam", "user", "api-key", "list", "--user-id", user, "--all"], region, empty_list=True)
    if not isinstance(keys, list) or any(not isinstance(entry, dict) or not isinstance(entry.get("fingerprint"), str) for entry in keys):
        raise AccessError("Oracle не вернул список API Keys. Доступ не добавлен.")
    existing = any(entry.get("fingerprint") == fingerprint for entry in keys)
    if not existing:
        if len(keys) >= 3:
            raise AccessError("У пользователя уже три API Keys. Существующие ключи не удаляются и не заменяются.")
        created = command(["iam", "user", "api-key", "upload", "--user-id", user, "--key", pem], region)
        if not isinstance(created, dict) or created.get("fingerprint") != fingerprint:
            raise AccessError("Отпечаток ответа отличается от ожидаемого. Проверь API Keys в консоли.")
    return {"tenancy": tenancy, "user": user, "region": region, "fingerprint": fingerprint,
            "public_identifiers_only": True, "already_registered": existing,
            "revoke_command": ["oci", "--region", region, "iam", "user", "api-key", "delete", "--user-id", user, "--fingerprint", fingerprint]}


def main():
    parser = argparse.ArgumentParser(description="Бесплатное подключение через собственную консоль Oracle. Добавляется публичный API-ключ для настройки; тариф не меняется.")
    parser.add_argument("--public-key-der", required=True, help="Публичный ключ DER в base64; это НЕ секретный ключ.")
    parser.add_argument("--grant-temporary-access", action="store_true", required=True,
                        help="Явно разрешить этому ключу доступ от имени вошедшего пользователя OCI. Ключ удаляется после настройки.")
    arguments = parser.parse_args()
    try:
        print(json.dumps(connect(arguments.public_key_der), ensure_ascii=False, indent=2))
        return 0
    except (AccessError, OSError, configparser.Error) as error:
        print(str(error) if isinstance(error, AccessError) else "Не удалось прочитать конфигурацию Cloud Shell.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
