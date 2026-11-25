#!/usr/bin/env bash
# Fail-closed local checks for {{repo}}.
# Adapted from scripts/precheck.sh in {{sourceRepo}}.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run lint
npm run typecheck
npm test
npm run build
