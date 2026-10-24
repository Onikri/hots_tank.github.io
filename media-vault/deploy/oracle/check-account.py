#!/usr/bin/env python3
"""Read-only OCI inventory using Cloud Shell's existing authenticated CLI.

No resources, API keys, IAM policies, subscriptions or billing settings are
created or changed. Only public tenancy/profile selectors are read from the
CLI configuration; credentials are handled by OCI CLI and never printed.
"""
from __future__ import annotations

import configparser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


class CheckError(RuntimeError):
    pass


def context():
    profile = os.getenv("OCI_CLI_PROFILE", "DEFAULT")
    path = Path(os.getenv("OCI_CLI_CONFIG_FILE", str(Path.home() / ".oci" / "config")))
    configuration = configparser.ConfigParser(interpolation=None)
    try:
        configuration.read(path)
    except (OSError, configparser.Error):
        raise CheckError("Не удалось прочитать параметры активного профиля OCI CLI.") from None
    if profile not in configuration:
        raise CheckError("Активный профиль OCI CLI не найден. Запусти проверку в Oracle Cloud Shell.")
    selected = configuration[profile]
    tenancy = selected.get("tenancy", "").strip()
    region = selected.get("region", "").strip()
    if not re.fullmatch(r"ocid1\.tenancy\.[a-zA-Z0-9.]+", tenancy):
        raise CheckError("В активном профиле не найден идентификатор tenancy. Открой новую сессию Cloud Shell.")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+){2,}", region):
        raise CheckError("В активном профиле не найден регион OCI.")
    return tenancy, region


def read_oci(arguments, *, region):
    command = ["oci", "--region", region, "--output", "json", *arguments]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise CheckError("Oracle CLI не ответил. Проверь, что Cloud Shell открыт в домашнем регионе.") from None
    if result.returncode:
        # Do not echo CLI diagnostics: debug output may contain authentication headers.
        match = re.search(r'"code"\s*:\s*"([a-zA-Z0-9_-]{1,80})"', result.stderr)
        reason = match[1] if match else "ошибка доступа"
        raise CheckError("OCI: " + reason + ". Инвентаризация не завершена; ничего не изменено.")
    try:
        return json.loads(result.stdout)["data"]
    except (ValueError, KeyError, TypeError):
        raise CheckError("OCI вернул неизвестный формат ответа; проверка остановлена.") from None


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise CheckError("OCI не указал размер существующего ресурса. Автоматически считать его нулевым нельзя.")
    return value


def inventory():
    if not shutil.which("oci"):
        raise CheckError("Нужен Oracle Cloud Shell: в нём OCI CLI уже установлен и авторизован.")
    tenancy, active_region = context()
    subscriptions = read_oci(["iam", "region-subscription", "list", "--tenancy-id", tenancy, "--all"], region=active_region)
    regions = [entry.get("region-name") for entry in subscriptions if entry.get("is-home-region") is True]
    if len(regions) != 1 or not regions[0]:
        raise CheckError("Не удалось однозначно определить домашний регион tenancy.")
    region = regions[0]
    domains = read_oci(["iam", "availability-domain", "list", "--compartment-id", tenancy, "--all"], region=region)
    search = read_oci(["search", "resource", "structured-search", "--query-text", "query all resources", "--all"], region=region)
    if not isinstance(search, dict) or not isinstance(search.get("items"), list):
        raise CheckError("OCI Resource Search не вернул список ресурсов.")
    instances, volumes, cores, memory, disk = [], [], 0, 0, 0
    for resource in search["items"]:
        kind, identity = resource.get("resource-type"), resource.get("identifier")
        if kind not in {"Instance", "BootVolume", "Volume"}:
            continue
        if not identity:
            raise CheckError("Ресурс найден без идентификатора; проверка остановлена.")
        if kind == "Instance":
            item = read_oci(["compute", "instance", "get", "--instance-id", identity], region=region)
            if item.get("lifecycle-state") == "TERMINATED":
                continue
            shape, sizes = item.get("shape", ""), item.get("shape-config") or {}
            record = {"name": item.get("display-name"), "shape": shape, "state": item.get("lifecycle-state")}
            if shape == "VM.Standard.A1.Flex":
                record.update(ocpus=number(sizes.get("ocpus")), memory_gb=number(sizes.get("memory-in-gbs")))
                cores += record["ocpus"]
                memory += record["memory_gb"]
            instances.append(record)
        else:
            operation, option = ("boot-volume", "--boot-volume-id") if kind == "BootVolume" else ("volume", "--volume-id")
            item = read_oci(["bv", operation, "get", option, identity], region=region)
            if item.get("lifecycle-state") in {"TERMINATED", "DELETED"}:
                continue
            size = number(item.get("size-in-gbs"))
            disk += size
            volumes.append({"name": item.get("display-name"), "type": kind, "size_gb": size})
    # These are deliberately conservative template bounds, not a claim about
    # the account's subscription, resource prices or free-tier eligibility.
    return {"mode": "READ_ONLY", "tenancy_id": tenancy, "home_region": region,
            "availability_domains": [entry["name"] for entry in domains],
            "instances": instances, "volumes": volumes,
            "existing_a1": {"ocpus": cores, "memory_gb": memory}, "existing_disk_gb": disk,
            "proposed_server": {"ocpus": 2, "memory_gb": 12, "boot_disk_gb": 50},
            "fits_conservative_bounds": cores + 2 <= 2 and memory + 12 <= 12 and disk + 50 <= 200,
            "notice": "Это снимок Resource Search, не расчёт стоимости. Always Free проверяется в консоли перед созданием. Ресурсы и тариф не изменены."}


def main():
    try:
        print(json.dumps(inventory(), ensure_ascii=False, indent=2))
        return 0
    except CheckError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
