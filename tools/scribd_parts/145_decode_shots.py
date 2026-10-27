

def decode_shots(body: bytes) -> tuple[list[dict], str]:
    """The book wire format: [4-byte length][png] ... [zero length][manifest].

    A body that ends mid-picture or whose manifest is not JSON is an error, not
    a partial book: half a book of clipped pages would put the wrong picture on
    the wrong page number.
    """
    import json as _json
    buf = memoryview(body)
    pages: list[dict] = []
    at = 0
    while at + 4 <= len(buf):
        length = int.from_bytes(buf[at:at + 4], "big")
        at += 4
        if length == 0:
            break
        if at + length > len(buf):
            return [], "a picture runs past the end of the answer"
        pages.append({"png": bytes(buf[at:at + length])})
        at += length
    try:
        manifest = _json.loads(bytes(buf[at:]) or b"{}")
    except Exception:                                            # noqa: BLE001
        return [], "the manifest is not JSON"
    if not isinstance(manifest, dict):
        return [], "the manifest is not a JSON object"
    listed = manifest.get("pages") or []
    for entry, meta in zip(pages, listed if isinstance(listed, list) else []):
        if isinstance(meta, dict):
            entry.update({key: meta[key] for key in
                          ("page", "width", "height", "unstable", "blank")
                          if key in meta})
    for number, entry in enumerate(pages, 1):
        entry.setdefault("page", number)
        width, height = entry.get("width") or 0, entry.get("height") or 0
        if not (width and height):
            width, height = png_size(entry.get("png") or b"")
            entry["width"], entry["height"] = width, height
    return pages, ""
