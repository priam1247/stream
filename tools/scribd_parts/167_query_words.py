

def query_words(query: str) -> list[str]:
    """The words a person actually searched for, without filler."""
    raw = re.split(r"[^0-9a-z]+", (query or "").lower())
    words = [word for word in raw if word and word not in SEARCH_STOPWORDS]
    return list(dict.fromkeys(words))
