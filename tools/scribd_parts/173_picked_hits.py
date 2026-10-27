

def picked_hits(hits: list[dict], spec: str) -> list[dict]:
    """`--pick 1,3` and `--pick 2-4` out of the numbered list."""
    chosen: list[dict] = []
    for part in str(spec or "").replace(" ", ",").split(","):
        if not part:
            continue
        try:
            if "-" in part:
                start, end = part.split("-", 1)
                numbers = range(int(start), int(end) + 1)
            else:
                numbers = [int(part)]
        except ValueError:
            continue
        for number in numbers:
            if 1 <= number <= len(hits) and hits[number - 1] not in chosen:
                chosen.append(hits[number - 1])
    return chosen
