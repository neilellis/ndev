#!/usr/bin/env bash
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: verify-server.sh --config <file> [--only host|api] [--cpus N] [--mem-gb N]

  host checks run as root on the build server; api checks need a signed-in gh and run anywhere (on a laptop: env -u GITHUB_TOKEN for a repository your token cannot reach)"

config_arg="" only=all cpus_override="" mem_override=""
usage_fail() { echo "verify-server.sh: $1" >&2; echo "$usage" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config|--only|--cpus|--mem-gb)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value."
      case "$1" in
        --config) config_arg=$2 ;;
        --only) only=$2 ;;
        --cpus) count_ok "$2" || usage_fail "--cpus must be a whole number; got '$2'."; cpus_override=$2 ;;
        --mem-gb) count_ok "$2" || usage_fail "--mem-gb must be a whole number; got '$2'."; mem_override=$2 ;;
      esac
      shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
case "$only" in all|host|api) ;; *) usage_fail "--only must be host or api, got '$only'." ;; esac
load_config "$config_arg"

passed=0 failed=0
pass() { echo "PASS $1"; passed=$((passed + 1)); }
bad() { echo "FAIL $1: $2"; failed=$((failed + 1)); }
check() {
  local name=$1 out rc=0
  shift
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
  [ -n "$got" ] || { echo "findmnt reports no size for $mount. Check it with: findmnt -o TARGET,FSTYPE,SIZE $mount"; return 1; }
  [ "$got" = "$(size_bytes "$want")" ] || { echo "$mount has $got bytes, expected $want."; return 1; }
}
check_ports() {
  local n=$1 base listeners
  base=$((port_base + 100 * n))
  listeners=$(ss -Hltn 2>&1) || { echo "ss failed: $listeners"; return 1; }
  listeners=$(awk -v lo="$base" -v hi="$((base + 99))" '{n = split($4, a, ":"); p = a[n] + 0; if (p >= lo && p <= hi) print $4}' <<<"$listeners")
  [ -z "$listeners" ] || { echo "something already listens in $base-$((base + 99)): $(tr '\n' ' ' <<<"$listeners"). Stop that stack, or wait for the job that holds it to end, and run this check again."; return 1; }
}
check_env() {
  local n=$1 file=/home/ci$1/runner/.env differences
  [ -f "$file" ] || { echo "$file is missing. Run provision.sh --config $config_file, or register-runner.sh for this slot."; return 1; }
  differences=$(diff <(runner_env "$n") "$file") || { echo "$file differs from runner-env.sh: $(tr '\n' ' ' <<<"$differences"). Run provision.sh --config $config_file --skip register to write it again."; return 1; }
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
check_docker_ip() {
  local file=/etc/docker/daemon.json
  [ -r "$file" ] || { echo "cannot read $file. Run provision.sh --config $config_file."; return 1; }
  grep -q '"ip": "127.0.0.1"' "$file" || { echo "$file does not set \"ip\": \"127.0.0.1\", so a port that a job publishes is open to the internet, because ufw does not filter the ports Docker publishes. Run provision.sh --config $config_file when no job runs; the docker step restarts Docker."; return 1; }
}
check_sizing() {
  local problems
  host_size
  problems=$(sizing_problems "$cpus" "$mem_gb")
  [ -z "$problems" ] || { echo "$problems"; return 1; }
}
check_swap() {
  local out
  out=$(swapon --show --noheadings 2>&1) || { echo "swapon --show failed: $out"; return 1; }
  [ -n "$out" ] || { echo "no swap is active. Run provision.sh --config $config_file, which makes a swap file when none is active."; return 1; }
}
check_api() {
  local slot=$1 repo=${r_repo[$1]} name=$name_prefix-$1 json status got want
  json=$("${GH_BIN:-gh}" api "repos/$repo/actions/runners" --paginate 2>&1) || { echo "gh api repos/$repo/actions/runners failed: $json. Sign in with gh auth login (for a repository your GITHUB_TOKEN cannot reach, run it with env -u GITHUB_TOKEN)."; return 1; }
  json=$(jq -s '[.[].runners[]]' <<<"$json" 2>&1) || { echo "could not read the runner list of $repo: $json"; return 1; }
  status=$(jq -r --arg n "$name" '[.[] | select(.name == $n)] | if length == 0 then "missing" else .[0].status end' <<<"$json" 2>&1) || { echo "could not read the runner list of $repo: $status"; return 1; }
  [ "$status" != missing ] || { echo "$repo has no runner named $name. Register it with provision.sh --config $config_file --register."; return 1; }
  [ "$status" = online ] || { echo "$name is $status in $repo. On the host: systemctl status $(unit_name "$slot")"; return 1; }
  got=$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].labels | map(.name) | map(select(. != "self-hosted" and . != "Linux" and . != "X64" and . != "ARM64")) | sort | join(",")' <<<"$json" 2>&1) || { echo "could not read the labels of $name: $got"; return 1; }
  want=$(tr ',' '\n' <<<"${r_labels[$slot]}" | sort | paste -sd, -)
  [ "$got" = "$want" ] || { echo "$name has labels '$got', expected '$want'. During a cut-over the old runners keep their labels until the new ones are proven; the labels are the owner's decision. Change them with gh api repos/$repo/actions/runners/<id>/labels."; return 1; }
}

if [ "$only" != api ]; then
  check "sizing rule" check_sizing
  check "swap active" check_swap
  check "sysctl vm.max_map_count" check_sysctl vm.max_map_count 1048576
  check "sysctl fs.inotify.max_user_watches" check_sysctl fs.inotify.max_user_watches 524288
  check "docker works" check_docker
  check "docker publishes container ports on 127.0.0.1 only" check_docker_ip
  for n in "${slots[@]}"; do
    check "ci$n _work is tmpfs" check_tmpfs "/home/ci$n/runner/_work" "${r_work[$n]}"
    check "ci$n tmp is tmpfs" check_tmpfs "/home/ci$n/tmp" "${r_tmp[$n]}"
    check "ci$n .env has its port block" check_env "$n"
    check "ci$n ports $((port_base + 100 * n))-$((port_base + 100 * n + 99)) are free" check_ports "$n"
    check "$(unit_name "$n") is active" systemctl is-active --quiet "$(unit_name "$n")"
  done
  [ -z "$sweep_repos" ] || check "$unit_prefix-runner-sweep.timer is active" systemctl is-active --quiet "$unit_prefix-runner-sweep.timer"
  [ "$docker_sweep_on" = 0 ] || check "$unit_prefix-docker-sweep.timer is active" systemctl is-active --quiet "$unit_prefix-docker-sweep.timer"
  [ -z "$prepull_images" ] || check "$unit_prefix-docker-prepull.timer is active" systemctl is-active --quiet "$unit_prefix-docker-prepull.timer"
fi
if [ "$only" != host ]; then
  for n in "${slots[@]}"; do check "$name_prefix-$n is online in ${r_repo[$n]} with labels ${r_labels[$n]}" check_api "$n"; done
fi

echo "verify-server: $passed passed, $failed failed"
[ "$failed" = 0 ]
