#!/usr/bin/env bash
# Shared repository identity for {{name}} GitHub helpers.
set -euo pipefail
REPO="{{repo}}"
OWNER="neilellis"
GH() { env -u GITHUB_TOKEN gh "$@"; }
