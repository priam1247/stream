

def positioned_lines(html: str) -> list[tuple[str, float]]:
    """The page's lines in reading order, each with the vertical place it had.

    Returns [] when the markup carries no placement at all, which is the
    honest answer for plain paragraphs: then the words flow instead.
    """
    marks: list[tuple[int, float]] = []
    for match in STYLE_TAG_RE.finditer(html or ""):
        style = STYLE_ATTR_RE.search(match.group(2) or "")
        if not style:
            continue
        found = TOP_RE.search(style.group(1))
        if not found:
            continue
        try:
            marks.append((match.end(), float(found.group(1))))
        except ValueError:
            continue
    if len(marks) < 2:
        return []
    out: list[tuple[str, float]] = []
    for index, (start, top) in enumerate(marks):
        end = marks[index + 1][0] if index + 1 < len(marks) else len(html)
        words = html_to_text(html[start:end])
        if not words.strip():
            continue
        # an outer and an inner element can name the same line: keep one
        if out and words.strip() == out[-1][0].strip():
            continue
        out.append((words, top))
    # two columns on one row are two spans at the same height: join them into
    # the row they belong to instead of writing them one under the other
    rows: list[tuple[str, float]] = []
    for text, top in out:
        if rows and abs(top - rows[-1][1]) <= max(0.4, abs(top) * 0.01):
            rows[-1] = (rows[-1][0] + "   " + text, rows[-1][1])
        else:
            rows.append((text, top))
    return rows
