
def _forget(scheme: str, netloc: str) -> None:
    pool = getattr(_POOL, "pool", None) or {}
    connection = pool.pop((scheme, netloc), None)
    if connection is not None:
        try:
            connection.close()
        except Exception:  # noqa: BLE001
            pass
