

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
