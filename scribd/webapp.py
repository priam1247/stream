"""Small web front-end: search Scribd, then batch-download what was found.

Why a job queue and not one HTTP request: a search is a browser session
(20-40 s) and a download is Chromium printing one sheet per page (minutes for a
textbook). Both are run as **subprocesses of the CLI** (`python -m scribd …`),
so the web layer never needs to know how the scraping works — it starts a job,
streams the CLI's own log, and serves the files.

    pip install flask
    export SCRIBD_WEB_USER=me SCRIBD_WEB_PASS=secret
    export SCRIBD_WEB_COOKIES=/path/to/cookies.txt      # optional
    python -m scribd.webapp --host 0.0.0.0 --port 8000

On a Pterodactyl-style panel there is no shell and only one file is run, so
`bot.py` (repo root) starts this app on `0.0.0.0:$SERVER_PORT` instead.

Endpoints (all behind HTTP Basic auth when the env vars are set):

    GET  /                          the page
    POST /api/jobs                  {"mode":"search","query":"excel","limit":50}
    POST /api/jobs                  {"mode":"download","urls":[...]}  or
                                    {"mode":"download","query":"excel","limit":0}
    POST /api/jobs                  {"mode":"setup"}   install Chromium (+ its libs)
    GET  /api/jobs                  all jobs + counts
    GET  /api/jobs/<id>             status, results, file list, manifest counts
    GET  /api/jobs/<id>/log?offset= incremental log text
    GET  /api/jobs/<id>/file/<name> one PDF
    GET  /api/jobs/<id>/zip         every PDF of that job
    POST /api/jobs/<id>/cancel      stop it

`limit: 0` means "everything the search found". Downloads are resumable: the
CLI skips documents whose PDF is already in the output folder, so a re-run of a
failed batch only fetches what is missing.
"""
from __future__ import annotations

import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

from . import __version__
from .dotenv import load_env
from .sysroot import lib_dirs

