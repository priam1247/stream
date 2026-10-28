#!/usr/bin/env python3
"""
chromium_setup.py — get a working Chromium on a host where you have no root.

Why this exists
---------------
`python -m playwright install chromium` needs to run a browser it downloads into
~/.cache/ms-playwright.  On a shared panel that either fails (noexec /tmp, tiny
quota) or is forbidden.  `@sparticuz/chromium` solves the problem by shipping a
self-contained AL2023 build plus its own shared libraries, which is exactly what
this script unpacks — in pure Python, no Node, no root, no system packages.

    python chromium_setup.py                  # download + unpack into ./.chromium
    python chromium_setup.py --dir /path/bin  # somewhere else
    python chromium_setup.py --force           # re-extract
    python chromium_setup.py --version 147.0.0 # pin a build

**Node and npm are not required.** If node_modules/@sparticuz/chromium is not
present it downloads the package tarball straight from the npm registry with
`requests` and unpacks the payload itself. It writes:

    <dir>/chromium            the browser executable (chmod 755)
    <dir>/al2023/lib/*.so     the libraries it needs on a minimal host
    <dir>/fonts/              fonts, so text is not blank
    <dir>/swiftshader/        software GL

Then point the tools at it:

    export SCRIBD_CHROMIUM=$PWD/.chromium/chromium
    python scribd_shot.py <id> -o out

or pass --chromium-path on any of the three tools.
"""

from __future__ import annotations

import argparse
import os
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DIR = HERE / ".chromium"
PAYLOAD = Path("@sparticuz/chromium/bin")
BROTLI_HINT = "pip install brotli      (1 MB, pure wheel)"


def find_payload(explicit: str | None = None) -> Path:
    """Locate the @sparticuz/chromium bin directory that npm downloaded."""
    if explicit:
        path = Path(explicit)
        if path.is_dir():
            return path
        raise SystemExit(f"--from {path} is not a directory")

    env = os.environ.get("SPARTICUZ_BIN")
    if env and Path(env).is_dir():
        return Path(env)

    # walk up from here and from the cwd: node_modules may live one level up
    for start in (HERE, Path.cwd()):
        for parent in [start, *start.parents]:
            cand = parent / "node_modules" / PAYLOAD
            if cand.is_dir():
                return cand
            cand = parent / "browser-test" / "node_modules" / PAYLOAD
            if cand.is_dir():
                return cand

    raise SystemExit(
        "could not find node_modules/@sparticuz/chromium/bin\n"
        "  fix: python chromium_setup.py                  (downloads the payload)\n"
        "  or : python chromium_setup.py --from /path/to/@sparticuz/chromium/bin"
    )


REGISTRY = "https://registry.npmjs.org/@sparticuz/chromium"
PAYLOAD_FILES = ("chromium.br", "al2023.tar.br", "fonts.tar.br", "swiftshader.tar.br")


def registry_meta(version: str | None = None, timeout: int = 30) -> dict:
    """Ask the npm registry where the tarball is (no npm, no node)."""
    import requests

    url = f"{REGISTRY}/{version or 'latest'}"
    resp = requests.get(url, timeout=timeout, headers={"Accept": "application/json"})
    resp.raise_for_status()
    data = resp.json()
    return {"version": data["version"], "tarball": data["dist"]["tarball"]}


