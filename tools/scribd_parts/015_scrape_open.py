

def _scrape_open(netloc: str) -> bool:
    """May this host be asked through the route at all?"""
    if not SCRAPE_DO:
        return False
    host = netloc.split("@")[-1].split(":")[0].lower()
    return any(host == wanted or host.endswith("." + wanted)
               for wanted in SCRAPE_HOSTS)
