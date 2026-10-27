

def shooter_start_reason(proj: str) -> str:
    """The service's own last words, from its start log — never a guess.

    A browser service that dies at import time knows exactly why (a missing
    package, a missing shared library). Swallowing that is what made a panel
    say "nothing is listening" instead of the one line that fixes it.
    """
    try:
        with open(shooter_log_path(proj), "rb") as handle:
            lines = [ln.decode("utf-8", "replace").strip()
                     for ln in handle.read().splitlines() if ln.strip()]
    except Exception:                                   # noqa: BLE001
        return ""
    return " | ".join(lines[-3:])
