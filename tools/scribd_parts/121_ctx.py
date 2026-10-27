
class Ctx:
    """Everything one document needs: session, names, token, gate, cache."""

    def __init__(self, url: str, jobs: int = 12) -> None:
        self.url = url
        self.jobs = max(1, min(jobs, 32))
        self.ident = doc_id_of(url)
        self.cookie_path = find_cookies()
        self.jar = scribd_only(self.cookie_path)
        self.document_url = f"https://www.scribd.com/document/{self.ident}"
        self.embed_url = f"https://www.scribd.com/embeds/{self.ident}/content"
        self.sources = Sources()
        self.token = Token()
        self.lock_window = (1, 0)      # unknown until the token is read
        self.gate = Gate()
        self.dead: set[str] = set()
        self.notes: list[str] = []
        self.notes_lock = threading.Lock()
        self.trace: dict[int, list[str]] = {}
        self.tried: dict[int, set[str]] = {}
        # the viewer's own pages, kept once: they are the words of the whole
        # document in one answer, and every later lookup reads them from here
        self.embed_body = b""
        self.embed_texts: dict[int, str] = {}
        self.embed_state = ""        # "", "N page(s) of words", or why not
        self.embed_walked = False    # the windows were walked once, not again
        self.embed_lock = threading.Lock()
        self.rejected: dict[str, int] = {}
        self.trace_lock = threading.Lock()
        self.cache_dir = ""
        self.debug_dir = ""
        self.gen = 0                 # 0 = a job that was not started from the panel
        self.total = 0
        self.title = ""
        self.author = ""
        # the throttle breaker, shared by every worker thread
        self.refuse_lock = threading.Lock()
        self.refused_pages: set[int] = set()
        self.arrived = 0             # pages that actually came back, ever
        self.rested = 0.0            # seconds this document has spent resting
        self.t0 = time.time()        # this document's own clock, for the drop
        # REST_BUDGET, unless a browser is waiting to photograph what is left:
        # then resting a minute for pages that may never arrive is a minute the
        # reader waits for a page that could already be in the PDF
        self.rest_budget = REST_BUDGET
        self.said_no_hope = False
        self.skip_now = False          # the queue is waiting: yield to it
        self.rest_until = 0.0
        self.rests = 0
        self.reliefs = 0

    # -- the throttle breaker ------------------------------------------------
    def rest(self) -> None:
        """Wait out a rest the breaker called, if there is one."""
        wait = self.rest_until - time.time()
        if wait > 0:
            time.sleep(min(wait, 30.0))

    def refused(self, number: int) -> bool:
        """One more 403 on this page. True means "throttled: rest, then again".

        The discriminator is *which* page keeps being refused. One page refused
        over and over while the rest arrive is a locked page — retrying it is
        pointless and resting for it wastes minutes. Different pages refused in
        a row, with nothing succeeding between them, is the address being
        throttled, and resting is the only thing that helps.
        """
        with self.refuse_lock:
            if time.time() < self.rest_until:
                return True                # already resting: do not climb the ladder
            if number in self.refused_pages:
                return False               # the same page again: it is not ours
            self.refused_pages.add(number)
            proved = (len(self.refused_pages) >= REFUSALS_IN_A_ROW
                      or self.rests > 0)
            if (self.arrived == 0 and proved and QUEUE_DROP_AFTER > 0
                    and self.age() >= QUEUE_DROP_AFTER):
                # past the drop line with nothing but refusals to show for it
                self._queue_drop()
                if self.skip_now:
                    return False       # no rest, no retry, no second pass
            if len(self.refused_pages) < REFUSALS_IN_A_ROW:
                return False
            if self.arrived == 0 and self.rests >= NO_HOPE_RESTS:
                # Two rests and not one page has ever arrived in this document.
                # That is not a throttle — a throttle stops a job that was
                # working — and resting again only makes the reader wait for
                # the same refusal. Say it once and let the pages fail.
                if not self.said_no_hope:
                    self.said_no_hope = True
                    JOB.say("nothing in this document has arrived and resting "
                            "has not changed that — treating these 403s as "
                            "'not this account', not as throttling")
                self._queue_drop()
                return False
            pause = PAUSE_LADDER[min(self.rests, len(PAUSE_LADDER) - 1)]
            if self.rested + pause > self.rest_budget:
                # the whole document has already spent its resting budget on
                # refusals that did not clear: more waiting is just more waiting
                if not self.said_no_hope:
                    self.said_no_hope = True
                    JOB.say(f"rested {self.rested:.0f}s of "
                            f"{self.rest_budget:.0f}s already and the refusals "
                            f"did not clear — not resting again, the missing "
                            f"pages will be reported")
                self._queue_drop()
                return False
            self.rested += pause
            self.rests += 1
            self.rest_until = time.time() + pause
            self.refused_pages.clear()     # after a rest they get a fair second look
            self.dead.clear()              # a name refused while throttled is not dead
            self.gate.rate = max(self.gate.floor, self.gate.rate * 0.75)
        JOB.say(f"refused {REFUSALS_IN_A_ROW} times with nothing succeeding — "
                f"resting {pause:.0f}s and slowing down (that is throttling, "
                f"not a locked page)")
        return True

    def age(self) -> float:
        """Seconds since this document started, rests and retries included."""
        return time.time() - self.t0

    def _queue_drop(self) -> None:
        """Drop this document and let the queue through.

        A book that answers nothing but refusals for twenty seconds is not a
        throttle that will clear — it is a book this address will not be
        served. While other documents wait, fighting it further buys nothing
        and costs every book behind it, so it drops itself: what arrived is
        written, the missing pages are left out and named for what they are,
        queue moves on. There is no second pass — a document that refused
        everything for twenty seconds refuses everything a second time, and
        the reader should not wait twice for the same answer.

        With no queue behind it, nothing is dropped: a lone document fights to
        the end, retries, words and a browser included, because there is
        nothing to yield to.
        """
        if self.skip_now or QUEUE_DROP_AFTER <= 0 or JOB.waiting() <= 0:
            return       # nothing to yield to, or the impatience is switched off
        self.skip_now = True
        JOB.say(f"dropping this document: {self.age():.0f}s of refusals with "
                f"nothing arrived and {JOB.waiting()} document(s) waiting — "
                f"writing what arrived and moving on (not retried: it will "
                f"refuse the same way again)")

    def answered(self) -> None:
        """A page arrived: start counting refusals again from zero.

        After a run of good answers the pause ladder steps back down, so one
        throttle early in a big document does not make every later pause long.
        """
        with self.refuse_lock:
            self.refused_pages.clear()
            self.arrived += 1
            self.reliefs += 1
            if self.rests and self.reliefs >= 8 and time.time() >= self.rest_until:
                self.rests = max(0, self.rests - 1)
                self.reliefs = 0

    def note(self, text: str) -> None:
        with self.notes_lock:
            if text not in self.notes:
                self.notes.append(text)

    def record(self, number: int, url: str, status: int) -> None:
        with self.trace_lock:
            self.trace.setdefault(number, []).append(f"{status:>3}  {url}")
            self.tried.setdefault(number, set()).add(url)

    def keep_reject(self, number: int, data: bytes) -> None:
        """Keep the picture that was refused, so the reason can be checked.

        A rejection nobody can look at is a rumour. The bytes land in
        debug/rejected/ (capped, so a broken document cannot fill the disk) and
        the log says so once.
        """
        if not number or not data:
            return
        folder = os.path.join(JOB.out or OUT, "debug", "rejected")
        try:
            os.makedirs(folder, exist_ok=True)
            if len(os.listdir(folder)) >= 40:
                return
            with open(os.path.join(folder, f"page-{number:04d}.bin"), "wb") as handle:
                handle.write(data)
            self.note(f"page {number}: the refused picture is saved in "
                      "debug/rejected — the log line above says what it was")
        except OSError:
            pass

    def reject(self, data: bytes) -> str:
        """Remember the KIND of file that arrived but could not be read."""
        if data[:2] == b"\xff\xd8":
            kind = "jpeg"
        elif data[:8] == b"\x89PNG\r\n\x1a\n":
            kind = "png"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            kind = "webp"
        else:
            kind = (data[:8].decode("latin-1", "replace").strip() or "empty")[:12]
        with self.trace_lock:
            self.rejected[kind] = self.rejected.get(kind, 0) + 1
        return kind

    def gives_words(self) -> bool:
        """Does this document have words worth one request per page?

        This never decides how a page is BUILT: every page of every document is
        photographed. It decides only whether the document's own words are worth
        asking for, page by page, to lay underneath the photographs — because a
        scanned page has none, and hundreds of refused descriptor requests would
        trip the throttle breaker and rest the job for nothing. One request
        answers it: the second page's descriptor.
        """
        words = self.page_text(2)
        return len(words.strip()) > 120

    def load(self) -> bool:
        doc = fetch(self.document_url, self.jar)
        if doc["error"]:
            JOB.say(f"document page: {doc['error']}")
            return False
        JOB.say(f"document page: HTTP {doc['status']}, "
                f"{len(doc['body']) / 1000:.0f} kB, {describe(doc['body'])}")
        embed = fetch(self.embed_url + "?start_page=1&view_mode=scroll", self.jar,
                      referer=self.document_url)
        if embed["error"]:
            JOB.say(f"embed viewer: {embed['error'][:120]} — using the document page")
            embed = {"status": 0, "body": b""}
        else:
            JOB.say(f"embed viewer: HTTP {embed['status']}, "
                    f"{len(embed['body']) / 1000:.0f} kB, {describe(embed['body'])}")

        combined = embed["body"] + doc["body"]
        self.embed_body = embed["body"]
        self.sources.merge(combined)
        found = harvest_token(combined, where="document or viewer page")
        self.token.set(found)
        self.total = page_count(combined, self.sources)
        if not self.total:
            return False
        JOB.say(f"pages: {self.total} found · {self.sources.count()} with a page name")
        if not self.token.get():
            # no token on the page at all: try the viewer's other entry points
            for probe in (f"https://www.scribd.com/embeds/{self.ident}/content"
                          f"?start_page=1&view_mode=scroll&access_key=&"
                          f"only_page=1",
                          f"https://www.scribd.com/document/{self.ident}/"
                          f"__next_data__"):
                extra = fetch(probe, self.jar, referer=self.document_url, timeout=20)
                if extra.get("status") == 200 and extra.get("body"):
                    late = harvest_token(extra["body"], where=probe.split("/")[3])
                    if late:
                        self.token.set(late)
                        break
        JOB.say(token_note(self.token.get()))
        self.lock_window = unlocked_range(jwt_claims(self.token.get()),
                                          self.total)
        if self.lock_window != (1, self.total):
            JOB.say(f"preview lock: the document's own token says the CDN "
                    f"serves pages {self.lock_window[0]}–{self.lock_window[1]} "
                    f"of {self.total} — the rest are locked by Scribd, and will "
                    f"be photographed or left out of the PDF and named, never "
                    f"asked for")

        meta = oembed(self.ident, self.jar)
        self.author = safe_name(str(meta.get("author_name") or ""), "")
        self.title = (safe_name(str(meta.get("title") or ""), "")
                      or title_from_html(combined, self.url)
                      or f"scribd-{self.ident}")
        JOB.title = self.title
        JOB.say(f"title: {self.title!r}"
                + (f" · author: {self.author}" if self.author else ""))
        return True

    def locked_pages(self, limit: int) -> set[int]:
        """Pages the token says the CDN will refuse: not worth one request."""
        low, high = self.lock_window
        if high <= 0 or (low, high) == (1, limit):
            return set()
        return {n for n in range(1, limit + 1) if n < low or n > high}

    def jsonp_variants(self, jsonp: str) -> list[str]:
        return jsonp_variants_of(jsonp, self.token.get())

    def assets_in(self, body: bytes, number: int, token: str) -> list[str]:
        """Every image name in a body that belongs to this page number."""
        out: list[str] = []
        for match in ASSET_RE.finditer(text_of(body)):
            url = match.group(0)
            if f"/{number}-" not in url or not SCAN_RE.search(url):
                continue
            out.append(with_token(url, token))
            out.append(strip_token(url))
            derived = image_url_for(url)
            if derived:
                out.append(derived)
        return list(dict.fromkeys(out))

    def viewer_pages(self) -> dict[int, str]:
        """Every page's words from the viewer's own scroll page.

        This is what a browser reads. For a converted document it is the only
        place the words exist — no descriptor, no scan — and it is normally one
        request for the whole book. A viewer that hands out its pages in
        windows is walked (`?start_page=<next>`), but only a few times: past
        that, the honest answer is "the viewer did not give it", not silence.
        """
        with self.embed_lock:
            if self.embed_walked:
                return dict(self.embed_texts)
            self.embed_walked = True
            pages: dict[int, str] = {}
            start_page = 1
            windows = 0
            while windows < VIEWER_WINDOWS:
                if windows == 0 and self.embed_body:
                    body = self.embed_body
                else:
                    url = (f"{self.embed_url}?start_page={start_page}"
                           f"&view_mode=scroll")
                    got = fetch(url, self.jar, referer=self.document_url,
                                timeout=30)
                    if got["error"] or got["status"] != 200 or not got["body"]:
                        self.note("viewer page: start_page=%d -> %s"
                                  % (start_page, (got["error"]
                                                  or http_reason(got))[:90]))
                        break
                    body = got["body"]
                    if not self.embed_body:
                        self.embed_body = body
                self.sources.merge(body)          # its names are names too
                fresh_token = harvest_token(body)
                if fresh_token:
                    self.token.set(fresh_token)
                found = embed_text_pages(body)
                windows += 1
                new_pages = {number: words for number, words in found.items()
                             if number not in pages}
                pages.update(new_pages)
                if not found or not new_pages:
                    break                    # the same window again: stop
                if self.total and len(pages) >= self.total:
                    break
                start_page = max(found) + 1
            self.embed_texts = pages
            if pages:
                self.embed_state = f"{len(pages)} page(s) of words"
            else:
                self.embed_state = "no page blocks in the viewer page"
                self.note("viewer page: " + self.embed_state)
                self.save_viewer_page()
            return dict(pages)

    def save_viewer_page(self) -> str:
        """Keep the raw viewer page when it gave no words.

        Guessing at markup that was never seen is what turned this into three
        rounds of "not working". The page is public content and holds no
        cookie, so the file can be sent as-is and the parser written against
        what is really there.
        """
        if not self.debug_dir or not self.embed_body:
            return ""
        target = os.path.join(self.debug_dir, f"viewer-{self.ident}.html")
        try:
            os.makedirs(self.debug_dir, exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(self.embed_body[:2_000_000])
        except OSError:
            return ""
        return target

    def save_shot_note(self, note: str) -> str:
        """Keep the browser service's own report of a refused photograph.

        The note says what the browser was looking at when nothing on the screen
        was a page: the title, the url it ended on, the size of the window, how
        many elements were there, whether a viewer sat inside an iframe, how many
        things were pinned over the window, the biggest boxes and the rule that
        threw each one away, and the words the page itself printed. That is the
        difference between guessing at the next fix and knowing it.
        """
        if not self.debug_dir or not str(note or "").strip():
            return ""
        target = os.path.join(self.debug_dir, f"shots-{self.ident}.txt")
        try:
            os.makedirs(self.debug_dir, exist_ok=True)
            with open(target, "w", encoding="utf-8", errors="replace") as handle:
                handle.write(str(note).strip() + "\n")
        except OSError:
            return ""
        return target

    def page_text(self, number: int) -> str:
        """This page's words: its descriptor first, then the viewer's page.

        A converted document often serves no descriptor at all; the words still
        exist, in the page a browser reads (`viewer_pages()`, one request for
        the whole book). Both are tried before a page is called blank, because
        that is the difference between a book and 37 empty sheets.
        """
        if self.cache_dir:
            cached = os.path.join(self.cache_dir, f"{number:04d}.text")
            if os.path.isfile(cached):
                try:
                    with open(cached, encoding="utf-8", errors="replace") as handle:
                        kept = handle.read()
                    if kept.startswith(WORDS_CACHE_TAG + "\n"):
                        return kept[len(WORDS_CACHE_TAG) + 1:]
                except OSError:
                    pass
        words = self.descriptor_text(number)
        if not words.strip():
            words = self.viewer_pages().get(number, "")
        self.remember_text(number, words)
        return words

    def remember_text(self, number: int, words: str) -> None:
        """Keep one page's words in this document's cache, so a re-run reads
        no network.

        The words now carry each line's vertical place, so a cache written by
        an older version would draw the old paragraph again. The marker makes
        that file stale instead of trusted.
        """
        if not self.cache_dir or not (words or "").strip():
            return
        try:
            with open(os.path.join(self.cache_dir, f"{number:04d}.text"),
                      "w", encoding="utf-8") as handle:
                handle.write(WORDS_CACHE_TAG + "\n" + words)
        except OSError:
            pass

    def descriptor_text(self, number: int) -> str:
        """This page's words out of its own descriptor, if one is served."""
        token = self.token.get()
        names = list(self.sources.jsonps_for(number))
        if not names:                       # pictures named, descriptors not
            names = [jsonp for jsonp in
                     (jsonp_from_image(url) for url in self.sources.images_for(number))
                     if jsonp]
        # nothing names this page? build its address from a page that is named.
        # This is what a converted document needs: it names one asset, page 1's
        # picture, and its 37 other pages are words behind a name nobody printed.
        # Only then, though: a borrowed name carries another page's content
        # hash, so on a page that IS named it is four requests that can only
        # answer 403 — and 403s are exactly what gets an address throttled.
        if not names:
            for pattern in self.sources.asset_patterns()[:4]:
                borrowed = jsonp_for_page(pattern, number)
                if borrowed and borrowed not in names:
                    names.append(borrowed)
        names = names[:6]
        for jsonp in names:
            for variant in jsonp_variants_of(jsonp, token):
                if not variant:
                    continue
                self.rest()
                self.gate.acquire()
                got = fetch(variant, self.jar, referer=self.document_url, timeout=20)
                if got["status"] != 200 or not got["body"]:
                    continue
                self.answered()
                words = text_from_jsonp(got["body"])
                if words.strip():
                    return words
        return ""
