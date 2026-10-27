
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
