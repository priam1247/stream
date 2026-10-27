

def count_in(payload, key: str) -> int:
    """A number Scribd sent, or 0 when it sent nothing usable."""
    value = payload.get(key) if isinstance(payload, dict) else None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 0 <= number <= 10000000 else 0
