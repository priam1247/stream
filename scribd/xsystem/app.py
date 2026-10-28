#!/usr/bin/env python3
"""Scribd file server — XS Systems side.

This box is for downloading only. It has no browser and never downloads
Chromium; the screenshots are taken on the Node server (Botkeep), which hands
each finished PDF here. This service stores those PDFs and serves them back.

Standard library only: nothing to pip install, so it starts on any Python.

    python app.py              serve (binds 0.0.0.0:25811 + SERVER_PORT)
    python app.py --selftest   offline checks
    python app.py --health     print health JSON and exit

Routes
    GET  /health            service state
    GET  /diag              where files live, storage used
    GET  /files             {"files": [{name, bytes, age, mtime}]}
    GET  /file/<name>       download one PDF
    POST /upload?name=...   accept a finished PDF from anywhere
    GET  /send?url=...      download documents: ask the Node server for the page
                            images, build the PDF here, store it, answer with a
                            heading the sender reads
    POST /send              same, for a JSON body {"urls": [...]}
    POST /reset             delete every stored PDF
    GET  /                  a plain page to download what is stored

There is no page limit, no file limit and no upload limit here: a document is
whatever the shot server manages to photograph, and that is what gets built.
"""

from __future__ import annotations

import html
import io
import json
import os
import re
import shutil
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "4.0.0"
HOST = "0.0.0.0"
DEFAULT_PORT = 25811


def out_dir() -> Path:
    raw = (os.environ.get("SCRIBD_OUT") or "").strip()
    return Path(raw).expanduser() if raw else HERE / "downloads"


def panel_key() -> str:
    return (os.environ.get("SCRIBD_PANEL_KEY") or os.environ.get("PANEL_KEY") or "").strip()


def ports() -> list[int]:
    found = [DEFAULT_PORT]
    for name in ("SCRIBD_PANEL_PORT", "SERVER_PORT", "PORT"):
        raw = (os.environ.get(name) or "").strip()
        if raw.isdigit() and 1 <= int(raw) <= 65535 and int(raw) not in found:
            found.append(int(raw))
    return found


def safe_name(raw: str) -> str:
    name = Path(str(raw or "")).name
    name = "".join(ch for ch in name if ch.isalnum() or ch in "._ -()[]").strip(" .")
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:150]


def listing(folder: Path) -> list[dict]:
    items = []
    try:
        for item in sorted(folder.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True):
            stat = item.stat()
            age = max(0, int(time.time() - stat.st_mtime))
            items.append(
                {
                    "name": item.name,
                    "bytes": stat.st_size,
                    # Epoch seconds: what the dashboard formats for "when".
                    "when": int(stat.st_mtime),
                    "size": f"{stat.st_size / 1024:.0f} KiB",
                    "age": f"{age // 60} min ago" if age < 3600 else f"{age // 3600} h ago",
                    "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
                }
            )
    except OSError:
        pass
    return items


# ---------------------------------------------------------------------------
# page images, however they arrive
# ---------------------------------------------------------------------------
# A screenshot is a picture. Nothing here reads lines, headers, offsets or a
# manifest: the body is searched for the pictures it contains, and every one of
# them becomes a page. That is why a length-prefixed container, a zip, a bare
# multipart body and a single image all work without being told apart.
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


def _jpeg_end(data: bytes, start: int) -> int:
    """One past the end of the JPEG that starts at `start` (its FFD9)."""
    at = start + 2
    limit = len(data)
    while at < limit - 1:
        if data[at] == 0xFF and data[at + 1] == 0xD9:
            return at + 2
        at += 1
    return limit


def _png_end(data: bytes, start: int) -> int:
    """One past the end of the PNG that starts at `start` (after IEND + CRC)."""
    # Start after the 8-byte signature: the chunks begin there, and the first
    # four bytes of a PNG are not a chunk length.
    at = start + 8
    limit = len(data)
    while at + 8 <= limit:
        length = struct.unpack(">I", data[at:at + 4])[0]
        kind = data[at + 4:at + 8]
        nxt = at + 8 + length + 4
        if kind == b"IEND":
            return min(nxt, limit)
        if nxt <= at or nxt > limit:
            return limit
        at = nxt
    return limit


