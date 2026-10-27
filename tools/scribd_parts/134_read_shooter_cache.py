

def read_shooter_cache() -> str:
    try:
        with open(shooter_cache_path()) as handle:
            text = handle.read().strip()
    except Exception:                                   # noqa: BLE001
        return ""
    return text if text.startswith("http") else ""
