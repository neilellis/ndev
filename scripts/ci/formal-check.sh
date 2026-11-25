#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
models="$root/models"
quint="$root/node_modules/.bin/quint"

fail() {
  echo "formal-check: $*" >&2
  exit 1
}

[[ -x "$quint" ]] || fail "Quint is missing at $quint. Repair: npm install (package.json pins @informalsystems/quint)."
[[ -d "$models" ]] || fail "the models folder $models does not exist."

files=()
while IFS= read -r -d '' file; do files+=("$file"); done < <(find "$models" -name '*.qnt' -print0 | sort -z)
((${#files[@]})) || fail "the models folder $models has no .qnt file."

failed=0
report() {
  echo "formal-check: FAILED $1" >&2
  printf '%s\n' "$2" >&2
  failed=1
}

for file in "${files[@]}"; do
  if ! out="$("$quint" typecheck "$file" 2>&1)"; then report "typecheck ${file#"$root"/}" "$out"; fi
done

if ! out_links="$("$root/scripts/ci/model-links.sh" 2>&1)"; then report "model links" "$out_links"; fi

models_count=0
tests_count=0
for file in "${files[@]}"; do
  [[ "$file" == *_test.qnt ]] || { models_count=$((models_count + 1)); continue; }
  rel="${file#"$root"/}"
  while IFS= read -r name; do
    report "$rel: run $name does not end in Test, so quint test skips it" "Rename it, or make it an action if it is a prefix of other runs."
  done < <(sed -nE 's/^[[:space:]]*run[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$file" | grep -v 'Test$' || true)
  modules="$(sed -nE 's/^module[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$file")"
  [[ -n "$modules" ]] || { report "$rel has no module" ""; continue; }
  for module in $modules; do
    if ! out="$(cd "$(dirname "$file")" && "$quint" test "$(basename "$file")" --backend=typescript --main="$module" --match 'Test$' 2>&1)"; then
      report "$rel module $module" "$out"
      continue
    fi
    passed="$(sed -nE 's/^[[:space:]]*([0-9]+) passing.*/\1/p' <<<"$out" | tail -1)"
    if [[ -z "$passed" || "$passed" == 0 ]]; then
      report "$rel module $module: no test ran" "$out"
      continue
    fi
    tests_count=$((tests_count + passed))
  done
done

((failed == 0)) || fail "see the failures above."
echo "formal-check: ${#files[@]} files typechecked, $models_count models, $tests_count tests passed."
echo "$out_links"
