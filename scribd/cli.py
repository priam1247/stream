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
        default="txt,md,json",
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
    if not urls:
        console.print("[red]No URLs given.[/red]")
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
    ) as fetcher:
        scraper = ScribdScraper(
            fetcher,
            markdown=args.markdown,
            want_images=args.images,
            log=lambda m: console.print(f"[dim]{m}[/dim]"),
        )
        ok = 0
        for url in urls:
            console.print(f"\n[bold cyan]{url}[/bold cyan]")
            try:
                doc = await scraper.scrape(url)
            except ScrapeError as exc:
                console.print(f"[red]FAILED[/red] {exc}")
                continue
            written = write_all(doc, out_dir, formats)
            ok += 1
            label = doc.meta.title[:70]
            console.print(
                f"[green]OK[/green] {label} — {len(doc.pages)} pages via {doc.strategy}"
            )
            for w in written:
                console.print(f"  [dim]→ {w}[/dim]")

        console.print(f"\n[bold]{ok}/{len(urls)} succeeded[/bold] → {out_dir.resolve()}")
        return 0 if ok else 1


def main() -> None:
    args = build_parser().parse_args()
    try:
        sys.exit(asyncio.run(run(args)))
    except KeyboardInterrupt:
        sys.exit(130)
