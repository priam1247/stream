

def jwt_ok(token: str) -> bool:
    """Both leading segments must really decode to JSON.

    "navigator.userAgent.toLowerCase" has three dot-separated parts and passes
    any shape test; only the decode tells it apart from a real token.
    """
    parts = (token or "").split(".")
    if len(parts) != 3:
        return False
    try:
        for segment in parts[:2]:
            raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
            json.loads(raw.decode("utf-8", "replace"))
        return True
    except Exception:  # noqa: BLE001
        return False
