
def pillow_size(data: bytes) -> tuple[int, int, int]:
    """Last-resort size for an image whose header the parser cannot trust.

    Only reached when the bytes look like an image but no plausible frame header
    was found. Pillow is optional; without it this simply says "unknown" and the
    page is reported, never guessed at.
    """
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001
        return 0, 0, 0
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.width, image.height, 3
    except Exception:  # noqa: BLE001
        return 0, 0, 0
