

def sheet_scale(sheet: tuple[float, float]) -> float:
    """How big this sheet is against an A4 page, for sizes and margins.

    A Word document's page comes through at whatever the viewer's scan was —
    900x1200 pt is not rare — and 10.5 pt on a sheet that big looks like a
    footnote in the corner. Type is sized against the sheet, not against an
    absolute number, so a page reads the same at any page size.
    """
    return max(0.6, min(2.5, min(sheet[0] / 595.0, sheet[1] / 842.0)))