REPO_ROOT = Path(__file__).resolve().parent.parent
# Panels without a variable editor: read ./.env (never overrides real env vars).
ENV_FILE = load_env(os.environ.get("SCRIBD_WEB_ENV_FILE", ""), REPO_ROOT / ".env", Path.cwd() / ".env")
DATA_DIR = Path(os.environ.get("SCRIBD_WEB_DATA", "./webdata")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
OUT_DIR = DATA_DIR / "out"
MAX_JOBS_KEPT = int(os.environ.get("SCRIBD_WEB_MAX_JOBS", "200"))
CONCURRENCY = max(1, int(os.environ.get("SCRIBD_WEB_CONCURRENCY", "1")))

app = Flask(__name__)

JOBS: dict[str, "Job"] = {}
JOBS_LOCK = threading.Lock()
QUEUE: "queue.Queue[str]" = queue.Queue()
WORKERS: list[threading.Thread] = []
WORKERS_LOCK = threading.Lock()


def _playwright_installed() -> bool:
    import importlib.util

    return importlib.util.find_spec("playwright") is not None


def _chromium_path() -> str:
    """Where playwright keeps Chromium, if any build was downloaded."""
    from .chromium import find_chromium

    return find_chromium()


def browser_status() -> dict:
    """What the panel needs to know: is a browser even usable here?"""
    from .chromium import _read_cache

    chromium = _chromium_path()
    return {
        "playwright": _playwright_installed(),
        "chromium": bool(chromium),
        "chromium_path": chromium,
        # which launch variant worked last time ("shell" / "chrome" / "path")
        "mode": str(_read_cache().get("mode") or ""),
    }


def resolve_bind(host: str | None = None, port: int | str | None = None) -> tuple[str, int]:
    """--host/--port, else SCRIBD_WEB_*, else the panel's SERVER_PORT / PORT."""
    resolved_host = host or os.environ.get("SCRIBD_WEB_HOST") or "127.0.0.1"
    raw = port
    if raw is None:
        raw = (
            os.environ.get("SCRIBD_WEB_PORT")
            or os.environ.get("SERVER_PORT")   # Pterodactyl / Pterodactyl-derived panels
            or os.environ.get("PORT")
            or 8000
        )
    try:
        resolved_port = int(raw)
    except (TypeError, ValueError):
        resolved_port = 8000
    return resolved_host, resolved_port


def _is_public(host: str) -> bool:
    return host not in ("127.0.0.1", "localhost", "::1")


def ensure_auth(host: str) -> str:
    """Never serve an open downloader on a public port.

    If the app is bound to something other than loopback and no credentials are
    configured, a random password is generated and printed once to the console
    (the panel log), where only the server owner can read it.
    """
    if os.environ.get("SCRIBD_WEB_USER") or os.environ.get("SCRIBD_WEB_PASS") or os.environ.get("SCRIBD_WEB_TOKEN"):
        return "configured"
    if not _is_public(host):
        return "open-loopback"
    import secrets

    password = secrets.token_urlsafe(12)
    os.environ["SCRIBD_WEB_USER"] = "admin"
    os.environ["SCRIBD_WEB_PASS"] = password
    print(
        "\n" + "=" * 64 +
        "\nNo SCRIBD_WEB_USER/SCRIBD_WEB_PASS set, and this server is public.\n"
        "Generated credentials for this run:\n"
        f"    user:     admin\n"
        f"    password: {password}\n"
        "Log in with those, or set the env vars in the panel to keep a fixed one.\n"
        + "=" * 64 + "\n",
        flush=True,
    )
    return "generated"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _slug(text: str, fallback: str = "query") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", (text or "")).strip("_")
    return (cleaned or fallback)[:60]


# ---------------------------------------------------------------------------
# jobs
# ---------------------------------------------------------------------------
@dataclass
class Job:
    id: str
    mode: str                      # "search" | "download"
    query: str = ""
    limit: int = 5
    pages: int = 3
    picks: list[int] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    status: str = "queued"         # queued | running | done | failed | cancelled
    created_at: str = field(default_factory=_now)
    started_at: str = ""
    finished_at: str = ""
    returncode: int | None = None
    error: str = ""
    command: list[str] = field(default_factory=list)

    # runtime only
    process: subprocess.Popen | None = None
    log_offset: int = 0

    @property
    def dir(self) -> Path:
        return JOBS_DIR / self.id

    @property
    def log_path(self) -> Path:
        return self.dir / "job.log"

    def state_path(self) -> Path:
        return self.dir / "state.json"

    def save(self) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self.state_path().write_text(
                json.dumps(
                    {
                        "id": self.id,
                        "mode": self.mode,
                        "query": self.query,
                        "limit": self.limit,
                        "pages": self.pages,
                        "picks": self.picks,
                        "urls": self.urls,
                        "status": self.status,
                        "created_at": self.created_at,
                        "started_at": self.started_at,
                        "finished_at": self.finished_at,
                        "returncode": self.returncode,
                        "error": self.error,
                        "command": self.command,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass

    def as_dict(self) -> dict:
        manifest = _manifest_for(self)
        return {
            "id": self.id,
            "mode": self.mode,
            "query": self.query,
            "limit": self.limit,
            "picks": self.picks,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "returncode": self.returncode,
            "error": self.error,
            "pdf_count": len(_job_files(self)),
            "files": [path.name for path in _job_files(self)],
            "manifest": manifest,
            "results": _job_results(self),
            "urls": self.urls,
        }


def _job_files(job: Job) -> list[Path]:
    """PDFs this job produced (from its own manifest when possible)."""
    wanted = _manifest_for(job).get("entries") or []
    names = {
        name
        for entry in wanted
        for name in (entry.get("files") or [])
        if name.endswith(".pdf")
    }
    if names:
        found = [OUT_DIR / name for name in names if (OUT_DIR / name).is_file()]
        if found:
            return sorted(found, key=lambda p: p.name)
    if not job.urls:
        return []
    ids = {_doc_id(url) for url in job.urls if _doc_id(url)}
    return sorted(
        (
            path
            for path in OUT_DIR.glob("*.pdf")
            if path.name.split("_", 1)[0] in ids
        ),
        key=lambda path: path.name,
    )


def _manifest_for(job: Job) -> dict:
    """Manifest rows that belong to this job, plus ok/failed/skipped counts."""
    path = OUT_DIR / "manifest.jsonl"
    entries: list[dict] = []
    counts = {"ok": 0, "failed": 0, "skipped": 0}
    if not path.is_file():
        return {"counts": counts, "entries": []}
    mine = {_doc_id(url) for url in job.urls if _doc_id(url)} or None
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if mine is not None and str(entry.get("doc_id") or "") not in mine:
                continue
            entries.append(entry)
            status = str(entry.get("status") or "")
            if status in counts:
                counts[status] += 1
    except OSError:
        pass
    return {"counts": counts, "entries": entries[-500:]}


def _job_results(job: Job) -> list[dict]:
    """Search hits, read from the list the CLI saves (out/search-*.json)."""
    if job.mode != "search":
        return []
    if job.query:
        candidate = OUT_DIR / f"search-{_slug(job.query)}.json"
        if candidate.is_file():
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
                if payload.get("query") == job.query:
                    return list(payload.get("results") or [])
            except (OSError, json.JSONDecodeError):
                pass
    newest = None
    for path in OUT_DIR.glob("search-*.json"):
        try:
            if newest is None or path.stat().st_mtime > newest.stat().st_mtime:
                newest = path
        except OSError:
            continue
    if newest is not None:
        try:
            return list(json.loads(newest.read_text(encoding="utf-8")).get("results") or [])
        except (OSError, json.JSONDecodeError):
            return []
    return []


def _doc_id(url: str) -> str:
    match = re.search(r"/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/(\d+)", url or "")
    return match.group(1) if match else ""


# ---------------------------------------------------------------------------
# building the CLI command
# ---------------------------------------------------------------------------
def cookies_file() -> str:
    """Explicit setting first, then the usual places a cookies.txt gets dropped."""
    configured = os.environ.get("SCRIBD_WEB_COOKIES", "").strip()
    if configured:
        return configured if Path(configured).is_file() else ""
    for candidate in (REPO_ROOT / "cookies.txt", Path.cwd() / "cookies.txt", DATA_DIR / "cookies.txt"):
        if candidate.is_file():
            return str(candidate)
    return ""


def _cookies_args() -> list[str]:
    path = cookies_file()
    return ["--cookies-file", path] if path else []


def _formats() -> str:
    return os.environ.get("SCRIBD_WEB_FORMATS", "pdf").strip() or "pdf"


def build_command(job: Job) -> list[str]:
    if job.mode == "setup":
        # no shell on most panels: download *and* launch-test Chromium as a job
        return [sys.executable, "-m", "scribd.browsersetup"]

    command = [
        sys.executable, "-m", "scribd",
        "-o", str(OUT_DIR),
        "-f", _formats(),
        "--browser", "--no-cache",
    ]
    if os.environ.get("SCRIBD_WEB_NO_EMBED"):
        command.append("--no-embed")
    command += _cookies_args()

    if os.environ.get("SCRIBD_WEB_FAST"):
        command.append("--fast")
    workers = os.environ.get("SCRIBD_WEB_WORKERS", "").strip()
    if workers.isdigit():
        command += ["--workers", workers]
    jobs = os.environ.get("SCRIBD_WEB_JOBS", "").strip()
    if jobs.isdigit():
        command += ["--jobs", jobs]

    if job.mode == "search":
        command += [
            "--search", job.query,
            "--limit", str(max(0, job.limit)),
            "--search-pages", str(max(1, job.pages)),
            "--search-only",
        ]
        return command

    if job.urls:
        listing = job.dir / "urls.txt"
        job.dir.mkdir(parents=True, exist_ok=True)
        listing.write_text("".join(f"{url}\n" for url in job.urls), encoding="utf-8")
        command += ["--file", str(listing)]
        return command

    command += ["--search", job.query, "--limit", str(max(0, job.limit))]
    if job.picks:
        command += ["--pick", ",".join(str(number) for number in job.picks)]
    return command


# ---------------------------------------------------------------------------
# running jobs
# ---------------------------------------------------------------------------
def _worker() -> None:
    while True:
        job_id = QUEUE.get()
        try:
            if job_id is None:
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if job is None or job.status != "queued":
                continue
            process_job(job)
        finally:
            QUEUE.task_done()


def ensure_workers() -> None:
    with WORKERS_LOCK:
        if WORKERS:
            return
        for _ in range(CONCURRENCY):
            thread = threading.Thread(target=_worker, name="scribd-web-job", daemon=True)
            thread.start()
            WORKERS.append(thread)


def process_job(job: Job) -> None:
    """Run one job to completion (separated out so tests can call it)."""
    job.status = "running"
    job.started_at = _now()
    job.save()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    job.dir.mkdir(parents=True, exist_ok=True)
    try:
        job.command = build_command(job)
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        with job.log_path.open("ab") as handle:
            handle.write(f"\n$ {' '.join(job.command)}\n".encode())
            handle.flush()
            job.process = subprocess.Popen(
                job.command,
                cwd=str(REPO_ROOT),
                stdout=handle,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            job.returncode = job.process.wait()
        job.status = "done" if job.returncode == 0 else "failed"
        if job.status == "failed":
            job.error = f"exit code {job.returncode}"
    except Exception as exc:  # pragma: no cover - environment failures
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        job.finished_at = _now()
        job.process = None
        job.save()


def enqueue(job: Job) -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job.save()
    with JOBS_LOCK:
        JOBS[job.id] = job
        _prune()
    ensure_workers()
    QUEUE.put(job.id)


def _prune() -> None:
    if len(JOBS) <= MAX_JOBS_KEPT:
        return
    for job_id in sorted(JOBS, key=lambda key: JOBS[key].created_at)[: len(JOBS) - MAX_JOBS_KEPT]:
        if JOBS[job_id].status in ("queued", "running"):
            continue
        JOBS.pop(job_id, None)


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------
def _authorized() -> bool:
    token = os.environ.get("SCRIBD_WEB_TOKEN", "").strip()
    if token and (
        request.headers.get("X-Token") == token or request.args.get("token") == token
    ):
        return True
    user = os.environ.get("SCRIBD_WEB_USER", "")
    password = os.environ.get("SCRIBD_WEB_PASS", "")
    if not user and not password:
        return True  # no auth configured (fine behind a private network)
    auth = request.authorization
    return bool(auth and auth.username == user and auth.password == password)


@app.before_request
def _require_auth():
    if request.path.startswith("/api/health"):
        return None
    if _authorized():
        return None
    return Response(
        "authentication required",
        401,
        {"WWW-Authenticate": 'Basic realm="scribd"'},
    )


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "version": __version__,
            "browser": browser_status(),
            "jobs": len(JOBS),
            "concurrency": CONCURRENCY,
            "env_file": str(ENV_FILE) if ENV_FILE else "",
            "cookies": bool(cookies_file()),
            "sysroot_libs": len(lib_dirs()),
            "out": str(OUT_DIR),
            "auth": bool(
                os.environ.get("SCRIBD_WEB_USER")
                or os.environ.get("SCRIBD_WEB_PASS")
                or os.environ.get("SCRIBD_WEB_TOKEN")
            ),
        }
    )


@app.post("/api/jobs")
def create_job():
    payload = request.get_json(silent=True) or {}
    mode = str(payload.get("mode") or "search").lower()
    if mode not in ("search", "download", "setup"):
        return jsonify({"error": "mode must be 'search', 'download' or 'setup'"}), 400

    query = str(payload.get("query") or "").strip()
    urls = [str(url).strip() for url in (payload.get("urls") or []) if str(url).strip()]
    picks = [int(n) for n in (payload.get("picks") or []) if str(n).isdigit()]
    try:
        limit = int(payload.get("limit", 5))
    except (TypeError, ValueError):
        limit = 5
    try:
        pages = int(payload.get("pages", 3))
    except (TypeError, ValueError):
        pages = 3

    if mode == "setup":
        job = Job(id=uuid.uuid4().hex[:12], mode="setup", query="")
        enqueue(job)
        return jsonify(job.as_dict()), 202

    if mode == "search" and not query:
        return jsonify({"error": "query is required for a search"}), 400
    if mode == "download" and not query and not urls:
        return jsonify({"error": "give 'urls' or a 'query'"}), 400

    job = Job(
        id=uuid.uuid4().hex[:12],
        mode=mode,
        query=query,
        limit=max(0, limit),
        pages=max(1, pages),
        picks=picks,
        urls=urls,
    )
    enqueue(job)
    return jsonify(job.as_dict()), 202


@app.get("/api/jobs")
def list_jobs():
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda job: job.created_at, reverse=True)
        return jsonify({"jobs": [job.as_dict() for job in jobs]})


@app.get("/api/jobs/<job_id>")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "no such job"}), 404
    return jsonify(job.as_dict())


