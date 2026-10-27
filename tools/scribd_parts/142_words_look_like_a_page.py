

def words_look_like_a_page(words: str) -> bool:
    """Whether these words are a page of a book, or the wreckage of a font decode.

    Length must not be the test. A title page, a dedication, a folio and a
    chapter divider are all real pages with almost nothing on them, and a
    character floor drops exactly those — which is how a fix for one blank book
    would have started eating short real ones. What was shipped instead of page
    1 of a live book was not *short*, it was *shards*: seven glyph runs where
    lines of words should be, because the viewer's custom font would not decode.
    Half or more of the alphabetic tokens being one or two letters is that
    wreckage; no real page, however sparse, looks like it. A page below the
    rule is left out of the PDF and named, which is honest, where an empty sheet
    with writing on it is not.
    """
    if not str(words or "").strip():
        return False
    return shard_fraction(words) < MAX_SHARD_FRACTION
