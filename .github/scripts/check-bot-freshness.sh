#!/usr/bin/env bash
set -euo pipefail

# Do not let a slower, older workflow overwrite newer bot changes on main.
# A newer dashboard-only or markdown-only commit is safe: the bot is unchanged.
write_decision() {
  printf 'fresh=%s\n' "$1" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

skip_upload() {
  write_decision false
  if [[ "${GITHUB_EVENT_NAME:-}" == 'workflow_dispatch' ]]; then
    echo "::error::$1"
    exit 1
  fi
  echo "::warning::$1"
  exit 0
}

if ! git fetch --quiet --no-tags origin '+refs/heads/main:refs/remotes/origin/main' 2>/dev/null ||
   ! latest="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null)"; then
  skip_upload 'Could not verify the latest main branch. Bot upload skipped; run the workflow manually from main if needed.'
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if bash "$script_dir/bot-diff.sh" "${GITHUB_SHA:-}" "$latest"; then
  echo 'The tested bot matches the current main branch.'
  write_decision true
else
  result=$?
  if [[ "$result" -eq 1 ]]; then
    skip_upload 'Newer bot changes exist on main. This older upload was skipped.'
  else
    skip_upload 'Could not compare the tested bot with main. Bot upload was skipped.'
  fi
fi
