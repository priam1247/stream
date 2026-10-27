"""Search-first HTTP panel for the screenshot-only Scribd downloader.

One worker, one queue, one Playwright Chromium capture per document. No shooter
service, autostart, discovery, stall heuristics or background jobs outside this
file. The browser sees Scribd exactly as a signed-in member would.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import http.cookies
import json
import shutil
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    from . import capture, config, scribd
except ImportError:  # standalone folder run (python downloader/app.py)
    import capture  # type: ignore[no-redef]
    import config  # type: ignore[no-redef]
    import scribd  # type: ignore[no-redef]


class StopToken:
    """A reset stays in force until the next queued batch starts."""

    def __init__(self, panel: "Panel", generation: int) -> None:
        self.panel = panel
        self.generation = generation

    def is_set(self) -> bool:
        with self.panel.lock:
            return self.panel.cancel.is_set() or self.panel.generation != self.generation


class Panel:
    """Thread-safe status and document queue."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.wakeup = threading.Condition(self.lock)
        self.queue: deque[scribd.Document] = deque()
        self.state = "idle"
        self.verdict = ""
        self.detail = "Search Scribd, tick results, download ticked."
        self.url = ""
        self.title = ""
        self.file = ""
        self.version = config.VERSION
        self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
        self.log: deque[str] = deque(maxlen=config.MAX_LOG_LINES)
        self.queue_view: dict[str, Any] = {
            "pending": 0,
            "done": 0,
            "total": 0,
            "current": "",
            "results": [],
        }
        self.started_at = 0.0
        self.seconds = 0
        self.cancel = threading.Event()
        self.generation = 0
        self.worker = threading.Thread(target=self._run_worker, name="scribd-shots", daemon=True)
        self.worker.start()

    def log_line(self, text: str) -> None:
        clean = " ".join(str(text).split())[:400]
        with self.lock:
            self.log.append(f"{time.strftime('%H:%M:%S')} · {clean}")

    def _set_progress(self, page: int, of: int, ok: int) -> None:
        with self.lock:
            self.progress = {
                "page": max(0, page),
                "of": max(0, of),
                "ok": max(0, ok),
                "skipped": 0,
                "blank": 0,
            }

    def status(self) -> dict[str, Any]:
        with self.lock:
            seconds = self.seconds
            if self.state == "running" and self.started_at:
                seconds = int(time.monotonic() - self.started_at)
            return {
                "state": self.state,
                "verdict": self.verdict,
                "detail": self.detail,
                "url": self.url,
                "title": self.title,
                "file": self.file,
                "seconds": max(0, seconds),
                "version": self.version,
                "cookies": config.cookie_report(),
                "sample": "screenshot-boundaries",
                "progress": dict(self.progress),
                "log": list(self.log),
                "queue": {
                    "pending": len(self.queue),
                    "done": self.queue_view["done"],
                    "total": self.queue_view["total"],
                    "current": self.queue_view["current"],
                    "results": list(self.queue_view["results"]),
                },
                "quiet": 0,
                "stalled": False,
                "stall_after": 0,
            }

    def health(self) -> dict[str, Any]:
        with self.lock:
            state = self.state
        return {
            "ok": True,
            "version": config.VERSION,
            "locked": bool(config.panel_key()),
            "state": state,
        }

    def enqueue(self, documents: list[scribd.Document]) -> dict[str, Any]:
        """Add ticked documents. Returns immediately; the worker does the work."""
        if not documents:
            return {"ok": False, "error": "Tick at least one search result to download."}
        with self.wakeup:
            started = self.state != "running"
            if started:
                self.cancel.clear()
                self.generation += 1
                self.started_at = time.monotonic()
                self.seconds = 0
                self.verdict = ""
                self.file = ""
                self.queue_view = {
                    "pending": 0,
                    "done": 0,
                    "total": 0,
                    "current": "",
                    "results": [],
                }
                self.log.clear()
            for document in documents:
                self.queue.append(document)
            self.queue_view["total"] += len(documents)
            self.state = "running"
            self.detail = f"{len(documents)} document(s) queued · exact page boundaries."
            self.log_line(f"queued {len(documents)} document(s)")
            self.wakeup.notify_all()
            return {
                "ok": True,
                "queued": len(documents),
                "channels": 1,
                "started": started,
                "pending": len(self.queue),
            }

    def reset(self) -> dict[str, Any]:
        """Stop the current job and clear everything waiting behind it."""
        with self.wakeup:
            stopped = self.state == "running" or bool(self.queue)
            self.generation += 1
            self.cancel.set()
            self.queue.clear()
            self.state = "idle"
            self.verdict = "STOPPED"
            self.detail = "Stopped. Search, tick and download again."
            self.url = ""
            self.title = ""
            self.file = ""
            self.seconds = int(time.monotonic() - self.started_at) if self.started_at else 0
            self.started_at = 0.0
            self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
            self.queue_view = {
                "pending": 0,
                "done": 0,
                "total": 0,
                "current": "",
                "results": [],
            }
            self.log_line("stopped by administrator")
            self.wakeup.notify_all()
            return {"ok": True, "stopped": stopped}

    def _run_worker(self) -> None:
        while True:
            with self.wakeup:
                while not self.queue:
                    self.wakeup.wait()
                generation = self.generation
                document = self.queue.popleft()
                self.url = document.url
                self.title = document.title or scribd.title_from_url(document.url)
                self.state = "running"
                self.verdict = ""
                self.detail = f"Capturing {self.title} · every page at its boundary."
                self.queue_view["current"] = document.url
                self.progress = {"page": 0, "of": document.pages, "ok": 0, "skipped": 0, "blank": 0}
            if self.cancel.is_set() or generation != self.generation:
                continue
            try:
                result = capture.capture_document(
                    document,
                    progress=self._set_progress,
                    log=self.log_line,
                    cancel=StopToken(self, generation),
                )
                with self.lock:
                    if generation != self.generation or self.cancel.is_set():
                        continue
                    self.queue_view["done"] += 1
                    self.queue_view["results"].append(
                        {
                            "url": document.url,
                            "title": self.title,
                            "file": result.path.name,
                            "verdict": "PDF BUILT",
                            "detail": f"{result.pages} pages · {result.bytes / 1024:.0f} KiB · {result.seconds:.1f}s",
                        }
                    )
                    self.file = result.path.name
                    self.verdict = "PDF BUILT"
                    self.detail = (
                        f"{self.title} · {result.pages} pages · "
                        f"{result.bytes / 1024:.0f} KiB · {result.seconds:.1f}s"
                    )
                    self.log_line(f"PDF BUILT · {result.path.name}")
            except Exception as exc:  # one bad document must not kill the queue
                message = str(exc) or exc.__class__.__name__
                with self.lock:
                    if generation != self.generation or self.cancel.is_set():
                        continue
                    self.queue_view["done"] += 1
                    self.queue_view["results"].append(
                        {
                            "url": document.url,
                            "title": self.title,
                            "file": "",
                            "verdict": "PDF FAILED",
                            "detail": message[:400],
                        }
                    )
                    self.verdict = "PDF FAILED"
                    self.detail = message[:400]
                    self.log_line(f"PDF FAILED · {message}")
            finally:
                with self.wakeup:
                    if generation == self.generation and not self.cancel.is_set() and not self.queue:
                        failed = any(
                            row["verdict"] != "PDF BUILT"
                            for row in self.queue_view["results"]
                        )
                        self.state = "failed" if failed else "done"
                        self.verdict = "PDF FAILED" if failed else "PDF BUILT"
                        self.seconds = int(time.monotonic() - self.started_at) if self.started_at else 0
                        self.started_at = 0.0
                        self.queue_view["current"] = ""
                        self.queue_view["pending"] = 0
                        self.wakeup.notify_all()

    def files(self) -> list[dict[str, Any]]:
        try:
            paths = sorted(
                config.out_dir().glob("*.pdf"),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return []
        return [
            {"name": path.name, "bytes": path.stat().st_size, "when": int(path.stat().st_mtime)}
            for path in paths
        ]


PANEL = Panel()


class Handler(BaseHTTPRequestHandler):
    server_version = f"ScribdShots/{config.VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:
        # Never put panel keys, cookie values or document titles in stdout logs.
        return

    def _origin(self) -> str:
        origin = (self.headers.get("Origin") or "").rstrip("/")
        allowed = config.panel_origins()
        if origin and origin in allowed:
            return origin
        return ""

    def _cors(self) -> None:
        origin = self._origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")

    def _query(self) -> dict[str, str]:
        parsed = urllib.parse.urlsplit(self.path)
        values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        return {key: value[0] for key, value in values.items() if value}

    def _cookie_key(self) -> str:
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            return ""
        if config.PANEL_COOKIE in jar:
            return jar[config.PANEL_COOKIE].value
        return ""

    def _key_ok(self, query: dict[str, str]) -> bool:
        key = config.panel_key()
        if not key:
            return True
        supplied = (
            self.headers.get("X-Panel-Key")
            or query.get("key")
            or self._cookie_key()
            or ""
        )
        return hmac.compare_digest(supplied, key)

    def _signed_ok(self, name: str, query: dict[str, str]) -> bool:
        key = config.panel_key()
        if not key:
            return True
        token = query.get("t") or ""
        expiry = query.get("e") or ""
        if not token or not expiry.isdigit():
            return False
        if int(expiry) < int(time.time()):
            return False
        expected = hmac.new(
            key.encode(), f"{name}|{expiry}".encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(token, expected)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0 or length > config.MAX_BODY_BYTES:
            return {}
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _authorized(self, query: dict[str, str], *, file_name: str = "") -> bool:
        return self._key_ok(query) or self._signed_ok(file_name, query)

    def _name_from_path(self, path: str) -> str:
        if path.startswith("/file/"):
            raw = urllib.parse.unquote(path[len("/file/") :])
            return config.safe_name(raw)
        return config.safe_name("")

    def _serve_file(self, query: dict[str, str], path: str, *, head_only: bool = False) -> None:
        name = config.safe_name(query.get("name") or "") or self._name_from_path(path)
        if name and not self._authorized(query, file_name=name):
            self._error(401, "Panel key missing or wrong.")
            return
        candidates = [config.out_dir() / name] if name else []
        if not name:
            files = PANEL.files()
            if files:
                candidates = [config.out_dir() / files[0]["name"]]
        if not candidates:
            self._error(404, "No finished PDF yet.")
            return
        target = candidates[0]
        if not target.is_file():
            self._error(404, "That PDF is not on this panel.")
            return
        safe = config.safe_name(target.name)
        headers = {
            "Content-Disposition": f'attachment; filename="{safe}"',
            "X-Accel-Buffering": "no",
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if head_only or self.command == "HEAD":
            return
        with target.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, length=256 * 1024)

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self._origin()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Panel-Key")
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path in ("/file",) or parsed.path.startswith("/file/"):
            self._serve_file(self._query(), parsed.path, head_only=True)
            return
        self._send(200, b"", "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = self._query()
        if path == "/health":
            self._json(200, PANEL.health())
            return
        if path in ("/file",) or path.startswith("/file/"):
            self._serve_file(query, path)
            return
        if not self._authorized(query):
            self._error(401, "Panel key missing or wrong.")
            return
        if path in ("/", "/index.html"):
            body = ui_html(embed="embed" in query).encode("utf-8")
            extra = {}
            key = config.panel_key()
            supplied = query.get("key") or ""
            if key and supplied and hmac.compare_digest(supplied, key):
                extra["Set-Cookie"] = (
                    f"{config.PANEL_COOKIE}={urllib.parse.quote(supplied)}; "
                    "Path=/; SameSite=Lax; HttpOnly"
                )
            self._send(200, body, "text/html; charset=utf-8", extra)
            return
        if path == "/status":
            self._json(200, PANEL.status())
            return
        if path == "/files":
            self._json(200, {"files": PANEL.files()})
            return
        if path == "/config":
            self._json(
                200,
                {
                    "ok": True,
                    "version": config.VERSION,
                    "locked": bool(config.panel_key()),
                    "browser": "Playwright Chromium",
                    "capture": "screenshot-boundaries",
                    "pages": "all",
                },
            )
            return
        if path == "/link":
            name = config.safe_name(query.get("name") or "")
            if not name:
                self._json(200, {"ok": True, "url": "/file", "direct": False})
                return
            link = "/file/" + urllib.parse.quote(name)
            key = config.panel_key()
            if key:
                expiry = str(int(time.time()) + 900)
                token = hmac.new(
                    key.encode(), f"{name}|{expiry}".encode(), hashlib.sha256
                ).hexdigest()
                link += "?" + urllib.parse.urlencode({"t": token, "e": expiry})
            self._json(200, {"ok": True, "url": link, "direct": bool(key)})
            return
        if path == "/diag":
            self._json(
                200,
                {
                    "ok": True,
                    "version": config.VERSION,
                    "browser": "Playwright Chromium",
                    "executable": config.chrome_executable() or "playwright managed",
                    "cookies": config.cookie_report(),
                    "output": str(config.out_dir()),
                },
            )
            return
        self._error(404, "No such route.")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = self._query()
        if not self._authorized(query):
            self._error(401, "Panel key missing or wrong.")
            return
        payload = self._read_json()
        if path == "/find":
            self._json(200, scribd.find_page(payload.get("query"), payload.get("page", 1)))
            return
        if path in ("/run", "/send"):
            documents = scribd.normalise_documents(payload)
            if not documents:
                self._error(400, "Tick at least one search result to download.")
                return
            self._json(200, PANEL.enqueue(documents))
            return
        if path == "/reset":
            self._json(200, PANEL.reset())
            return
        self._error(404, "No such route.")


class PanelServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler]) -> None:
        super().__init__(address, handler)
        self.panel = PANEL


def ui_html(*, embed: bool = False) -> str:
    """A tiny search-first UI. No paste-link field and no removed options."""
    compact = " compact" if embed else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scribd screenshot panel</title>
<style>
:root{{color-scheme:light;--ink:#17212b;--muted:#667;--line:#dce3e8;--teal:#0f766e;--bg:#f5f7f8}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
main{{max-width:1080px;margin:0 auto;padding:28px 18px 60px}}h1{{font-size:24px;margin:0 0 4px}}h2{{font-size:17px;margin:0 0 12px}}
p{{margin:6px 0}}.muted{{color:var(--muted);font-size:13px}}.card{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px;margin:16px 0;box-shadow:0 2px 10px rgba(20,40,60,.04)}}
.row{{display:flex;gap:8px;flex-wrap:wrap;align-items:center}}input[type=search]{{flex:1;min-width:220px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font:inherit}}
button{{padding:10px 14px;border:1px solid var(--line);background:#fff;border-radius:11px;font-weight:650;cursor:pointer}}button.primary{{background:var(--teal);border-color:var(--teal);color:#fff}}button.dark{{background:#17212b;border-color:#17212b;color:#fff}}button:disabled{{opacity:.45;cursor:not-allowed}}
.hits{{display:grid;gap:8px;margin-top:12px}}.hit{{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:12px;padding:11px;cursor:pointer}}.hit:hover{{border-color:#9cc9c4}}.hit input{{margin-top:4px}}.hit b{{display:block;font-size:14px}}.hit small{{color:var(--muted)}}
.bar{{height:8px;background:#e8edf0;border-radius:99px;overflow:hidden}}.bar i{{display:block;height:100%;background:var(--teal);width:0}}
pre{{white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;border-radius:12px;padding:12px;max-height:210px;overflow:auto;font-size:12px}}
.files{{display:grid;gap:8px}}.file{{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}}.file a{{color:var(--teal);font-weight:650;text-decoration:none}}
.badge{{display:inline-block;padding:2px 8px;border-radius:99px;background:#e6f5f2;color:#0f766e;font-size:12px;font-weight:700}}.notice{{padding:10px;border-radius:10px;background:#fff5f5;color:#9f1239;margin:10px 0}}.compact main{{padding:12px}}
@media(max-width:600px){{main{{padding:18px 12px 40px}}.row>*{{width:100%}}}}
</style></head><body><main class="{compact.strip()}">
<header class="card"><h1>Scribd Library</h1><p class="muted">Search words, tick documents, download ticked. Every page Scribd shows is captured at its own page boundary — no viewport slicing, no blank pages.</p><p class="muted">Playwright Chromium · exact page count · one clean PDF per document · v{html.escape(config.VERSION)}</p></header>
<section class="card"><h2>Find a book</h2><div class="row"><input id="q" type="search" placeholder="physics 12th" autocomplete="off"><button id="find" class="primary">Find</button><button id="more" disabled>Load more</button></div><p id="summary" class="muted"></p><div id="hits" class="hits"></div><div class="row" style="margin-top:12px"><button id="all">Mark all</button><button id="clear">Clear</button><span id="picked" class="muted">nothing ticked yet</span><button id="run" class="dark" disabled>Download ticked</button></div><p id="notice" class="notice" hidden></p></section>
<section class="card"><h2>Progress</h2><div class="row" style="justify-content:space-between"><span id="verdict" class="badge">idle</span><button id="reset">Stop job</button></div><div class="bar" style="margin-top:10px"><i id="bar"></i></div><p id="detail" class="muted">No job yet.</p><pre id="log">(no output yet)</pre></section>
<section class="card"><h2>Finished PDFs</h2><div id="files" class="files"><p class="muted">Nothing built yet.</p></div></section>
</main><script>
const KEY = new URLSearchParams(location.search).get('key') || '';
const headers = {{'Content-Type':'application/json'}};
if (KEY) headers['X-Panel-Key'] = KEY;
const hitsEl=document.getElementById('hits'), pickedEl=document.getElementById('picked'), runEl=document.getElementById('run');
let hits=[], ticked=new Set(), page=1, maxPage=1, searching=false, starting=false;
function esc(s){{return String(s??'').replace(/[&<>"']/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}})[c]);}}
function notice(text){{const el=document.getElementById('notice');el.textContent=text||'';el.hidden=!text;}}
async function api(path, body){{const opt={{headers,credentials:'same-origin'}};if(body){{opt.method='POST';opt.body=JSON.stringify(body);}}const res=await fetch(path,opt);const data=await res.json().catch(()=>({{}}));if(!res.ok)throw new Error(data.error||('HTTP '+res.status));return data;}}
function render(){{hitsEl.innerHTML=hits.length?hits.map((h,i)=>`<label class="hit"><input type="checkbox" data-url="${{esc(h.url)}}" ${{ticked.has(h.url)?'checked':''}}><span><b>${{esc(h.title)}}</b><small>${{h.pages?h.pages+' pages · ':''}}${{esc(h.author||h.views||'Scribd')}}</small></span></label>`).join(''):'<p class="muted">No results yet.</p>';hitsEl.querySelectorAll('input').forEach(box=>box.onchange=()=>{{box.checked?ticked.add(box.dataset.url):ticked.delete(box.dataset.url);sync();}});sync();}}
function sync(){{pickedEl.textContent=ticked.size?ticked.size+' ticked':'nothing ticked yet';runEl.disabled=!ticked.size||starting;runEl.textContent=starting?'Starting…':'Download ticked ('+ticked.size+')';}}
async function find(next){{if(searching)return;const q=document.getElementById('q').value.trim();if(!q){{notice('Type a few words to search Scribd for.');return;}}searching=true;notice('');try{{const data=await api('/find',{{query:q,page:next}});const fresh=next===1?data.hits:data.hits.filter(h=>!hits.some(x=>x.id===h.id));hits=next===1?data.hits:hits.concat(fresh);page=data.page||next;maxPage=data.max_page||1;document.getElementById('summary').textContent=data.summary||'';document.getElementById('more').disabled=page>=maxPage||!data.hits.length;render();if(!hits.length)notice('No documents match that.');}}catch(e){{notice(e.message);}}finally{{searching=false;}}}}
document.getElementById('find').onclick=()=>find(1);document.getElementById('q').onkeydown=e=>{{if(e.key==='Enter')find(1);}};document.getElementById('more').onclick=()=>find(page+1);
document.getElementById('all').onclick=()=>{{hits.forEach(h=>ticked.add(h.url));render();}};document.getElementById('clear').onclick=()=>{{ticked.clear();render();}};
runEl.onclick=async()=>{{if(!ticked.size||starting)return;starting=true;notice('');try{{const documents=hits.filter(h=>ticked.has(h.url)).map(h=>({{id:h.id,title:h.title,url:h.url,pages:h.pages}}));await api('/run',{{urls:documents.map(d=>d.url),documents}});ticked.clear();render();notice('Queued. Every page will be captured at its boundary.');}}catch(e){{notice(e.message);}}finally{{starting=false;sync();}}}};
document.getElementById('reset').onclick=async()=>{{try{{await api('/reset',{{}});notice('Stopped.');}}catch(e){{notice(e.message);}}}};
async function poll(){{try{{const s=await api('/status');document.getElementById('verdict').textContent=s.verdict||s.state||'idle';document.getElementById('detail').textContent=s.detail||'';const p=s.progress||{{}};const of=Number(p.of)||0;document.getElementById('bar').style.width=(of?Math.min(100,Math.round(100*(Number(p.page)||0)/of)):0)+'%';document.getElementById('log').textContent=(s.log||[]).slice(-16).join('\\n')||'(no output yet)';const f=await api('/files');const list=f.files||[];document.getElementById('files').innerHTML=list.length?list.map(x=>`<div class="file"><a href="/file/${{encodeURIComponent(x.name)}}">${{esc(x.name)}}</a><small class="muted">${{(x.bytes/1048576).toFixed(1)}} MB</small></div>`).join(''):'<p class="muted">Nothing built yet.</p>';}}catch(e){{document.getElementById('detail').textContent=e.message;}}}}
poll();setInterval(poll,2500);render();
</script></body></html>"""


def make_server(host: str = config.HOST, port: int | None = None) -> PanelServer:
    config.ensure_dirs()
    return PanelServer((host, port if port is not None else config.port()), Handler)


def serve(host: str = config.HOST, port: int | None = None) -> None:
    server = make_server(host, port)
    actual = server.server_address[1]
    print(f"Scribd screenshot panel v{config.VERSION} on http://{host}:{actual}", flush=True)
    print(f"PDFs: {config.out_dir()} · {config.cookie_report()}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