def download_payload(dest: Path, version: str | None = None, log=print) -> Path:
    """Fetch the @sparticuz tarball and extract just bin/*.br into dest."""
    import io
    import tarfile

    import requests

    meta = registry_meta(version)
    log(f"registry: version {meta['version']}")
    log(f"downloading {meta['tarball']}")
    with requests.get(meta["tarball"], stream=True, timeout=120) as resp:
        resp.raise_for_status()
        blob = resp.content
    log(f"  {len(blob) / 1e6:.0f} MB downloaded")

    dest.mkdir(parents=True, exist_ok=True)
    wanted = {f"package/bin/{name}" for name in PAYLOAD_FILES}
    found = []
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
        for member in tf.getmembers():
            if member.name not in wanted or not member.isfile():
                continue
            fh = tf.extractfile(member)
            if fh is None:
                continue
            out = dest / os.path.basename(member.name)
            out.write_bytes(fh.read())
            found.append(out.name)
    if "chromium.br" not in found:
        raise SystemExit(
            f"the tarball did not contain chromium.br (found: {found or 'nothing'})"
        )
    log(f"  payload: {', '.join(found)}")
    return dest


def ensure_payload(explicit: str | None, version: str | None = None, log=print) -> Path:
    """Find the payload, or download it from the registry if npm was never run."""
    try:
        return find_payload(explicit)
    except SystemExit:
        if explicit:
            raise
    log("no local payload - downloading from the npm registry (no npm needed)")
    cache = Path(os.environ.get("SPARTICUZ_CACHE") or DEFAULT_DIR / "_payload")
    return download_payload(cache, version=version, log=log)


def _brotli_module():
    try:
        import brotli  # type: ignore

        return brotli
    except ImportError:
        pass
    try:
        import brotlicffi as brotli  # type: ignore

        return brotli
    except ImportError:
        raise SystemExit(
            "this needs a brotli decompressor:\n  " + BROTLI_HINT
        ) from None


