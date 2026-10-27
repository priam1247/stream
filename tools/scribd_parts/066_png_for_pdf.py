
def png_for_pdf(data: bytes) -> dict | None:
    """Embed a PNG's own filtered scanlines. No decode, no pixel loop."""
    parsed = png_chunks(data)
    if parsed is None:
        return None
    header, palette, stream = parsed
    width, height = header["width"], header["height"]
    depth, colour = header["depth"], header["colour"]
    # only 8-bit goes in directly: 1/2/4-bit rows are legal in PDF but readers
    # disagree about unpacking them, and a page that renders differently in
    # someone else's reader is worse than a slow page.
    if header["interlace"] != 0 or depth != 8 or not width:
        return None
    if colour == 0:
        colours, space = 1, "/DeviceGray"
    elif colour == 2:
        colours, space = 3, "/DeviceRGB"
    elif colour == 3:
        if not palette:
            return None
        entries = max(1, len(palette) // 3)
        colours = 1
        space = (f"[/Indexed /DeviceRGB {entries - 1} "
                 f"<{palette[:entries * 3].hex()}>]")
    else:
        return None
    params = (f"/Width {width} /Height {height} /ColorSpace {space} "
              f"/BitsPerComponent {depth} /Filter /FlateDecode "
              f"/DecodeParms << /Predictor 15 /Colors {colours} "
              f"/BitsPerComponent {depth} /Columns {width} >>")
    return {"payload": stream, "params": params, "width": width, "height": height,
            "label": f"{width}x{height} png, {len(stream) / 1000:.0f} kB"}
