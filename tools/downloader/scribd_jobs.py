"""Scribd panel — the job engine and page-source extraction.

Loaded from tools/downloader/ by scribd_download.py after scribd_pages.py. Job/Gate/Sources/Ctx,
HTML-to-text helpers, run_job, run_queue, _batch and _probe live here.
Annotations are compiled with PEP 563 by the loader.
"""

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

JOB = Job()

class Gate:
    """A shared token bucket that tells the two kinds of refusal apart.

    A 429/503 is the CDN throttling: pay 30% of the rate. A 403 is a key that
    will 403 however slowly it is asked for, so it only costs 3%.
    """

    def __init__(self, rate: float = 24.0, floor: float = 8.0,
                 ceiling: float = 60.0) -> None:
        self.lock = threading.Lock()
        self.rate = rate
        self.floor = floor
        self.ceiling = ceiling
        self.tokens = 10.0
        self.stamp = time.time()
        self.clean = 0

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.time()
                self.tokens = min(16.0, self.tokens + (now - self.stamp) * self.rate)
                self.stamp = now
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return
                wait = (1.0 - self.tokens) / self.rate
            time.sleep(min(wait, 0.2))

    def clean_answer(self) -> None:
        with self.lock:
            self.clean += 1
            if self.clean >= 4:
                self.clean = 0
                self.rate = min(self.ceiling, self.rate * 1.03)

    def complaint(self, status: int) -> None:
        with self.lock:
            if status in HARD_THROTTLE:
                self.clean = 0
                self.rate = max(self.floor, self.rate * 0.70)
            else:
                self.rate = max(self.floor, self.rate * 0.97)

