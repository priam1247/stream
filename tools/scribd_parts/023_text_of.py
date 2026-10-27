
def text_of(body) -> str:
    """Scribd writes urls inside JS as https:\\/\\/… — sometimes with one backslash,
    sometimes two, depending on how the string was nested. Strip them all.

    Accepts bytes or str: the search parsers hand it text they already decoded.
    """
    if isinstance(body, bytes):
        text = body.decode("utf-8", "replace")
    else:
        text = str(body or "")
    return re.sub(r"\\+/", "/", text.replace("&amp;", "&"))
