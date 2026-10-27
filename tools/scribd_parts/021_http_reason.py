
def http_reason(got: dict) -> str:
    """A short, honest description of a non-image answer."""
    body = got.get("body") or b""
    if body.startswith(b"<?xml") or b"<Error>" in body[:200]:
        code = re.search(rb"<Code>([^<]+)</Code>", body)
        label = code.group(1).decode("latin-1") if code else "xml error"
        return f"HTTP {got['status']} {label}"
    if body[:2] in (b"\xff\xd8", b"\x89P"):
        return f"HTTP {got['status']} short image"
    snippet = body[:50].decode("latin-1", "replace").strip()
    return f"HTTP {got['status']}, not an image ({snippet!r})"
