

def alternate_host(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if not host:
        return ""
    other = OTHER_HOSTS[0] if "scribdassets" in host else "html.scribdassets.com"
    return urllib.parse.urlunsplit((parsed.scheme, other, parsed.path,
                                    parsed.query, ""))