class Sources:
    """page number -> the names seen for it, in the order seen.

    A list, not one name: the document's own name stays first (so good pages
    still cost one request) and a descriptor's name is appended behind it, so a
    stale name can never evict a working one.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.images: dict[int, list[str]] = {}
        self.jsonps: dict[int, list[str]] = {}
        self.folders: set[str] = set()

    @staticmethod
    def _add(table: dict[int, list[str]], number: int, url: str) -> bool:
        url = full_url(url)
        if not url:
            return False
        bucket = table.setdefault(number, [])
        if url in bucket:
            return False
        bucket.append(url)
        return True

    def merge(self, body: bytes) -> int:
        text = text_of(body)
        changed = 0
        with self.lock:
            for match in JSONP_RE.finditer(text):
                if self._add(self.jsonps, int(match.group(1)), match.group(0)):
                    changed += 1
            for match in IMAGE_RE.finditer(text):
                if self._add(self.images, int(match.group(1)), match.group(0)):
                    changed += 1
        return changed

    def get(self, number: int) -> dict[str, str]:
        with self.lock:
            images = self.images.get(number) or []
            jsonps = self.jsonps.get(number) or []
            return {"image": images[0] if images else "",
                    "jsonp": jsonps[0] if jsonps else ""}

    def images_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.images.get(number) or [])

    def asset_patterns(self) -> list[str]:
        """One asset name of every shape this document writes, any page."""
        with self.lock:
            seen: set[str] = set()
            out: list[str] = []
            for urls in list(self.images.values()) + list(self.jsonps.values()):
                for url in urls:
                    shape = re.sub(r"/\d+-[0-9A-Za-z]+\.", "/#.", url.split("?")[0])
                    if shape not in seen:
                        seen.add(shape)
                        out.append(url)
            return out

    def jsonps_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.jsonps.get(number) or [])

    def count(self) -> int:
        with self.lock:
            return len(set(self.images) | set(self.jsonps))

    def highest(self) -> int:
        with self.lock:
            both = set(self.images) | set(self.jsonps)
            return max(both) if both else 0

TEXT_OF_JSONP_RE = re.compile(r"^\s*(?:window\.)?[A-Za-z0-9_$.]*call?back?\s*\(|"
                              r"^\s*[A-Za-z0-9_$.]+\s*\(", re.I)
BREAK_TAG_RE = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr)\s*/?\s*>", re.I)
TAG_STRIP_RE = re.compile(r"<[^>]*>")
SPACE_RE = re.compile(r"[ \t\u00a0]+")


def html_to_text(html: str, collapse: bool = True) -> str:
    """The words of one page out of Scribd's own HTML, line by line.

    Scribd sends each page's text as HTML with <br> and block tags, so breaks
    have to become newlines before the tags are stripped; otherwise the whole
    page becomes one long line and a text layer is useless for selection.
    """
    text = BREAK_TAG_RE.sub("\n", html or "")
    text = TAG_STRIP_RE.sub("", text)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "),
                 ("&mdash;", "-"), ("&ndash;", "-"), ("&rsquo;", "'"),
                 ("&lsquo;", "'"), ("&ldquo;", '"'), ("&rdquo;", '"')):
        text = text.replace(a, b)
    # blank lines carry no words and only eat the little room a sheet has,
    # so they are dropped: one line of text per line of the page
    # `collapse=False` keeps runs of spaces, which is how a text layer with no
    # CSS placement says where its lines end
    lines = [(SPACE_RE.sub(" ", line) if collapse else line).strip()
             for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------------------
# lines: the shape a browser actually lays out
# ---------------------------------------------------------------------------
# Scribd's page HTML is not a paragraph. Each line is its own element, placed
# with inline CSS (`<span style="left:12%;top:34%">…`), and the tags carry the
# only clue that a new line starts at all: strip them and the page becomes one
# long run — a contents page turned into a paragraph in the corner of the
# sheet. So the positioned elements are read for their vertical place, and the
# page keeps its lines and their spacing.
LINE_MARK = "\x01"           # "the line after this mark has a vertical place"
WORDS_CACHE_TAG = "#words-v2"   # a cached page written with line placement
STYLE_TAG_RE = re.compile(r"<(span|div|p|li|td|a|h[1-6])\b([^>]*)>", re.IGNORECASE)
STYLE_ATTR_RE = re.compile(r"""style\s*=\s*["']([^"']*)["']""", re.IGNORECASE)
TOP_RE = re.compile(r"top\s*:\s*(-?[\d.]+)\s*(px|pt|em|%|in)?", re.IGNORECASE)


def positioned_lines(html: str) -> list[tuple[str, float]]:
    """The page's lines in reading order, each with the vertical place it had.

    Returns [] when the markup carries no placement at all, which is the
    honest answer for plain paragraphs: then the words flow instead.
    """
    marks: list[tuple[int, float]] = []
    for match in STYLE_TAG_RE.finditer(html or ""):
        style = STYLE_ATTR_RE.search(match.group(2) or "")
        if not style:
            continue
        found = TOP_RE.search(style.group(1))
        if not found:
            continue
        try:
            marks.append((match.end(), float(found.group(1))))
        except ValueError:
            continue
    if len(marks) < 2:
        return []
    out: list[tuple[str, float]] = []
    for index, (start, top) in enumerate(marks):
        end = marks[index + 1][0] if index + 1 < len(marks) else len(html)
        words = html_to_text(html[start:end])
        if not words.strip():
            continue
        # an outer and an inner element can name the same line: keep one
        if out and words.strip() == out[-1][0].strip():
            continue
        out.append((words, top))
    # two columns on one row are two spans at the same height: join them into
    # the row they belong to instead of writing them one under the other
    rows: list[tuple[str, float]] = []
    for text, top in out:
        if rows and abs(top - rows[-1][1]) <= max(0.4, abs(top) * 0.01):
            rows[-1] = (rows[-1][0] + "   " + text, rows[-1][1])
        else:
            rows.append((text, top))
    return rows


def encode_page_lines(lines: list[tuple[str, float | None]]) -> str:
    """A page's words, with the vertical place of each line when it has one."""
    tops = [top for _text, top in lines if top is not None]
    low, high = (min(tops), max(tops)) if tops else (0.0, 0.0)
    out: list[str] = []
    for text, top in lines:
        if top is None or high <= low:
            out.append(text)
            continue
        out.append("%s%.4f|%s" % (LINE_MARK, (top - low) / (high - low), text))
    return "\n".join(out)