@app.get("/api/jobs/<job_id>/log")
def job_log(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "no such job"}), 404
    try:
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        offset = 0
    data = b""
    try:
        with job.log_path.open("rb") as handle:
            handle.seek(offset)
            data = handle.read(200_000)
    except OSError:
        data = b""
    text = data.decode("utf-8", errors="replace")
    return jsonify({"offset": offset + len(data), "text": text, "status": job.status})


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "no such job"}), 404
    if job.process is not None:
        try:
            job.process.terminate()
        except Exception:
            pass
        job.status = "cancelled"
        job.finished_at = _now()
        job.save()
        return jsonify(job.as_dict())
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = _now()
        job.save()
        return jsonify(job.as_dict())
    return jsonify({"error": f"job is {job.status}"}), 409


def _safe_file(name: str) -> Path | None:
    candidate = (OUT_DIR / Path(name).name).resolve()
    try:
        candidate.relative_to(OUT_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


@app.get("/api/jobs/<job_id>/file/<path:name>")
def job_file(job_id: str, name: str):
    if job_id not in JOBS:
        return jsonify({"error": "no such job"}), 404
    path = _safe_file(name)
    if path is None:
        return jsonify({"error": "no such file"}), 404
    return send_file(path, as_attachment=True, download_name=path.name)


@app.get("/api/jobs/<job_id>/zip")
def job_zip(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "no such job"}), 404
    files = _job_files(job)
    if not files:
        return jsonify({"error": "this job has no PDFs yet"}), 404
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, arcname=path.name)
        if (OUT_DIR / "manifest.jsonl").is_file():
            archive.write(OUT_DIR / "manifest.jsonl", arcname="manifest.jsonl")
    buffer.seek(0)
    name = f"scribd-{_slug(job.query or job.id)}.zip"
    return send_file(
        buffer, mimetype="application/zip", as_attachment=True, download_name=name
    )


