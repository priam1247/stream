
def with_token(url: str, token: str) -> str:
    """Put the real token on the url, replacing anything that is not one."""
    if not url:
        return url
    match = TOKEN_RE.search(url)
    if not match:
        if not usable_token(token):
            return url
        return url + ("&" if "?" in url else "?") + "token=" + token
    if usable_token(match.group(1)) or not usable_token(token):
        return url
    return url[:match.start(1)] + token + url[match.end(1):]