def decode_page_lines(words: str) -> tuple[list[str], list[float] | None]:
    """Read back what encode_page_lines wrote: (lines, places or None)."""
    lines: list[str] = []
    places: list[float] = []
    placed = False
    for raw in (words or "").split("\n"):
        if raw.startswith(LINE_MARK) and "|" in raw:
            head, _, text = raw[len(LINE_MARK):].partition("|")
            try:
                places.append(float(head))
                placed = True
                lines.append(text)
                continue
            except ValueError:
                pass
        places.append(0.0)
        lines.append(raw)
    return lines, (places if placed else None)


def words_plain(words: str) -> str:
    """The page's words without the placement marks, for counting and display."""
    lines, _places = decode_page_lines(words)
    return "\n".join(lines)


def lines_from_html(html: str, chrome: bool = True) -> str:
    """One page's words, line by line, out of its markup.

    Placed elements give the lines and their spacing. Failing that, block tags
    give the lines. Failing that too (one flat run), runs of wide space are
    treated as line ends — a text layer positioned with spaces rather than CSS
    is otherwise a single unreadable line.
    """
    placed = positioned_lines(html)
    if placed:
        kept = []
        for text, top in placed:
            text = (tidy_page_text(text, keep_spacing=True) if chrome
                    else html_to_text(text))
            if text.strip():
                kept.append((text, top))
        if len(kept) >= 2:
            return encode_page_lines(kept)
    loose = html_to_text(html, collapse=False)
    if "\n" not in loose and len(re.findall(r"[ \t\u00a0]{3,}", loose)) >= 2:
        parts = [part.strip() for part in re.split(r"[ \t\u00a0]{3,}", loose)]
        parts = [part for part in parts if part]
        if len(parts) >= 3:
            cleaned = [tidy_page_text(part) if chrome else html_to_text(part)
                       for part in parts]
            return "\n".join(line for line in cleaned if line)
    return tidy_page_text(html_to_text(html)) if chrome else html_to_text(html)


def text_from_jsonp(body: bytes) -> str:
    """A page's text out of its descriptor: window.pageN_callback([…, "…"])."""
    raw = text_of(body)
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        return ""
    try:
        parts = json.loads(raw[start:end + 1])
    except ValueError:
        return ""
    if not isinstance(parts, list):
        return ""
    html = "".join(part for part in parts if isinstance(part, str))
    return lines_from_html(html, chrome=False)


# ---------------------------------------------------------------------------
# the embed viewer's own pages — where the words are when no descriptor is
# ---------------------------------------------------------------------------
# This is the piece v2.17 did not have. A converted document (a Word file, a
# typed book) has no scan for most of its pages, and its `.jsonp` descriptor is
# sometimes not served either: the only place the words exist is the page a
# browser reads, `/embeds/<id>/content?start_page=1&view_mode=scroll`, where
# every page is an HTML block with its text already in it.
# A browser reads that page anonymously for public documents, which is why the
# document looks complete on Scribd and used to come out blank here.
PAGE_ANCHOR_RE = re.compile(
    r'id="(?:outer_)?page[-_]?(\d+)"'
    r'|data-page-number="(\d+)"'
    r'|data-page="(\d+)"'
    r'|id="page-(\d+)"', re.IGNORECASE)
SCRIPT_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>",
                             re.IGNORECASE | re.DOTALL)
