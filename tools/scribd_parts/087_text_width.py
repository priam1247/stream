

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
