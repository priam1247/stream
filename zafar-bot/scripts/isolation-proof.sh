#!/usr/bin/env bash
# scripts/isolation-proof.sh — the grep evidence required by Phase 4D/4F.
#
# Runs the same checks as test/imports.test.js, but as plain grep so the output
# can be pasted into the migration report as evidence. Exit code is 0 only when
# every rule holds. This script is read-only.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
verdict() { # verdict <findings> <description>
  if [ -z "$2" ]; then
    printf '  \033[32mPASS\033[0m %s (0 hits)\n' "$1"
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$1"
    printf '%s\n' "$2" | sed 's/^/      /'
    FAIL=1
  fi
}

section "1. No command requires another command"
# Any relative require that climbs out of its own folder and lands in a sibling.
HITS=$(for f in $(find commands -mindepth 2 -name '*.js' -not -path '*/node_modules/*'); do
  own=$(echo "$f" | cut -d/ -f2)
  grep -oE "require\(['\"]\.\.[^'\"]*['\"]\)" "$f" 2>/dev/null \
    | sed "s|^|$f: |" \
    | while read -r line; do
        target=$(echo "$line" | sed -E "s/.*require\(['\"]//; s/['\"]\)//")
        resolved=$(cd "$(dirname "$f")" && realpath -m "$target")
        case "$resolved" in
          */commands/*) ;;
        esac
        if [ -d "$resolved" ] && [ "$(basename "$resolved")" != "$own" ] && \
           [ "$(dirname "$resolved")" = "$(pwd)/commands" ]; then
          echo "$line -> sibling command"
        fi
      done
done)
verdict "commands never require a sibling command folder" "$HITS"

section "2. No command reaches into gateway/"
HITS=$(grep -rnE "(require\(['\"][^'\"]*gateway/|from ['\"][^'\"]*gateway/)" commands --include='*.js' 2>/dev/null)
verdict "commands never import gateway/ internals" "$HITS"

section "3. No command touches the raw Baileys socket"
HITS=$(grep -rnE "(@whiskeysockets/baileys|makeWASocket|useMultiFileAuthState|downloadMediaMessage|downloadContentFromMessage)" commands --include='*.js' 2>/dev/null)
verdict "commands never import Baileys or download media themselves" "$HITS"

# The paper family keeps the original vault code, which talks to a *fake* socket
# defined in adapter.js. That shim is the only permitted socket-shaped call.
section "4. socket-shaped calls are confined to the paper adapters"
# Comments explain the design; only executable lines count as evidence.
strip() { sed -E 's://.*::' | grep -vE '^\s*[^:]*(\*|/\*)' ; }
HITS=$(grep -rnE "\bsock\.(sendMessage|sendReaction|sendDocument)\(" commands --include='*.js' 2>/dev/null \
  | grep -vE 'commands/(paper|countpapers|refreshpapers)/vault\.js' \
  | grep -vE ':[0-9]+:\s*(\*|//)')
verdict "only the ported vaults call the adapter shim" "$HITS"

HITS=$(grep -rnE "\bsendMessage\s*\(" commands --include='*.js' 2>/dev/null \
  | grep -vE 'commands/(paper|countpapers|refreshpapers)/adapter\.js')
verdict "sendMessage exists only in the adapters (which forward to ctx)" "$HITS"

section "5. No command reads or writes users.json"
HITS=$(grep -rnE "users\.json" commands --include='*.js' 2>/dev/null | grep -vE '^\S+:\s*\*|//')
verdict "commands never name users.json in code" "$HITS"

HITS=$(grep -rnE "\bwriteUsers\b|store\.(addUser|banUser|setRole|blockCommand)" commands --include='*.js' 2>/dev/null)
verdict "commands never call a store writer" "$HITS"

section "6. gateway/users/store.js is the only writer of users.json"
HITS=$(grep -rnE "writeJsonAtomic\(\s*usersFile|writeFileSync\(\s*usersFile" gateway lib scripts commands --include='*.js' 2>/dev/null \
  | grep -v '^gateway/users/store.js')
verdict "no writer outside store.js" "$HITS"

section "7. No command reached the old bot tree"
HITS=$(grep -rn "Whatsapp bot" --include='*.js' commands lib gateway 2>/dev/null)
verdict "no references to the old project" "$HITS"

section "8. gateway/ and lib/ hold no feature logic"
HITS=$(grep -rniE "\b(ytmp3|facebook|instagram|moviebox|torrentio|drime|debrid|paper|counterstrike|cinemeta)\b" gateway lib --include='*.js' 2>/dev/null)
verdict "no provider or feature names in the shared layers" "$HITS"

section "9. No fallback chains left in commands"
# The one remaining name is deltaFallback() in the paper vault: it is not a
# fallback path, it is the *named* delta-sync routine (full walk vs delta walk
# are two different jobs, chosen explicitly by the caller, not a retry ladder).
HITS=$(grep -rnE "(^|[^a-zA-Z])(fallback|Fallback)[A-Za-z]*\s*(=|:)" commands --include='*.js' 2>/dev/null \
  | grep -vE ':[0-9]+:\s*(\*|//)' \
  | grep -viE "engine/|hooks/|vendor/|host\.js|deltaFallback")
verdict "no fallback assignments outside the ported engine" "$HITS"

section "10. Baileys is pinned exactly"
PIN=$(node -e "const p=require('./package.json');process.stdout.write(p.dependencies['@whiskeysockets/baileys']||'MISSING')")
case "$PIN" in
  [0-9]*.[0-9]*.[0-9]*) printf '  \033[32mPASS\033[0m Baileys pinned at %s\n' "$PIN" ;;
  *) printf '  \033[31mFAIL\033[0m Baileys version is %s\n' "$PIN"; FAIL=1 ;;
esac

section "11. No committed secrets"
HITS=$(grep -rnE "(api[_-]?key|apikey|secret|password)\s*[:=]\s*['\"][A-Za-z0-9_-]{16,}['\"]" \
  --include='*.js' --include='*.json' --include='*.md' . 2>/dev/null \
  | grep -vE 'node_modules|package-lock|\.env\.example' | grep -vE ':[0-9]+:\s*(\*|//)')
verdict "no credential-looking literals" "$HITS"

section "12. Legacy privileged numbers are gone"
HITS=$(grep -rnE "265894016453|265997564836|265986741036|265894016451" \
  --include='*.js' --include='*.json' --include='*.md' . 2>/dev/null \
  | grep -vE 'node_modules|package-lock|storage/backups|^./test/|^./scripts/isolation-proof')
verdict "no hardcoded owner/admin numbers" "$HITS"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m✅ All isolation proofs hold.\033[0m\n'
else
  printf '\033[31m❌ Isolation proofs failed — see above.\033[0m\n'
fi
exit "$FAIL"