@app.get("/")
def index():
    return Response(PAGE, mimetype="text/html")


# ---------------------------------------------------------------------------
# the page (no external assets, no build step)
# ---------------------------------------------------------------------------
PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scribd search &amp; download</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1100px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  form, .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input[type=text], input[type=number] { padding: 8px 10px; border: 1px solid #8884; border-radius: 6px; }
  input[type=text] { flex: 1 1 320px; }
  button { padding: 8px 14px; border: 1px solid #8884; border-radius: 6px; cursor: pointer; background: #8882; }
  button.primary { background: #2b7a0b; color: #fff; border-color: #2b7a0b; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-weight: 600; color: #888; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; max-height: 320px; font-size: 12.5px; }
  .muted { color: #888; }
  .tag { padding: 1px 6px; border-radius: 999px; background: #8883; font-size: 12px; }
  .ok { background: #2b7a0b33; } .failed { background: #b32b2b33; }
  section { margin-top: 28px; }
</style>
<h1>Scribd search &amp; download</h1>

<div id="setup" hidden>
  <p><strong>This server has no browser yet.</strong>
     Searches and downloads run in Chromium — nothing works until it is installed.</p>
  <p class="muted" id="setupmsg"></p>
  <button class="primary" id="installbrowser">Install &amp; test Chromium (~150 MB)</button>
</div>

<form id="search">
  <input type="text" id="q" placeholder="search Scribd, e.g. excel and succeed" required>
  <label class="muted">results <input type="number" id="limit" value="50" min="0" max="500" style="width:80px"></label>
  <label class="muted">search pages <input type="number" id="pages" value="5" min="1" max="50" style="width:70px"></label>
  <button class="primary">Search</button>
</form>
<div id="searchinfo" class="muted"></div>

<section id="results-section" hidden>
  <div class="row">
    <button id="all">Select all</button>
    <button id="none">Select none</button>
    <button class="primary" id="download">Download selected</button>
    <button id="downloadall">Download all found</button>
    <span id="count" class="muted"></span>
  </div>
  <table><thead><tr><th></th><th>#</th><th>Title</th><th></th></tr></thead>
  <tbody id="results"></tbody></table>
</section>

<section>
  <h2 style="font-size:16px">Jobs</h2>
  <table><thead><tr><th>Job</th><th>Mode</th><th>Status</th><th>PDFs</th><th></th></tr></thead>
  <tbody id="jobs"></tbody></table>
</section>

<section>
  <div class="row"><h2 style="font-size:16px;margin:0">Log</h2><button id="refresh">Refresh</button></div>
  <pre id="log" class="muted">no job selected</pre>
</section>

<script>
let current = null;      // current search job id
let hits = [];
let selected = new Set();
let watch = null;        // job id being logged
let offset = 0;

const $ = (id) => document.getElementById(id);
async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

$('search').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('searchinfo').textContent = 'searching… (a browser session, ~20-40s)';
  $('results-section').hidden = true;
  const job = await api('/api/jobs', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'search', query: $('q').value, limit: Number($('limit').value), pages: Number($('pages').value) || 5})
  });
  current = job.id;
  watchJob(job.id);
  await waitFor(job.id);
});

async function waitFor(id) {
  for (;;) {
    const job = await api('/api/jobs/' + id);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function watchJob(id) {
  watch = id; offset = 0; $('log').textContent = '';
  clearInterval(window.__t);
  window.__t = setInterval(async () => {
    if (!watch) return;
    try {
      const chunk = await api(`/api/jobs/${watch}/log?offset=${offset}`);
      offset = chunk.offset;
      if (chunk.text) {
        const pre = $('log');
        pre.textContent += chunk.text;
        pre.scrollTop = pre.scrollHeight;
      }
    } catch (e) {}
    loadJobs();
  }, 2000);
}

async function loadJobs() {
  try {
    const data = await api('/api/jobs');
    $('jobs').innerHTML = data.jobs.map((job) => `
      <tr>
        <td><a href="#" data-log="${job.id}">${job.id}</a></td>
        <td>${job.mode}${job.query ? ' · ' + escapeHtml(job.query) : ''}${job.picks.length ? ' · pick ' + job.picks.join(',') : ''}</td>
        <td class="${job.status}"><span class="tag">${job.status}</span>${job.error ? ' <span class="muted">' + escapeHtml(job.error) + '</span>' : ''}</td>
        <td>${job.pdf_count}${job.manifest.counts.failed ? ' <span class="muted">(' + job.manifest.counts.failed + ' failed)</span>' : ''}</td>
        <td>${job.pdf_count ? `<a href="/api/jobs/${job.id}/zip">zip</a>` : ''}</td>
      </tr>`).join('');
    document.querySelectorAll('[data-log]').forEach((link) => {
      link.onclick = (event) => { event.preventDefault(); watchJob(link.dataset.log); };
    });
  } catch (e) {}
}

$('all').onclick = () => { hits.forEach((h) => selected.add(h.doc_id)); render(); };
$('none').onclick = () => { selected.clear(); render(); };

$('downloadall').onclick = async () => {
  const answer = confirm(`Download all ${hits.length} results? This can run for a long time; the job resumes where it stopped if interrupted.`);
  if (!answer) return;
  const job = await api('/api/jobs', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'download', query: $('q').value, limit: 0, pages: Number($('pages') ? $('pages').value : 5) || 5})
  });
  watchJob(job.id);
  loadJobs();
};