# The viewer wraps every page in furniture: an ad, "Share this document", the
# cookie notice, the sign-up banner. Those lines are not the book and must not
# be drawn onto a sheet as if they were.
BOILERPLATE = (
    "download to read ad-free", "opens in a new window", "opening in a new window",
    "opens an external website", "you are on page", "share this document",
    "copy link", "share on facebook", "share on linkedin", "share with email",
    "sign in", "sign up", "log in", "free trial", "privacy policy",
    "your privacy choices", "close this consent banner", "skip to main content",
    "open navigation menu", "close suggestions", "change language",
    "found this document useful", "uploaded by", "millions of documents",
    "ad-free", "scribd.com/oauth", "follow this publisher", "related documents",
    "report this document", "about scribd", "cookie", "advertisement",
)
BOILERPLATE_JUNK = {"ad", "ads", "advert", "scribd", "download", "menu",
                    "search", "searchsearch", "share", "save", "print"}


def is_boilerplate(line: str) -> bool:
    """Is this line the viewer's furniture rather than the document?"""
    plain = line.strip().lower()
    if not plain:
        return False
    if plain in BOILERPLATE_JUNK:
        return True
    if plain.isdigit() and len(plain) <= 4:      # a page number in the chrome
        return True
    return any(marker in plain for marker in BOILERPLATE)


def tidy_page_text(words: str, keep_spacing: bool = False) -> str:
    """One page's words with the viewer chrome taken out, lines kept.

    `keep_spacing` leaves runs of spaces alone: a row of a contents page spaces
    its two columns with spaces, and collapsing them welds the columns together.
    """
    out: list[str] = []
    for line in (words or "").split("\n"):
        line = line.strip() if keep_spacing else " ".join(line.split())
        if line and not is_boilerplate(line):
            out.append(line)
    return "\n".join(out)


def embed_text_pages(body: bytes) -> dict[int, str]:
    """Every page's words out of the embed viewer, by page number.

    The viewer marks each page's block with its number (`id="page-3"`,
    `data-page-number="3"`, …). Slicing the page at those marks is what keeps
    page 34's words on sheet 34 instead of dumping all 38 pages onto one.
    """
    text = SCRIPT_BLOCK_RE.sub(" ", text_of(body))
    marks: list[tuple[int, int]] = []
    seen: set[int] = set()
    for match in PAGE_ANCHOR_RE.finditer(text):
        digits = next((group for group in match.groups() if group), "")
        if not digits.isdigit():
            continue
        number = int(digits)
        if number in seen or number == 0:
            continue
        seen.add(number)
        marks.append((match.start(), number))
    if not marks:
        # some viewers print no page number at all, only a text block per page
        blocks = [m.start() for m in re.finditer(r'class="[^"]*text_layer',
                                                 text, re.IGNORECASE)]
        if len(blocks) >= 3:
            marks = [(position, index + 1)
                     for index, position in enumerate(blocks)]
        else:
            return {}
    marks.sort()

    def tag_start(position: int) -> int:
        """Where the tag around this mark begins, so no half tag leaks in.

        A mark is an attribute inside `<div id="page-3" …>`. Cutting at the mark
        itself leaves `id="page-3" class="outer_page"` behind, and the tag
        stripper cannot remove a fragment that has no `<` in front of it.
        """
        opened = text.rfind("<", 0, position)
        return opened if opened >= 0 else position

    pages: dict[int, str] = {}
    for index, (start, number) in enumerate(marks):
        end = tag_start(marks[index + 1][0]) if index + 1 < len(marks) else len(text)
        words = lines_from_html(text[tag_start(start):end], chrome=True)
        if words.strip():
            pages[number] = words
    return pages


