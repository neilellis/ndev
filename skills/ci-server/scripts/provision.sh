#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
. "$here/config.sh"

usage="Usage: provision.sh --config <file> [--plan | --dry-run] [--register] [--skip STEP[,STEP]] [--cpus N] [--mem-gb N] [--allow-oversubscribed]

  --config FILE          the server's runners, sizes, ports, packages and sweeps ($config_example)
  --plan                 print every step and the values it would use; read nothing on the host, change nothing
  --dry-run              run the checks and print each change that would be made; change nothing
  --register             register the runners; reads one 'owner/repo token' line per repository from standard input
  --skip STEP[,STEP]     leave steps out (--plan prints their names)
  --cpus N, --mem-gb N   override the detected CPUs and memory for the sizing rule
  --allow-oversubscribed go on when the sizing rule is broken"

all_steps="sizing base sources packages kernel swap docker users mounts runner-download cockpit ssh ports register sweeps"
libexec=/usr/local/libexec/ci-server
share=/usr/local/share/ci-server
mode=apply register=0 allow_over=0 config_arg="" skip="" cpus_override="" mem_override=""

fail() { echo "provision.sh: $1" >&2; exit 1; }
usage_fail() { echo "provision.sh: $1" >&2; echo "$usage" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config|--skip|--cpus|--mem-gb)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value."
      case "$1" in
        --config) config_arg=$2 ;;
        --skip) skip=$2 ;;
        --cpus) count_ok "$2" || usage_fail "--cpus must be a whole number; got '$2'."; cpus_override=$2 ;;
        --mem-gb) count_ok "$2" || usage_fail "--mem-gb must be a whole number; got '$2'."; mem_override=$2 ;;
      esac
      shift 2 ;;
    --register) register=1; shift ;;
    --allow-oversubscribed) allow_over=1; shift ;;
    --plan) mode=plan; shift ;;
    --dry-run) mode=dryrun; shift ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *) usage_fail "unknown argument: $1." ;;
  esac
done
[ -n "$config_arg" ] || usage_fail "give --config <file>."
for s in ${skip//,/ }; do
  case " $all_steps " in *" $s "*) ;; *) usage_fail "--skip names '$s', which is not a step. The steps are: $all_steps." ;; esac
done
load_config "$config_arg"

step_enabled() { case ",$skip," in *",$1,"*) return 1 ;; esac; return 0; }
env_list() {
  [ "${#env_names[@]}" -gt 0 ] || return 0
  local IFS=,
  echo " and ${env_names[*]}"
}
images_file() { echo "$share/$prepull_images"; }

runner_sweep_units() {
  local repo globs=""
  for repo in ${sweep_repos//,/ }; do globs="$globs actions.runner.${repo/\//-}.$name_prefix-*.service"; done
  echo "${globs# }"
}

sweeps_summary() {
  local parts=""
  [ -z "$sweep_repos" ] || parts="$unit_prefix-runner-sweep.timer (every 5 minutes) and the recovery drop-in for the runners of $sweep_repos"
  [ "$docker_sweep_on" = 0 ] || parts="${parts:+$parts; }$unit_prefix-docker-sweep.timer (hourly, Docker leftovers older than $docker_sweep_min_age seconds that the docker_sweep_* fields of the config match)"
  [ -z "$prepull_images" ] || parts="${parts:+$parts; }$unit_prefix-docker-prepull.timer (pulls the images in $prepull_images after each boot and each day)"
  if [ -z "$parts" ]; then echo "nothing to install: the config sets no sweep_repos, docker_sweep_* field or prepull_images"; else echo "write where they differ and enable: $parts"; fi
}

if [ "$mode" = plan ]; then
  echo "provision.sh plan for $config_file: $runner_count runners, name prefix $name_prefix, port base $port_base, swap file $swap_size if the host has no swap"
  for n in "${slots[@]}"; do
    base=$((port_base + 100 * n))
    echo "  runner $name_prefix-$n: user ci$n, repository ${r_repo[$n]}, labels ${r_labels[$n]}, ports $base-$((base + 99)), _work tmpfs ${r_work[$n]}, tmp tmpfs ${r_tmp[$n]}, unit $(unit_name "$n")"
  done
  describe() {
    case "$1" in
      sizing) echo "check the runner count against the CPUs and memory ($(sizing_rule))" ;;
      base) echo "set the time zone to $timezone, the locale to en_US.UTF-8, the apt lock timeout and unattended upgrades" ;;
      sources) echo "add the apt sources docker${apt_sources:+,$apt_sources}" ;;
      packages)
        extra=""
        [ -z "$packages" ] || extra=", and the packages of the config: $packages"
        [ -z "$services" ] || extra="$extra; enable the services $services"
        echo "install Docker, git, jq, curl, sysstat, pcp, Cockpit, fail2ban, ufw and unattended-upgrades$extra" ;;
      kernel) echo "write /etc/sysctl.d/60-ci-server.conf (inotify limits, vm.max_map_count, vm.swappiness=10); no ulimit overrides" ;;
      swap) echo "keep the swap partition the installer made; make a $swap_size /swapfile only if no swap is active" ;;
      docker) echo "write /etc/docker/daemon.json (publish container ports on 127.0.0.1 only, because ufw does not filter the ports Docker publishes; 3 x 20 MB logs, builder cache capped), enable docker, add the weekly prune" ;;
      users) echo "make users ci<slot> (uid 999+slot) in the docker group with sudo for apt-get and ss, and their runner, _work, tmp and toolcache folders" ;;
      mounts) echo "add the _work and tmp tmpfs lines to /etc/fstab and mount them" ;;
      runner-download) echo "download Actions runner $runner_version to /opt and check its sha256" ;;
      cockpit) echo "make the admin user (no password), bind Cockpit to 127.0.0.1:9090, keep root out of Cockpit, enable pmcd, pmlogger and sysstat with its collection timers so sar keeps history" ;;
      ssh) echo "SSH keys only, enable fail2ban, ufw lets in SSH only" ;;
      ports) echo "write /home/ci<slot>/runner/.env: CI_PORT_BASE, TMPDIR, RUNNER_TOOL_CACHE$(env_list)" ;;
      register) echo "register each runner with register-runner.sh and install its systemd service (needs --register and a token per repository on standard input; tokens are never stored)" ;;
      sweeps) sweeps_summary ;;
    esac
  }
  i=0
  for s in $all_steps; do
    i=$((i + 1))
    if step_enabled "$s"; then echo "  step $i $s: $(describe "$s")"; else echo "  step $i $s: skipped by --skip"; fi
  done
  exit 0
