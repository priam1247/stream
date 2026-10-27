

def token_ok(name: str, expires, given: str) -> bool:
    """Is that signature ours, for this file, and still in date?"""
    if not PANEL_KEY:
        return True                       # an open panel needs no signature
    if not given or expires is None:
        return False
    try:
        moment = int(expires)
    except (TypeError, ValueError):
        return False
    now = time.time()
    if moment < now or moment > now + 7 * 24 * 3600:
        return False                      # expired, or absurdly far ahead
    return hmac.compare_digest(given.strip(), file_token(name, moment))
