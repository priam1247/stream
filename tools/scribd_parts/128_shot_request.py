

def shot_request(base: str, ident: str, number: int, scale: float) -> str:
    """The one request that asks a browser for one page of one document."""
    return (f"{base.rstrip('/')}/shot?doc={ident}&page={int(number)}"
            f"&scale={scale:g}")
