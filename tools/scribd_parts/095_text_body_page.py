

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
