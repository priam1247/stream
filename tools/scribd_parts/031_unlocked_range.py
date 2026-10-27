

def unlocked_range(claims: dict, total: int) -> tuple[int, int]:
    """The pages the CDN serves: all of them, unless the token enforces a
    preview window. Garbage in the claims means no window at all."""
    if not claims.get("enforce"):
        return 1, total
    try:
        low = max(1, int(claims.get("page_min") or 1))
        high = min(total, int(claims.get("page_max") or total))
    except (TypeError, ValueError):
        return 1, total
    return (low, high) if low <= high else (1, total)
