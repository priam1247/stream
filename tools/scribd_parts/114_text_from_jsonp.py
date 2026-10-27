

def text_from_jsonp(body: bytes) -> str:
    """A page's text out of its descriptor: window.pageN_callback([…, "…"])."""
    raw = text_of(body)
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        return ""
    try:
        parts = json.loads(raw[start:end + 1])
    except ValueError:
        return ""
    if not isinstance(parts, list):
        return ""
    html = "".join(part for part in parts if isinstance(part, str))
    return lines_from_html(html, chrome=False)
