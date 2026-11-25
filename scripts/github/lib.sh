#!/usr/bin/env bash
# Shared GitHub settings for the github skill's helpers. Source this file; do not run it.
#
# Repository: $GH_REPO (OWNER/REPO) if set, else "github.repo" in the project's .neil-dev.json
# (see project-config.sh), else the repository of the current checkout, found with `gh repo view`. Each helper also accepts --repo where it says so.
#
# Token: when GH_USE_KEYRING=1, the helpers drop GITHUB_TOKEN so that the gh keyring
# login is used. Set it when the ambient token lacks the scopes a call needs
# (project, actions, read:org). Otherwise gh uses its normal authentication.
#
# Project board (optional): GH_PROJECT_OWNER and GH_PROJECT_NUMBER name a Projects v2
# board; unset, they come from "github.board" in .neil-dev.json. Field and option ids are looked up by name at run time; no ids are stored here.
set -euo pipefail

# shellcheck source=project-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/project-config.sh"

GH() {
  if [ "${GH_USE_KEYRING:-0}" = "1" ]; then
    env -u GITHUB_TOKEN gh "$@"
  else
    gh "$@"
  fi
}

# Resolve REPO once: the environment, then the origin remote, which costs no GitHub call, then gh,
# then REST. Fail with the repair command when it cannot be found.
gh_resolve_repo() {
  if [ -n "${REPO:-}" ]; then return 0; fi
  if [ -n "${GH_REPO:-}" ]; then REPO="$GH_REPO"; return 0; fi
  local origin out
  origin="$(git remote get-url origin 2>/dev/null || true)"
  if [[ "$origin" =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
    REPO="${BASH_REMATCH[1]%.git}"
    return 0
  fi
  if out="$(GH repo view --json nameWithOwner --jq .nameWithOwner 2>&1)" && [ -n "$out" ]; then REPO="$out"; return 0; fi
  if ! out="$(GH api 'repos/{owner}/{repo}' --jq .full_name 2>&1)" || [ -z "$out" ]; then
    echo "github lib: cannot find the GitHub repository for $(pwd): ${out:-no output}" >&2
    echo "  Repair: run from inside a checkout with a GitHub origin, or set GH_REPO=OWNER/REPO, or run 'gh auth login'." >&2
    return 1
  fi
  REPO="$out"
}
