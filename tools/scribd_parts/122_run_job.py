
def run_job(url: str | list[str], limit: int = 0, out: str = OUT, jobs: int = 12,
            name: str = "", check: bool = True,
            placeholder: bool = True, probe_page: int = 0,
            verify: bool = True, text: bool = False, gen: int = 0,
            note: str = "") -> None:
    urls = [str(item).strip() for item in
            (url if isinstance(url, (list, tuple)) else [url])
            if str(item or "").strip()]
    if gen:
        # /run already claimed the slot, so its progress must not be wiped here
        with JOB.lock:
            JOB.url = urls[0] if urls else ""
            JOB.out = out
    else:
        gen = JOB.begin()
        with JOB.lock:
            JOB.url = urls[0] if urls else ""
            JOB.out = out
    os.makedirs(out, exist_ok=True)
    if note:
        JOB.say(note)
    try:
        if not urls:
            with JOB.lock:
                JOB.verdict = "BAD LINK"
                JOB.detail = "no link given"
        elif probe_page:
            _probe(urls[0], probe_page)
        elif len(urls) > 1:
            _batch(urls, limit, out, jobs, check=check, placeholder=placeholder,
                   verify=verify, text=text, gen=gen)
        else:
            _download(urls[0], limit, out, jobs, name=name, check=check,
                      placeholder=placeholder, verify=verify, text=text, gen=gen)
    except Exception as exc:  # noqa: BLE001
        JOB.say(f"crashed: {exc!r}")
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = repr(exc)[:180]
    finally:
        with JOB.lock:
            # a reset or a takeover may already have closed this job: never
            # reopen it, and never let it narrate the job that replaced it
            owner = JOB.generation == gen and JOB.state == "running"
            if owner:
                JOB.state = "done"
                JOB.ended = time.time()
            verdict, detail = JOB.verdict, JOB.detail
        if owner:
            JOB.say("")
            JOB.say(f"== {verdict} — {detail}")
