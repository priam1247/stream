
# ---------------------------------------------------------------------------
# images -> something a PDF can hold
# ---------------------------------------------------------------------------
def _sof_candidates(data: bytes) -> list[tuple[int, int, int]]:
    """Every JPEG frame header in the data, as (width, height, components)."""
    found: list[tuple[int, int, int]] = []
    for match in re.finditer(rb"\xff[\xc0-\xcf]", data):
        position = match.start()
        marker = data[position + 1]
        if marker in (0xC4, 0xC8, 0xCC):        # not frame headers
            continue
        if position + 10 > len(data):
            continue
        height, width = struct.unpack(">HH", data[position + 5:position + 9])
        components = data[position + 9]
        if width and height:
            found.append((width, height, components))
    return found
