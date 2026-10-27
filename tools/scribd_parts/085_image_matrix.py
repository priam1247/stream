
def _image_matrix(page: dict, box: tuple[float, float, float, float]) -> str:
    """The cm matrix that draws the scan inside its box, EXIF rotation applied.

    The box is already in DISPLAY orientation, so the matrix only has to turn
    the stored pixels: x = a*u + c*v + e, y = b*u + d*v + f, over the unit
    square. (u,v) run along the stored width and height.
    """
    width, height, left, bottom = box
    rotate = page.get("rotate", 1)
    if rotate in (6, 5):                     # stored sideways, turn 90 deg CW
        return f"0 {-height} {width} 0 {left} {bottom + height} cm"
    if rotate in (8, 7):                     # stored sideways, turn 90 deg CCW
        return f"0 {height} {-width} 0 {left + width} {bottom} cm"
    if rotate == 3:
        return f"{-width} 0 0 {-height} {left + width} {bottom + height} cm"
    return f"{width} 0 0 {height} {left} {bottom} cm"
