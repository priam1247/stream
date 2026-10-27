

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
