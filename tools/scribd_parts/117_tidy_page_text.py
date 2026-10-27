

def tidy_page_text(words: str, keep_spacing: bool = False) -> str:
    """One page's words with the viewer chrome taken out, lines kept.

    `keep_spacing` leaves runs of spaces alone: a row of a contents page spaces
    its two columns with spaces, and collapsing them welds the columns together.
    """
    out: list[str] = []
    for line in (words or "").split("\n"):
        line = line.strip() if keep_spacing else " ".join(line.split())
        if line and not is_boilerplate(line):
            out.append(line)
    return "\n".join(out)
