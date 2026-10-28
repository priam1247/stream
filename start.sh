#!/usr/bin/env bash
# Single entry point. index.js auto-starts the Scribd panel via
# utils/scribdLauncher.js, so there is nothing else to supervise here.
# Deploy = add files + press Restart. No env vars, no setup commands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [ -f .env ]; then set -a; . .env; set +a; fi
exec node --expose-gc index.js "$@"
