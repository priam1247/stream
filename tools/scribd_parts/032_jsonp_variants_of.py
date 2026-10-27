

def jsonp_variants_of(jsonp: str, token: str) -> list[str]:
    """The names to ask a descriptor by, no-token FIRST.

    The CDN's /pages/ path wants no token at all, and a token that has expired
    is not neutral: carrying it is a 403 that counts against the address. So
    the bare name goes first and the tokened one is the fallback, never the
    other way round.
    """
    out: list[str] = []
    for candidate in (strip_token(jsonp), with_token(jsonp, token)):
        if candidate and candidate not in out:
            out.append(candidate)
    return out
