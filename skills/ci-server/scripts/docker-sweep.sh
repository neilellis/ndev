#!/usr/bin/env bash
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: docker-sweep.sh --config <file> [--dry-run]   removes the Docker leftovers of finished jobs that the config's docker_sweep_* fields match"
usage_fail() { echo "docker-sweep: $1" >&2; echo "$usage" >&2; exit 2; }

config_arg="" dry_run=0
now=$(date -u +%s)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) [ "$#" -ge 2 ] || usage_fail "--config needs a file."; config_arg=$2; shift 2 ;;
    --now) [[ "${2:-}" =~ ^[0-9]+$ ]] || usage_fail "--now needs seconds since 1970."; now=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
load_config "$config_arg"
[ "$docker_sweep_on" = 1 ] || usage_fail "$config_file sets no docker_sweep_projects, docker_sweep_containers or docker_sweep_images, so there is nothing to sweep. Repair: set the fields that match the leftovers of your jobs, or do not install the docker sweep."
keep=${docker_sweep_keep//'{slots}'/$(slot_list)}

failed=0
removed_container=0 removed_volume=0 removed_network=0 removed_image=0

list() {
  local out
  if ! out=$(docker "$@" 2>&1); then
    echo "docker-sweep: docker $1 $2 failed: $out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

epoch() {
  local raw=$1 what=$2 off s
  if [[ $raw =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})[T\ ]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?\ ?(Z|[+-][0-9]{2}:?[0-9]{2}) ]]; then
    off=${BASH_REMATCH[4]}
    [ "$off" = Z ] && off=+0000
    off=${off/:/}
    s="${BASH_REMATCH[1]} ${BASH_REMATCH[2]} $off"
    date -u -d "$s" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S %z' "$s" +%s 2>/dev/null && return
  fi
  echo "docker-sweep: cannot read the creation time '$raw' of $what" >&2
  exit 1
}

old() {
  local t
  t=$(epoch "$1" "$2") || exit 1
  [ $((now - t)) -gt "$docker_sweep_min_age" ]
}

owned_project() {
  [ -n "$docker_sweep_projects" ] && [[ $1 =~ $docker_sweep_projects ]] || return 1
  if [ -n "$keep" ] && [[ $1 =~ $keep ]]; then return 1; fi
  return 0
}

unused() {
  local users
  users=$(list ps -a --filter "$1=$2" -q) || exit 1
  [ -z "$users" ]
}

count() {
  case "$1" in
    container) removed_container=$((removed_container + 1)) ;;
    volume) removed_volume=$((removed_volume + 1)) ;;
    network) removed_network=$((removed_network + 1)) ;;
    image) removed_image=$((removed_image + 1)) ;;
  esac
}

remove() {
  local kind=$1 label=$2 why=$3 err
  shift 3
  if [ "$dry_run" = 1 ]; then
    echo "docker-sweep: would remove $kind $label ($why)"
    count "$kind"
    return
  fi
  if err=$(docker "$@" 2>&1 >/dev/null); then
    echo "docker-sweep: removed $kind $label ($why)"
    count "$kind"
  else
    echo "docker-sweep: could not remove $kind $label: $err" >&2
    failed=1
  fi
}

echo "docker-sweep: $(date -u -d "@$now" +%FT%TZ 2>/dev/null || date -u -r "$now" +%FT%TZ) runners $(slot_list | tr '|' ',')$([ "$dry_run" = 1 ] && echo ' (dry run)')"

containers=$(list ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}') || exit 1
while IFS=$'\t' read -r id name image created project; do
  [ -n "$id" ] || continue
  why=
  if [ -n "$docker_sweep_containers" ] && [[ $name =~ $docker_sweep_containers ]]; then why="container of a past job, matched by docker_sweep_containers"
  elif [ -n "$docker_sweep_service_images" ] && [[ $name =~ ^[0-9a-f]{32}_ ]] && [[ $image =~ $docker_sweep_service_images ]]; then why="service container of a past job, matched by docker_sweep_service_images"
  elif [ -n "$project" ] && owned_project "$project"; then why="container of the project $project, which no live runner keeps"
  fi
  [ -n "$why" ] && old "$created" "container $name" && remove container "$name" "$why" rm -f -v "$id"
done <<<"$containers"

volumes=$(list volume ls --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}') || exit 1
while IFS=$'\t' read -r name project; do
  [ -n "$name" ] && [ -n "$project" ] && owned_project "$project" || continue
  created=$(list volume inspect --format '{{.CreatedAt}}' "$name") || exit 1
  old "$created" "volume $name" && unused volume "$name" \
    && remove volume "$name" "volume of the project $project, unused" volume rm "$name"
done <<<"$volumes"

networks=$(list network ls --format '{{.Name}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}') || exit 1
while IFS=$'\t' read -r name created project; do
  [ -n "$name" ] || continue
  [ -n "$project" ] || project=${name##*_}
  owned_project "$project" || continue
  old "$created" "network $name" && unused network "$name" \
    && remove network "$name" "network of the project $project, unused" network rm "$name"
done <<<"$networks"

images=$(list image ls --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}') || exit 1
while IFS=$'\t' read -r id repo tag created; do
  [ -n "$docker_sweep_images" ] && [[ $repo =~ $docker_sweep_images ]] || continue
  ref=$repo:$tag
  [ "$tag" != "<none>" ] || ref=$id
  old "$created" "image $ref" && unused ancestor "$ref" \
    && remove image "$ref" "image of a past run, matched by docker_sweep_images, unused" image rm "$ref"
done <<<"$images"

verb=removed
[ "$dry_run" = 1 ] && verb="would remove"
echo "docker-sweep: $verb $removed_container containers, $removed_volume volumes, $removed_network networks, $removed_image images"
if [ "$failed" = 1 ]; then
  echo "docker-sweep: some removals failed (above); the next run tries them again" >&2
  exit 1
fi
