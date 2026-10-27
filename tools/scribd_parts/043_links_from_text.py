

def links_from_text(text: str) -> list[str]:
    """Document links out of a pasted block: one per line or all mixed together.

    Keeps the order you pasted, drops duplicates, ignores anything that is not a
    Scribd document link, and strips the query string (`?utm_…`, `#page=3`) which
    Scribd does not need and which makes two copies of one document look
    different.
    """
    urls: list[str] = []
    for match in LINK_IN_TEXT_RE.finditer(text or ""):
        url = match.group(0).split("?")[0].split("#")[0].rstrip(".,;)")
        if url not in urls:
            urls.append(url)
    return urls
