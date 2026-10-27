#!/usr/bin/env python3
"""Scribd panel — small loader for the four-file source.

The real code lives in ``scribd_core.py``, ``scribd_jobs.py`` and
``scribd_panel.py``. They are executed here in one shared namespace, in order,
so the public behaviour is exactly the same as the old monolithic file.

See ``tools/README.md`` for deployment. ``build_scribd_singlefile.py`` can make
a one-file copy for hosts that need one.
"""
from __future__ import annotations

import __future__
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SOURCES = ("scribd_core.py", "scribd_jobs.py", "scribd_panel.py")
_NS = globals()


def _scribd_source_text() -> str:
    """All source files concatenated, for selftests that inspect the whole source."""
    return "".join((_HERE / name).read_text(encoding="utf-8") for name in _SOURCES)


_NS["_scribd_source_text"] = _scribd_source_text

for _name in _SOURCES:
    _path = _HERE / _name
    _code = compile(
        _path.read_text(encoding="utf-8"),
        str(_path),
        "exec",
        flags=__future__.annotations.compiler_flag,
        dont_inherit=True,
    )
    exec(_code, _NS)

# Importers (screenshots_to_pdf.py, scribd_screenshots.py) see every function.
_NS["_scribd_source_text"] = _scribd_source_text
