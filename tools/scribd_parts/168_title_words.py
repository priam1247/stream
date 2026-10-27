

def title_words(text: str) -> list[str]:
    return [word for word in re.split(r"[^0-9a-z]+", (text or "").lower()) if word]
