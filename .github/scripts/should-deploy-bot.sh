#!/usr/bin/env bash
set -euo pipefail

# Automatic deployments compare the entire push, not just its final commit.
# If the comparison cannot be trusted, fail closed and require a manual run.
write_decision() {
  printf 'deploy=%s\n' "$1" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
}

case "${GITHUB_EVENT_NAME:-}" in
  workflow_dispatch)
    if [[ "${GITHUB_REF:-}" != 'refs/heads/main' ]]; then
      echo '::error::Bot deployments must be run from the main branch.'
      exit 1
    fi
    echo 'Manual bot deployment requested from main.'
    write_decision true
    ;;
  push)
    if [[ "${GITHUB_REF:-}" != 'refs/heads/main' ]]; then
      echo 'Not a main-branch push; skipping bot deployment.'
      write_decision false
      exit 0
    fi

    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    if bash "$script_dir/bot-diff.sh" "${PUSH_BEFORE:-}" "${GITHUB_SHA:-}"; then
      echo 'No bot code or configuration changes; skipping bot upload and restart.'
      write_decision false
    else
      result=$?
      if [[ "$result" -eq 1 ]]; then
        echo 'Bot changes detected; proceeding with deployment checks.'
        write_decision true
      else
        echo '::warning::Could not verify the changed commits. Bot upload skipped; run the workflow manually from main if needed.'
        write_decision false
      fi
    fi
    ;;
  *)
    echo 'Not a deployment event; skipping bot deployment.'
    write_decision false
    ;;
esac
