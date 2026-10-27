

def ping_ok(base: str, timeout: float = 1.5) -> bool:
    """One cheap question: is a browser service actually home at this address?"""
    status, body, error = shot_get(base.rstrip("/") + "/shot/ping", timeout)
    if error or status != 200:
        return False
    try:
        return bool(json.loads(body).get("ok"))
    except Exception:                                   # noqa: BLE001
        return False
