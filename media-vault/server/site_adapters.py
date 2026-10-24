"""Site-specific public HTML adapters. No catalogue/video-site API requests."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import re
import time
import threading
from urllib.parse import urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup

from source_parser import PublicHttp, Resolver, SourceError, episode_number, parse_page, public_url


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    root: str
    hosts: tuple
    cards: str
    title: str
    search_path: str = "/"
    kind: str = "anime"

    def search_url(self, query):
        if self.id == "animego":
            return self.root + "/search/anime?" + urlencode({"search": query})
        if self.id == "jutsu":
            # Jut.su's public catalogue is HTML; its search form is not a DLE API.
            return self.root + "/anime/"
        if self.id == "anilibria":
            return self.root + "/pages/catalog.php?" + urlencode({"search": query})
        return self.root + self.search_path + "?" + urlencode({"do": "search", "subaction": "search", "story": query})


SITES = (
    Site("yummy", "YummyAnime", "https://yummyanime.tv", ("yummyanime.tv",), ".movie-item", ".movie-item__title"),
    Site("animego", "AnimeGo", "https://animego.me", ("animego.me", "animego.org"), ".animes-list-item, .anime-item", ".h5, h2, h3"),
    Site("jutsu", "Jut.su", "https://jut.su", ("jut.su",), ".all_anime_global, .all_anime", ".aaname, .anime_name"),
    Site("animevost", "AnimeVost", "https://animevost.org", ("animevost.org",), ".shortstory", ".shortstoryHead h2, .shortstoryHead a", "/index.php"),
    Site("anilibria", "AniLibria", "https://anilibria.tv", ("anilibria.tv", "anilibria.top", "aniliberty.top"), ".release, .release-item, .goodcell", "h2, h3, .title"),
    Site("readmanga", "ReadManga", "https://readmanga.live", ("readmanga.live", "mintmanga.live"), ".tile, .manga-list-item", "h3, .title", "/search", "manga"),
)
BY_ID = {site.id: site for site in SITES}


def site_for(url):
    host = urlsplit(public_url(url, resolve_dns=False)).hostname
    return next((site for site in SITES if host in site.hosts), None)


def clean(value, limit=300):
    return " ".join(str(value or "").split())[:limit]


def link(value, base):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return public_url(urljoin(base, str(value)), resolve_dns=False)
    except SourceError:
        return None


def parse_search(site, text, base, query=""):
    soup = BeautifulSoup(text, "html.parser")
    results, seen = [], set()
    cards = soup.select(site.cards)
    if site.id == "jutsu":
        cards = soup.select("a[href]")
    for card in cards:
        heading = card.select_one(site.title)
        anchor = heading.find_parent("a") if heading else None
        anchor = anchor or card.select_one("a[href]") or (card if card.name == "a" else None)
        if not anchor:
            continue
        url = link(anchor.get("href"), base)
        if not url or urlsplit(url).hostname not in site.hosts or url in seen:
            continue
        image = card.select_one("img")
        title = clean(heading.get_text(" ", strip=True) if heading else anchor.get_text(" ", strip=True))
        title = title or clean(image.get("alt") if image else "")
        if site.id == "jutsu":
            if not card.select_one(".aaname, .all_anime_global, .all_anime") and not re.search(r"class=[\"'][^\"']*all_anime", str(card)):
                continue
            title = clean((card.select_one(".aaname") or card).get_text(" ", strip=True))
        if not title or (query and site.id == "jutsu" and query.casefold() not in (title + " " + url).casefold()):
            continue
        seen.add(url)
        result = {"provider": site.id, "providerName": site.name, "url": url, "title": title,
                  "kind": site.kind, "dubs": [], "releaseDates": []}
        if image:
            result["cover"] = link(image.get("data-src") or image.get("src"), base)
        # Only labels actually present in the HTML are exposed as voice filters.
        for element in card.select("[data-translation], [data-dubbing], .dubbing, .translation"):
            value = clean(element.get("data-translation") or element.get("data-dubbing") or element.get_text(" "), 120)
            if value and value not in result["dubs"]:
                result["dubs"].append(value)
        results.append(result)
    return results[:24]


def player_choices(text, base):
    """Kodik publishes real translation/season IDs in its HTML select options."""
    soup = BeautifulSoup(text, "html.parser")
    choices = []
    for select in soup.select(".serial-translations-box select, select[name*=translation], select[data-type=translation]"):
        for option in select.select("option"):
            kind = option.get("data-media-type") or option.get("data-type", "serial")
            identity = option.get("data-media-id") or option.get("data-id")
            digest = option.get("data-media-hash") or option.get("data-hash")
            explicit = option.get("data-src") or option.get("data-link") or option.get("value", "")
            target = link(explicit, base) if explicit.startswith(("/", "https:")) else None
            if identity and digest and kind in {"serial", "video", "seria"} and re.fullmatch(r"[\w-]+", identity + digest):
                root = urlsplit(base)
                target = f"https://{root.netloc}/{kind}/{identity}/{digest}/720p"
            if target and (identity or target != base):
                choices.append({"id": str(option.get("value") or identity), "name": clean(option.get("data-title") or option.get_text(" "), 120), "url": target})
    seasons = []
    for option in soup.select(".serial-seasons-box option, select[name*=season] option"):
        number = option.get("value", "")
        target = link(option.get("data-src") or option.get("data-link"), base)
        identity, digest = option.get("data-serial-id") or option.get("data-id"), option.get("data-serial-hash") or option.get("data-hash")
        if identity and digest and re.fullmatch(r"[\w-]+", identity + digest):
            target = f"https://{urlsplit(base).netloc}/serial/{identity}/{digest}/720p"
        if number.isdigit() and 1 <= int(number) <= 1000:
            seasons.append({"number": int(number), "url": target, "name": clean(option.get_text(" "))})
    return choices, seasons


def parse_reader(text, base):
    """ReadManga's HTML reader exposes image locations without a developer API."""
    soup = BeautifulSoup(text, "html.parser")
    pages, chapters = [], []
    for image in soup.select("#mangaPicture, .reader-page img, .manga-pages img, img[data-page]"):
        value = link(image.get("data-src") or image.get("src"), base)
        if value:
            pages.append(value)
    # rm_h.init is parsed as data, never evaluated as JavaScript.
    match = re.search(r"rm_h\.init\s*\(\s*(\[\s*\[.*?\]\s*\])", text, re.S)
    if match:
        import json
        try:
            values = json.loads(match[1])
            for parts in values:
                if isinstance(parts, list) and all(isinstance(part, str) for part in parts[:3]):
                    value = link("".join(parts[:3]), base)
                    if value:
                        pages.append(value)
        except (ValueError, TypeError):
            pass
    for anchor in soup.select(".chapters-link, .chapters a[href], .chapter-link"):
        value = link(anchor.get("href"), base)
        number = episode_number(anchor.get_text(" "))
        if number is None:
            match = re.search(r"(?:глава|chapter|ch)\s*(\d+)", anchor.get_text(" "), re.I)
            number = int(match[1]) if match else None
        if value and number:
            chapters.append({"number": number, "url": value, "title": clean(anchor.get_text(" "))})
    return list(dict.fromkeys(pages)), list({entry["url"]: entry for entry in chapters}.values())


