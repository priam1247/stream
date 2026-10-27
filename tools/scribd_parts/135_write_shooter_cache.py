

def write_shooter_cache(base: str) -> None:
    try:
        with open(shooter_cache_path(), "w") as handle:
            handle.write(base + "\n")
    except Exception:                                   # noqa: BLE001
        pass