$('download').onclick = async () => {
  const chosen = hits.filter((h) => selected.has(h.doc_id));
  if (!chosen.length) return;
  const job = await api('/api/jobs', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'download', query: $('q').value, urls: chosen.map((h) => h.url)})
  });
  watchJob(job.id);
  loadJobs();
};

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function render() {
  $('count').textContent = `${selected.size} of ${hits.length} selected`;
  $('results').innerHTML = hits.map((hit, index) => `
    <tr>
      <td><input type="checkbox" data-id="${hit.doc_id}" ${selected.has(hit.doc_id) ? 'checked' : ''}></td>
      <td class="muted">${index + 1}</td>
      <td>${escapeHtml(hit.title)}<div class="muted">${escapeHtml(hit.url)}</div></td>
      <td><a href="${escapeHtml(hit.url)}" target="_blank" rel="noopener">open</a></td>
    </tr>`).join('');
  document.querySelectorAll('input[data-id]').forEach((box) => {
    box.onchange = () => {
      box.checked ? selected.add(box.dataset.id) : selected.delete(box.dataset.id);
      render();
    };
  });
}

async function checkBrowser() {
  try {
    const health = await api('/api/health');
    const status = health.browser || {};
    if (!status.playwright) {
      $('setup').hidden = false;
      $('setupmsg').textContent = 'The python package playwright is missing. Add it to requirements.txt (or the Additional Python packages field) and restart; this button cannot fix that.';
      $('installbrowser').hidden = true;
    } else if (!status.chromium) {
      $('setup').hidden = false;
      $('setupmsg').textContent = 'Playwright is installed, Chromium is not. Press the button once; it stays installed.';
      $('installbrowser').hidden = false;
    } else {
      $('setup').hidden = true;
    }
  } catch (e) {}
}

