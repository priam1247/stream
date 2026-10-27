

def decode_page_lines(words: str) -> tuple[list[str], list[float] | None]:
    """Read back what encode_page_lines wrote: (lines, places or None)."""
    lines: list[str] = []
    places: list[float] = []
    placed = False
    for raw in (words or "").split("\n"):
        if raw.startswith(LINE_MARK) and "|" in raw:
            head, _, text = raw[len(LINE_MARK):].partition("|")
            try:
                places.append(float(head))
                placed = True
                lines.append(text)
                continue
            except ValueError:
                pass
        places.append(0.0)
        lines.append(raw)
    return lines, (places if placed else None)
