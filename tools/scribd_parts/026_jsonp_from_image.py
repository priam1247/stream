
def jsonp_from_image(image_url: str) -> str:
    """The descriptor that sits beside an image, under the same hash.

    Measured against a live document: images/2-90c206b2e6.jpg and
    pages/2-90c206b2e6.jsonp are the same <page>-<hash> pair, and the jsonp is
    where that page's words are. So a document that names only its scans still
    gives up its text.
    """
    swapped = re.sub(r"/images/(\d+-[0-9A-Za-z]+)\.(?:jpe?g|png|webp)(?:\?.*)?$",
                     r"/pages/\1.jsonp", image_url, flags=re.IGNORECASE)
    return "" if swapped == image_url else swapped
