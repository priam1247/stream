from __future__ import annotations

import argparse
import asyncio
import sys
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
        "--search-only",
        action="store_true",
        help="With --search: only list the matches (verify the search), download nothing",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=5,
        help="With --search: how many documents to download (default 5)",
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
            from .search import browser_search, find_documents

            limit = max(1, int(getattr(args, "limit", 5) or 5))
            pages = max(1, int(getattr(args, "search_pages", 3) or 3))
            found_any = 0
            for query in queries:
                console.print(f"\n[bold]search:[/bold] {query!r} (limit {limit})")
                hits = []
                try:
                    hits = await find_documents(
                        fetcher,
                        query,
                        limit=limit,
                        pages=pages,
                        debug_dir=".debug",
                        log=lambda m: console.print(f"[dim]  {m}[/dim]"),
                    )
                except Exception as exc:
                    console.print(
                        f"[red]  http search failed: {type(exc).__name__}: {exc}[/red]"[:300]
                    )

                if len(hits) < limit:
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
                            limit=limit,
                            pages=pages,
                            debug_dir=".debug",
                            log=lambda m: console.print(f"[dim]  {m}[/dim]"),
                        )
                    except Exception as exc:
                        browser_hits = []
                        console.print(
                            f"[yellow]  browser search failed: "
                            f"{type(exc).__name__}: {exc}[/yellow]"[:300]
                        )
                    seen = {hit.doc_id for hit in hits}
                    for hit in browser_hits:
                        if len(hits) >= limit:
                            break
                        if hit.doc_id in seen:
                            continue
                        seen.add(hit.doc_id)
                        hits.append(hit)

                if not hits:
                    console.print("[yellow]  no matching documents[/yellow]")
                    continue
                for number, hit in enumerate(hits, start=1):
                    console.print(
                        f"  [cyan]{number}.[/cyan] {hit.title[:70]} — {hit.url}"
                    )
                found_any += len(hits)
                urls.extend(hit.url for hit in hits)
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
        done = 0
        counter_lock = asyncio.Lock()

        async def download_one(url: str) -> None:
            nonlocal ok, done
            async with counter_lock:
                done += 1
                position = done
            console.print(
                f"\n[bold cyan]{url}[/bold cyan] "
                f"[dim]({position}/{len(urls)})[/dim]"
            )
            try:
                doc = await scraper.scrape(url)
            except ScrapeError as exc:
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
                console.print(
                    f"[red]FAILED[/red] {url} — {type(exc).__name__}: {exc}"[:300]
                )
                return
            written = write_all(doc, out_dir, formats)
            if not written:
                # e.g. "-f pdf" on a text-only result: nothing was saved,
                # so do NOT count this as a success.
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

        jobs = int(getattr(args, "jobs", 0) or 0) or (3 if queries else 1)
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

        console.print(f"\n[bold]{ok}/{len(urls)} succeeded[/bold] → {out_dir.resolve()}")
        return 0 if ok else 1


def main() -> None:
    args = build_parser().parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except KeyboardInterrupt:
        sys.exit(130)
