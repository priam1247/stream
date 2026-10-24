from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console

from .export import write_all
from .http import Fetcher
from .scraper import ScrapeError, ScribdScraper

console = Console()


def _parse_cookie(arg: str | None) -> dict[str, str]:
    if not arg:
        return {}
    jar: dict[str, str] = {}
    for part in arg.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            jar[k.strip()] = v.strip()
    return jar


def _load_netscape(path: str) -> dict[str, str]:
    jar: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8", errors="ignore").splitlines():
        # Exporters (e.g. "Get cookies.txt LOCALLY") prefix HttpOnly
        # cookies with "#HttpOnly_" instead of a plain comment marker.
        # Those are usually THE session cookies — skipping every line
        # starting with "#" (as the original did) silently dropped the
        # login session, so the scraper ran anonymous while the user
        # believed they were authenticated.
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            jar[parts[5]] = parts[6].strip()
    return jar


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser("scribd", description="Scrape text and PDFs from Scribd.")
    p.add_argument("urls", nargs="*", help="Scribd document URLs")
    # FIX (vs. original listing): `-f` was bound to --file, while the
    # documented usage was `-f txt,md,json` (formats). That made every
    # documented example try to open a file literally named
    # "txt,md,json". Now: -f/--format = formats, --file = URL list file.
    p.add_argument("--file", dest="file", help="File with one URL per line")
    p.add_argument("-o", "--out", default="out", help="Output directory")
    p.add_argument(
        "-f",
        "--format",
        dest="format",
        default="txt,md,json,pdf",
        help="Comma list: txt,md,json,html,epub,pdf",
    )
    p.add_argument("--markdown", action="store_true", help="Keep bold/italic in output")
    p.add_argument("--images", action="store_true", help="Record page image URLs")
    p.add_argument("--concurrency", type=int, default=6)
    p.add_argument("--rate", type=float, default=6.0, help="Requests per second")
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--cache-dir", default=".scribd-cache")
    p.add_argument("--cookie", help='Raw cookie string: "k=v; k2=v2"')
    p.add_argument("--cookies-file", help="Netscape cookies.txt export")
    p.add_argument("--proxy", help="e.g. http://127.0.0.1:8080")
    p.add_argument(
        "--browser",
        action="store_true",
        help=(
            "Force the Chromium route: embed viewer + direct page loading + "
            "one PDF sheet per page (needs playwright)"
        ),
    )
    p.add_argument(
        "--no-embed",
        action="store_true",
        help=(
            "With --browser: skip the /embeds/<id>/content route "
            "(themrsami-style) and use the main viewer instead"
        ),
    )
    p.add_argument(
        "--no-print-pages",
        action="store_true",
        help="With --browser: print the document in one pass instead of one sheet per page",
    )
    p.add_argument(
        "--screenshots",
        action="store_true",
        help="With --browser: also screenshot each page (slower, fallback PDF)",
    )
    p.add_argument(
        "--keep-images",
        action="store_true",
        help="Also save the downloaded page images (out/<name>_pages/)",
    )
    p.add_argument(
        "--impersonate",
        default="chrome",
        help="Browser TLS fingerprint via curl_cffi (default: chrome; 'none' to disable)",
    )
    p.add_argument(
        "--search",
        action="append",
        metavar="QUERY",
        help=(
            "Search Scribd for this keyword and download the matches — no link "
            'needed (e.g. --search "excel"). Repeat for several queries.'
        ),
    )
    p.add_argument(
        "--pick",
        metavar="N,N",
        help=(
            "With --search: download only these result numbers from the printed "
            'list, 1-based (e.g. --pick 1,3,7)'
        ),
    )
    p.add_argument(
        "--search-only",
        action="store_true",
        help="With --search: only list the matches (verify the search), download nothing",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=5,
        help=(
            "With --search: how many documents to download (default 5; "
            "0 = everything the search found)"
        ),
    )
    p.add_argument(
        "--overwrite",
        action="store_true",
        help=(
            "Re-download documents whose PDF is already in the output folder "
            "(default: skip them, so a long batch can be re-run safely)"
        ),
    )
    p.add_argument(
        "--search-pages",
        type=int,
        default=3,
        help="With --search: how many result pages to read while filling --limit",
    )
    p.add_argument(
        "--jobs",
        type=int,
        default=0,
        help=(
            "How many documents to download in parallel "
            "(default: 3 with --search, 1 otherwise)"
        ),
    )
    p.add_argument(
        "--workers",
        type=int,
        default=0,
        help=(
            "With --browser: tabs printing pages in parallel "
            "(default: 2, or 4 with --fast)"
        ),
    )
    p.add_argument(
        "--fast",
        action="store_true",
        help="Shorter settle wait, bigger batches, 4 printing tabs",
    )
    p.add_argument(
        "--preload-all",
        action="store_true",
        help=(
            "With --browser: load every page up front (upstream's slow mode) "
            "instead of only the pages being printed"
        ),
    )
    p.add_argument(
        "--diagnose",
        action="store_true",
        help="Report what the live page returns (no download); saves .debug/page-*.html",
    )
    return p


