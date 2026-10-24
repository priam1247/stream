#!/usr/bin/env python3
"""download_check.py — one file. Paste a Scribd link, press one button, and the
panel tells you whether it can download it and build a PDF.

Why this file exists: the panel has no shell. `bot.py` runs, you have a browser
and a port, and that is all. So the decisive test — "can this machine fetch a
document without Chromium?" — has to be a page you can open, not a command you
type.

What it does
------------
It serves a small page on the panel's own port. You paste one or more document
URLs, press *Test download*, and it runs the project's real downloader exactly
as the app does:

    python -m scribd --file urls.txt -o <out> -f pdf --no-cache \
        --cookies-file <found cookies.txt> [--browser]

It then reports, from the filesystem and the log, one of:

    PDF BUILT        a .pdf appeared and is bigger than 1 kB  -> the panel works
    NO PDF           the run ended without a PDF              -> the log says why
    RUNNING          still fetching page images

The checkbox *use the browser too* adds `--browser`. On a panel that is missing
libatspi/libnspr4 it will fail — and that failure next to a successful HTTP run
is exactly the proof you need that the browser is the only missing piece.

Usage
-----
    # panel without a shell: set PY_FILE to this file, restart, open the server URL
    SERVER_PORT=25811 python download_check.py

    # anywhere with a shell (Cloud Shell, your PC, a runner):
    python download_check.py --url https://www.scribd.com/document/751945245
    python download_check.py --url URL --browser          # test the browser too
    python download_check.py --selftest                   # offline sanity check

Nothing here prints a cookie value, installs a package, or uploads anything.
PDFs land in `out/` (or `--out`), the same folder the app uses.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
OUT_DIR = "out"
COOKIE_CANDIDATES = (
    "cookies.txt",
    "./cookies.txt",
    "/home/container/cookies.txt",
    os.path.join(os.environ.get("SCRIBD_WEB_DATA", "webdata"), "cookies.txt"),
)
FAILURE_HINTS = ("FAILED", "Traceback", "error", "Error", "refused", "403", "401",
                 "login", "challenge", "not found", "GLIBC", "libatspi", "libnspr")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def clean(line: str) -> str:
    return ANSI.sub("", line).rstrip()


def find_cookies(explicit: str = "") -> str:
    for candidate in (explicit, os.environ.get("SCRIBD_WEB_COOKIES", ""),
                      os.environ.get("SCRIBD_DIAG_COOKIES", ""),
                      os.environ.get("SCRIBD_COOKIES", "")):
        if candidate and os.path.isfile(candidate):
            return candidate
    for candidate in COOKIE_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return ""


def cookie_summary(path: str) -> str:
    """Counts only — never a value."""
    if not path:
        return "no cookies.txt found — anonymous requests only"
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = [ln for ln in handle.read().splitlines()
                     if ln.strip() and not ln.startswith("#")]
    except OSError as exc:
        return f"{path} — unreadable ({exc.__class__.__name__})"
    names = set()
    for line in lines:
        parts = line.split("\t")
        if len(parts) == 7:
            names.add(parts[5])
    session = [n for n in names if "session" in n.lower()]
    return (f"{path} — {len(lines)} cookie line(s), {len(names)} name(s)"
            + (f", session '{session[0]}' present" if session else
               ", NO session cookie — looks logged out"))


def pdfs_in(directory: str, since: float = 0.0) -> list[dict]:
    found: list[dict] = []
    if not os.path.isdir(directory):
        return found
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not name.lower().endswith(".pdf") or not os.path.isfile(path):
            continue
        stat = os.stat(path)
        if since and stat.st_mtime < since - 2:
            continue
        found.append({"name": name, "size": stat.st_size,
                      "mtime": stat.st_mtime})
    return found


def verdict(exit_code: int | None, pdfs: list[dict], log: list[str]) -> tuple[str, str]:
    """(state, one-line explanation) — judged on files first, words second."""
    big = [p for p in pdfs if p["size"] > 1024]
    if big:
        total = sum(p["size"] for p in big)
        size = (f"{total / 1_000_000:.1f} MB" if total >= 1_000_000
                else f"{total / 1000:.0f} kB")
        return ("PDF BUILT",
                f"{len(big)} PDF(s), {size} — the panel can download "
                "without a browser")
    if exit_code is None:
        return ("RUNNING", "still working")
    if exit_code == 0:
        return ("NO PDF", "the run exited 0 but wrote no PDF — check the log "
                          "for 'already there' or an empty document")
    hints = [line for line in log if any(h in line for h in FAILURE_HINTS)]
    tail = hints[-1][:180] if hints else (log[-1][:180] if log else "no output")
    return ("NO PDF", tail)


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------
class Job:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.lines: deque[str] = deque(maxlen=600)
        self.state = "idle"          # idle | running | done
        self.urls: list[str] = []
        self.started = 0.0
        self.ended = 0.0
        self.exit_code: int | None = None
        self.command: list[str] = []
        self.state_text = ""
        self.detail = ""
        self.process: subprocess.Popen | None = None
        self.out_dir = OUT_DIR

    def say(self, text: str) -> None:
        with self.lock:
            self.lines.append(clean(text))
        print(clean(text), flush=True)

    def snapshot(self) -> dict:
        with self.lock:
            pdfs = pdfs_in(self.out_dir, self.started)
            state, detail = verdict(self.exit_code, pdfs, list(self.lines))
            return {
                "state": self.state,
                "verdict": state if self.state == "done" else "RUNNING",
                "detail": self.detail or detail,
                "urls": list(self.urls),
                "started": self.started,
                "ended": self.ended,
                "seconds": round((self.ended or time.time()) - self.started, 1)
                if self.started else 0,
                "exit_code": self.exit_code,
                "pdfs": pdfs,
                "log": list(self.lines)[-200:],
                "command": " ".join(self.command),
                "cookies": cookie_summary(find_cookies()),
                "version": VERSION,
            }


JOB = Job()


def start_job(urls: list[str], use_browser: bool, out_dir: str, cookies: str,
              require_public: bool = False,
              timeout_min: float = 45.0) -> tuple[bool, str]:
    with JOB.lock:
        if JOB.state == "running":
            return False, "a run is already in progress"
        JOB.state = "running"
        JOB.lines.clear()
        JOB.urls = list(urls)
        JOB.exit_code = None
        JOB.ended = 0.0
        JOB.detail = ""
        JOB.started = time.time()
        JOB.out_dir = out_dir
    os.makedirs(out_dir, exist_ok=True)

    listing = os.path.join(out_dir, "urls.txt")
    with open(listing, "w", encoding="utf-8") as handle:
        handle.write("".join(f"{u}\n" for u in urls))

    command = [sys.executable, "-m", "scribd", "--file", listing,
               "-o", out_dir, "-f", "pdf", "--no-cache"]
    if cookies:
        command += ["--cookies-file", cookies]
    if use_browser:
        command += ["--browser"]
    if require_public:
        command += ["--require-public"]
    with JOB.lock:
        JOB.command = command

    env = dict(os.environ)
    env.update({"NO_COLOR": "1", "TERM": "dumb", "PYTHONUNBUFFERED": "1",
                "COLUMNS": "200"})

    def worker() -> None:
        try:
            JOB.say("$ " + " ".join(command))
            JOB.say(f"cookies: {cookie_summary(cookies)}")
            JOB.say("")
            process = subprocess.Popen(command, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True,
                                       bufsize=1, env=env, cwd=os.getcwd())
            with JOB.lock:
                JOB.process = process
            deadline = time.time() + timeout_min * 60

            def watchdog() -> None:
                # a silent retry loop would otherwise never reach the deadline
                while process.poll() is None and time.time() < deadline:
                    time.sleep(0.5)
                if process.poll() is None:
                    JOB.say(f"[timeout] stopping after {timeout_min:g} minutes")
                    process.terminate()

            threading.Thread(target=watchdog, daemon=True).start()
            assert process.stdout is not None
            for line in process.stdout:
                JOB.say(line)
            code = process.wait()
        except FileNotFoundError:
            code = 127
            JOB.say("cannot start 'python -m scribd' — is the project in this "
                    "folder? (bot.py and scribd/ must be next to this file)")
        except Exception as exc:  # noqa: BLE001
            code = 1
            JOB.say(f"crashed: {exc!r}")
        with JOB.lock:
            JOB.exit_code = code
            JOB.ended = time.time()
            JOB.state = "done"
            JOB.process = None
            pdfs = pdfs_in(out_dir, JOB.started)
            state, detail = verdict(code, pdfs, list(JOB.lines))
            JOB.detail = detail
        JOB.say("")
        JOB.say(f"== {state} — {detail}")

    threading.Thread(target=worker, daemon=True).start()
    return True, "started"


def stop_job() -> None:
    with JOB.lock:
        process = JOB.process
    if process and process.poll() is None:
        process.terminate()
        JOB.say("[stop] terminating the run")


def run_once(urls: list[str], use_browser: bool, out_dir: str, cookies: str,
             require_public: bool = False, timeout_min: float = 45.0) -> int:
    ok, message = start_job(urls, use_browser, out_dir, cookies, require_public,
                            timeout_min)
    if not ok:
        print(message)
        return 2
    while True:
        with JOB.lock:
            state = JOB.state
        if state == "done":
            break
        time.sleep(0.4)
    with JOB.lock:
        code = JOB.exit_code
    return 0 if (code == 0 and pdfs_in(out_dir, JOB.started)) else 1


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>can this panel download?</title>
<style>
 body{font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 70px}
 .wrap{max-width:1020px;margin:0 auto}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#57606a;font-size:13px;margin-bottom:16px}
 textarea{width:100%;height:92px;box-sizing:border-box;font:inherit;
  padding:10px;border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 .row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:12px 0}
 button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;
  background:#1f6feb;color:#fff;cursor:pointer}
 button.ghost{background:#fff;color:#1f2328;border-color:#b8c0c8}
 button:disabled{opacity:.5;cursor:default}
 .verdict{background:#fff;border:1px solid #d0d7de;border-left:5px solid #9a6700;
  padding:13px 15px;margin:16px 0;white-space:pre-wrap;font-size:16px}
 .ok{border-left-color:#1a7f37} .bad{border-left-color:#b42318}
 pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:8px;
  overflow:auto;max-height:440px;font-size:12.5px;line-height:1.45;margin:0}
 .files{background:#fff;border:1px solid #d0d7de;border-radius:8px;
  padding:10px 14px;margin:12px 0;font-size:13px}
 .files a{color:#0969da}
 .muted{color:#57606a;font-size:13px}
</style></head><body><div class="wrap">
<h1>Can this panel download a document?</h1>
<div class="meta" id="meta">ready</div>
<textarea id="urls" placeholder="one Scribd URL per line&#10;https://www.scribd.com/document/751945245"></textarea>
<div class="row">
  <label><input type="checkbox" id="browser"> also try <b>--browser</b> (needs libatspi/libnse etc.)</label>
  <label><input type="checkbox" id="require_public"> public documents only</label>
</div>
<div class="row">
  <button id="go">Test download</button>
  <button id="stop" class="ghost" disabled>Stop</button>
  <span class="muted" id="hint"></span>
</div>
<div class="verdict" id="verdict">idle — paste a link and press the button</div>
<div class="files" id="files" style="display:none"></div>
<pre id="log">(no output yet)</pre>
</div>
<script>
const $ = (id) => document.getElementById(id);
let timer = null;

async function poll() {
  const r = await fetch('/status', {cache: 'no-store'});
  const s = await r.json();
  $('log').textContent = s.log.length ? s.log.join('\\n') : '(no output yet)';
  $('meta').textContent = `${s.state} · ${s.seconds}s · ${s.cookies}`;
  const v = $('verdict');
  v.textContent = s.verdict + (s.detail ? ' — ' + s.detail : '');
  v.className = 'verdict' + (s.verdict === 'PDF BUILT' ? ' ok'
                 : (s.verdict === 'NO PDF' ? ' bad' : ''));
  if (s.pdfs.length) {
    $('files').style.display = 'block';
    $('files').innerHTML = 'PDFs in this run:<br>' + s.pdfs.map(p =>
      `&nbsp;&nbsp;<a href="/file/${encodeURIComponent(p.name)}">${p.name}</a>`
      + ` <span class="muted">${(p.size/1e6).toFixed(2)} MB</span>`).join('<br>');
  } else { $('files').style.display = 'none'; }
  const running = s.state === 'running';
  $('go').disabled = running; $('stop').disabled = !running;
  if (!running && timer) { clearInterval(timer); timer = null; }
}

$('go').onclick = async () => {
  const urls = $('urls').value.split(/\\s+/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) { $('hint').textContent = 'paste at least one URL'; return; }
  $('hint').textContent = '';
  const body = {urls: urls, browser: $('browser').checked,
                require_public: $('require_public').checked};
  const r = await fetch('/run', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify(body)});
  const j = await r.json();
  if (!r.ok) { $('hint').textContent = j.error || 'could not start'; return; }
  if (timer) clearInterval(timer);
  poll(); timer = setInterval(poll, 1500);
};
$('stop').onclick = () => fetch('/stop', {method: 'POST'});
setTimeout(poll, 300);
</script></body></html>"""


