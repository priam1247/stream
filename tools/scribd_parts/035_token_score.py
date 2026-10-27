
def token_score(token: str) -> tuple[int, int]:
    """(expiry, tier) — a real token always beats a placeholder."""
    if not token:
        return 0, 0
    if jwt_ok(token):
        return jwt_exp(token), 2
    if usable_token(token):
        return jwt_exp(token), 1
    return 0, 0
