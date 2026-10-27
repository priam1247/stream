"""Scribd panel — image decoding, page heuristics and PDF assembly.

Loaded by scribd_download.py after scribd_config.py. JPEG/PNG parsing,
page-shape checks, the PDF writer and the read-back verifier live here.
Annotations are compiled with PEP 563 by the loader.
"""


# ---------------------------------------------------------------------------
# images -> something a PDF can hold
# ---------------------------------------------------------------------------
def _sof_candidates(data: bytes) -> list[tuple[int, int, int]]:
    """Every JPEG frame header in the data, as (width, height, components)."""
    found: list[tuple[int, int, int]] = []
    for match in re.finditer(rb"\xff[\xc0-\xcf]", data):
        position = match.start()
        marker = data[position + 1]
        if marker in (0xC4, 0xC8, 0xCC):        # not frame headers
            continue
        if position + 10 > len(data):
            continue
        height, width = struct.unpack(">HH", data[position + 5:position + 9])
        components = data[position + 9]
        if width and height:
            found.append((width, height, components))
    return found

def jpeg_frames(data: bytes) -> tuple[list[tuple[int, int, int]], bool]:
    """Every frame header in a JPEG, and whether the file arrived whole.

    A cut transfer keeps the header and loses the tail, so the only honest test
    for "did this file arrive complete" is the end-of-image marker. Without it a
    viewer draws the decoded sliver and greys the rest — a page that looks like
    our bug instead of the CDN's.
    """
    if data[:2] != b"\xff\xd8":
        return [], False
    frames: list[tuple[int, int, int]] = []
    index = 2
    limit = min(len(data), 4_000_000)
    saw_scan = False
    while index + 4 <= limit:
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker == 0xD9:                    # end of image, before any scan
            break
        if marker == 0xDA:                    # scan data starts here
            saw_scan = True
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if index + 10 <= limit:
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                components = data[index + 9]
                if width and height:
                    frames.append((width, height, components))
        index += 2 + length
    tail = data.rstrip(b"\x00\t\r\n ")
    return frames, bool(saw_scan and tail.endswith(b"\xff\xd9"))


def biggest_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest picture in a JPEG file — never a header's decoy thumbnail."""
    if not frames:
        return 0, 0, 0
    return max(frames, key=lambda frame: frame[0] * frame[1])


def small_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest picture in the file that could be a page at all.

    v2.16 stopped excluding pages. A scanned upload often serves odd sizes —
    a 60x80 strip, a double-page spread far outside a page's aspect, a 349x383
    thumbnail — and a small or odd-looking page is still that page's content.
    A blank placeholder is strictly worse than a poor scan, so the rule is now:
    take the biggest frame that is not a 1-pixel smudge, whatever its shape.
    """
    best = (0, 0, 0)
    for width, height, components in frames:
        if min(width, height) < ABSOLUTE_MIN_PX:
            continue
        # prefer a page-shaped frame of the same area, but never insist
        if width * height > best[0] * best[1]:
            best = (width, height, components or 3)
    return best


def best_frame_any_shape(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest frame, page-shaped or not — the last resort before a blank."""
    usable = [frame for frame in frames if min(frame[0], frame[1]) >= ABSOLUTE_MIN_PX]
    if not usable:
        return 0, 0, 0
    return max(usable, key=lambda frame: frame[0] * frame[1])


def jpeg_size(data: bytes) -> tuple[int, int, int]:
    """The real frame size, validated — not the first marker we trip over.

    2.3 walked the marker chain and believed the first SOF it met. An EXIF
    thumbnail, a padding segment or a truncated chain can put a 772x68 "frame"
    in front of the real one, and then the whole book was laid out for 772x68.
    Now: walk the chain, collect every plausible frame, and only if none of them
    is a plausible page scan fall back to scanning the raw bytes.
    """
    if data[:2] != b"\xff\xd8":
        return 0, 0, 0
    walked, _complete = jpeg_frames(data)
    for group in (walked, _sof_candidates(data[:200_000])):
        for width, height, components in group:
            if (width >= MIN_PAGE_PX and height >= MIN_PAGE_PX
                    and ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]):
                return width, height, components or 3
    return 0, 0, 0

