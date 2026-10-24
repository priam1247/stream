"""Give Chromium the system libraries it needs — without root.

A shared container often ships Chromium's *download* but not its *dependencies*:

    chrome-linux64/chrome: error while loading shared libraries:
    libnspr4.so: cannot open shared object file: No such file or directory

`apt-get install` is not available without root, and `playwright install-deps`
needs the same. But these libraries are just files inside Debian packages, and a
`.deb` is an `ar` archive holding a tarball. So we fetch only the packages named
by the dynamic loader, unpack them into `webdata/sysroot/`, and point
`LD_LIBRARY_PATH` at the result. Chromium then starts with the container's own
glibc and our copy of the rest.

    python -m scribd.sysroot            # find what is missing, fetch it, verify
    python -m scribd.sysroot --check    # just list the missing sonames
    python -m scribd.sysroot --clean    # throw the sysroot away

The command is idempotent and works offline after the first run. Nothing here
needs root, a compiler, or a package manager:

* `ldd` (part of glibc) tells us what is missing, including for the libraries we
  add — so dependencies are resolved transitively, one `ldd` pass at a time;
* the Debian `Packages` index tells us the exact file to download;
* `dpkg-deb -x` extracts when present, otherwise a small pure-Python
  `ar` + `tarfile` reader does it (`.xz`/`.gz`/`.bz2` in stdlib; `.zst` needs the
  optional `zstandard` wheel, or a `.deb` from a suite that still uses xz).

Knobs: SCRIBD_SYSROOT (default `webdata/sysroot`), SCRIBD_DEB_SUITE (default: the
container's own codename, else bookworm), SCRIBD_DEB_MIRROR.
"""
from __future__ import annotations

import gzip
import io
import json
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIRROR = os.environ.get("SCRIBD_DEB_MIRROR", "https://deb.debian.org/debian").rstrip("/")
USER_AGENT = "curl/8.5.0"

# soname -> Debian binary package. Debian package names are stable, the sonames
# are what the loader prints, so this table is the bridge between the two.
SONAME_PACKAGES: dict[str, str] = {
    "libnspr4.so": "libnspr4",
    "libnss3.so": "libnss3",
    "libnssutil3.so": "libnss3",
    "libsmime3.so": "libnss3",
    "libssl3.so": "libnss3",
    "libatk-1.0.so.0": "libatk1.0-0",
    "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
    "libcups.so.2": "libcups2",
    "libdrm.so.2": "libdrm2",
    "libgbm.so.1": "libgbm1",
    "libxkbcommon.so.0": "libxkbcommon0",
    "libX11.so.6": "libx11-6",
    "libX11-xcb.so.1": "libx11-xcb1",
    "libXcomposite.so.1": "libxcomposite1",
    "libXdamage.so.1": "libxdamage1",
    "libXext.so.6": "libxext6",
    "libXfixes.so.3": "libxfixes3",
    "libXrandr.so.2": "libxrandr2",
    "libXrender.so.1": "libxrender1",
    "libXtst.so.6": "libxtst6",
    "libXi.so.6": "libxi6",
    "libXcursor.so.1": "libxcursor1",
    "libXinerama.so.1": "libxinerama1",
    "libxcb.so.1": "libxcb1",
    "libxcb-shm.so.0": "libxcb-shm0",
    "libxcb-render.so.0": "libxcb-render0",
    "libxcb-shape.so.0": "libxcb-shape0",
    "libxcb-randr.so.0": "libxcb-randr0",
    "libxcb-sync.so.1": "libxcb-sync1",
    "libxcb-xfixes.so.0": "libxcb-xfixes0",
    "libxcb-image.so.0": "libxcb-image0",
    "libxcb-icccm.so.4": "libxcb-icccm4",
    "libxcb-keysyms.so.1": "libxcb-keysyms1",
    "libxcb-glx.so.0": "libxcb-glx0",
    "libxshmfence.so.1": "libxshmfence1",
    "libpango-1.0.so.0": "libpango-1.0-0",
    "libpangoft2-1.0.so.0": "libpangoft2-1.0-0",
    "libpangocairo-1.0.so.0": "libpangocairo-1.0-0",
    "libcairo.so.2": "libcairo2",
    "libasound.so.2": "libasound2",
    "libdbus-1.so.3": "libdbus-1-3",
    "libexpat.so.1": "libexpat1",
    "libfontconfig.so.1": "libfontconfig1",
    "libfreetype.so.6": "libfreetype6",
    "libpng16.so.16": "libpng16-16",
    "libharfbuzz.so.0": "libharfbuzz0b",
    "libgraphite2.so.3": "libgraphite2-3",
    "libfribidi.so.0": "libfribidi0",
    "libthai.so.0": "libthai0",
    "libdatrie.so.1": "libdatrie1",
    "libpixman-1.so.0": "libpixman-1-0",
    "libbsd.so.0": "libbsd0",
    "libmd.so.0": "libmd0",
    "libICE.so.6": "libice6",
    "libSM.so.6": "libsm6",
    "libuuid.so.1": "libuuid1",
    "libbrotlidec.so.1": "libbrotli1",
    "libbrotlicommon.so.1": "libbrotli1",
    "libglib-2.0.so.0": "libglib2.0-0",
    "libgobject-2.0.so.0": "libglib2.0-0",
    "libgio-2.0.so.0": "libglib2.0-0",
    "libgmodule-2.0.so.0": "libglib2.0-0",
    "libpcre2-8.so.0": "libpcre2-8-0",
    "libffi.so.8": "libffi8",
    "libselinux.so.1": "libselinux1",
    "liblzma.so.5": "liblzma5",
    "libzstd.so.1": "libzstd1",
    "libz.so.1": "zlib1g",
    "libstdc++.so.6": "libstdc++6",
    "libgcc_s.so.1": "libgcc-s1",
    "libwayland-client.so.0": "libwayland-client0",
    "libwayland-cursor.so.0": "libwayland-cursor0",
    "libwayland-egl.so.1": "libwayland-egl1",
    "libepoxy.so.0": "libepoxy0",
    "libxml2.so.2": "libxml2",
    "libavahi-client.so.3": "libavahi-client3",
    "libavahi-common.so.3": "libavahi-common3",
    "libkrb5.so.3": "libkrb5-3",
    "libk5crypto.so.3": "libk5crypto3",
    "libkrb5support.so.0": "libkrb5support0",
    "libcom_err.so.2": "libcom-err2",
    "libkeyutils.so.1": "libkeyutils1",
    "libgssapi_krb5.so.2": "libgssapi-krb5-2",
}


