

def panel_files(folder: str, limit: int = 100) -> list[dict]:
    """Every finished PDF in the output folder, newest first.

    The dashboard cannot guess file names, so it asks for this list instead of
    remembering what it started.
    """
    found: list[dict] = []
    try:
        names = os.listdir(folder)
    except OSError:
        return found
    for name in names:
        if not name.lower().endswith(".pdf"):
            continue
        path = os.path.join(folder, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        found.append({"name": name, "bytes": stat.st_size,
                      "when": int(stat.st_mtime)})
    found.sort(key=lambda item: -item["when"])
    return found[:max(1, limit)]
