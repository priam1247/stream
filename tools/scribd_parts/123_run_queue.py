
def run_queue(gen: int, out: str, note: str = "") -> None:
    """Download the queue, one document at a time, until it is empty.

    One document at a time is the whole point: the panel has one connection
    budget and one output folder, and Scribd throttles by address anyway. What
    the queue buys is the other half of the feature — you can keep searching and
    tick more books while the current one downloads, and they are appended here
    instead of being refused.
    """
    os.makedirs(out, exist_ok=True)
    if note:
        JOB.say(note)
    while True:
        item = JOB.next_item(gen)
        if item is None:
            break
        url = str(item.get("url") or "")
        with JOB.lock:
            index = JOB.queue_done + 1
            total = JOB.queue_total
            JOB.url = url
            JOB.verdict = ""
            JOB.detail = ""
            JOB.file = ""
        JOB.say("")
        JOB.say(f"=== document {index} of {total}: {url}")
        try:
            # Named, not positional. This call used to hand over a bare False
            # for a parameter that no longer exists, and every document the panel
            # was asked for died with "_download() takes from 3 to 10 positional
            # arguments but 11 were given" — a row of True, True, True is how a
            # removed parameter hides until the panel is running.
            _download(url, int(item.get("limit") or 0), out,
                      jobs=int(item.get("jobs") or PANEL_JOBS), name="",
                      check=True, placeholder=True, verify=True,
                      text=bool(item.get("text")), gen=gen)
        except Exception as exc:  # noqa: BLE001
            JOB.say(f"crashed on {url}: {exc!r}")
            with JOB.lock:
                JOB.verdict = "FAILED"
                JOB.detail = repr(exc)[:180]
                JOB.file = ""
        with JOB.lock:
            verdict, detail, file = JOB.verdict, JOB.detail, JOB.file
        JOB.finish_item(gen, item, verdict, detail, file)

    if not JOB.alive(gen):
        return                        # stopped or taken over: say nothing
    JOB.close_queue(gen)
    with JOB.lock:
        verdict, detail = JOB.verdict, JOB.detail
    JOB.say("")
    JOB.say(f"== {verdict} — {detail}")
