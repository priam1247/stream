

def best_frame_any_shape(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest frame, page-shaped or not — the last resort before a blank."""
    usable = [frame for frame in frames if min(frame[0], frame[1]) >= ABSOLUTE_MIN_PX]
    if not usable:
        return 0, 0, 0
    return max(usable, key=lambda frame: frame[0] * frame[1])
