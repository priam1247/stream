#!/usr/bin/env python3
"""Alias for app.py, so any panel `PY_FILE` setting works unchanged."""
import pathlib
import runpy

runpy.run_path(str(pathlib.Path(__file__).resolve().parent / "app.py"), run_name="__main__")
