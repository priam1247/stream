

def _scrape_get(target: str, timeout: float) -> dict | None:
    """One answer through the route, or None when the route itself failed."""
    if not _scrape_take():
        return None
    status, body, error = shot_get(scrape_url(target), timeout)
    if status == 200 and body:
        return {"status": 200, "body": body, "headers": {}, "error": "",
                "via": "scrape route"}
    with _scrape_lock:
        said = _scrape_said[0]
        _scrape_said[0] = True
    if not said:
        JOB.say(f"the scrape route could not help either — "
                f"{error or ('http ' + str(status))}"[:200])
    return None
