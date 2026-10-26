#!/usr/bin/env python3
"""Compile already-captured page screenshots into a clean PDF.

This is a last-resort assembly step, not a Scribd downloader: capture one
complete, authorized document page per image first. JPEG bytes are embedded
without recompression; PNG pages are preserved through scribd_download's image
pipeline. Each PDF sheet keeps that screenshot's aspect ratio and page order.

Usage:
  python tools/screenshots_to_pdf.py ./page-shots --out ./recovered.pdf
  python tools/screenshots_to_pdf.py page-01.png page-02.jpg --out recovered.pdf
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import scribd_download as sd

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}


def natural_key(path: Path) -> list[object]:
    """Sort page-2 before page-10, while keeping ordinary names predictable."""
    return [(1, int(part)) if part.isdigit() else (0, part.casefold())
            for part in re.split(r"(\d+)", path.name)]


def expand_inputs(items: list[str]) -> list[Path]:
    """A directory is natural-sorted; explicitly listed files keep user order."""
    result: list[Path] = []
    for item in items:
        path = Path(item).expanduser()
        if path.is_dir():
            found = sorted((child for child in path.iterdir()
                            if child.is_file() and child.suffix.lower() in SUPPORTED),
                           key=natural_key)
            result.extend(found)
        else:
            result.append(path)
    return result


def compile_pdf(inputs: list[str], target: str, title: str = "") -> tuple[bool, str]:
    files = expand_inputs(inputs)
    if not files:
        return False, "no supported screenshot files found"

    pages: list[dict] = []
    failures: list[str] = []
    for path in files:
        if path.suffix.lower() not in SUPPORTED:
            failures.append(f"{path}: unsupported file type")
            continue
        try:
            data = path.read_bytes()
        except OSError as exc:
            failures.append(f"{path}: {exc}")
            continue
        page = sd.scan_for_pdf(data)
        if page is None:
            failures.append(f"{path}: not a readable JPEG, PNG, or supported WebP image")
            continue
        pages.append(page)

    # Fail closed: don't silently create a PDF with a missing screenshot.
    if failures:
        return False, "\n".join(failures)
    if len(pages) != len(files):
        return False, f"loaded {len(pages)} of {len(files)} screenshots"

    ok, built = sd.build_pdf(pages, target, title=title or Path(target).stem,
                             uniform=False)
    if not ok:
        return False, built
    verified, report = sd.verify_pdf(target, expect_pages=len(pages),
                                     expect_images=len(pages), uniform=False)
    if not verified:
        try:
            os.remove(target)
        except OSError:
            pass
        return False, f"PDF verification failed: {report}"
    return True, f"{built}; {report}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile one captured page screenshot per image into a verified PDF.")
    parser.add_argument("images", nargs="+",
                        help="image files in page order, or a directory (natural filename sort)")
    parser.add_argument("--out", required=True, help="output PDF path")
    parser.add_argument("--title", default="", help="optional PDF title metadata")
    args = parser.parse_args(argv)

    target = str(Path(args.out).expanduser())
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    ok, message = compile_pdf(args.images, target, args.title)
    print(message)
    if ok:
        print(f"written: {target}")
        return 0
    print("no PDF written: every input must be readable", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
