

def plain_error(exc: BaseException) -> str:
    """A connection failure in words, not in a repr.

    "URLError(ConnectionRefusedError(111, 'Connection refused'))" is what Python
    knows. What the reader needs to know is that nothing is listening there —
    because that is a service they have to start, not a bug in the document.
    """
    text = repr(exc)
    lowered = text.lower()
    if "connectionrefused" in lowered or "refused" in lowered:
        return "nothing is listening there — is the /shot service running?"
    if "timed out" in lowered or "timeout" in lowered:
        return "it did not answer in time (a page can take a while to draw)"
    if "gaierror" in lowered or "name or service not known" in lowered:
        return "that host does not resolve — check the address"
    if "connectionreset" in lowered or "brokenpipe" in lowered:
        return "the connection was dropped mid-answer"
    if "ssl" in lowered or "certificate" in lowered:
        return "the TLS handshake failed — is it http:// and not https://?"
    if "unreachable" in lowered:
        return "that network is unreachable from here"
    return text[:160]
