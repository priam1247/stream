

def lines_from_html(html: str, chrome: bool = True) -> str:
    """One page's words, line by line, out of its markup.

    Placed elements give the lines and their spacing. Failing that, block tags
    give the lines. Failing that too (one flat run), runs of wide space are
    treated as line ends — a text layer positioned with spaces rather than CSS
    is otherwise a single unreadable line.
    """
    placed = positioned_lines(html)
    if placed:
        kept = []
        for text, top in placed:
            text = (tidy_page_text(text, keep_spacing=True) if chrome
                    else html_to_text(text))
            if text.strip():
                kept.append((text, top))
        if len(kept) >= 2:
            return encode_page_lines(kept)
    loose = html_to_text(html, collapse=False)
    if "\n" not in loose and len(re.findall(r"[ \t\u00a0]{3,}", loose)) >= 2:
        parts = [part.strip() for part in re.split(r"[ \t\u00a0]{3,}", loose)]
        parts = [part for part in parts if part]
        if len(parts) >= 3:
            cleaned = [tidy_page_text(part) if chrome else html_to_text(part)
                       for part in parts]
            return "\n".join(line for line in cleaned if line)
    return tidy_page_text(html_to_text(html)) if chrome else html_to_text(html)