def jpeg_orientation(data: bytes) -> int:
    """EXIF orientation 1..8, or 1 when there is none."""
    if data[:2] != b"\xff\xd8":
        return 1
    index = 2
    while index + 4 <= min(len(data), 200_000):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker in (0xD9, 0xDA):
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        segment = data[index + 4:index + 2 + length]
        if marker == 0xE1 and segment[:6] == b"Exif\x00\x00":
            tiff = segment[6:]
            if len(tiff) > 8:
                little = tiff[:2] == b"II"
                order = "<" if little else ">"
                try:
                    ifd = struct.unpack(order + "I", tiff[4:8])[0]
                    count = struct.unpack(order + "H", tiff[ifd:ifd + 2])[0]
                    for entry in range(count):
                        base = ifd + 2 + entry * 12
                        tag, kind, _count = struct.unpack(
                            order + "HHI", tiff[base:base + 8])
                        if tag == 0x0112 and kind == 3:
                            value = struct.unpack(order + "H", tiff[base + 8:base + 10])[0]
                            return value if 1 <= value <= 8 else 1
                except struct.error:
                    return 1
            return 1
        index += 2 + length
    return 1

def png_chunks(data: bytes) -> tuple[dict, bytes, bytes] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos = 8
    header: dict = {}
    palette = b""
    stream = b""
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            break
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            header = {"width": width, "height": height, "depth": depth,
                      "colour": colour, "interlace": interlace}
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            stream += body
        elif kind == b"IEND":
            break
    if not header or not stream:
        return None
    return header, palette, stream

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

def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytes:
    out = bytearray(height * stride)
    previous = bytearray(stride)
    pos = 0
    for row in range(height):
        if pos >= len(raw):
            break
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = previous[i]
                corner = previous[i - bpp] if i >= bpp else 0
                delta = left + up - corner
                pa, pb, pc = abs(delta - left), abs(delta - up), abs(delta - corner)
                predictor = left if (pa <= pb and pa <= pc) else (
                    up if pb <= pc else corner)
                line[i] = (line[i] + predictor) & 0xFF
        out[row * stride:(row + 1) * stride] = line
        previous = line
    return bytes(out)

def _unpack_bits(row: bytes, count: int, depth: int) -> list[int]:
    out: list[int] = []
    per_byte = 8 // depth
    mask = (1 << depth) - 1
    for byte in row:
        for slot in range(per_byte):
            out.append((byte >> (8 - depth * (slot + 1))) & mask)
            if len(out) == count:
                return out
    return out

