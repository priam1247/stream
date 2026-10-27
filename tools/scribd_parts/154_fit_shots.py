

def fit_shots(collected: dict[int, dict], sheet: tuple[float, float]) -> None:
    """Put every photographed page on this document's sheet, shape kept.

    A screenshot is the size of a screen, and a screen is not a piece of paper:
    left alone it would make one page of the book a different size from the rest.
    Scaling the picture's own dimensions to the sheet means the sheet stays the
    document's, the page fills it, and nothing is stretched — the aspect ratio
    is carried along, so a page that is not quite A4 is centred, not distorted.
    """
    if not (sheet[0] and sheet[1]):
        return
    for page in collected.values():
        if not page.get("shot"):
            continue
        width, height = page["width"] * 0.75, page["height"] * 0.75
        if not (width and height):
            continue
        factor = min(sheet[0] / width, sheet[1] / height)
        page["width"] = max(1, round(page["width"] * factor))
        page["height"] = max(1, round(page["height"] * factor))
