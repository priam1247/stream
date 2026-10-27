
def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytes:
    out = bytearray(height * stride)
    previous = bytearray(stride)
    pos = 0
    for row in range(height):
        if pos >= len(raw):
            break
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = previous[i]
                corner = previous[i - bpp] if i >= bpp else 0
                delta = left + up - corner
                pa, pb, pc = abs(delta - left), abs(delta - up), abs(delta - corner)
                predictor = left if (pa <= pb and pa <= pc) else (
                    up if pb <= pc else corner)
                line[i] = (line[i] + predictor) & 0xFF
        out[row * stride:(row + 1) * stride] = line
        previous = line
    return bytes(out)
