

def rank_hits(hits: list[dict], query: str) -> tuple[list[dict], int]:
    """Order results the way the words were typed, and say which are exact.

    Scribd's own search is deliberately loose — a search for "physics 12th"
    also returns books that merely share a common word, which is why the panel
    used to look like it was answering something nobody asked. Nothing is
    thrown away here: a result that matches every word comes first, a result
    that matches none is kept but marked `match: "none"`, so the page can show
    it as *related* instead of pretending it was the answer.
    """
    words = query_words(query)
    phrase = " ".join((query or "").split()).lower()
    rows: list[tuple[int, int, dict]] = []
    for order, hit in enumerate(hits):
        title = str(hit.get("title") or "").lower()
        author = str(hit.get("author") or "").lower()
        in_title = title_words(title)
        title_set = set(in_title)
        score = 0
        matched = 0
        for word in words:
            if word in title_set:
                score += 12
                matched += 1
            elif any(candidate.startswith(word) for candidate in in_title):
                score += 6
                matched += 1
            elif any(len(word) >= 4 and word.startswith(candidate)
                     for candidate in in_title):
                score += 4
                matched += 1
            elif word in author:
                score += 3
                matched += 1
        if phrase and phrase in title:
            score += 100                      # the exact phrase, first
        if words and matched == len(words):
            score += 20                       # every word, in any order
        if hit.get("pages"):
            score += 1                       # a tie-break that prefers real books
        marked = dict(hit)
        marked["score"] = score
        # an empty query (or one made only of filler words) cannot fail a match
        marked["match"] = ("all" if not words or matched == len(words)
                           else "some" if matched else "none")
        rows.append((score, order, marked))
    rows.sort(key=lambda row: (-row[0], row[1]))
    ordered = [row[2] for row in rows]
    weak = sum(1 for hit in ordered if hit["match"] == "none")
    return ordered, weak
