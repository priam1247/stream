# Split source for `scribd_download.py`

`tools/scribd_download.py` is a ~40-line loader. It reads `MANIFEST.json`, then
executes every `*.py` fragment here **in order, in one shared namespace**. That
means the behaviour is identical to the old 7,808-line monolith: every function
still sees the same globals, and `inspect.getsource()` still points at the real
fragment file.

- `MANIFEST.json` — execution order. Do not reorder without a reason.
- `MAP.md` — original line range and top-level name(s) for every fragment.
- `001_state_version.py` — shebang, module docstring, `from __future__`, imports,
  and the first block of constants.
- `NNN_<function>.py` — one top-level function or class per file.
- `NNN_state_*.py` — top-level constants/assignments that appeared between defs.
- `179_entry.py` — the original `if __name__ == "__main__":` block.

To make a deployable single file:

```bash
python3 tools/build_scribd_singlefile.py
python3 tools/build_scribd_singlefile.py --check   # verify it is in sync
python3 tools/scribd_download_singlefile.py --selftest
```

The generated file is ignored by Git; the fragments are the source of truth.
