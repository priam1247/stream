
def _unpack_bits(row: bytes, count: int, depth: int) -> list[int]:
    out: list[int] = []
    per_byte = 8 // depth
    mask = (1 << depth) - 1
    for byte in row:
        for slot in range(per_byte):
            out.append((byte >> (8 - depth * (slot + 1))) & mask)
            if len(out) == count:
                return out
    return out
