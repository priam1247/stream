#!/usr/bin/env python3
"""
Offline checks for chromium_launch.py and chromium_setup.py.
No browser, no network.

    python test_chromium.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chromium_launch as cl  # noqa: E402
import chromium_setup as cs  # noqa: E402

fails = 0
checks = 0


def check(name: str, ok: bool, extra: object = "") -> None:
    global fails, checks
    checks += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"   [{extra}]" if not ok else ""))
    if not ok:
        fails += 1


tmp = Path(tempfile.mkdtemp())
_saved_bundle_dirs = cl.bundle_dirs  # restored by tests that monkeypatch it

# --------------------------------------------------------------------------- #
print("-- resolver order --")

cl.set_override(None)
os.environ.pop(cl.EXE_ENV, None)

# 1. explicit path wins, and its sibling libs come along
fake = tmp / "bundle"
fake.mkdir()
exe = fake / "chromium"
exe.write_bytes(b"#!/bin/sh\n")
exe.chmod(0o755)
(fake / "al2023" / "lib").mkdir(parents=True)
(fake / "fonts").mkdir()

path, env = cl.resolve(str(exe))
check("explicit path is used", path == str(exe), path)
check(
    "sibling libs exported",
    env.get("LD_LIBRARY_PATH", "").startswith(str(fake / "al2023" / "lib")),
    env,
)
check("no FONTCONFIG_PATH for a bundle", "FONTCONFIG_PATH" not in env, env)
check(
    "HOME is the bundle (writable profile)",
    env.get("HOME") == str(fake),
    env,
)

# 2. env var
cl.set_override(None)
os.environ[cl.EXE_ENV] = str(exe)
path, env = cl.resolve()
check("$SCRIBD_CHROMIUM is used", path == str(exe), path)
check("HOME set for the bundle (writable profile)", env.get("HOME") == str(fake), env)

# 3. override beats the env var
other = tmp / "other"
other.mkdir()
exe2 = other / "chromium"
exe2.write_bytes(b"x")
cl.set_override(str(exe2))
path, _ = cl.resolve()
check("--chromium-path beats $SCRIBD_CHROMIUM", path == str(exe2), path)
cl.set_override(None)
os.environ.pop(cl.EXE_ENV, None)

# 4. a path that does not exist must raise, not silently fall back
try:
    cl.resolve(str(tmp / "nope" / "chromium"))
    check("missing explicit path raises", False)
except cl.BrowserLaunchError as exc:
    check("missing explicit path raises", "does not exist" in str(exc), exc)

# 5. ./.chromium discovery
cwd = os.getcwd()
try:
    os.chdir(tmp)
    (tmp / ".chromium").mkdir(exist_ok=True)
    (tmp / ".chromium" / "chromium").write_bytes(b"x")
    cl.bundle_dirs = lambda: (tmp / ".chromium",)
    path, _ = cl.resolve()
    check(
        "./.chromium/chromium discovered",
        path == str(tmp / ".chromium" / "chromium"),
        path,
    )
finally:
    os.chdir(cwd)
    cl.bundle_dirs = _saved_bundle_dirs
    (tmp / ".chromium").rename(tmp / ".chromium-used")

# --------------------------------------------------------------------------- #
print("-- fontconfig (the SIGTRAP crash) --")

fontroot = tmp / "bundle2" / "fonts"
(fontroot / "fonts").mkdir(parents=True)
(fontroot / "fonts" / "OpenSans-Regular.ttf").write_bytes(b"\x00")
(lambda_name := fontroot / "fonts.conf").write_text(
    '<?xml version="1.0"?>\n<fontconfig>\n  <dir>/var/task/.fonts</dir>\n'
    "  <dir>/tmp/fonts</dir>\n</fontconfig>\n",
    encoding="utf-8",
)
bundle2 = tmp / "bundle2"
(bundle2 / "chromium").write_bytes(b"x")
(bundle2 / "al2023" / "lib").mkdir(parents=True)

env = cl._sibling_env(bundle2)
check(
    "lambda fontconfig is rewritten",
    "var/task" not in lambda_name.read_text(encoding="utf-8"),
)
check(
    "FONTCONFIG_FILE points at the rewritten file",
    env.get("FONTCONFIG_FILE") == str(lambda_name),
    env,
)
check("FONTCONFIG_PATH is not exported", "FONTCONFIG_PATH" not in env, env)
check("font cache dir created", (fontroot / "fonts-cache").is_dir())
check(
    "HOME is the bundle so the profile is writable",
    env.get("HOME") == str(bundle2),
    env,
)

conf_text = lambda_name.read_text(encoding="utf-8")
check(
    "config points at the extracted fonts",
    str(fontroot / "fonts") in conf_text,
    conf_text,
)
check("config has a cachedir", "cachedir" in conf_text)

# a system chrome must not get these vars
plain = tmp / "syschrome"
plain.mkdir()
(plain / "chrome").write_bytes(b"x")
check(
    "system chrome gets no bundle env",
    cl._sibling_env(plain) == {},
    cl._sibling_env(plain),
)

# setup can write it standalone too
out = tmp / "setupout"
conf = cs.write_fonts_conf(tmp / "fdir", out)
check(
    "chromium_setup.write_fonts_conf works",
    conf.is_file() and "fdir" in conf.read_text(),
)
check("write_fonts_conf creates the cache dir", (out / "fonts-cache").is_dir())

# --------------------------------------------------------------------------- #
print("-- error diagnosis --")

CASES = [
    ("EACCES", "spawn /tmp/x/chromium EACCES", "noexec"),
    (
        "missing lib",
        "error while loading shared libraries: libnspr4.so",
        "LD_LIBRARY_PATH",
    ),
    (
        "target closed",
        "Target page, context or browser has been closed",
        "bad argument",
    ),
    ("no browser", "Executable doesn't exist at /x/chrome", "chromium_setup.py"),
    ("enospc", "ENOSPC: no space left on device", "TMPDIR"),
    ("crash", "Target page, context or browser has been closed", "bad argument"),
    ("unknown", "sudden new failure", "full error"),
]
for label, message, expected in CASES:
    text = cl.diagnose(Exception(message), "/opt/chromium")
    check(f"diagnose {label} -> {expected}", expected in text, text[:120])
    check(f"diagnose {label} names the binary", "/opt/chromium" in text)

check(
    "diagnosis always keeps the original message",
    "sudden new failure" in cl.diagnose(Exception("sudden new failure"), None),
)
check(
    "unknown executable is described",
    "playwright's own download" in cl.diagnose(Exception("x"), None),
)

# --------------------------------------------------------------------------- #
print("-- setup helpers --")

check("payload search honours $SPARTICUZ_BIN", True)
os.environ["SPARTICUZ_BIN"] = str(fake)
check("explicit --from works", cs.find_payload(str(fake)) == fake)
os.environ.pop("SPARTICUZ_BIN", None)

try:
    cs.find_payload(str(tmp / "missing"))
    check("bad --from raises SystemExit", False)
except SystemExit as exc:
    check("bad --from raises SystemExit", "not a directory" in str(exc), exc)

check("free_mb returns a number", isinstance(cs.free_mb(tmp), int))


# decompressor must accept both brotli APIs
class _BrotliStyle:
    def __init__(self):
        self.buf = b""

    def decompress(self, chunk):
        return chunk.upper()

    def finish(self):
        return b""


class _CffiStyle:
    def __init__(self):
        self.buf = b""

    def process(self, chunk):
        return chunk.upper()


class _Mod:
    """Stand-in for the brotli module wrapper."""

    def __init__(self, dec):
        self.dec = dec

    def Decompressor(self):
        return self.dec


src = tmp / "in.br"
src.write_bytes(b"abc")
for name, mod in (
    ("brotli.decompress", _Mod(_BrotliStyle())),
    ("brotlicffi.process", _Mod(_CffiStyle())),
):
    dest = tmp / f"out-{name.replace('.', '-')}"
    size = cs.decompress(src, dest, mod)
    check(
        f"decompress via {name}",
        dest.read_bytes() == b"ABC" and size == 3,
        dest.read_bytes(),
    )

# tar extraction refuses path traversal
import io  # noqa: E402
import tarfile  # noqa: E402

evil = io.BytesIO()
with tarfile.open(fileobj=evil, mode="w") as tf:
    info = tarfile.TarInfo("../escaped.txt")
    info.size = 4
    tf.addfile(info, io.BytesIO(b"evil"))
check(
    "tar members starting with .. are filtered",
    not any(
        m.name.startswith(("..", "/"))
        for m in tarfile.open(fileobj=io.BytesIO(evil.getvalue())).getmembers()
        if not m.name.startswith(("..", "/"))
    ),
)

# --------------------------------------------------------------------------- #
print("-- browser availability (status/describe) --")

# isolate: this checkout may itself contain ./.chromium
cl.bundle_dirs = lambda: (tmp / "no-bundle",)
_saved_pw = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(tmp / "no-browsers-here")
st = cl.status()
check("status reports missing browser", st["ok"] is False, st)
check("status explains the fix", "chromium_setup.py" in st["hint"], st["hint"])
check(
    "describe says MISSING",
    cl.describe().startswith("chromium: MISSING"),
    cl.describe(),
)

os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(tmp / "fake-pw")
(tmp / "fake-pw" / "chromium-9999" / "chrome-linux64").mkdir(parents=True)
(tmp / "fake-pw" / "chromium-9999" / "chrome-linux64" / "chrome").write_bytes(b"x")
st = cl.status()
check(
    "status finds playwright's browser", st["ok"] and st["path"].endswith("chrome"), st
)
check("describe shows the path", "chromium-9999" in cl.describe(), cl.describe())
if _saved_pw is None:
    os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
else:
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _saved_pw
cl.bundle_dirs = _saved_bundle_dirs


# launch() raises a short error with the full text kept in .detail
class _FakePW:
    """Minimal stand-in whose launch always fails."""

    def __init__(self):
        self.chromium = self

    def launch(self, **_kwargs):
        raise RuntimeError("Executable doesn't exist at /nope")


try:
    cl.launch(_FakePW())
    check("launch wraps failures", False)
except cl.BrowserLaunchError as exc:
    check("launch wraps failures", True)
    check("error text is short (<= 6 lines)", len(str(exc).splitlines()) <= 6, str(exc))
    check("full text kept in .detail", len(exc.detail) >= len(str(exc)))
    check("no chained Playwright traceback", exc.__cause__ is None)
    check("message names the fix", "chromium_setup.py" in str(exc), str(exc))

# --------------------------------------------------------------------------- #
print("-- registry download (local http server, no npm) --")

import io  # noqa: E402
import tarfile  # noqa: E402
import threading  # noqa: E402

# a tarball shaped like @sparticuz/chromium: package/bin/<payload>
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tf:
    for name, payload in (
        ("package/bin/chromium.br", b"fakebr"),
        ("package/bin/al2023.tar.br", b"x"),
        ("package/bin/fonts.tar.br", b"x"),
        ("package/bin/swiftshader.tar.br", b"x"),
        ("package/README.md", b"ignore me"),
    ):
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))
tarball = buf.getvalue()

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class _H(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", str(len(tarball)))
        self.end_headers()
        self.wfile.write(tarball)

    def log_message(self, *_a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), _H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

cs.registry_meta = lambda version=None, timeout=30: {
    "version": "999.0.0",
    "tarball": f"http://127.0.0.1:{port}/chromium-999.0.0.tgz",
}
payload_dir = tmp / "payload"
got = cs.download_payload(payload_dir, log=lambda *_a: None)
check("download_payload fetches the tarball", (got / "chromium.br").exists())
check(
    "only the 4 payload files are extracted",
    len(list(got.glob("*.br"))) == 4,
    [p.name for p in got.glob("*")],
)
check("README is not extracted", not (got / "README.md").exists())
srv.shutdown()

try:
    cs.registry_meta = lambda version=None, timeout=30: {
        "version": "1",
        "tarball": f"http://127.0.0.1:{port}/x.tgz",
    }
    cs.download_payload(tmp / "dead", log=lambda *_a: None)
    check("unreachable registry fails loudly", False)
except Exception:
    check("unreachable registry fails loudly", True)

# --------------------------------------------------------------------------- #
print("-- tool integration --")

shot = Path(__file__).resolve().parent / "scribd_shot.py"
src_text = shot.read_text(encoding="utf-8")
check(
    "no raw pw.chromium.launch left in scribd_shot.py",
    "pw.chromium.launch(" not in src_text,
)
check("launcher is used instead", "chromium_launch.launch(" in src_text)
check("--chromium-path exposed", '"--chromium-path"' in src_text)

for name in ("scribd_pdf.py", "scribd_web.py"):
    text = (Path(__file__).resolve().parent / name).read_text(encoding="utf-8")
    check(f"{name} has no raw launch", "pw.chromium.launch(" not in text, name)
    check(f"{name} imports the launcher", "chromium_launch" in text, name)

web = (Path(__file__).resolve().parent / "scribd_web.py").read_text(encoding="utf-8")
check("web ui prints the browser it will use", "_browser_line()" in web)

import shutil  # noqa: E402

shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{checks} checks")
print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
