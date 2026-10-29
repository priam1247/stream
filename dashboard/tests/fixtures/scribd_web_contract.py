"""Offline contract fixture using the unmodified Scribd web request handler.

Only search, thumbnails, and the expensive conversion worker are replaced; no
Scribd/Drime network access occurs and job files live in a temporary directory.
"""
from __future__ import annotations

import base64
import signal
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "working scribd"))
import scribd_web as web  # noqa: E402

scratch = tempfile.TemporaryDirectory(prefix="dashboard-scribd-contract-")
web.OUTDIR = Path(scratch.name)
web.STATE_FILE = web.OUTDIR / ".job.json"
web.THUMBS = web.OUTDIR / ".thumbs"
web.TOKEN = "contract-token"
web.JOB["items"] = []
web.JOB["cancelled"] = False


def search(query: str, page: int = 1) -> dict:
    if query == "challenge":
        raise web.ChallengeError("Scribd challenge (fixture)")
    items = {
        1: [
            {"id": "100001", "title": "Local book", "url": "/document/100001/local", "thumb": "https://img.scribdassets.com/cover.jpg", "pages": 3, "views": "2K", "author": "Author"},
            {"id": "100002", "title": "Cloud book", "url": "/document/100002/cloud", "thumb": "", "pages": 2, "views": "", "author": ""},
        ],
        2: [{"id": "100003", "title": "Slow book", "url": "/document/100003/slow", "thumb": "", "pages": 10, "views": "", "author": ""}],
    }.get(page, [])
    return {"query": query, "page": page, "title": "Fixture search", "items": items}


def thumb(_url: str) -> tuple[bytes, str]:
    png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEUNlIhZ7OqFAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC"
    return base64.b64decode(png), "image/png"


def run_item(item: dict, _engine: str, _tabs: int, _scale: float) -> None:
    item["status"] = "running"
    item["started"] = time.time()
    if item["id"] == "100003":
        for _ in range(250):
            if web.JOB["cancelled"]:
                item["status"] = "failed"
                item["error"] = "Cancellation requested"
                web._save()
                return
            time.sleep(0.02)
    item["done"] = item["total"]
    item["status"] = "done"
    if item["id"] == "100002":
        item["pdf"] = "cloud.pdf"
        item["offloaded"] = True
        item["drime"] = {"id": "42", "name": "cloud.pdf", "url": ""}
    else:
        item["pdf"] = "local.pdf"
        data = b"%PDF-1.4\nfixture PDF\n%%EOF\n"
        (web.OUTDIR / item["pdf"]).write_bytes(data)
        item["size"] = len(data)
    web._save()


web.scribd_search = search
web.fetch_thumb = thumb
web._run_item = run_item
server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
# shutdown() must be called from a different thread than serve_forever().
signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
print(server.server_address[1], flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    scratch.cleanup()
