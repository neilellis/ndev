#!/usr/bin/env bash
set -euo pipefail
git diff --check
npm test
scripts/ci/formal-check.sh
