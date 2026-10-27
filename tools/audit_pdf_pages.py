#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audit finished PDFs for grey pages — the one failure that is never allowed.

Usage:  python3 tools/audit_pdf_pages.py <file-or-directory> ...

A page is flagged when it carries placeholder wording, when a sheet carries
neither a picture nor any words, when a pictureless sheet carries too few words
to be a page (a blank sheet with writing on it), when a real page is missing
from the sheet
sequence, or when one image dominates the whole book (the same picture pasted
everywhere). A clean book exits 0; any finding exits 1, so this can stand at
the end of any test or any download folder.

No dependencies. Pillow is used for the ink measure --compare prints when it
happens to be installed; without it the structural and text checks still run.
"""
import os
import re
import sys
import zlib

PLACEHOLDERS = (b"scan not available", b"not available", b"error en p",
                b"placeholder", b"blank page", b"page missing")

# A sheet with no picture on it and fewer characters of words than this is a
# blank page that happens to have writing on it. A live run shipped exactly
# that: page 1 of a 258-page textbook as seven glyph fragments, 26 characters,
# and this audit called the book clean because the sheet had *some* Tj on it.
MIN_SHEET_CHARS = 100


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
        # A photographed page carries megabytes of pixels, and a lazy regex over
        # all of them takes longer than building the book did. Only a content
        # stream can hold the words a sheet draws, and one is a few kilobytes —
        # so the pixel streams are skipped, not read and searched.
        if len(chunk) > 262144 or (b"Tj" not in chunk and b"TJ" not in chunk):
            continue
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

    # Parsed as objects, not matched with one regex: an image dictionary carries
    # a nested /DecodeParms << … >>, and a pattern that stops at the first ">>"
    # finds no images at all in a PDF this engine writes — which quietly disarmed
    # the very check below, the one that catches a stub picture pasted on every
    # page of a book.
    objs = parse_objects(data)
    images = [body for head, body in objs.values()
              if b"/Subtype" in head and b"/Image" in head and body]
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

    # A sheet with no picture on it and no words drawn on it is a blank page —
    # the one thing that must never reach a finished book. Read off the page's
    # own content stream, so it costs no pixels and still holds on a 400-page
    # book: a picture is an XObject Do, and words are a Tj or a TJ.
    kids = re.search(rb"/Kids\s*\[(.*?)\]", data, re.S)
    blanks = []
    thin = []
    if kids:
        numbers = [int(x) for x in re.findall(rb"(\d+)\s+0\s+R", kids.group(1))]
        for index, number in enumerate(numbers, 1):
            head, _body = objs.get(number, (b"", b""))
            mcon = re.search(rb"/Contents\s+(\d+)\s+0\s+R", head)
            content = objs[int(mcon.group(1))][1] \
                if mcon and int(mcon.group(1)) in objs else b""
            try:
                content = zlib.decompress(content)
            except zlib.error:
                pass
            if b" Do" not in content and b"Tj" not in content \
                    and b"TJ" not in content:
                blanks.append(index)
            elif b" Do" not in content:
                drawn = b"".join(re.findall(rb"\(((?:[^()\\]|\\.)*)\)", content))
                for esc, plain in ((b"\\(", b"("), (b"\\)", b")"),
                                   (b"\\\\", b"\\")):
                    drawn = drawn.replace(esc, plain)
                chars = len(re.sub(rb"\s+", b"", drawn))
                if chars < MIN_SHEET_CHARS:
                    thin.append((index, chars))
    if thin:
        shown = ", ".join(f"{n} ({c} characters)" for n, c in thin[:8])
        findings.append(f"NEAR-BLANK SHEET: page(s) {shown}"
                        + (f" and {len(thin) - 8} more" if len(thin) > 8 else "")
                        + " carry no picture and too few words to be a page")
    if blanks:
        shown = ", ".join(str(n) for n in blanks[:8])
        findings.append(f"BLANK SHEET: page(s) {shown}"
                        + (f" and {len(blanks) - 8} more" if len(blanks) > 8 else "")
                        + " carry no picture and no words")

    return findings, pages, len(images)


def parse_objects(data):
    """object number -> (dict bytes, stream body), nesting honoured."""
    objs = {}
    for m in re.finditer(rb"(\d+) 0 obj\s*", data):
        num = int(m.group(1))
        i = m.end()
        if not data.startswith(b"<<", i):
            continue
        depth, j = 0, i
        while j < len(data):
            if data.startswith(b"<<", j):
                depth += 1; j += 2
            elif data.startswith(b">>", j):
                depth -= 1; j += 2
                if depth == 0:
                    break
            else:
                j += 1
        d = data[i:j]
        body = b""
        k = data.find(b"stream", j)
        if k != -1 and k - j < 8:
            t = k + 6
            if data[t:t + 2] == b"\r\n":
                t += 2
            elif data[t:t + 1] in (b"\n", b"\r"):
                t += 1
            e = data.find(b"endstream", t)
            body = data[t:e].rstrip(b"\r\n")
        objs[num] = (d, body)
    return objs


def page_rows(path):
    """One honest row per page, in reading order: what carries the page,
    how big its picture is, how many strings it draws, and (with Pillow)
    how much ink is on it."""
    with open(path, "rb") as handle:
        data = handle.read()
    objs = parse_objects(data)
    kids = re.search(rb"/Kids\s*\[(.*?)\]", data, re.S)
    pages = [int(x) for x in re.findall(rb"(\d+)\s+0\s+R", kids.group(1))] \
        if kids else []
    rows = []
    for i, pnum in enumerate(pages, 1):
        d, _ = objs.get(pnum, (b"", b""))
        mres = re.search(rb"/Resources\s+(\d+)\s+0\s+R", d)
        rd = objs[int(mres.group(1))][0] if mres and int(mres.group(1)) in objs else d
        mim = re.search(rb"/Im0\s+(\d+)\s+0\s+R", rd)
        imnum = int(mim.group(1)) if mim else None
        mcon = re.search(rb"/Contents\s+(\d+)\s+0\s+R", d)
        body = objs[int(mcon.group(1))][1] if mcon and int(mcon.group(1)) in objs else b""
        try:
            content = zlib.decompress(body)
        except zlib.error:
            content = body
        strings = len(re.findall(rb"\)\s*Tj", content))
        hidden = b"3 Tr" in content
        has_img = b"/Im0 Do" in content and imnum is not None
        kind = ("img+hidden" if has_img and hidden else
                "image" if has_img else
                "hidden-text" if hidden else
                "words-sheet" if strings else "empty")
        w = h = nb = 0
        ink = None
        if imnum is not None and imnum in objs:
            idict, ibody = objs[imnum]
            mw = re.search(rb"/Width\s+(\d+)", idict)
            mh = re.search(rb"/Height\s+(\d+)", idict)
            w = int(mw.group(1)) if mw else 0
            h = int(mh.group(1)) if mh else 0
            nb = len(ibody)
            mc = re.search(rb"/Colors\s+(\d+)", idict)
            colors = int(mc.group(1)) if mc else (1 if b"/DeviceGray" in idict else 3)
            mp = re.search(rb"/Indexed\s*/DeviceRGB\s+\d+\s*<([0-9A-Fa-f\s]+)>",
                           idict)
            palette = b""
            if mp:
                try:
                    palette = bytes.fromhex(re.sub(rb"\s+", b"", mp.group(1)).decode())
                except ValueError:
                    palette = b""
            ink = pixel_ink(ibody, w, h, colors=colors, palette=palette,
                            predictor=b"/Predictor" in idict)
        rows.append({"page": i, "kind": kind, "w": w, "h": h,
                     "bytes": nb, "strings": strings, "ink": ink})
    return rows


def pixel_ink(body, w, h, colors=3, palette=b"", predictor=False):
    """Share of pixels darker than near-white, if Pillow is installed."""
    try:
        import io
        import struct
        from PIL import Image
        if body[:2] == b"\xff\xd8":
            im = Image.open(io.BytesIO(body)).convert("L")
        elif predictor and w and h:
            # /Predictor 15 rows are PNG scanlines, filter byte and all, so they
            # go back inside a PNG and Pillow undoes the filters. Guessing a
            # stride instead reads a real page as noise — and an ink measure
            # that is always None is a grey page nobody would ever catch.
            def chunk(tag, payload):
                return (struct.pack(">I", len(payload)) + tag + payload +
                        struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

            # IDAT holds a zlib stream of the filtered rows, which is exactly
            # what a PDF /FlateDecode stream already is — so the body goes in as
            # it came, and only a stream that is not zlib gets compressed here.
            try:
                zlib.decompress(body)
                idat = body
            except zlib.error:
                idat = zlib.compress(body)
            head = struct.pack(">IIBBBBB", w, h, 8,
                               3 if palette else (2 if colors == 3 else 0), 0, 0, 0)
            png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) +
                   (chunk(b"PLTE", palette) if palette else b"") +
                   chunk(b"IDAT", idat) + chunk(b"IEND", b""))
            im = Image.open(io.BytesIO(png)).convert("L")
        else:
            raw = zlib.decompress(body)
            stride = w * colors + 1
            if len(raw) == stride * h:
                raw = b"".join(raw[r * stride + 1:(r + 1) * stride]
                               for r in range(h))
            im = Image.frombytes("RGB" if colors == 3 else "L", (w, h),
                                 raw[:w * h * colors]).convert("L")
        # the histogram is the same count without walking every pixel in
        # Python: a photographed sheet is millions of them
        hist = im.histogram()
        return sum(hist[:200]) / max(1, sum(hist))
    except Exception:
        return None


def compare(paths):
    left, right = page_rows(paths[0]), page_rows(paths[1])
    for name, rows in zip(paths, (left, right)):
        kinds = {}
        for row in rows:
            kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
        sizes = {(r["w"], r["h"]) for r in rows if r["w"]}
        print(f"{name}: {len(rows)} page(s) · " +
              ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())) +
              (f" · image size(s): " +
               ", ".join(f"{w}x{h}" for w, h in sorted(sizes)) if sizes else ""))
    print(f"{'page':>4}  {'left':<26}  {'right':<26}")
    for i in range(max(len(left), len(right))):
        a = left[i] if i < len(left) else None
        b = right[i] if i < len(right) else None
        def cell(row):
            if not row:
                return "missing"
            ink = f" ink={row['ink']*100:.1f}%" if row["ink"] is not None else ""
            size = f" {row['w']}x{row['h']}" if row["w"] else ""
            return f"{row['kind']}{size}{ink}"
        print(f"{i+1:>4}  {cell(a):<26}  {cell(b):<26}")
    return 0


def main(argv):
    if "--compare" in argv:
        rest = [a for a in argv if a != "--compare"]
        if len(rest) != 2:
            print("compare needs exactly two PDFs")
            return 2
        return compare(rest)
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
