#!/usr/bin/env bash
set -uo pipefail

scripts=/skill/scripts
[ -f /.dockerenv ] || { echo "FAIL provision-container.sh changes the system it runs on; run it only inside a container (see container.test.mjs)."; exit 1; }
fails=0
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }

work=/work
mkdir -p "$work"
cp /skill/examples/ci-images.txt "$work/"
sed -e '/^runner = [346]:/d' -e 's/^swap_size = .*/swap_size = 1M/' /skill/examples/multi-repo.conf >"$work/server.conf"
grep -v '^runner = ' "$work/server.conf" >"$work/one.conf"
echo 'runner = 1:acme/app:app,supabase:12G:3G' >>"$work/one.conf"
conf=$work/server.conf

state=/fake-state
mkdir -p "$state" /fake-bin
: >"$state/installed"
export FAKE_STATE=$state
export PATH=/fake-bin:$PATH

fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"/fake-bin/$1"; chmod +x "/fake-bin/$1"; }
for noop in sshd visudo gpg; do
  fake "$noop" 'echo "$(basename "$0") $*" >>"$FAKE_STATE/calls"; [ "$(basename "$0")" = gpg ] && cat >"${3:-/dev/null}"; exit 0'
done
fake timedatectl 'echo "timedatectl $*" >>"$FAKE_STATE/calls"; if [ "$1" = set-timezone ]; then echo "$2" >"$FAKE_STATE/tz"; else cat "$FAKE_STATE/tz" 2>/dev/null; fi'
fake locale-gen 'echo "locale-gen $*" >>"$FAKE_STATE/calls"; touch "$FAKE_STATE/locale"'
fake update-locale 'echo "update-locale $*" >>"$FAKE_STATE/calls"; mkdir -p /etc/default; echo "$1" >/etc/default/locale'
fake locale 'if [ -e "$FAKE_STATE/locale" ]; then echo en_US.utf8; fi'
fake apt-get 'echo "apt-get $*" >>"$FAKE_STATE/calls"
if [ "$1" = install ]; then for a in "$@"; do case "$a" in -*|install) ;; *) echo "$a" >>"$FAKE_STATE/installed" ;; esac; done; fi'
fake dpkg-query 'grep -qx "${@: -1}" "$FAKE_STATE/installed" && { printf "ii "; exit 0; }; exit 1'
fake curl 'out=""; while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift ;; http*) url=$1 ;; esac; shift; done
echo "curl $url" >>"$FAKE_STATE/calls"
case "$url" in
  *actions-runner-linux-x64*) if [ -e "$FAKE_STATE/bad-tarball" ]; then echo bad >"$out"; else cp "$FAKE_STATE/runner.tar.gz" "$out"; fi ;;
  *) if [ -n "$out" ]; then echo key >"$out"; else echo key; fi ;;
esac'
fake mount 'echo "mount $*" >>"$FAKE_STATE/calls"; [ -e "$FAKE_STATE/mount-fails" ] && { echo "mount: $1: permission denied (fake)" >&2; exit 32; }; echo "$1" >>"$FAKE_STATE/mounted"'
fake mountpoint 'grep -qx "${@: -1}" "$FAKE_STATE/mounted" 2>/dev/null'
fake fallocate 'out="${@: -1}"; dd if=/dev/zero of="$out" bs=1M count=1 2>/dev/null'
fake mkswap 'echo "mkswap $*" >>"$FAKE_STATE/calls"; [ -f "${@: -1}" ]'
fake swapon 'if [ "$1" = --show ]; then [ -e "$FAKE_STATE/swapon-fails" ] && { echo "swapon: cannot read /proc/swaps (fake)" >&2; exit 1; }; cat "$FAKE_STATE/swap" 2>/dev/null; else echo "$1 file 1M 0B -2" >"$FAKE_STATE/swap"; fi; exit 0'
fake ufw 'case "$1" in status) [ -e "$FAKE_STATE/ufw-on" ] && echo "Status: active" ;; --force) touch "$FAKE_STATE/ufw-on" ;; esac; exit 0'
fake systemctl 'echo "systemctl $*" >>"$FAKE_STATE/calls"
case "$1" in
  is-enabled) shift; [ "$1" = --quiet ] && shift; for u in "$@"; do grep -qx "$u" "$FAKE_STATE/enabled" 2>/dev/null || exit 1; done ;;
  enable) for a in "$@"; do case "$a" in enable|--now) ;; *) echo "$a" >>"$FAKE_STATE/enabled"; echo "$a" >>"$FAKE_STATE/active" ;; esac; done ;;
  start) echo "$2" >>"$FAKE_STATE/active" ;;
  disable) for f in enabled active; do grep -vx "${@: -1}" "$FAKE_STATE/$f" >"$FAKE_STATE/$f.new"; mv "$FAKE_STATE/$f.new" "$FAKE_STATE/$f"; done ;;
  is-active) shift; [ "$1" = --quiet ] && shift; grep -qx "$1" "$FAKE_STATE/active" 2>/dev/null || exit 3 ;;
