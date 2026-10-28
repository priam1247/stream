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
    POST /upload?name=...   accept a PDF from the capture server
    POST /reset             delete every stored PDF
    GET  /                  a plain page to download what is stored
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "4.0.0"
HOST = "0.0.0.0"
DEFAULT_PORT = 25811
MAX_UPLOAD = 512 * 1024 * 1024
MAX_FILES = 40


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


def prune(folder: Path) -> None:
    try:
        files = sorted(folder.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[MAX_FILES:]:
            old.unlink(missing_ok=True)
    except OSError:
        pass


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
                    "size": f"{stat.st_size / 1024:.0f} KiB",
                    "age": f"{age // 60} min ago" if age < 3600 else f"{age // 3600} h ago",
                    "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
                }
            )
    except OSError:
        pass
    return items


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
            if length > MAX_UPLOAD:
                self._json(413, {"error": "That PDF is too large for this server."})
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
            prune(folder)
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

    print(f"\nSELFTEST {'FAILED' if failures else 'OK'} — {9 - failures}/9 checks")
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
