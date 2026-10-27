

def shard_fraction(words: str) -> float:
    """How much of a page's words are glyph shards instead of words.

    A text layer that failed to decode leaves a signature no character count
    has: its "words" are one- and two-letter runs — `Udd h`, `Eo`, `er`, `W` —
    scattered where lines should be. A page that is genuinely sparse has the
    opposite shape: very few tokens, but whole ones — `Contents`, `Fifth
    Edition`, a folio `6`, a dedication `For my mother`. So the share of
    alphabetic tokens that are one or two letters is what tells a fake page
    from a short real one, and it does not care how long the page is.
    """
    # the words a page carries are stored with their placement marks in front
    # of every line ("\x010.0000|Udd h"); tokenising THAT would chew on the
    # positions and hide the shards entirely
    plain = words_plain(str(words or ""))
    tokens = [tok for tok in re.split(r"\s+", plain.strip()) if tok]
    alpha = [tok for tok in tokens if re.search(r"[A-Za-z]", tok)]
    if not alpha:
        return 0.0          # a folio, a figure, a page number: nothing shardy
    shards = [tok for tok in alpha
              if re.fullmatch(r"[A-Za-z]{1,2}", tok.strip(".,;:!?\"'()"))]
    return len(shards) / len(alpha)
