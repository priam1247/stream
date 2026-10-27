

def file_token(name: str, expires: int) -> str:
    """A short-lived signature for one file, so a browser can fetch it directly.

    Why this exists: the dashboard proxies every byte through its own server
    function, and a hosting function has a wall-clock limit (60 s on Vercel's
    free plan). A 150 MB book on a slow link does not fit in that. With this the
    dashboard mints `?t=…&e=…` for one file and one moment, the phone downloads
    straight from the panel, and the panel key never appears in the URL.
    """
    if not PANEL_KEY:
        return ""
    message = f"{name}|{int(expires)}".encode()
    return hmac.new(PANEL_KEY.encode(), message, hashlib.sha256).hexdigest()
