

def discover_shots(hosts: tuple | list | None = None, force: bool = False,
                   timeout: float = 3.0) -> tuple[str, str]:
    """The browser service to use, found by asking — nothing to configure.

    Cached, because a panel runs for days and a document asks once: a service
    that answered is trusted for SHOT_FOUND_FOR, and one that did not is looked
    for again after SHOT_RETRY_AFTER, so starting it later still works without a
    restart of this one.
    """
    candidates = list(hosts if hosts is not None else
                      ([SHOTS] if SHOTS else []) + list(SHOT_HOSTS) +
                      ([read_shooter_cache()] if read_shooter_cache() else []))
    with _SHOT_LOCK:
        age = time.time() - _SHOT_CACHE["when"]
        fresh = ((_SHOT_CACHE["base"] and age < SHOT_FOUND_FOR)
                 or (not _SHOT_CACHE["base"] and age < SHOT_RETRY_AFTER))
        if _SHOT_CACHE["when"] and fresh and not force:
            return _SHOT_CACHE["base"], _SHOT_CACHE["note"]
    tried: list[str] = []
    for candidate in candidates:
        base = str(candidate or "").strip().rstrip("/")
        if not base:
            continue
        status, body, error = shot_get(base + "/shot/ping", timeout)
        ready, why = ping_answer(status, body, error)
        if ready:
            note = f"{base} · {why}"
            with _SHOT_LOCK:
                _SHOT_CACHE.update(base=base, note=note, when=time.time())
            return base, note
        tried.append(f"{base} — {why}")
    note = ("no browser service answered: " + "; ".join(tried)
            if tried else "no browser service address to try")
    with _SHOT_LOCK:
        _SHOT_CACHE.update(base="", note=note, when=time.time())
    return "", note