def serve(port: int, out_dir: str, cookies: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if path == "/status":
                self._send(json.dumps(JOB.snapshot()).encode(),
                           "application/json; charset=utf-8")
            elif path == "/health":
                self._send(b"ok", "text/plain")
            elif path.startswith("/file/"):
                name = os.path.basename(urllib.parse.unquote(path[6:]))
                target = os.path.join(out_dir, name)
                if not name.lower().endswith(".pdf") or not os.path.isfile(target):
                    self._send(b"no such file", "text/plain", 404)
                    return
                with open(target, "rb") as handle:
                    body = handle.read()
                self._send(body, "application/pdf")
            else:
                self._send(PAGE.encode(), "text/html; charset=utf-8")

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            if path == "/stop":
                stop_job()
                self._send(b'{"stopped":true}', "application/json")
                return
            if path != "/run":
                self._send(b'{"error":"unknown endpoint"}', "application/json", 404)
                return
            try:
                payload = json.loads(raw or b"{}")
            except Exception:  # noqa: BLE001
                payload = {}
            urls = [str(u).strip() for u in (payload.get("urls") or []) if str(u).strip()]
            if not urls:
                self._send(b'{"error":"no urls"}', "application/json", 400)
                return
            use_browser = bool(payload.get("browser"))
            require_public = bool(payload.get("require_public"))
            ok, message = start_job(urls, use_browser, out_dir, cookies,
                                    require_public)
            code = 200 if ok else 409
            self._send(json.dumps({"ok": ok, "message": message}).encode(),
                       "application/json", code)

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"open http://0.0.0.0:{port}/  — paste a link, press the button",
          flush=True)
    print(f"cookies: {cookie_summary(find_cookies())}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()


# ---------------------------------------------------------------------------
# entry points
# ---------------------------------------------------------------------------
def selftest() -> str:
    assert clean("\x1b[31mFAILED\x1b[0m x") == "FAILED x"
    assert verdict(None, [], ["still"])[0] == "RUNNING"
    assert verdict(1, [], ["FAILED HTTP 403", "other"]) == ("NO PDF", "FAILED HTTP 403")
    assert verdict(0, [], ["ok"])[0] == "NO PDF"
    assert verdict(0, [{"name": "a.pdf", "size": 5000, "mtime": 1}], [])[0] == "PDF BUILT"
    assert verdict(0, [{"name": "a.pdf", "size": 10, "mtime": 1}], [])[0] == "NO PDF"
    assert cookie_summary("") == "no cookies.txt found — anonymous requests only"
    return "selftest: 7/7 ok"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    parser.add_argument("--url", action="append", default=[],
                        help="document URL; repeatable (runs once and exits)")
    parser.add_argument("--file", help="file with one URL per line (runs once)")
    parser.add_argument("--browser", action="store_true",
                        help="add --browser (tests Chromium as well)")
    parser.add_argument("--out", default=OUT_DIR, help="output folder")
    parser.add_argument("--cookies", default="", help="path to cookies.txt")
    parser.add_argument("--require-public", action="store_true",
                        help="skip documents the oEmbed endpoint does not know")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--timeout-min", type=float, default=45.0)
    args = parser.parse_args(argv)

    if args.selftest:
        print(selftest())
        return 0

    cookies = find_cookies(args.cookies)
    urls = list(args.url)
    if args.file:
        with open(args.file, encoding="utf-8") as handle:
            urls += [ln.strip() for ln in handle if ln.strip()]

    if urls:
        print(f"cookies: {cookie_summary(cookies)}", flush=True)
        return run_once(urls, args.browser, args.out, cookies,
                        args.require_public, args.timeout_min)

    port = args.port or int(os.environ.get("SERVER_PORT")
                            or os.environ.get("PORT") or 8090)
    serve(port, args.out, cookies)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
