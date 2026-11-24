#!/usr/bin/env bash
set -uo pipefail

list=${1:-/etc/ci-server/images.txt}
[ -r "$list" ] || { echo "ci-docker-prepull: cannot read the image list $list. Run provision.sh with image= lines in its config." >&2; exit 2; }

total=0
failed=0
while read -r image _; do
  [ -n "$image" ] || continue
  total=$((total + 1))
  if out=$(docker pull -q "$image" 2>&1); then
    echo "ci-docker-prepull: $image ready"
  else
    echo "ci-docker-prepull: docker pull $image failed: $out" >&2
    failed=$((failed + 1))
  fi
done <"$list"

if [ "$failed" != 0 ]; then
  echo "ci-docker-prepull: $failed of $total images failed to pull; their errors are above. Check the registry and the network, then run: systemctl start ci-docker-prepull.service" >&2
  exit 1
fi
