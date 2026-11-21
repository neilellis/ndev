#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/check-plugin-version.mjs"
git diff --check
npm test
