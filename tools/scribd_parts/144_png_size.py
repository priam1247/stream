

# ─── the browser service starts itself ──────────────────────────────────────
# A host that runs only the web process (the Procfile's `web:` line) has no
# shooter until somebody starts one by hand — and a document whose scans are
# refused then used to end in grey sheets saying "scan not available". That
# sheet no longer exists, so the engine makes sure the browser does: same box,
# same node that runs the panel, the service that ships next to this file.
def png_size(payload: bytes) -> tuple[int, int]:
    """(width, height) as a PNG header claims them — no decoding."""
    if len(payload) < 24 or payload[:4] != b"\x89PNG":
        return 0, 0
    import struct as _struct
    width, height = _struct.unpack(">II", payload[16:24])
    return int(width), int(height)
