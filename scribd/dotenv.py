"""A tiny `.env` reader, for hosts that give you no variable panel.

Panels without user-defined startup variables leave exactly one place to put
secrets: a file next to the code. This reads

    # .env, in the repo root, next to bot.py
    SCRIBD_WEB_USER=me
    SCRIBD_WEB_PASS="a long password with spaces"
    SCRIBD_WEB_COOKIES=/home/container/cookies.txt

Rules:

* `KEY=value`, one per line; `#` starts a comment, blank lines are ignored.
* Optional surrounding single or double quotes are stripped.
* An existing environment variable **always wins** — a real panel variable is
  not silently overridden by a file.
* Nothing is ever printed: values (passwords, cookies) stay in the process.
"""
from __future__ import annotations

import os
from pathlib import Path


def parse_env_text(text: str) -> dict[str, str]:
    """Parse `KEY=value` lines. Never raises: junk lines are skipped."""
    values: dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            # drop a trailing "  # comment"
            hash_at = value.find(" #")
            if hash_at != -1:
                value = value[:hash_at].rstrip()
        values[key] = value
    return values


def load_env_file(path: str | Path, override: bool = False) -> dict[str, str]:
    """Load one `.env` file into `os.environ`. Returns what it set."""
    try:
        text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return {}
    applied: dict[str, str] = {}
    for key, value in parse_env_text(text).items():
        if not override and key in os.environ and os.environ[key] != "":
            continue
        os.environ[key] = value
        applied[key] = value
    return applied


def load_env(*candidates: str | Path) -> Path | None:
    """Load the first `.env` that exists (later files never override)."""
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            load_env_file(candidate)
            return Path(candidate)
    return None


def mask(value: str) -> str:
    """For logging: show that a value exists without revealing it."""
    value = value or ""
    if not value:
        return "(empty)"
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[0]}{'*' * (len(value) - 2)}{value[-1]}"
