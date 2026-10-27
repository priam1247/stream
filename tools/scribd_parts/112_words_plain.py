

def words_plain(words: str) -> str:
    """The page's words without the placement marks, for counting and display."""
    lines, _places = decode_page_lines(words)
    return "\n".join(lines)
