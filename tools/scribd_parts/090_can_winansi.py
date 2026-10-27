

# Helvetica is base-14 WinAnsi, which is cp1252 — not Latin-1. The curly quotes,
# dashes and ellipsis a Word document is full of are cp1252 bytes, so a character
# is kept whenever cp1252 can spell it. Dropped, they turned "ZAM’KATIMU" into
# "ZAMKATIMU" and swallowed the dotted leaders of a contents page; written as
# the wrong byte, they became "?".
def can_winansi(char: str) -> bool:
    """Can Helvetica's WinAnsi encoding spell this character at all?"""
    try:
        char.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True
