#!/usr/bin/env bash
# Create the living development wiki from this plugin's kb/.
# Usage: init.sh <target-dir>    (normally ~/dev-wiki)
# Refuses a target that exists and is not empty. Makes a git repository with one commit.
set -euo pipefail

target="${1:?usage: init.sh <target-dir>}"
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
kb="$plugin_root/kb"

[ -f "$kb/README.md" ] || { echo "dev-wiki init: $kb/README.md is missing; the plugin copy is incomplete. Repair: claude plugin update ndev" >&2; exit 2; }
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "dev-wiki init: $target exists and is not empty; nothing changed. Move it away or remove it, then start a new session." >&2
  exit 3
fi

mkdir -p "$target"
cp -R "$kb/." "$target/"
mv "$target/README.md" "$target/wiki.md"
mkdir -p "$target/.log"
today="$(date +%F)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$plugin_root/.claude-plugin/plugin.json")"

cat > "$target/AGENTS.md" <<MD
# dev-wiki: rules for agents

This is the living development wiki. It holds lessons that travel between projects: how to
develop software (process, testing, guards, CI, git, agent collaboration), how to design it, and
how to write its copy and docs. It grows while you work.

- Start at \`wiki.md\`. Follow links down. Read only the page that fits the question.
- A fact about one project or one business domain goes in that project's wiki, not here. Routing
  test: is it still true in a different repository and a different domain? Yes: here. No: the
  project wiki.
- Pages describe the present. Correct a wrong fact in place. Git holds the history.
- Each ingest writes one file \`.log/YYYY-MM-DD-<slug>.md\`: what was learnt, the evidence, the
  source repository and session, and the pages changed.
- Mark a guess "unverified". Give a measured fact its number and its date.
- Ingest after each push: the plugin asks for it once a push lands.
- Commit each ingest: \`git -C ~/dev-wiki add -A && git -C ~/dev-wiki commit -m "learn: <slug>"\`.
- The \`ndev:dev-wiki\` skill is the procedure. Stable lessons go back to the plugin's
  \`kb/\` through a PR on the plugin repository.
MD

cat > "$target/.log/$today-init.md" <<MD
# $today init

Created from the ndev plugin kb/ (version $version).
MD

git -C "$target" init -q -b main
git -C "$target" add -A
git_author=()
git -C "$target" config user.name >/dev/null 2>&1 || git_author+=(-c user.name=ndev)
git -C "$target" config user.email >/dev/null 2>&1 || git_author+=(-c user.email=ndev@local)
git -C "$target" "${git_author[@]}" commit -q -m "init: from ndev $version"
echo "dev-wiki: created $target from ndev $version"
