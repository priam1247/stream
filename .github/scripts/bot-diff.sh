#!/usr/bin/env bash
set -euo pipefail

# Return 0 for identical bot runtime content, 1 for a change, and 2 if the
# comparison cannot be trusted. GitHub push SHAs are full 40-character hashes.
before="${1:-}"
after="${2:-}"
if [[ ! "$before" =~ ^[[:xdigit:]]{40}$ || ! "$after" =~ ^[[:xdigit:]]{40}$ || "$before" =~ ^0{40}$ ]] ||
   ! git cat-file -e "${before}^{commit}" 2>/dev/null ||
   ! git cat-file -e "${after}^{commit}" 2>/dev/null; then
  exit 2
fi

# A documentation-only edit does not require uploading or restarting the bot.
if git diff --quiet --no-renames "$before" "$after" -- \
  'Whatsapp bot/' ':(exclude,glob)Whatsapp bot/*.md' ':(exclude,glob)Whatsapp bot/**/*.md'; then
  exit 0
else
  result=$?
  if [[ "$result" -eq 1 ]]; then exit 1; fi
  exit 2
fi
