

def biggest_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest picture in a JPEG file — never a header's decoy thumbnail."""
    if not frames:
        return 0, 0, 0
    return max(frames, key=lambda frame: frame[0] * frame[1])
