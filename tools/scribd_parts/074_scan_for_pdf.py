

def scan_for_pdf(data: bytes) -> dict | None:
    """One page picture -> {'payload','params','width','height','rotate','label'}.

    The picture is a browser's photograph of a page; nothing else feeds this any
    more.

    Two facts ride along with the picture, because both decide what the report
    can honestly say about it:

      complete  the file ends where it should (JPEG end-of-image, PNG IEND).
                A transfer cut in the middle looks normal otherwise.
      preview   a complete, page-shaped picture smaller than a real scan: some
                documents are only served at that size. It still goes into the
                PDF, scaled to the sheet, and the count is reported — a readable
                page beats a blank placeholder with an excuse.
    """
    if data[:2] == b"\xff\xd8":
        frames, complete = jpeg_frames(data)
        width, height, components = jpeg_size(data)
        preview = False
        if width and not page_can_be_this_small(width, height, len(data)):
            # a page-sized file cannot really be a 772x68 picture: the header
            # read is wrong, so ask a decoder before believing either number
            wide, tall, guess = pillow_size(data)
            if page_can_be_this_small(wide, tall, len(data)):
                width, height, components = wide, tall, guess
            else:
                width = 0
        if not (width and plausible_page({"width": width, "height": height})):
            # the header chain said nothing usable, or said something no page
            # could be: ask a real decoder, then fall back to the best picture
            # the file actually contains
            wide, tall, guess = pillow_size(data)
            if wide and tall and plausible_page({"width": wide, "height": tall}):
                width, height, components = wide, tall, guess
            else:
                width, height, components = small_frame(frames)
                if not width:
                    # even an odd-shaped or tiny page beats a blank placeholder
                    width, height, components = best_frame_any_shape(frames)
                if not width:
                    return None
                preview = True
        space = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(
            components, "/DeviceRGB")
        return {"payload": data, "width": width, "height": height,
                "rotate": jpeg_orientation(data),
                "params": (f"/Width {width} /Height {height} /ColorSpace {space} "
                           "/BitsPerComponent 8 /Filter /DCTDecode /Interpolate true"),
                "label": (f"{width}x{height} jpeg, {len(data) / 1000:.0f} kB"
                          + (", small preview" if preview else "")
                          + ("" if complete else ", cut short")),
                "preview": preview, "complete": complete}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        complete = data.rstrip(b"\x00\t\r\n ").endswith(b"IEND\xaeB`\x82")
        direct = png_for_pdf(data)
        if direct:
            return with_flags(direct, complete)
        decoded = png_to_raw(data)
        if decoded:
            pixels, width, height, components = decoded
            return with_flags(_raw_page(pixels, width, height, components,
                                        f"{width}x{height} png"), complete)
        return with_flags(pillow_page(data), complete)   # 16-bit / interlaced
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return with_flags(pillow_page(data))
    return with_flags(pillow_page(data))
