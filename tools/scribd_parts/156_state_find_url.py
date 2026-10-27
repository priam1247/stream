
# ---------------------------------------------------------------------------
# find — Scribd's OWN search, so no search engine can refuse the request
# ---------------------------------------------------------------------------
FIND_URL = "https://www.scribd.com/search/query"
FIND_REFERER = "https://www.scribd.com/search"
FIND_PER_PAGE = 40                 # measured: 40 documents on a page of results
FIND_MAX_PAGE = 40                 # a stop, so a typo cannot walk the whole index
