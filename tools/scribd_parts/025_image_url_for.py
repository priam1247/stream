
# ---------------------------------------------------------------------------
# url helpers — no guessing, only the names the document gave
# ---------------------------------------------------------------------------
def image_url_for(jsonp_url: str) -> str:
    """The scan name that sits next to a descriptor name, under the same hash."""
    swapped = re.sub(r"/pages/(\d+-[0-9A-Za-z]+)\.jsonp(?:\?.*)?$",
                     r"/images/\1.jpg", jsonp_url, flags=re.IGNORECASE)
    return "" if swapped == jsonp_url else swapped
