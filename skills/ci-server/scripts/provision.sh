#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
usage="Usage: provision.sh --config <file> [options]
       provision.sh --name-prefix NAME --runner <slot>:<owner>/<repo>:<labels>[:<work size>:<tmp size>] [--runner ...] [options]

  --config FILE          the project's layout (keys: see references/config.md of the ci-server skill)
  --runner SPEC          one runner, repeat for each; replaces the runner= lines of the config (slot 1-99)
  --name-prefix NAME     runner names are NAME-<slot>
  --work-size SIZE       default size of each runner's _work tmpfs (default 10G)
  --tmp-size SIZE        default size of each runner's TMPDIR tmpfs (default 3G)
  --port-base N          slot n gets the ports N+100n to N+100n+99 (default 21000)
  --swap-size SIZE       swap file made only when the host has no active swap (default 16G)
  --cpus N, --mem-gb N   override the detected CPUs and memory for the sizing rule
  --allow-oversubscribed go on when the sizing rule is broken
  --skip STEP[,STEP]     leave steps out (names are printed by --plan)
  --register             register the runners; reads one 'owner/repo token' line per repository from standard input
  --reregister SLOT[,SLOT]  delete the local registration of these slots and register them again (needs --register)
  --plan                 print every step and the values it would use, read nothing, change nothing
  --dry-run              run the checks and print each change that would be made, change nothing"

all_steps="sizing base sources packages kernel swap docker users mounts runner-download cockpit ssh ports register sweeps"
libexec=/usr/local/libexec/ci-server
etc_dir=/etc/ci-server
fail() { echo "provision.sh: $1" >&2; exit 1; }
usage_fail() { echo "provision.sh: $1" >&2; echo "$usage" >&2; exit 2; }
. "$here/lib.sh"

cis_defaults
mode=apply register=0 allow_over=0 skip="" reregister=""
cis_preload_config "$@"
while [ "$#" -gt 0 ]; do
  if cis_common_option "$@"; then shift 2; continue; fi
  case "$1" in
    --skip|--reregister)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value."
      if [ "$1" = --skip ]; then skip=$2; else reregister=$2; fi
      shift 2 ;;
    --register) register=1; shift ;;
    --allow-oversubscribed) allow_over=1; shift ;;
    --plan) mode=plan; shift ;;
    --dry-run) mode=dryrun; shift ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
cis_validate
for s in ${skip//,/ }; do
  case " $all_steps " in *" $s "*) ;; *) usage_fail "--skip names '$s', which is not a step. The steps are: $all_steps." ;; esac
done
if [ -n "$reregister" ]; then
  [ "$register" = 1 ] || usage_fail "--reregister needs --register and a token for each repository on standard input."
  for s in ${reregister//,/ }; do
    [ -n "${r_repo[$s]:-}" ] || usage_fail "--reregister names slot '$s', which is not a runner in this plan."
  done
fi

step_enabled() { case ",$skip," in *",$1,"*) return 1 ;; esac; return 0; }
in_reregister() { case ",$reregister," in *",$1,"*) return 0 ;; esac; return 1; }
core_packages=(
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  gh git git-lfs jq curl ca-certificates gnupg build-essential python3 rsync unzip zip xz-utils
  sysstat pcp htop lsof psmisc strace uuid-runtime mdadm fail2ban ufw unattended-upgrades
)
wanted_packages() {
  local list=("${core_packages[@]}")
  [ -z "$node_major" ] || list+=(nodejs)
  [ "$chrome" = no ] || list+=(google-chrome-stable)
  [ "$cockpit" = no ] || list+=(cockpit cockpit-storaged cockpit-networkmanager cockpit-packagekit python3-pcp)
  local p
  for p in $packages; do list+=("$p"); done
  printf '%s\n' "${list[@]}"
}

