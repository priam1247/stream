#!/usr/bin/env python3
"""Split-source loader for the Scribd panel.

The real code lives in ``tools/scribd_parts/*.py`` — one fragment per top-level
function or class, plus small state/entry fragments. They are executed here in
``MANIFEST.json`` order in one shared namespace, so the behaviour is exactly the
same as the old monolithic file. See ``tools/scribd_parts/MAP.md``.
"""
from __future__ import annotations

import __future__
import json
from pathlib import Path

_SCRIBD_PARTS = Path(__file__).resolve().with_name("scribd_parts")
_SCRIBD_MANIFEST = json.loads(
    (_SCRIBD_PARTS / "MANIFEST.json").read_text(encoding="utf-8")
)
_SCRIBD_NS = globals()


def _scribd_source_text() -> str:
    """All fragments concatenated, for selftests that inspect the whole source."""
    return "\n".join(
        (_SCRIBD_PARTS / name).read_text(encoding="utf-8")
        for name in _SCRIBD_MANIFEST
    )


_SCRIBD_NS["_scribd_source_text"] = _scribd_source_text

for _scribd_name in _SCRIBD_MANIFEST:
    _scribd_path = _SCRIBD_PARTS / _scribd_name
    _scribd_code = compile(
        _scribd_path.read_text(encoding="utf-8"),
        str(_scribd_path),
        "exec",
        flags=__future__.annotations.compiler_flag,
        dont_inherit=True,
    )
    exec(_scribd_code, _SCRIBD_NS)

# Importers (screenshots_to_pdf.py, scribd_screenshots.py) see every function.
_SCRIBD_NS["_scribd_source_text"] = _scribd_source_text
