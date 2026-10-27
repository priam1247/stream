

class Shooter:
    """One browser service, asked for the pages this document could not build.

    The service stays warm between requests, so a document's missing pages are
    asked for several at a time and each one costs a tab, not a browser.
    """

    def __init__(self, base: str = "", scale: float = 0.0,
                 timeout: float = 0.0, discover: bool = True) -> None:
        self.base = (base or SHOTS).rstrip("/")
        self.discover = discover
        self.scale = max(0.5, min(4.0, float(scale or SHOT_SCALE)))
        self.timeout = float(timeout or SHOT_TIMEOUT)
        self.state: bool | None = None     # asked once per document, not per page
        self.note = ""

    def ping(self) -> bool:
        """Is there a browser to ask? One cheap request, answered once.

        With no address given, the written-down list is asked in order — that is
        what makes this work with nothing configured.
        """
        if not self.base and self.discover:
            self.base, found = discover_shots()
            if not self.base:
                self.state = False
                self.note = found
                return False
        if not self.base:
            self.state = False
            self.note = ("no browser service to ask — the addresses written into "
                         "SHOT_HOSTS did not answer, and SCRIBD_SHOTS is not set")
            return False
        status, body, error = shot_get(self.base + "/shot/ping", 10.0)
        ready, why = ping_answer(status, body, error)
        self.state = ready
        self.note = "" if ready else why
        return ready

    def alive(self) -> bool:
        if self.state is None:
            self.ping()
        return bool(self.state)

    def shoot(self, ident: str, number: int) -> tuple[dict | None, str]:
        """One page, photographed. -> (the page for the PDF, or why not).

        Two checks stand between a picture and the book. The picture must be
        the size of the box the shooter says it measured — a capture that is
        not its page's size is a capture of something else, and it is failed,
        not shipped. And it must not be an empty sheet: an empty sheet is not a
        page, and "the only picture of that page" is not a reason to put a
        blank leaf in a book. Either way the page is reported failed and the
        book's record names it.
        """
        if not self.base:
            return None, self.note or "no browser service configured"
        status, body, error, heads = shot_get_headed(
            shot_request(self.base, ident, number, self.scale), self.timeout)
        if error:
            return None, f"page {number}: the browser did not answer — {error}"
        if status != 200:
            return None, f"page {number}: the browser refused — {refusal_reason(body, status)}"
        page = scan_for_pdf(body)
        if page is None:
            return None, (f"page {number}: the browser sent "
                          f"{describe_image(body)}, not a page")
        page = dict(page)
        page["bytes"] = len(body)
        # the box the shooter measured, in the page's own units: the picture's
        # pixel count must be that box at the scale it was taken at, or the
        # picture is not of this page
        box = (heads.get("x-shot-box") or "").lower().split("x")
        if len(box) == 2 and box[0].strip().isdigit() and box[1].strip().isdigit():
            # in the page's own units, so a rounding of half a pixel at 2x is
            # not a disagreement: 283 pixels at 2x IS a 142-pixel page
            want = (int(box[0]), int(box[1]))
            got = (round(page["width"] / self.scale),
                   round(page["height"] / self.scale))
            if abs(got[0] - want[0]) > 1 or abs(got[1] - want[1]) > 1:
                return None, (f"page {number}: the capture came back "
                              f"{page['width']}x{page['height']} pixels, a "
                              f"{got[0]}x{got[1]} page at {self.scale:g}x, against "
                              f"the measured page box {want[0]}x{want[1]} — a "
                              f"picture that is not the page's own size is "
                              f"failed, not shipped")
        if looks_blank_shot(len(body), page["height"]):
            sheet = (max(1, round(page["width"] / self.scale)),
                     max(1, round(page["height"] / self.scale)))
            return None, (f"page {number}: the sheet came back empty "
                          f"({sheet[0]}x{sheet[1]} in "
                          f"{size_text(len(body))}) — failed, and named: an "
                          f"empty sheet is not a page")
        # a screenshot's pixel count says how finely the page was drawn, not how
        # big the page is: at 2x it is the same page at twice the detail, so the
        # size goes back to the screen's and the sharpness stays in the pixels
        page["width"] = max(1, round(page["width"] / self.scale))
        page["height"] = max(1, round(page["height"] / self.scale))
        page["blank"] = False
        page["shot"] = True
        page["phase"] = "shot"
        page["url"] = f"browser {self.base} · page {number}"
        page["label"] = (f"{page['width']}x{page['height']} photographed"
                         + (f" at {self.scale:g}x" if self.scale != 1 else ""))
        return page, ""

    def capture(self, ident: str, pages, jobs: int = 4,
                alive=None, progress=None) -> tuple[dict[int, dict], list[str]]:
        """Photograph a list of pages. -> (page -> picture, what went wrong).

        `progress(done, ok, total)` is called as each page lands. Twenty pages
        one at a time is minutes of silence, and a panel that prints nothing for
        minutes looks dead — which is what makes a run get killed and started
        again, and what made a book sit at `page 0/20 · 0 ok · 159.7s`.
        """
        asked = sorted({int(number) for number in pages if number})
        wanted = asked[:MAX_SHOT_PAGES]
        if not wanted:
            return {}, []
        notes: list[str] = []
        if len(asked) > len(wanted):
            # a cap that quietly drops pages is how a document ends up short
            notes.append(
                f"{len(asked)} page(s) need a browser and one window each "
                f"{MAX_SHOT_PAGES} — pages {wanted[-1] + 1} to {asked[-1]} will be "
                f"left out of the PDF and named; run again for those")
        if not self.alive():
            return {}, [self.note or "no browser to ask"]
        pictures: dict[int, dict] = {}
        workers = max(1, min(int(jobs or 4), MAX_SHOT_JOBS, len(wanted)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(self.shoot, ident, number): number
                       for number in wanted}
            for future in as_completed(futures):
                if alive is not None and not alive():
                    for pending in futures:
                        pending.cancel()
                    notes.append("stopped — the job was closed")
                    break
                number = futures[future]
                try:
                    page, note = future.result()
                except Exception as exc:        # noqa: BLE001
                    page, note = None, (f"page {number}: the browser failed — "
                                        f"{exc!r}"[:200])
                if page:
                    pictures[number] = page
                    if note:
                        notes.append(note)     # kept, and worth saying so
                elif note:
                    notes.append(note)
                if progress is not None:
                    try:
                        progress(len(pictures) + len(notes), len(pictures),
                                 len(wanted))
                    except Exception:          # noqa: BLE001
                        pass                   # a progress line is never a failure
        return pictures, notes
