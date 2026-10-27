
def redact(text: str, limit: int = 150) -> str:
    """A URL or body line safe to paste into a chat window.

    Probe output is meant to be shared — with a person, in an issue — so every
    token in it is replaced before printing. A cookie or a token in a screenshot
    is a leaked account; this is the one place that could happen by accident.
    """
    out = str(text or "")
    for shape in TOKEN_SHAPES:
        out = shape.sub(lambda m: m.group(0).replace(m.group(1), "REDACTED"), out)
    out = re.sub(r"([?&](?:key|access_key|sid)=)[A-Za-z0-9._%\-]{8,}",
                 r"\1REDACTED", out)
    out = " ".join(out.split())
    return out[:limit]
