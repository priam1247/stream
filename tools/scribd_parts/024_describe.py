
def describe(body: bytes) -> str:
    if any(m in body for m in DOC_MARKERS):
        return "document content"
    if any(m in (body or b"").lower() for m in CHALLENGE):
        return "CHALLENGE page"
    return "no document markers"
