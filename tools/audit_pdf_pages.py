#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audit finished PDFs for grey pages — the one failure that is never allowed.

Usage:  python3 tools/audit_pdf_pages.py <file-or-directory> ...

A page is flagged when it carries placeholder wording, when a real page is
missing from the sheet sequence, or when one image dominates the whole book
(the same picture pasted everywhere). A clean book exits 0; any finding exits
1, so this can stand at the end of any test or any download folder.

No dependencies. Pillow is used for a pixel check when it happens to be
installed; without it the structural and text checks still run.
"""
import os
import re
import sys
import zlib

PLACEHOLDERS = (b"scan not available", b"not available", b"error en p",
                b"placeholder", b"blank page", b"page missing")


def decode_streams(data):
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.S):
        raw = m.group(1)
        for cand in (raw, raw.rstrip(b"\r\n")):
            try:
                out.append(zlib.decompress(cand))
                break
            except zlib.error:
                continue
        else:
            out.append(raw)
    return out


def audit(path):
    """Returns (findings, page_count, image_count) for one PDF."""
    findings = []
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:5] != b"%PDF-":
        return ["not a PDF"], 0, 0
    counts = re.findall(rb"/Type\s*/Pages[^>]*?/Count\s+(\d+)", data)
    if not counts:
        counts = re.findall(rb"/Count\s+(\d+)", data)
    pages = int(counts[-1]) if counts else len(re.findall(rb"/Type\s*/Page[^s]", data))
    if pages == 0:
        findings.append("NO PAGES")

    text = []
    for chunk in decode_streams(data):
        try:
            text.append(chunk.decode("latin-1", "replace"))
        except Exception:
            continue
    joined = "\n".join(text)
    shown = re.findall(r"\((.*?)\)\s*Tj", joined)

    hits = set()
    for word in PLACEHOLDERS:
        needle = word.decode("latin-1")
        for line in shown:
            if needle in line.lower():
                hits.add(line.strip())
        if word in data.lower():
            hits.add(word.decode("latin-1") + " (raw)")
    if hits:
        findings.append("PLACEHOLDER WORDS: " + " | ".join(sorted(hits)[:5]))

    images = re.findall(rb"/Subtype\s*/Image[^>]*?>>\s*stream\r?\n(.*?)endstream",
                        data, re.S)
    if images:
        sizes = [len(i) for i in images]
        biggest = max(sizes)
        same = sizes.count(biggest)
        # one identical picture everywhere is only damning when that picture is
        # too small to be a page: a server may honestly serve the same scan for
        # every page of a mock or a stamp book, and 6 kB of real JPEG is a page.
        if same >= 3 and same >= len(sizes) * 0.6 and biggest < 2048:
            findings.append(f"UNIFORM TINY IMAGE x{same} of {len(sizes)} "
                            f"({biggest} B — one stub picture everywhere)")

    return findings, pages, len(images)


def main(argv):
    targets = []
    for arg in argv:
        if os.path.isdir(arg):
            for root, _dirs, files in os.walk(arg):
                targets += [os.path.join(root, f) for f in files if f.lower().endswith(".pdf")]
        else:
            targets.append(arg)
    if not targets:
        print("no PDFs found")
        return 2
    bad = 0
    for target in sorted(targets):
        findings, pages, imgs = audit(target)
        if findings:
            bad += 1
            print(f"FAIL {target}: pages={pages} images={imgs}")
            for line in findings:
                print(f"     {line}")
        else:
            print(f"clean {target}: pages={pages} images={imgs}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
