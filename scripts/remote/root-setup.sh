#!/usr/bin/env bash
# The first build of a server that /dev remote create made from the base image. hooks/remote-host.ts sends it to
# `u=<user> bash -s` as root over SSH; floating-ip.sh then sets the floating address. It never runs on a desktop. It is safe to run again.
# stdout carries one line only: the server's new ed25519 host key. Everything else goes to stderr.
set -euo pipefail
exec 3>&1 1>&2
: "${u:?u (the workspace user) is not set}"

export DEBIAN_FRONTEND=noninteractive
# The daily apt job often holds the package lists just after the first boot, and the lock timeout does not cover them.
tries=0
until apt-get -o DPkg::Lock::Timeout=600 -qq update; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || { echo "apt-get update failed 30 times" >&2; exit 1; }
  sleep 10
done
apt-get -o DPkg::Lock::Timeout=600 -qq -y install \
  docker.io docker-buildx docker-compose-v2 git gh curl ca-certificates build-essential unzip jq xz-utils unattended-upgrades

# Container logs capped at 3 x 20 MB.
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "20m", "max-file": "3" }\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades >/dev/null

# sshd takes the first value it reads, so this file's name sorts before cloud-init's. The settings are checked now,
# before the host keys change: a failure here leaves the keys as they were.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-ndev-remote.conf
sshd -t
got="$(sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication) ' | tr '\n' ' ')"
[ "$got" = "passwordauthentication no kbdinteractiveauthentication no " ] || { echo "password sign-in would still be on: $got" >&2; exit 1; }

# A server restored from a snapshot of this one is a new instance to cloud-init, which by default deletes the SSH host
# keys and makes new ones. Keep them: the floating address must present the key the desktop already trusts.
printf 'ssh_deletekeys: false\nssh_genkeytypes: [ed25519]\n' > /etc/cloud/cloud.cfg.d/99-ndev-keep-host-keys.cfg

# New host keys: the first-boot key is readable in the user data by every user of this server. The key is made beside
# the old one and moved into place; the running sshd keeps the old key until it is reloaded, which the desktop does
# only after it has recorded the new one. The public key is printed on every run.
if [ ! -f /etc/ssh/.ndev-host-keys-made ]; then
  rm -f /etc/ssh/ssh_host_ed25519_key.new /etc/ssh/ssh_host_ed25519_key.new.pub
  ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key.new
  rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub
  mv /etc/ssh/ssh_host_ed25519_key.new.pub /etc/ssh/ssh_host_ed25519_key.pub
  mv /etc/ssh/ssh_host_ed25519_key.new /etc/ssh/ssh_host_ed25519_key
  touch /etc/ssh/.ndev-host-keys-made
fi

# The workspace user: in the docker group, with root's authorized keys.
id "$u" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$u"
usermod -aG docker "$u"
install -d -m 700 -o "$u" -g "$u" "/home/$u/.ssh"
[ -f "/home/$u/.ssh/authorized_keys" ] || install -m 600 -o "$u" -g "$u" /root/.ssh/authorized_keys "/home/$u/.ssh/authorized_keys"

awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub >&3