def png_to_raw(data: bytes) -> tuple[bytes, int, int, int] | None:
    parsed = png_chunks(data)
    if parsed is None:
        return None
    header, palette, stream = parsed
    width, height = header["width"], header["height"]
    depth, colour = header["depth"], header["colour"]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour)
    if not width or not channels or header["interlace"] != 0:
        return None
    if depth not in (1, 2, 4, 8):
        return None
    if depth < 8 and colour not in (0, 3):
        return None
    try:
        raw = zlib.decompress(stream)
    except zlib.error:
        return None
    bits = depth * channels
    stride = (width * bits + 7) // 8
    bpp = max(1, bits // 8)
    pixels = _unfilter(raw, width, height, bpp, stride)

    if depth < 8:
        full = (1 << depth) - 1
        rows: list[bytes] = []
        for row in range(height):
            line = pixels[row * stride:(row + 1) * stride]
            samples = _unpack_bits(line, width * channels, depth)
            if colour == 3:
                out = bytearray()
                for index in samples:
                    entry = index * 3
                    out += palette[entry:entry + 3] or b"\x00\x00\x00"
                rows.append(bytes(out))
            else:
                rows.append(bytes(sample * 255 // full for sample in samples))
        pixels = b"".join(rows)
        return (pixels, width, height, 3) if colour == 3 else (pixels, width, height, 1)

    if colour == 3:
        out = bytearray(width * height * 3)
        for index in range(width * height):
            entry = pixels[index] * 3
            out[index * 3:index * 3 + 3] = palette[entry:entry + 3] or b"\x00\x00\x00"
        return bytes(out), width, height, 3
    if colour == 2:
        return pixels, width, height, 3
    if colour == 0:
        return pixels, width, height, 1
    if colour == 6:
        out = bytearray(width * height * 3)
        for index in range(width * height):
            out[index * 3:index * 3 + 3] = pixels[index * 4:index * 4 + 3]
        return bytes(out), width, height, 3
    if colour == 4:
        out = bytearray(width * height)
        for index in range(width * height):
            out[index] = pixels[index * 2]
        return bytes(out), width, height, 1
    return None

def _raw_page(pixels: bytes, width: int, height: int, components: int,
              label: str) -> dict:
    payload = zlib.compress(pixels, 6)
    space = "/DeviceRGB" if components == 3 else "/DeviceGray"
    return {"payload": payload, "width": width, "height": height, "rotate": 1,
            "params": (f"/Width {width} /Height {height} /ColorSpace {space} "
                       "/BitsPerComponent 8 /Filter /FlateDecode"),
            "label": f"{label}, {len(payload) / 1000:.0f} kB"}

def pillow_page(data: bytes) -> dict | None:
    """Decode with Pillow when the bytes are legal but awkward (webp, 16-bit PNG,
    interlaced PNG). Optional: without Pillow these pages are reported, not lost
    silently."""
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            kind = {"WEBP": "webp", "PNG": "png"}.get(image.format or "", "image")
            rgb = image.convert("RGB")
            return _raw_page(rgb.tobytes(), rgb.width, rgb.height, 3,
                             f"{rgb.width}x{rgb.height} {kind}")
    except Exception:  # noqa: BLE001
        return None

def pillow_size(data: bytes) -> tuple[int, int, int]:
    """Last-resort size for an image whose header the parser cannot trust.

    Only reached when the bytes look like an image but no plausible frame header
    was found. Pillow is optional; without it this simply says "unknown" and the
    page is reported, never guessed at.
    """
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001
        return 0, 0, 0
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.width, image.height, 3
    except Exception:  # noqa: BLE001
        return 0, 0, 0

def with_flags(page: dict | None, complete: bool = True) -> dict | None:
    """Record what the report needs to know about the picture that arrived."""
    if not page:
        return None
    page.setdefault("preview", False)
    page.setdefault("complete", complete)
    return page


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


def size_text(count: int) -> str:
    """Bytes as the log should say them: 430 B, 6.2 kB, 151 kB."""
    if count < 1000:
        return f"{count} B"
    if count < 10_000:
        return f"{count / 1000:.1f} kB"
    return f"{count / 1000:.0f} kB"


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


def looks_like_image(data: bytes) -> bool:
    return (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n"
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"))

def page_can_be_this_small(width: int, height: int, size: int) -> bool:
    """Could a file of `size` bytes really be a picture this many pixels?

    A JPEG spends roughly 0.2 to 8 bits per pixel. 90 kB declared as 772x68 is
    13 bits per pixel, which no scan reaches: the size read is wrong. This is
    the cheap, dependency-free guard against exactly the misparse that made
    2.3 lay out a 402-page book as strips.
    """
    if not width or not height:
        return False
    bits = size * 8 / (width * height)
    return bits <= 12.0


def plausible_page(page: dict) -> bool:
    """Is this really a page scan, or a thumbnail / banner / misparse?"""
    width, height = page["width"], page["height"]
    if width < MIN_PAGE_PX or height < MIN_PAGE_PX:
        return False
    return ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]

# ---------------------------------------------------------------------------
# pdf
# ---------------------------------------------------------------------------
def pdf_string(text: str) -> bytes:
    return (text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            ).encode("latin-1", "replace")

def median_page(pages: list[dict]) -> tuple[int, int]:
    """The document's page size: the median PAGE, not the commonest and not two
    medians. Sorting by area and taking the middle page keeps the answer a real
    page's own (width, height); averaging the axes separately can invent a size
    no page ever had (1200x1600 + 1600x1200 -> 1600x1600). One misparsed page
    cannot move the middle of 400.
    """
    ordered = sorted(pages, key=lambda page: (page["width"] * page["height"],
                                              page["width"]))
    page = ordered[len(ordered) // 2]
    return page["width"], page["height"]

def house_sheet(pages: list[dict]) -> tuple[float, float]:
    """The one sheet every page is scaled into: the median page, in points.

    Pages that only came as a small preview are left out of the median: a
    document served half in 96x130 copies must not end up with 96x130 sheets.
    """
    real = ([page for page in pages
             if not page.get("preview") and not page.get("shot")] or pages)
    width, height = median_page(real)
    return round(width * 0.75, 2), round(height * 0.75, 2)

def sheet_list(collected: dict[int, dict], total: int,
               placeholder: bool) -> list[dict | None]:
    """Page N of the PDF is page N of the document — unless you ask otherwise."""
    if placeholder:
        return [collected.get(number) for number in range(1, total + 1)]
    return [collected[number] for number in sorted(collected) if number <= total]

def _placement(page: dict, sheet: tuple[float, float]) -> tuple[float, float, float, float]:
    """(box_w, box_h, left, bottom) for one scan on one sheet.

    Aspect ratio is preserved and nothing is ever cropped. EXIF orientation is
    applied by swapping the box, and the image matrix is rotated to match.
    """
    width, height = page["width"], page["height"]
    rotate = page.get("rotate", 1)
    if rotate in (5, 6, 7, 8):                    # stored sideways
        width, height = height, width
    natural_w, natural_h = width * 0.75, height * 0.75
    # fill the sheet, but never blow a small scan up into mush: past 2x the
    # pixels are invented, so a genuinely small page stays crisp and centred.
    # A preview has no crispness to lose, so it fills the sheet instead of
    # sitting in the middle of it like a postage stamp.
    fit = min(sheet[0] / natural_w, sheet[1] / natural_h)
    if not page.get("preview"):
        fit = min(fit, 2.0)
    box_w = round(natural_w * fit, 2)
    box_h = round(natural_h * fit, 2)
    return (box_w, box_h, round((sheet[0] - box_w) / 2, 2),
            round((sheet[1] - box_h) / 2, 2))

def _image_matrix(page: dict, box: tuple[float, float, float, float]) -> str:
    """The cm matrix that draws the scan inside its box, EXIF rotation applied.

    The box is already in DISPLAY orientation, so the matrix only has to turn
    the stored pixels: x = a*u + c*v + e, y = b*u + d*v + f, over the unit
    square. (u,v) run along the stored width and height.
    """
    width, height, left, bottom = box
    rotate = page.get("rotate", 1)
    if rotate in (6, 5):                     # stored sideways, turn 90 deg CW
        return f"0 {-height} {width} 0 {left} {bottom + height} cm"
    if rotate in (8, 7):                     # stored sideways, turn 90 deg CCW
        return f"0 {height} {-width} 0 {left + width} {bottom} cm"
    if rotate == 3:
        return f"{-width} 0 0 {-height} {left + width} {bottom + height} cm"
    return f"{width} 0 0 {height} {left} {bottom} cm"

# Helvetica's own advance widths, in 1/1000 of the font size, for characters
# 32..126 — the Adobe AFM numbers. A guessed average either runs a line off the
# right edge of the sheet or leaves a third of it empty; these are the widths
# the reader's PDF viewer will actually use.
HELVETICA_WIDTHS = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584,
)
TEXT_CHAR_EM = 0.556          # a fallback for characters outside that table


def text_width(text: str, size: float) -> float:
    """How wide this string really is in Helvetica at this size, in points."""
    total = 0.0
    for char in text:
        code = ord(char)
        if 32 <= code <= 126:
            total += HELVETICA_WIDTHS[code - 32]
        elif char in "\u00a0\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022":
            total += 556
        else:
            total += TEXT_CHAR_EM * 1000
    return total / 1000.0 * size


def wrap_to_width(words: str, width: float, size: float) -> list[str]:
    """Break lines at spaces using the real widths, so nothing overflows."""
    lines: list[str] = []
    for paragraph in (words or "").replace("\r", "").split("\n"):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue                       # no blank lines: they only eat room
        current = ""
        for word in paragraph.split(" "):
            # one word wider than the line still has to be broken somewhere,
            # or it hangs over the right edge of the sheet
            while text_width(word, size) > width and len(word) > 1:
                if current:
                    lines.append(current)
                    current = ""
                cut = len(word)
                while cut > 1 and text_width(word[:cut], size) > width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            candidate = f"{current} {word}".strip()
            if not current or text_width(candidate, size) <= width:
                current = candidate
                continue
            lines.append(current)
            current = word
        if current:
            lines.append(current)
    return lines
WINANSI_STAND_IN = {
    0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2015: "-", 0x2212: "-",
    0x00A0: " ", 0x2007: " ", 0x2008: " ", 0x2009: " ", 0x200A: " ",
    0x200B: "", 0x200E: "", 0x200F: "", 0xFEFF: "",
    0x2044: "/", 0x2219: "\xb7", 0x00AD: "",
}


# Helvetica is base-14 WinAnsi, which is cp1252 — not Latin-1. The curly quotes,
# dashes and ellipsis a Word document is full of are cp1252 bytes, so a character
# is kept whenever cp1252 can spell it. Dropped, they turned "ZAM’KATIMU" into
# "ZAMKATIMU" and swallowed the dotted leaders of a contents page; written as
# the wrong byte, they became "?".
def can_winansi(char: str) -> bool:
    """Can Helvetica's WinAnsi encoding spell this character at all?"""
    try:
        char.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True


def pdf_visible_text(text: str) -> str:
    """Escape a string for a PDF literal, in the characters WinAnsi can spell.

    Brackets and backslashes must be escaped or the string ends the content
    stream early. Curly quotes, dashes and the ellipsis are kept exactly as
    written — the stream is written as cp1252, which is what WinAnsi means.
    """
    out: list[str] = []
    for char in text:
        if char in "()\\":
            out.append("\\" + char)
        elif 32 <= ord(char) <= 126:
            out.append(char)
        elif can_winansi(char):
            out.append(char)
        elif ord(char) in WINANSI_STAND_IN:
            out.append(WINANSI_STAND_IN[ord(char)])
        elif char == "\t":
            out.append(" ")
    return "".join(out)


TEXT_SIZES = (10.5, 9.5, 8.5, 7.5, 6.5, 5.5)


SHOT_BLANK_ROWS = 12.0


def looks_blank_shot(size: int, height: int) -> bool:
    """Is a photographed sheet nothing but paper?

    Bytes per row, not bytes per pixel — the browser side judges the very same
    PNG at the very same number, and a pixel measure moves with the width of the
    shot, so one page would look four times emptier at 2x than at 1x. Rows are
    stable: a white sheet compresses to a handful of bytes per row whatever its
    width, and a page with writing on it stays an order of magnitude above that.
    A page with one paragraph on it is sparse, not empty, and is kept in silence.
    """
    if size <= 0 or height <= 0:
        return False                       # nothing to judge by: keep the picture
    return size / height < SHOT_BLANK_ROWS


def sheet_scale(sheet: tuple[float, float]) -> float:
    """How big this sheet is against an A4 page, for sizes and margins.

    A Word document's page comes through at whatever the viewer's scan was —
    900x1200 pt is not rare — and 10.5 pt on a sheet that big looks like a
    footnote in the corner. Type is sized against the sheet, not against an
    absolute number, so a page reads the same at any page size.
    """
    return max(0.6, min(2.5, min(sheet[0] / 595.0, sheet[1] / 842.0)))


def text_body_page(words: str, sheet: tuple[float, float],
                   report: list[int] | None = None) -> tuple[bytes, int]:
    """A whole sheet of readable text — for a document page that is text.

    Not every Scribd document is a stack of scans. Plenty are converted
    documents: the viewer renders each page's *words* (HTML), and there is no
    image to download for most pages at all. Those pages used to come out as
    "scan not available" placeholders while the same document read perfectly in
    a browser — because the words were one request away and nothing asked.

    Two things make the sheet look like the page and not like a paragraph:
    the lines keep the vertical places the viewer gave them (a contents page
    stays a contents page), and the type is sized against the sheet.

    Returns (content stream, lines actually drawn). `report`, if given, gets a
    1 appended when the page's spacing or type had to be squeezed to fit the
    sheet — squeezed, never cut: every line the document has gets drawn.
    """
    scale = sheet_scale(sheet)
    margin = 46.0 * scale
    usable_w = max(40.0, sheet[0] - 2 * margin)
    usable_h = max(40.0, sheet[1] - 2 * margin)
    if not words_plain(words).strip():
        return b"", 0
    lines, places = decode_page_lines(words)
    lines = [line.rstrip() for line in lines]
    if not any(line.strip() for line in lines):
        return b"", 0

    body = ["BT 0 0 0 rg"]
    drawn = 0

    if places is not None and len([line for line in lines if line.strip()]) >= 2:
        # the viewer placed these lines: draw them where it placed them
        gaps = sorted({round(b - a, 4) for a, b in zip(places, places[1:])
                       if b - a > 0.0005})
        step = (gaps[len(gaps) // 2] * usable_h) if gaps else usable_h / len(lines)
        size = max(4.0 * scale, min(12.0 * scale, step / 1.30))
        # a contents line is one line: shrink the type until the longest one
        # fits the sheet instead of breaking its dots across two
        widest = max((text_width(pdf_visible_text(line), 1.0) for line in lines),
                     default=0.0)
        if widest:
            size = min(size, usable_w / widest)
        size = max(3.5 * scale, size)
        top = sheet[1] - margin - size
        entries: list[tuple[float, int, str]] = []
        for line, place in zip(lines, places):
            if not line.strip():
                continue
            # the row of a contents page is spaced with spaces; keep them
            pieces = ([line] if text_width(line, size) <= usable_w
                      else wrap_to_width(line, usable_w, size))
            entries += [(place, offset, piece)
                        for offset, piece in enumerate(pieces)]
        # Every line the viewer placed gets drawn. A page whose last line sits
        # below this sheet used to lose it (and everything after it) to a cut;
        # now the whole column squeezes proportionally instead — the lines keep
        # their order and their relative places, the page keeps its words.
        drops = [place * (usable_h - size) + offset * size * 1.30
                 for place, offset, _ in entries]
        allowed = usable_h - size
        deepest = max(drops) if drops else 0.0
        k = min(1.0, allowed / deepest) if deepest > allowed else 1.0
        if k < 0.80:
            # squeeze the type a little before squeezing the spacing hard
            size = max(3.5 * scale, size * k / 0.80)
            drops = [place * (usable_h - size) + offset * size * 1.30
                     for place, offset, _ in entries]
            deepest = max(drops) if drops else 0.0
            allowed = usable_h - size
            k = min(1.0, allowed / deepest) if deepest > allowed else 1.0
        if k < 1.0 and report is not None:
            report.append(1)
        for (_place, _offset, piece), drop in zip(entries, drops):
            y = top - drop * k
            body.append(f"/F1 {size:.2f} Tf 1 0 0 1 {margin:.2f} {y:.2f} Tm "
                        f"({pdf_visible_text(piece)}) Tj")
            drawn += 1
        body.append("ET")
        return "\n".join(body).encode("cp1252", "replace"), drawn

    chosen = TEXT_SIZES[-1] * scale
    leading = chosen * 1.32
    flow: list[str] = []
    for base in TEXT_SIZES:
        size = round(base * scale, 2)
        leading = round(size * 1.32, 2)
        flow = wrap_to_width("\n".join(lines), usable_w, size)
        chosen = size
        if len(flow) * leading <= usable_h:
            break
    # a page with no placement keeps normal line spacing from the top: that is
    # what a browser does with plain paragraphs too. The corner-of-the-sheet
    # look was never the spacing — it was the type, sized against the sheet now.
    room = max(1, int(usable_h / leading))
    if len(flow) > room:
        # tighten the leading until every line fits: the lines are the page,
        # and dropping the last ones to keep the spacing pretty was the old bug
        leading = usable_h / len(flow)
        room = len(flow)
        if report is not None:
            report.append(1)
    drawn_lines = flow[:room]
    top = sheet[1] - margin - chosen
    body.append(f"/F1 {chosen:.2f} Tf")
    for index, line in enumerate(drawn_lines):
        if not line:
            continue
        body.append(f"1 0 0 1 {margin:.2f} {top - index * leading:.2f} Tm "
                    f"({pdf_visible_text(line)}) Tj")
    drawn = len([line for line in drawn_lines if line])
    body.append("ET")
    return "\n".join(body).encode("cp1252", "replace"), drawn


def text_layer(words: str, box: tuple[float, float, float, float],
               size: float = 9.0) -> bytes:
    """The invisible text of one page, laid out inside the sheet.

    box is _placement's (width, height, left, bottom). Invisible on purpose
    (render mode 3): the scan is already the picture, so the text only has to be
    there for search, copy and accessibility. Lines are wrapped to the sheet so
    selection follows the page instead of running off it.
    """
    width, height, left, bottom = box
    if not words or width < 20 or height < 20:
        return b""
    usable = max(10.0, width - 6)
    per_line = max(8, int(usable / (size * 0.5)))
    lines: list[str] = []
    for paragraph in words.split("\n"):
        while len(paragraph) > per_line:
            cut = paragraph.rfind(" ", 0, per_line)
            cut = cut if cut > per_line // 2 else per_line
            lines.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        lines.append(paragraph)
    lines = [line for line in lines if line]
    if not lines:
        return b""
    leading = size * 1.2
    room = int((height - 8) / leading)
    if room <= 0:
        return b""
    lines = lines[:room]
    top = bottom + height - size - 2
    body = [f"BT /F1 {size:.1f} Tf 3 Tr 0 0 0 rg"]
    for index, line in enumerate(lines):
        body.append(f"1 0 0 1 {left + 3:.2f} {top - index * leading:.2f} Tm "
                    f"({pdf_visible_text(line)}) Tj")
    body.append("ET")
    return "\n".join(body).encode("cp1252", "replace")


def build_pdf(pages: list[dict | None], path: str, title: str = "",
              author: str = "", uniform: bool = True,
              texts: dict[int, str] | None = None,
              text_pages: dict[int, str] | None = None) -> tuple[bool, str]:
    """pages: [{'payload','params','width','height','rotate'}|None] in sheet order.

    None with words in `text_pages` becomes a readable text sheet. None with
    nothing — no photograph, no words — is OMITTED: the sheet is not drawn and
    the note says how many went missing. A grey placeholder sheet is never drawn,
    because a book that silently contains grey leaves is worse than a book that
    says which pages it could not get.
    uniform=False gives every sheet the MediaBox of the page on it.
    """
    real = [page for page in pages if page]
    text_pages = {number: words for number, words in (text_pages or {}).items()
                  if (words or "").strip()}
    if not real and not text_pages:
        return False, "no pages to write"
    house = house_sheet(real) if real else (595.0, 842.0)   # A4 for a text doc
    texts = texts or {}
    with_text = 0
    from_text = 0
    short: list[int] = []
    missing: list[int] = []

    objects: list[bytes] = [b"", b"", b""]     # 1 catalog, 2 pages, 3 font
    objects[2] = (b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                  b"/Encoding /WinAnsiEncoding >>")
    kids: list[int] = []

    for index, page in enumerate(pages, start=1):
        if page is None and text_pages.get(index):
            sheet = house
            cut: list[int] = []
            content, drawn = text_body_page(text_pages[index], sheet, cut)
            if drawn:
                from_text += 1
            if cut:
                short.append(index)
            objects.append(b"<< /Length " + str(len(content)).encode()
                           + b" >>\nstream\n" + content + b"\nendstream")
            content_num = len(objects)
            objects.append(
                (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
                 f" /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R >> >>"
                 f" /Contents {content_num} 0 R >>").encode())
            kids.append(len(objects))
            continue

        if page is None:
            # Nothing arrived for this page from any source. It is left out
            # and named in the note: a grey sheet is not a page and not an
            # answer, and readers deserve the truth in words, not in leaves.
            missing.append(index)
            continue

        sheet = (house if uniform else
                 (round(page["width"] * 0.75, 2), round(page["height"] * 0.75, 2)))
        box = _placement(page, sheet)
        image = page["payload"]
        objects.append(("<< /Type /XObject /Subtype /Image " + page["params"]
                        + f" /Length {len(image)} >>").encode()
                       + b"\nstream\n" + image + b"\nendstream")
        image_num = len(objects)
        body = [("q " + _image_matrix(page, box) + " /Im0 Do Q").encode()]
        layer = text_layer(words_plain(texts.get(index, "")), box) if texts else b""
        if layer:
            body.append(layer)
            with_text += 1
        content = b"\n".join(body)
        objects.append(b"<< /Length " + str(len(content)).encode()
                       + b" >>\nstream\n" + content + b"\nendstream")
        content_num = len(objects)
        objects.append(
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
             f" /Resources << /ProcSet [/PDF /ImageB /ImageC /Text]"
             f" /Font << /F1 3 0 R >>"
             f" /XObject << /Im0 {image_num} 0 R >> >>"
             f" /Contents {content_num} 0 R >>").encode())
        kids.append(len(objects))

    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = (f"<< /Type /Pages /Count {len(kids)} /Kids ["
                  + " ".join(f"{kid} 0 R" for kid in kids) + "] >>").encode()
    stamp = datetime.datetime.now().strftime("D:%Y%m%d%H%M%S")
    info = (b"<< /Title " + pdf_string(title) + b" /Author " + pdf_string(author)
            + b" /Producer (scribd_download " + VERSION.encode()
            + b") /CreationDate (" + stamp.encode() + b") >>")
    objects.append(info)
    info_num = len(objects)

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {info_num} 0 R"
            f" >>\nstartxref\n{xref}\n%%EOF\n").encode()
    with open(path, "wb") as handle:
        handle.write(bytes(out))
    blanks = sum(1 for position, page in enumerate(pages, start=1)
                 if page is None and not text_pages.get(position))
    return True, (f"{len(kids)} sheet(s), {len(out) / 1_000_000:.2f} MB"
                  + (f", {from_text} page(s) from the document's text"
                     if from_text else "")
                  + (f", {blanks} page(s) omitted — no photograph, no "
                     f"words" if blanks else "")
                  + (f", {with_text} page(s) with searchable text" if texts
                     and with_text else "")
                  + (f", {len(short)} page(s) squeezed to fit the sheet "
                   f"(nothing dropped)"
                     if short else ""))

# ---------------------------------------------------------------------------
# read the file back and check it as a PDF
# ---------------------------------------------------------------------------
XREF_ENTRY_RE = re.compile(rb"\d{10} \d{5} [nf] \r?\n")

def verify_pdf(path: str, expect_pages: int = 0, expect_images: int = 0,
               uniform: bool = True) -> tuple[bool, str]:
    """Read the finished file and validate it, instead of assuming it is fine."""
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        return False, f"unreadable: {exc}"
    return verify_bytes(data, expect_pages, expect_images, uniform)

def verify_bytes(data: bytes, expect_pages: int = 0, expect_images: int = 0,
                 uniform: bool = True) -> tuple[bool, str]:
    """The checks themselves, over the bytes of a PDF.

    Checks the header, every xref offset against the object header that should be
    there, the trailer and /Root, each page's MediaBox and /Contents, each stream's
    /Length against the bytes that follow it, the filter against the data magic,
    /Count against the real number of kid pages, and the image count.
    """
    size = len(data)
    problems: list[str] = []
    if not data.startswith(b"%PDF-1."):
        return False, "no %PDF header"
    if b"%%EOF" not in data[-1024:]:
        problems.append("no %%EOF in the last 1 kB")
    match = re.search(rb"startxref\s+(\d+)", data[-4096:])
    if not match:
        return False, "no startxref in the trailer"
    xref = int(match.group(1))
    if xref >= size or data[xref:xref + 4] != b"xref":
        return False, f"startxref {xref} does not point at an xref table"
    head = re.match(rb"xref\r?\n(\d+) (\d+)\r?\n", data[xref:])
    if not head:
        return False, "malformed xref header"
    first, count = int(head.group(1)), int(head.group(2))
    if first != 0:
        problems.append(f"xref starts at object {first}, not 0")
    pos = xref + head.end()
    offsets: dict[int, int] = {}
    for index in range(count):
        entry = data[pos:pos + 20]
        if not XREF_ENTRY_RE.fullmatch(entry):
            problems.append(f"xref entry {first + index} malformed: {entry!r}")
            break
        if entry[17:18] == b"n":
            offsets[first + index] = int(entry[:10])
        pos += 20
    trailer = data[pos:pos + 512]
    if not trailer.startswith(b"trailer"):
        problems.append("no trailer keyword after the xref")
    root = re.search(rb"/Root (\d+) 0 R", trailer)
    if not root:
        problems.append("trailer has no /Root")
    elif int(root.group(1)) not in offsets:
        problems.append("/Root does not resolve to an object")

    ordered = sorted(offsets.items(), key=lambda item: item[1])
    pages = 0
    images = 0
    boxes: set[tuple[float, float]] = set()
    counted = -1
    for index, (number, offset) in enumerate(ordered):
        end = ordered[index + 1][1] if index + 1 < len(ordered) else xref
        if not re.match(rb"%d 0 obj" % number, data[offset:offset + 24]):
            problems.append(f"object {number} is not at its xref offset")
            continue
        body = data[offset:end]
        # only the dictionary is inspected: a page could legitimately contain
        # the bytes "/Type /Page" inside its image data by pure chance
        head = body.split(b"stream", 1)[0]
        length_match = re.search(rb"/Length (\d+)\s*>>\s*stream\r?\n", body)
        if length_match:
            length = int(length_match.group(1))
            start = length_match.end()
            if start + length > len(body):
                problems.append(f"object {number}: stream runs past the object")
            else:
                payload = body[start:start + length]
                if not body[start + length:start + length + 12].startswith(b"\nendstream"):
                    problems.append(f"object {number}: no endstream after /Length bytes")
                if b"/DCTDecode" in head:
                    if payload[:2] != b"\xff\xd8":
                        problems.append(f"object {number}: DCTDecode without JPEG data")
                elif b"/FlateDecode" in body:
                    try:
                        zlib.decompress(payload)
                    except zlib.error:
                        problems.append(f"object {number}: FlateDecode will not inflate")
        if b"/Type /XObject" in head and b"/Subtype /Image" in head:
            images += 1                       # an image is its own object
            width = re.search(rb"/Width (\d+)", head)
            height = re.search(rb"/Height (\d+)", head)
            if width and height:
                wide, tall = int(width.group(1)), int(height.group(1))
                if wide < PREVIEW_MIN_PX or tall < PREVIEW_MIN_PX:
                    # a preview page is allowed to be small, a smudge is not:
                    # the sheet can only ever be as readable as its picture
                    problems.append(f"image object {number} is only {wide}x{tall} px")
        if b"/Type /Catalog" in head:
            if b"/Pages" not in body:
                problems.append("catalog has no /Pages")
        elif b"/Type /Pages" in head:
            found = re.search(rb"/Count (\d+)", body)
            counted = int(found.group(1)) if found else -1
            listed = re.findall(rb"(\d+) 0 R", head.split(b"/Kids", 1)[-1])
            if len(listed) != counted:
                problems.append(f"/Count says {counted}, /Kids lists {len(listed)}")
        elif b"/Type /Page" in head:
            pages += 1
            box = re.search(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", head)
            if not box:
                problems.append(f"page object {number} has no MediaBox")
            else:
                wide, tall = float(box.group(1)), float(box.group(2))
                boxes.add((wide, tall))
                if not (40 <= wide <= 4000 and 40 <= tall <= 4000):
                    problems.append(f"page object {number}: MediaBox {wide}x{tall}")
            for key in (b"/Contents", b"/Parent"):
                if key not in head:
                    problems.append(f"page object {number} lacks {key.decode()}")

    if expect_pages and pages != expect_pages:
        problems.append(f"{pages} page object(s), expected {expect_pages}")
    if expect_images and images != expect_images:
        problems.append(f"{images} image stream(s), expected {expect_images}")
    if uniform and len(boxes) > 1:
        problems.append(f"{len(boxes)} different sheet sizes: {sorted(boxes)[:4]}")

    if problems:
        return False, ("; ".join(problems[:6])
                       + (f" (+{len(problems) - 6} more)" if len(problems) > 6 else ""))
    shapes = sorted(boxes)
    if not shapes:
        sheets = "no sheet"
    elif len(shapes) == 1:
        sheets = f"sheet {shapes[0][0]}x{shapes[0][1]} pt"
    else:
        listed = ", ".join(f"{wide}x{tall}" for wide, tall in shapes[:3])
        sheets = f"{len(shapes)} sheet size(s): {listed} pt"
    return True, (f"{pages} page(s), {images} image stream(s), "
                  f"{size / 1_000_000:.2f} MB, {sheets}, xref and trailer ok")

# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------
STALL_SECONDS = 420          # a "running" job with no page progress for 7 min is wedged
