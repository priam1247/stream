"""Scribd panel — shooter discovery, screenshot fallback and final download.

Loaded from tools/downloader/ by scribd_download.py after scribd_jobs.py. The /shot client, shooter
autostart, Shooter, fit_shots and _download live here. Annotations are compiled
with PEP 563 by the loader.
"""


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
    return os.path.join(_tools_dir(), "shooter-found.txt")


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
            f"once — remembered in shooter-found.txt beside troy-search/, never swept again")
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
    """Start the sibling troy-search/ service myself and wait for it to answer.

    Returns '' if I cannot. Retried at most once per cooldown after a failure,
    cached forever once it works. SCRIBD_AUTOSHOOT=0 turns it off for hosts
    where a browser must never be spawned; SCRIBD_SHOOTER_DIR points somewhere
    else, and SCRIBD_TOOLS_DIR changes where the sibling is looked for. If the
    service has no packages installed, npm install runs once first —
    photographs need them, and a panel box that runs node can fetch them.
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
    here = _tools_dir()
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
                    "npm install in troy-search/ once, because the "
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
                    "not on the PATH — run npm install in troy-search/ "
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
    JOB.say("no browser service was running — starting troy-search/ "
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
