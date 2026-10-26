#!/usr/bin/env python3
"""Screenshot a Scribd document's pages in a real browser, then compile those
screenshots into one verified PDF.

A Word document Scribd converted will sometimes refuse a page: the panel asks
for the scan, the scan's lookup is refused, and the words that would have stood
in for it never arrive either. Text drawing cannot invent words. A screenshot
cannot fail that way — it is the page exactly as the browser shows it.

    python tools/scribd_screenshots.py --url 692848690 --pages all
    python tools/scribd_screenshots.py --url https://www.scribd.com/document/692848690/Nthondo-PDF
    python tools/scribd_screenshots.py --url 692848690 --pages 12,13 --pdf page12.pdf
    python tools/scribd_screenshots.py --from-dir ./shots --pdf Nthondo.pdf
    python tools/scribd_screenshots.py --selftest

It needs a Chrome-family browser already installed — Chrome, Edge, Chromium or
Brave, on your computer or on the server. Nothing to pip install, nothing to
npm install: the browser's own `--headless --screenshot` is run once per page,
opened at the viewer's `?start_page=N`, so each shot is that page.

Rules it keeps, because the point is a PDF you can read:

  · a shot is checked before it is trusted — a blank white sheet is retaken,
    not compiled;
  · pages already captured are reused, so a second run costs nothing;
  · the PDF is read back and verified before it is announced;
  · if any requested page is missing the PDF is not written at all (pass
    --partial to take what worked instead).
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scribd_download as sd          # noqa: E402  the PDF writer and verifier

VERSION = "1.0"
SHOT_NAME = "page-%04d.png"
DEFAULT_SCALE = 2.0                   # device pixel ratio: 2x the page, sharper than a scan
DEFAULT_WINDOW = (1000, 1414)         # A4 in CSS pixels
DEFAULT_WAIT_MS = 7000                # let the viewer's JavaScript lay out the page
PATIENT_WAIT_MS = 14000               # the second, patient try for a page that came back white
# A freshly drawn blank sheet compresses to almost nothing: a white row costs a
# handful of bytes, so an empty screenshot is a few bytes per row however wide
# the page is. This is only ever used to decide "retake", never "throw away": a
# sparse page that trips it costs one extra browser run and is still compiled.
BLANK_BYTES_PER_ROW = 12
A4 = (595.28, 841.89)                 # A4 in points
A4_PX = (A4[0] / 0.75, A4[1] / 0.75)  # the same sheet in the pixels the shot has
CHROME_NAMES = ("google-chrome", "google-chrome-stable", "chrome", "chromium",
                "chromium-browser", "microsoft-edge", "brave-browser")


# ---------------------------------------------------------------------------
# finding a browser
# ---------------------------------------------------------------------------
def chrome_candidates() -> list[str]:
    """Every place a Chrome-family browser hides on the three systems."""
    found: list[str] = []
    for name in CHROME_NAMES:
        hit = shutil.which(name)
        if hit:
            found.append(hit)
    for root in (os.environ.get("PROGRAMFILES", ""),
                 os.environ.get("PROGRAMFILES(X86)", ""),
                 os.environ.get("LOCALAPPDATA", "")):
        if not root:
            continue
        for tail in ("Google/Chrome/Application/chrome.exe",
                     "Microsoft/Edge/Application/msedge.exe",
                     "BraveSoftware/Brave-Browser/Application/brave.exe"):
            path = os.path.join(root, *tail.split("/"))
            if os.path.isfile(path):
                found.append(path)
    for path in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                 "/Applications/Chromium.app/Contents/MacOS/Chromium",
                 "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                 "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                 "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                 "/usr/bin/chromium", "/usr/bin/chromium-browser",
                 "/snap/bin/chromium"):
        if os.path.isfile(path):
            found.append(path)
    return list(dict.fromkeys(path for path in found if path))


def find_chrome(explicit: str = "") -> str:
    """The browser to drive: the one you named, the one the env names, or one here."""
    for candidate in (explicit, os.environ.get("SCRIBD_CHROME", "")):
        if candidate:
            expanded = os.path.expanduser(candidate)
            if os.path.isfile(expanded):
                return expanded
            raise SystemExit(f"there is no browser at {expanded!r} — check --chrome")
    found = chrome_candidates()
    if found:
        return found[0]
    raise SystemExit(
        "no Chrome, Edge, Chromium or Brave found to take the screenshots with.\n"
        "  · on your own computer: install Chrome, or pass --chrome with its path\n"
        '    (Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")\n'
        "  · already have the screenshots? "
        "python tools/scribd_screenshots.py --from-dir DIR --pdf OUT.pdf")


# ---------------------------------------------------------------------------
# which document, which pages
# ---------------------------------------------------------------------------
def document_id(text: str) -> str:
    """The number in a Scribd link, or the number you typed."""
    text = (text or "").strip()
    if re.fullmatch(r"\d{3,}", text):
        return text
    match = re.search(r"scribd\.com/(?:document|doc|presentation|spreadsheet|"
                      r"ebook|magazine|read)/(\d{3,})", text)
    if match:
        return match.group(1)
    raise SystemExit(f"no Scribd document id in {text!r}")


def embed_url(ident: str, page: int) -> str:
    """The public viewer, opened at one page.

    `start_page` is what makes this one screenshot per page: the viewer lays
    that page out at the top, so the picture is that page and no other.
    """
    return (f"https://www.scribd.com/embeds/{ident}/content"
            f"?start_page={page}&view_mode=scroll")


def document_pages(ident: str, fetch=None) -> int:
    """How many pages the document has, asked once, so `--pages all` works.

    Only a hint: if the answer cannot be had (no network, no cookies, a block),
    the caller asks for --of N instead of guessing.
    """
    if fetch is None:
        def fetch(url: str) -> dict:
            try:
                jar = sd.load_cookies(sd.find_cookies())
            except SystemExit:              # no cookies is fine: public pages
                jar = {}
            return sd.fetch(url, jar=jar)
    try:
        got = fetch(embed_url(ident, 1))
    except (Exception, SystemExit):         # noqa: BLE001  a hint may fail
        return 0
    body = (got or {}).get("body") or b""
    if not body or (got.get("status") not in (0, 200)):
        return 0
    sources = sd.Sources()
    sources.merge(body)
    try:
        found = sd.page_count(body, sources)
    except Exception:                       # noqa: BLE001
        return 0
    return found if 0 < found <= 5000 else 0


def parse_pages(text: str, total: int = 0) -> list[int]:
    """`1-35`, `12,13`, `5-`, `all` -> the page numbers to capture."""
    text = (text or "").strip()
    if not text or text.lower() in ("all", "*"):
        if not total:
            raise SystemExit("say which pages: --pages 1-35, or --pages all --of N")
        return list(range(1, total + 1))
    pages: set[int] = set()
    for part in text.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            low, _, high = part.partition("-")
            if low and not low.isdigit():
                raise SystemExit(f"--pages cannot read {part!r}")
            if high and not high.isdigit():
                raise SystemExit(f"--pages cannot read {part!r}")
            first = int(low) if low else 1
            last = int(high) if high else total
            if not last:
                raise SystemExit(f"--pages {part} needs --of N when the end is left open")
            pages.update(range(min(first, last), max(first, last) + 1))
        elif part.isdigit():
            pages.add(int(part))
        else:
            raise SystemExit(f"--pages cannot read {part!r}")
    if not pages:
        raise SystemExit("no pages selected")
    return sorted(pages)


# ---------------------------------------------------------------------------
# one screenshot
# ---------------------------------------------------------------------------
def shot_args(chrome: str, url: str, target: str, scale: float,
              window: tuple[int, int], wait_ms: int,
              profile: str = "", headless: str = "--headless=new") -> list[str]:
    """The command line for one page: headless, one file, done."""
    args = [chrome, headless, "--disable-gpu", "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--mute-audio", "--disable-sync", "--disable-background-networking",
            "--disable-dev-shm-usage", "--no-pings", "--log-level=3",
            f"--window-size={int(window[0])},{int(window[1])}",
            f"--force-device-scale-factor={scale:g}",
            f"--virtual-time-budget={int(wait_ms)}",
            "--run-all-compositor-stages-before-draw",
            "--force-color-profile=srgb",
            f"--screenshot={target}"]
    if profile:
        args.append(f"--user-data-dir={profile}")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.append("--no-sandbox")       # Chromium refuses to start as root otherwise
    args.append(url)
    return args


def shot_size(data: bytes) -> tuple[int, int]:
    """The size this screenshot claims to have (header only, no decode)."""
    parsed = sd.png_chunks(data) if data[:8] == b"\x89PNG\r\n\x1a\n" else None
    if parsed is None:
        return 0, 0
    header = parsed[0]
    return int(header.get("width") or 0), int(header.get("height") or 0)


def looks_blank_shot(path: str) -> tuple[bool, str]:
    """Did the browser hand back an empty white sheet?

    Measured on bytes per row of the image: a page of a book costs hundreds of
    bytes per row, a sheet with nothing drawn on it a few. Only used to decide
    whether to take the shot again — a real page that trips this is still kept,
    so a sparse title page can never be lost to a clever rule.
    """
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        return True, f"unreadable: {exc}"
    width, height = shot_size(data)
    size = sd.size_text(len(data))
    if not (width and height):
        return False, f"{size}, not a png the header can read"
    per_row = len(data) / height
    if per_row < BLANK_BYTES_PER_ROW:
        return True, f"{width}x{height} in {size} ({per_row:.0f} B/row)"
    return False, f"{width}x{height}, {size}"


def _run_once(chrome: str, url: str, target: str, scale: float,
              window: tuple[int, int], wait_ms: int, profile: str,
              headless: str) -> tuple[bool, str]:
    """One browser run. True means it wrote a picture of some kind."""
    if os.path.exists(target):
        os.remove(target)
    scratch = ""
    if not profile:
        # a throwaway profile: the browser never touches the one you browse with,
        # and two runs at once cannot fight over one directory
        scratch = profile = tempfile.mkdtemp(prefix="scribd-shot-")
    try:
        done = subprocess.run(shot_args(chrome, url, target, scale, window,
                                        wait_ms, profile, headless),
                              capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        return False, "the browser did not finish in 180 s"
    except OSError as exc:
        return False, f"could not run the browser: {exc}"
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
    if os.path.isfile(target) and os.path.getsize(target) > 1000:
        return True, ""
    text = (done.stderr or b"").decode("utf-8", "replace").strip()
    return False, (text.splitlines()[-1] if text else f"exit {done.returncode}")


def take_shot(chrome: str, url: str, target: str, scale: float,
              window: tuple[int, int], wait_ms: int,
              profile: str = "") -> tuple[str, str]:
    """Screenshot this page. -> ("drawn" | "blank" | "failed", note).

    Both headless modes are tried, newest first: `--headless=new` is what current
    Chrome offers, `--headless` is what older builds understand, and a build that
    ignores a flag tends to leave a blank sheet behind rather than an error. A
    blank sheet is reported as blank, never as a page: the caller decides.
    """
    blank_note = ""
    last = ""
    for headless in ("--headless=new", "--headless"):
        ok, why = _run_once(chrome, url, target, scale, window, wait_ms, profile,
                            headless)
        if not ok:
            last = why
            continue
        blank, note = looks_blank_shot(target)
        if not blank:
            return "drawn", note
        blank_note = note
    if blank_note:
        return "blank", blank_note
    return "failed", last or "the browser wrote no picture"


def capture_page(chrome: str, ident: str, page: int, folder: str,
                 scale: float, window: tuple[int, int], wait_ms: int,
                 profile: str, again: bool) -> tuple[int, bool, str]:
    """One page, checked, retaken if the page had not drawn. -> (page, ok, note)."""
    target = os.path.abspath(os.path.join(folder, SHOT_NAME % page))
    if os.path.isfile(target) and not again:
        blank, note = looks_blank_shot(target)
        if not blank:
            return page, True, f"already here — {note}"
    started = time.time()
    state, note = take_shot(chrome, embed_url(ident, page), target, scale, window,
                            wait_ms, profile)
    if state == "failed":
        return page, False, note
    if state == "drawn":
        return page, True, f"{note}  ({time.time() - started:.1f} s)"
    # the sheet is still white: give the viewer longer, once, before believing it
    keep = target + ".keep"
    if os.path.isfile(target):
        shutil.copyfile(target, keep)         # the retry deletes before it draws
    state, second = take_shot(chrome, embed_url(ident, page), target, scale,
                              window, PATIENT_WAIT_MS, profile)
    if state in ("blank", "failed") and os.path.isfile(keep):
        if not os.path.isfile(target):
            os.replace(keep, target)          # keep the page we did get
        else:
            os.remove(keep)
    if state == "drawn":
        if os.path.isfile(keep):
            os.remove(keep)
        return page, True, (f"{second}  ({time.time() - started:.1f} s, "
                            f"after a patient second try)")
    # kept whatever is there: a blank shot beats losing the page, and the note
    # says so plainly so nobody has to guess later
    return page, True, f"{note} — kept, though it looks empty (look at page {page})"


def capture(ident: str, pages: list[int], folder: str, chrome: str,
            scale: float, window: tuple[int, int], wait_ms: int,
            profile: str = "", again: bool = False, jobs: int = 3,
            keep_going: bool = False) -> tuple[list[int], list[int]]:
    """One screenshot per page. -> (pages captured, pages that failed)."""
    os.makedirs(folder, exist_ok=True)
    done: list[int] = []
    failed: list[int] = []
    jobs = max(1, min(jobs, 8))
    for start in range(0, len(pages), jobs):
        batch = pages[start:start + jobs]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results = list(pool.map(
                lambda page: capture_page(chrome, ident, page, folder, scale,
                                          window, wait_ms, profile, again),
                batch))
        for page, ok, note in results:
            shown = f"[{pages.index(page) + 1}/{len(pages)}] page {page}"
            if ok:
                done.append(page)
                print(f"{shown}: {note}", flush=True)
            else:
                failed.append(page)
                print(f"{shown}: FAILED — {note}", flush=True)
        if failed and not keep_going:
            print("stopping: the shots that worked are kept — run the same "
                  "command again to retry only the missing pages", flush=True)
            break
    return sorted(done), sorted(failed)


# ---------------------------------------------------------------------------
# screenshots -> one verified PDF
# ---------------------------------------------------------------------------
def shot_files(folder: str) -> list[Path]:
    """The pages in this folder, in page order (page-2 before page-10)."""
    path = Path(folder).expanduser()
    if not path.is_dir():
        raise SystemExit(f"{path} is not a folder")
    files = [child for child in path.iterdir()
             if child.is_file() and child.suffix.lower() in (".png", ".jpg", ".jpeg")]
    if not files:
        raise SystemExit(f"{path} has no screenshots in it")
    return sorted(files, key=lambda child: natural_key(child.name))


def natural_key(name: str) -> list:
    return [(1, int(part)) if part.isdigit() else (0, part.casefold())
            for part in re.split(r"(\d+)", name)]


def page_of_shot(path: Path) -> int:
    """The page a screenshot belongs to, from its name; 0 when it cannot be read."""
    match = re.search(r"(\d+)(?=\.\w+$)", path.name)
    return int(match.group(1)) if match else 0


def fit_sheet(pages: list[dict], sheet: str = "a4") -> float:
    """One number that puts every shot on the same sensible piece of paper.

    A screenshot's pixel size says how finely the page was drawn, not how big
    the paper is: 1000 CSS pixels of screen is not 1000 points of anything. So
    the document is fitted to A4 once, on the median page, and every page gets
    the same treatment — which keeps the pages consistent with each other.
    """
    if sheet == "native" or not pages:
        return 1.0
    widths = sorted(page["width"] for page in pages)
    heights = sorted(page["height"] for page in pages)
    width = widths[len(widths) // 2]
    height = heights[len(heights) // 2]
    if not (width and height):
        return 1.0
    return min(A4_PX[0] / width, A4_PX[1] / height)


def compile_shots(folder: str, target: str, scale: float = DEFAULT_SCALE,
                  title: str = "", crop: tuple[int, int, int, int] | None = None,
                  expect: list[int] | None = None,
                  sheet: str = "a4") -> tuple[bool, str]:
    """The screenshots into one PDF, one sheet per shot, the file read back."""
    files = shot_files(folder)
    have = {page_of_shot(path) for path in files}
    if expect:
        missing = [page for page in expect if page not in have]
        if missing:
            return False, ("no screenshot for page(s) "
                           + ", ".join(str(page) for page in missing)
                           + " — nothing was written")
        asked = set(expect)
        files = [path for path in files if page_of_shot(path) in asked]
    pages: list[dict] = []
    for path in files:
        data = path.read_bytes()
        if crop:
            data = crop_png(data, crop)
            if data is None:
                return False, f"{path.name}: cannot crop this picture"
        page = sd.scan_for_pdf(data)
        if page is None:
            return False, f"{path.name}: not a readable page image"
        page = dict(page)
        # a 2x screenshot is not a page twice as large: it is the same page drawn
        # twice as finely, so the sheet is scaled back to the size of the screen.
        scale_used = max(0.1, scale)
        page["width"] = max(1.0, page["width"] / scale_used)
        page["height"] = max(1.0, page["height"] / scale_used)
        pages.append(page)
    fitted = fit_sheet(pages, sheet)
    if fitted != 1.0:
        for page in pages:
            page["width"] = round(page["width"] * fitted, 2)
            page["height"] = round(page["height"] * fitted, 2)
    ok, built = sd.build_pdf(pages, target, title=title or Path(target).stem,
                             uniform=False)
    if not ok:
        return False, built
    sound, verdict = sd.verify_pdf(target, expect_pages=len(pages),
                                   expect_images=len(pages), uniform=False)
    if not sound:
        remove(target)
        return False, f"the PDF did not verify: {verdict}"
    return True, f"{len(pages)} page(s) · {built} · {verdict}"


def remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def crop_png(data: bytes, crop: tuple[int, int, int, int]) -> bytes | None:
    """Cut L,T,W,H out of a screenshot, keeping the pixels exactly as drawn.

    Cropping happens on the decoded scanlines so a crop never re-compresses the
    page: the PDF then carries the same pixels the browser produced.
    """
    left, top, width, height = crop
    decoded = sd.png_to_raw(data)
    if not decoded:
        return None
    pixels, full_width, full_height, channels = decoded
    if (left < 0 or top < 0 or width <= 0 or height <= 0
            or left + width > full_width or top + height > full_height):
        return None
    rows = []
    stride = full_width * channels
    for row in range(top, top + height):
        start = row * stride + left * channels
        rows.append(b"\x00" + pixels[start:start + width * channels])
    return png_build(width, height, channels, b"".join(rows))


def png_build(width: int, height: int, channels: int, scanlines: bytes) -> bytes:
    """A valid 8-bit PNG from unfiltered scanlines (each already has its filter byte)."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (len(body).to_bytes(4, "big") + kind + body
                + (zlib.crc32(kind + body) & 0xFFFFFFFF).to_bytes(4, "big"))
    colour = {1: 0, 3: 2, 4: 6}.get(channels, 2)
    header = (width.to_bytes(4, "big") + height.to_bytes(4, "big")
              + bytes([8, colour, 0, 0, 0]))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(scanlines, 6)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# the whole job
