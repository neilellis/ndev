---
name: ci-server
description: "Set up, change and repair a server of self-hosted GitHub Actions runners. Use for a new build server, a runner migration to another server, adding or removing runners, runners that are offline, a growing queue of runs, or slow or hanging CI jobs. Bundles provision, sizing and verify scripts for Ubuntu 24.04."
---

# CI server

The scripts are in this skill's `scripts/` folder. They take the project's layout from a config file. `references/config.md` gives each key. `examples/fcc-ssd-build.conf` is one worked example (two repositories, six runners), not a default.

| Script | What it does |
|---|---|
| `provision.sh --config <file>` | Sets up a fresh Ubuntu 24.04 host as root, and registers the runners. Safe to run again. |
| `sizing.sh --config <file>` | Checks the runner plan against the CPUs and memory. Exit 1 when the plan does not fit. |
| `verify-server.sh --config <file>` | Prints one `PASS` or `FAIL` line for each host check (`--only host`, as root) and API check (`--only api`, where `gh` is signed in). |
| `runner-sweep.sh`, `docker-sweep.sh`, `docker-prepull.sh` | Installed by `provision.sh` with systemd timers. They remove the processes and Docker objects that finished jobs leave, and pull the pinned images. |

The owner of the repositories decides the runner count and the labels. Never add, remove, relabel or deregister a runner, and never cancel a server, without their go. When one server runs runners for another project, that project's owner decides about those runners.

## When to use it