fi

dry=0
[ "$mode" = dryrun ] && dry=1
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
step() {
  current_step=$1
  if step_enabled "$1"; then echo "provision.sh: step $1"; return 0; fi
  echo "provision.sh: step $1 skipped by --skip"
  return 1
}
retire_timer() {
  local unit=$unit_prefix-$1
  [ -e "/etc/systemd/system/$unit.timer" ] || return 0
  echo "provision.sh: the config no longer asks for $unit.timer, so it $([ "$dry" = 1 ] && echo 'would be' || echo 'is') turned off and its units removed."
  run systemctl disable --now "$unit.timer"
  run rm -f "/etc/systemd/system/$unit.timer" "/etc/systemd/system/$unit.service"
  retired=1
}
registered() {
  local file=/home/ci$1/runner/.runner
  [ -f "$file" ] && grep -qF "\"agentName\": \"$name_prefix-$1\"," "$file" && grep -qF "\"gitHubUrl\": \"https://github.com/${r_repo[$1]}\"," "$file"
}

[ "$dry" = 1 ] || [ "$(id -u)" = 0 ] || fail "run as root."
[ -r /etc/os-release ] || fail "cannot read /etc/os-release, so the system is not known. This script sets up Ubuntu 24.04."
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || fail "this script sets up Ubuntu 24.04, not ${PRETTY_NAME:-an unknown system}."
export DEBIAN_FRONTEND=noninteractive
if step_enabled runner-download; then
  host_arch=$(uname -m)
  [ "$host_arch" = x86_64 ] || fail "this host is $host_arch; the pinned Actions runner $runner_version is for x86_64 (linux-x64). Provision an x86_64 host. Nothing was changed."
fi

token_repos=()
token_values=()
token_of() {
  local i=0
  while [ "$i" -lt "${#token_repos[@]}" ]; do
    [ "${token_repos[$i]}" != "$1" ] || { echo "${token_values[$i]}"; return 0; }
    i=$((i + 1))
  done
  return 0
}
if [ "$register" = 1 ] && step_enabled register; then
  if [ "$dry" = 0 ]; then
    if [ -t 0 ]; then fail "--register reads one '<owner>/<repo> <token>' line per repository from standard input, and standard input is a terminal. Pipe the lines in, as step 5 of the ci-server skill shows."; fi
    while read -r repo_name token_value _; do
      [ -n "${repo_name:-}" ] || continue
      known=0
      for n in "${slots[@]}"; do [ "${r_repo[$n]}" != "$repo_name" ] || known=1; done
      [ "$known" = 1 ] || fail "standard input has a token for $repo_name, which no runner line of $config_file has. Send one '<owner>/<repo> <token>' line for each repository of the runner lines. Nothing was changed."
      token_repos+=("$repo_name")
      token_values+=("${token_value:-}")
    done
  fi
  for n in "${slots[@]}"; do
    if [ "$dry" = 0 ] && ! registered "$n" && [ -z "$(token_of "${r_repo[$n]}")" ]; then
      fail "no registration token for ${r_repo[$n]} on standard input, and $name_prefix-$n is not registered. Make one with: gh api -X POST repos/${r_repo[$n]}/actions/runners/registration-token -q .token and send the line '${r_repo[$n]} <token>'. Nothing was changed."
    fi
  done
