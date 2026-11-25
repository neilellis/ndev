#!/usr/bin/env bash
set -uo pipefail

list=${1:-}
[ -n "$list" ] || { echo "docker-prepull: give the image list. Usage: docker-prepull.sh <image list>" >&2; exit 2; }
[ -r "$list" ] || { echo "docker-prepull: cannot read the image list $list. Repair: run provision.sh --config <file>, which installs it from the config's prepull_images." >&2; exit 2; }

total=0
failed=0
while read -r image _; do
  [ -n "$image" ] || continue
  total=$((total + 1))
  if out=$(docker pull -q "$image" 2>&1); then
    echo "docker-prepull: $image ready"
  else
    echo "docker-prepull: docker pull $image failed: $out" >&2
    failed=$((failed + 1))
  fi
done <"$list"

if [ "$failed" != 0 ]; then
  echo "docker-prepull: $failed of $total images failed to pull; their errors are above. Check the registry and the network, then start the pre-pull service again (systemctl list-timers '*-docker-prepull.timer' names it)." >&2
  exit 1
fi
echo "docker-prepull: $total images ready"
