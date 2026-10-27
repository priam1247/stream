
def usable_token(value: str) -> bool:
    """A real token is a JWT, or a plain signed string with no dots.

    A dotted value that does not decode as a JWT is a JavaScript expression
    ("navigator.userAgent.toLowerCase") which the viewer writes into the url
    template. It is never a signature, so it is never sent.
    """
    value = urllib.parse.unquote((value or "").strip("\"'"))
    if not value or len(value) < 16:
        return False
    if jwt_ok(value):
        return True
    if "." in value:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9_\-]+", value))
