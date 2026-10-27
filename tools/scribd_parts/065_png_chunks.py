
def png_chunks(data: bytes) -> tuple[dict, bytes, bytes] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos = 8
    header: dict = {}
    palette = b""
    stream = b""
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            break
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            header = {"width": width, "height": height, "depth": depth,
                      "colour": colour, "interlace": interlace}
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            stream += body
        elif kind == b"IEND":
            break
    if not header or not stream:
        return None
    return header, palette, stream