- **New build server, or a migration to one:** size it, then follow [Migration order](#migration-order).
- **Add or remove runners:** change the `runner=` lines with the owner's agreement, run `sizing.sh`, then `provision.sh --register`.
- **Runners offline, a queued backlog, slow or hanging jobs:** [Diagnose](#diagnose), then [Restart or register again](#restart-or-register-again).

## Size the server first

`sizing.sh`, `provision.sh` and `verify-server.sh` apply one rule. A heavy runner is a runner with the `heavy_label` label (default `supabase`), which starts a full local stack for each job.

| Rule | Why |
|---|---|
| At most one heavy runner for each 4 CPUs | A Supabase job starts about ten containers, and its tests start up to 8 workers. |
| At most one runner for each 2 CPUs | A runner with no heavy label still runs builds and tests. |
| At least 8 GB of memory for each runner | The runner units set no memory limit. |

On 2026-11-24 a host with 16 CPUs and 64 GB ran six runners, all with `supabase`. The load average reached 58, CPU pressure was near 80% and swap was full. Test files that take 28 seconds alone hit their 120 second timeout. Disk I/O pressure stayed near 0.1% on NVMe. Under the rule, 16 CPUs carry four heavy runners. Measure CPU first when jobs are slow. Docker volumes in RAM (a tmpfs on `/var/lib/docker/volumes`) gave no useful gain on the NVMe host. The scripts do not set them up.

`provision.sh` refuses a plan that breaks the rule and stops before it changes anything. `--allow-oversubscribed` goes on with a warning. Use it only when the owner chose the layout.

## Set up a host

### 1. Steps by hand

The scripts cannot do these steps:

1. Order the server. Choose rescue mode, and add your SSH public key to the order. At Hetzner, the Robot page of the account that pays.
2. Boot the rescue system and connect with `ssh root@<ip>`. Compare the host key with the one the provider shows.
3. Install Ubuntu 24.04. At Hetzner, run `installimage` with a config file (for two NVMe drives: `SWRAID 1`, `SWRAIDLEVEL 1`, `/boot` 1G, swap 16G, `/` all). Check the drive names with `lsblk` first.
4. Before the reboot, read the new host keys from the installed disk. Compare them on the first connection. A RAID 1 resync runs for about an hour after the reboot; jobs can run during it.

### 2. Provision

Copy this skill's `scripts/` folder and the project's config to the host, for example to `/opt/ci-server/`. Then, as root:

```bash
bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/<project>.conf --plan
bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/<project>.conf --dry-run
bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/<project>.conf
```

- `--plan` prints every step and each runner's user, ports, tmpfs sizes and unit. It reads nothing and changes nothing.
- `--dry-run` runs the checks and prints each change: `would write`, `would add to /etc/fstab`, `would run`.
- A real run changes only what differs. A second run ends with `done, 0 change(s)`. At the first failure it stops and prints the step, the command, its exit code and the command's output. Fix the cause and run it again.

Each runner gets user `ci<slot>` (uid 999 + slot), the name `<name_prefix>-<slot>`, ports `port_base + 100 × slot` to `+ 99`, and tmpfs mounts for `_work` and `TMPDIR`. `/home/ci<slot>/runner/.env` gives jobs `CI_PORT_BASE`, `CI_RUNNER_SLOT`, `TMPDIR`, `RUNNER_TOOL_CACHE`, and with `supabase=yes` the `SUPABASE_*_PORT` values and `SUPABASE_PROJECT_ID_SUFFIX=-ci<slot>`. The project's workflows must read these values to keep parallel stacks apart. `--skip <step>[,<step>]` leaves steps out.

### 3. Register the runners

A person who administers each repository makes a registration token. A token lasts one hour. Send one `<owner>/<repo> <token>` line for each repository on standard input. The tokens never go into a file:

```bash
{ echo "acme/app $(gh api -X POST repos/acme/app/actions/runners/registration-token -q .token)"
  echo "acme/data $(gh api -X POST repos/acme/data/actions/runners/registration-token -q .token)"; } \
  | ssh root@<host> 'bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/<project>.conf --register'
```

A runner that is registered and running is left alone. A missing token stops the run before any change, and the message gives the `gh` command that makes one. The runner's own `config.sh` takes the token as an argument, so the token shows in the process list for a short time. The `sweeps` step runs after `register`, so the new runner units get their recovery drop-in in the same run.

### 4. Verify

```bash
ssh root@<host> 'bash /opt/ci-server/scripts/verify-server.sh --config /opt/ci-server/<project>.conf --only host'
bash scripts/verify-server.sh --config <project>.conf --only api
```

Run the host checks when no job runs: a running stack holds its ports. Then make sure that a real job runs to the end on each repository's runners, and on one heavy runner of each.

### 5. More steps by hand

- With `cockpit=yes`, the `admin` user has no password. The owner sets it: `ssh -t root@<host> passwd admin`. Cockpit listens on `127.0.0.1:9090` only; reach it through an SSH tunnel.
- The label cut-over and the decision to cancel the old server.

## Migration order

Never move the labels in one step. Jobs wait for a runner with their labels, so a gap stops CI.

1. Register the new runners with the labels they will carry. Give the new server its own `name_prefix`, so that the names differ from the old runners. Both servers now take jobs.
2. Prove each new runner with real jobs that run to the end. Run `verify-server.sh`.
3. Only then take the labels off the old runners, one at a time: `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>/labels/<label>`. Runner ids are per repository. Do not deregister the old runners.
4. Keep the old runners online with no custom label until the owner says otherwise.

## Diagnose

```bash
gh api repos/<owner>/<repo>/actions/runners --paginate \
  -q '.runners[]|[.id,.name,.status,.busy,([.labels[].name]|join(","))]|@tsv'
gh run list -R <owner>/<repo> --status queued --limit 50
ssh root@<host> 'uptime; nproc; free -g; cat /proc/pressure/cpu /proc/pressure/io /proc/pressure/memory'
ssh root@<host> 'systemctl --no-pager list-units "actions.runner.*"; df -h /; cat /proc/mdstat'
ssh root@<host> 'sar -u -q 1 5; sar -d 1 5; ps -eo state,pid,etime,cmd | awk "\$1 ~ /D/"'
```

Read the result in this order:

1. **A runner is offline and runs are queued:** restart it.
2. **Queued runs, all runners online and busy:** the plan is too small or the jobs are too slow. Do not add runners without the owner.
3. **CPU pressure high** (`some avg60` above 50, load average above the CPU count): the host is oversubscribed. Run `sizing.sh` and give the owner the numbers.
4. **Memory pressure or full swap:** too many runners or a job that leaks. `free -g` and `ps -eo rss,cmd --sort=-rss | head`.
5. **I/O pressure high, or many processes in state `D`:** the disk is slow or full. `sar -d` shows the busy device. Check `/proc/mdstat` for a resync.
6. **A job fails at the start on one runner only:** compare the same job on another runner or on the default branch. Read the job's port lines and the listeners in the runner's port block (`ss -ltnp`).

`sar` reads the `sysstat` history, so `sar -u -f /var/log/sysstat/sa<DD>` shows an earlier day.

## Restart or register again

```bash
ssh root@<host> 'cd /home/ci<slot>/runner && ./svc.sh status && ./svc.sh stop && ./svc.sh start'
ssh root@<host> 'systemctl status actions.runner.<owner>-<repo>.<name>.service; journalctl -u actions.runner.<owner>-<repo>.<name>.service -n 50 --no-pager'
```

If the runner is gone from the repository list or will not connect, register it again with a fresh token. This deletes the local registration and replaces the GitHub record of the same name:

```bash
echo "<owner>/<repo> $(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token)" \
  | ssh root@<host> 'bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/<project>.conf --register --reregister <slot>'
```

To drain a runner, take its custom labels off (do not deregister it). Wait until `pgrep -a Runner.Worker` prints nothing, then add the labels back with `gh api -X POST repos/<owner>/<repo>/actions/runners/<id>/labels -f 'labels[]=<label>'`. Get the owner's go first.

## Disk and Docker

Docker logs are capped, the build cache is capped in `/etc/docker/daemon.json`, and `/etc/cron.weekly/docker-prune` prunes images older than a week. With `docker_sweep_*` rules, `ci-docker-sweep.timer` removes the old containers, volumes and networks of named compose projects every hour. `ci-runner-sweep.timer` ends processes that finished jobs left in the runner cgroups of each `sweep_repo`. If `/` fills: `docker system prune -af --volumes; df -h /`.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## Tests

`scripts/tests/ci-server.test.mjs` runs in `npm test`: config errors, the plan, the sizing rule, the API checks against a fake `gh` and the Docker sweep against a fake `docker`. `scripts/tests/provision.container.test.mjs` runs `provision.sh` and `verify-server.sh` for real as root in an `ubuntu:24.04` container, with fakes for `systemctl`, `apt-get`, `mount` and similar commands. It needs Docker, and the `ci-server` job of the ndev CI runs it. Nothing here runs `apt`, `mount`, systemd, `ufw` or the runner download against a real host.
