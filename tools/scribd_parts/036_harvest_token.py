
def harvest_token(body: bytes, where: str = "") -> str:
    """Find the scan token wherever it is written, and refuse the fake ones.

    v2.16 looks for four shapes, because the panel's log said
    `image token: none on the page` for scanned uploads while the same page in a
    browser served its scans: the token was in the body, just not as `?token=`.
    """
    scored: list[tuple[tuple[int, int], str, str]] = []
    seen: set[str] = set()
    text = text_of(body)
    for variant in (text, urllib.parse.unquote(text)):
        for index, shape in enumerate(TOKEN_SHAPES):
            for match in shape.finditer(variant):
                for candidate in (match.group(1), urllib.parse.unquote(match.group(1))):
                    candidate = candidate.strip("\"'")
                    if candidate in seen or not usable_token(candidate):
                        continue
                    seen.add(candidate)
                    scored.append((token_score(candidate), candidate, f"shape {index + 1}"))
    if not scored:
        return ""
    scored.sort(key=lambda row: row[0], reverse=True)
    best = scored[0]
    if where:
        JOB.say(f"image token: found in the {where} ({best[2]}, "
                f"{'jwt' if jwt_ok(best[1]) else 'plain'})")
    return best[1]