# ---------------------------------------------------------------------------
def page_report(done: list[int], failed: list[int], folder: str) -> str:
    lines = []
    if done:
        lines.append(f"{len(done)} page(s) in {folder}")
    if failed:
        lines.append("no screenshot for page(s): "
                     + ", ".join(str(page) for page in failed))
        lines.append("  · a page that will not draw may need the viewer opened "
                     "once in a normal window (it can ask for consent), or "
                     "--profile with your own Chrome profile")
        lines.append("  · run the same command again: only the missing pages "
                     "are captured")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Screenshot a Scribd document's pages in a real browser and "
                    "compile them into one verified PDF.")
    parser.add_argument("--url", default="", help="document link or document id")
    parser.add_argument("--pages", default="all",
                        help="all · 1-35 · 12,13 · 5- (default all)")
    parser.add_argument("--of", type=int, default=0, dest="total",
                        help="page count, when --pages cannot learn it")
    parser.add_argument("--out", default="",
                        help="folder for the screenshots "
                             "(default scribd-shots-<document id>)")
    parser.add_argument("--pdf", default="", help="the PDF to write")
    parser.add_argument("--from-dir", default="",
                        help="skip the browser: compile these screenshots only")
    parser.add_argument("--scale", type=float, default=DEFAULT_SCALE,
                        help="device pixel ratio for the shots; with --sheet a4 "
                             "the paper is fitted anyway (default 2)")
    parser.add_argument("--window", default=f"{DEFAULT_WINDOW[0]}x{DEFAULT_WINDOW[1]}",
                        help="browser window in CSS pixels (default 1000x1414)")
    parser.add_argument("--wait", type=int, default=DEFAULT_WAIT_MS,
                        help="milliseconds to let the viewer draw (default 7000)")
    parser.add_argument("--jobs", type=int, default=3,
                        help="browsers at once (default 3)")
    parser.add_argument("--chrome", default="", help="path to Chrome/Edge/Chromium")
    parser.add_argument("--profile", default="",
                        help="a Chrome user-data-dir, to shoot with your own session")
    parser.add_argument("--crop", default="",
                        help="cut L,T,W,H from each shot — trims viewer furniture")
    parser.add_argument("--sheet", default="a4", choices=("a4", "native"),
                        help="paper size: a4 (default) or native screen pixels")
    parser.add_argument("--again", action="store_true",
                        help="re-take screenshots that are already there")
    parser.add_argument("--keep-going", action="store_true",
                        help="carry on after a page that will not draw")
    parser.add_argument("--partial", action="store_true",
                        help="write the PDF even if pages are missing")
    parser.add_argument("--title", default="", help="PDF title metadata")
    parser.add_argument("--selftest", action="store_true",
                        help="offline checks: no browser, no network")
    args = parser.parse_args(argv)

    if args.selftest:
        print(selftest())
        return 0

    crop = parse_crop(args.crop)

    if args.from_dir:
        if not args.pdf:
            raise SystemExit("--from-dir needs --pdf OUT.pdf")
        ok, message = compile_shots(args.from_dir, args.pdf, args.scale,
                                    args.title, crop, sheet=args.sheet)
        print(message)
        if ok:
            print(f"written: {args.pdf}")
        return 0 if ok else 1

    if not args.url:
        raise SystemExit("give --url (a Scribd link or document id) or --from-dir")

    ident = document_id(args.url)
    total = args.total
    if args.pages.strip().lower() in ("", "all", "*") and not total:
        print("asking the viewer how many pages the document has …", flush=True)
        total = document_pages(ident)
        if total:
            print(f"document {ident} has {total} page(s)", flush=True)
        else:
            raise SystemExit(
                "could not learn the page count from here — say it: "
                "--pages all --of 35")
    pages = parse_pages(args.pages, total)
    chrome = find_chrome(args.chrome)
    try:
        width, height = (int(part) for part in args.window.lower().split("x"))
    except ValueError:
        raise SystemExit(f"--window wants WIDTHxHEIGHT, not {args.window!r}")
    print(f"scribd-screenshots {VERSION} · document {ident} · {len(pages)} page(s)"
          f" · {os.path.basename(chrome)} · {args.scale:g}x · {args.jobs} at a time")
    args.out = args.out or f"scribd-shots-{ident}"
    print(f"shots: {args.out}", flush=True)
    started = time.time()
    done, failed = capture(ident, pages, args.out, chrome, args.scale,
                           (width, height), args.wait, args.profile, args.again,
                           args.jobs, args.keep_going)
    target = args.pdf or f"scribd-{ident}.pdf"
    print(page_report(done, failed, args.out), flush=True)
    if not done:
        return stop_short(target, "nothing was captured")
    if failed and not args.partial:
        return stop_short(target, "every page must be there first — fix the "
                                 "page(s) above and run again (or --partial "
                                 "to take what worked)")
    ok, message = compile_shots(args.out, target, args.scale, args.title, crop,
                                expect=sorted(done), sheet=args.sheet)
    print(f"{message}  ({time.time() - started:.0f} s)")
    if ok:
        print(f"written: {target}")
        return 0
    return 1


