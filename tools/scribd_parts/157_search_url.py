

def search_url(query: str, page: int = 1) -> str:
    """The request Scribd's own search page makes.

    /search is a JavaScript app, but it does not search on the page: it asks
    /search/query and renders the JSON that comes back. This is that same
    request, so the answers come from Scribd itself — no search engine in the
    way, and none of the engine blocking that made the old panel search fail.
    """
    params = {"query": " ".join((query or "").split()), "verbatim": "true",
              "ct_lang": "0"}
    if page > 1:
        params["page"] = str(page)
    return FIND_URL + "?" + urllib.parse.urlencode(params)