def sysroot() -> Path:
    configured = os.environ.get("SCRIBD_SYSROOT", "").strip()
    if configured:
        return Path(configured).expanduser()
    data = Path(os.environ.get("SCRIBD_WEB_DATA", str(REPO_ROOT / "webdata"))).expanduser()
    return data / "sysroot"


def lib_dirs(root: Path | None = None) -> list[str]:
    """Every directory of unpacked libraries, ready for LD_LIBRARY_PATH."""
    root = root or sysroot()
    found: list[str] = []
    for pattern in ("usr/lib/*-linux-gnu*", "lib/*-linux-gnu*"):
        for directory in sorted(root.glob(pattern)):
            if directory.is_dir() and str(directory) not in found:
                found.append(str(directory))
    if found:
        return found
    # no multiarch layout: use the plain paths if they actually hold libraries
    for pattern in ("usr/lib64", "usr/lib", "lib"):
        directory = root / pattern
        if directory.is_dir() and any(directory.glob("*.so*")):
            found.append(str(directory))
    return found


def apply_env(root: Path | None = None) -> str:
    """Prepend the sysroot to LD_LIBRARY_PATH (idempotent). Returns the value."""
    directories = lib_dirs(root)
    if not directories:
        return os.environ.get("LD_LIBRARY_PATH", "")
    current = [item for item in os.environ.get("LD_LIBRARY_PATH", "").split(":") if item]
    merged = directories + [item for item in current if item not in directories]
    value = ":".join(merged)
    os.environ["LD_LIBRARY_PATH"] = value
    return value


# ---------------------------------------------------------------------------
# what is missing
# ---------------------------------------------------------------------------
def parse_ldd(output: str) -> list[str]:
    """sonames the loader could not find ('libX.so => not found')."""
    missing: list[str] = []
    for line in (output or "").splitlines():
        if "not found" not in line:
            continue
        match = re.search(r"([\w.+-]+\.so[\w.]*)\s*=>\s*not found", line)
        if match and match.group(1) not in missing:
            missing.append(match.group(1))
    return missing


def missing_sonames(binary: str | Path) -> list[str]:
    """Run the loader against a binary or library and report what it lacks."""
    path = str(binary)
    try:
        result = subprocess.run(
            ["ldd", path],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ},
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_ldd(result.stdout + "\n" + result.stderr)


