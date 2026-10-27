

def ensure_shooter(shooter: "Shooter") -> "Shooter":
    """A live shooter: ask again past the cache, then start one myself."""
    if shooter.alive():
        return shooter
    base, _note = discover_shots(force=True)
    if not base:
        base = scan_for_shooter()
    if not base:
        base = autostart_shots()
    if not base:
        # Asked after the attempt, not before it. A copy has just been started,
        # so the local door is one cheap question away from the truth: if it
        # came up late it is used, and if it came up and cannot help, its own
        # answer joins what the document says — because a stale "nothing is
        # listening" beside a service that did answer sends anybody reading it
        # looking in the wrong place.
        local = f"http://127.0.0.1:{SHOT_LOCAL_PORT}"
        status, body, error = shot_get(local + "/shot/ping", 3.0)
        ready, why = ping_answer(status, body, error)
        if not ready:
            shooter.state = False
            shooter.note = (f"{shooter.note or 'no browser service answered'}; "
                            f"the copy started here says: {why}")
            return shooter
        base = local
    fresh = Shooter(base, discover=False)
    return fresh if fresh.alive() else shooter
