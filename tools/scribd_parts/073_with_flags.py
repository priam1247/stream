
def with_flags(page: dict | None, complete: bool = True) -> dict | None:
    """Record what the report needs to know about the picture that arrived."""
    if not page:
        return None
    page.setdefault("preview", False)
    page.setdefault("complete", complete)
    return page
