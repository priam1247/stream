
def house_sheet(pages: list[dict]) -> tuple[float, float]:
    """The one sheet every page is scaled into: the median page, in points.

    Pages that only came as a small preview are left out of the median: a
    document served half in 96x130 copies must not end up with 96x130 sheets.
    """
    real = ([page for page in pages
             if not page.get("preview") and not page.get("shot")] or pages)
    width, height = median_page(real)
    return round(width * 0.75, 2), round(height * 0.75, 2)
