

def entry_manifest(pages: list[dict]) -> str:
    """One honest line about how the book was cut."""
    widths = {int(e.get("width") or 0) for e in pages}
    heights = {int(e.get("height") or 0) for e in pages}
    unstable = [int(e.get("page") or 0) for e in pages if e.get("unstable")]
    blanks = [int(e.get("page") or 0) for e in pages if e.get("blank")]
    if len(widths) == 1 and len(heights) == 1:
        size = f"every sheet {sorted(widths)[0]}x{sorted(heights)[0]}"
    else:
        size = (f"{len(widths)} different size(s) — the viewer did not lay "
                f"them out as one column")
    line = f"{len(pages)} page(s) clipped at the gaps, {size}"
    if unstable:
        line += f" · page(s) {', '.join(map(str, unstable[:8]))} were still " \
                f"moving between two captures"
    if blanks:
        line += f" · page(s) {', '.join(map(str, blanks[:8]))} look empty"
    return line
