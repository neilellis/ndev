#!/usr/bin/env bash
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
usage="Usage: verify-server.sh --config <file> [--only host|api] [--cpus N] [--mem-gb N]
       verify-server.sh --name-prefix NAME --runner <slot>:<owner>/<repo>:<labels>[:<work size>:<tmp size>] [--runner ...] [--work-size 10G] [--tmp-size 3G] [--port-base 21000] [--only host|api]

  host checks run as root on the build server; api checks need a signed-in gh and run anywhere"
usage_fail() { echo "verify-server.sh: $1" >&2; echo "$usage" >&2; exit 2; }
. "$here/lib.sh"

cis_defaults
only=all
cis_preload_config "$@"
while [ "$#" -gt 0 ]; do
  if cis_common_option "$@"; then shift 2; continue; fi
  case "$1" in
    --only) [ "$#" -ge 2 ] || usage_fail "--only needs host or api."; only=$2; shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
case "$only" in all|host|api) ;; *) usage_fail "--only must be host or api, got '$only'." ;; esac
cis_validate

passed=0 failed=0
pass() { echo "PASS $1"; passed=$((passed + 1)); }
bad() { echo "FAIL $1: $2"; failed=$((failed + 1)); }
check() {
  local name=$1; shift
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  if [ "$rc" = 0 ]; then pass "$name"; else bad "$name" "${out:-exit code $rc, no output}"; fi
}
size_bytes() {
  case "$1" in *G) echo $((${1%G} * 1073741824)) ;; *M) echo $((${1%M} * 1048576)) ;; esac
}

check_tmpfs() {
  local mount=$1 want=$2 got fs
  fs=$(findmnt -no FSTYPE "$mount" 2>&1) || { echo "$mount is not mounted. Check its line in /etc/fstab and run: mount $mount"; return 1; }
  [ "$fs" = tmpfs ] || { echo "$mount is $fs, not tmpfs."; return 1; }
  got=$(findmnt -no SIZE -b "$mount" 2>&1) || { echo "findmnt -no SIZE -b $mount failed: $got"; return 1; }
  [ "$got" = "$(size_bytes "$want")" ] || { echo "$mount has $got bytes, expected $want."; return 1; }
}
check_ports() {
  local n=$1 base listeners
  base=$((port_base + 100 * n))
  listeners=$(ss -Hltn 2>&1) || { echo "ss failed: $listeners"; return 1; }
  listeners=$(awk -v lo="$base" -v hi="$((base + 99))" '{n = split($4, a, ":"); p = a[n] + 0; if (p >= lo && p <= hi) print $4}' <<<"$listeners")
  [ -z "$listeners" ] || { echo "something already listens in $base-$((base + 99)): $(echo $listeners). Stop that stack, or wait for the job that holds it to end, and run this check again."; return 1; }
}
check_env() {
  local n=$1 file=/home/ci$1/runner/.env
  [ -f "$file" ] || { echo "$file is missing. Run provision.sh."; return 1; }
  diff <(cis_runner_env "$n") "$file" >/dev/null || { echo "$file differs from the config: $(diff <(cis_runner_env "$n") "$file" | tr '\n' ' '). Run provision.sh to write it again."; return 1; }
}
check_sysctl() {
  local key=$1 want=$2 got
  got=$(sysctl -n "$key" 2>&1) || { echo "sysctl $key failed: $got"; return 1; }
  [ "$got" = "$want" ] || { echo "$key is $got, expected $want. Run: sysctl --system"; return 1; }
}
check_docker() {
  local out
  out=$(docker info --format '{{.ServerVersion}}' 2>&1) || { echo "docker info failed: $out. Check: systemctl status docker"; return 1; }
  out=$(docker ps -q 2>&1) || { echo "docker ps failed: $out"; return 1; }
}
check_sizing() {
  local problems
  cis_host_size
  problems=$(sizing_problems "$cpus" "$mem_gb" "$runner_count" "$heavy_count" "$heavy_label")
  [ -z "$problems" ] || { echo "$problems"; return 1; }
}
check_api() {
  local slot=$1 repo=${r_repo[$1]} name=$name_prefix-$1 json status got want
  json=$("${GH_BIN:-gh}" api "repos/$repo/actions/runners" --paginate 2>&1) || { echo "gh api repos/$repo/actions/runners failed: $json. Sign in with gh auth login as someone who administers $repo (if GITHUB_TOKEN cannot reach it, run with env -u GITHUB_TOKEN)."; return 1; }
  json=$(jq -s '[.[].runners[]]' <<<"$json" 2>&1) || { echo "could not read the runner list of $repo: $json"; return 1; }
  status=$(jq -r --arg n "$name" '[.[] | select(.name == $n)] | if length == 0 then "missing" else .[0].status end' <<<"$json" 2>&1) || { echo "could not read the runner list: $json"; return 1; }
  [ "$status" != missing ] || { echo "$repo has no runner named $name. Register it with provision.sh --register."; return 1; }
  [ "$status" = online ] || { echo "$name is $status in $repo. On the host: systemctl status $(cis_unit_name "$slot")"; return 1; }
  got=$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].labels | map(.name) | map(select(. != "self-hosted" and . != "Linux" and . != "X64" and . != "ARM64")) | sort | join(",")' <<<"$json")
  want=$(tr ',' '\n' <<<"${r_labels[$slot]}" | sort | paste -sd, -)
  [ "$got" = "$want" ] || { echo "$name has labels '$got', expected '$want'. During a cut-over the old runners keep their labels until the new ones are proven; a change of labels is the owner's decision."; return 1; }
}

if [ "$only" != api ]; then
  check "sizing rule" check_sizing
  check "swap active" bash -c 'test -n "$(swapon --show --noheadings)" || { echo "no swap is active. Run provision.sh (step swap)."; exit 1; }'
  for kv in "${sysctl_values[@]}"; do check "sysctl ${kv%%=*}" check_sysctl "${kv%%=*}" "${kv#*=}"; done
  check "docker works" check_docker
  for n in "${slots[@]}"; do
    check "ci$n _work is tmpfs" check_tmpfs "/home/ci$n/runner/_work" "${r_work[$n]}"
    check "ci$n tmp is tmpfs" check_tmpfs "/home/ci$n/tmp" "${r_tmp[$n]}"
    check "ci$n .env matches the config" check_env "$n"
    check "ci$n ports $((port_base + 100 * n))-$((port_base + 100 * n + 99)) are free" check_ports "$n"
    check "$(cis_unit_name "$n") is active" systemctl is-active --quiet "$(cis_unit_name "$n")"
  done
  [ "${#sweep_repos[@]}" = 0 ] || check "ci-runner-sweep.timer is active" systemctl is-active --quiet ci-runner-sweep.timer
  [ "${#docker_sweep_projects[@]}${#docker_sweep_containers[@]}${#docker_sweep_images[@]}" = 000 ] || check "ci-docker-sweep.timer is active" systemctl is-active --quiet ci-docker-sweep.timer
  [ "${#images[@]}" = 0 ] || check "ci-docker-prepull.timer is active" systemctl is-active --quiet ci-docker-prepull.timer
fi
if [ "$only" != host ]; then
  for n in "${slots[@]}"; do check "$name_prefix-$n is online in ${r_repo[$n]} with labels ${r_labels[$n]}" check_api "$n"; done
fi

echo "verify-server: $passed passed, $failed failed"
[ "$failed" = 0 ]
