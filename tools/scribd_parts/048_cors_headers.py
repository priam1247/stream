

def cors_headers(origin: str) -> dict[str, str]:
    """Allow exactly the origins listed in PANEL_ORIGIN, and no others.

    A wildcard would let any page on the internet drive this panel with a
    visitor's cookies, so the list is explicit or the answer is none.
    """
    clean = (origin or "").strip().rstrip("/")
    if not clean or clean not in PANEL_ORIGINS:
        return {}
    return {"Access-Control-Allow-Origin": clean,
            "Access-Control-Allow-Headers": "Content-Type, X-Panel-Key",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin"}