esac
exit 0'
fake findmnt 'path=${@: -1}
grep -qx "$path" "$FAKE_STATE/mounted" 2>/dev/null || { echo "findmnt: $path not mounted (fake)" >&2; exit 1; }
case "$*" in
  *FSTYPE*) echo tmpfs ;;
  *SIZE*) [ -e "$FAKE_STATE/findmnt-no-size" ] && exit 0 ;;&
  *SIZE*) s=$(grep " $path tmpfs " /etc/fstab | sed "s/.*size=\([0-9]*\)\([MG]\).*/\1 \2/"); set -- $s; if [ "$2" = G ]; then echo $(($1 * 1073741824)); else echo $(($1 * 1048576)); fi ;;
esac'
fake uname 'if [ "$1" = -m ]; then if [ -e "$FAKE_STATE/arm" ]; then echo aarch64; else echo x86_64; fi; else exec /usr/bin/uname "$@"; fi'
fake ss 'cat "$FAKE_STATE/listeners" 2>/dev/null; exit 0'
fake docker 'case "$*" in "info "*) echo 29.10.0 ;; "ps -q") ;; esac; [ -e "$FAKE_STATE/docker-down" ] && { echo "Cannot connect to the Docker daemon (fake)" >&2; exit 1; }; exit 0'
fake sysctl 'echo "sysctl $*" >>"$FAKE_STATE/calls"; if [ "$1" = -n ]; then grep -h "^$2 " /etc/sysctl.d/60-ci-server.conf | sed "s/.*= //"; fi; exit 0'

