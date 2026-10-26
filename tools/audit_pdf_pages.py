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
            ink = pixel_ink(ibody, w, h)
        rows.append({"page": i, "kind": kind, "w": w, "h": h,
                     "bytes": nb, "strings": strings, "ink": ink})
    return rows


def pixel_ink(body, w, h):
    """Share of pixels darker than near-white, if Pillow is installed."""
    try:
        import io
        from PIL import Image
        if body[:2] == b"\xff\xd8":
            im = Image.open(io.BytesIO(body)).convert("L")
        else:
            raw = zlib.decompress(body)
            stride = w * 3 + 1
            if len(raw) == stride * h:
                raw = b"".join(raw[r * stride + 1:(r + 1) * stride]
                               for r in range(h))
            im = Image.frombytes("RGB", (w, h), raw[:w * h * 3]).convert("L")
        px = im.get_flattened_data() if hasattr(im, "get_flattened_data") \
            else im.getdata()
        vals = list(px)
        return sum(1 for v in vals if v < 200) / max(1, len(vals))
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
