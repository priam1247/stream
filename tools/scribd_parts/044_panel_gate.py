

def panel_gate(headers, query: dict, cookies: str = "") -> bool:
    """Is this request allowed in?

    Open panel: everything is. Keyed panel: the key must arrive as the
    X-Panel-Key header (a server-side proxy), as ?key= (a link somebody was
    given), or in the cookie that opening the panel with the right key sets.
    The cookie is SameSite=Strict, so another site cannot borrow it.
    """
    if not PANEL_KEY:
        return True
    wanted = PANEL_KEY.encode()
    given = (headers.get("X-Panel-Key") or "").strip()
    if not given:
        given = (query.get("key") or [""])[0].strip()
    if not given and cookies:
        for part in cookies.split(";"):
            name, _sep, value = part.strip().partition("=")
            if name == PANEL_COOKIE:
                given = urllib.parse.unquote(value.strip())
                break
    return bool(given) and hmac.compare_digest(given.encode(), wanted)