def decompress(src: Path, dest: Path, brotli) -> int:
    """brotli-decompress one file, streaming so 200 MB does not sit in RAM."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    dec = brotli.Decompressor()
    # the API differs between bindings: Brotli -> decompress(), brotli -> process()
    step = getattr(dec, "decompress", None) or dec.process
    with src.open("rb") as fin, dest.open("wb") as fout:
        while True:
            chunk = fin.read(1 << 20)
            if not chunk:
                break
            out = step(chunk)
            if out:
                fout.write(out)
                total += len(out)
        finish = getattr(dec, "finish", None)
        if finish is not None:
            tail = finish()
            if tail:
                fout.write(tail)
                total += len(tail)
    return total


def extract_tar_br(src: Path, dest: Path, brotli, label: str) -> None:
    """brotli -> tar -> dest, streaming through a temp file."""
    import tempfile

    with tempfile.TemporaryDirectory(dir=str(dest.parent)) as tmp:
        tarball = Path(tmp) / "payload.tar"
        size = decompress(src, tarball, brotli)
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tarball) as tf:
            members = [m for m in tf.getmembers() if not m.name.startswith(("/", ".."))]
            tf.extractall(dest, members=members)  # noqa: S202 - members filtered
        print(f"   {label}: {size / 1e6:.0f} MB -> {dest}")


def write_fonts_conf(fonts_dir: Path, out_dir: Path) -> Path:
    """Rewrite fonts.conf for *this* machine.

    The shipped file points at Lambda paths (/var/task/.fonts, /tmp/fonts). On a
    normal host fontconfig finds no font, Skia hits an unimplemented path and the
    browser dies with SIGTRAP the moment a page needs to render text - which is
    every real page. Point it at the directory we actually extracted.
    """
    conf = out_dir / "fonts.conf"
    cache = out_dir / "fonts-cache"
    cache.mkdir(parents=True, exist_ok=True)
    conf.write_text(
        '<?xml version="1.0"?>\n'
        '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n'
        "<fontconfig>\n"
        f"  <dir>{fonts_dir}</dir>\n"
        f"  <cachedir>{cache}</cachedir>\n"
        "  <config></config>\n"
        "</fontconfig>\n",
        encoding="utf-8",
    )
    return conf


def free_mb(path: Path) -> int:
    try:
        st = os.statvfs(path)
        return int(st.f_bavail * st.f_frsize / 1e6)
    except Exception:
        return -1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="chromium_setup.py",
        description="Unpack @sparticuz/chromium for use with Python Playwright.",
    )
    ap.add_argument("--dir", default=str(DEFAULT_DIR), help="where to unpack")
    ap.add_argument("--from", dest="src", default=None, help="the @sparticuz bin dir")
    ap.add_argument("--force", action="store_true", help="re-extract even if present")
    ap.add_argument(
        "--version",
        default=None,
        help="pin the @sparticuz/chromium version (default: whatever the registry "
        "has as 'latest'); ignored when node_modules is present",
    )
    ap.add_argument(
        "--no-download",
        action="store_true",
        help="never touch the network; fail if node_modules is missing",
    )
    ap.add_argument(
        "--print-env",
        action="store_true",
        help="only print the export lines (for eval/CI)",
    )
    args = ap.parse_args(argv)

    out = Path(args.dir).expanduser().resolve()
    exe = out / "chromium"
    libdir = out / "al2023" / "lib"
    fontdir = out / "fonts"

    if exe.exists() and not args.force:
        print(f"already unpacked: {exe} ({exe.stat().st_size / 1e6:.0f} MB)")
        # repair mode: an older run may have left the Lambda fontconfig in place
        if (out / "fonts" / "fonts").is_dir():
            conf = write_fonts_conf(out / "fonts" / "fonts", out / "fonts")
            print(f"   fontconfig: {conf}")
        print_env(exe, libdir, fontdir)
        return 0

    need = 500  # 200 MB binary + ~85 MB tarball + temp copy + slack
    have = free_mb(out.parent if out.parent.exists() else HERE)
    print(f"free    : {have} MB (need ~{need} MB)")
    if 0 <= have < need:
        print(
            "!! not enough space. the extracted browser is ~196 MB, the download is\n"
            "   ~80 MB and decompressing needs a temp copy while it works.\n"
            "   free some space, or use --dir to unpack onto a bigger volume.",
            file=sys.stderr,
        )
        return 1

    if args.no_download:
        bin_dir = find_payload(args.src)
    else:
        bin_dir = ensure_payload(args.src, version=args.version)
    print(f"payload : {bin_dir}")

    brotli = _brotli_module()
    out.mkdir(parents=True, exist_ok=True)

    print("-> chromium")
    size = decompress(bin_dir / "chromium.br", exe, brotli)
    exe.chmod(0o755)
    print(f"   chromium: {size / 1e6:.0f} MB -> {exe}")

    for name, label in (
        ("al2023.tar.br", "libraries"),
        ("fonts.tar.br", "fonts"),
        ("swiftshader.tar.br", "swiftshader"),
    ):
        src = bin_dir / name
        if not src.exists():
            print(f"   {label}: not shipped ({name}), skipping")
            continue
        target = out / ("al2023" if name.startswith("al2023") else name.split(".")[0])
        extract_tar_br(src, target, brotli, label)

    # the extracted fonts need a config that matches this host
    font_root = out / "fonts"
    if (font_root / "fonts").is_dir():
        conf = write_fonts_conf(font_root / "fonts", font_root)
        print(f"   fontconfig: {conf}")
    else:
        print("   fontconfig: no fonts extracted - pages with text may crash")

    print()
    print(f"ready: {exe}")
    print_env(exe, libdir, fontdir)
    return 0


def print_env(exe: Path, libdir: Path, fontdir: Path) -> None:
    libs = f"{libdir}:" if libdir.is_dir() else ""
    conf = fontdir / "fonts.conf"
    print("\nexport these (or pass --chromium-path):")
    print(f"  export SCRIBD_CHROMIUM={exe}")
    if libs:
        print(f'  export LD_LIBRARY_PATH="{libdir}:$LD_LIBRARY_PATH"')
    if conf.is_file():
        print(f"  export FONTCONFIG_FILE={conf}")
    print(f"  export HOME={exe.parent}")


if __name__ == "__main__":
    raise SystemExit(main())
