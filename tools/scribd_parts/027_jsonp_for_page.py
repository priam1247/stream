

def jsonp_for_page(url: str, number: int) -> str:
    """That page's descriptor, built on a pattern the document already names.

    A converted document may name an asset for one page only (page 1 keeps its
    scan). The other pages still have descriptors; their address is the same
    shape with another page number, so it can be built instead of guessed.
    """
    swapped = jsonp_from_image(url) or url
    return re.sub(r"/(pages|images)/\d+-", lambda m: f"/{m.group(1)}/{number}-",
                  swapped, count=1)
