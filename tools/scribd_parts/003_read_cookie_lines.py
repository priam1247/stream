
def read_cookie_lines(path: str) -> list[list[str]]:
    rows: list[list[str]] = []
    if not path or not os.path.isfile(path):
        return rows
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("#HttpOnly_"):
                    line = line[len("#HttpOnly_"):]
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) == 7:
                    rows.append(parts)
    except OSError:
        pass
    return rows
