

def _batch(urls: list[str], limit: int, out: str, jobs: int = 12,
           check: bool = True, placeholder: bool = True,
           verify: bool = True, text: bool = False, gen: int = 0) -> None:
    """Several documents, one after another, with one honest verdict at the end.

    Each link goes through exactly the same _download path as a single link, so
    a batch can never behave differently from the one-document case.
    """
    total = len(urls)
    built = partial = broken = dropped = 0
    lines: list[str] = []
    last_file = ""
    for index, link in enumerate(urls, start=1):
        if gen and not JOB.alive(gen):
            JOB.say("stopped before the next document")
            break
        JOB.say("")
        JOB.say(f"=== document {index} of {total}: {link}")
        with JOB.lock:
            JOB.url = link
            JOB.batch_left = total - index   # documents behind this one
        try:
            _download(link, limit, out, jobs, name="", check=check,
                      placeholder=placeholder, verify=verify, text=text, gen=gen)
        except Exception as exc:  # noqa: BLE001
            JOB.say(f"crashed on {link}: {exc!r}")
            broken += 1
            lines.append(f"{index}. FAILED — {link}")
            continue
        verdict = JOB.verdict
        if verdict == "PDF BUILT":
            built += 1
            last_file = JOB.file or last_file
        elif verdict == "PDF PARTIAL":
            partial += 1
            last_file = JOB.file or last_file
        elif verdict == "DROPPED":
            dropped += 1               # let go on purpose, not a crash
            last_file = JOB.file or last_file
        else:
            broken += 1
        lines.append(f"{index}. {verdict} — {os.path.basename(JOB.file or '') or link}")
        JOB.set_progress(page=index, of=total)
        with JOB.lock:
            JOB.title = f"document {index} of {total}"
    if gen and not JOB.alive(gen):
        with JOB.lock:
            JOB.batch_left = 0
        return                       # a reset ended this batch; leave it ended
    with JOB.lock:
        JOB.batch_left = 0
        if built == total:
            JOB.verdict = "PDF BUILT"
        elif built or partial:
            JOB.verdict = "PDF PARTIAL"
        else:
            JOB.verdict = "FAILED"
        JOB.file = last_file
        JOB.detail = (f"{built} of {total} document(s) built"
                      + (f", {partial} partial" if partial else "")
                      + (f", {dropped} dropped by the queue" if dropped else "")
                      + (f", {broken} failed" if broken else ""))
    JOB.say("")
    for line in lines:
        JOB.say("  " + line)
