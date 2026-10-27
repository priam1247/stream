

def refusal_reason(body: bytes, status: int) -> str:
    """Why the browser service said no, in its own words."""
    if body:
        try:
            answer = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            answer = None
        if isinstance(answer, dict):
            for key in ("error", "note", "message"):
                text = str(answer.get(key) or "").strip()
                if text:
                    # 200 characters cut the browser's own diagnosis in half —
                    # "the column NaNpx tall, 0 bo" is what a run printed, and
                    # the rest of that sentence was the part that said why
                    return text[:900]
    text = body[:900].decode("utf-8", "replace").strip()
    return text or f"http {status}"
