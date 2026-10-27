
def full_url(url: str) -> str:
    """A name always begins with https://, however the page wrote it.

    Scribd writes the same asset as `https://html…`, `//html…` and
    `https:\\/\\/html…`; the last is already `text_of()`'s job. The first two
    are normalised here so a name seen in one shape matches the same name seen
    in another, and so `fetch()` never has to guess a scheme.
    """
    url = (url or "").strip().strip("\"'")
    if not url:
        return ""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith(("http://", "https://")):
        return url
    return ""
