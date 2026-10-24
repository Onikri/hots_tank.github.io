"""Public HTML/player resolver. No anime catalogue/search REST APIs are used.

Only the Kodik, Aniboom, Sibnet and Animedia player implementations from
anime-dl-core (MIT) are enabled. API-based AniLibria/CVH/Alloha adapters are
deliberately not registered. Google credentials never enter this module.
"""
from __future__ import annotations

import html
import ipaddress
import json
import re
import socket
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests


class SourceError(RuntimeError):
    pass


USER_AGENT = "MediaVault/3.0 (personal public-media importer)"
MAX_DOCUMENT = 4 * 1024 * 1024
MAX_VIDEO = 40 * 1024**3
BLOCKED = re.compile(
    r"/cdn-cgi/challenge-platform|cf-chl-|__cf_chl_|checking your browser|"
    r"enable javascript and cookies to continue|verify (?:that )?you are human|"
    r"<title[^>]*>\s*(?:just a moment|access denied)|"
    r"[\"'](?:subscription_required|requires_subscription|requires_authentication)[\"']\s*:\s*true",
    re.I,
)


def public_url(value, *, resolve_dns=True):
    """Validate every request and every redirect, including nested HLS URLs."""
    if not isinstance(value, str) or len(value) > 8192:
        raise SourceError("Некорректная ссылка источника.")
    try:
        url = urlsplit(value.strip())
        host = (url.hostname or "").lower()
        port = url.port
    except ValueError:
        raise SourceError("Некорректная ссылка источника.") from None
    if (url.scheme != "https" or url.username or url.password or port not in (None, 443)
            or not host or "." not in host or host.endswith(".")
            or host.endswith((".local", ".internal", ".localhost"))):
        raise SourceError("Поддерживаются только публичные HTTPS-ссылки без логина и пароля.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise SourceError("IP-адреса не поддерживаются; укажи публичный домен.")
    # Disallow catalogue REST/GraphQL calls even if a page advertises an API URL.
    if (host.startswith(("api.", "plapi."))
            or re.search(r"/(?:api|graphql)(?:/|$)", url.path, re.I)):
        raise SourceError("API сайтов отключены: нужна публичная страница или ссылка плеера.")
    if resolve_dns:
        try:
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except OSError:
            raise SourceError("Не удалось найти сервер источника.") from None
        if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
            raise SourceError("Локальные и служебные адреса источников запрещены.")
    return urlunsplit(("https", host, url.path or "/", url.query, ""))


def playback_headers(headers=None):
    """Allow only public playback headers; never forward cookies or authorization."""
    result = {"User-Agent": USER_AGENT}
    for key, value in (headers or {}).items():
        name = {"referer": "Referer", "origin": "Origin", "user-agent": "User-Agent"}.get(key.lower())
        if not name:
            continue
        if not isinstance(value, str) or len(value) > 8192 or "\r" in value or "\n" in value:
            raise SourceError("Некорректный заголовок плеера.")
        if name in {"Referer", "Origin"}:
            value = public_url(value, resolve_dns=False)
            if name == "Origin":
                parsed = urlsplit(value)
                value = f"{parsed.scheme}://{parsed.netloc}"
        result[name] = value
    return result


class PublicHttp:
    def __init__(self, *, session=None, validate=public_url, timeout=(20, 45)):
        self.session = session or requests.Session()
        self.validate = validate
        self.timeout = timeout
        # Session is source-only and is never shared with Google Drive.
        self.session.headers.clear()

    def close(self):
        self.session.close()

    def _open(self, value, *, headers=None, method="GET", data=None, byte_range=None):
        url = self.validate(value)
        outgoing = playback_headers(headers)
        if byte_range:
            outgoing["Range"] = byte_range
        if method == "POST":
            # Only a public Kodik player's same-origin playback form, not a site API.
            host = urlsplit(url).hostname
            if not (host in {"kodikplayer.com", "kodik.info", "kodik.biz", "kodik.cc", "aniqit.com"}
                    and re.fullmatch(r"/[a-zA-Z0-9_-]{1,40}", urlsplit(url).path)):
                raise SourceError("Этот POST не относится к поддерживаемому публичному плееру.")
            outgoing["X-Requested-With"] = "XMLHttpRequest"
            outgoing["Accept"] = "application/json, text/javascript, */*; q=0.01"
        for hop in range(6):
            try:
                # Clear cookies collected by previous HTML pages, including redirects.
                self.session.cookies.clear()
                response = self.session.request(method, url, headers=outgoing, data=data,
                                                timeout=self.timeout, allow_redirects=False, stream=True)
            except requests.RequestException:
                raise SourceError("Источник не ответил. Повтори импорт позднее.") from None
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location", "")
                response.close()
                if not location or hop == 5:
                    raise SourceError("Некорректное перенаправление источника.")
                next_url = self.validate(urljoin(url, location))
                if method == "POST" and urlsplit(next_url).netloc != urlsplit(url).netloc:
                    raise SourceError("Плеер перенаправил форму на другой сервер.")
                if response.status_code == 303:
                    method, data = "GET", None
                url = next_url
                continue
            if not 200 <= response.status_code < 300:
                status = response.status_code
                response.close()
                if status in {401, 403}:
                    raise SourceError("Источник требует вход, проверку браузера или ограничивает доступ.")
                raise SourceError(f"Источник вернул HTTP {status}.")
            return response, url
        raise SourceError("Слишком много перенаправлений.")

    def document(self, value, *, headers=None, method="GET", data=None):
        response, url = self._open(value, headers=headers, method=method, data=data)
        try:
            parts, size, start = [], 0, time.monotonic()
            for block in response.iter_content(65536):
                size += len(block)
                if size > MAX_DOCUMENT or time.monotonic() - start > 90:
                    raise SourceError("Страница или плейлист слишком велики.")
                parts.append(block)
            text = b"".join(parts).decode(response.encoding if response.encoding not in (None, "ISO-8859-1") else "utf-8", errors="replace")
            if BLOCKED.search(text):
                raise SourceError("Страница требует проверку браузера или подписку. Выбери другой публичный источник.")
            return text, url, dict(response.headers)
        finally:
            response.close()

    def download(self, value, target, *, headers=None, byte_range=None, maximum=MAX_VIDEO):
        response, final_url = self._open(value, headers=headers, byte_range=byte_range)
        expected = None
        if byte_range:
            expected = int(byte_range.split("-")[1]) - int(byte_range.split("=")[1].split("-")[0]) + 1
            if response.status_code != 206 or response.headers.get("Content-Range", "").split("/")[0] != byte_range.replace("=", " "):
                response.close()
                raise SourceError("Источник не поддерживает нужный диапазон HLS.")
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > maximum:
            response.close()
            raise SourceError("Файл превышает лимит свободной сессии.")
        size = 0
        try:
            if "text/html" in response.headers.get("Content-Type", "").lower():
                raise SourceError("Вместо видео источник вернул HTML-страницу.")
            with Path(target).open("wb") as output:
                for block in response.iter_content(1024 * 1024):
                    size += len(block)
                    if size > maximum:
                        raise SourceError("Файл превышает лимит свободной сессии.")
                    output.write(block)
            if size == 0 or (expected is not None and size != expected) or (declared and declared.isdigit() and size != int(declared)):
                raise SourceError("Источник передал неполный файл.")
            return size
        except requests.RequestException:
            Path(target).unlink(missing_ok=True)
            raise SourceError("Скачивание прервалось. Повтори импорт: завершённые серии будут пропущены.") from None
        except BaseException:
            Path(target).unlink(missing_ok=True)
            raise
        finally:
            response.close()

    # The exact small interface anime-dl-core expects. It cannot use its own network client.
    def get(self, url, *, headers=None, params=None, **_):
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        text, final, response_headers = self.document(url, headers=headers)
        from anime_dl_core.http import Response
        return Response(200, text, final, response_headers)

    def post(self, url, *, headers=None, data=None):
        text, final, response_headers = self.document(url, headers=headers, method="POST", data=data)
        from anime_dl_core.http import Response
        return Response(200, text, final, response_headers)


def episode_number(text):
    for expression in (r"(?:серия|эпизод|episode|ep)[\s_/-]*(\d{1,4})(?!\d)",
                       r"(?<!\d)(\d{1,4})[\s_/-]*(?:серия|серию|серии|seriya|episode)(?![a-z])"):
        found = re.search(expression, text, re.I)
        if found and int(found[1]) > 0:
            return int(found[1])
    query = dict(parse_qsl(urlsplit(text).query))
    if query.get("episode", "").isdigit() and int(query["episode"]) > 0:
        return int(query["episode"])
    return None


@dataclass
class Page:
    title: str = ""
    streams: list = field(default_factory=list)
    players: list = field(default_factory=list)
    episodes: list = field(default_factory=list)


class PageParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.result = base, Page()
        self.title = False
        self.anchor = None
        self.select = ""
        self.option = None
        self.containers = []
        self.yummy_player_id = None

    def link(self, value):
        try:
            return public_url(urljoin(self.base, html.unescape(value).replace("\\/", "/")), resolve_dns=False)
        except SourceError:
            return None

    def candidate(self, value, label="", attrs=None):
        url = self.link(value)
        if not url:
            return
        path = urlsplit(url).path.lower()
        if path.endswith((".mp4", ".m3u8")):
            self.result.streams.append({"url": url, "type": "hls" if path.endswith(".m3u8") else "mp4",
                                        "quality": None, "headers": {"Referer": self.base}})
        number = episode_number(label + " " + url)
        if attrs and str(attrs.get("data-episode", "")).isdigit():
            number = int(attrs["data-episode"])
        if number and urlsplit(url).netloc == urlsplit(self.base).netloc and url != self.base:
            self.result.episodes.append({"number": number, "title": label.strip()[:180], "url": url})
        if re.search(r"/(?:embed|seria|serial|shell\.php|vod|video_ext\.php)(?:/|\?|$)", url):
            self.result.players.append(url)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        # The site's published player-relay.js loads these exact public slots.
        # Read the same GET response as the iframe; no search/developer API,
        # session, key or generated player ID is used.
        if urlsplit(self.base).hostname == "yummyanime.tv":
            identity = attrs.get("data-player-anime-id", "")
            if re.fullmatch(r"\d{1,10}", identity):
                self.yummy_player_id = identity
            slot = attrs.get("data-player-slot", "")
            if self.yummy_player_id and re.fullmatch(r"\d{1,2}", slot):
                query = urlencode({"mod": "player", "id": self.yummy_player_id, "slot": slot})
                self.result.players.append("https://yummyanime.tv/engine/ajax/controller.php?" + query)
        if tag == "div":
            self.containers.append(attrs.get("class", ""))
        if tag == "title":
            self.title = True
        if tag == "meta" and (attrs.get("property") or attrs.get("name")) == "og:title":
            self.result.title = (attrs.get("content") or "")[:300]
        if tag == "a":
            self.anchor = [attrs, ""]
        if tag == "select":
            self.select = " ".join(self.containers[-4:] + [attrs.get("class", ""), attrs.get("name", "")])
        if tag == "option":
            self.option = [attrs, "", self.select]
        for attribute in ("src", "data-src", "data-href", "data-video", "data-player"):
            value = attrs.get(attribute)
            if value:
                self.candidate(value, attrs=attrs)
                if tag in {"iframe", "embed"}:
                    url = self.link(value)
                    if url:
                        self.result.players.append(url)

    def handle_data(self, data):
        if self.title and not self.result.title:
            self.result.title = data.strip()[:300]
        if self.anchor:
            self.anchor[1] += data
        if self.option:
            self.option[1] += data

    def handle_endtag(self, tag):
        if tag == "div" and self.containers:
            self.containers.pop()
        if tag == "title":
            self.title = False
        if tag == "a" and self.anchor:
            attrs, label = self.anchor
            self.candidate(attrs.get("href", ""), label, attrs)
            self.anchor = None
        if tag == "option" and self.option:
            attrs, label, select = self.option
            if attrs.get("value", "").startswith(("/", "https:")):
                self.candidate(attrs["value"], label, attrs)
            # Kodik's published episode choices carry per-episode IDs and hashes.
            if "serial-series" in select and attrs.get("data-id") and attrs.get("data-hash"):
                number = episode_number(label) or (int(attrs["value"]) if attrs.get("value", "").isdigit() else None)
                if number:
                    root = urlsplit(self.base)
                    url = f"https://{root.netloc}/seria/{attrs['data-id']}/{attrs['data-hash']}/720p"
                    self.result.episodes.append({"number": number, "title": label[:180], "url": url})
            self.option = None
        if tag == "select":
            self.select = ""


def parse_page(text, base):
    if BLOCKED.search(text):
        raise SourceError("Источник требует проверку браузера или подписку.")
    parser = PageParser(base)
    parser.feed(text)
    # Public inline player configuration; scripts are read as text, never executed.
    decoded = html.unescape(text).replace("\\/", "/")
    for match in re.finditer(r"[\"']((?:https:)?//[^\s<>\"'\\]+|/[^\s<>\"'\\]+\.(?:mp4|m3u8)(?:\?[^\s<>\"'\\]*)?)[\"']", decoded):
        parser.candidate(match[1])
    page = parser.result
    page.streams = list({entry["url"]: entry for entry in page.streams}.values())[:100]
    page.players = list(dict.fromkeys(page.players))[:50]
    # Multiple dubs can publish the same episode. Preserve the page's first choice.
    page.episodes = list({entry["number"]: entry for entry in reversed(page.episodes)}.values())
    page.episodes.sort(key=lambda entry: entry["number"])
    return page


class Resolver:
    def __init__(self, http=None):
        self.http = http or PublicHttp()

    def inspect(self, url):
        url = public_url(url, resolve_dns=False)
        path = urlsplit(url).path.lower()
        if path.endswith((".mp4", ".m3u8")):
            return Page(streams=[{"url": url, "type": "hls" if path.endswith(".m3u8") else "mp4", "quality": None, "headers": {}}])
        text, final, _ = self.http.document(url)
        return parse_page(text, final)

    def player(self, url, referer=None):
        from anime_dl_core import AniboomPlayer, AnimediaPlayer, KodikPlayer, SibnetPlayer
        # Explicit registry: never ap.extract(), which also registers API-based players.
        for player_type in (KodikPlayer, AniboomPlayer, SibnetPlayer, AnimediaPlayer):
            if player_type.matches(url):
                with player_type(client=self.http) as player:
                    options = {"referer": referer} if referer else {}
                    if player_type is KodikPlayer:
                        options["include_mp4"] = False  # Do not fabricate MP4 URLs from HLS.
                    result = player.extract(url, **options)
                streams = [{"url": stream.url, "type": stream.kind.value, "quality": stream.quality,
                            "headers": playback_headers(stream.headers)} for stream in result.streams
                           if stream.kind.value in {"mp4", "hls"}]
                return Page(title=result.title or "", streams=streams)
        return None

    def resolve(self, url, *, referer=None, depth=0, visited=None):
        if depth > 4:
            raise SourceError("Слишком длинная цепочка вложенных плееров.")
        visited = visited if visited is not None else set()
        if url in visited:
            raise SourceError("Источник зациклил вложенные плееры.")
        visited.add(url)
        page = self.player(url, referer) or self.inspect(url)
        if page.streams:
            return page
        for embed in page.players:
            try:
                resolved = self.resolve(embed, referer=url, depth=depth + 1, visited=visited)
                if resolved.streams:
                    resolved.title = page.title or resolved.title
                    return resolved
            except (SourceError, requests.RequestException):
                continue
            except Exception as error:
                if error.__class__.__module__.startswith("anime_dl_core"):
                    continue
                raise
        raise SourceError("Публичный MP4/HLS-поток не найден. Вставь ссылку на доступную серию или поддерживаемый плеер.")
