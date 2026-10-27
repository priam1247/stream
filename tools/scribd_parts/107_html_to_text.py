

def html_to_text(html: str, collapse: bool = True) -> str:
    """The words of one page out of Scribd's own HTML, line by line.

    Scribd sends each page's text as HTML with <br> and block tags, so breaks
    have to become newlines before the tags are stripped; otherwise the whole
    page becomes one long line and a text layer is useless for selection.
    """
    text = BREAK_TAG_RE.sub("\n", html or "")
    text = TAG_STRIP_RE.sub("", text)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "),
                 ("&mdash;", "-"), ("&ndash;", "-"), ("&rsquo;", "'"),
                 ("&lsquo;", "'"), ("&ldquo;", '"'), ("&rdquo;", '"')):
        text = text.replace(a, b)
    # blank lines carry no words and only eat the little room a sheet has,
    # so they are dropped: one line of text per line of the page
    # `collapse=False` keeps runs of spaces, which is how a text layer with no
    # CSS placement says where its lines end
    lines = [(SPACE_RE.sub(" ", line) if collapse else line).strip()
             for line in text.split("\n")]
    return "\n".join(line for line in lines if line)
