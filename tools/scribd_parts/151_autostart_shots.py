

def autostart_shots() -> str:
    """Start tools/troy-search myself and wait for it to answer. '' if I cannot.

    Retried at most once per cooldown after a failure, cached forever once it
    works. SCRIBD_AUTOSHOOT=0 turns it off for hosts where a browser must never
    be spawned; SCRIBD_SHOOTER_DIR points somewhere else. If the service has no
    packages installed, npm install runs once first — photographs need them,
    and a panel box that runs node can fetch them.
    """
    if _AUTOSTART["base"]:
        return _AUTOSTART["base"]
    now = time.time()
    if _AUTOSTART["tried"] and now - _AUTOSTART["tried"] < AUTOSTART_COOLDOWN:
        return ""
    _AUTOSTART["tried"] = now
    if os.environ.get("SCRIBD_AUTOSHOOT", "1") == "0":
        return ""
    node = shutil.which("node")
    here = os.path.dirname(os.path.abspath(__file__))
    proj = os.environ.get("SCRIBD_SHOOTER_DIR") or os.path.join(here, "troy-search")
    entry = os.path.join(proj, "index.js")
    if not node or not os.path.isfile(entry):
        JOB.say("no browser service is running and I cannot start one myself "
                f"(node found: {bool(node)} · {entry} exists: "
                f"{os.path.isfile(entry)}) — pages with no other source will "
                f"be left out of the PDF and named, never greyed")
        return ""
    os.makedirs(os.path.join(proj, "tmp"), exist_ok=True)
    log = shooter_log_path(proj)
    if not os.path.isdir(os.path.join(proj, "node_modules")) \
            and not _AUTOSTART["npm_tried"]:
        _AUTOSTART["npm_tried"] = True
        npm = shutil.which("npm")
        if npm:
            JOB.say("the browser service has no packages installed — running "
                    "npm install in tools/troy-search once, because the "
                    "photographs need them")
            try:
                done = subprocess.run(
                    [npm, "install", "--no-audit", "--no-fund",
                     "--loglevel=error"],
                    cwd=proj, capture_output=True, timeout=900)
                with open(log, "ab") as handle:
                    handle.write((done.stderr or done.stdout or b"")[-2000:])
            except Exception as exc:  # noqa: BLE001
                JOB.say(f"npm install for the browser service failed: {exc!r}")
        else:
            JOB.say("the browser service has no packages installed and npm is "
                    "not on the PATH — run npm install in tools/troy-search "
                    "once by hand")
    env = dict(os.environ)
    env.setdefault("TMPDIR", os.path.join(proj, "tmp"))
    # A copy started beside this panel is a local one, so it takes the local
    # door — never the port the host assigned to THIS container, which is the
    # panel's own and already taken. Without this, a host that hands every
    # container its public port in SERVER_PORT would have the browser try to
    # sit on the panel's door and die there.
    env.pop("SERVER_PORT", None)
    env["PORT"] = str(SHOT_LOCAL_PORT)
    try:
        handle = open(log, "ab")
        subprocess.Popen([node, "index.js"], cwd=proj, env=env,
                         stdout=subprocess.DEVNULL, stderr=handle,
                         start_new_session=True)
    except Exception as exc:  # noqa: BLE001
        JOB.say(f"starting the browser service myself failed: {exc!r}")
        return ""
    JOB.say("no browser service was running — starting tools/troy-search "
            "myself and waiting for it, because a grey page is not an option")
    local = f"http://127.0.0.1:{SHOT_LOCAL_PORT}"
    for waited in range(45):
        time.sleep(1.0)
        # The copy started here is the one being waited for, so it is the one
        # asked: walking the whole ladder every second spends minutes on
        # addresses across a network that answer nothing at all, while the
        # browser being waited for is next door and refuses in a millisecond.
        if ping_ok(local, 2.0):
            _AUTOSTART["base"] = local
            JOB.say(f"the browser service I started is up: {local}")
            return local
        if waited in (19, 44):
            # twice, though, the world is asked as well: a service that came up
            # somewhere else while this one was starting is worth more than the
            # copy being waited for, and must not be missed
            base, _note = discover_shots(force=True)
            if base:
                _AUTOSTART["base"] = base
                JOB.say(f"a browser service answered while this one was "
                        f"starting: {base}")
                return base
    reason = shooter_start_reason(proj)
    JOB.say("the browser service I started never answered in 45s"
            + (f" — its own last words: {reason}" if reason else
               f" (start log: {log})"))
    return ""