def viewer_fingerprint(body: bytes) -> str:
    """What the viewer page actually is, in one line — for `--probe`.

    When a page comes out blank, this is the line that says why: a JS-only
    shell (no text at all), text with no page numbers, or the normal case.
    """
    text = SCRIPT_BLOCK_RE.sub(" ", text_of(body))
    marks = len(PAGE_ANCHOR_RE.findall(text))
    layers = len(re.findall(r'class="[^"]*text_layer', text, re.IGNORECASE))
    words = len(html_to_text(text))
    return (f"{len(body) / 1000:.0f} kB · {marks} page mark(s) · "
            f"{layers} text block(s) · {words} chars of text")


def page_count(body: bytes, sources: Sources) -> int:
    text = text_of(body)
    for pattern in (r'"page_count"\s*:\s*(\d+)', r'"totalPages"\s*:\s*(\d+)',
                    r'"pageCount"\s*:\s*(\d+)', r'"pages_count"\s*:\s*(\d+)'):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return sources.highest()

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


def _probe(url: str, number: int) -> None:
    ctx = Ctx(url)
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = "the page named no pages"
        return
    JOB.say(f"probe: page {number} · token "
            + ("found (redacted)" if ctx.token.get() else "NONE FOUND"))
    # the viewer's own page: is the text of the whole book in it, and which
    # page numbers does it print? This one line answers "why is my page blank".
    viewer = ctx.viewer_pages()
    JOB.say(f"probe: viewer page: {ctx.embed_state or 'not read'}"
            + (f" · {viewer_fingerprint(ctx.embed_body)}" if ctx.embed_body else "")
            + (f" · pages it prints: {', '.join(str(n) for n in sorted(viewer)[:12])}"
               f"{' …' if len(viewer) > 12 else ''}" if viewer else ""))
    words = (viewer.get(number) or "").strip()
    if words:
        JOB.say(f"probe: viewer words for page {number}: {len(words)} chars")
        JOB.say("        " + redact(words, 300))
    elif viewer:
        JOB.say(f"probe: the viewer page has no words for page {number}")
    # The names the document gives are reported, and the descriptor beside an
    # image name is derived — that is where a page's WORDS are. No image is
    # fetched: a page is a photograph, and the probe says so further down.
    jsonps = list(ctx.sources.jsonps_for(number))
    for name in ctx.sources.images_for(number):
        JOB.say(f"probe: document name  {redact(name, 160)}")
        derived = jsonp_from_image(name)
        if derived and derived not in jsonps:
            jsonps.append(derived)
            JOB.say(f"probe: its descriptor {redact(derived, 160)} — derived: a "
                    "page's words sit beside its picture, under one hash")
    for jsonp in jsonps:
        JOB.say(f"probe: descriptor     {redact(jsonp, 160)}")
        for variant in ctx.jsonp_variants(jsonp):
            got = fetch(variant, ctx.jar, referer=ctx.document_url, timeout=20)
            JOB.say(f"  {got['status']:>3} {len(got['body']):>7} B  {redact(variant, 160)}"
                    + (f"   {http_reason(got)}" if got["status"] != 200 else ""))
            if got["status"] == 200 and got["body"]:
                JOB.say("        body: " + redact(got["body"][:800].decode("latin-1", "replace"), 300))
                # what the descriptor itself offers, by host and name only
                for url in ctx.assets_in(got["body"], number, ctx.token.get())[:4]:
                    JOB.say(f"        offers: {redact(url, 160)}")
    # The browser is the only thing that builds a page now, so it is the thing
    # worth probing: does one answer, and what does it make of this page?
    shooter = Shooter()
    if not shooter.alive():
        JOB.say("probe: browser " + (shooter.base or "none")
                + f" — does not answer: {shooter.note}")
    else:
        JOB.say(f"probe: browser {shooter.base} answers")
        page, note = shooter.shoot(ctx.ident, number)
        if page:
            JOB.say(f"probe: the browser's own picture of page {number}: "
                    f"{page['label']} — that is the page")
        else:
            JOB.say(f"probe: the browser has no picture of page {number}: {note}")
    with JOB.lock:
        JOB.verdict = "PROBE DONE"
        JOB.detail = f"page {number}"