def stop_short(target: str, why: str) -> int:
    """No PDF this run — and no old PDF left behind to be mistaken for it."""
    stale = os.path.isfile(target)
    if stale:
        remove(target)
    print(("no PDF written: " + why)
          + (f"\nthe older {target} was removed, so nothing stale can be "
             f"mistaken for this run" if stale else ""))
    return 1


def parse_crop(text: str) -> tuple[int, int, int, int] | None:
    """`L,T,W,H` -> four numbers; empty -> no crop."""
    text = (text or "").strip()
    if not text:
        return None
    parts = [part.strip() for part in text.split(",")]
    if len(parts) != 4 or not all(re.fullmatch(r"\d+", part) for part in parts):
        raise SystemExit(f"--crop wants LEFT,TOP,WIDTH,HEIGHT, not {text!r}")
    return tuple(int(part) for part in parts)     # type: ignore[return-value]


# ---------------------------------------------------------------------------
# offline checks
# ---------------------------------------------------------------------------
def make_png(width: int, height: int, ink: bool) -> bytes:
    """A PNG for the selftest: white paper, and text-like rows if `ink`.

    The ink is noisy on purpose: real text is anti-aliased and different on every
    row, which is exactly why a page of writing cannot compress the way a blank
    sheet does. A tidy repeating pattern would not exercise that difference.
    """
    rows = []
    state = 12345
    for row in range(height):
        line = bytearray(b"\xff" * (width * 3))
        if ink and (row // 34) % 2 == 0 and (row % 34) < 8:
            for column in range(width // 8, width * 7 // 8):
                state = (state * 1103515245 + 12345) & 0x7FFFFFFF
                shade = 20 + (state >> 16) % 80
                line[column * 3:column * 3 + 3] = bytes([shade, shade, shade])
        rows.append(b"\x00" + bytes(line))
    return png_build(width, height, 3, b"".join(rows))


def selftest() -> str:
    assert document_id("692848690") == "692848690"
    assert document_id(
        "https://www.scribd.com/document/692848690/Nthondo-PDF") == "692848690"
    assert document_id("scribd.com/doc/123456/x") == "123456"
    for bad in ("", "nonsense", "https://example.com/x", "12"):
        try:
            document_id(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"{bad!r} should have been refused")

    assert embed_url("7", 3) == ("https://www.scribd.com/embeds/7/content"
                                 "?start_page=3&view_mode=scroll")
    assert embed_url("7", 12).endswith("start_page=12&view_mode=scroll")

    assert parse_pages("12,13") == [12, 13]
    assert parse_pages("1-4") == [1, 2, 3, 4]
    assert parse_pages("3-1") == [1, 2, 3]
    assert parse_pages("5-", 8) == [5, 6, 7, 8]
    assert parse_pages("-3", 0) == [1, 2, 3]
    assert parse_pages("", 3) == [1, 2, 3]
    assert parse_pages("all", 2) == [1, 2]
    assert parse_pages(" 2 , 4-5 ", 0) == [2, 4, 5]
    assert parse_pages("2", 0) == [2]                 # one page, no count needed
    for bad, total in (("x", 0), ("1-", 0), ("all", 0), ("", 0), ("-", 0)):
        try:
            parse_pages(bad, total)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"--pages {bad!r} should have been refused")

    # the page count is a hint from the viewer's own markup, not a guess
    assert document_pages("1", fetch=lambda url: {
        "status": 200, "body": b'<script>var d={"page_count":35};</script>'}) == 35
    assert document_pages("1", fetch=lambda url: {"status": 403, "body": b"no"}) == 0
    assert document_pages("1", fetch=lambda url: None) == 0

    args = shot_args("/usr/bin/chrome", "https://x/y", "/tmp/p-1.png", 2.0,
                     (1000, 1414), 7000)
    assert args[0] == "/usr/bin/chrome" and args[1] == "--headless=new"
    assert "--window-size=1000,1414" in args
    assert "--force-device-scale-factor=2" in args
    assert "--screenshot=/tmp/p-1.png" in args
    assert "--virtual-time-budget=7000" in args
    assert args[-1] == "https://x/y"                  # the url is last, always
    assert shot_args("/c", "u", "/t", 1, (1, 1), 1,
                     headless="--headless")[1] == "--headless"
    profiled = shot_args("/c", "u", "/t", 1.5, (800, 600), 1000,
                         profile="/home/me/profile")
    assert "--user-data-dir=/home/me/profile" in profiled
    assert "--force-device-scale-factor=1.5" in profiled
    assert parse_crop("") is None
    assert parse_crop(" 10, 20 ,300,400 ") == (10, 20, 300, 400)
    for bad in ("1,2,3", "a,b,c,d", "1,2,3,-4"):
        try:
            parse_crop(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"--crop {bad!r} should have been refused")

    with tempfile.TemporaryDirectory() as shelf:
        inked = os.path.join(shelf, "page-0001.png")
        with open(inked, "wb") as handle:
            handle.write(make_png(600, 840, ink=True))
        blank, note = looks_blank_shot(inked)
        assert not blank, note
        assert "600x840" in note, note
        white = os.path.join(shelf, "page-0002.png")
        with open(white, "wb") as handle:
            handle.write(make_png(600, 840, ink=False))
        blank, note = looks_blank_shot(white)
        assert blank, note                            # a white sheet is retaken
        assert "B/row" in note, note

        # cropping cuts exactly those pixels out, and the result is still a page
        with open(os.path.join(shelf, "page-0003.png"), "wb") as handle:
            handle.write(make_png(600, 840, ink=True))
        data = crop_png(Path(os.path.join(shelf, "page-0003.png")).read_bytes(),
                        (100, 200, 300, 400))
        assert data, "the crop produced nothing"
        decoded = sd.png_to_raw(data)
        assert decoded, "the cropped png does not decode"
        pixels, width, height, channels = decoded
        assert (width, height, channels) == (300, 400, 3), (width, height, channels)
        source = sd.png_to_raw(Path(os.path.join(shelf, "page-0003.png")).read_bytes())
        assert source
        source_pixels, source_width, _sh, source_channels = source
        want = (source_pixels[(200 * source_width + 100) * source_channels:
                              (200 * source_width + 100) * source_channels + 3])
        assert pixels[:3] == want, (pixels[:3], want)
        assert crop_png(Path(os.path.join(shelf, "page-0003.png")).read_bytes(),
                        (500, 700, 300, 400)) is None      # off the edge

        # page names decide page order, and a gap is refused before writing
        for page in (10, 2, 1):
            with open(os.path.join(shelf, SHOT_NAME % page), "wb") as handle:
                handle.write(make_png(600, 840, ink=True))
        names = [path.name for path in shot_files(shelf)]
        assert names == ["page-0001.png", "page-0002.png", "page-0003.png",
                         "page-0010.png"], names
        assert [page_of_shot(path) for path in shot_files(shelf)] == [1, 2, 3, 10]

        target = os.path.join(shelf, "book.pdf")
        ok, message = compile_shots(shelf, target, scale=2.0, expect=[1, 2, 10],
                                    sheet="native")
        assert ok, message
        # only the pages asked for, even though the folder holds one more
        sound, report = sd.verify_pdf(target, expect_pages=3, expect_images=3,
                                      uniform=False)
        assert sound, report
        data = Path(target).read_bytes()
        boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", data)
        assert len(boxes) == 3, boxes
        # and with nothing asked for, everything in the folder goes in, in order
        every = os.path.join(shelf, "every.pdf")
        ok, message = compile_shots(shelf, every, scale=2.0, sheet="native")
        assert ok, message
        sound, report = sd.verify_pdf(every, expect_pages=4, expect_images=4,
                                      uniform=False)
        assert sound, report
        # 600x840 px shot at 2x is a 300x420 px screen = 225x315 pt on paper
        assert abs(float(boxes[0][0]) - 225.0) < 0.6, boxes[0]
        assert abs(float(boxes[0][1]) - 315.0) < 0.6, boxes[0]

        # and on A4 paper the same shots are fitted, aspect kept, one size for all
        target = os.path.join(shelf, "book-a4.pdf")
        ok, message = compile_shots(shelf, target, scale=2.0, sheet="a4")
        assert ok, message
        boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]",
                           Path(target).read_bytes())
        wide, tall = float(boxes[0][0]), float(boxes[0][1])
        assert abs(wide - A4[0]) < 0.6, (wide, tall)   # points, not pixels
        assert tall <= A4[1] + 0.6, (wide, tall)
        assert abs(wide / tall - 300 / 420) < 0.002, (wide, tall)
        assert len(set(boxes)) == 1, boxes
        assert fit_sheet([{"width": 600, "height": 840}], "native") == 1.0
        assert fit_sheet([], "a4") == 1.0

        ok, message = compile_shots(shelf, os.path.join(shelf, "gap.pdf"),
                                    expect=[1, 2, 3, 10, 11])
        assert not ok and "page(s) 11" in message, message
        assert not os.path.exists(os.path.join(shelf, "gap.pdf"))

        empty = os.path.join(shelf, "empty")
        os.makedirs(empty)
        try:
            compile_shots(empty, target)
        except SystemExit:
            pass
        else:
            raise AssertionError("an empty folder must be refused")

    return ("selftest: every check passed — document ids, page lists "
            "(all · 1-35 · 12,13 · 5-) and the page-count hint, the browser "
            "command line, blank-shot detection, exact cropping, natural page "
            "order, a gap refused before anything is written, screenshots "
            "compiled into a verified PDF at the right sheet size, and the same "
            "shots fitted to A4 with their shape kept")


if __name__ == "__main__":
    raise SystemExit(main())
