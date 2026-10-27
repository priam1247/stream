

def as_page(value, default: int = 1) -> int:
    """A page number from anything a browser or a shell might send."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = default
    return max(1, min(number, FIND_MAX_PAGE))
