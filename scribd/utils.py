from __future__ import annotations

import re
from typing import Any, Iterator

ZW_CHARS = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff\u00ad"), None)


def extract_json_after(text: str, start: int = 0) -> str | None:
    """Return the first balanced {...} block at/after `start`, string-aware."""
    i = text.find("{", start)
    if i == -1:
        return None
    depth = 0
    in_str = False
    escaped = False
    for j in range(i, len(text)):
        ch = text[j]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[i : j + 1]
    return None


def iter_dicts(obj: Any) -> Iterator[dict]:
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from iter_dicts(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from iter_dicts(v)


def first_str(obj: Any, keys: tuple[str, ...]) -> str:
    for d in iter_dicts(obj):
        for k in keys:
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, dict):
                for nk in ("name", "display_name", "displayName"):
                    nv = v.get(nk)
                    if isinstance(nv, str) and nv.strip():
                        return nv.strip()
    return ""


def first_int(obj: Any, keys: tuple[str, ...]) -> int:
    for d in iter_dicts(obj):
        for k in keys:
            v = d.get(k)
            if isinstance(v, bool):
                continue
            if isinstance(v, int) and v > 0:
                return v
            if isinstance(v, str) and v.isdigit():
                return int(v)
    return 0


def slugify(name: str, maxlen: int = 80) -> str:
    name = re.sub(r"[^\w\s.-]", "", name, flags=re.UNICODE).strip()
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name).strip("._")
    return (name or "document")[:maxlen]


def parse_page_range(spec: str | None, total: int) -> tuple[int, int]:
    if not spec:
        return 1, total
    if "-" in spec:
        a, b = spec.split("-", 1)
        lo = int(a) if a.strip() else 1
        hi = int(b) if b.strip() else total
    else:
        lo = hi = int(spec)
    return max(1, lo), min(total, hi)
