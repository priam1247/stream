
def jwt_claims(token: str) -> dict:
    """What a Scribd asset token says besides its expiry: the CDN folder
    (`format_uuid`) and the window of pages the CDN will actually serve
    (`page_min`, `page_max`, `enforce`).

    Read, not trusted: the payload is plain base64url json that Scribd hands to
    every anonymous viewer, and it is used for one decision only — which pages
    are worth asking for. A preview-limited document says so here, in its own
    token, before a single request is spent finding out the hard way.
    """
    parts = (token or "").split(".")
    if len(parts) < 2:
        return {}
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}
    return claims if isinstance(claims, dict) else {}
