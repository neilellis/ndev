#!/usr/bin/env bash
set -uo pipefail

[ -f /.dockerenv ] || { echo "provision-in-container.sh changes users, /etc and /opt. Run it only inside a throwaway container, through provision.container.test.mjs."; exit 2; }
scripts=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }

state=/fake-state
mkdir -p "$state" /fake-bin
: >"$state/installed"
export FAKE_STATE=$state
export PATH=/fake-bin:$PATH

fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"/fake-bin/$1"; chmod +x "/fake-bin/$1"; }
fake sshd 'echo "sshd $*" >>"$FAKE_STATE/calls"'
fake visudo 'echo "visudo $*" >>"$FAKE_STATE/calls"; grep -q NOPASSWD "${@: -1}"'
fake gpg 'echo "gpg $*" >>"$FAKE_STATE/calls"; cat >"${3:-/dev/null}"'
fake dpkg 'if [ "$1" = --print-architecture ]; then cat "$FAKE_STATE/arch" 2>/dev/null || echo amd64; else exec /usr/bin/dpkg "$@"; fi'
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
fake sha256sum 'if [ "$1" = -c ]; then read -r line; f=${line#*  }; [ -f "$f" ] && ! grep -q bad "$f" && exit 0; exit 1; fi; exec /usr/bin/sha256sum "$@"'
fake mount 'echo "mount $*" >>"$FAKE_STATE/calls"; [ -e "$FAKE_STATE/mount-fails" ] && { echo "mount: $1: permission denied (fake)" >&2; exit 32; }; echo "$1" >>"$FAKE_STATE/mounted"'
fake mountpoint 'grep -qx "${@: -1}" "$FAKE_STATE/mounted" 2>/dev/null'
fake swapon 'if [ "$1" = --show ]; then cat "$FAKE_STATE/swap" 2>/dev/null; else echo "$1 file 1M 0B -2" >"$FAKE_STATE/swap"; fi; exit 0'
fake mkswap 'echo "mkswap $*" >>"$FAKE_STATE/calls"'
fake ufw 'echo "ufw $*" >>"$FAKE_STATE/calls"; case "$1" in status) [ -e "$FAKE_STATE/ufw-on" ] && echo "Status: active" ;; --force) touch "$FAKE_STATE/ufw-on" ;; esac; exit 0'
fake systemctl 'echo "systemctl $*" >>"$FAKE_STATE/calls"
case "$1" in
  is-enabled) shift; [ "$1" = --quiet ] && shift; for u in "$@"; do grep -qx "$u" "$FAKE_STATE/enabled" 2>/dev/null || exit 1; done ;;
  enable) for a in "$@"; do case "$a" in enable|--now) ;; *) echo "$a" >>"$FAKE_STATE/enabled"; echo "$a" >>"$FAKE_STATE/active" ;; esac; done ;;
  start) echo "$2" >>"$FAKE_STATE/active" ;;
  stop) grep -vx "$2" "$FAKE_STATE/active" >"$FAKE_STATE/active.new"; mv "$FAKE_STATE/active.new" "$FAKE_STATE/active" ;;
  is-active) shift; [ "$1" = --quiet ] && shift; grep -qx "$1" "$FAKE_STATE/active" 2>/dev/null || exit 3 ;;
  list-unit-files) shift 3; found=1; for f in $(ls /etc/systemd/system); do for pat in "$@"; do case "$f" in $pat) echo "$f enabled enabled"; found=0 ;; esac; done; done; exit $found ;;
esac
exit 0'
fake findmnt 'path=${@: -1}
grep -qx "$path" "$FAKE_STATE/mounted" 2>/dev/null || { echo "findmnt: $path not mounted (fake)" >&2; exit 1; }
case "$*" in
  *FSTYPE*) echo tmpfs ;;
  *SIZE*) s=$(grep " $path tmpfs " /etc/fstab | sed "s/.*size=\([0-9]*\)\([MG]\).*/\1 \2/"); set -- $s; [ "$2" = G ] && echo $(($1 * 1073741824)) || echo $(($1 * 1048576)) ;;
