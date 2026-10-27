

def set_shots(value: str) -> None:
    """Point the engine at a browser service (--shots URL, or SCRIBD_SHOTS)."""
    global SHOTS
    SHOTS = (value or "").strip().rstrip("/")
    os.environ["SCRIBD_SHOTS"] = SHOTS