if [ "$mode" = plan ]; then
  echo "provision.sh plan: $runner_count runners, name prefix $name_prefix, port base $port_base, swap file $swap_size if the host has no swap${config_file:+, config $config_file}"
  for n in "${slots[@]}"; do
    base=$((port_base + 100 * n))
    echo "  runner $name_prefix-$n: user ci$n, repository ${r_repo[$n]}, labels ${r_labels[$n]}, ports $base-$((base + 99)), _work tmpfs ${r_work[$n]}, tmp tmpfs ${r_tmp[$n]}, unit $(cis_unit_name "$n")"
  done
  describe() {
    case "$1" in
      sizing) echo "check the runner count against the CPUs and memory (one $heavy_label runner per $sizing_cpus_per_heavy_runner CPUs, one runner per $sizing_cpus_per_runner CPUs, $sizing_gb_per_runner GB per runner)" ;;
      base) echo "set the time zone to $timezone, the locale to en_US.UTF-8, the apt lock timeout and unattended upgrades" ;;
      sources) echo "add the package sources for Docker and the GitHub CLI$([ -z "$node_major" ] || echo ", NodeSource $node_major")$([ "$chrome" = no ] || echo ", Google Chrome")" ;;
      packages) echo "install $(wanted_packages | paste -sd' ' -)" ;;
      kernel) echo "write /etc/sysctl.d/60-ci-server.conf (${sysctl_values[*]}); no ulimit overrides" ;;
      swap) echo "keep a swap partition the installer made; make a $swap_size /swapfile only if no swap is active" ;;
      docker) echo "write /etc/docker/daemon.json (3 x 20 MB logs, builder cache capped), enable docker, add the weekly prune" ;;
      users) echo "make users ci<slot> (uid 999+slot) in the docker group$([ -z "$runner_sudo" ] || echo " with sudo for $runner_sudo"), their runner, _work, tmp and toolcache folders" ;;
      mounts) echo "add the _work and tmp tmpfs lines to /etc/fstab and mount them" ;;
      runner-download) echo "download Actions runner $runner_version (linux x64) to /opt and check its sha256" ;;
      cockpit) if [ "$cockpit" = yes ]; then echo "make the admin user (no password), bind Cockpit to 127.0.0.1:9090, keep root out of Cockpit"; else echo "nothing: cockpit=no"; fi ;;
      ssh) echo "SSH keys only, enable fail2ban, the firewall lets in SSH only; enable sysstat, pmcd, pmlogger${services:+, $services}" ;;
      ports) echo "write /home/ci<slot>/runner/.env: CI_PORT_BASE, CI_RUNNER_SLOT, TMPDIR, RUNNER_TOOL_CACHE$([ "$supabase" = no ] || echo ", the SUPABASE_*_PORT values, SUPABASE_PROJECT_ID_SUFFIX=-ci<slot>")" ;;
      register) echo "register each runner and install its systemd service (needs --register and a token per repository on standard input; tokens are never stored)" ;;
      sweeps) if [ "${#sweep_repos[@]}${#images[@]}${#docker_sweep_projects[@]}${#docker_sweep_containers[@]}${#docker_sweep_images[@]}" = 00000 ]; then echo "nothing: the config names no sweep_repo, docker_sweep rule or image"; else echo "recovery drop-in and runner sweep for ${sweep_repos[*]:-no repository}; docker sweep with ${#docker_sweep_projects[@]} project and ${#docker_sweep_containers[@]} container rules; pre-pull of ${#images[@]} images"; fi ;;
    esac
  }
  i=0
  for s in $all_steps; do
    i=$((i + 1))
    if step_enabled "$s"; then echo "  step $i $s: $(describe "$s")"; else echo "  step $i $s: skipped by --skip"; fi
  done
  exit 0
fi

dry=0; [ "$mode" = dryrun ] && dry=1
changes=0
changed=0
current_step=start

