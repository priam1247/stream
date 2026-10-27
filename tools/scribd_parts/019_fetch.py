
def fetch(url: str, jar: dict[str, str] | None = None, referer: str = "",
          timeout: float = 25.0) -> dict:
    target = rebase(url)
    headers = {"User-Agent": UA,
               "Accept": "text/html,application/xhtml+xml,application/json,"
                         "image/avif,image/webp,image/*,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Accept-Encoding": "gzip, deflate"}
    if referer:
        headers["Referer"] = rebase(referer)
    if jar:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in jar.items())
    for _hop in range(4):
        parsed = urllib.parse.urlsplit(target)
        scheme = parsed.scheme or "https"
        netloc = parsed.netloc
        path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        status = 0
        body = b""
        location = ""
        answer: dict = {}
        answered = False
        for attempt in (0, 1):
            connection = _connection(scheme, netloc, timeout)
            try:
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                status = response.status
                body = _decompress(response.read(),
                                   (response.getheader("Content-Encoding") or "").lower())
                location = response.getheader("Location") or ""
                answer = {k.lower(): v for k, v in response.getheaders()}
                answered = True
                break
            except Exception as exc:  # noqa: BLE001
                _forget(scheme, netloc)
                if attempt:
                    return {"status": 0, "body": b"", "headers": {},
                            "error": repr(exc)[:200]}
        if not answered:
            return {"status": 0, "body": b"", "headers": {}, "error": "no answer"}
        if status in (301, 302, 303, 307, 308) and location:
            target = urllib.parse.urljoin(target, location)
            continue
        if status in SCRAPE_REFUSED and _scrape_open(parsed.netloc):
            through = _scrape_get(target, timeout)
            if through is not None:
                with _scrape_lock:
                    said = _scrape_said[0]
                    _scrape_said[0] = True
                if not said:
                    JOB.say(f"the front door answered {status} — the same page "
                            f"came through the scrape route instead")
                return through
        return {"status": status, "body": body, "headers": answer, "error": ""}
    return {"status": 0, "body": b"", "headers": {}, "error": "too many redirects"}