def inspect_source(url, *, http=None, dub_url=None, season=None, kind="anime"):
    own_http = http is None
    http = http or PublicHttp()
    try:
        original = public_url(url, resolve_dns=False)
        site = site_for(original)
        if urlsplit(original).path.lower().endswith((".mp4", ".m3u8")):
            return {"provider": "direct", "title": "Видео по ссылке", "url": original,
                    "dubs": [], "seasons": [], "episodes": [{"number": 1, "url": original}], "releases": []}
        text, final, _ = http.document(original)
        page = parse_page(text, final)
        choices, seasons = player_choices(text, final)
        if kind == "ranobe":
            soup = BeautifulSoup(text, "html.parser")
            _, chapters = parse_reader(text, final)
            has_text = bool(soup.select_one(".chapter-content, .text-content, article"))
            return {"provider": site.id if site else "public", "title": page.title, "url": final,
                    "dubs": [], "seasons": [], "episodes": chapters or ([{"number": 1, "url": final}] if has_text else []), "releases": []}
        if kind == "manga" or (site and site.kind == "manga"):
            pages, chapters = parse_reader(text, final)
            return {"provider": site.id if site else "public", "title": page.title, "url": final, "dubs": [], "seasons": [],
                    "episodes": chapters or ([{"number": 1, "url": final}] if pages else []),
                    "pages": pages, "kind": "manga", "releases": []}
        # Inspect bounded nested public frames, including a site's player relay.
        # JSON iframe responses are parsed as text, never executed as scripts.
        def embedded_pages():
            pending = [(embed, final, 1) for embed in page.players[:8]]
            seen = {final}
            count = 0
            while pending and count < 12:
                embed, referer, depth = pending.pop(0)
                if embed in seen or urlsplit(embed).hostname in {"www.youtube.com", "youtube.com", "youtu.be", "www.youtube-nocookie.com"}:
                    continue
                seen.add(embed)
                count += 1
                try:
                    embedded_text, embedded_final, _ = http.document(embed, headers={"Referer": referer})
                    embedded = parse_page(embedded_text, embedded_final)
                except SourceError:
                    continue
                yield embedded_text, embedded_final, embedded
                if depth < 3:
                    pending.extend((child, embedded_final, depth + 1) for child in embedded.players[:8])

        # A selected dub must be published by the source or its embedded player.
        if dub_url:
            candidates = [public_url(dub_url, resolve_dns=False)]
            dub_referer = final
            allowed = {entry["url"] for entry in choices}
            if dub_url not in allowed:
                # A selected dub belongs to an embedded player, whose choices are checked below.
                found = False
                for embedded_text, embedded_final, _ in embedded_pages():
                    values, _ = player_choices(embedded_text, embedded_final)
                    if dub_url in {entry["url"] for entry in values}:
                        found = True
                        choices = values
                        dub_referer = embedded_final
                        break
                if not found:
                    raise SourceError("Выбранная озвучка больше не найдена на странице. Обнови список.")
        else:
            candidates = None
        episodes = [] if dub_url else page.episodes
        if candidates:
            selected_text, selected_final, _ = http.document(candidates[0], headers={"Referer": dub_referer})
            selected_page = parse_page(selected_text, selected_final)
            documents = [(selected_text, selected_final, selected_page)]
        else:
            documents = embedded_pages()
        for embedded_text, embedded_final, embedded in documents:
            new_choices, new_seasons = player_choices(embedded_text, embedded_final)
            choices = (new_choices or choices) if dub_url else (choices or new_choices)
            seasons = new_seasons if dub_url else (seasons or new_seasons)
            if embedded.episodes:
                episodes = embedded.episodes
                break
            target = urlsplit(embedded_final)
            if target.hostname in {"kodikplayer.com", "kodik.info", "kodik.biz", "kodik.cc", "aniqit.com"} and re.match(r"/video/[\w-]+/[\w-]+(?:/|$)", target.path):
                episodes = [{"number": 1, "title": "Видео", "url": embedded_final}]
                break
        if not episodes and page.streams:
            episodes = [{"number": episode_number(final) or 1, "url": final}]
        # Episode season/translation values are recorded, never guessed from a total count.
        for entry in episodes:
            match = re.search(r"(?:season|sezon)[/-](\d+)", entry["url"], re.I)
            if match:
                entry["season"] = int(match[1])
        soup = BeautifulSoup(text, "html.parser")
        releases = [{"date": element.get("datetime"), "label": clean(element.parent.get_text(" "))}
                    for element in soup.select(".episode time[datetime], .release time[datetime], .schedule time[datetime], [data-episode] time[datetime]") if element.get("datetime")][:100]
        return {"provider": site.id if site else "public", "title": page.title, "url": final,
                "dubs": choices, "seasons": seasons, "episodes": episodes, "releases": releases,
                "available": bool(episodes), "checkedAt": int(time.time())}
    finally:
        if own_http:
            http.close()


