

def token_note(token: str) -> str:
    if not token:
        return ("image token: none on the page — trying without one (the viewer "
                "may build it in the browser)")
    if jwt_ok(token):
        left = (jwt_exp(token) - time.time()) / 3600
        if left > 0:
            return f"image token: found, valid for the next {left:.0f} h"
        return (f"image token: found but EXPIRED {abs(left):.0f} h ago — open the "
                "document while logged in, then reload it")
    return "image token: found (a plain token, not a JWT)"
