#!/usr/bin/env bash
set -euo pipefail

root="${MODEL_LINKS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root"

fail() {
  echo "model-links: $*" >&2
  exit 1
}

exempt='^(init|initWith|step|agentStep|humanStep|githubStep|watchdogStep|coordinatorStep|workerStep|github|setSub|setPr|moved)$'

models=()
while IFS= read -r -d '' file; do models+=("${file#./}"); done < <(find ./models -name '*.qnt' ! -name '*_test.qnt' -print0 | sort -z)
((${#models[@]})) || fail "no model in $root/models."

links="$(grep -rnoE --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.sh' \
  'Model: models/[A-Za-z0-9_/]+\.qnt#[A-Za-z0-9_]+' hooks scripts | grep -v '^scripts/ci/' || true)"

failed=0
while IFS= read -r link; do
  [[ -n "$link" ]] || continue
  site="${link%%:Model: *}"
  target="${link#*Model: }"
  model="${target%%#*}"
  name="${target#*#}"
  if [[ ! -f "$model" ]]; then
    echo "model-links: $site links $model, which does not exist." >&2
    failed=1
  elif ! grep -qE "^[[:space:]]*(action|def|val|pure def|pure val)[[:space:]]+$name([^A-Za-z0-9_]|\$)" "$model"; then
    echo "model-links: $site links $model#$name, but $model has no action or definition $name." >&2
    failed=1
  fi
done <<<"$links"

count=0
for model in "${models[@]}"; do
  while IFS= read -r name; do
    [[ "$name" =~ $exempt ]] && continue
    parent="$(sed -E 's/(With|To)$//' <<<"$name")"
    [[ "$parent" != "$name" ]] && grep -qE "^[[:space:]]*action[[:space:]]+$parent([^A-Za-z0-9_]|\$)" "$model" && continue
    if ! grep -qF "Model: $model#$name" <<<"$links"; then
      echo "model-links: $model action $name has no code link. Add '// Model: $model#$name' above the code that performs it." >&2
      failed=1
    fi
    count=$((count + 1))
  done < <(sed -nE 's/^[[:space:]]*action[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$model" | sort -u)
done

((failed == 0)) || fail "see the broken links above."
echo "model-links: $count model actions linked from code, $(grep -c . <<<"$links") links valid."
