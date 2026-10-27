

def size_text(count: int) -> str:
    """Bytes as the log should say them: 430 B, 6.2 kB, 151 kB."""
    if count < 1000:
        return f"{count} B"
    if count < 10_000:
        return f"{count / 1000:.1f} kB"
    return f"{count / 1000:.0f} kB"
