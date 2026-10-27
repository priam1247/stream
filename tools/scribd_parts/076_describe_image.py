

def describe_image(data: bytes) -> str:
    """What actually arrived, in one line, so a refusal is never a riddle.

    "6 kB jpeg that is not a page scan" told nobody anything. This says the
    size the file declares, whether it is complete, and whether it was simply
    too small to be a page — which is the difference between a bad parse, a cut
    transfer and a document Scribd keeps at low resolution.
    """
    size = size_text(len(data))
    if not data:
        return "an empty body"
    if data[:2] == b"\xff\xd8":
        frames, complete = jpeg_frames(data)
        cut = "" if complete else ", cut short (no end-of-image marker)"
        width, height, _components = biggest_frame(frames)
        if not width:
            return f"a jpeg with no frame header, {size}{cut}"
        if not plausible_page({"width": width, "height": height}):
            return (f"a {width}x{height} jpeg, {size}{cut} — below the "
                    f"{MIN_PAGE_PX} px floor for a page")
        return f"a {width}x{height} jpeg, {size}{cut}"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return f"a png, {size}"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return f"a webp, {size}"
    return (f"{size} that is not an image at all "
            f"(starts {data[:12].decode('latin-1', 'replace').strip()!r})")