$('installbrowser').onclick = async () => {
  $('installbrowser').disabled = true;
  $('setupmsg').textContent = 'downloading Chromium, then launching it to be sure it works… the log below shows both';
  const job = await api('/api/jobs', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'setup'})
  });
  watchJob(job.id);
  const finished = await waitFor(job.id);
  $('installbrowser').disabled = false;
  await checkBrowser();
  if (finished.returncode === 0) {
    $('setupmsg').textContent = 'Chromium downloaded, launched and printed a test PDF. You can search now.';
    $('setup').hidden = true;
  } else {
    $('setupmsg').textContent = 'Chromium does not work on this server yet — the last lines of the log say exactly why.';
  }
};

checkBrowser();

// the search job writes its hits to disk; poll for them
const originalWaitFor = waitFor;
waitFor = async function (id) {
  const job = await originalWaitFor(id);
  if (job.mode === 'search') {
    hits = job.results || [];
    selected = new Set();
    $('searchinfo').textContent = hits.length
      ? `${hits.length} documents found — tick the ones you want`
      : 'no results (the log shows what the browser saw)';
    $('results-section').hidden = hits.length === 0;
    render();
  }
  loadJobs();
  return job;
};

loadJobs();
</script>
"""


def main(host: str | None = None, port: int | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Scribd search/download web UI")
    parser.add_argument("--host", default=None, help="default: SCRIBD_WEB_HOST, else 127.0.0.1")
    parser.add_argument("--port", type=int, default=None,
                        help="default: SCRIBD_WEB_PORT, SERVER_PORT (panels), PORT, else 8000")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    host, port = resolve_bind(args.host or host, args.port or port)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ensure_workers()
    auth = ensure_auth(host)
    if auth == "configured":
        print("auth: configured (SCRIBD_WEB_USER/SCRIBD_WEB_PASS or SCRIBD_WEB_TOKEN)", flush=True)
    elif auth == "open-loopback":
        print("auth: none, but bound to loopback only — fine for local use", flush=True)

    status = browser_status()
    if not status["playwright"]:
        print(
            "browser: playwright is NOT installed — search and download will fail.\n"
            "         fix: add `playwright` to requirements.txt (or the panel's "
            "PY_PACKAGES) and restart.",
            flush=True,
        )
    elif not status["chromium"]:
        print(
            "browser: playwright is installed but Chromium is not downloaded yet.\n"
            "         open the page and press 'Install Chromium', or run:\n"
            "         python -m playwright install chromium",
            flush=True,
        )
    else:
        print(f"browser: chromium at {status['chromium_path']}", flush=True)

    os.environ.setdefault("FLASK_SKIP_DOTENV", "1")  # we load .env ourselves
    print(f"data: {DATA_DIR}\nlistening on http://{host}:{port}", flush=True)
    app.run(host=host, port=port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
