

def _scrape_take() -> bool:
    """One unit of the per-document budget. -> still allowed."""
    with _scrape_lock:
        if _scrape_left[0] <= 0:
            return False
        _scrape_left[0] -= 1
        return True