def package_for(soname: str) -> str:
    if soname in SONAME_PACKAGES:
        return SONAME_PACKAGES[soname]
    # libxcb-*.so.0 -> libxcb-*-0 ; libfoo.so.1 -> libfoo1 is too risky to guess
    match = re.match(r"libxcb-([a-z0-9]+)\.so\.\d+$", soname)
    if match:
        return f"libxcb-{match.group(1)}0"
    return ""


# ---------------------------------------------------------------------------
# the package index
# ---------------------------------------------------------------------------
def suite() -> str:
    configured = os.environ.get("SCRIBD_DEB_SUITE", "").strip()
    if configured:
        return configured
    try:
        text = Path("/etc/os-release").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return "bookworm"
    match = re.search(r"^VERSION_CODENAME=\"?([a-z]+)\"?", text, re.M)
    if match:
        return match.group(1)
    match = re.search(r"^UBUNTU_CODENAME=\"?([a-z]+)\"?", text, re.M)
    return match.group(1) if match else "bookworm"


def _download(url: str, destination: Path, timeout: int = 120) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return destination


def index_path(codename: str) -> Path:
    return sysroot().parent / f"packages-{codename}.json"


def build_index(codename: str | None = None, log=print) -> dict[str, dict]:
    """Download and cache the Debian Packages index (name -> filename)."""
    codename = codename or suite()
    cached = index_path(codename)
    if cached.is_file():
        try:
            return json.loads(cached.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass

    url = f"{MIRROR}/dists/{codename}/main/binary-amd64/Packages.xz"
    log(f"index: downloading {url}")
    raw = _download(url, sysroot().parent / f"Packages-{codename}.xz").read_bytes()
    text = lzma.decompress(raw).decode("utf-8", errors="replace")

    packages: dict[str, dict] = {}
    for block in text.split("\n\n"):
        if "Package:" not in block:
            continue
        fields: dict[str, str] = {}
        for line in block.splitlines():
            if line.startswith((" ", "\t")) or ":" not in line:
                continue
            key, _, value = line.partition(":")
            fields[key.strip().lower()] = value.strip()
        name = fields.get("package", "")
        filename = fields.get("filename", "")
        if name and filename:
            packages[name] = {
                "file": filename,
                "depends": fields.get("depends", "") + ", " + fields.get("pre-depends", ""),
            }
    try:
        cached.write_text(json.dumps(packages), encoding="utf-8")
    except OSError:
        pass
    log(f"index: {len(packages)} packages")
    return packages


# ---------------------------------------------------------------------------
# .deb extraction (no dpkg needed)
# ---------------------------------------------------------------------------
def _ar_members(data: bytes) -> dict[str, bytes]:
    """Minimal BSD/GNU `ar` reader — a .deb is one of these."""
    members: dict[str, bytes] = {}
    if not data.startswith(b"!<arch>\n"):
        return members
    offset = 8
    while offset + 60 <= len(data):
        header = data[offset : offset + 60]
        name = header[0:16].decode("ascii", "replace").strip().rstrip("/")
        size_text = header[48:58].decode("ascii", "replace").strip()
        try:
            size = int(size_text)
        except ValueError:
            break
        start = offset + 60
        members[name] = data[start : start + size]
        offset = start + size + (size % 2)
    return members


def _open_tar(payload: bytes, name: str):
    if name.endswith(".xz"):
        return tarfile.open(fileobj=io.BytesIO(lzma.decompress(payload)), mode="r:")
    if name.endswith(".gz"):
        return tarfile.open(fileobj=io.BytesIO(gzip.decompress(payload)), mode="r:")
    if name.endswith(".bz2"):
        import bz2

        return tarfile.open(fileobj=io.BytesIO(bz2.decompress(payload)), mode="r:")
    if name.endswith(".zst"):
        try:
            import zstandard  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on the host
            raise RuntimeError(
                "this .deb uses zstd; `pip install zstandard` (or set "
                "SCRIBD_DEB_SUITE=bullseye, which still ships xz packages)"
            ) from exc
        decompressed = zstandard.ZstdDecompressor().decompress(payload)
        return tarfile.open(fileobj=io.BytesIO(decompressed), mode="r:")
    return None


def extract_deb(deb: Path, destination: Path) -> list[str]:
    """Unpack a .deb into `destination`; returns the files written."""
    destination.mkdir(parents=True, exist_ok=True)
    if shutil.which("dpkg-deb"):
        result = subprocess.run(
            ["dpkg-deb", "-x", str(deb), str(destination)],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return [str(path) for path in destination.rglob("*") if path.is_file()]

    members = _ar_members(deb.read_bytes())
    written: list[str] = []
    for name, payload in members.items():
        if not name.startswith("data.tar"):
            continue
        archive = _open_tar(payload, name)
        if archive is None:
            continue
        with archive:
            archive.extractall(destination)  # noqa: S202 - our own .deb
        written = [str(path) for path in destination.rglob("*") if path.is_file()]
        break
    return written


# ---------------------------------------------------------------------------
# the fix
# ---------------------------------------------------------------------------
def ensure(
    binary: str | Path,
    log=print,
    limit: int = 40,
) -> tuple[bool, list[str]]:
    """Fetch every library `binary` lacks. Returns `(ok, packages)`."""
    root = sysroot()
    root.mkdir(parents=True, exist_ok=True)
    apply_env(root)  # anything already unpacked counts as present

    root_lib_dir = root / "usr" / "lib" / "x86_64-linux-gnu"
    packages: list[str] = []
    seen: set[str] = set()
    index: dict[str, dict] | None = None

    for _ in range(4):  # a few ldd rounds: libs have their own needs
        missing = [name for name in missing_sonames(binary) if name not in seen]
        if not missing:
            break
        if index is None:
            index = build_index(log=log)
        for soname in missing:
            seen.add(soname)
            package = package_for(soname)
            if not package:
                log(f"  {soname}: no known Debian package — skipping")
                continue
            entry = index.get(package)
            if not entry:
                log(f"  {soname}: {package} is not in the {suite()} index")
                continue
            url = f"{MIRROR}/{entry['file']}"
            target = root.parent / "debs" / Path(entry["file"]).name
            log(f"  {soname}: {package}")
            try:
                if not target.is_file():
                    _download(url, target)
                extract_deb(target, root)
            except Exception as exc:  # noqa: BLE001 - report and continue
                log(f"    failed: {type(exc).__name__}: {exc}")
                continue
            packages.append(package)
            if len(packages) >= limit:
                log(f"  stopping after {limit} packages")
                break
        apply_env(root)
        if len(packages) >= limit:
            break

    apply_env(root)
    still_missing = missing_sonames(binary)
    ok = not still_missing
    if ok:
        log(f"ok: all libraries found ({len(packages)} package(s) unpacked into {root})")
    else:
        log("still missing: " + ", ".join(still_missing[:12]))
        # the libs we fetched may themselves be missing headers-only deps
        unknown = [name for name in still_missing if not package_for(name)]
        if unknown:
            log(
                "no Debian package known for: " + ", ".join(unknown[:8])
                + "\n  send this line to the maintainer — it needs one line in "
                "scribd/sysroot.py"
            )
    return ok, packages


def clean(log=print) -> None:
    root = sysroot()
    for path in (root, root.parent / "debs"):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    for stale in root.parent.glob("packages-*.json"):
        stale.unlink(missing_ok=True)
    for stale in root.parent.glob("Packages-*.xz"):
        stale.unlink(missing_ok=True)
    log(f"removed {root} and its downloads")


def main(argv: list[str] | None = None) -> int:
    import argparse

    from .chromium import find_chromium

    parser = argparse.ArgumentParser(description="Unpack Chromium's system libraries without root")
    parser.add_argument("--check", action="store_true", help="only list missing libraries")
    parser.add_argument("--clean", action="store_true", help="delete the sysroot")
    parser.add_argument("--binary", help="check this binary instead of Chromium")
    args = parser.parse_args(argv)

    if args.clean:
        clean()
        return 0

    binary = args.binary or find_chromium()
    if not binary:
        print("no Chromium found — run `python -m playwright install chromium` first")
        return 1

    print(f"binary: {binary}")
    print(f"suite:  {suite()}   sysroot: {sysroot()}")
    if args.check:
        missing = missing_sonames(binary)
        print("missing: " + (", ".join(missing) if missing else "nothing"))
        if missing:
            print("packages: " + ", ".join(sorted({package_for(name) or "?" for name in missing})))
        return 0 if not missing else 1

    ok, packages = ensure(binary)
    if ok:
        dirs = lib_dirs()
        print("LD_LIBRARY_PATH=" + ":".join(dirs))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
