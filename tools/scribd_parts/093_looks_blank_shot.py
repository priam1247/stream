

def looks_blank_shot(size: int, height: int) -> bool:
    """Is a photographed sheet nothing but paper?

    Bytes per row, not bytes per pixel — the browser side judges the very same
    PNG at the very same number, and a pixel measure moves with the width of the
    shot, so one page would look four times emptier at 2x than at 1x. Rows are
    stable: a white sheet compresses to a handful of bytes per row whatever its
    width, and a page with writing on it stays an order of magnitude above that.
    A page with one paragraph on it is sparse, not empty, and is kept in silence.
    """
    if size <= 0 or height <= 0:
        return False                       # nothing to judge by: keep the picture
    return size / height < SHOT_BLANK_ROWS
