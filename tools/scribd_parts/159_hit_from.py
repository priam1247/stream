

def hit_from(doc: dict) -> dict:
    """One search result, in the shape the page and the downloader both use."""
    url = str(doc.get("reader_url") or doc.get("url") or "").strip()
    if url and not re.search(r"(?:^|\.)scribd\.com/", url, re.I):
        return {}
    if url:
        url = url.split("?")[0].split("#")[0]
    ident = str(doc.get("id") or "").strip() or doc_id_of(url)
    if not ident.isdigit():
        return {}
    if not url:
        url = f"https://www.scribd.com/document/{ident}"
    author = ""
    authors = doc.get("authors")
    if isinstance(authors, list) and authors and isinstance(authors[0], dict):
        author = str(authors[0].get("name") or "").strip()
    if not author and isinstance(doc.get("author"), dict):
        author = str(doc["author"].get("name") or "").strip()
    try:
        pages = int(doc.get("pageCount") or 0)
    except (TypeError, ValueError):
        pages = 0
    return {"id": ident,
            "title": " ".join(str(doc.get("title") or "").split())
                     or f"document {ident}",
            "url": url, "pages": pages,
            "views": str(doc.get("views") or "").strip(), "author": author}
