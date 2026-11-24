#!/usr/bin/env bash
set -uo pipefail

min_age=7200
config=""
dry_run=0
now=$(date -u +%s)
projects=() keeps=() container_rules=() image_rules=()

usage() {
  echo "docker-sweep: $1" >&2
  echo "usage: docker-sweep.sh --config <file> [--dry-run]   (lines project=, keep=, container=, image=, min_age=)" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --config) [ $# -ge 2 ] || usage "--config needs a file"; config=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --now) [ $# -ge 2 ] || usage "--now needs epoch seconds"; now=$2; shift 2 ;;
    *) usage "unknown argument '$1'" ;;
  esac
done
[ -n "$config" ] || usage "--config is required"
[ -r "$config" ] || usage "cannot read the config file $config"

n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  key=${line%%=*} value=${line#*=}
  [ "$key" != "$line" ] || usage "$config line $n: '$line' is not key=value"
  case "$key" in
    project) projects+=("$value") ;;
    keep) keeps+=("$value") ;;
    container) container_rules+=("$value") ;;
    image) image_rules+=("$value") ;;
    min_age) [[ "$value" =~ ^[0-9]+$ ]] || usage "$config line $n: min_age must be seconds"; min_age=$value ;;
    *) usage "$config line $n: unknown key '$key'; the keys are project, keep, container, image, min_age" ;;
  esac
  if [ "$key" != min_age ]; then
    rc=0; [[ "" =~ $value ]] || rc=$?
    [ "$rc" -ne 2 ] || usage "$config line $n: '$value' is not a valid extended regular expression"
  fi
done <"$config"

failed=0
declare -A count=([container]=0 [volume]=0 [network]=0 [image]=0)

list() {
  local out
  if ! out=$(docker "$@" 2>&1); then
    echo "docker-sweep: docker $1 $2 failed: $out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

epoch() {
  local raw=$1 what=$2 off
  if [[ $raw =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})[T\ ]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?\ ?(Z|[+-][0-9]{2}:?[0-9]{2}) ]]; then
    off=${BASH_REMATCH[4]}; [ "$off" = Z ] && off=+0000; off=${off/:/}
    local s="${BASH_REMATCH[1]} ${BASH_REMATCH[2]} $off"
    date -u -d "$s" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S %z' "$s" +%s 2>/dev/null && return
  fi
  echo "docker-sweep: cannot read the creation time '$raw' of $what" >&2
  exit 1
}

old() {
  local t
  t=$(epoch "$1" "$2") || exit 1
  [ $((now - t)) -gt "$min_age" ]
}

matches_any() {
  local text=$1 rule; shift
  for rule in "$@"; do [[ $text =~ $rule ]] && return 0; done
  return 1
}

owned_project() {
  matches_any "$1" "${projects[@]}" || return 1
  ! matches_any "$1" "${keeps[@]}"
}

unused() {
  local users
  users=$(list ps -a --filter "$1=$2" -q) || exit 1
  [ -z "$users" ]
}

remove() {
  local kind=$1 label=$2 why=$3; shift 3
  if [ "$dry_run" = 1 ]; then
    echo "docker-sweep: would remove $kind $label ($why)"
    count[$kind]=$((count[$kind] + 1))
    return
  fi
  local err
  if err=$(docker "$@" 2>&1 >/dev/null); then
    echo "docker-sweep: removed $kind $label ($why)"
    count[$kind]=$((count[$kind] + 1))
  else
    echo "docker-sweep: could not remove $kind $label: $err" >&2
    failed=1
  fi
}

echo "docker-sweep: $(date -u -d "@$now" +%FT%TZ 2>/dev/null || date -u -r "$now" +%FT%TZ) config $config$([ "$dry_run" = 1 ] && echo ' (dry run)')"

containers=$(list ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}') || exit 1

while IFS=$'\t' read -r id name image created project; do
  [ -n "$id" ] || continue
  why=
  if matches_any "$name $image" "${container_rules[@]}"; then why="matches a container rule"
  elif [ -n "$project" ] && owned_project "$project"; then why="container of the compose project $project"
  fi
  [ -n "$why" ] && old "$created" "container $name" && remove container "$name" "$why" rm -f -v "$id"
done <<<"$containers"

volumes=$(list volume ls --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}') || exit 1

while IFS=$'\t' read -r name project; do
  [ -n "$name" ] && [ -n "$project" ] && owned_project "$project" || continue
  created=$(list volume inspect --format '{{.CreatedAt}}' "$name") || exit 1
  old "$created" "volume $name" && unused volume "$name" \
    && remove volume "$name" "volume of the compose project $project, unused" volume rm "$name"
done <<<"$volumes"

networks=$(list network ls --format '{{.Name}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}') || exit 1

while IFS=$'\t' read -r name created project; do
  [ -n "$name" ] || continue
  [ -n "$project" ] || project=${name#supabase_network_}
  [ "$project" != "$name" ] && owned_project "$project" || continue
  old "$created" "network $name" && unused network "$name" \
    && remove network "$name" "network of the compose project $project, unused" network rm "$name"
done <<<"$networks"

images=$(list image ls --format '{{.Repository}}\t{{.CreatedAt}}') || exit 1

while IFS=$'\t' read -r repo created; do
  [ -n "$repo" ] && matches_any "$repo" "${image_rules[@]}" || continue
  old "$created" "image $repo" && unused ancestor "$repo" \
    && remove image "$repo" "image matches an image rule, unused" image rm "$repo"
done <<<"$images"

verb=removed; [ "$dry_run" = 1 ] && verb="would remove"
echo "docker-sweep: $verb ${count[container]} containers, ${count[volume]} volumes, ${count[network]} networks, ${count[image]} images"
if [ "$failed" = 1 ]; then
  echo "docker-sweep: some removals failed (above); the next run tries them again" >&2
  exit 1
fi
