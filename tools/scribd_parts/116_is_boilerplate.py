

def is_boilerplate(line: str) -> bool:
    """Is this line the viewer's furniture rather than the document?"""
    plain = line.strip().lower()
    if not plain:
        return False
    if plain in BOILERPLATE_JUNK:
        return True
    if plain.isdigit() and len(plain) <= 4:      # a page number in the chrome
        return True
    return any(marker in plain for marker in BOILERPLATE)
