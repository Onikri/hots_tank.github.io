"""Key-free metadata services. Kept completely separate from video HTTP clients."""
from __future__ import annotations

from collections import OrderedDict
import json
import re
import threading
import time

import requests
from bs4 import BeautifulSoup

from source_parser import SourceError


USER_AGENT = "MediaVault/4.0 (https://github.com/Onikri/hots_tank.github.io; personal catalogue)"
MEDIA_FIELDS = """id idMal type format status title{romaji english native} synonyms description
 coverImage{large} genres tags{name isAdult} isAdult episodes chapters volumes seasonYear season
 startDate{year month day} endDate{year month day} siteUrl nextAiringEpisode{episode airingAt}
 airingSchedule(perPage:50,notYetAired:true){nodes{episode airingAt}}"""
_cache, _lock = OrderedDict(), threading.RLock()


def get_json(url, *, params=None, body=None):
    try:
        with requests.Session() as session:
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
            response = session.post(url, json=body, timeout=(6, 15), stream=True) if body else session.get(url, params=params, timeout=(6, 15), stream=True)
            with response:
                if response.status_code == 429:
                    raise SourceError("Каталог ограничил частоту запросов. Попробуй немного позже.")
                response.raise_for_status()
                raw = bytearray()
                for block in response.iter_content(65536):
                    raw.extend(block)
                    if len(raw) > 8 * 1024 * 1024:
                        raise SourceError("Ответ каталога слишком велик.")
                return json.loads(raw)
    except (requests.RequestException, ValueError):
        raise SourceError("Каталог сейчас недоступен. Остальные источники продолжат поиск.") from None


def metadata(provider, *, query="", kind="anime", page=1, identity=None, year=None):
    if provider not in {"kitsu", "anilist", "shikimori", "jikan", "tvmaze", "imdb", "wikidata"}:
        raise SourceError("Неизвестный каталог.")
    query, page = str(query).strip()[:160], max(1, min(100, int(page)))
    if kind not in {"anime", "manga", "ranobe", "movie", "tv"}:
        raise SourceError("Неизвестный тип каталога.")
    if identity and not re.fullmatch(r"(?:tt)?\d{1,12}|Q\d{1,12}", str(identity)):
        raise SourceError("Некорректный идентификатор тайтла.")
    cache_key = (provider, query, kind, page, identity, str(year))
    with _lock:
        cached = _cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    resource = "manga" if kind in {"manga", "ranobe"} else "anime"
    if provider == "kitsu":
        params = {"include": "genres,categories,mappings"}
        if not identity:
            params.update({"page[limit]": 16, "page[offset]": (page - 1) * 16})
            if query:
                params["filter[text]"] = query
            else:
                params["sort"] = "-userCount"
            if year and resource == "anime":
                params["filter[seasonYear]"] = year
        value = get_json(f"https://kitsu.io/api/edge/{resource}" + (f"/{identity}" if identity else ""), params=params)
    elif provider == "anilist":
        if identity:
            body = {"query": f"query($id:Int){{Media(id:$id){{{MEDIA_FIELDS}}}}}", "variables": {"id": int(identity)}}
        else:
            arguments = "type:$type,sort:POPULARITY_DESC" + (",search:$search" if query else "") + (",seasonYear:$year" if year else "")
            body = {"query": "query($search:String,$type:MediaType,$page:Int,$year:Int){Page(page:$page,perPage:16){pageInfo{hasNextPage} media(" + arguments + "){" + MEDIA_FIELDS + "}}}",
                    "variables": {"search": query or None, "type": "MANGA" if resource == "manga" else "ANIME", "page": page, "year": int(year) if year else None}}
        value = get_json("https://graphql.anilist.co", body=body)
    elif provider == "shikimori":
        resource = "mangas" if resource == "manga" else "animes"
        params = {"limit": 16, "page": page, "order": "popularity"}
        if query:
            params["search"] = query
        if year:
            params["season"] = str(year)
        value = get_json(f"https://shikimori.one/api/{resource}" + (f"/{identity}" if identity else ""), params=params)
    elif provider == "jikan":
        params = {"q": query, "page": page, "limit": 16, "sfw": "false"}
        if year and resource == "anime":
            params["start_date"], params["end_date"] = f"{year}-01-01", f"{year}-12-31"
        value = get_json(f"https://api.jikan.moe/v4/{resource}" + (f"/{identity}/full" if identity else ""), params=params)
    elif provider == "tvmaze":
        value = get_json(f"https://api.tvmaze.com/shows/{identity}", params={"embed": "episodes"}) if identity else get_json("https://api.tvmaze.com/search/shows", params={"q": query})
    elif provider == "wikidata":
        if identity:
            params = {"action": "wbgetentities", "ids": identity, "props": "labels|descriptions|aliases|claims", "languages": "ru|en|ja|zh|ko", "format": "json"}
        else:
            language = "ru" if re.search("[А-Яа-яЁё]", query) else "ja" if re.search("[ぁ-ヿ]", query) else "ko" if re.search("[가-힣]", query) else "zh" if re.search("[一-鿿]", query) else "en"
            params = {"action": "wbsearchentities", "search": query, "language": language, "uselang": "ru", "limit": 20, "format": "json"}
        value = get_json("https://www.wikidata.org/w/api.php", params=params)
    else:
        if identity:
            try:
                response = requests.get(f"https://www.imdb.com/title/{identity}/", headers={"User-Agent": USER_AGENT}, timeout=(6, 15))
                response.raise_for_status()
                if len(response.content) > 8 * 1024 * 1024:
                    raise SourceError("Страница каталога слишком велика.")
                script = BeautifulSoup(response.text, "html.parser").find("script", type="application/ld+json")
                value = json.loads(script.string) if script and script.string else {}
            except (requests.RequestException, ValueError):
                raise SourceError("Подробности IMDb сейчас недоступны.") from None
        else:
            from urllib.parse import quote
            if not query:
                value = {"d": []}
            else:
                encoded = quote(query.lower(), safe="")
                value = get_json(f"https://v3.sg.media-imdb.com/suggestion/{encoded[:1]}/{encoded}.json")
    with _lock:
        _cache[cache_key] = (time.monotonic() + (21600 if identity else 120), value)
        _cache.move_to_end(cache_key)
        while len(_cache) > 512:
            _cache.popitem(last=False)
    return value
