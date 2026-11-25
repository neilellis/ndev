#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token | register-runner.sh --config <file> <slot>"
fail() { echo "register-runner.sh: $1" >&2; exit "${2:-1}"; }
usage_fail() { echo "register-runner.sh: $1" >&2; echo "$usage" >&2; exit 2; }

config_arg="" n=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) [ "$#" -ge 2 ] || usage_fail "--config needs a file."; config_arg=$2; shift 2 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    -*) usage_fail "unknown argument: $1." ;;
    *) [ -z "$n" ] || usage_fail "give one slot, not '$n' and '$1'."; n=$1; shift ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
[ -n "$n" ] || usage_fail "give the slot of a runner."
load_config "$config_arg"
require_slot "$n"

slug=${r_repo[$n]}
url=https://github.com/$slug
labels=${r_labels[$n]}
user=ci$n
name=$name_prefix-$n
home=/home/$user
dir=$home/runner
unit=$(unit_name "$n")
tarball=/opt/actions-runner-linux-x64.tar.gz
token=""
IFS= read -r token || true

[ "$(id -u)" = 0 ] || fail "run as root."
as_user() { runuser -u "$user" -- env HOME="$home" "$@"; }
id "$user" >/dev/null 2>&1 || fail "user $user does not exist. Run provision.sh --config $config_file first."
[ -f "$tarball" ] || fail "$tarball is missing. Run provision.sh --config $config_file first."
mountpoint -q "$dir/_work" || fail "$dir/_work is not a tmpfs mount. Run provision.sh --config $config_file first, then check: findmnt $dir/_work"

if [ ! -x "$dir/config.sh" ]; then
  as_user tar -xzf "$tarball" -C "$dir"
fi
runner_env "$n" >"$dir/.env"
echo '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin' >"$dir/.path"
chown "$user:$user" "$dir/.env" "$dir/.path"
as_user mkdir -p "$home/toolcache"

if [ -f "$dir/.runner" ] && grep -qF "\"agentName\": \"$name\"," "$dir/.runner" && grep -qF "\"gitHubUrl\": \"$url\"," "$dir/.runner"; then
  echo "register-runner.sh: $name is already registered to $url; the registration is kept."
else
  [ -n "$token" ] || fail "no registration token on standard input, and $name is not registered. Make one with: gh api -X POST repos/$slug/actions/runners/registration-token -q .token" 2
  (cd "$dir" && ACTIONS_RUNNER_INPUT_TOKEN=$token as_user ./config.sh --unattended --replace --url "$url" --name "$name" --labels "$labels" --work _work) \
    || fail "config.sh failed for $name. Read its output above; a token older than an hour must be made again."
fi

if [ ! -f "/etc/systemd/system/$unit" ]; then
  (cd "$dir" && ./svc.sh install "$user") || fail "svc.sh install $user failed for $name. Read its output above."
fi
systemctl start "$unit"
systemctl is-active --quiet "$unit" || fail "$unit did not start. Check: journalctl -u $unit -n 50 --no-pager"
echo "register-runner.sh: $name runs as $unit with labels $labels."
