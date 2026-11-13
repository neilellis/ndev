#!/usr/bin/env bash
# Puts a Hetzner floating IPv4 on eth0 of a server, now and after every restart. hooks/remote-host.ts sends it to
# `floating=<floating IPv4> bash -s` as root over SSH. It never runs on a desktop. It is safe to run again: it adds the
# address only when eth0 does not hold it, and writes the file only when it differs.
# By hand, the address is set with: ip addr add <floating ip> dev eth0   (that alone does not survive a restart).
# The persistent form is the one Hetzner documents for Ubuntu with netplan
# (https://docs.hetzner.com/cloud/floating-ips/persistent-configuration/): /etc/netplan/60-floating-ip.yaml.
set -euo pipefail
: "${floating:?floating (the floating IPv4) is not set}"
dev=eth0
# The output is read whole and then matched: a pipe into grep -q can end ip early, which pipefail reads as a failure.
has() { case "$(ip -4 -o addr show dev "$dev")" in *"inet $floating/"*) return 0 ;; *) return 1 ;; esac; }

ip -o link show "$dev" >/dev/null 2>&1 || { echo "this server has no interface $dev (it has: $(ip -o link show | awk -F': ' '{print $2}' | tr '\n' ' ')), so $floating was not set" >&2; exit 1; }
if has; then
  echo "$dev already holds $floating"
else
  ip addr add "$floating" dev "$dev"
  echo "added $floating to $dev"
fi

file=/etc/netplan/60-floating-ip.yaml
want="$(printf 'network:\n   version: 2\n   renderer: networkd\n   ethernets:\n     %s:\n       addresses:\n       - %s/32' "$dev" "$floating")"
if [ "$(cat "$file" 2>/dev/null || true)" != "$want" ]; then
  printf '%s\n' "$want" > "$file"
  chmod 600 "$file"
  netplan generate
  echo "wrote $file"
fi
has || { echo "$dev does not hold $floating: $(ip -4 -o addr show dev "$dev" | tr '\n' ' ')" >&2; exit 1; }
