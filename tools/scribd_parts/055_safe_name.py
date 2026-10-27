

# ---------------------------------------------------------------------------
# what the document is called
# ---------------------------------------------------------------------------
def safe_name(text: str, fallback: str) -> str:
    text = text or ""
    for a, b in (("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"'), ("&lt;", "<"),
                 ("&gt;", ">")):
        text = text.replace(a, b)
    text = re.sub(r"\s+", " ", text).strip().strip("\"' ")
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", text)
    text = text.strip(" .")[:120].strip(" .")
    return text or fallback