esac'
fake ss 'cat "$FAKE_STATE/listeners" 2>/dev/null; exit 0'
fake docker '[ -e "$FAKE_STATE/docker-down" ] && { echo "Cannot connect to the Docker daemon (fake)" >&2; exit 1; }; case "$*" in "info "*) echo 29.10.0 ;; esac; exit 0'
fake sysctl 'if [ "$1" = -n ]; then grep -h "^$2 " /etc/sysctl.d/60-ci-server.conf | sed "s/.*= //"; else echo "sysctl $*" >>"$FAKE_STATE/calls"; fi; exit 0'

userdel ubuntu 2>/dev/null; groupdel ubuntu 2>/dev/null; groupadd -g 988 docker
mkdir -p /tmp/runner-src /opt
printf '#!/bin/sh\nname=""; url=""; labels=""\nwhile [ "$#" -gt 0 ]; do case "$1" in --name) name=$2 ;; --url) url=$2 ;; --labels) labels=$2 ;; esac; shift; done\necho "$name $labels" >>"$FAKE_STATE/config-calls"\nprintf "\\357\\273\\277{\\n  \\n  \\"agentName\\": \\"%%s\\",\\n  \\"gitHubUrl\\": \\"%%s\\",\\n  \\"workFolder\\": \\"_work\\"\\n}" "$name" "$url" >.runner\ntouch .credentials\n' >/tmp/runner-src/config.sh
printf '#!/bin/sh\nname=$(sed -n "s/.*agentName\\": \\"\\(.*\\)\\",/\\1/p" .runner)\nurl=$(sed -n "s/.*gitHubUrl\\": \\"\\(.*\\)\\",/\\1/p" .runner)\nrepo=$(echo "${url#https://github.com/}" | tr / -)\ntouch /etc/systemd/system/actions.runner.$repo.$name.service\n' >/tmp/runner-src/svc.sh
chmod +x /tmp/runner-src/*.sh
tar -czf "$state/runner.tar.gz" -C /tmp/runner-src config.sh svc.sh
chmod 0644 "$state/runner.tar.gz"; chmod 0755 "$state"; touch "$state/config-calls"; chmod 0666 "$state/config-calls"

conf=/tmp/acme.conf
cat >"$conf" <<'EOF'
name_prefix=acme-build
timezone=Europe/London
supabase=yes
node_major=22
runner=1:acme/app:app,supabase
runner=2:acme/app:app,supabase
runner=5:acme/data:data:16G:4G
sweep_repo=acme/app
image=postgres:17
docker_sweep_project=^app-test(-ci[0-9]+)?$
EOF

prov() { bash "$scripts/provision.sh" "$@" 2>&1; }
digest() { find /etc /home /opt /usr/local -type f -not -path '*/.cache/*' -exec /usr/bin/sha256sum {} + 2>/dev/null | sort | /usr/bin/sha256sum; }
size="--cpus 16 --mem-gb 64"
token=ghs_SECRETTOKENVALUE0123456789
tokens() { printf 'acme/app %s\nacme/data %s\n' "$token" "$token"; }

before=$(digest); passwd_before=$(cat /etc/passwd)
out=$(prov --config "$conf" --plan); rc=$?
steps_ok=1
for s in sizing base sources packages kernel swap docker users mounts runner-download cockpit ssh ports register sweeps; do grep -q "step [0-9]* $s:" <<<"$out" || steps_ok=0; done
[ "$rc" = 0 ] && [ "$steps_ok" = 1 ] && grep -q 'acme-build-5: user ci5, repository acme/data, labels data, ports 21500-21599, _work tmpfs 16G, tmp tmpfs 4G' <<<"$out" \
  && [ "$before" = "$(digest)" ] && [ "$passwd_before" = "$(cat /etc/passwd)" ] \
  && ok "--plan prints every step and each runner's values and changes nothing" || fail "--plan: rc=$rc out=$out"

out=$(prov --config "$conf" --dry-run $size </dev/null); rc=$?
! id ci1 >/dev/null 2>&1 && [ "$before" = "$(digest)" ] && ! grep -qE '^(apt-get|mount|curl|timedatectl set|locale-gen|sysctl|systemctl (enable|restart|start|daemon-reload))' "$state/calls" 2>/dev/null \
  && grep -q 'would write /etc/docker/daemon.json' <<<"$out" && grep -q 'would add to /etc/fstab: tmpfs /home/ci5/runner/_work tmpfs size=16G' <<<"$out" \
  && [ "$rc" = 0 ] && ok "--dry-run lists the changes it would make and makes none" || fail "--dry-run: rc=$rc out=$out"

out=$(prov --config "$conf" $size --swap-size 1M --register </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q "no registration token for acme/app on standard input" <<<"$out" && grep -q "registration-token -q .token" <<<"$out" && grep -q "Nothing was changed" <<<"$out" && ! id ci1 >/dev/null 2>&1 \
  && ok "--register with no token stops before any change and names the command that makes one" || fail "missing token: rc=$rc out=$out"

out=$(prov --config "$conf" $size --swap-size 1M --register < <(tokens)); rc=$?
[ "$rc" = 0 ] && ok "a real run with --register succeeds" || fail "real run: rc=$rc out=$out"
[ "$(id -u ci1)" = 1000 ] && [ "$(id -u ci2)" = 1001 ] && [ "$(id -u ci5)" = 1004 ] && id -nG ci1 | grep -qw docker \
  && ok "users ci1, ci2 and ci5 exist with uids 1000, 1001 and 1004 in the docker group" || fail "users"
grep -qx 'tmpfs /home/ci1/runner/_work tmpfs size=10G,mode=0755,uid=1000,gid=1000,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci1/tmp tmpfs size=3G,mode=0700,uid=1000,gid=1000,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci5/runner/_work tmpfs size=16G,mode=0755,uid=1004,gid=1004,nosuid,nodev 0 0' /etc/fstab \
  && grep -qx 'tmpfs /home/ci5/tmp tmpfs size=4G,mode=0700,uid=1004,gid=1004,nosuid,nodev 0 0' /etc/fstab \
  && ok "fstab holds the default tmpfs sizes and the per-runner override" || fail "fstab: $(cat /etc/fstab)"
grep -qx 'CI_PORT_BASE=21500' /home/ci5/runner/.env && grep -qx 'SUPABASE_PROJECT_ID_SUFFIX=-ci5' /home/ci5/runner/.env && grep -qx 'SUPABASE_DB_PORT=21502' /home/ci5/runner/.env && grep -qx 'TMPDIR=/home/ci5/tmp' /home/ci5/runner/.env && [ "$(stat -c %U /home/ci5/runner/.env)" = ci5 ] \
  && ok "each runner's .env holds its port block, its Supabase ports and its project id suffix" || fail ".env: $(cat /home/ci5/runner/.env)"
[ -f /swapfile ] && grep -qx '/swapfile none swap sw 0 0' /etc/fstab && ok "a swap file is made when no swap is active" || fail "swap"
grep -q 'max-size": "20m"' /etc/docker/daemon.json && grep -qx 'vm.swappiness = 10' /etc/sysctl.d/60-ci-server.conf && grep -qx 'ci1 ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/ss' /etc/sudoers.d/ci1 \
  && [ "$(cat "$state/tz")" = Europe/London ] && grep -qx nodejs "$state/installed" && ! grep -qx google-chrome-stable "$state/installed" && [ ! -e /etc/apt/sources.list.d/google-chrome.list ] \
  && ok "the config sets the time zone, Node and no Chrome; docker log caps, sysctl and sudoers are written" || fail "config files"
for u in actions.runner.acme-app.acme-build-1.service actions.runner.acme-app.acme-build-2.service actions.runner.acme-data.acme-build-5.service; do
  [ -f "/etc/systemd/system/$u" ] && grep -qx "$u" "$state/active" || fail "unit $u"
done
grep -q '"agentName": "acme-build-5"' /home/ci5/runner/.runner && grep -q 'github.com/acme/data' /home/ci5/runner/.runner && grep -qx 'acme-build-5 data' "$state/config-calls" \
  && ok "each runner is registered to its own repository with its labels and has its service" || fail "registration: $(cat "$state/config-calls")"
[ -f /etc/systemd/system/actions.runner.acme-app.acme-build-1.service.d/10-ci-recovery.conf ] && [ ! -e /etc/systemd/system/actions.runner.acme-data.acme-build-5.service.d ] \
  && grep -qxF "ExecStart=/usr/local/libexec/ci-server/runner-sweep --units 'actions.runner.acme-app.*.service'" /etc/systemd/system/ci-runner-sweep.service \
  && grep -qxF 'project=^app-test(-ci[0-9]+)?$' /etc/ci-server/docker-sweep.conf && grep -qx 'postgres:17' /etc/ci-server/images.txt \
  && grep -qx ci-runner-sweep.timer "$state/enabled" && grep -qx ci-docker-sweep.timer "$state/enabled" && grep -qx ci-docker-prepull.timer "$state/enabled" \
  && ok "the recovery drop-in and runner sweep go to the sweep_repo runners only; the docker sweep and pre-pull follow the config" || fail "sweeps: $(ls -R /etc/systemd/system)"
if grep -rqF "$token" /etc /home /opt /root /usr/local /tmp "$state" 2>/dev/null; then fail "the registration token was stored in a file"; else ok "the registration token is stored nowhere"; fi

after=$(digest)
out=$(prov --config "$conf" $size --swap-size 1M --register </dev/null); rc=$?
[ "$rc" = 0 ] && grep -q 'done, 0 change(s)' <<<"$out" && [ "$after" = "$(digest)" ] && ! grep -qE 'wrote |added to|would' <<<"$out" \
  && ok "a second run changes nothing and says 0 changes" || fail "idempotence: rc=$rc out=$out"
out=$(prov --config "$conf" --dry-run $size --swap-size 1M --register </dev/null)
grep -q 'done, 0 change(s)' <<<"$out" && ok "--dry-run on a provisioned host finds nothing to change" || fail "dry-run after: $out"

: >"$state/config-calls"
out=$(prov --config "$conf" $size --register --reregister 2 < <(tokens)); rc=$?
[ "$rc" = 0 ] && [ "$(cat "$state/config-calls")" = "acme-build-2 app,supabase" ] && grep -qx actions.runner.acme-app.acme-build-2.service "$state/active" && grep -q 'removed the local registration of acme-build-2' <<<"$out" \
  && ok "--reregister registers only the named slot again and starts its service" || fail "reregister: rc=$rc out=$out"
out=$(prov --config "$conf" $size --reregister 2 </dev/null); rc=$?
[ "$rc" = 2 ] && grep -q -- '--reregister needs --register' <<<"$out" && ok "--reregister without --register is refused" || fail "reregister alone: rc=$rc out=$out"

verify() { bash "$scripts/verify-server.sh" --config "$conf" --only host $size 2>&1; }
out=$(verify); rc=$?
[ "$rc" = 0 ] && grep -q '^PASS docker works' <<<"$out" && grep -q '^PASS ci5 _work is tmpfs' <<<"$out" && grep -q '^PASS ci-docker-prepull.timer is active' <<<"$out" && grep -q '^PASS ci1 ports 21100-21199 are free' <<<"$out" && grep -q ', 0 failed' <<<"$out" \
  && ok "verify-server.sh passes on the provisioned host" || fail "verify host pass: rc=$rc out=$out"

echo "LISTEN 0 4096 0.0.0.0:21101 0.0.0.0:*" >"$state/listeners"; touch "$state/docker-down"; grep -v ci2/tmp "$state/mounted" >"$state/mounted.new"; mv "$state/mounted.new" "$state/mounted"
echo 'CI_PORT_BASE=1' >>/home/ci5/runner/.env
out=$(verify); rc=$?
[ "$rc" = 1 ] && grep -q '^FAIL ci1 ports 21100-21199 are free: something already listens' <<<"$out" && grep -q '^FAIL docker works: docker info failed' <<<"$out" && grep -q '^FAIL ci2 tmp is tmpfs: .*not mounted' <<<"$out" && grep -q '^FAIL ci5 .env matches the config: .*CI_PORT_BASE=1' <<<"$out" \
  && ok "verify-server.sh lists each failing check with the command's own message" || fail "verify host fail: rc=$rc out=$out"
rm -f "$state/listeners" "$state/docker-down"; echo /home/ci2/tmp >>"$state/mounted"
out=$(prov --config "$conf" $size --swap-size 1M); rc=$?
[ "$rc" = 0 ] && grep -q 'wrote /home/ci5/runner/.env' <<<"$out" && grep -q 'done, 1 change(s)' <<<"$out" && ok "a run after drift writes back only what differs" || fail "drift: rc=$rc out=$out"

six=(--runner 1:acme/app:app,supabase --runner 2:acme/app:app,supabase --runner 3:acme/app:app,supabase --runner 4:acme/app:app,supabase --runner 5:acme/data:data,supabase:16G:4G --runner 6:acme/data:data,supabase)
out=$(prov --dry-run --name-prefix acme-build --cpus 16 --mem-gb 62 "${six[@]}" </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step sizing: the plan does not fit the host (16 CPUs, 62 GB)' <<<"$out" && grep -q 'load average of 58' <<<"$out" && grep -q 'allow-oversubscribed' <<<"$out" \
  && ok "provision.sh refuses six supabase runners on 16 CPUs and names the override" || fail "sizing provision: rc=$rc out=$out"
out=$(prov --dry-run --allow-oversubscribed --name-prefix acme-build --cpus 16 --mem-gb 62 "${six[@]}" </dev/null); rc=$?
[ "$rc" = 0 ] && grep -q 'warning, the sizing rule is broken' <<<"$out" && ok "--allow-oversubscribed goes on and warns" || fail "oversubscribed: rc=$rc out=$out"

touch "$state/mount-fails"
out=$(prov --name-prefix acme-build $size --runner 9:acme/app:app </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q "step mounts: 'mount /home/ci9/runner/_work' exited with code 32: mount: /home/ci9/runner/_work: permission denied (fake)" <<<"$out" \
  && ok "a failing command stops the run and names the step, the command, its exit code and its output" || fail "mount failure: rc=$rc out=$out"
rm -f "$state/mount-fails"

out=$(prov --name-prefix acme-build $size --runner 1:acme/app:app:20G:3G --skip runner-download,register,sweeps </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step mounts: /etc/fstab has another tmpfs line for /home/ci1/runner/_work' <<<"$out" \
  && ok "a changed tmpfs size for a mounted runner stops the run instead of adding a second line" || fail "fstab conflict: rc=$rc out=$out"

rm -f /opt/actions-runner-linux-x64-*.tar.gz; touch "$state/bad-tarball"
out=$(prov --config "$conf" $size </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step runner-download: the runner tarball does not match sha256 baebf204' <<<"$out" && ! ls /opt/actions-runner-linux-x64-* >/dev/null 2>&1 \
  && ok "a runner tarball with the wrong checksum is refused and not kept" || fail "tarball: rc=$rc out=$out"
rm -f "$state/bad-tarball"

echo arm64 >"$state/arch"
out=$(prov --config "$conf" $size --skip sources </dev/null); rc=$?
[ "$rc" = 1 ] && grep -q 'step runner-download: the pinned runner is for linux x64, and this host is arm64' <<<"$out" && ok "a host that is not x64 is refused at the runner download" || fail "arch: rc=$rc out=$out"
rm -f "$state/arch"

: >"$state/calls"
out=$(prov --config "$conf" --dry-run $size --skip packages,sources,ssh </dev/null)
grep -q 'step packages skipped by --skip' <<<"$out" && ! grep -q 'apt-get install' "$state/calls" && ok "--skip leaves a step out" || fail "skip: $out"

[ "$fails" = 0 ] && echo "provision (in container): all passed" || { echo "provision (in container): $fails failed"; exit 1; }
