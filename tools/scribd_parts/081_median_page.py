
def median_page(pages: list[dict]) -> tuple[int, int]:
    """The document's page size: the median PAGE, not the commonest and not two
    medians. Sorting by area and taking the middle page keeps the answer a real
    page's own (width, height); averaging the axes separately can invent a size
    no page ever had (1200x1600 + 1600x1200 -> 1600x1600). One misparsed page
    cannot move the middle of 400.
    """
    ordered = sorted(pages, key=lambda page: (page["width"] * page["height"],
                                              page["width"]))
    page = ordered[len(ordered) // 2]
    return page["width"], page["height"]