def collect_urls(args: argparse.Namespace) -> list[str]:
    urls = list(args.urls)
    if args.file:
        for line in Path(args.file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                urls.append(line)
    return urls


DOC_ID_RE = re.compile(r"/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/(\d+)")
_MANIFEST_LOCK = threading.Lock()


def doc_id_of(url: str) -> str:
    match = DOC_ID_RE.search(url or "")
    return match.group(1) if match else ""


def existing_pdf(out_dir: Path, url: str) -> Path | None:
    """The PDF already written for this document, if any (resume support)."""
    doc_id = doc_id_of(url)
    if not doc_id:
        return None
    for path in out_dir.glob(f"{doc_id}_*.pdf"):
        try:
            if path.stat().st_size <= 0:
                continue
            # A truncated/failed write is not a downloaded document.
            with path.open("rb") as handle:
                if handle.read(5) != b"%PDF-":
                    continue
            return path
        except OSError:
            continue
    return None


def append_manifest(out_dir: Path, entry: dict) -> None:
    """Append one JSON line to out/manifest.jsonl (batch audit trail)."""
    record = dict(entry)
    record.setdefault("at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        with _MANIFEST_LOCK:
            with (out_dir / "manifest.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def parse_picks(value: str | None) -> set[int]:
    """``"1,3, 7"`` -> ``{1, 3, 7}`` (1-based result numbers; junk ignored)."""
    picks: set[int] = set()
    for part in str(value or "").replace(" ", "").split(","):
        if not part:
            continue
        try:
            number = int(part)
        except ValueError:
            continue
        if number > 0:
            picks.add(number)
    return picks


async def run(args: argparse.Namespace) -> int:
    # Missing/unreadable input files are user errors, not crashes:
    # report them cleanly (exit 2) instead of dumping a traceback.
    try:
        urls = collect_urls(args)
    except OSError:
        console.print(
            f"[red]Cannot read URL file: {args.file}[/red] "
            "(create it with one Scribd URL per line, or drop --file)"
        )
        return 2
    queries = [q for q in (getattr(args, "search", None) or []) if str(q).strip()]
    if not urls and not queries:
        console.print(
            "[red]No URLs given.[/red] Pass a Scribd URL, --file urls.txt, "
            'or search without a link: --search "excel"'
        )
        return 2

    cookies = _parse_cookie(args.cookie)
    if args.cookies_file:
        try:
            cookies.update(_load_netscape(args.cookies_file))
        except OSError:
            console.print(f"[red]Cannot read cookies file: {args.cookies_file}[/red]")
            return 2
    if cookies:
        # Count only — never print names/values; a cookie value is a
        # live session credential, equivalent to your password.
        console.print(f"[dim]loaded {len(cookies)} account cookies (values hidden)[/dim]")
        if args.cache_dir and not args.no_cache:
            console.print(
                "[dim]tip: add --no-cache on the first logged-in run so "
                "anonymous cached pages aren't reused[/dim]"
            )

    out_dir = Path(args.out)
    formats = [f.strip() for f in args.format.split(",") if f.strip()]

    async with Fetcher(
        concurrency=args.concurrency,
        rate=args.rate,
        timeout=args.timeout,
        retries=args.retries,
        cache_dir=None if args.no_cache else args.cache_dir,
        cookies=cookies,
        proxy=args.proxy,
        impersonate=None if str(args.impersonate).lower() in ("none", "off", "0") else args.impersonate,
    ) as fetcher:
        console.print(f"[dim]http backend: {fetcher.backend}[/dim]")
        if "not installed" in fetcher.backend:
            console.print(
                "[yellow]curl_cffi is missing — Scribd's anti-bot will likely serve "
                "a 'Client Challenge' page. Fix: pip install curl_cffi[/yellow]"
            )
        if args.diagnose:
            from .diagnose import diagnose

            rc = 0
            for url in urls:
                console.print(f"\n[bold cyan]{url}[/bold cyan]")
                rc = max(rc, await diagnose(fetcher, url))
            return rc

        # --- search: keyword -> document URLs (no link needed) -----------
        if queries:
            from .search import browser_search, find_documents, web_search
            from .utils import slugify

            out_dir.mkdir(parents=True, exist_ok=True)
            # 0 means "everything the search found".
            limit = max(0, int(getattr(args, "limit", 5) or 0))
            pages = max(1, int(getattr(args, "search_pages", 3) or 3))
            picks = parse_picks(getattr(args, "pick", None))
            if limit == 0:
                want = 0  # read every result page there is
            elif picks:
                # --pick 47 must be able to reach result 47, so read that far.
                want = max(limit, max(picks))
            else:
                want = limit
            if limit == 0 and pages < 10:
                pages = 10  # "everything" needs more result pages
            if want == 0:
                console.print(
                    "[dim]  --limit 0: downloading everything the search finds[/dim]"
                )
            found_any = 0
            for query in queries:
                shown = "all" if limit == 0 else limit
                console.print(f"\n[bold]search:[/bold] {query!r} (limit {shown})")
                hits = []
                try:
                    hits = await find_documents(
                        fetcher,
                        query,
                        limit=want,
                        pages=pages,
                        debug_dir=".debug",
                        log=lambda m: console.print(f"[dim]  {m}[/dim]"),
                    )
                except Exception as exc:
                    console.print(
                        f"[red]  http search failed: {type(exc).__name__}: {exc}[/red]"[:300]
                    )

                # want == 0 means "everything", so never stop early on it
                if want == 0 or len(hits) < want:
                    # Scribd's search page is client-rendered: when the HTTP
                    # response has no links (it usually has none), read the
                    # results in a real browser — no login needed.
                    if not hits:
                        console.print(
                            "[dim]  the HTTP page had no result links — "
                            "reading the results in a real browser…[/dim]"
                        )
                    try:
                        browser_hits = await browser_search(
                            cookies,
                            query,
                            limit=want,
                            pages=pages,
                            debug_dir=".debug",
                            log=lambda m: console.print(f"[dim]  {m}[/dim]"),
                        )
                    except Exception as exc:
                        browser_hits = []
                        from .chromium import BrowserLaunchError

                        if isinstance(exc, BrowserLaunchError):
                            # the reasons and the hints were already printed
                            console.print(
                                "[yellow]  browser search failed: Chromium cannot "
                                "start on this machine — see the reasons above[/yellow]"
                            )
                        else:
                            console.print(
                                f"[yellow]  browser search failed: "
                                f"{type(exc).__name__}: {exc}[/yellow]"
                            )
                    seen = {hit.doc_id for hit in hits}
                    for hit in browser_hits:
                        if want and len(hits) >= want:
                            break
                        if hit.doc_id in seen:
                            continue
                        seen.add(hit.doc_id)
                        hits.append(hit)

                if not hits:
                    # Still nothing: no browser needed for this one — search
                    # engines index Scribd's documents. This is what makes a
                    # server without Chromium able to find documents at all.
                    web_hits = await web_search(query, limit=want, log=lambda m: console.print(f"[dim]  {m}[/dim]"))
                    seen = set()
                    for hit in web_hits:
                        if want and len(hits) >= want:
                            break
                        if hit.doc_id in seen:
                            continue
                        seen.add(hit.doc_id)
                        hits.append(hit)

                if not hits:
                    console.print("[yellow]  no matching documents[/yellow]")
                    continue
                for number, hit in enumerate(hits, start=1):
                    chosen = " [green]*[/green]" if number in picks else ""
                    console.print(
                        f"  [cyan]{number}.[/cyan] {hit.title[:70]} — "
                        f"{hit.url}{chosen}"
                    )
                if picks:
                    missing = sorted(n for n in picks if n > len(hits))
                    hits = [hit for number, hit in enumerate(hits, start=1) if number in picks]
                    if missing:
                        console.print(
                            f"[yellow]  --pick: no result "
                            f"{', '.join(str(n) for n in missing)} "
                            f"in the first {want}[/yellow]"
                        )
                    if not hits:
                        console.print("[yellow]  --pick selected nothing[/yellow]")
                        continue
                    console.print(
                        "[dim]  picked: "
                        + ", ".join(str(n) for n in sorted(picks))
                        + "[/dim]"
                    )
                found_any += len(hits)
                urls.extend(hit.url for hit in hits)

                # Keep the list: it can be edited and fed back with --file.
                stem = out_dir / f"search-{slugify(query) or 'query'}"
                try:
                    stem.with_suffix(".txt").write_text(
                        "".join(f"{hit.url}\n" for hit in hits), encoding="utf-8"
                    )
                    stem.with_suffix(".json").write_text(
                        json.dumps(
                            {
                                "query": query,
                                "count": len(hits),
                                "results": [hit.to_dict() for hit in hits],
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    console.print(
                        f"[dim]  list saved: {stem.with_suffix('.txt')} "
                        f"(feed it back with --file)[/dim]"
                    )
                except OSError:
                    pass
            if not urls:
                console.print("[red]Nothing found to download.[/red]")
                return 1
            console.print(f"[dim]found {found_any} document(s) to download[/dim]")
            if getattr(args, "search_only", False):
                console.print(
                    "[dim]--search-only: nothing downloaded[/dim]"
                )
                return 0 if found_any else 1

        out_dir.mkdir(parents=True, exist_ok=True)
        fast = bool(getattr(args, "fast", False))
        strategies = None
        if getattr(args, "browser", False):
            from .browser import BrowserStrategy
            from .embedprint import EmbedPrintStrategy
            from .fetch import JsonpPagesStrategy

            workers = int(getattr(args, "workers", 0) or 0) or (4 if fast else 2)
            strategies = []
            if not getattr(args, "no_embed", False):
                # First choice: themrsami/scribd-downloader's model — the bare
                # embed viewer, pages loaded through window.docManager, then
                # one CDP Page.printToPDF sheet per document page. Printing is
                # split across `workers` tabs.
                strategies.append(
                    EmbedPrintStrategy(
                        workers=workers,
                        batch_size=12 if fast else 8,
                        settle_timeout=10 if fast else 30,
                        preload_all=bool(getattr(args, "preload_all", False)),
                    )
                )
            strategies.append(
                BrowserStrategy(
                    screenshot=bool(getattr(args, "screenshots", False)),
                    print_pages=not bool(getattr(args, "no_print_pages", False)),
                )
            )
            strategies.append(JsonpPagesStrategy())
            console.print(
                "[dim]using the Chromium route (--browser): "
                + ("embed-print -> " if len(strategies) > 2 else "")
                + f"scroll-print -> jsonp (embed-print uses {workers} tab(s)"
                + (", fast preset" if fast else "")
                + ")[/dim]"
            )
        scraper = ScribdScraper(
            fetcher,
            strategies=strategies,
            markdown=args.markdown,
            want_images=args.images,
            keep_images=args.keep_images,
            images_dir=str(out_dir / "_pages"),
            log=lambda m: console.print(f"[dim]{m}[/dim]"),
        )

        ok = 0
        skipped = 0
        failed = 0
        done = 0
        counter_lock = asyncio.Lock()
        skip_existing = not bool(getattr(args, "overwrite", False))

        async def download_one(url: str) -> None:
            nonlocal ok, skipped, failed, done
            async with counter_lock:
                done += 1
                position = done
            label_url = f"\n[bold cyan]{url}[/bold cyan] [dim]({position}/{len(urls)})[/dim]"

            if skip_existing:
                already = existing_pdf(out_dir, url)
                if already is not None:
                    async with counter_lock:
                        skipped += 1
                    console.print(f"{label_url} [dim]already there: {already.name}[/dim]")
                    append_manifest(
                        out_dir,
                        {"url": url, "doc_id": doc_id_of(url), "status": "skipped",
                         "file": already.name},
                    )
                    return

            console.print(label_url)
            try:
                doc = await scraper.scrape(url)
            except ScrapeError as exc:
                async with counter_lock:
                    failed += 1
                append_manifest(
                    out_dir,
                    {"url": url, "doc_id": doc_id_of(url), "status": "failed",
                     "error": str(exc)[:300]},
                )
                console.print(f"[red]FAILED[/red] {exc}")
                if "anti-bot" in str(exc) or "Client Challenge" in str(exc):
                    console.print(
                        "[yellow]Blocked by Scribd's bot protection. Try:\n"
                        "  pip install curl_cffi\n"
                        "  re-run with --impersonate chrome --no-cache\n"
                        "If it persists, your IP may be rate-limited — wait a "
                        "while, or use --proxy with your own proxy.[/yellow]"
                    )
                return
            except Exception as exc:  # one document must not kill the batch
                async with counter_lock:
                    failed += 1
                append_manifest(
                    out_dir,
                    {"url": url, "doc_id": doc_id_of(url), "status": "failed",
                     "error": f"{type(exc).__name__}: {exc}"[:300]},
                )
                console.print(
                    f"[red]FAILED[/red] {url} — {type(exc).__name__}: {exc}"[:300]
                )
                return
            written = write_all(doc, out_dir, formats)
            if not written:
                # e.g. "-f pdf" on a text-only result: nothing was saved,
                # so do NOT count this as a success.
                async with counter_lock:
                    failed += 1
                append_manifest(
                    out_dir,
                    {"url": url, "doc_id": doc_id_of(url), "status": "failed",
                     "error": f"nothing written for formats {args.format}"},
                )
                console.print(
                    f"[red]FAILED[/red] {url} — nothing written for formats "
                    f"{args.format}"
                    + (
                        " (no PDF available: the download endpoint refused and "
                        "page images could not be assembled — see the notes above)"
                        if "pdf" in formats
                        else ""
                    )
                )
                return
            async with counter_lock:
                ok += 1
            append_manifest(
                out_dir,
                {
                    "url": url,
                    "doc_id": doc.meta.doc_id or doc_id_of(url),
                    "title": doc.meta.title,
                    "status": "ok",
                    "strategy": doc.strategy,
                    "complete": doc.complete,
                    "pages": len(doc.pages),
                    "pdf_bytes": len(doc.pdf) if doc.pdf else 0,
                    "files": [p.name for p in written],
                },
            )
            label = doc.meta.title[:70]
            what = (
                f"PDF {len(doc.pdf):,} bytes"
                if doc.pdf
                else f"{len(doc.pages)} pages"
            )
            partial = ""
            if not doc.complete:
                partial = (
                    f" [yellow](PARTIAL {len(doc.pages)}/{doc.meta.page_count})[/yellow]"
                )
            console.print(
                f"[green]OK[/green] {label} — {what} via {doc.strategy}{partial}"
            )
            for w in written:
                console.print(f"  [dim]→ {w}[/dim]")
            if doc.pdf and "pdf" not in formats:
                console.print(
                    "  [yellow]the full document is in the PDF — add pdf to -f "
                    "(e.g. -f txt,md,pdf)[/yellow]"
                )
            elif doc.pdf and not doc.text.strip():
                console.print(
                    "  [dim]text export is empty (image-only document); the PDF "
                    "holds all pages[/dim]"
                )

        # Two textbooks at once is already two browsers with two tabs each;
        # more than that is the usual way to run a laptop out of memory.
        jobs = int(getattr(args, "jobs", 0) or 0) or (2 if queries else 1)
        jobs = max(1, min(jobs, len(urls)))
        if jobs > 1:
            console.print(
                f"[dim]downloading {len(urls)} document(s), {jobs} at a time[/dim]"
            )
            semaphore = asyncio.Semaphore(jobs)

            async def guarded(url: str) -> None:
                async with semaphore:
                    await download_one(url)

            await asyncio.gather(*(guarded(url) for url in urls))
        else:
            for url in urls:
                await download_one(url)

        summary = f"[bold]{ok} downloaded[/bold]"
        if skipped:
            summary += f", {skipped} already present"
        if failed:
            summary += f", [red]{failed} failed[/red]"
        summary += f" / {len(urls)} → {out_dir.resolve()}"
        console.print("\n" + summary)
        if (ok + skipped) and not failed:
            console.print("[dim]manifest: manifest.jsonl[/dim]")
        return 0 if (ok + skipped) and not failed else 1


def main() -> None:
    args = build_parser().parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except KeyboardInterrupt:
        sys.exit(130)
