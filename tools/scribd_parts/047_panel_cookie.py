

def panel_cookie() -> str:
    """The cookie that keeps the panel working after ?key= was used once."""
    return (f"{PANEL_COOKIE}={urllib.parse.quote(PANEL_KEY, safe='')}; "
            "Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