fi

if step sizing; then
  host_size
  problems=$(sizing_problems "$cpus" "$mem_gb")
  if [ -n "$problems" ]; then
    if [ "$allow_over" = 1 ]; then
      echo "provision.sh: warning, the sizing rule is broken and --allow-oversubscribed goes on anyway:"
      echo "$problems"
    else
      fail "step sizing: the plan does not fit the host ($cpus CPUs, $mem_gb GB). $problems Give fewer runners or fewer heavy labels in $config_file, or pass --allow-oversubscribed to accept the risk. The runner count and labels are the owner's decision. Nothing was changed."
    fi
  else
    echo "provision.sh: $(sizing_fit "$cpus" "$mem_gb")"
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
  arch=$(dpkg --print-architecture)
  add_source() {
    local list=$1 key=$2 url=$3 dearmor=$4 line=$5
    if [ ! -s "$key" ]; then
      need_update=1
      if [ "$dearmor" = 1 ]; then run bash -c "set -o pipefail; curl -fsSL '$url' | gpg --dearmor -o '$key'"; else run curl -fsSL "$url" -o "$key"; fi
      [ "$dry" = 1 ] || chmod a+r "$key"
    fi
    write_file "/etc/apt/sources.list.d/$list.list" 0644 <<<"$line"
    [ "$changed" = 0 ] || need_update=1
  }
  add_source docker /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg 0 \
    "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable"
  for source in ${apt_sources//,/ }; do
    case "$source" in
      github-cli) add_source github-cli /etc/apt/keyrings/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg 0 \
        "deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" ;;
      google-chrome) add_source google-chrome /etc/apt/keyrings/google-chrome.gpg https://dl.google.com/linux/linux_signing_key.pub 1 \
        "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" ;;
      nodesource-22) add_source nodesource /etc/apt/keyrings/nodesource.gpg https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key 1 \
        "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" ;;
    esac
  done
  [ "$need_update" = 0 ] || run apt-get update -q
fi

if step packages; then
  wanted=(
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
    git jq curl sysstat pcp python3-pcp fail2ban ufw unattended-upgrades
    cockpit cockpit-networkmanager cockpit-packagekit cockpit-storaged
  )
  for p in $packages; do wanted+=("$p"); done
  missing=()
  for p in "${wanted[@]}"; do
    dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing+=("$p")
  done
  if [ "${#missing[@]}" -gt 0 ]; then run apt-get install -y -q "${missing[@]}"; fi
  for u in $services; do
    systemctl is-enabled --quiet "$u" 2>/dev/null || run systemctl enable --now "$u"
  done
fi

if step kernel; then
  write_file /etc/sysctl.d/60-ci-server.conf 0644 <<'EOT'
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
vm.max_map_count = 1048576
vm.swappiness = 10
EOT
  [ "$changed" = 0 ] || run sysctl --system
fi

