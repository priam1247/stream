

def prune_out(folder: str) -> list[str]:
    """Keep the output folder from filling a small disk.

    A 10 GB plan holds maybe forty 150 MB books, and every document also leaves
    its pages' words in `cache/` — which is what makes re-running a partial cheap,
    so it is kept for a few days rather than thrown away at once. Rules, in
    order:

      1. page caches older than SCRIBD_CACHE_DAYS are deleted;
      2. only the newest SCRIBD_KEEP_FILES PDFs are kept;
      3. if the folder is still bigger than SCRIBD_MAX_MB, the oldest PDFs go
         until it is not.

    Returns one line per thing it deleted, so the log can say what happened
    instead of a folder quietly shrinking.
    """
    said: list[str] = []
    if not os.path.isdir(folder):
        return said

    cache_root = os.path.join(folder, "cache")
    cutoff = time.time() - CACHE_DAYS * 86400
    if os.path.isdir(cache_root):
        for name in sorted(os.listdir(cache_root)):
            path = os.path.join(cache_root, name)
            try:
                if os.path.isdir(path) and os.path.getmtime(path) < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
                    said.append(f"cache: dropped {name} (older than "
                                f"{CACHE_DAYS:g} day(s))")
            except OSError:
                pass

    pdfs = panel_files(folder, limit=100000)
    for row in pdfs[KEEP_FILES:]:
        path = os.path.join(folder, row["name"])
        try:
            os.remove(path)
            said.append(f"disk: removed {row['name']} "
                        f"({row['bytes'] / 1e6:.0f} MB, older than the newest "
                        f"{KEEP_FILES})")
        except OSError:
            pass

    while folder_mb(folder) > MAX_OUT_MB and len(pdfs) > 1:
        row = pdfs.pop()                      # the oldest one left
        path = os.path.join(folder, row["name"])
        try:
            os.remove(path)
            said.append(f"disk: removed {row['name']} to stay under "
                        f"{MAX_OUT_MB} MB")
        except OSError:
            break
    return said
