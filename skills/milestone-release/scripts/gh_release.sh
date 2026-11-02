#!/usr/bin/env bash
# Create (or update) a GitHub release from a milestone release-notes markdown file
# (as produced by the `milestone-release-notes` skill and committed to the repo).
#
#   tag   = the file's basename without .md      (phase-1.md -> phase-1)
#   title = the file's first "# " H1 heading     (falls back to the tag)
#   body  = the whole file, verbatim (--notes-file)
#
# Publishing a release is outward-facing and creates a git tag on the remote — the calling
# skill MUST confirm with the user first (see ../SKILL.md). This script does the mechanical
# `gh release create`; it does not ask.
#
# Usage:
#   gh_release.sh <notes-file.md> [--repo OWNER/NAME] [--tag TAG] [--target REF] \
#                 [--latest true|false] [--draft] [--update] [--keyring]
#
#   --repo OWNER/NAME  target repo (default: gh repo view --json nameWithOwner of the cwd)
#   --tag TAG        override the derived tag
#   --target REF     commit/branch the tag points at (default: repo default-branch tip)
#   --latest true    mark this the repo's "Latest" release; false to explicitly not
#   --draft          create as a draft (nothing public until you publish it)
#   --update         if a release already exists for the tag, edit its title/notes
#                    instead of failing
#   --keyring        run gh without GITHUB_TOKEN, so it uses the keyring login. Use this
#                    when the ambient token lacks repo-write scope (gh then fails with 403).
#
# Exit codes: 0 done; 1 gh or the release failed; 2 bad arguments or missing file.
set -euo pipefail

die() { echo "gh_release.sh: $*" >&2; exit 1; }
usage() {
  echo "usage: gh_release.sh <notes-file.md> [--repo OWNER/NAME] [--tag TAG] [--target REF] [--latest true|false] [--draft] [--update] [--keyring]" >&2
  exit 2
}
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "gh_release.sh: $1 needs a value" >&2; usage; }; }

FILE=""; REPO=""; TAG=""; TARGET=""; LATEST=""; DRAFT=""; UPDATE=""; KEYRING=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)   need "$@"; REPO="$2"; shift 2 ;;
    --tag)    need "$@"; TAG="$2"; shift 2 ;;
    --target) need "$@"; TARGET="$2"; shift 2 ;;
    --latest) need "$@"; LATEST="$2"; shift 2 ;;
    --draft)  DRAFT=1; shift ;;
    --update) UPDATE=1; shift ;;
    --keyring) KEYRING=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)  [ -z "$FILE" ] || { echo "gh_release.sh: unexpected extra argument: $1" >&2; usage; }; FILE="$1"; shift ;;
  esac
done

[ -n "$FILE" ] || usage
[ -f "$FILE" ] || { echo "gh_release.sh: notes file not found: $FILE" >&2; exit 2; }
case "$LATEST" in ''|true|false) ;; *) echo "gh_release.sh: --latest takes true or false, got '$LATEST'" >&2; exit 2 ;; esac

command -v gh >/dev/null 2>&1 || die "the GitHub CLI (gh) is not installed. Fix: brew install gh, then gh auth login"
GH() { if [ -n "$KEYRING" ]; then env -u GITHUB_TOKEN gh "$@"; else gh "$@"; fi; }

if [ -z "$REPO" ]; then
  REPO="$(GH api 'repos/{owner}/{repo}' --jq .full_name 2>&1)" ||
    die "could not find the repo from the current directory: $REPO. Fix: run inside the checkout, or pass --repo OWNER/NAME"
fi

# title = first markdown H1; tag = filename slug (unless overridden)
[ -n "$TAG" ]   || TAG="$(basename "$FILE" .md)"
TITLE="$(sed -n 's/^# //p' "$FILE" | head -1)"
[ -n "$TITLE" ] || TITLE="$TAG"

# `gh release view` fails both for "no such release" and for auth or network errors.
# Only "release not found" means the tag is free; any other failure stops here.
if view_err="$(GH release view "$TAG" --repo "$REPO" 2>&1 >/dev/null)"; then
  [ -n "$UPDATE" ] || die "a release already exists for tag '$TAG' — pass --update to overwrite its title/notes, or delete it first"
  GH release edit "$TAG" --repo "$REPO" --title "$TITLE" --notes-file "$FILE"
  echo "updated: $TAG  ($TITLE)"
  exit 0
elif ! printf '%s' "$view_err" | grep -qi 'release not found'; then
  die "could not check for an existing release '$TAG' in $REPO: $view_err. Fix: gh auth status (or retry with --keyring)"
fi

args=(release create "$TAG" --repo "$REPO" --title "$TITLE" --notes-file "$FILE")
[ -n "$TARGET" ] && args+=(--target "$TARGET")
[ -n "$LATEST" ] && args+=(--latest="$LATEST")
[ -n "$DRAFT" ]  && args+=(--draft)
GH "${args[@]}"
echo "created: $TAG  ($TITLE)${DRAFT:+  [draft]}"
