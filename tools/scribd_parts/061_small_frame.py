

def small_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest picture in the file that could be a page at all.

    v2.16 stopped excluding pages. A scanned upload often serves odd sizes —
    a 60x80 strip, a double-page spread far outside a page's aspect, a 349x383
    thumbnail — and a small or odd-looking page is still that page's content.
    A blank placeholder is strictly worse than a poor scan, so the rule is now:
    take the biggest frame that is not a 1-pixel smudge, whatever its shape.
    """
    best = (0, 0, 0)
    for width, height, components in frames:
        if min(width, height) < ABSOLUTE_MIN_PX:
            continue
        # prefer a page-shaped frame of the same area, but never insist
        if width * height > best[0] * best[1]:
            best = (width, height, components or 3)
    return best
