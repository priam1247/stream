"""Publish the local web UI as a temporary public URL — one command, no hosting.

The reason this exists: a browser is the hard part, and the machine that already
has a working one is *your own computer*. So the app runs there, where search and
`printToPDF` are known to work, and a tunnel gives it a public https address.

    python -m scribd.webapp --tunnel

Cloudflare's quick tunnel (`cloudflared`) needs no account and prints a
`https://<random>.trycloudflare.com` URL. `ngrok` is used if that is what is
installed. Nothing is installed automatically and nothing is written anywhere:
the URL lives only as long as the process.

Knobs: SCRIBD_TUNNEL_BIN (path to cloudflared/ngrok), SCRIBD_TUNNEL=none|cloudflared|ngrok.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

QUICK_HOST = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com", re.I)
NGROK_HOST = re.compile(r"https://[a-z0-9][a-z0-9-]*\.(?:ngrok(?:-free)?\.app|ngrok\.io|ngrok-free\.app)", re.I)

WINDOWS_HINTS = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Links/cloudflared.exe",
    Path("C:/Program Files/cloudflared/cloudflared.exe"),
    Path("C:/Program Files (x86)/cloudflared/cloudflared.exe"),
)

INSTALL_HINT = """\
no tunnel program found. Install one of these (no account needed for the first):

    winget install --id Cloudflare.cloudflared          # Windows
    brew install cloudflared                            # macOS
    sudo apt install cloudflared                        # Debian/Ubuntu

or download it from https://github.com/cloudflare/cloudflared/releases and put
`cloudflared` on your PATH. `ngrok` works too (`ngrok config add-authtoken …`).
"""


def find_binary() -> tuple[str, str]:
    """`(kind, path)` of the tunnel program, or `("", "")`."""
    forced = os.environ.get("SCRIBD_TUNNEL", "").strip().lower()
    explicit = os.environ.get("SCRIBD_TUNNEL_BIN", "").strip()

    candidates: list[tuple[str, str]] = []
    if explicit:
        name = Path(explicit).name.lower()
        candidates.append(("ngrok" if "ngrok" in name else "cloudflared", explicit))
    for name in ("cloudflared", "ngrok"):
        found = shutil.which(name)
        if found:
            candidates.append((name, found))
    for path in WINDOWS_HINTS:
        try:
            if path and path.is_file():
                candidates.append(("cloudflared", str(path)))
        except OSError:
            continue
    if forced in ("none", "off", "0"):
        return "", ""
    if forced in ("cloudflared", "ngrok"):
        for kind, path in candidates:
            if kind == forced:
                return kind, path
        return "", ""
    return candidates[0] if candidates else ("", "")


def command(kind: str, binary: str, port: int) -> list[str]:
    local = f"http://127.0.0.1:{port}"
    if kind == "ngrok":
        return [binary, "http", str(port), "--log", "stdout", "--log-format", "logfmt"]
    return [binary, "tunnel", "--url", local, "--no-autoupdate"]


def parse_url(text: str, kind: str = "") -> str:
    """Pull the https URL out of the tool's output."""
    if kind != "ngrok":
        match = QUICK_HOST.search(text or "")
        if match:
            return match.group(0)
    match = NGROK_HOST.search(text or "")
    return match.group(0) if match else ""


@dataclass
class Tunnel:
    kind: str
    process: subprocess.Popen | None = None
    url: str = ""
    lines: list[str] = field(default_factory=list)
    _thread: threading.Thread | None = None

    def stop(self) -> None:
        if self.process is None:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:  # already gone
            try:
                self.process.kill()
            except Exception:
                pass


def start(port: int, log=print, timeout: float = 45.0) -> Tunnel | None:
    """Start a quick tunnel for `port`. Returns None (with a hint) if impossible."""
    kind, binary = find_binary()
    if not kind:
        log(INSTALL_HINT)
        return None

    argv = command(kind, binary, port)
    log(f"tunnel: starting {kind} → http://127.0.0.1:{port}")
    try:
        process = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as exc:
        log(f"tunnel: could not run {binary}: {exc}")
        return None

    tunnel = Tunnel(kind=kind, process=process)
    ready = threading.Event()

    def read() -> None:
        for line in process.stdout or []:
            tunnel.lines.append(line.rstrip())
            if not tunnel.url:
                found = parse_url(line, kind)
                if found:
                    tunnel.url = found
                    ready.set()
        ready.set()

    tunnel._thread = threading.Thread(target=read, name="tunnel-reader", daemon=True)
    tunnel._thread.start()

    if not ready.wait(timeout):
        log("tunnel: no URL yet — the output below may explain why")
    if not tunnel.url:
        for line in tunnel.lines[-6:]:
            log(f"    {line}")
        tunnel.stop()
        return None

    log(f"tunnel: {tunnel.url}")
    log("tunnel: that address is public while this process runs (password still required)")
    return tunnel


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Start a temporary public tunnel")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--seconds", type=float, default=0, help="close after N seconds (0 = run)")
    args = parser.parse_args(argv)

    tunnel = start(args.port)
    if tunnel is None:
        return 1
    try:
        if args.seconds:
            import time

            time.sleep(args.seconds)
        else:
            tunnel._thread.join() if tunnel._thread else None
    except KeyboardInterrupt:
        pass
    finally:
        tunnel.stop()
    return 0 if tunnel.url else 1


if __name__ == "__main__":
    raise SystemExit(main())