note_change() { changes=$((changes + 1)); }
run() {
  if [ "$dry" = 1 ]; then echo "provision.sh: would run: $*"; note_change; return 0; fi
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  [ "$rc" = 0 ] || fail "step $current_step: '$*' exited with code $rc: $out"
  note_change
}
write_file() {
  local target=$1 mode_bits=$2 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  changed=0
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then rm -f "$tmp"; return 0; fi
  changed=1
  note_change
  if [ "$dry" = 1 ]; then echo "provision.sh: would write $target"; rm -f "$tmp"; return 0; fi
  install -D -m "$mode_bits" "$tmp" "$target" || { rm -f "$tmp"; fail "step $current_step: could not write $target."; }
  rm -f "$tmp"
  echo "provision.sh: wrote $target"
}
install_script() {
  write_file "$2" 0755 <"$here/$1"
}
enable_units() {
  local u
  for u in "$@"; do
    systemctl is-enabled --quiet "$u" 2>/dev/null || run systemctl enable --now "$u"
  done
}
step() {
  current_step=$1
  if step_enabled "$1"; then echo "provision.sh: step $1"; return 0; fi
  echo "provision.sh: step $1 skipped by --skip"
  return 1
}

[ "$dry" = 1 ] || [ "$(id -u)" = 0 ] || fail "run as root."
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || fail "this script sets up Ubuntu 24.04, not $PRETTY_NAME."
export DEBIAN_FRONTEND=noninteractive

registered() {
  local file=/home/ci$1/runner/.runner
  [ -f "$file" ] && grep -qF "\"agentName\": \"$name_prefix-$1\"," "$file" && grep -qF "\"gitHubUrl\": \"https://github.com/${r_repo[$1]}\"," "$file"
}

declare -A token_of
if [ "$register" = 1 ] && step_enabled register; then
  if [ "$dry" = 0 ]; then
    if [ -t 0 ]; then fail "--register reads one 'owner/repo token' line per repository from standard input, and standard input is a terminal. Make each token with 'gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token' and pipe the lines in over ssh."; fi
    while read -r repo_name token_value _; do
      [ -n "${repo_name:-}" ] || continue
      token_of[$repo_name]=$token_value
    done
  fi
  for n in "${slots[@]}"; do
    if [ "$dry" = 0 ] && { ! registered "$n" || in_reregister "$n"; } && [ -z "${token_of[${r_repo[$n]}]:-}" ]; then
      fail "no registration token for ${r_repo[$n]} on standard input, and $name_prefix-$n needs one. Make one with: gh api -X POST repos/${r_repo[$n]}/actions/runners/registration-token -q .token and send the line '${r_repo[$n]} <token>'. Nothing was changed."
    fi
  done
fi

if step sizing; then
  cis_host_size
  problems=$(sizing_problems "$cpus" "$mem_gb" "$runner_count" "$heavy_count" "$heavy_label")
  if [ -n "$problems" ]; then
    if [ "$allow_over" = 1 ]; then
      echo "provision.sh: warning, the sizing rule is broken and --allow-oversubscribed goes on anyway:"; echo "$problems"
    else
      fail "step sizing: the plan does not fit the host ($cpus CPUs, $mem_gb GB). $problems Give fewer runners or fewer $heavy_label labels, or pass --allow-oversubscribed to accept the risk. Nothing was changed."
    fi
  else
    echo "provision.sh: $runner_count runners, $heavy_count with $heavy_label, fit $cpus CPUs and $mem_gb GB."
  fi
fi

if step base; then
  [ "$(timedatectl show -p Timezone --value 2>/dev/null)" = "$timezone" ] || run timedatectl set-timezone "$timezone"
  locale -a 2>/dev/null | grep -qix 'en_US.utf-\?8' || run locale-gen en_US.UTF-8
  grep -qx 'LANG=en_US.UTF-8' /etc/default/locale 2>/dev/null || run update-locale LANG=en_US.UTF-8
  write_file /etc/apt/apt.conf.d/90ci-lock 0644 <<'EOT'
DPkg::Lock::Timeout "600";
Acquire::Retries "3";
EOT
  write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOT
