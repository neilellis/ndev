#!/usr/bin/env bash
set -euo pipefail
for file in "$@"; do
  case "$file" in
    *.mjs|*.js|*.ts) node --check "$file" ;;
  esac
done
git diff --check
