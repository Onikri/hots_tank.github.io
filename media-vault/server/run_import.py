"""One-episode-at-a-time public-source → Colab → encrypted Drive import."""
from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from media_download import download_episode, pick_stream
from source_parser import Resolver, SourceError, episode_number, public_url


def episode_selection(value):
    value = str(value or "all").strip().lower()
    if value in {"all", "все", ""}:
        return None
    numbers = set()
    for part in value.split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", part)
        if not match:
            raise SourceError("Серии указываются как all, 1-12 или 1,3,5-8.")
        first, last = int(match[1]), int(match[2] or match[1])
        if first < 1 or last < first or last > 10000:
            raise SourceError("Некорректный диапазон серий.")
        numbers.update(range(first, last + 1))
    return numbers


def validate_job(value):
    if not isinstance(value, dict) or value.get("version") != 1:
        raise SourceError("Нужно задание MediaVault версии 1.")
    # Reject accidental pasted credentials rather than saving or forwarding them.
    if set(value) - {"version", "library_id", "sources", "collection", "episodes", "quality", "resume"}:
        raise SourceError("В задании есть лишние поля. Скопируй новое задание с сайта.")
    library = value.get("library_id", "")
    if not isinstance(library, str) or not re.fullmatch(r"[\w-]{5,256}", library, flags=re.ASCII):
        raise SourceError("В задании отсутствует ID открытой библиотеки.")
    urls = value.get("sources")
    if not isinstance(urls, list) or not 1 <= len(urls) <= 200:
        raise SourceError("В задании должно быть от 1 до 200 ссылок.")
    sources = list(dict.fromkeys(public_url(url, resolve_dns=False) for url in urls))
    quality = str(value.get("quality", "720"))
    if quality not in {"best", "1080", "720", "480", "360"}:
        raise SourceError("Некорректное качество.")
    collection = str(value.get("collection", "")).strip()[:180]
    selected = episode_selection(value.get("episodes", "all"))
    return {"library_id": library, "sources": sources, "collection": collection,
            "quality": quality, "selected": selected}


def source_identity(url):
    """Keep logical episode/dub identity; remove rotating CDN signatures."""
    parsed = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parsed.query)
             if key.lower() in {"episode", "season", "translation", "videoid", "id", "oid", "dubbing"}]
    stable = urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path,
                        urlencode(sorted(query)), ""))
    # A non-URL prefix keeps vault_drive from dropping meaningful episode queries.
    return "public-player-v1:" + stable


def plan_sources(job, resolver):
    seen, plans, discovered = set(), [], set()
    for index, source in enumerate(job["sources"], 1):
        page = resolver.inspect(source)
        episodes = page.episodes
        # A title page may embed a serial player with actual published episode options.
        if not episodes and not page.streams:
            for embed in page.players:
                try:
                    embedded = resolver.inspect(embed)
                except SourceError:
                    continue
                if embedded.episodes:
                    episodes = embedded.episodes
                    break
        if not episodes:
            number = episode_number(source)
            # Ordered explicit links are the user's episode list, not invented site episodes.
            if number is None and len(job["sources"]) > 1:
                number = index
            episodes = [{"number": number, "title": page.title, "url": source}]
        for episode in episodes:
            number = episode.get("number")
            if number:
                discovered.add(number)
            if job["selected"] is not None and number not in job["selected"]:
                continue
            identity = source_identity(episode["url"])
            if identity in seen:
                continue
            seen.add(identity)
            plans.append({"number": number, "title": episode.get("title") or page.title,
                          "url": episode["url"], "identity": identity,
                          "collection": job["collection"] or page.title[:180] or "Импорт аниме"})
    if not plans:
        raise SourceError("Нужные опубликованные серии не найдены. Можно вставить отдельные ссылки серий списком.")
    return plans


def run_job(value, vault, *, resolver=None, downloader=download_episode, log=print):
    job = validate_job(value)
    if getattr(vault, "library_id", None) != job["library_id"]:
        raise SourceError("Открытая библиотека не совпадает с заданием.")
    own_resolver = resolver is None
    resolver = resolver or Resolver()
    result = {"saved": 0, "skipped": 0, "failed": 0}
    try:
        plans = plan_sources(job, resolver)
        log(f"Найдено серий для задания: {len(plans)}. Обрабатываем по одной.")
        found = {entry["number"] for entry in plans if entry["number"] is not None}
        if job["selected"] is not None and job["selected"] - found:
            log("Некоторые указанные серии не опубликованы в найденных ссылках; они не будут выдуманы или загружены.")
        for index, entry in enumerate(plans, 1):
            number, collection = entry["number"], entry["collection"]
            label = f"Серия {number}" if number is not None else f"Видео {index}"
            # Check before contacting the player, because its signed links expire.
            if vault.completed(entry["identity"], collection=collection, episode=number):
                result["skipped"] += 1
                log(f"[{index}/{len(plans)}] {label}: уже в Drive, пропускаю.")
                continue
            log(f"[{index}/{len(plans)}] {label}: скачивание на сервер Google.")
            # Every episode gets its own temporary directory; nothing accumulates for a season.
            with tempfile.TemporaryDirectory(prefix="mediavault-episode-") as temporary:
                try:
                    page = resolver.resolve(entry["url"])
                    stream = pick_stream(page.streams, job["quality"])
                    last_phase = [None]
                    def progress(event):
                        phase = event.get("phase")
                        if phase != last_phase[0]:
                            text = {"downloading": "скачивание", "assembling": "сборка MP4",
                                    "uploading": "шифрование и запись в Drive", "done": "сохранено"}.get(phase)
                            if text:
                                log(f"  {label}: {text}.")
                            last_phase[0] = phase
                    path = downloader(stream, temporary, http=resolver.http, quality=job["quality"], progress=progress)
                except SourceError as error:
                    result["failed"] += 1
                    log(f"  {label}: {error}")
                    continue
                except Exception as error:
                    if error.__class__.__module__.startswith("anime_dl_core"):
                        result["failed"] += 1
                        log(f"  {label}: плеер не отдал публичный поток. Повтори позже или используй другую ссылку.")
                        continue
                    raise
                # Drive/auth/quota errors stop immediately; prior completed episodes are preserved.
                name = (f"{collection} — серия {number:03d}.mp4" if number is not None
                        else (page.title or entry["title"] or collection)[:220] + ".mp4")
                vault.upload_file(path, name=name, category="video", collection=collection,
                                  episode=number, source_identity=entry["identity"], mime="video/mp4", progress=progress)
                result["saved"] += 1
        log(f"Готово: сохранено {result['saved']}, уже были в Drive {result['skipped']}, недоступны {result['failed']}.")
        return result
    finally:
        if own_resolver:
            resolver.http.close()