fi

if step sources; then
  need_update=0
  have_pkgs=1
  for p in ca-certificates curl gnupg; do dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || have_pkgs=0; done
  if [ "$have_pkgs" = 0 ]; then run apt-get update -q; run apt-get install -y -q ca-certificates curl gnupg; fi
  [ -d /etc/apt/keyrings ] || run install -d -m 0755 /etc/apt/keyrings
  fetch_key() {
    local target=$1 url=$2 dearmor=$3
    [ -s "$target" ] && return 0
    need_update=1
    if [ "$dearmor" = 1 ]; then run bash -c "curl -fsSL '$url' | gpg --dearmor -o '$target'"; else run curl -fsSL "$url" -o "$target"; fi
  }
  arch=$(dpkg --print-architecture)
  source_list() {
    write_file "/etc/apt/sources.list.d/$1.list" 0644
    [ "$changed" = 0 ] || need_update=1
  }
  fetch_key /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg 0
  fetch_key /etc/apt/keyrings/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg 0
  source_list docker <<<"deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable"
  source_list github-cli <<<"deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main"
  if [ -n "$node_major" ]; then
    fetch_key /etc/apt/keyrings/nodesource.gpg https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key 1
    source_list nodesource <<<"deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$node_major.x nodistro main"
  fi
  if [ "$chrome" = yes ]; then
    fetch_key /etc/apt/keyrings/google-chrome.gpg https://dl.google.com/linux/linux_signing_key.pub 1
    source_list google-chrome <<<"deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main"
  fi
  [ "$dry" = 1 ] || [ ! -d /etc/apt/keyrings ] || chmod a+r /etc/apt/keyrings/*
  [ "$need_update" = 0 ] || run apt-get update -q
fi

if step packages; then
  missing=()
  while read -r p; do
    dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing+=("$p")
  done < <(wanted_packages)
  if [ "${#missing[@]}" -gt 0 ]; then run apt-get install -y -q "${missing[@]}"; fi
fi

if step kernel; then
  write_file /etc/sysctl.d/60-ci-server.conf 0644 < <(printf '%s\n' "${sysctl_values[@]}" | sed 's/=/ = /')
  [ "$changed" = 0 ] || run sysctl --system
fi

if step swap; then
  if [ -n "$(swapon --show --noheadings 2>&1)" ]; then
    echo "provision.sh: swap is already active; none is added."
  elif [ "$dry" = 1 ]; then
    echo "provision.sh: would make /swapfile of $swap_size and add it to /etc/fstab"; note_change
  else
    run fallocate -l "$swap_size" /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    grep -qxF '/swapfile none swap sw 0 0' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
fi

if step docker; then
  write_file /etc/docker/daemon.json 0644 <<'EOT'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "builder": { "gc": { "enabled": true, "defaultReservedSpace": "10GB", "defaultMaxUsedSpace": "20GB" } }
}
EOT
  [ "$changed" = 0 ] || run systemctl restart docker
  systemctl is-enabled --quiet docker containerd 2>/dev/null || run systemctl enable --now docker containerd
  write_file /etc/cron.weekly/docker-prune 0755 <<'EOT'
#!/bin/sh
docker system prune -af --filter "until=168h" >/var/log/docker-prune.log 2>&1
EOT
fi

if step users; then
  for n in "${slots[@]}"; do
    user=ci$n
    id "$user" >/dev/null 2>&1 || run useradd --create-home --shell /bin/bash --uid $((999 + n)) --user-group "$user"
    id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx docker || run usermod -aG docker "$user"
    if [ -n "$runner_sudo" ]; then
      write_file "/etc/sudoers.d/$user" 0440 <<<"$user ALL=(root) NOPASSWD: $runner_sudo"
      if [ "$dry" = 0 ]; then
        visudo -cf "/etc/sudoers.d/$user" >/dev/null || fail "step users: /etc/sudoers.d/$user does not parse. Fix runner_sudo in the config, then check with: visudo -cf /etc/sudoers.d/$user"
      fi
    elif [ -f "/etc/sudoers.d/$user" ]; then
      echo "provision.sh: runner_sudo is empty, but /etc/sudoers.d/$user exists; it is kept. Remove it by hand if the runner must have no sudo."
    fi
    for d in "/home/$user/runner:0755" "/home/$user/runner/_work:0755" "/home/$user/tmp:0700" "/home/$user/toolcache:0755"; do
      [ -d "${d%:*}" ] && [ "$(stat -c %U "${d%:*}")" = "$user" ] && continue
      run install -d -o "$user" -g "$user" -m "${d#*:}" "${d%:*}"
    done
  done
fi

if step mounts; then
  for n in "${slots[@]}"; do
    user=ci$n
    uid=$(id -u "$user" 2>/dev/null || echo $((999 + n))); gid=$(id -g "$user" 2>/dev/null || echo "$uid")
    for line in \
      "tmpfs /home/$user/runner/_work tmpfs size=${r_work[$n]},mode=0755,uid=$uid,gid=$gid,nosuid,nodev 0 0" \
      "tmpfs /home/$user/tmp tmpfs size=${r_tmp[$n]},mode=0700,uid=$uid,gid=$gid,nosuid,nodev 0 0"; do
      if ! grep -qxF "$line" /etc/fstab; then
        mount_point=$(cut -d' ' -f2 <<<"$line")
        if grep -q "^tmpfs $mount_point tmpfs " /etc/fstab; then
          fail "step mounts: /etc/fstab has another tmpfs line for $mount_point: $(grep "^tmpfs $mount_point tmpfs " /etc/fstab). Edit or remove it by hand (a mounted tmpfs loses its contents when you remount it), then run provision.sh again."
        fi
        note_change
        if [ "$dry" = 1 ]; then echo "provision.sh: would add to /etc/fstab: $line"; else echo "$line" >>/etc/fstab; echo "provision.sh: added to /etc/fstab: $line"; fi
      fi
    done
  done
  [ "$dry" = 1 ] || systemctl daemon-reload
  for n in "${slots[@]}"; do
    for m in "/home/ci$n/runner/_work" "/home/ci$n/tmp"; do
      mountpoint -q "$m" 2>/dev/null || run mount "$m"
    done
  done
fi

tarball=/opt/actions-runner-linux-x64-$runner_version.tar.gz
if step runner-download; then
  [ "$(dpkg --print-architecture)" = amd64 ] || fail "step runner-download: the pinned runner is for linux x64, and this host is $(dpkg --print-architecture). Set runner_version and runner_sha256 for an x64 host, or provision an x64 host."
  if ! echo "$runner_sha256  $tarball" | sha256sum -c --status 2>/dev/null; then
    run curl -fsSL -o "$tarball.part" "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz"
    if [ "$dry" = 0 ]; then
      echo "$runner_sha256  $tarball.part" | sha256sum -c --status || { rm -f "$tarball.part"; fail "step runner-download: the runner tarball does not match sha256 $runner_sha256. Check the release page of actions/runner v$runner_version."; }
      mv "$tarball.part" "$tarball"
    fi
  fi
fi

if step cockpit; then
  if [ "$cockpit" = no ]; then
    echo "provision.sh: cockpit=no; no console is set up."
  else
    id admin >/dev/null 2>&1 || run useradd --create-home --shell /bin/bash --groups sudo admin
    write_file /etc/sudoers.d/admin 0440 <<<"admin ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/snap"
    if [ "$dry" = 0 ]; then
      visudo -cf /etc/sudoers.d/admin >/dev/null || fail "step cockpit: /etc/sudoers.d/admin does not parse. Check it with: visudo -cf /etc/sudoers.d/admin"
    fi
    write_file /etc/systemd/system/cockpit.socket.d/listen.conf 0644 <<'EOT'
[Socket]
ListenStream=
ListenStream=127.0.0.1:9090
EOT
    [ "$changed" = 0 ] || run systemctl daemon-reload
    write_file /etc/cockpit/disallowed-users 0644 <<<"root"
    enable_units cockpit.socket
  fi
fi

if step ssh; then
  write_file /etc/ssh/sshd_config.d/10-keys-only.conf 0644 <<'EOT'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOT
  if [ "$changed" = 1 ]; then run sshd -t; run systemctl reload ssh; fi
  enable_units fail2ban sysstat pmcd pmlogger $services
  if ! ufw status 2>/dev/null | grep -q 'Status: active'; then
    run ufw default deny incoming
    run ufw default allow outgoing
    run ufw allow OpenSSH
    run ufw --force enable
  fi
fi

if step ports; then
  for n in "${slots[@]}"; do
    if [ "$dry" = 1 ] && [ ! -d "/home/ci$n/runner" ]; then echo "provision.sh: would write /home/ci$n/runner/.env"; note_change; continue; fi
    write_file "/home/ci$n/runner/.env" 0644 < <(cis_runner_env "$n")
    [ "$dry" = 1 ] || [ "$changed" = 0 ] || chown "ci$n:ci$n" "/home/ci$n/runner/.env"
    write_file "/home/ci$n/runner/.path" 0644 <<<'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin'
    [ "$dry" = 1 ] || [ "$changed" = 0 ] || chown "ci$n:ci$n" "/home/ci$n/runner/.path"
  done
fi

register_one() {
  local n=$1 user=ci$1 home=/home/ci$1 dir=/home/ci$1/runner name=$name_prefix-$1 url=https://github.com/${r_repo[$1]} unit
  unit=$(cis_unit_name "$n")
  as_user() { runuser -u "$user" -- env HOME="$home" "$@"; }
  mountpoint -q "$dir/_work" || fail "step register: $dir/_work is not mounted. Run provision.sh without --skip mounts, then check: findmnt $dir/_work"
  [ -f "$tarball" ] || fail "step register: $tarball is missing. Run provision.sh without --skip runner-download."
  if [ ! -x "$dir/config.sh" ]; then
    as_user tar -xzf "$tarball" -C "$dir" || fail "step register: could not unpack $tarball into $dir."
  fi
  if in_reregister "$n"; then
    if [ -f "/etc/systemd/system/$unit" ]; then run systemctl stop "$unit"; fi
    rm -f "$dir/.runner" "$dir/.credentials" "$dir/.credentials_rsaparams"
    echo "provision.sh: removed the local registration of $name; the runner record in GitHub is replaced by the new one."
  fi
  if ! registered "$n"; then
    (cd "$dir" && printf '%s\n' "${token_of[${r_repo[$n]}]}" | as_user bash -c 'IFS= read -r t; exec ./config.sh --unattended --replace --url "$1" --token "$t" --name "$2" --labels "$3" --work _work' _ "$url" "$name" "${r_labels[$n]}") \
      || fail "step register: config.sh failed for $name (its output is above). A token older than an hour must be made again."
  fi
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    (cd "$dir" && ./svc.sh install "$user") || fail "step register: svc.sh install failed for $name (its output is above)."
  fi
  run systemctl start "$unit"
  systemctl is-active --quiet "$unit" || fail "step register: $unit did not start. Check: journalctl -u $unit -n 50 --no-pager"
  echo "provision.sh: $name runs as $unit with labels ${r_labels[$n]}."
}

if step register; then
  if [ "$register" = 0 ]; then
    echo "provision.sh: not registering (no --register)."
  else
    for n in "${slots[@]}"; do
      if registered "$n" && ! in_reregister "$n" && systemctl is-active --quiet "$(cis_unit_name "$n")" 2>/dev/null; then echo "provision.sh: $name_prefix-$n is registered and running."; continue; fi
      if [ "$dry" = 1 ]; then echo "provision.sh: would register $name_prefix-$n to https://github.com/${r_repo[$n]} with labels ${r_labels[$n]}"; note_change; continue; fi
      register_one "$n"
    done
  fi
fi

if step sweeps; then
  reload=0
  if [ "${#sweep_repos[@]}" -gt 0 ]; then
    globs=$(cis_sweep_unit_globs)
    read -r -a glob_list <<<"$globs"
    err_file=$(mktemp)
    rc=0
    listed=$(systemctl list-unit-files --plain --no-legend "${glob_list[@]}" 2>"$err_file") || rc=$?
    listing_err=$(cat "$err_file"); rm -f "$err_file"
    [ "$rc" = 0 ] || [ -z "$listing_err" ] || fail "step sweeps: systemctl list-unit-files $globs exited with code $rc: $listing_err"
    units=$(awk '{print $1}' <<<"$listed")
    if [ -z "$units" ]; then
      echo "provision.sh: no runner unit of ${sweep_repos[*]} exists yet; run provision.sh again after --register to add the recovery drop-ins."
    fi
    for unit in $units; do
      write_file "/etc/systemd/system/$unit.d/10-ci-recovery.conf" 0644 <"$here/units/ci-runner-recovery.conf"
      [ "$changed" = 0 ] || reload=1
    done
    install_script runner-sweep.sh "$libexec/runner-sweep"
    write_file /etc/systemd/system/ci-runner-sweep.service 0644 <<EOT
[Unit]
Description=End processes that finished jobs left in the runners' cgroups

[Service]
Type=oneshot
ExecStart=$libexec/runner-sweep --units '$globs'
EOT
    [ "$changed" = 0 ] || reload=1
    write_file /etc/systemd/system/ci-runner-sweep.timer 0644 <"$here/units/ci-runner-sweep.timer"
    [ "$changed" = 0 ] || reload=1
    timers=(ci-runner-sweep.timer)
  else
    timers=()
  fi
  if [ "${#docker_sweep_projects[@]}${#docker_sweep_containers[@]}${#docker_sweep_images[@]}" != 000 ]; then
    install_script docker-sweep.sh "$libexec/docker-sweep"
    write_file "$etc_dir/docker-sweep.conf" 0644 < <(cis_docker_sweep_conf)
    write_file /etc/systemd/system/ci-docker-sweep.service 0644 <"$here/units/ci-docker-sweep.service"
    [ "$changed" = 0 ] || reload=1
    write_file /etc/systemd/system/ci-docker-sweep.timer 0644 <"$here/units/ci-docker-sweep.timer"
    [ "$changed" = 0 ] || reload=1
    timers+=(ci-docker-sweep.timer)
  fi
  if [ "${#images[@]}" -gt 0 ]; then
    install_script docker-prepull.sh "$libexec/docker-prepull"
    write_file "$etc_dir/images.txt" 0644 < <(printf '%s\n' "${images[@]}")
    write_file /etc/systemd/system/ci-docker-prepull.service 0644 <"$here/units/ci-docker-prepull.service"
    [ "$changed" = 0 ] || reload=1
    write_file /etc/systemd/system/ci-docker-prepull.timer 0644 <"$here/units/ci-docker-prepull.timer"
    [ "$changed" = 0 ] || reload=1
    timers+=(ci-docker-prepull.timer)
  fi
  [ "$reload" = 0 ] || run systemctl daemon-reload
  [ "${#timers[@]}" = 0 ] || enable_units "${timers[@]}"
  [ "${#timers[@]}" -gt 0 ] || echo "provision.sh: the config names no sweep_repo, docker_sweep rule or image; no sweep or pre-pull is installed."
fi

echo "provision.sh: done, $changes change(s)$([ "$dry" = 1 ] && echo ' that --dry-run would make')."
[ "$register" = 1 ] || echo "provision.sh: next, register the runners with --register, then run verify-server.sh."
