#!/usr/bin/env bash
# Installs yt-dlp for hosts where pip is unavailable or the environment is
# "externally managed" (Debian/Ubuntu 23+, Katabump, Pterodactyl images, …).
# The bot can also do this by itself at runtime (.ytdl repair / automatic).
set -u
cd "$(dirname "$0")/.."

# yt-dlp is usable either as a command or as a python module
have_ytdlp() {
  if [ -x ./bin/yt-dlp ]; then ./bin/yt-dlp --version >/dev/null 2>&1 && return 0; fi
  if command -v yt-dlp >/dev/null 2>&1; then yt-dlp --version >/dev/null 2>&1 && return 0; fi
  python3 -m yt_dlp --version >/dev/null 2>&1 && return 0
  return 1
}

yt_version() {
  ./bin/yt-dlp --version 2>/dev/null || yt-dlp --version 2>/dev/null || python3 -m yt_dlp --version 2>/dev/null
}
have_ytdlp && { echo "✅ yt-dlp already installed: $(yt_version)"; exit 0; }

echo "→ trying pip (user install, break-system-packages allowed)…"
# Debian/Ubuntu 23+ and most panels mark the system python as "externally
# managed"; without --break-system-packages pip refuses to install anything.
python3 -m pip install --user -q --break-system-packages --upgrade 'yt-dlp[default]' 2>/dev/null \
  || python3 -m pip install -q --break-system-packages --upgrade 'yt-dlp[default]' 2>/dev/null \
  || pip3 install --user -q --break-system-packages --upgrade 'yt-dlp[default]' 2>/dev/null \
  || python3 -m pip install --user -q --upgrade 'yt-dlp[default]' 2>/dev/null \
  || true

if have_ytdlp; then
  echo "✅ yt-dlp installed: $(yt_version)"
  exit 0
fi

echo "→ pip did not work, downloading the standalone binary into ./bin …"
mkdir -p bin
bin_tmp=$(mktemp bin/.yt-dlp.XXXXXXXX) || exit 1
sums_tmp=$(mktemp bin/.yt-dlp-sums.XXXXXXXX) || { rm -f "$bin_tmp"; exit 1; }
trap 'rm -f "$bin_tmp" "$sums_tmp"' EXIT
release=https://github.com/yt-dlp/yt-dlp/releases/latest/download
if command -v curl >/dev/null 2>&1; then
  curl -fL --proto '=https' --proto-redir '=https' --retry 3 -o "$sums_tmp" "$release/SHA2-256SUMS" && \
    curl -fL --proto '=https' --proto-redir '=https' --retry 3 -o "$bin_tmp" "$release/yt-dlp" || exit 1
elif command -v wget >/dev/null 2>&1; then
  wget --https-only -O "$sums_tmp" "$release/SHA2-256SUMS" && \
    wget --https-only -O "$bin_tmp" "$release/yt-dlp" || exit 1
else
  echo "❌ neither curl nor wget available"; exit 1
fi
# Verify before chmod or execution. Both assets must arrive over verified HTTPS.
if ! python3 - "$bin_tmp" "$sums_tmp" <<'PY'
import hashlib, re, sys
binary, sums = sys.argv[1:]
with open(sums, encoding='utf-8') as f:
    match = re.search(r'^([a-fA-F0-9]{64})\s+\*?yt-dlp\s*$', f.read(), re.M)
with open(binary, 'rb') as f:
    digest = hashlib.file_digest(f, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(f.read()).hexdigest()
if not match or digest != match.group(1).lower():
    raise SystemExit('yt-dlp checksum missing or mismatched')
PY
then
  echo "❌ yt-dlp checksum verification failed"; exit 1
fi
chmod 755 "$bin_tmp"
"$bin_tmp" --version || { echo "❌ downloaded yt-dlp is not runnable"; exit 1; }
mv -f "$bin_tmp" bin/yt-dlp
echo "✅ standalone yt-dlp ready at ./bin/yt-dlp"
