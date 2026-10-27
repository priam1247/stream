

def viewer_fingerprint(body: bytes) -> str:
    """What the viewer page actually is, in one line — for `--probe`.

    When a page comes out blank, this is the line that says why: a JS-only
    shell (no text at all), text with no page numbers, or the normal case.
    """
    text = SCRIPT_BLOCK_RE.sub(" ", text_of(body))
    marks = len(PAGE_ANCHOR_RE.findall(text))
    layers = len(re.findall(r'class="[^"]*text_layer', text, re.IGNORECASE))
    words = len(html_to_text(text))
    return (f"{len(body) / 1000:.0f} kB · {marks} page mark(s) · "
            f"{layers} text block(s) · {words} chars of text")
