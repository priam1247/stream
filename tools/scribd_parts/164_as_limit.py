

def as_limit(value, default: int = 0, top: int = 5000) -> int:
    """A page limit from a browser or a shell: 0 means the whole document."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, min(number, top))
