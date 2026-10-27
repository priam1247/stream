
def _placement(page: dict, sheet: tuple[float, float]) -> tuple[float, float, float, float]:
    """(box_w, box_h, left, bottom) for one scan on one sheet.

    Aspect ratio is preserved and nothing is ever cropped. EXIF orientation is
    applied by swapping the box, and the image matrix is rotated to match.
    """
    width, height = page["width"], page["height"]
    rotate = page.get("rotate", 1)
    if rotate in (5, 6, 7, 8):                    # stored sideways
        width, height = height, width
    natural_w, natural_h = width * 0.75, height * 0.75
    # fill the sheet, but never blow a small scan up into mush: past 2x the
    # pixels are invented, so a genuinely small page stays crisp and centred.
    # A preview has no crispness to lose, so it fills the sheet instead of
    # sitting in the middle of it like a postage stamp.
    fit = min(sheet[0] / natural_w, sheet[1] / natural_h)
    if not page.get("preview"):
        fit = min(fit, 2.0)
    box_w = round(natural_w * fit, 2)
    box_h = round(natural_h * fit, 2)
    return (box_w, box_h, round((sheet[0] - box_w) / 2, 2),
            round((sheet[1] - box_h) / 2, 2))
