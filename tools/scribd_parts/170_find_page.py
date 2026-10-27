

def find_page(query: str, page: int = 1,
              ask=None) -> tuple[list[dict], str, dict]:
    """One page of Scribd's own search.

    Returns (hits, one line saying what happened, what Scribd said about the
    result set). The page number is honoured by Scribd, so "load more" asks for
    page 2, 3, … instead of asking for page 1 again and hoping.
    """
    query = " ".join((query or "").split())
    if not query:
        return [], "type a few words to search for", {}
    page = as_page(page)
    caller = ask or (lambda url: fetch(url, referer=FIND_REFERER))
    got = caller(search_url(query, page)) or {}
    status = int(got.get("status") or 0)
    body = got.get("body") or b""
    if status != 200:
        return [], find_refusal(status, body, str(got.get("error") or "")), {}
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return [], f"the answer was not search data ({describe(body)})", {}
    documents = documents_in(payload)
    hits: list[dict] = []
    seen: set[str] = set()
    for doc in documents:
        hit = hit_from(doc)
        if hit and hit["id"] not in seen:
            seen.add(hit["id"])
            hits.append(hit)
    info = {"page": page, "documents": len(documents),
            "total": count_in(payload, "total_results_count"),
            "pages": count_in(payload, "page_count")}
    if not documents:
        note = ("Scribd answered, but named no documents for that query"
                if page == 1 else "no more documents")
    else:
        hits, weak = rank_hits(hits, query)
        note = f"{len(documents)} document(s)"
        dropped = len(documents) - len(hits)
        if dropped:
            note += f", {dropped} dropped (duplicate or not a Scribd document)"
        if weak:
            note += f", {weak} only loosely related"
    return hits, note, info
