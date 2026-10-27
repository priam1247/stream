

def pdf_visible_text(text: str) -> str:
    """Escape a string for a PDF literal, in the characters WinAnsi can spell.

    Brackets and backslashes must be escaped or the string ends the content
    stream early. Curly quotes, dashes and the ellipsis are kept exactly as
    written — the stream is written as cp1252, which is what WinAnsi means.
    """
    out: list[str] = []
    for char in text:
        if char in "()\\":
            out.append("\\" + char)
        elif 32 <= ord(char) <= 126:
            out.append(char)
        elif can_winansi(char):
            out.append(char)
        elif ord(char) in WINANSI_STAND_IN:
            out.append(WINANSI_STAND_IN[ord(char)])
        elif char == "\t":
            out.append(" ")
    return "".join(out)
