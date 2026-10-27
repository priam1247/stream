
def page_can_be_this_small(width: int, height: int, size: int) -> bool:
    """Could a file of `size` bytes really be a picture this many pixels?

    A JPEG spends roughly 0.2 to 8 bits per pixel. 90 kB declared as 772x68 is
    13 bits per pixel, which no scan reaches: the size read is wrong. This is
    the cheap, dependency-free guard against exactly the misparse that made
    2.3 lay out a 402-page book as strips.
    """
    if not width or not height:
        return False
    bits = size * 8 / (width * height)
    return bits <= 12.0
