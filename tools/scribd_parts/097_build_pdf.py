

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
