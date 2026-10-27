

def as_channels(value, default: int = 0, top: int = 24) -> int:
    """How many pages to fetch at once.

    Each one is a channel: one connection, one page. Scribd throttles per
    address, so past a point extra channels only produce more 403s — the
    download rate stops rising and the log gets noisy. 16 is the measured
    middle for a small container; the panel offers 8, 12, 16 and 24.
    """
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = default or PANEL_JOBS
    if number <= 0:
        number = default or PANEL_JOBS
    return max(1, min(number, top))
