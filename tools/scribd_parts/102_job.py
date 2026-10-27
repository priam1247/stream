

class Job:
    """One job slot, with a generation number so a stopped job really stops.

    The generation is what makes stopping honest: every worker asks
    `alive(gen)`, and a reset bumps the generation, so the abandoned thread
    can never write into the new job's progress or verdict.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.generation = 0
        self.heartbeat = 0.0
        self.lines: list[str] = []
        self.state = "idle"
        self.verdict = ""
        self.detail = ""
        self.url = ""
        self.started = 0.0
        self.ended = 0.0
        self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
        self.file = ""
        self.title = ""
        self.out = OUT
        # the queue: ticked documents wait here, one is downloaded at a time
        self.queue: list[dict] = []
        self.queue_done = 0
        self.queue_total = 0
        self.batch_left = 0            # a CLI batch: documents still to come
        self.current = ""
        self.results: list[dict] = []

    def say(self, text: str) -> None:
        with self.lock:
            self.lines.append(text)
            del self.lines[:-400]
        print(text, flush=True)

    def set_progress(self, **kwargs) -> None:
        with self.lock:
            self.progress.update(kwargs)
            self.heartbeat = time.time()      # the sign of a job that is alive

    def quiet_for(self) -> float:
        """Seconds since the last page progress (0 when nothing is running)."""
        with self.lock:
            if self.state != "running":
                return 0.0
            last = self.heartbeat or self.started or time.time()
            return max(0.0, time.time() - last)

    def stalled(self) -> bool:
        return self.quiet_for() > STALL_SECONDS

    def alive(self, gen: int) -> bool:
        """Is that generation still the job that owns the slot?"""
        with self.lock:
            return self.state == "running" and gen == self.generation

    def _start(self) -> int:
        """Take the slot. `threading.Lock` is not re-entrant, so the CALLER
        holds the lock — `begin()` and `enqueue()` both do."""
        self.generation += 1
        self.state = "running"
        self.started = time.time()
        self.heartbeat = self.started
        self.ended = 0.0
        self.verdict = ""
        self.detail = ""
        self.file = ""
        self.title = ""
        self.lines.clear()
        self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
        # a fresh start begins a fresh tally; anything already queued stays queued
        self.queue_done = 0
        self.results = []
        self.current = ""
        return self.generation

    def begin(self) -> int:
        """Start a job from the command line, where there is no queue to check."""
        with self.lock:
            return self._start()

    def stop(self, reason: str, clear_queue: bool = True) -> bool:
        """Stop whatever is running, so its workers see they are not alive."""
        with self.lock:
            dropped = len(self.queue)
            if clear_queue:
                self.queue.clear()
                self.current = ""
            if self.state != "running":
                return False
            self.generation += 1          # every worker now answers alive() == False
            self.state = "done"
            self.verdict = "STOPPED"
            self.detail = reason + (f" · {dropped} document(s) dropped from the queue"
                                    if dropped else "")
            self.ended = time.time()
        return True

    # -- the queue ---------------------------------------------------------
    def pending(self) -> int:
        with self.lock:
            return len(self.queue)

    def waiting(self) -> int:
        """Documents waiting behind the one in flight, on either bulk path.

        The panel queues into self.queue; a CLI batch walks a plain list and
        keeps its count here. Both mean the same thing to a document that is
        only refusals: somebody is waiting, so stop being polite.
        """
        with self.lock:
            return len(self.queue) + self.batch_left

    def enqueue(self, items: list[dict]) -> tuple[bool, int, str]:
        """Queue these documents. Start the worker only if nobody is working.

        This is what makes "download ticked while another book is downloading"
        work: a second tap is not refused and nothing is lost — it is added
        behind the one in flight. A job that has not moved for STALL_SECONDS is
        taken over, and whatever was still queued for it carries on here.
        """
        if not items:
            return False, self.generation, ""
        note = ""
        with self.lock:
            if self.state == "running":
                quiet = time.time() - (self.heartbeat or self.started or time.time())
                if quiet <= STALL_SECONDS:
                    self.queue.extend(items)
                    self.queue_total += len(items)
                    return False, self.generation, ""
                note = (f"taking over from a job that had not moved for "
                        f"{int(quiet)}s")
            self.queue.extend(items)      # a takeover keeps the waiting work
            gen = self._start()
            self.queue_total = len(self.queue)
            return True, gen, note

    def next_item(self, gen: int) -> dict | None:
        """The next document for this worker, or None when the queue is empty."""
        with self.lock:
            if gen != self.generation or self.state != "running":
                return None
            if not self.queue:
                return None
            item = self.queue.pop(0)
            self.current = str(item.get("url") or "")
            self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
            self.heartbeat = time.time()
            return item

    def finish_item(self, gen: int, item: dict, verdict: str, detail: str,
                    file: str) -> None:
        """Record one finished document and move the queue forward."""
        with self.lock:
            if gen != self.generation:
                return
            self.queue_done += 1
            self.results.append({
                "url": item.get("url", ""),
                "title": os.path.basename(file or "") or item.get("url", ""),
                "file": file or "",
                "verdict": verdict,
                "detail": detail,
            })
            self.current = ""
            self.heartbeat = time.time()
            self.progress = {"page": self.queue_done, "of": self.queue_total,
                             "ok": self.queue_done, "skipped": 0, "blank": 0}

    def close_queue(self, gen: int) -> None:
        """The queue is empty: one honest verdict for the whole batch."""
        with self.lock:
            if gen != self.generation or self.state != "running":
                return
            built = sum(1 for row in self.results if row["verdict"] == "PDF BUILT")
            partial = sum(1 for row in self.results if row["verdict"] == "PDF PARTIAL")
            dropped = sum(1 for row in self.results if row["verdict"] == "DROPPED")
            other = len(self.results) - built - partial - dropped
            last_file = next((row["file"] for row in reversed(self.results)
                              if row["file"]), "")
            if built and not partial and not other and not dropped:
                self.verdict = "PDF BUILT"
            elif built or partial:
                self.verdict = "PDF PARTIAL"
            else:
                self.verdict = "FAILED"
            if len(self.results) == 1:
                # one book keeps its own verdict and detail, not "0 of 1 built"
                self.verdict = self.results[0]["verdict"] or self.verdict
                self.detail = self.results[0]["detail"] or self.verdict
            else:
                self.detail = (f"{built} of {len(self.results)} document(s) built"
                               + (f", {partial} partial" if partial else "")
                               + (f", {dropped} dropped by the queue"
                                  if dropped else "")
                               + (f", {other} failed" if other else ""))
            self.file = last_file
            self.current = ""
            self.state = "done"
            self.ended = time.time()

    def snapshot(self) -> dict:
        with self.lock:
            return {"state": self.state, "verdict": self.verdict,
                    "detail": self.detail, "url": self.url,
                    "progress": dict(self.progress), "file": self.file,
                    "title": self.title,
                    "seconds": round((self.ended or time.time()) - self.started, 1)
                    if self.started else 0,
                    "log": list(self.lines)[-200:],
                    "cookies": cookie_report(find_cookies()),
                    "queue": {"pending": len(self.queue), "done": self.queue_done,
                              "total": self.queue_total, "current": self.current,
                              "results": list(self.results)[-20:]},
                    "quiet": round(max(0.0, time.time() - self.heartbeat)
                                   if self.state == "running" and self.heartbeat else 0),
                    "stalled": (self.state == "running" and self.heartbeat
                                and time.time() - self.heartbeat > STALL_SECONDS),
                    "stall_after": STALL_SECONDS,
                    "version": VERSION, "sample": SAMPLE}
