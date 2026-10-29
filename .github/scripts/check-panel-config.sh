#!/usr/bin/env bash
set -euo pipefail

# H/U/P/K are populated by GitHub Actions secrets. Never print their values.
if [[ -n "${H:-}" && -n "${U:-}" && ( -n "${P:-}" || -n "${K:-}" ) ]]; then
  echo 'ready=true' >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo 'Panel upload settings are present.'
  exit 0
fi

echo 'ready=false' >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
message='Configure PANEL_SFTP_HOST, PANEL_SFTP_USER, and either PANEL_SFTP_PASS or PANEL_SSH_KEY in GitHub Actions secrets.'
if [[ "${GITHUB_EVENT_NAME:-}" == 'workflow_dispatch' ]]; then
  echo "::error::$message Manual bot upload did not run."
  exit 1
fi

echo "::warning::$message Bot upload was skipped."
