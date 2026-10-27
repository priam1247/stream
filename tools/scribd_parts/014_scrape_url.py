

def scrape_url(target: str) -> str:
    """The route's own address for one target page."""
    return ("https://api.scrape.do/?token=" + SCRAPE_DO +
            "&url=" + urllib.parse.quote(target, safe=""))
