#!/usr/bin/env bash
set -euo pipefail

# Restart only the explicitly configured server on the explicitly configured
# HTTPS panel. Never discover a server or guess a hostname from the SFTP host.
if [[ -z "${PANEL_API_KEY:-}" ]]; then
  echo '::notice::Restart skipped: PANEL_API_KEY is not configured. Restart the uploaded server manually in the panel.'
  exit 0
fi
if [[ -z "${PANEL_URL:-}" || -z "${PANEL_SERVER_ID:-}" ]]; then
  echo '::warning::Restart skipped: set PANEL_URL and PANEL_SERVER_ID for the intended server, or restart it manually.'
  exit 0
fi
if [[ ! "$PANEL_SERVER_ID" =~ ^[A-Za-z0-9_-]{1,100}$ ]]; then
  echo '::warning::Restart skipped: PANEL_SERVER_ID is not a valid server identifier.'
  exit 0
fi

# Accept the panel origin or its /server/... page, but reject credentials,
# query strings, fragments, and non-HTTPS URLs. Preserve a panel subpath.
if ! base="$(node -e '
  try {
    const u = new URL(process.env.PANEL_URL);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) process.exit(1);
    const pathname = u.pathname.replace(/\/server\/.*$/, "").replace(/\/$/, "");
    process.stdout.write(u.origin + pathname);
  } catch { process.exit(1); }
' 2>/dev/null)"; then
  echo '::warning::Restart skipped: PANEL_URL must be a valid HTTPS panel URL without credentials, a query or a fragment.'
  exit 0
fi

for api in client application; do
  code="$(curl -sS --proto '=https' --max-time 20 --output /dev/null --write-out '%{http_code}' \
    --request POST \
    -H "Authorization: Bearer $PANEL_API_KEY" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    --data '{"signal":"restart"}' \
    -- "$base/api/$api/servers/$PANEL_SERVER_ID/power" 2>/dev/null)" || code='unreachable'
  if [[ "$code" == '200' || "$code" == '204' ]]; then
    echo '::notice::Restart requested for the configured server. A request does not confirm completion.'
    exit 0
  fi
done

echo '::warning::Restart was not accepted. Files were uploaded; restart the configured server manually in the panel.'
