

def html_escape(text) -> str:
    raw = str(text if text is not None else "")
    for a, b in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ('"', "&quot;")):
        raw = raw.replace(a, b)
    return raw
