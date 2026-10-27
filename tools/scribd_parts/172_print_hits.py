

def print_hits(hits: list[dict]) -> None:
    for number, hit in enumerate(hits, 1):
        extra = " · ".join(part for part in (
            f"{hit['pages']} pages" if hit["pages"] else "",
            f"{hit['views']} views" if hit["views"] else "",
            hit["author"] or "") if part)
        print(f"  {number:2}. {hit['title']}")
        print(f"      {hit['url']}" + (f"   ({extra})" if extra else ""))
