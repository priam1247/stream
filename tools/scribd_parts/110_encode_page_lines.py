

def encode_page_lines(lines: list[tuple[str, float | None]]) -> str:
    """A page's words, with the vertical place of each line when it has one."""
    tops = [top for _text, top in lines if top is not None]
    low, high = (min(tops), max(tops)) if tops else (0.0, 0.0)
    out: list[str] = []
    for text, top in lines:
        if top is None or high <= low:
            out.append(text)
            continue
        out.append("%s%.4f|%s" % (LINE_MARK, (top - low) / (high - low), text))
    return "\n".join(out)
