

def find_refusal(status: int, body: bytes, error: str = "") -> str:
    """Say plainly whether Scribd refused the address or just had no answer."""
    if any(marker in (body or b"").lower() for marker in CHALLENGE):
        return (f"HTTP {status} challenge page — Scribd wants a browser check "
                f"from this address")
    if status in (401, 403, 429, 503):
        return (f"HTTP {status} — Scribd refused the search from this address; "
                f"the download still works, the search has to happen elsewhere")
    if not status:
        return f"no answer ({error or 'connection failed'})"
    return f"HTTP {status}"