userdel ubuntu 2>/dev/null; groupdel ubuntu 2>/dev/null; groupadd -g 988 docker
mkdir -p /tmp/runner-src
cat >/tmp/runner-src/config.sh <<'EOT'
#!/bin/sh
[ -n "${ACTIONS_RUNNER_INPUT_TOKEN:-}" ] || { echo "config.sh: no token in ACTIONS_RUNNER_INPUT_TOKEN (fake)" >&2; exit 1; }
echo "$*" >>"$FAKE_STATE/config-args"
name=""; url=""
while [ "$#" -gt 0 ]; do case "$1" in --name) name=$2 ;; --url) url=$2 ;; esac; shift; done
printf '\357\273\277{\n  \n  "agentName": "%s",\n  "gitHubUrl": "%s",\n  "workFolder": "_work"\n}' "$name" "$url" >.runner
EOT
cat >/tmp/runner-src/svc.sh <<'EOT'
#!/bin/sh
name=$(sed -n 's/.*agentName": "\(.*\)",/\1/p' .runner)
url=$(sed -n 's/.*gitHubUrl": "\(.*\)",/\1/p' .runner)
repo=$(echo "${url#https://github.com/}" | tr / -)
touch "/etc/systemd/system/actions.runner.$repo.$name.service"
EOT
chmod +x /tmp/runner-src/*.sh
tar -czf "$state/runner.tar.gz" -C /tmp/runner-src config.sh svc.sh
runner_sha=$(sha256sum "$state/runner.tar.gz" | cut -d' ' -f1)
printf 'runner_version = 2.338.2\nrunner_sha256 = %s\n' "$runner_sha" >>"$conf"

all_enabled() { local t; for t in "$@"; do grep -qx "$t" "$state/enabled" || return 1; done; }
prov() { bash "$scripts/provision.sh" "$@" 2>&1; }
digest() { find /etc /home /opt /usr/local -type f -not -path '*/.cache/*' -exec /usr/bin/sha256sum {} + 2>/dev/null | sort | /usr/bin/sha256sum; }
size="--cpus 16 --mem-gb 64"
token=TEST_FAKE_RUNNER_REG_TOKEN_0123456789
tokens() { printf 'acme/app %s\nacme/analytics %s\n' "$token" "$token"; }
app_unit=actions.runner.acme-app.ci-host-1.service

before=$(digest); passwd_before=$(cat /etc/passwd)
out=$(prov --config "$conf" --plan); rc=$?
[ "$rc" = 0 ] && grep -q 'ci-host-5: user ci5, repository acme/analytics, labels analytics,supabase, ports 21500-21599, _work tmpfs 16G, tmp tmpfs 4G' <<<"$out" \
  && [ "$before" = "$(digest)" ] && [ "$passwd_before" = "$(cat /etc/passwd)" ] \
  && ok "--plan prints each runner's values and changes nothing" || fail "--plan: rc=$rc out=$out"

out=$(prov --config "$conf" --dry-run $size </dev/null); rc=$?
! id ci1 >/dev/null 2>&1 && [ "$before" = "$(digest)" ] && ! grep -qE '^(apt-get|mount|curl|timedatectl set|locale-gen|sysctl --system|systemctl (enable|restart|start|daemon-reload))' "$state/calls" 2>/dev/null \
  && grep -q 'would write /etc/docker/daemon.json' <<<"$out" && grep -q 'would add to /etc/fstab: tmpfs /home/ci5/runner/_work tmpfs size=16G' <<<"$out" \
  && grep -q 'that --dry-run would make' <<<"$out" && [ "$rc" = 0 ] \
  && ok "--dry-run lists the changes it would make and makes none" || fail "--dry-run: rc=$rc out=$out calls=$(cat "$state/calls" 2>/dev/null)"

mkdir -p /opt
out=$(prov --config "$conf" $size --register </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q "no registration token for acme/app on standard input" <<<"$out" && grep -q "registration-token -q .token" <<<"$out" && grep -q "Nothing was changed" <<<"$out" && ! id ci1 >/dev/null 2>&1 \
  && ok "--register with no token stops before any change and names the command that makes one" || fail "missing token: rc=$rc out=$out"

out=$(prov --config "$conf" $size --register < <(tokens; echo "acme/other $token")); rc=$?
[ "$rc" = 1 ] && grep -q "standard input has a token for acme/other, which no runner line of $conf has" <<<"$out" && grep -q "Nothing was changed" <<<"$out" && ! id ci1 >/dev/null 2>&1 \
  && ok "--register refuses a token line for a repository the config does not have, before any change" || fail "unknown token repository: rc=$rc out=$out"

out=$(prov --config "$conf" $size --register < <(tokens)); rc=$?
[ "$rc" = 0 ] && ok "a real run with --register succeeds" || fail "real run: rc=$rc out=$out"
[ "$(id -u ci1)" = 1000 ] && [ "$(id -u ci2)" = 1001 ] && [ "$(id -u ci5)" = 1004 ] && id -nG ci1 | grep -qw docker \
  && ok "users ci1, ci2 and ci5 exist with uids 1000, 1001 and 1004 in the docker group" || fail "users"
grep -qx 'tmpfs /home/ci1/runner/_work tmpfs size=10G,mode=0755,uid=1000,gid=1000,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci1/tmp tmpfs size=3G,mode=0700,uid=1000,gid=1000,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci5/runner/_work tmpfs size=16G,mode=0755,uid=1004,gid=1004,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci5/tmp tmpfs size=4G,mode=0700,uid=1004,gid=1004,nosuid,nodev 0 0' /etc/fstab \
  && ok "fstab holds the default tmpfs sizes and the per-runner override" || fail "fstab: $(cat /etc/fstab)"
[ "$(bash "$scripts/runner-env.sh" --config "$conf" 5)" = "$(cat /home/ci5/runner/.env)" ] && grep -qx 'CI_PORT_BASE=21500' /home/ci5/runner/.env && grep -qx 'SUPABASE_PROJECT_ID_SUFFIX=-ci5' /home/ci5/runner/.env \
  && ok "each runner's .env holds its port block and its env lines" || fail ".env: $(cat /home/ci5/runner/.env 2>&1)"
[ -f /swapfile ] && grep -qx '/swapfile none swap sw 0 0' /etc/fstab && ok "a swap file is made when no swap is active" || fail "swap"
[ "$(cat "$state/tz")" = Europe/Berlin ] && grep -q 'max-size": "20m"' /etc/docker/daemon.json && grep -q '"ip": "127.0.0.1"' /etc/docker/daemon.json && grep -qx 'vm.swappiness = 10' /etc/sysctl.d/60-ci-server.conf && grep -q 'ci1 ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/ss' /etc/sudoers.d/ci1 \
  && ok "the time zone, docker log caps, sysctl and sudoers are written" || fail "config files"
grep -qx redis-server "$state/installed" && grep -qx google-chrome-stable "$state/installed" && grep -qx docker-ce "$state/installed" && grep -qx redis-server "$state/enabled" && [ -f /etc/apt/sources.list.d/nodesource.list ] && [ ! -f /etc/apt/sources.list.d/yarn.list ] \
  && ok "the config's sources, packages and services are installed and enabled" || fail "packages: $(tr '\n' ' ' <"$state/installed")"
for u in "$app_unit" actions.runner.acme-app.ci-host-2.service actions.runner.acme-analytics.ci-host-5.service; do
  [ -f "/etc/systemd/system/$u" ] && grep -qx "$u" "$state/active" || fail "unit $u"
done
grep -q '"agentName": "ci-host-5"' /home/ci5/runner/.runner && grep -q 'github.com/acme/analytics' /home/ci5/runner/.runner \
  && ok "each runner is registered to its own repository and has its service" || fail "registration"
grep -qx 'ENABLED="true"' /etc/default/sysstat && grep -qx sysstat "$state/enabled" && grep -qx sysstat-collect.timer "$state/enabled" \
  && ok "sysstat is enabled and collects, so sar keeps history" || fail "sysstat"
[ -f /etc/systemd/system/ci-runner-sweep.timer ] && [ -f "/etc/systemd/system/$app_unit.d/10-ci-recovery.conf" ] && [ ! -e /etc/systemd/system/actions.runner.acme-analytics.ci-host-5.service.d ] \
  && grep -qF "ExecStart=/usr/local/libexec/ci-server/runner-sweep.sh --units 'actions.runner.acme-app.ci-host-*.service'" /etc/systemd/system/ci-runner-sweep.service \
  && ok "the runner sweep and the recovery drop-in go to the sweep_repos runners only" || fail "runner sweep: $(cat /etc/systemd/system/ci-runner-sweep.service 2>&1)"
grep -qF 'ExecStart=/usr/local/libexec/ci-server/docker-sweep.sh --config /usr/local/share/ci-server/ci-server.conf' /etc/systemd/system/ci-docker-sweep.service \
  && cmp -s "$conf" /usr/local/share/ci-server/ci-server.conf && cmp -s "$work/ci-images.txt" /usr/local/share/ci-server/ci-images.txt \
  && grep -qF 'ExecStart=/usr/local/libexec/ci-server/docker-prepull.sh /usr/local/share/ci-server/ci-images.txt' /etc/systemd/system/ci-docker-prepull.service \
  && cmp -s "$scripts/config.sh" /usr/local/libexec/ci-server/config.sh \
  && all_enabled ci-runner-sweep.timer ci-docker-sweep.timer ci-docker-prepull.timer \
  && ok "the docker sweep and the pre-pull read the installed config and image list, and their timers are on" || fail "docker sweep and pre-pull"
bash /usr/local/libexec/ci-server/docker-sweep.sh --config /usr/local/share/ci-server/ci-server.conf --dry-run >/dev/null 2>&1 \
  && ok "the installed docker sweep loads the installed config" || fail "installed docker sweep: $(bash /usr/local/libexec/ci-server/docker-sweep.sh --config /usr/local/share/ci-server/ci-server.conf --dry-run 2>&1)"
if grep -rqF "$token" /etc /home /opt /root /usr/local /tmp/runner-src "$state" 2>/dev/null || grep -q -- --token "$state/config-args"; then fail "the registration token was stored in a file or passed as an argument: $(cat "$state/config-args")"; else ok "the registration token is stored nowhere and reaches config.sh through its environment"; fi

after=$(digest)
: >"$state/calls"
out=$(prov --config "$conf" $size --register </dev/null); rc=$?
[ "$rc" = 0 ] && grep -q 'done, 0 change(s)' <<<"$out" && [ "$after" = "$(digest)" ] && ! grep -qE 'wrote |added to|would' <<<"$out" && ! grep -qE '^systemctl (enable|restart)' "$state/calls" \
  && ok "a second run changes nothing, starts nothing and says 0 changes" || fail "idempotence: rc=$rc out=$out calls=$(cat "$state/calls")"
echo changed >/etc/systemd/system/ci-runner-sweep.timer
out=$(prov --config "$conf" $size </dev/null); rc=$?
[ "$rc" = 0 ] && grep -q 'wrote /etc/systemd/system/ci-runner-sweep.timer' <<<"$out" && grep -q 'done, 2 change(s)' <<<"$out" \
  && ok "the sweeps step rewrites a changed unit, reloads systemd and counts both" || fail "sweeps change: rc=$rc out=$out"
out=$(prov --config "$conf" --dry-run $size </dev/null)
grep -q 'done, 0 change(s)' <<<"$out" && ok "--dry-run on a provisioned host finds nothing to change" || fail "dry-run after: $out"

verify() { bash "$scripts/verify-server.sh" --config "$1" --only host $size 2>&1; }
out=$(verify "$conf"); rc=$?
[ "$rc" = 0 ] && grep -q '^PASS docker works' <<<"$out" && grep -q '^PASS docker publishes container ports on 127.0.0.1 only' <<<"$out" && grep -q '^PASS ci5 _work is tmpfs' <<<"$out" && grep -q '^PASS ci-docker-prepull.timer is active' <<<"$out" && grep -q '^PASS ci1 ports 21100-21199 are free' <<<"$out" && grep -q ', 0 failed$' <<<"$out" \
  && ok "verify-server.sh passes on the provisioned host" || fail "verify host pass: rc=$rc out=$out"

echo "LISTEN 0 4096 0.0.0.0:21101 0.0.0.0:*" >"$state/listeners"; touch "$state/docker-down"; grep -v ci2/tmp "$state/mounted" >"$state/mounted.new"; mv "$state/mounted.new" "$state/mounted"
out=$(verify "$conf"); rc=$?
[ "$rc" = 1 ] && grep -q '^FAIL ci1 ports 21100-21199 are free: something already listens' <<<"$out" && grep -q '^FAIL docker works: docker info failed' <<<"$out" && grep -q '^FAIL ci2 tmp is tmpfs: .*not mounted' <<<"$out" \
  && ok "verify-server.sh lists each failing check with the command's own message" || fail "verify host fail: rc=$rc out=$out"
rm -f "$state/listeners" "$state/docker-down"; echo /home/ci2/tmp >>"$state/mounted"

cp /home/ci1/runner/.env "$state/env.saved"
sed -i 's/^SUPABASE_DB_PORT=.*/SUPABASE_DB_PORT=54322/' /home/ci1/runner/.env
out=$(verify "$conf"); rc=$?
[ "$rc" = 1 ] && grep -q '^FAIL ci1 .env has its port block: /home/ci1/runner/.env differs from runner-env.sh: .*SUPABASE_DB_PORT=54322' <<<"$out" \
  && ok "verify-server.sh compares the whole .env" || fail "verify env: rc=$rc out=$out"
