"""Scribd panel — download jobs and the screenshot shooter bridge.

Loaded by scribd_download.py after scribd_core.py. Annotations are compiled
with PEP 563 by the loader, exactly like the original single file.
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

# ---------------------------------------------------------------------------
# the browser that photographs a page nobody sent us
# ---------------------------------------------------------------------------
# A page can come back with neither a scan nor the words behind it: the viewer
# builds that page's own token at runtime, and our requests never learn it. Text
# drawing cannot invent words, so such a page is photographed instead — by a
# browser, over one small HTTP request. That browser is a service (troy-search's
# /shot); this is the client, and it is deliberately optional: with no service
# configured, or one that will not answer, the document is built exactly as
# before. A photograph is a rescue, never a requirement.
SHOTS = os.environ.get("SCRIBD_SHOTS", "").rstrip("/")
# The browser service is not deployed beside this panel: it is its own server,
# on its own host, with its own assigned endpoint. So every door it could be
# behind is written down here instead of wired by hand — tried in order, and the
# first one that answers `"ok": true` is the browser. SCRIBD_SHOTS still comes
# first when it is set, for a box that is not this box, but nothing needs setting.
#   127.0.0.1 / localhost   the same container, or the same machine. Asked first
#                           because a door with nobody behind it answers at once,
#                           and one box does run both halves together.
#   node6.botkeep.cloud:45009
#                           THE browser egg. Its own control panel names this as
#                           the endpoint assigned to it, so this — not any port
#                           of this panel's machine — is the door to knock on.
#   77.90.45.110:45009      the same door by number, for a container whose name
#                           service cannot resolve the host above.
#   195.123.189.187         this panel's own address, kept for the day the two
#                           eggs share a machine again, and asked last: a port
#                           nobody answers there costs the whole timeout.
SHOT_HOSTS = ("http://127.0.0.1:8096", "http://localhost:8096",
              "http://node6.botkeep.cloud:45009",
              "http://77.90.45.110:45009",
              "http://195.123.189.187:8096",
              "http://195.123.189.187:25811")
# The door a copy started beside this panel takes. Read off the first address
# above, so starting one can never put the browser somewhere nobody looks.
SHOT_LOCAL_PORT = int(urllib.parse.urlparse(SHOT_HOSTS[0]).port or 8096)
# A server cannot see the public port its own panel mapped to it, so if every
# written-down door is shut, this one asks the browser egg's host port by port —
# once — and remembers the answer in shooter-found.txt. The endpoint above is
# today's; a host that moves it to another port is still found, with no setting
# to touch and no second sweep ever.
SHOOTER_SCAN_RANGES = ((25000, 26000), (20000, 30000), (44000, 46000))
_scan_host = os.environ.get("SCRIBD_SHOOTER_HOST", "").strip()
# (host, the bands of its ports to ask), in the order worth asking them: the
# narrow shelf around the endpoint it has today first, because a host that hands
# out ports from one shelf is found in about a hundred questions.
SHOOTER_SCAN_HOSTS = (((_scan_host, SHOOTER_SCAN_RANGES),) if _scan_host else
                      (("node6.botkeep.cloud", ((45000, 45100), (44000, 46000))),
                       ("77.90.45.110", ((45000, 45100), (44000, 46000))),
                       ("195.123.189.187", ((25000, 26000), (20000, 30000)))))
SCAN_RETRY_AFTER = 900.0    # a sweep that found nothing is not repeated at once
SCAN_BUDGET = 120.0         # the most a sweep may take: documents are waiting
SCAN_LIE_RATIO = 4          # a host that says yes to every 4th port is lying
_SCAN_LOCK = threading.Lock()
_SCAN_TRIED: dict = {"when": 0.0}
SHOT_FOUND_FOR = 300.0      # a service that answered is trusted for this long
SHOT_RETRY_AFTER = 60.0     # one that did not is looked for again after this
_SHOT_CACHE: dict = {"base": "", "note": "", "when": 0.0}
_SHOT_LOCK = threading.Lock()
# 1x is standard quality: the page at the size the viewer draws it. 2x was the
# same page at twice the detail — four times the pixels to draw, encode, send
# and embed, for a sheet that is placed at the same size in the PDF anyway.
SHOT_SCALE = float(os.environ.get("SCRIBD_SHOT_SCALE") or 1)
SHOT_TIMEOUT = float(os.environ.get("SCRIBD_SHOT_TIMEOUT") or 120)
# Every page of every document is a photograph now, so this is no longer a cap on
# a rescue — it is a cap on a WHOLE BOOK going page by page. One pass over the
# viewer is what makes a long book fast; this bounds the slow route behind it, for
# the book whose column the pass could not cut at all. A cap below the longest book
# on the shelf is a book that comes out short — named, but short — so it sits above
# every book asked for so far (the longest is 402), and 2000 pages one at a time
# over 8 tabs is still a wait of minutes, not hours.
MAX_SHOT_PAGES = 2000
MAX_SHOT_JOBS = 8           # tabs in one browser: past this it stops helping


def set_shots(value: str) -> None:
    """Point the engine at a browser service (--shots URL, or SCRIBD_SHOTS)."""
    global SHOTS
    SHOTS = (value or "").strip().rstrip("/")
    os.environ["SCRIBD_SHOTS"] = SHOTS


def shot_request(base: str, ident: str, number: int, scale: float) -> str:
    """The one request that asks a browser for one page of one document."""
    return (f"{base.rstrip('/')}/shot?doc={ident}&page={int(number)}"
            f"&scale={scale:g}")


def shot_get_headed(url: str, timeout: float
                    ) -> tuple[int, bytes, str, dict[str, str]]:
    """shot_get, plus the answer's headers.

    The browser service states the box it measured in `X-Shot-Box`, because the
    panel checks every picture against the box it claims to be: a picture that
    is not the size of its own page is a picture of something else, and the
    shooter's word alone is not the check.
    """
    request = urllib.request.Request(url, headers={"User-Agent": UA,
                                                  "Accept": "image/png,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return (answer.status, answer.read(), "",
                    {k.lower(): v for k, v in answer.headers.items()})
    except urllib.error.HTTPError as exc:
        # an HTTP answer is an answer: the status and body carry the reason,
        # exactly as shot_get has always reported them
        return exc.code, exc.read() or b"", "", {}
    except Exception as exc:                                 # noqa: BLE001
        return 0, b"", str(exc), {}


def shot_get(url: str, timeout: float) -> tuple[int, bytes, str]:
    """A plain GET that is deliberately not `fetch()`.

    `fetch()` is for Scribd: it carries the session jar and, in local tests,
    rewrites every host onto --base. The browser service is neither of those,
    and a rewrite here would send the request to the wrong machine.
    """
    request = urllib.request.Request(url, headers={"User-Agent": UA,
                                                  "Accept": "image/png,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return answer.status, answer.read(), ""
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read(), ""
        except Exception:                       # noqa: BLE001
            return exc.code, b"", ""
    except Exception as exc:                    # noqa: BLE001
        return 0, b"", plain_error(exc)


def plain_error(exc: BaseException) -> str:
    """A connection failure in words, not in a repr.

    "URLError(ConnectionRefusedError(111, 'Connection refused'))" is what Python
    knows. What the reader needs to know is that nothing is listening there —
    because that is a service they have to start, not a bug in the document.
    """
    text = repr(exc)
    lowered = text.lower()
    if "connectionrefused" in lowered or "refused" in lowered:
        return "nothing is listening there — is the /shot service running?"
    if "timed out" in lowered or "timeout" in lowered:
        return "it did not answer in time (a page can take a while to draw)"
    if "gaierror" in lowered or "name or service not known" in lowered:
        return "that host does not resolve — check the address"
    if "connectionreset" in lowered or "brokenpipe" in lowered:
        return "the connection was dropped mid-answer"
    if "ssl" in lowered or "certificate" in lowered:
        return "the TLS handshake failed — is it http:// and not https://?"
    if "unreachable" in lowered:
        return "that network is unreachable from here"
    return text[:160]


def ping_answer(status: int, body: bytes, error: str) -> tuple[bool, str]:
    """What a /shot/ping answer means: (is a browser ready, and in what words).

    Read, not sniffed: a service with no browser in it still answers 200 and
    still says "ok" — with false after it. Believing that sends every missing
    page somewhere that cannot help, and the document ends up with the same
    placeholders, only slower.
    """
    if error:
        return False, error
    answer = None
    if body:
        try:
            answer = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            answer = None
    if not isinstance(answer, dict):
        return False, (f"answered {status} with something that is not json"
                       if status == 200 else f"answered {status}")
    if answer.get("ok"):
        version = str(answer.get("version") or "").strip()
        return True, (f"troy-search {version}" if version else "ready")
    browser = answer.get("browser")
    why = (str(browser.get("note") or "").strip()
           if isinstance(browser, dict) else "")
    why = why or str(answer.get("error") or "").strip()
    return False, (why[:200] or f"answered {status} and said it is not ready")


def shooter_cache_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "shooter-found.txt")


def read_shooter_cache() -> str:
    try:
        with open(shooter_cache_path()) as handle:
            text = handle.read().strip()
    except Exception:                                   # noqa: BLE001
        return ""
    return text if text.startswith("http") else ""


def write_shooter_cache(base: str) -> None:
    try:
        with open(shooter_cache_path(), "w") as handle:
            handle.write(base + "\n")
    except Exception:                                   # noqa: BLE001
        pass


def ping_ok(base: str, timeout: float = 1.5) -> bool:
    """One cheap question: is a browser service actually home at this address?"""
    status, body, error = shot_get(base.rstrip("/") + "/shot/ping", timeout)
    if error or status != 200:
        return False
    try:
        return bool(json.loads(body).get("ok"))
    except Exception:                                   # noqa: BLE001
        return False


def scan_for_shooter(host: str = "", announce=None) -> str:
    """Find the browser egg by asking its host's ports, once.

    The egg cannot say which port its own panel mapped to it, and nothing on
    this machine is it, so the ports are asked directly: a closed one answers at
    once, so a band of a thousand costs a couple of seconds even across a
    network. The first address that answers /shot/ping with ok:true is the
    browser, and it is written to shooter-found.txt so no later run, and no
    later restart, ever sweeps again. A sweep that finds nothing is not repeated
    for SCAN_RETRY_AFTER, so an egg that is simply stopped cannot slow down
    every document that asks for it.
    """
    say = announce or (lambda text: JOB.say(text))
    with _SCAN_LOCK:
        cached = read_shooter_cache()
        if cached and ping_ok(cached, 3.0):
            return cached
        if time.time() - _SCAN_TRIED["when"] < SCAN_RETRY_AFTER:
            return ""
        targets = (((host, SHOOTER_SCAN_RANGES),) if host
                   else SHOOTER_SCAN_HOSTS)
        found = ""
        ran_out = ""
        deadline = time.time() + SCAN_BUDGET
        for name, bands in targets:
            if time.time() >= deadline:
                ran_out = name
                break
            try:                       # a name is looked up once, not per port
                address = socket.gethostbyname(name)
            except OSError:
                say(f"cannot look up the name {name}, so its ports cannot be "
                    f"asked")
                continue
            for low, high in bands:
                if time.time() >= deadline:
                    ran_out = ran_out or name
                    break
                open_ports: list[int] = []

                def try_port(port: int, where: str = address) -> int | None:
                    sock = socket.socket()
                    sock.settimeout(0.5)   # a host across a network, not a
                    try:                   # container next door: it needs room
                        return (port if sock.connect_ex((where, port)) == 0
                                else None)
                    except Exception:                      # noqa: BLE001
                        return None
                    finally:
                        sock.close()

                with ThreadPoolExecutor(max_workers=200) as pool:
                    for port in pool.map(try_port, range(low, high + 1)):
                        if port:
                            open_ports.append(port)
                if len(open_ports) * SCAN_LIE_RATIO > high - low + 1:
                    # every door "open" is a host, or a firewall in front of it,
                    # that says yes to everything — which is no answer about any
                    # one port. Asking them all would take the rest of the day.
                    say(f"{name} answered on {len(open_ports)} of "
                        f"{high - low + 1} ports asked — a host that opens "
                        f"every door is not telling the truth about any of "
                        f"them, so they are not asked one by one")
                    continue
                for port in sorted(open_ports):
                    base = f"http://{name}:{port}"
                    if ping_ok(base, 5.0):
                        found = base
                        break
                if found:
                    break
            if found:
                break
        _SCAN_TRIED["when"] = time.time()
    if found:
        write_shooter_cache(found)
        say(f"found the browser service at {found} by asking its host's ports "
            f"once — remembered in tools/shooter-found.txt, never swept again")
    elif ran_out:
        say(f"the search for the browser service ran out of its "
            f"{int(SCAN_BUDGET)} seconds at {ran_out} — pages will come as "
            f"words until it is found, and its ports are not asked again for "
            f"{int(SCAN_RETRY_AFTER // 60)} minutes")
    else:
        say(f"asked {', '.join(name for name, _b in targets)} port by port and "
            f"no port is the browser service — pages will come as words until "
            f"that egg is running, and its ports are not asked again for "
            f"{int(SCAN_RETRY_AFTER // 60)} minutes")
    return found


def boot_shots_report() -> None:
    """Ask for the browser at boot, off the serving thread, and say the answer.

    The browser is another host now, so the panel opens its own door first and
    asks afterwards: whether a page nobody sends can be photographed is still
    said before anybody presses download, but a host that does not answer cannot
    hold the panel shut while it times out.
    """
    def say(text: str) -> None:
        print(text, flush=True)

    try:
        found, note = discover_shots(timeout=6.0)
        if not found:
            found = scan_for_shooter(announce=say)
            if found:
                # asked once more, so the note is the browser's own words and the
                # answer is warm in the cache before the first document asks
                again, why = discover_shots(hosts=[found], force=True,
                                            timeout=6.0)
                note = why if again else found
        say(("photographing pages: " + note) if found else
            ("photographing pages: none — " + note))
    except Exception as trouble:                          # noqa: BLE001
        say(f"photographing pages: unknown — asking failed ({plain_error(trouble)})")


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


MAX_SHARD_FRACTION = 0.5


def shard_fraction(words: str) -> float:
    """How much of a page's words are glyph shards instead of words.

    A text layer that failed to decode leaves a signature no character count
    has: its "words" are one- and two-letter runs — `Udd h`, `Eo`, `er`, `W` —
    scattered where lines should be. A page that is genuinely sparse has the
    opposite shape: very few tokens, but whole ones — `Contents`, `Fifth
    Edition`, a folio `6`, a dedication `For my mother`. So the share of
    alphabetic tokens that are one or two letters is what tells a fake page
    from a short real one, and it does not care how long the page is.
    """
    # the words a page carries are stored with their placement marks in front
    # of every line ("\x010.0000|Udd h"); tokenising THAT would chew on the
    # positions and hide the shards entirely
    plain = words_plain(str(words or ""))
    tokens = [tok for tok in re.split(r"\s+", plain.strip()) if tok]
    alpha = [tok for tok in tokens if re.search(r"[A-Za-z]", tok)]
    if not alpha:
        return 0.0          # a folio, a figure, a page number: nothing shardy
    shards = [tok for tok in alpha
              if re.fullmatch(r"[A-Za-z]{1,2}", tok.strip(".,;:!?\"'()"))]
    return len(shards) / len(alpha)


def words_look_like_a_page(words: str) -> bool:
    """Whether these words are a page of a book, or the wreckage of a font decode.

    Length must not be the test. A title page, a dedication, a folio and a
    chapter divider are all real pages with almost nothing on them, and a
    character floor drops exactly those — which is how a fix for one blank book
    would have started eating short real ones. What was shipped instead of page
    1 of a live book was not *short*, it was *shards*: seven glyph runs where
    lines of words should be, because the viewer's custom font would not decode.
    Half or more of the alphabetic tokens being one or two letters is that
    wreckage; no real page, however sparse, looks like it. A page below the
    rule is left out of the PDF and named, which is honest, where an empty sheet
    with writing on it is not.
    """
    if not str(words or "").strip():
        return False
    return shard_fraction(words) < MAX_SHARD_FRACTION


def refusal_reason(body: bytes, status: int) -> str:
    """Why the browser service said no, in its own words."""
    if body:
        try:
            answer = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            answer = None
        if isinstance(answer, dict):
            for key in ("error", "note", "message"):
                text = str(answer.get(key) or "").strip()
                if text:
                    # 200 characters cut the browser's own diagnosis in half —
                    # "the column NaNpx tall, 0 bo" is what a run printed, and
                    # the rest of that sentence was the part that said why
                    return text[:900]
    text = body[:900].decode("utf-8", "replace").strip()
    return text or f"http {status}"


# ─── the browser service starts itself ──────────────────────────────────────
# A host that runs only the web process (the Procfile's `web:` line) has no
# shooter until somebody starts one by hand — and a document whose scans are
# refused then used to end in grey sheets saying "scan not available". That
# sheet no longer exists, so the engine makes sure the browser does: same box,
# same node that runs the panel, the service that ships next to this file.
def png_size(payload: bytes) -> tuple[int, int]:
    """(width, height) as a PNG header claims them — no decoding."""
    if len(payload) < 24 or payload[:4] != b"\x89PNG":
        return 0, 0
    import struct as _struct
    width, height = _struct.unpack(">II", payload[16:24])
    return int(width), int(height)


def decode_shots(body: bytes) -> tuple[list[dict], str]:
    """The book wire format: [4-byte length][png] ... [zero length][manifest].

    A body that ends mid-picture or whose manifest is not JSON is an error, not
    a partial book: half a book of clipped pages would put the wrong picture on
    the wrong page number.
    """
    import json as _json
    buf = memoryview(body)
    pages: list[dict] = []
    at = 0
    while at + 4 <= len(buf):
        length = int.from_bytes(buf[at:at + 4], "big")
        at += 4
        if length == 0:
            break
        if at + length > len(buf):
            return [], "a picture runs past the end of the answer"
        pages.append({"png": bytes(buf[at:at + length])})
        at += length
    try:
        manifest = _json.loads(bytes(buf[at:]) or b"{}")
    except Exception:                                            # noqa: BLE001
        return [], "the manifest is not JSON"
    if not isinstance(manifest, dict):
        return [], "the manifest is not a JSON object"
    listed = manifest.get("pages") or []
    for entry, meta in zip(pages, listed if isinstance(listed, list) else []):
        if isinstance(meta, dict):
            entry.update({key: meta[key] for key in
                          ("page", "width", "height", "unstable", "blank")
                          if key in meta})
    for number, entry in enumerate(pages, 1):
        entry.setdefault("page", number)
        width, height = entry.get("width") or 0, entry.get("height") or 0
        if not (width and height):
            width, height = png_size(entry.get("png") or b"")
            entry["width"], entry["height"] = width, height
    return pages, ""


def body_manifest(body: bytes) -> dict:
    """The JSON tail of a /shots answer, without re-walking the pictures."""
    import json as _json
    # the manifest is the last JSON object: cut at the final zero length mark
    mark = body.rfind(b"\x00\x00\x00\x00")
    tail = body[mark + 4:] if mark >= 0 else b"{}"
    try:
        got = _json.loads(tail or b"{}")
    except Exception:                                              # noqa: BLE001
        return {}
    return got if isinstance(got, dict) else {}


def entry_manifest(pages: list[dict]) -> str:
    """One honest line about how the book was cut."""
    widths = {int(e.get("width") or 0) for e in pages}
    heights = {int(e.get("height") or 0) for e in pages}
    unstable = [int(e.get("page") or 0) for e in pages if e.get("unstable")]
    blanks = [int(e.get("page") or 0) for e in pages if e.get("blank")]
    if len(widths) == 1 and len(heights) == 1:
        size = f"every sheet {sorted(widths)[0]}x{sorted(heights)[0]}"
    else:
        size = (f"{len(widths)} different size(s) — the viewer did not lay "
                f"them out as one column")
    line = f"{len(pages)} page(s) clipped at the gaps, {size}"
    if unstable:
        line += f" · page(s) {', '.join(map(str, unstable[:8]))} were still " \
                f"moving between two captures"
    if blanks:
        line += f" · page(s) {', '.join(map(str, blanks[:8]))} look empty"
    return line


_AUTOSTART = {"tried": 0.0, "base": "", "npm_tried": False}
AUTOSTART_COOLDOWN = 300.0   # a failed start is retried, just not every page


def shooter_log_path(proj: str) -> str:
    return os.path.join(proj, "tmp", "shooter-start.log")


def shooter_start_reason(proj: str) -> str:
    """The service's own last words, from its start log — never a guess.

    A browser service that dies at import time knows exactly why (a missing
    package, a missing shared library). Swallowing that is what made a panel
    say "nothing is listening" instead of the one line that fixes it.
    """
    try:
        with open(shooter_log_path(proj), "rb") as handle:
            lines = [ln.decode("utf-8", "replace").strip()
                     for ln in handle.read().splitlines() if ln.strip()]
    except Exception:                                   # noqa: BLE001
        return ""
    return " | ".join(lines[-3:])


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


def fit_shots(collected: dict[int, dict], sheet: tuple[float, float]) -> None:
    """Put every photographed page on this document's sheet, shape kept.

    A screenshot is the size of a screen, and a screen is not a piece of paper:
    left alone it would make one page of the book a different size from the rest.
    Scaling the picture's own dimensions to the sheet means the sheet stays the
    document's, the page fills it, and nothing is stretched — the aspect ratio
    is carried along, so a page that is not quite A4 is centred, not distorted.
    """
    if not (sheet[0] and sheet[1]):
        return
    for page in collected.values():
        if not page.get("shot"):
            continue
        width, height = page["width"] * 0.75, page["height"] * 0.75
        if not (width and height):
            continue
        factor = min(sheet[0] / width, sheet[1] / height)
        page["width"] = max(1, round(page["width"] * factor))
        page["height"] = max(1, round(page["height"] * factor))


def _download(url: str, limit: int, out: str, jobs: int = 12,
              name: str = "", check: bool = True,
              placeholder: bool = True, verify: bool = True,
              text: bool = False, gen: int = 0) -> None:
    ctx = Ctx(url, jobs)
    ctx.gen = gen or JOB.generation
    # One cheap question before any page is asked for: is there a browser to
    # photograph with? There is one route now and it runs through a browser, so
    # knowing early is what makes the rest of the job honest — with no browser,
    # only a page that has words of its own can still be built.
    shooter = Shooter()
    photographed: list[int] = []
    if shooter.base and shooter.alive():
        ctx.rest_budget = min(REST_BUDGET, SHOT_REST_BUDGET)
        JOB.say(f"browser on hand ({shooter.base}) — every page of this document "
                f"is photographed with it, so it rests at most "
                f"{ctx.rest_budget:.0f}s waiting on a page that is refusing")
    elif shooter.base:
        JOB.say(f"no browser at {shooter.base}: {shooter.note}")
        JOB.say("  with no browser there is nothing to photograph a page with, so "
                "only a page that has words of its own can still be built; the "
                "rest are left out of the PDF and named, never greyed. When pages "
                "are missing I will try to start that service myself")
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    JOB.say(f"document {ctx.ident} · {socket.gethostname()} · python "
            f"{sys.version.split()[0]} · {cookie_report(ctx.cookie_path)}")
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = ("the page named no pages — is the session logged in?"
                          if ctx.total == 0 else "nothing to do")
        JOB.say("no page count and no page descriptors found")
        return

    with_limit = min(ctx.total, limit) if limit else ctx.total
    locked = ctx.locked_pages(with_limit)

    JOB.say(("downloading the first %d" % with_limit) if limit
            else "downloading the whole document")
    JOB.set_progress(page=0, of=with_limit, ok=0, skipped=0, blank=0)

    with _scrape_lock:
        _scrape_left[0] = SCRAPE_BUDGET
        _scrape_said[0] = False
    ctx.cache_dir = os.path.join(out, "cache", ctx.ident)
    ctx.debug_dir = os.path.join(out, "debug")
    os.makedirs(ctx.cache_dir, exist_ok=True)
    os.makedirs(os.path.join(out, "debug"), exist_ok=True)

    # ---- every document is photographed ------------------------------------
    # There is one load and one way a page is built: a browser photographs what
    # the viewer shows. A scanned upload and a converted upload are drawn by the
    # same viewer, so the photograph is the page for both.
    #
    # Whether the document's WORDS are worth one request per page is a separate
    # question, and one request answers it: a scan has none, and asking anyway
    # would spend hundreds of refusals and rest the job for nothing.
    has_words = ctx.gives_words()
    JOB.say("route: every page is photographed — one window and one measured "
            "clip per page"
            + (" · this document carries words, so they stay underneath every "
               "page, searchable" if has_words else
               " · this document carries no words of its own, so the "
               "photograph is the page"))
    # ---- one window per page, one clip of exactly that page ----------------
    # The browser opens the page's own address, measures the page's bounds in
    # that window, and photographs exactly those bounds: a capture can neither
    # lose the page's own edges nor carry its neighbour's. A page whose bounds
    # are missing, cut by the window, shared with a neighbour, or whose picture
    # does not match the measured bounds is a FAILED page with a reason — never
    # a picture of something else, and never a photograph of the window. The
    # words still come from the document, underneath, so the book stays
    # searchable.
    collected: dict[int, dict] = {}

    def shot_progress(done: int, ok: int, total: int) -> None:
        """Move the panel's numbers while pages are photographed one at a time.

        Twenty pages of silence is a panel that reads `page 0/20 · 0 ok · 159.7s`
        and looks dead, and a run that looks dead gets killed and started again,
        losing the pages that had already landed.
        """
        # "of" is the DOCUMENT's page count, never this pass's: a pass over one
        # page must not turn the panel's `page 20 of 20` into `page 20 of 1`,
        # which reads like a lie about the book
        of = max(int(with_limit), int(total), int(done))
        JOB.set_progress(page=min(len(collected) + int(done), of), of=of,
                         ok=len(collected) + int(ok))

    failed: list[int] = []
    text_pages: dict[int, str] = {}
    texts: dict[int, str] = {}     # the invisible text layer of a photographed page
    book_shot: list[int] = []
    shot_notes: list[str] = []
    asked = [number for number in range(1, with_limit + 1)
             if number not in locked]
    if not ctx.skip_now:
        shooter = ensure_shooter(shooter)
        if shooter.alive():
            JOB.say(f"photographing {len(asked)} page(s) at {shooter.base} — "
                    f"one window each, measured and clipped to the page's own "
                    f"bounds, at {shooter.scale:g}x")
            pictures, shot_notes = shooter.capture(
                ctx.ident, asked, jobs=ctx.jobs,
                alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
            collected.update(pictures)
            book_shot = sorted(pictures)
            for note in shot_notes:
                JOB.say("  " + note)
            # the browser's own words for why a page failed are the only honest
            # answer to "why is this page missing", and the debug file keeps all
            # of them, page by page
            missed_notes = [note for note in shot_notes
                            if "failed" in note or "refused" in note]
            if missed_notes:
                saved = ctx.save_shot_note("\n".join(missed_notes))
                if saved:
                    JOB.say(f"why, page by page: {saved}")
        else:
            JOB.say("no browser is reachable"
                    + (f" at {shooter.base}" if shooter.base else "")
                    + f": {shooter.note} — the words ladder runs instead, and a "
                    "page with no words and no photograph is left out and named")
    if collected and has_words:
        # The look came from the browser; the words come from the document,
        # underneath every photograph, so the book stays searchable. Only when
        # the document has words to give: a scanned page has none, and one
        # refused request per page would trip the throttle breaker and rest the
        # job for nothing.
        with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
            futures = {pool.submit(ctx.page_text, number): number
                       for number in sorted(collected)}
            for future in as_completed(futures):
                number = futures[future]
                try:
                    words = future.result()
                except Exception:                      # noqa: BLE001
                    words = ""
                if words and words.strip():
                    texts[number] = words
        JOB.say(f"words underneath: {len(texts)} of {len(collected)} "
                f"photographed page(s) are searchable")
    failed = [number for number in asked if number not in collected]
    thin: list[int] = []
    if failed and not ctx.skip_now:
        JOB.say(f"{len(failed)} page(s) no photograph reached — asking the "
                f"document for their words instead")
        with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
            futures = {pool.submit(ctx.descriptor_text, number): number
                       for number in list(failed)}
            for future in as_completed(futures):
                number = futures[future]
                try:
                    words = future.result()
                except Exception:                      # noqa: BLE001
                    words = ""
                if words_look_like_a_page(words):
                    text_pages[number] = words
                    failed = [n for n in failed if n != number]
                elif words and words.strip():
                    thin.append(number)
    if thin:
        JOB.say(f"{len(thin)} page(s) had words that were glyph shards, "
                f"not a page (half or more of its word-runs are one or two "
                f"letters — a font that would not decode) — left out and "
                f"named, not drawn as an empty sheet: "
                f"{', '.join(str(n) for n in thin[:12])}"
                + (" …" if len(thin) > 12 else ""))
    if failed:
        JOB.say(f"pages left out of the PDF (no photograph and no words "
                f"reached them): {', '.join(map(str, failed[:12]))}"
                + (" …" if len(failed) > 12 else ""))
    JOB.set_progress(page=with_limit, ok=len(collected),
                     skipped=len(failed))
    photographed.extend(book_shot)
    if not collected:
        # ---- when no photograph arrived at all ------------------------------
        # Not one page could be photographed, so every page is built from the
        # document's own words. A document
        # that has words reads them — they are drawn as pages, and photographed
        # over the top when a browser is there. A document with no words of its
        # own has every page photographed instead: the viewer's picture is the
        # page, and there is nothing else to fetch it from.
        done = 0
        if has_words:
            JOB.say("reading the pages the viewer renders — that is what a "
                    "browser shows you, and what this document is made of")
            # ONE request first: the viewer's scroll page carries every page's
            # words. Only what it does not have is asked for page by page.
            viewer = ctx.viewer_pages()
            if viewer:
                JOB.say(f"viewer: {ctx.embed_state} — its pages are the document, "
                        f"so they are drawn as pages")
                thin = [number for number in range(1, with_limit + 1)
                        if (viewer.get(number) or "").strip()
                        and not words_look_like_a_page(viewer.get(number))]
                for number in range(1, with_limit + 1):
                    words = (viewer.get(number) or "").strip()
                    if words and words_look_like_a_page(words):
                        text_pages[number] = viewer[number]
                        ctx.remember_text(number, viewer[number])
                if thin:
                    JOB.say(f"{len(thin)} page(s) of the viewer's words were "
                            f"glyph shards, not a page (a font that would not "
                            f"decode) — left out and named, not drawn as an "
                            f"empty sheet")
            missing = [number for number in range(1, with_limit + 1)
                       if number not in text_pages and number not in locked]
            done = len(text_pages)
            JOB.set_progress(page=done, ok=len(text_pages), skipped=len(missing))
            if missing and done:
                saved = ctx.save_viewer_page()
                if saved:
                    JOB.say(f"viewer: it carries no page text — the page as received "
                            f"is saved to {saved} (safe to send: no cookie in it)")
                JOB.say(f"text: {len(missing)} page(s) are not in the viewer page — "
                        f"asking their descriptors")
            with ThreadPoolExecutor(max_workers=max(2, min(ctx.jobs, 8))) as pool:
                futures = {pool.submit(ctx.descriptor_text, number): number
                           for number in missing}
                for future in as_completed(futures):
                    if not JOB.alive(ctx.gen):
                        for pending in futures:
                            pending.cancel()
                        JOB.say("stopped — no more pages read")
                        return
                    if ctx.skip_now:
                        for pending in futures:
                            pending.cancel()
                        break
                    number = futures[future]
                    try:
                        words = future.result()
                    except Exception:                      # noqa: BLE001
                        words = ""
                    if words.strip():
                        text_pages[number] = words
                    done += 1
                    JOB.set_progress(page=done, ok=len(text_pages),
                                     skipped=with_limit - len(text_pages))
                    if done % 10 == 0 or done == with_limit:
                        JOB.say(f"… {done}/{with_limit} pages, "
                                f"{len(text_pages)} with words")
            # A page with no words is still a page the viewer draws, so it is
            # photographed below. Nothing here asks Scribd for an image of a page
            # any more: that was the scan ladder, and it is gone.
            silent = [number for number in range(1, with_limit + 1)
                      if number not in text_pages and number not in locked]
            failed = sorted(silent)
            JOB.say(f"text: {len(text_pages)} of {with_limit} page(s) have words"
                    + (f" — {len(failed)} have none, and are photographed as the "
                       f"pages they are" if failed else ""))
            JOB.set_progress(ok=len(text_pages), skipped=len(failed))

        if not has_words:
            # No words to read and no image to fetch: what a page is, is what the
            # viewer draws, so every page of it is photographed one at a time —
            # the only route there is: one window and one measured clip per page.
            failed = [number for number in range(1, with_limit + 1)
                      if number not in collected and number not in locked]
            JOB.say(f"{len(failed)} page(s) to photograph one at a time — this "
                    f"document has no words of its own, so the viewer's own "
                    f"picture is the page")
            JOB.set_progress(page=0, of=with_limit, ok=len(collected), skipped=0)


        if ctx.skip_now:
            # The drop cancelled requests that had not been made yet. A page nobody
            # asked for is still a page the reader does not have, and it must be
            # counted: otherwise a dropped book reports itself as built with a
            # handful of placeholder sheets inside it.
            never_asked = [number for number in range(1, with_limit + 1)
                           if number not in collected and number not in text_pages
                           and number not in failed and number not in texts]
            if never_asked:
                failed = sorted(set(failed) | set(never_asked))
                JOB.say(f"{len(never_asked)} page(s) were never asked for — the "
                        f"queue moved on without them: they will be left out of "
                        f"the PDF and named, never greyed")

    # ---- no retries --------------------------------------------------------
    # A page Scribd refused is refused for a reason, and the very same request
    # again has never once brought one back — it only spends the reader's minutes
    # and holds every document in the queue behind it. Everything already fetched
    # is kept, a locked page is a failed page (photographed if a browser is on
    # hand, left out and named if not), and the book is built now.
    if locked:
        failed = sorted(set(failed) | locked)

    # ---- fidelity pass: photograph the pages that only arrived as words ---
    # Words keep a page's content but lose the document: a retypeset sheet is
    # not the page a reader saw in the viewer — no layout, no headings in
    # place, no page number. A browser sees exactly what the viewer shows, so
    # whenever one runs (or can be started) the viewer's own look is
    # photographed for those pages, and their words stay underneath as a
    # hidden, searchable layer. With no browser at all the words sheet
    # remains, because the content beats the look.
    word_only = sorted(number for number in text_pages
                       if number not in collected)
    if word_only and not ctx.skip_now:
        shooter = ensure_shooter(shooter)
    if word_only and shooter.alive() and not ctx.skip_now:
        JOB.say(f"photographing {len(word_only)} text page(s) with a browser "
                f"({shooter.base}) — the viewer's own look, with the words kept "
                f"underneath, searchable")
        pictures, shot_notes = shooter.capture(
            ctx.ident, word_only, jobs=ctx.jobs,
            alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
        for number in sorted(pictures):
            collected[number] = pictures[number]
            photographed.append(number)
            # the picture now IS the page's look, so its words go underneath as
            # the hidden searchable layer instead of a second, retypeset sheet
            if number in text_pages:
                texts[number] = text_pages.pop(number)
        for note in shot_notes:
            JOB.say("  " + note)
        left = [number for number in word_only if number not in collected]
        JOB.say(f"the viewer's look is in the PDF for {len(word_only) - len(left)}"
                f" of {len(word_only)} text page(s)"
                + (f" — {len(left)} keep their words sheet: the browser could "
                   f"not see them" if left else ""))
        JOB.set_progress(ok=len(collected) + len(
            [n for n in text_pages if n not in collected]), skipped=len(failed))

    # ---- a page nothing reached yet: photograph it ------------------------
    # This is the page that used to say "scan not available". Nothing arrived for
    # it and nothing was drawn for it — but a browser can still see it, and what
    # a browser sees is the page.
    if failed and not ctx.skip_now:
        # not alive at the start of the job is not an answer: ask past the
        # cache and, if nobody runs one, start the browser service myself
        shooter = ensure_shooter(shooter)
    if failed and shooter.alive() and not ctx.skip_now:
        JOB.say(f"photographing {len(failed)} page(s) with a browser "
                f"({shooter.base}) — a page nobody sent us is still a page "
                f"somebody can see")
        asked_for = len(failed)
        pictures, shot_notes = shooter.capture(
            ctx.ident, failed, jobs=ctx.jobs,
            alive=lambda: JOB.alive(ctx.gen), progress=shot_progress)
        for number in sorted(pictures):
            collected[number] = pictures[number]
            photographed.append(number)
        for note in shot_notes:
            JOB.say("  " + note)
        failed = [number for number in failed if number not in collected]
        # a page photographed as an empty sheet is still that page: it is in the
        # PDF, so it is not a placeholder — the note above says what it looks like
        JOB.say(f"photographed: {len(photographed)} of {asked_for} page(s) the "
                f"panel could not build"
                + (" — no placeholder left in this document" if not failed else
                   f" — {len(failed)} page(s) still have nothing")
                + (f" · {sample['label']}" if (sample := next(
                    (collected[n] for n in photographed), None)) else ""))
        JOB.set_progress(ok=len(collected) + len(
            [n for n in text_pages if n not in collected]), skipped=len(failed))
    elif failed and shooter.note:
        JOB.say(f"no browser to photograph {len(failed)} page(s)"
                + (f" at {shooter.base}" if shooter.base else "")
                + f": {shooter.note}")

    # ---- a page no photograph reached may still have words: use them -------
    # This is the case that made a 38-page document come out blank: its pages are
    # text the viewer renders, and each one of them used to be reported as "scan
    # not available". One descriptor request per page that is still missing turns
    # it into a page you can actually read. It runs AFTER the photographs, not
    # before: a photograph is the page, and asking for words first only spends
    # requests on pages a browser was about to draw.
    if failed and not has_words:
        JOB.say(f"no photograph for {len(failed)} page(s) — asking the document "
                f"for their words")
        rescued: list[int] = []
        thin: list[int] = []
        for number in sorted(failed):
            if not JOB.alive(ctx.gen):
                break
            words = ctx.page_text(number)
            if words_look_like_a_page(words):
                text_pages[number] = words
                rescued.append(number)
            elif words.strip():
                thin.append(number)
        if thin:
            JOB.say(f"{len(thin)} page(s) had words that were glyph shards, "
                    f"not a page (half or more of its word-runs are one or two "
                    f"letters — a font that would not decode) — left out and "
                    f"named, not drawn as an empty sheet: "
                    f"{', '.join(str(n) for n in thin[:12])}"
                    + (" …" if len(thin) > 12 else ""))
        if rescued:
            for number in rescued:
                rows = [line for line in ctx.trace.get(number, [])
                        if "403" in line or "AccessDenied" in line]
                JOB.say(f"page {number}: no photograph (it is text in this "
                        f"document) — wrote its words instead"
                        + ("" if not rows else " · its picture was refused with 403"))
            failed = [number for number in failed if number not in text_pages]
            JOB.set_progress(ok=len(collected) + len(text_pages),
                             skipped=len(failed))
            JOB.say(f"{len(rescued)} page(s) came from the document's text — "
                    + ("the PDF is complete, no placeholder"
                       if not failed else
                       f"{len(failed)} page(s) still have neither a photograph "
                       f"nor words"))
        if failed and not rescued:
            # nothing came from the text either: keep what Scribd actually sent
            saved = ctx.save_viewer_page()
            if saved:
                JOB.say(f"viewer page saved to {saved} (no cookie in it) — that "
                        f"file says what the viewer really sends")


    # ---- the size of this book -------------------------------------------
    # Every page is a photograph cut at the column's own size, so the book's size
    # is the MEDIAN of those photographs: one odd page cannot shape it. Nothing is
    # refetched, because there is no second copy of a photograph to go and ask
    # for — what the viewer showed is what the page is.
    reference = median_page(list(collected.values())) if collected else (0, 0)

    # ---- the words of each page, so the PDF is not just photographs --------
    if text and collected:
        JOB.say("text: asking for each page's words (one extra request per page)")
        for number in sorted(collected):
            words = ctx.page_text(number)
            if words:
                texts[number] = words
        JOB.say(f"text: {len(texts)} of {len(collected)} page(s) had words")

    # A book of photographs has no scan to agree a size with, so no sheet is made
    # uniform: each one keeps the size of the page on it.
    sheets = sheet_list(collected, with_limit, placeholder)
    if not sheets:
        # a document with no pictures at all: one sheet per page, A4
        sheets = [None] * with_limit
    if reference[0]:
        sheet = (round(reference[0] * 0.75, 2), round(reference[1] * 0.75, 2))
    elif text_pages:
        sheet = (595.0, 842.0)
    else:
        sheet = (0.0, 0.0)

    fit_shots(collected, sheet)

    with open(os.path.join(out, "debug", "pages.txt"), "w") as handle:
        handle.write(f"document {ctx.ident} · title {ctx.title!r} · "
                     f"author {ctx.author!r}\n")
        word_sheets = sum(1 for pos, sh in enumerate(sheets, start=1)
                          if sh is None and (text_pages.get(pos) or "").strip())
        left_out = sum(1 for pos, sh in enumerate(sheets, start=1)
                       if sh is None and not (text_pages.get(pos) or "").strip())
        handle.write(f"pages in document: {ctx.total} · photographed: "
                     f"{len(collected)} · drawn from their own words: "
                     f"{word_sheets} · left out and named: {left_out}\n")
        handle.write(f"page size: {reference[0]}x{reference[1]} px · "
                     f"sheet {sheet[0]}x{sheet[1]} pt · every sheet keeps "
                     f"the size of the page on it\n")
        if ctx.rejected:
            handle.write("arrived but unreadable: "
                         + ", ".join(f"{count} {kind}" for kind, count in
                                     sorted(ctx.rejected.items())) + "\n")
        for number in range(1, with_limit + 1):
            page = collected.get(number)
            if page:
                handle.write(f"{number:4d}  {page['width']}x{page['height']}"
                             f"  rot {page.get('rotate', 1)}"
                             f"  {page.get('bytes', 0) / 1000:7.0f} kB"
                             f"  [{page.get('phase', '?')}]"
                             f"  {page.get('url', '')[:130]}\n")
            elif (text_pages.get(number) or "").strip():
                handle.write(f"{number:4d}  WORDS    drawn as a text sheet "
                             f"({len(text_pages[number])} chars) — no photograph "
                             f"reached this page, and its words are on it\n")
            else:
                handle.write(f"{number:4d}  LEFT OUT no photograph, no words — "
                             f"not in the PDF, and named in the verdict\n")
        if ctx.notes:
            handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")

    if failed:
        with open(os.path.join(out, "debug", "failed-pages.txt"), "w") as handle:
            handle.write(f"document {ctx.ident} · {len(failed)} page(s) failed\n")
            for number in sorted(failed):
                handle.write(f"\npage {number} — every name tried, and its answer:\n")
                for line in ctx.trace.get(number, []):
                    handle.write("  " + line + "\n")
            if ctx.notes:
                handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")
        with open(os.path.join(out, "debug", "missing-pages.txt"), "w") as handle:
            handle.write(", ".join(str(n) for n in failed) + "\n")
        codes: dict[str, int] = {}
        for number in failed:
            for line in ctx.trace.get(number, []):
                parts = line.split()
                code = parts[0] if parts else "?"
                codes[code] = codes.get(code, 0) + 1
        order = sorted(codes.items(), key=lambda row: -row[1])[:4]
        JOB.say("why: " + " · ".join(f"{count} answer(s) {code}"
                                     for code, count in order))
        if codes.get("403", 0) >= sum(codes.values()) * 0.6:
            JOB.say("     403 is the only answer: either those pages are not for "
                    "this account, or Scribd is still throttling this address — "
                    "run it again later, the finished pages are cached")
        if ctx.rejected:
            JOB.say("     arrived but unreadable: "
                    + ", ".join(f"{count} {kind}" for kind, count in
                                sorted(ctx.rejected.items())))
        for number in sorted(failed)[:3]:
            lines = ctx.trace.get(number, [])
            names = len(ctx.tried.get(number, ()))
            JOB.say(f"page {number}: {names} name(s) tried, "
                    f"nothing usable came back ({len(lines)} request(s))")
            for line in lines[:4]:
                JOB.say("   " + line)

    if not collected and not text_pages:
        kinds = ", ".join(f"{count} {kind}" for kind, count in
                          sorted(ctx.rejected.items(), key=lambda row: -row[1]))
        if ctx.rejected:
            why = (f"{sum(ctx.rejected.values())} page file(s) arrived but none could "
                   f"be read as a page image ({kinds})")
            if "webp" in ctx.rejected:
                why += (" · webp needs Pillow: this build reads jpeg and png alone. "
                        "Run --probe 1 to see the file that arrived")
        else:
            why = ("no page could be photographed and no page's words could be "
                   "read — see downloads/debug/"
                   + ("" if ctx.token.get() else
                      " · no browser answered and the document named no words: "
                      "a document of page scans is fetched without a browser, "
                      "so this one is a converted document with nothing to "
                      "photograph it — start the /shot service"))
        waited, aged = JOB.waiting(), ctx.age()
        with JOB.lock:
            if ctx.skip_now:
                JOB.verdict = "DROPPED"
                JOB.detail = (f"{aged:.0f}s of refusals, nothing arrived, "
                              f"{waited} document(s) waiting — dropped by the "
                              f"queue and moved on; not retried")
            else:
                JOB.verdict = "NO PAGES"
                JOB.detail = why
        for number in sorted(ctx.tried)[:3]:
            JOB.say(f"page {number}: {len(ctx.tried[number])} name(s) tried")
            for line in ctx.trace.get(number, [])[:3]:
                JOB.say("   " + line)
        return

    if failed and os.environ.get("SCRIBD_STRICT_PAGES", "0") == "1":
        # some deployments would rather have no book than a book with holes
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = (f"{len(failed)} page(s) have no source at all — no "
                          f"scan, no words, no browser that could photograph "
                          f"them: {failed[:20]}; SCRIBD_STRICT_PAGES refuses "
                          f"to save a book with holes")
        return

    stem = safe_name(name, "") or ctx.title or f"scribd-{ctx.ident}"
    target = os.path.join(out, f"{stem}.pdf")
    suffix = 2
    while os.path.exists(target) and suffix <= 50:
        target = os.path.join(out, f"{stem} ({suffix}).pdf")
        suffix += 1

    # uniform=False: every sheet keeps the MediaBox of the page on it. A book of
    # photographs was cut at one column's size, so the sheets agree anyway; a page
    # photographed on its own may not, and it must not be stretched to match.
    ok, note_text = build_pdf(sheets, target, title=ctx.title, author=ctx.author,
                              uniform=False, texts=texts, text_pages=text_pages)
    if not ok:
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = note_text
        return

    if verify:
        drawn = len(sheets) - sum(1 for pos, sh in enumerate(sheets, start=1)
                                  if sh is None and not text_pages.get(pos))
        sound, report = verify_pdf(target, expect_pages=drawn,
                                   expect_images=len(collected), uniform=False)
        JOB.say("verify: " + report)
        if not sound:
            with JOB.lock:
                JOB.file = target
                JOB.verdict = "PDF BROKEN"
                JOB.detail = f"{os.path.basename(target)} — {report}"
            return

    with JOB.lock:
        JOB.file = target
        JOB.verdict = ("DROPPED" if ctx.skip_now and failed else
                       "PDF BUILT" if not failed else "PDF PARTIAL")
        asked = with_limit if limit else ctx.total
        real_pages = len(set(collected) | set(text_pages))
        drawn_text = sum(1 for number in text_pages if number not in collected)
        JOB.detail = (f"{note_text} · {real_pages} of {asked} page(s) real"
                      + (f" of {ctx.total} in the document" if limit and
                         with_limit < ctx.total else "")
                      + (f" · {drawn_text} from text" if drawn_text else "")
                      + (f" · {len(photographed)} photographed"
                         if photographed else "")
                      + (f" · {len(failed)} omitted" if failed else "")
                      + (" · dropped by the queue" if ctx.skip_now else "")
                      + (" · verified" if verify else ""))
    if failed:
        JOB.say("pages left out of the PDF (no photograph, no words): "
                + ", ".join(str(n) for n in failed[:60])
                + (" …" if len(failed) > 60 else ""))
        JOB.say("why, page by page: downloads/debug/failed-pages.txt")
    if ctx.skip_now:
        JOB.say(f"dropped itself after {ctx.age():.0f}s: {len(failed)} page(s) "
                f"were only refusals and the queue was waiting — they are left "
                f"out of the PDF and named in the verdict; not retried")

    # a small disk fills up quietly; say what was cleaned instead of hiding it
    for line in prune_out(out):
        JOB.say(line)
        JOB.say("to see every name and answer for one of them: --probe <page>")
    JOB.say(f"written: {target}")
