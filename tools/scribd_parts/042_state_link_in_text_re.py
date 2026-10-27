
# ---------------------------------------------------------------------------
# links: what a pasted list or a bookmarklet hands to us
# ---------------------------------------------------------------------------
# Nothing on this machine searches. Searching happens in your own browser, where
# the address is not blocked; only the links travel to the panel (see
# bookmarklet() and the /send endpoint). These two helpers are the receiving end.
LINK_IN_TEXT_RE = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*scribd\.com/"
    r"(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/"
    r"\d{3,}(?:/[^\s\"'<>]*)?", re.I)