cp "$state/env.saved" /home/ci1/runner/.env

out=$(bash "$scripts/verify-server.sh" --config /skill/examples/multi-repo.conf --only host --cpus 16 --mem-gb 62 2>&1)
grep -q '^FAIL sizing rule: 6 runners carry the supabase label, but 16 CPUs carry at most 4' <<<"$out" && grep -q 'load average of 58' <<<"$out" \
  && ok "verify-server.sh fails the six-supabase-runner layout that ran at load 58 on 16 CPUs" || fail "sizing verify: $out"

out=$(prov --config /skill/examples/multi-repo.conf --dry-run --cpus 16 --mem-gb 62 </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step sizing: the plan does not fit the host (16 CPUs, 62 GB)' <<<"$out" && grep -q 'allow-oversubscribed' <<<"$out" \
  && ok "provision.sh refuses six supabase runners on 16 CPUs and names the override" || fail "sizing provision: rc=$rc out=$out"
out=$(prov --config /skill/examples/multi-repo.conf --dry-run --allow-oversubscribed --cpus 16 --mem-gb 62 </dev/null); rc=$?
[ "$rc" = 0 ] && grep -q 'warning, the sizing rule is broken' <<<"$out" && ok "--allow-oversubscribed goes on and warns" || fail "oversubscribed: rc=$rc out=$out"

fstab_before=$(cat /etc/fstab)
out=$(prov --config "$work/one.conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step mounts: slot 1 has /home/ci1/runner/_work at size=10G in /etc/fstab, and the config asks for size=12G' <<<"$out" && [ "$fstab_before" = "$(cat /etc/fstab)" ] \
  && ok "a changed tmpfs size stops the run, names the slot and both sizes, and leaves fstab alone" || fail "fstab size change: rc=$rc out=$out"

before=$(digest); touch "$state/arm"
out=$(prov --config "$conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'this host is aarch64' <<<"$out" && grep -q 'x86_64' <<<"$out" && [ "$before" = "$(digest)" ] \
  && ok "a host that is not x86_64 is refused before any change, naming its architecture" || fail "arch: rc=$rc out=$out"
rm -f "$state/arm"

sed 's/^runner = 2:.*/runner = 9:acme\/app:app/' "$conf" >"$work/nine.conf"
touch "$state/mount-fails"
out=$(prov --config "$work/nine.conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q "step mounts: 'mount /home/ci9/runner/_work' exited with code 32: mount: /home/ci9/runner/_work: permission denied (fake)" <<<"$out" \
  && ok "a failing command stops the run and names the step, the command, its exit code and its output" || fail "mount failure: rc=$rc out=$out"
rm -f "$state/mount-fails"

rm -f /opt/actions-runner-linux-x64.tar.gz; touch "$state/bad-tarball"
out=$(prov --config "$conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q "step runner-download: the runner tarball does not match sha256 $runner_sha" <<<"$out" && [ ! -e /opt/actions-runner-linux-x64.tar.gz ] \
  && ok "a runner tarball with the wrong checksum is refused and not kept" || fail "tarball: rc=$rc out=$out"
rm -f "$state/bad-tarball"

: >"$state/calls"
out=$(prov --config "$conf" --dry-run $size --skip packages,sources,ssh </dev/null)
grep -q 'step packages skipped by --skip' <<<"$out" && ! grep -q 'apt-get install' "$state/calls" && ok "--skip leaves a step out" || fail "skip: $out"

touch "$state/swapon-fails"
out=$(prov --config "$conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'swapon: cannot read /proc/swaps (fake)' <<<"$out" && grep -q 'step swap: swapon --show failed with exit code 1' <<<"$out" \
  && ok "a failing swapon --show stops the run with its own message" || fail "swapon failure: rc=$rc out=$out"
rm -f "$state/swapon-fails"

grep -vE '^(sweep_repos|docker_sweep_[a-z_]+|prepull_images) = ' "$conf" >"$work/bare.conf"
: >"$state/calls"
out=$(prov --config "$work/bare.conf" $size </dev/null); rc=$?
[ "$rc" = 0 ] && grep -qx 'systemctl disable --now ci-docker-sweep.timer' "$state/calls" && ! all_enabled ci-docker-sweep.timer \
  && [ ! -e /etc/systemd/system/ci-runner-sweep.timer ] && [ ! -e /etc/systemd/system/ci-docker-sweep.service ] && [ ! -e /etc/systemd/system/ci-docker-prepull.timer ] \
  && ok "a config without the sweeps turns their timers off and removes their units" || fail "retire timers: rc=$rc out=$out"

[ "$fails" = 0 ] && echo "provision (in container): all passed" || { echo "provision (in container): $fails failed"; exit 1; }
