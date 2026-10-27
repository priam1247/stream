
def jpeg_frames(data: bytes) -> tuple[list[tuple[int, int, int]], bool]:
    """Every frame header in a JPEG, and whether the file arrived whole.

    A cut transfer keeps the header and loses the tail, so the only honest test
    for "did this file arrive complete" is the end-of-image marker. Without it a
    viewer draws the decoded sliver and greys the rest — a page that looks like
    our bug instead of the CDN's.
    """
    if data[:2] != b"\xff\xd8":
        return [], False
    frames: list[tuple[int, int, int]] = []
    index = 2
    limit = min(len(data), 4_000_000)
    saw_scan = False
    while index + 4 <= limit:
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker == 0xD9:                    # end of image, before any scan
            break
        if marker == 0xDA:                    # scan data starts here
            saw_scan = True
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if index + 10 <= limit:
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                components = data[index + 9]
                if width and height:
                    frames.append((width, height, components))
        index += 2 + length
    tail = data.rstrip(b"\x00\t\r\n ")
    return frames, bool(saw_scan and tail.endswith(b"\xff\xd9"))
