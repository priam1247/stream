

def body_manifest(body: bytes) -> dict:
    """The JSON tail of a /shots answer, without re-walking the pictures."""
    import json as _json
    # the manifest is the last JSON object: cut at the final zero length mark
    mark = body.rfind(b"\x00\x00\x00\x00")
    tail = body[mark + 4:] if mark >= 0 else b"{}"
    try:
        got = _json.loads(tail or b"{}")
    except Exception:                                              # noqa: BLE001
        return {}
    return got if isinstance(got, dict) else {}
