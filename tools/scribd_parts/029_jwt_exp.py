
# ---------------------------------------------------------------------------
# the token scribd puts on some page scans
# ---------------------------------------------------------------------------
def jwt_exp(token: str) -> int:
    parts = token.split(".")
    if len(parts) < 2:
        return 0
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        return int(json.loads(raw).get("exp") or 0)
    except Exception:  # noqa: BLE001
        return 0
