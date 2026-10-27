

def find_documents(query: str, pages: int = 1,
                   limit: int = 0, ask=None) -> tuple[list[dict], list[str]]:
    """Search Scribd itself. Returns (hits, notes) — notes say what happened."""
    query = " ".join((query or "").split())
    if not query:
        return [], ["type a few words to search for"]
    wanted = max(1, min(int(pages or 1), FIND_MAX_PAGE))
    found: dict[str, dict] = {}
    notes: list[str] = []
    for page in range(1, wanted + 1):
        hits, note, info = find_page(query, page, ask)
        if not info:                      # refused, challenged or not search data
            notes.append(f"page {page}: {note}")
            break
        fresh = 0
        for hit in hits:
            if hit["id"] in found:
                continue
            found[hit["id"]] = hit
            fresh += 1
            if limit and len(found) >= limit:
                break
        notes.append(f"page {page}: {info['documents']} document(s), {fresh} new")
        if not info["documents"] or not fresh or (limit and len(found) >= limit):
            break
    return list(found.values()), notes