def search_site(site, query, *, http=None):
    own_http = http is None
    http = http or PublicHttp(timeout=(5, 12))
    try:
        text, final, _ = http.document(site.search_url(query))
        return {"provider": site.id, "name": site.name, "status": "ok", "results": parse_search(site, text, final, query)}
    except SourceError as error:
        return {"provider": site.id, "name": site.name, "status": "unavailable", "message": str(error), "results": []}
    finally:
        if own_http:
            http.close()


def search_sources(query, kind="anime"):
    if kind not in {"anime", "manga"}:
        return {"providers": [], "results": [], "checkedAt": int(time.time())}
    sites = [site for site in SITES if site.kind == ("manga" if kind == "manga" else "anime")]
    results = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(search_site, site, query) for site in sites]
        for future in as_completed(futures):
            results.append(future.result())
    return {"providers": results, "results": [item for result in results for item in result["results"]], "checkedAt": int(time.time())}


_voice_cache, _voice_lock = {}, threading.Lock()


def voice_availability(query):
    """Bounded HTML lookups, cached for 15 minutes; never a fabricated global dub index."""
    with _voice_lock:
        cached = _voice_cache.get(query.casefold())
        if cached and cached[0] > time.monotonic():
            return cached[1]
    import difflib
    normalize = lambda value: re.sub(r"[^\w]+", " ", value.casefold()).strip()
    target = normalize(query)
    dubs, sources = set(), []
    for identity in ("yummy", "animevost"):
        result = search_site(BY_ID[identity], query)
        score = lambda item: max(
            difflib.SequenceMatcher(None, target, normalize(item["title"].split("/")[0])).ratio(),
            difflib.SequenceMatcher(None, target, normalize(urlsplit(item["url"]).path)).ratio())
        candidates = sorted(result["results"], key=score, reverse=True)
        if not candidates or score(candidates[0]) < 0.45:
            continue
        candidate = candidates[0]
        # Search results are only candidates. A voice is reported with its source URL.
        http = PublicHttp(timeout=(5, 12))
        try:
            inspected = inspect_source(candidate["url"], http=http)
            names = [entry["name"] for entry in inspected["dubs"]]
            dubs.update(names)
            sources.append({"provider": identity, "title": candidate["title"], "url": candidate["url"], "dubs": names})
        except SourceError:
            pass
        finally:
            http.close()
    value = {"query": query, "dubs": sorted(dubs), "sources": sources, "checkedAt": int(time.time())}
    with _voice_lock:
        _voice_cache[query.casefold()] = (time.monotonic() + 900, value)
        if len(_voice_cache) > 128:
            _voice_cache.pop(next(iter(_voice_cache)))
    return value