def page_images(body: bytes) -> list[bytes]:
    """Every complete picture inside `body`, in the order it appears."""
    if not body:
        return []
    # A zip of pictures is still just pictures.
    if body[:4] == b"PK\x03\x04":
        try:
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                names = sorted(
                    (info for info in archive.infolist() if not info.is_dir()),
                    key=lambda info: [
                        int(part) if part.isdigit() else part
                        for part in re.split(r"(\d+)", info.filename)
                    ],
                )
                found = []
                for info in names:
                    blob = archive.read(info)
                    if blob[:8] == PNG_MAGIC or blob[:3] == JPEG_MAGIC:
                        found.append(blob)
                return found
        except (zipfile.BadZipFile, OSError, RuntimeError):
            pass

    found: list[bytes] = []
    at = 0
    limit = len(body)
    while at < limit:
        png = body.find(PNG_MAGIC, at)
        jpg = body.find(JPEG_MAGIC, at)
        if png < 0 and jpg < 0:
            break
        if png >= 0 and (jpg < 0 or png < jpg):
            end = _png_end(body, png)
            found.append(body[png:end])
            at = end
        else:
            end = _jpeg_end(body, jpg)
            found.append(body[jpg:end])
            at = end
    return found


def image_size(blob: bytes) -> tuple[int, int]:
    """(width, height) of a PNG or JPEG, read from the picture itself."""
    if blob[:8] == PNG_MAGIC:
        width, height = struct.unpack(">II", blob[16:24])
        return int(width), int(height)
    if blob[:3] == JPEG_MAGIC:
        at = 2
        limit = len(blob)
        while at + 9 < limit:
            if blob[at] != 0xFF:
                at += 1
                continue
            marker = blob[at + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                at += 2
                continue
            length = struct.unpack(">H", blob[at + 2:at + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", blob[at + 5:at + 9])
                return int(width), int(height)
            at += 2 + max(length, 2)
    raise ValueError("that picture has no size in it")


def png_to_rgb(blob: bytes) -> tuple[int, int, bytes]:
    """Decode a PNG to 8-bit RGB, flattening any transparency onto white."""
    if blob[:8] != PNG_MAGIC:
        raise ValueError("not a PNG")
    at = 8
    limit = len(blob)
    width = height = 0
    depth = colour = 0
    interlace = 0
    palette = b""
    alpha_table = b""
    idat = bytearray()
    while at + 8 <= limit:
        length = struct.unpack(">I", blob[at:at + 4])[0]
        kind = blob[at + 4:at + 8]
        data = blob[at + 8:at + 8 + length]
        at += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _compression, _filter, interlace = struct.unpack(">IIBBBBB", data)
        elif kind == b"PLTE":
            palette = data
        elif kind == b"tRNS":
            alpha_table = data
        elif kind == b"IDAT":
            idat += data
        elif kind == b"IEND":
            break
    if not width or not height:
        raise ValueError("this PNG has no size")
    if interlace:
        raise ValueError("this PNG is interlaced")
    if depth not in (8, 16):
        raise ValueError(f"this PNG is {depth}-bit")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour)
    if channels is None:
        raise ValueError(f"this PNG has colour type {colour}")
    raw = zlib.decompress(bytes(idat))
    step = channels * (depth // 8)
    stride = width * step
    out = bytearray()
    previous = bytearray(stride)
    pos = 0
    for _row in range(height):
        if pos >= len(raw):
            raise ValueError("this PNG stops early")
        kind_filter = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        if len(line) < stride:
            raise ValueError("this PNG stops early")
        pos += stride
        if kind_filter == 1:  # Sub
            for i in range(step, stride):
                line[i] = (line[i] + line[i - step]) & 0xFF
        elif kind_filter == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind_filter == 3:  # Average
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind_filter == 4:  # Paeth
            for i in range(stride):
                a = line[i - step] if i >= step else 0
                b = previous[i]
                c = previous[i - step] if i >= step else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif kind_filter != 0:
            raise ValueError(f"this PNG uses filter {kind_filter}")
        previous = line
        # -> RGB8
        if depth == 16:
            samples = line[0::2]
        else:
            samples = line
        if colour == 2:
            out += samples
        elif colour == 6:
            for i in range(0, len(samples), 4):
                r, g, b, a = samples[i], samples[i + 1], samples[i + 2], samples[i + 3]
                if a == 255:
                    out += bytes((r, g, b))
                else:
                    out += bytes((
                        (r * a + 255 * (255 - a)) // 255,
                        (g * a + 255 * (255 - a)) // 255,
                        (b * a + 255 * (255 - a)) // 255,
                    ))
        elif colour == 0:
            for value in samples:
                out += bytes((value, value, value))
        elif colour == 4:
            for i in range(0, len(samples), 2):
                value, a = samples[i], samples[i + 1]
                if a == 255:
                    out += bytes((value, value, value))
                else:
                    mixed = (value * a + 255 * (255 - a)) // 255
                    out += bytes((mixed, mixed, mixed))
        elif colour == 3:
            for value in samples:
                base = value * 3
                r, g, b = palette[base], palette[base + 1], palette[base + 2]
                a = alpha_table[value] if value < len(alpha_table) else 255
                if a == 255:
                    out += bytes((r, g, b))
                else:
                    out += bytes((
                        (r * a + 255 * (255 - a)) // 255,
                        (g * a + 255 * (255 - a)) // 255,
                        (b * a + 255 * (255 - a)) // 255,
                    ))
    return width, height, bytes(out)


def build_pdf(images: list[bytes], target: Path) -> int:
    """Write one page per picture. Returns the page count."""
    if not images:
        raise ValueError("no pictures to build a page from")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".part")
    offsets: dict[int, int] = {}
    count = len(images)

    def place(handle, number: int, body: bytes) -> None:
        offsets[number] = handle.tell()
        handle.write(f"{number} 0 obj\n".encode("ascii"))
        handle.write(body)
        handle.write(b"\nendobj\n")

    with temporary.open("wb") as handle:
        handle.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        kids = []
        number = 3
        for blob in images:
            width, height = image_size(blob)
            points_w = round(width * 0.75, 2)
            points_h = round(height * 0.75, 2)
            if blob[:8] == PNG_MAGIC:
                _w, _h, rgb = png_to_rgb(blob)
                data = zlib.compress(rgb, 6)
                filter_name = b"/FlateDecode"
            else:
                data = blob
                filter_name = b"/DCTDecode"
            content = f"q {points_w} 0 0 {points_h} 0 0 cm /Im0 Do Q".encode("ascii")
            place(handle, number, b"<< /Length " + str(len(content)).encode() +
                  b" >>\nstream\n" + content + b"\nendstream")
            content_no = number
            number += 1
            place(handle, number,
                  b"<< /Type /XObject /Subtype /Image /Width " + str(width).encode() +
                  b" /Height " + str(height).encode() +
                  b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter " + filter_name +
                  b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data +
                  b"\nendstream")
            image_no = number
            number += 1
            place(handle, number,
                  b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
                  f"{points_w} {points_h}".encode() + b"] /Resources << /XObject << /Im0 " +
                  str(image_no).encode() + b" 0 R >> >> /Contents " +
                  str(content_no).encode() + b" 0 R >>")
            kids.append(number)
            number += 1
        place(handle, 2, b"<< /Type /Pages /Count " + str(count).encode() +
              b" /Kids [" + b" ".join(f"{kid} 0 R".encode() for kid in kids) + b"] >>")
        place(handle, 1, b"<< /Type /Catalog /Pages 2 0 R >>")

        start = handle.tell()
        total = number
        handle.write(f"xref\n0 {total}\n".encode("ascii"))
        handle.write(b"0000000000 65535 f \n")
        for obj in range(1, total):
            handle.write(f"{offsets.get(obj, 0):010d} 00000 n \n".encode("ascii"))
        handle.write(b"trailer\n<< /Size " + str(total).encode() +
                     b" /Root 1 0 R >>\nstartxref\n" + str(start).encode() + b"\n%%EOF\n")
    os.replace(temporary, target)
    return count


# ---------------------------------------------------------------------------
# asking the Node server for those pictures
# ---------------------------------------------------------------------------
DEFAULT_SHOT_URL = "http://node6.botkeep.cloud:45009"
SHOT_CANDIDATES = (DEFAULT_SHOT_URL, "http://127.0.0.1:8096", "http://127.0.0.1:45009")

_document_re = re.compile(
    r"/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/(\d+)", re.I)


def document_id(raw: str) -> str:
    text = str(raw or "").strip()
    found = _document_re.search(text)
    if found:
        return found.group(1)
    digits = re.sub(r"\D", "", text)
    return digits if len(digits) >= 3 else ""


def fetch_bytes(url: str, timeout: float = 600.0) -> tuple[int, bytes]:
    """GET, and read the whole answer. No length limit: a book is a book."""
    request = urllib.request.Request(url, headers={
        "User-Agent": f"ScribdStore/{VERSION}",
        "Accept": "*/*",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return answer.status, answer.read()
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()
        except OSError:
            pass
        return exc.code, body


_shot_base: str = ""


def shot_base() -> str:
    """The Node server that photographs pages. Found once, then remembered."""
    global _shot_base
    if _shot_base:
        return _shot_base
    wanted = [
        (os.environ.get("SCRIBD_SHOT_URL") or "").strip(),
        *SHOT_CANDIDATES,
    ]
    for candidate in wanted:
        if not candidate:
            continue
        base = candidate.rstrip("/")
        try:
            status, _body = fetch_bytes(base + "/health", timeout=5.0)
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if status == 200:
            _shot_base = base
            return base
    return ""


def pictures_for(ident: str) -> tuple[list[bytes], list[str]]:
    """Every page picture for one document, plus what went wrong on the way."""
    base = shot_base()
    if not base:
        return [], ["no answer from the Node server — it photographs the pages"]
    notes: list[str] = []

    # One pass over the whole book is the fast way in.
    try:
        status, body = fetch_bytes(f"{base}/shots?doc={ident}&pages=0")
        if status == 200:
            whole = page_images(body)
            if whole:
                return whole, notes
            notes.append("the one pass returned no picture")
        else:
            notes.append(f"the one pass answered HTTP {status}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        notes.append(f"the one pass failed: {exc}")

    # Then page by page, with no ceiling: it stops when the server refuses,
    # not when a number says so.
    found: list[bytes] = []
    page = 1
    while True:
        try:
            status, body = fetch_bytes(f"{base}/shot?doc={ident}&page={page}")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            notes.append(f"page {page} failed: {exc}")
            break
        if status != 200:
            if page == 1:
                notes.append(f"page 1 answered HTTP {status}")
            break
        shots = page_images(body)
        if not shots:
            break
        found.extend(shots)
        page += 1
    return found, notes


def download_documents(urls: list[str]) -> dict:
    """Photograph each document, build the PDF here, store it. -> report."""
    folder = out_dir()
    folder.mkdir(parents=True, exist_ok=True)
    stored: list[dict] = []
    failed: list[dict] = []

    for raw in urls:
        ident = document_id(raw)
        if not ident:
            failed.append({"url": raw, "reason": "no document id in that link"})
            continue
        pictures, notes = pictures_for(ident)
        if not pictures:
            failed.append({"url": raw, "reason": "; ".join(notes) or "no pages came back"})
            continue
        name = safe_name(f"document-{ident}.pdf")
        try:
            pages = build_pdf(pictures, folder / name)
        except (ValueError, OSError) as exc:
            failed.append({"url": raw, "reason": f"could not build the PDF: {exc}"})
            continue
        size = (folder / name).stat().st_size
        stored.append({"name": name, "pages": pages, "bytes": size,
                       "note": "; ".join(notes)})

    return {"stored": stored, "failed": failed,
            "pages": sum(item["pages"] for item in stored),
            "bytes": sum(item["bytes"] for item in stored)}


def send_page(report: dict) -> str:
    """The reply: a heading the sender reads, then the detail."""
    stored, failed = report["stored"], report["failed"]
    if stored and not failed:
        heading = (f"stored {len(stored)} document(s) · {report['pages']} page(s) · "
                   f"{report['bytes'] // 1024} KiB")
    elif stored:
        heading = (f"stored {len(stored)} of {len(stored) + len(failed)} · "
                   f"{report['pages']} page(s)")
    elif failed:
        heading = f"failed: {failed[0]['reason']}"
    else:
        heading = "nothing to download"
    rows = "".join(
        f'<li><a href="/file/{urllib.parse.quote(item["name"])}">{item["name"]}</a> '
        f'— {item["pages"]} page(s), {item["bytes"] // 1024} KiB</li>'
        for item in stored
    )
    bad = "".join(f"<li>{html.escape(item['url'])} — {html.escape(item['reason'])}</li>"
                  for item in failed)
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        "<title>download</title></head><body>"
        f"<h1>{html.escape(heading)}</h1>"
        + (f"<ul>{rows}</ul>" if rows else "")
        + (f"<p>did not store:</p><ul>{bad}</ul>" if bad else "")
        + "</body></html>"
    )


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scribd downloads</title><style>
:root{color-scheme:dark}body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#0b0d12;color:#e7ebf3}
main{max-width:860px;margin:0 auto;padding:24px}h1{font-size:16px;margin:0 0 4px}
p{color:#8d99ad;font-size:13px;margin:0 0 18px}
a{color:#7fb0ff}li{list-style:none;padding:10px 12px;border:1px solid #1c2330;border-radius:9px;
margin-bottom:8px;background:#0f131b;display:flex;justify-content:space-between;gap:12px}
ul{padding:0;margin:0}.m{color:#8d99ad;font-size:13px}
</style></head><body><main><h1>Scribd downloads</h1>
<p>__COUNT__ file(s) stored on this server. Screenshots run on the other server.</p>
<ul>__LIST__</ul></main></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = f"ScribdStore/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        sys.stderr.write("[store] %s\n" % (fmt % args))

    # -- helpers ----------------------------------------------------------
    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _html(self, status: int, page: str) -> None:
        payload = page.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _authorised(self) -> bool:
        key = panel_key()
        if not key:
            return True
        return (self.headers.get("X-Panel-Key") or "") == key

    def _path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    # -- routes -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self._path()
        folder = out_dir()

        if path == "/health":
            self._json(200, {"ok": True, "version": VERSION, "role": "store", "locked": bool(panel_key())})
            return
        if not self._authorised():
            self._json(401, {"error": "This server is locked. Add the panel key."})
            return
        if path == "/diag":
            files = listing(folder)
            self._json(
                200,
                {
                    "ok": True,
                    "version": VERSION,
                    "role": "store (this server) + capture (node server)",
                    "output": str(folder),
                    "files": len(files),
                    "used_bytes": sum(item["bytes"] for item in files),
                    "ports": getattr(self.server, "bound_ports", ports()),
                },
            )
            return
        if path == "/files":
            self._json(200, {"files": listing(folder), "dir": str(folder)})
            return
        if path.startswith("/file/") or path == "/file":
            raw = path[len("/file/"):] if path.startswith("/file/") else ""
            if not raw:
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                raw = (query.get("name") or [""])[0]
            name = safe_name(urllib.parse.unquote(raw))
            target = folder / name
            if not name or not target.is_file():
                self._json(404, {"error": "No such file."})
                return
            size = target.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with target.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)
            return
        if path == "/send":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query, keep_blank_values=True)
            wanted = [value for value in query.get("url", []) if value.strip()]
            if not wanted:
                wanted = [value for value in query.get("urls", []) if value.strip()]
            if not wanted:
                page = send_page({"stored": [], "failed": [{"url": "", "reason": "no link was sent"}],
                                  "pages": 0, "bytes": 0})
                return self._html(400, page)
            report = download_documents(wanted)
            status = 200 if report["stored"] else 502
            return self._html(status, send_page(report))
        if path == "/":
            files = listing(folder)
            rows = "".join(
                f'<li><a href="/file/{urllib.parse.quote(item["name"])}">{item["name"]}</a>'
                f'<span class="m">{item["size"]} · {item["age"]}</span></li>'
                for item in files
            ) or '<li class="m">Nothing stored yet.</li>'
            html = PAGE.replace("__COUNT__", str(len(files))).replace("__LIST__", rows).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        self._json(404, {"error": "No such route."})

    def do_POST(self) -> None:  # noqa: N802
        path = self._path()
        if not self._authorised():
            self._json(401, {"error": "This server is locked. Add the panel key."})
            return

        if path == "/send":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            payload = {}
            if length > 0:
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                except (ValueError, UnicodeDecodeError):
                    payload = {}
            wanted = payload.get("urls") or payload.get("url") or []
            if isinstance(wanted, str):
                wanted = [wanted]
            wanted = [str(item) for item in wanted if str(item).strip()]
            if not wanted:
                page = send_page({"stored": [], "failed": [{"url": "", "reason": "no link was sent"}],
                                  "pages": 0, "bytes": 0})
                return self._html(400, page)
            report = download_documents(wanted)
            status = 200 if report["stored"] else 502
            return self._html(status, send_page(report))

        if path == "/reset":
            folder = out_dir()
            removed = 0
            for item in folder.glob("*.pdf"):
                try:
                    item.unlink()
                    removed += 1
                except OSError:
                    pass
            self._json(200, {"ok": True, "removed": removed})
            return

        if path == "/upload":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = safe_name(urllib.parse.unquote((query.get("name") or [""])[0]))
            if not name:
                self._json(400, {"error": "A file name is required."})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0:
                self._json(400, {"error": "The upload was empty."})
                return
            folder = out_dir()
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / name
            temporary = target.with_suffix(".part")
            remaining = length
            with temporary.open("wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 256, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            if remaining:
                temporary.unlink(missing_ok=True)
                self._json(400, {"error": "The upload stopped early."})
                return
            with temporary.open("rb") as handle:
                head = handle.read(5)
            if head != b"%PDF-":
                temporary.unlink(missing_ok=True)
                self._json(400, {"error": "That file is not a PDF."})
                return
            os.replace(temporary, target)
            size = target.stat().st_size
            self._json(200, {"ok": True, "name": name, "bytes": size})
            return

        self._json(404, {"error": "No such route."})


def make_server(number: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((HOST, number), Handler)
    server.daemon_threads = True
    return server


def selftest() -> int:
    import tempfile

    failures = 0

    def check(ok: bool, label: str, detail: str = "") -> None:
        nonlocal failures
        print(f"  {'ok ' if ok else 'FAIL'} {label}{f' — {detail}' if detail else ''}")
        if not ok:
            failures += 1

    check(VERSION.startswith("4."), "version", VERSION)
    check(bool(ports()), "ports resolve", ",".join(map(str, ports())))
    check(safe_name("../../etc/passwd") == "passwd.pdf", "names cannot escape the folder", safe_name("../../etc/passwd"))
    check(safe_name("My Book-12.pdf") == "My Book-12.pdf", "normal names survive", "My Book-12.pdf")

    with tempfile.TemporaryDirectory() as folder:
        os.environ["SCRIBD_OUT"] = folder
        root = Path(folder)
        (root / "a.pdf").write_bytes(b"%PDF-1.4 test")
        items = listing(root)
        check(len(items) == 1 and items[0]["name"] == "a.pdf", "listing finds stored PDFs", "1 file")
        del os.environ["SCRIBD_OUT"]

    server = make_server(0)
    port = server.server_address[1]
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        import urllib.request

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as answer:
            body = json.loads(answer.read())
        check(answer.status == 200 and body.get("ok") is True, "/health")
        check(body.get("role") == "store", "role is store (no browser here)", body.get("role", ""))
    finally:
        server.shutdown()
        server.server_close()

    # --- pictures, whatever shape they arrive in ---------------------------
    def tiny_png(width: int, height: int, colour=(200, 30, 30)) -> bytes:
        """A real PNG, built here so these checks need no browser."""
        def chunk(kind: bytes, data: bytes) -> bytes:
            return (struct.pack(">I", len(data)) + kind + data +
                    struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

        rows = b"".join(b"\x00" + bytes(colour) * width for _ in range(height))
        return (PNG_MAGIC +
                chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
                chunk(b"IDAT", zlib.compress(rows, 6)) +
                chunk(b"IEND", b""))

    page = tiny_png(40, 60)
    check(image_size(page) == (40, 60), "a picture reports its own size", "40x60")

    first = page
    wired = b"".join(struct.pack(">I", len(page)) + page for _ in range(3)) + struct.pack(">I", 0) + b'{"count":3}'
    check(len(page_images(wired)) == 3, "length-prefixed pictures are all found", "3 of 3")
    check(len(page_images(page * 4)) == 4, "pictures back to back, no framing", "4 of 4")
    check(len(page_images(page)) == 1, "a single picture", "1 of 1")
    check(page_images(b"nothing here") == [], "rubbish holds no pictures", "0")

    import io as _io
    import zipfile as _zip
    buffer = _io.BytesIO()
    with _zip.ZipFile(buffer, "w") as archive:
        for index in range(5):
            archive.writestr(f"page-{index + 1:03d}.png", page)
    check(len(page_images(buffer.getvalue())) == 5, "a zip of pictures", "5 of 5")

    check(len(page_images(page * 120)) == 120, "no page limit", "120 of 120")

    # --- the PDF those pictures become ------------------------------------
    with tempfile.TemporaryDirectory() as folder:
        target = Path(folder) / "built.pdf"
        count = build_pdf([page] * 7, target)
        blob = target.read_bytes()
        check(count == 7 and blob.startswith(b"%PDF-1.7"), "builds a PDF, one page per picture", f"{count} pages")
        check(blob.count(b"/Type /Page ") + blob.count(b"/Type /Page\n") >= 7, "every page is in the file", "7")
        check(blob.rstrip().endswith(b"%%EOF"), "the file ends properly")
        check(b"/Subtype /Image" in blob and b"/FlateDecode" in blob, "pictures are embedded, not drawn")
        check(b"/MediaBox [0 0 30.0 45.0]" in blob, "page size follows the picture", "30x45 pt")

    check(document_id("https://www.scribd.com/document/772900436/Some-Title") == "772900436",
          "a document id comes out of a link", "772900436")
    check(document_id("https://example.com/nothing") == "", "a link without an id is refused")

    report = {"stored": [{"name": "document-1.pdf", "pages": 7, "bytes": 2048, "note": ""}],
              "failed": [], "pages": 7, "bytes": 2048}
    heading = send_page(report)
    check("<h1>stored 1 document(s) · 7 page(s) · 2 KiB</h1>" in heading,
          "the reply carries a heading the sender reads", "stored 1 document(s) · 7 page(s) · 2 KiB")
    bad = send_page({"stored": [], "failed": [{"url": "x", "reason": "no answer"}], "pages": 0, "bytes": 0})
    check("<h1>failed: no answer</h1>" in bad, "a failure is reported, not hidden")

    server = make_server(0)
    port = server.server_address[1]
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        import urllib.request

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as answer:
            body = json.loads(answer.read())
        check(answer.status == 200 and body.get("ok") is True, "/health")
        check(body.get("role") == "store", "role is store (no browser here)", body.get("role", ""))

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/send", timeout=30) as answer:
            page_html = answer.read().decode("utf-8", "replace")
        check(False, "/send without a link")  # a 400 is raised as HTTPError below
    except urllib.error.HTTPError as exc:
        check(exc.code == 400 and b"no link was sent" in exc.read(), "/send without a link is refused", "HTTP 400")
    except (urllib.error.URLError, OSError):
        check(False, "/send without a link")
    finally:
        server.shutdown()
        server.server_close()

    total = 9 + 18
    print(f"\nSELFTEST {'FAILED' if failures else 'OK'} — {total - failures}/{total} checks")
    return 1 if failures else 0


def main() -> int:
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    if "--health" in args:
        print(json.dumps({"ok": True, "version": VERSION, "role": "store", "locked": bool(panel_key())}))
        return 0

    folder = out_dir()
    folder.mkdir(parents=True, exist_ok=True)

    servers = []
    for number in ports():
        try:
            servers.append(make_server(number))
        except OSError as exc:
            print(f"[store] cannot bind {number} ({exc})", flush=True)
    if not servers:
        print("[store] no port could be bound", flush=True)
        return 1

    bound = [server.server_address[1] for server in servers]
    for server in servers:
        server.bound_ports = bound
    print(f"Scribd file server v{VERSION} on " + ", ".join(f"http://{HOST}:{p}" for p in bound), flush=True)
    print(f"Storing PDFs in {folder} · no browser on this server", flush=True)

    import threading

    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