if step swap; then
  swaps=$(swapon --show --noheadings) || fail "step swap: swapon --show failed with exit code $?. Check: swapon --show"
  if [ -n "$swaps" ]; then
    echo "provision.sh: swap is already active; none is added."
  elif [ "$dry" = 1 ]; then
    echo "provision.sh: would make /swapfile of $swap_size and add it to /etc/fstab"
    note_change
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
  "ip": "127.0.0.1",
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
    write_file "/etc/sudoers.d/$user" 0440 <<<"$user ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/ss"
    if [ "$dry" = 0 ]; then
      visudo -cf "/etc/sudoers.d/$user" >/dev/null || fail "step users: /etc/sudoers.d/$user does not parse. Fix it with: visudo -f /etc/sudoers.d/$user"
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
    uid=$(id -u "$user" 2>/dev/null || echo $((999 + n)))
    gid=$(id -g "$user" 2>/dev/null || echo "$uid")
    for line in \
      "tmpfs /home/$user/runner/_work tmpfs size=${r_work[$n]},mode=0755,uid=$uid,gid=$gid,nosuid,nodev 0 0" \
      "tmpfs /home/$user/tmp tmpfs size=${r_tmp[$n]},mode=0700,uid=$uid,gid=$gid,nosuid,nodev 0 0"; do
      if ! grep -qxF "$line" /etc/fstab; then
        mount_point=${line#tmpfs }
        mount_point=${mount_point%% *}
        old=$(grep "^tmpfs $mount_point tmpfs " /etc/fstab || true)
        if [ -n "$old" ]; then
          old_size=$(grep -o 'size=[^,]*' <<<"$old" | head -n1)
          new_size=$(grep -o 'size=[^,]*' <<<"$line")
          fail "step mounts: slot $n has $mount_point at ${old_size:-no size} in /etc/fstab, and the config asks for $new_size. The line is: $old. Edit it by hand (remounting a tmpfs loses what it holds; stop $(unit_name "$n") first), then run provision.sh again."
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

if step runner-download; then
  tarball=/opt/actions-runner-linux-x64.tar.gz
  if ! echo "$runner_sha256  $tarball" | sha256sum -c --status 2>/dev/null; then
    run curl -fsSL -o "$tarball.part" "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz"
    if [ "$dry" = 0 ]; then
      echo "$runner_sha256  $tarball.part" | sha256sum -c --status || { rm -f "$tarball.part"; fail "step runner-download: the runner tarball does not match sha256 $runner_sha256. Check the release page of actions/runner v$runner_version, and set runner_version and runner_sha256 in $config_file."; }
      mv "$tarball.part" "$tarball"
    fi
  fi
fi

if step cockpit; then
  id admin >/dev/null 2>&1 || run useradd --create-home --shell /bin/bash --groups sudo admin
  write_file /etc/sudoers.d/admin 0440 <<'EOT'
admin ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg, /usr/bin/snap
EOT
  if [ "$dry" = 0 ]; then
    visudo -cf /etc/sudoers.d/admin >/dev/null || fail "step cockpit: /etc/sudoers.d/admin does not parse. Fix it with: visudo -f /etc/sudoers.d/admin"
  fi
  write_file /etc/systemd/system/cockpit.socket.d/listen.conf 0644 <<'EOT'
[Socket]
ListenStream=
ListenStream=127.0.0.1:9090
EOT
  [ "$changed" = 0 ] || run systemctl daemon-reload
  write_file /etc/cockpit/disallowed-users 0644 <<<"root"
  write_file /etc/default/sysstat 0644 <<<'ENABLED="true"'
  for u in cockpit.socket pmcd pmlogger sysstat sysstat-collect.timer sysstat-summary.timer; do
    systemctl is-enabled --quiet "$u" 2>/dev/null || run systemctl enable --now "$u"
  done
fi

if step ssh; then
  write_file /etc/ssh/sshd_config.d/10-keys-only.conf 0644 <<'EOT'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOT
  if [ "$changed" = 1 ]; then run sshd -t; run systemctl reload ssh; fi
  systemctl is-enabled --quiet fail2ban 2>/dev/null || run systemctl enable --now fail2ban
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
    env_text=$(runner_env "$n")
    write_file "/home/ci$n/runner/.env" 0644 <<<"$env_text"
    [ "$dry" = 1 ] || [ "$changed" = 0 ] || chown "ci$n:ci$n" "/home/ci$n/runner/.env"
  done
fi

if step register; then
  if [ "$register" = 0 ]; then
    echo "provision.sh: not registering (no --register). Register the runners later with provision.sh --register or register-runner.sh."
  else
    for n in "${slots[@]}"; do
      if registered "$n" && systemctl is-active --quiet "$(unit_name "$n")" 2>/dev/null; then echo "provision.sh: $name_prefix-$n is registered and running."; continue; fi
      if [ "$dry" = 1 ]; then echo "provision.sh: would register $name_prefix-$n to https://github.com/${r_repo[$n]} with labels ${r_labels[$n]}"; note_change; continue; fi
      token_of "${r_repo[$n]}" | bash "$here/register-runner.sh" --config "$config_file" "$n" \
        || fail "step register: register-runner.sh failed for $name_prefix-$n (output above). A token older than an hour must be made again."
      note_change
    done
  fi
fi

if step sweeps; then
  if [ -z "$sweep_repos" ] && [ "$docker_sweep_on" = 0 ] && [ -z "$prepull_images" ]; then
    echo "provision.sh: $(sweeps_summary)."
  else
    reload=0
    timers=()
    write_file "$libexec/config.sh" 0644 <"$here/config.sh"
    if [ -n "$sweep_repos" ]; then
      write_file "$libexec/runner-sweep.sh" 0755 <"$here/runner-sweep.sh"
      for n in "${slots[@]}"; do
        is_sweep_repo "${r_repo[$n]}" || continue
        write_file "/etc/systemd/system/$(unit_name "$n").d/10-$unit_prefix-recovery.conf" 0644 <<'EOT'
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
OOMPolicy=continue
Restart=on-failure
RestartSec=30
KillMode=control-group
EOT
        [ "$changed" = 0 ] || reload=1
      done
      write_file "/etc/systemd/system/$unit_prefix-runner-sweep.service" 0644 <<EOT
[Unit]
Description=End processes that finished jobs left in the runners' cgroups

[Service]
Type=oneshot
ExecStart=$libexec/runner-sweep.sh --units '$(runner_sweep_units)'
EOT
      [ "$changed" = 0 ] || reload=1
      write_file "/etc/systemd/system/$unit_prefix-runner-sweep.timer" 0644 <<EOT
[Unit]
Description=Sweep the runners' cgroups every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=$unit_prefix-runner-sweep.service

[Install]
WantedBy=timers.target
EOT
      [ "$changed" = 0 ] || reload=1
      sweep_registered=0
      for n in "${slots[@]}"; do
        if is_sweep_repo "${r_repo[$n]}" && registered "$n"; then sweep_registered=1; fi
      done
      if [ "$sweep_registered" = 1 ]; then
        timers+=("$unit_prefix-runner-sweep.timer")
      else
        echo "provision.sh: $unit_prefix-runner-sweep.timer is not enabled yet: no runner of $sweep_repos is registered. Run provision.sh again after --register."
      fi
    fi
    if [ "$docker_sweep_on" = 1 ] || [ -n "$prepull_images" ]; then
      write_file "$share/ci-server.conf" 0644 <"$config_file"
      [ -z "$prepull_images" ] || write_file "$(images_file)" 0644 <"$config_dir/$prepull_images"
    fi
    if [ "$docker_sweep_on" = 1 ]; then
      write_file "$libexec/docker-sweep.sh" 0755 <"$here/docker-sweep.sh"
      write_file "/etc/systemd/system/$unit_prefix-docker-sweep.service" 0644 <<EOT
[Unit]
Description=Remove the Docker containers, volumes, networks and images that finished jobs left behind
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$libexec/docker-sweep.sh --config $share/ci-server.conf
EOT
      [ "$changed" = 0 ] || reload=1
      write_file "/etc/systemd/system/$unit_prefix-docker-sweep.timer" 0644 <<EOT
[Unit]
Description=Sweep the Docker leftovers of the CI jobs every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min
Persistent=true
Unit=$unit_prefix-docker-sweep.service

[Install]
WantedBy=timers.target
EOT
      [ "$changed" = 0 ] || reload=1
      timers+=("$unit_prefix-docker-sweep.timer")
    fi
    if [ -n "$prepull_images" ]; then
      write_file "$libexec/docker-prepull.sh" 0755 <"$here/docker-prepull.sh"
      write_file "/etc/systemd/system/$unit_prefix-docker-prepull.service" 0644 <<EOT
[Unit]
Description=Pull the Docker images the CI jobs pin, so no job waits on a pull
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$libexec/docker-prepull.sh $(images_file)
EOT
      [ "$changed" = 0 ] || reload=1
      write_file "/etc/systemd/system/$unit_prefix-docker-prepull.timer" 0644 <<EOT
[Unit]
Description=Pull the pinned CI images after each boot and each day, after the weekly prune

[Timer]
OnBootSec=2min
OnCalendar=*-*-* 08:00
Persistent=true
Unit=$unit_prefix-docker-prepull.service

[Install]
WantedBy=timers.target
EOT
      [ "$changed" = 0 ] || reload=1
      timers+=("$unit_prefix-docker-prepull.timer")
    fi
    [ "$reload" = 0 ] || run systemctl daemon-reload
    for t in ${timers[@]+"${timers[@]}"}; do
      systemctl is-enabled --quiet "$t" 2>/dev/null || run systemctl enable --now "$t"
    done
  fi
  retired=0
  [ -n "$sweep_repos" ] || retire_timer runner-sweep
  [ "$docker_sweep_on" = 1 ] || retire_timer docker-sweep
  [ -n "$prepull_images" ] || retire_timer docker-prepull
  [ "$retired" = 0 ] || run systemctl daemon-reload
fi

echo "provision.sh: done, $changes change(s)$([ "$dry" = 1 ] && echo ' that --dry-run would make')."
[ "$register" = 1 ] || echo "provision.sh: next, register the runners with --register (tokens on standard input), then run verify-server.sh."
