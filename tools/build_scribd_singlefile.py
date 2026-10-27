#!/usr/bin/env python3
"""Build a deployable one-file copy of the Scribd panel.

Development uses ``tools/scribd_download.py`` (a small loader) plus
``scribd_core.py``, ``scribd_jobs.py`` and ``scribd_panel.py``. Hosts that still
need one file (``PY_FILE=scribd_download.py`` on Pterodactyl) can upload the
output of this script instead:

    python3 tools/build_scribd_singlefile.py
    python3 tools/scribd_download_singlefile.py --selftest
"""
from __future__ import annotations

import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = ("scribd_core.py", "scribd_jobs.py", "scribd_panel.py")
DEFAULT_OUT = HERE / "scribd_download_singlefile.py"

HELPER = '''

def _scribd_source_text() -> str:
    """The whole single-file source, for selftests that inspect call sites."""
    import pathlib
    return pathlib.Path(__file__).read_text(encoding="utf-8")

'''


def bundle() -> str:
    text = "".join((HERE / name).read_text(encoding="utf-8") for name in SOURCES)
    marker = "from __future__ import annotations\n"
    if marker not in text:
        raise RuntimeError("scribd_core.py lost its future import")
    return text.replace(marker, marker + HELPER, 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output .py file")
    ap.add_argument("--check", action="store_true",
                    help="compare the output with the sources, write nothing")
    args = ap.parse_args()
    text = bundle()
    out = Path(args.out)
    if args.check:
        if not out.exists() or out.read_text(encoding="utf-8") != text:
            print(f"OUT OF DATE: {out}")
            return 1
        print(f"up to date: {out} ({len(text)} bytes)")
        return 0
    out.write_text(text, encoding="utf-8")
    out.chmod(0o755)
    print(f"wrote {out} ({len(text)} bytes, {text.count(chr(10)) + 1} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
