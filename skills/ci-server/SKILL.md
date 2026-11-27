---
name: ci-server
description: "Provision, verify, diagnose and restart a server that runs self-hosted GitHub Actions runners for one or more repositories: one user, port block and tmpfs work folder for each runner, from a config file. Use to set up or migrate a build server, size its runner count, check it after a change, or restart a runner that is offline or slow."
---

# Self-hosted runner servers

Use this skill when a project runs its CI on its own server with self-hosted GitHub Actions runners. It covers a new server, a migration from an old one, the sizing of the runner count, and the diagnosis and restart of a runner. A project with its own runner skill keeps it for the facts of its host. Use this skill for the procedure and the scripts.

Never deregister a runner, change its labels or change the runner count without the owner. The runner count and labels are the owner's decision. The scripts take them from the config and do not choose them. When two projects share a server, the owner of each project decides for its runners.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

## The scripts

They are in this skill's `scripts/` folder. Each one reads the server's config file with `--config <file>`. [The config reference](references/config.md) lists every field. `examples/multi-repo.conf` is a full example.

| Script | What it does |
|---|---|
| `provision.sh` | Sets up a fresh Ubuntu 24.04 host: users `ci<slot>`, port blocks and `.env`, tmpfs work folders, Docker, swap, sysctl, Cockpit, SSH, runner download and registration, sweeps and pre-pull. |
| `sizing.sh` | Checks the runner count against the CPUs and memory of the host, or of the host that `--cpus` and `--mem-gb` describe. |
| `verify-server.sh` | Prints one `PASS` or `FAIL` line for each check of the host (`--only host`) and of the GitHub API (`--only api`). |
| `register-runner.sh` | Registers one runner. The registration token comes on standard input. |
| `runner-env.sh` | Prints the `.env` of a slot. |
| `runner-sweep.sh` | Ends processes that finished jobs left in a runner's cgroup. A timer runs it. |
| `docker-sweep.sh` | Removes old Docker leftovers that the config's `docker_sweep_*` fields match. A timer runs it. |
| `docker-prepull.sh` | Pulls the pinned images of the `prepull_images` list, so that no job waits for a pull. A timer runs it. |

`provision.sh` has three modes:

1. `--plan` prints every step and the values of each runner. It reads nothing on the host and changes nothing. It runs on a laptop.
2. `--dry-run` runs the checks on the host and prints each change that a real run makes. It ends with the number of changes.
3. With no mode flag, it makes the changes. It is idempotent: a second run ends with `done, 0 change(s)`. It stops at the first failed command and prints the step, the command, its exit code and its output. Fix the cause and run it again.

`--skip <step>[,<step>]` leaves steps out. `--plan` prints the step names.

## How many runners fit

Run `sizing.sh --config <file> --cpus <n> --mem-gb <n>` before you order a server. The rule:

| Rule | Why |
|---|---|
| At most one `heavy_label` runner for each 4 CPUs | A stack job starts about ten containers, and its tests start several workers. |
| At most one runner for each 2 CPUs | A runner without the heavy label still builds and tests. |
| At least 8 GB of memory for each runner | The runner units set no memory limit. |

In practice, running six runners with the `supabase` label on 16 CPUs drove the load average to 58. Test files that take 28 seconds alone hit their 120-second timeout. Under the rule, 16 CPUs carry four such runners.

`provision.sh` and `verify-server.sh` apply the same rule. `provision.sh` refuses a config that breaks it and changes nothing. `--allow-oversubscribed` goes on and prints a warning. Use that flag only when the owner chose the layout. The example config breaks the rule because the owner chose six runners on 16 CPUs.

## A new server or a migration

Do the steps in this order. Each step needs the previous one.

1. **Size it.** Write the config and run `sizing.sh` with the CPUs and memory of the server you plan to order. Get the owner's runner count and labels.
2. **Order and install it (by hand).** For example, order a Hetzner server in rescue mode with your SSH public key. In the Rescue System, check the host key, then run `installimage -a -c installimage.conf`. `examples/hetzner-installimage.conf` puts Ubuntu 24.04 on two NVMe drives in RAID 1. Change `HOSTNAME`, and change `DRIVE1` and `DRIVE2` if `lsblk` shows other names. Read the new host keys before the reboot.
3. **Copy the scripts.** Copy this skill's `scripts/` folder and the config (with its image list) to the host, for example to `/opt/ci-server/`.
4. **Plan, dry run, run.** As root on the host: `provision.sh --config <file> --plan`, then `--dry-run`, then with no mode flag. Read each output before the next step.
5. **Register the runners.** Run `provision.sh` again with `--register`. It reads one `<owner>/<repo> <token>` line for each repository from standard input. The tokens never go into a file or onto the command line of the scripts. A token lasts one hour.

   ```bash
   { echo "<owner>/<repo> $(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token)"; } \
     | ssh root@<host> 'bash /opt/ci-server/scripts/provision.sh --config /opt/ci-server/server.conf --register'
   ```

   `register-runner.sh` gives the token to the runner's `config.sh` in the environment variable `ACTIONS_RUNNER_INPUT_TOKEN`, not as an argument, so the token does not show in the process list.
6. **Cut over the labels.** Never move the labels in one step, because a gap in labels stops CI. The new runners start with the labels they will carry. Both servers take jobs until each new runner has run a job to the end. Then take the custom labels off the old runners, one at a time: `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>/labels/<label>`. Runner ids are per repository. Never deregister an old runner. It stays online with no custom label until the owner decides.
7. **Verify.** On the host, when no job runs: `verify-server.sh --config <file> --only host`. Anywhere `gh` is signed in: `verify-server.sh --config <file> --only api`. Use `env -u GITHUB_TOKEN` for a repository your token cannot reach. Then check that a job runs to the end on a runner of each repository and on one heavy runner.

## What the scripts cannot do

- Order the server and install the operating system, and check the host keys.
- Make the registration tokens. Someone who administers each repository makes them.
- Set the password of the Cockpit `admin` user. `provision.sh` makes the user with no password. The owner sets it with `ssh -t root@<host> passwd admin`. Cockpit listens on `127.0.0.1:9090`; reach it through an SSH tunnel.
- Move the labels from the old runners, or decide to cancel the old server.
- Close a port that a job publishes on `0.0.0.0`. ufw does not filter the ports that Docker publishes. `provision.sh` sets Docker to publish on `127.0.0.1` by default, but a job that names `0.0.0.0` opens its port to the internet.
- Change the tmpfs size of a runner that has one. The `mounts` step stops and names the slot and both sizes. Stop the runner, edit its line in `/etc/fstab` by hand (a remount empties the tmpfs), and run `provision.sh` again.

## Diagnose

```bash
gh api repos/<owner>/<repo>/actions/runners -q '.runners[]|[.id,.name,.status,.busy,([.labels[].name]|join(","))]|@tsv'
ssh root@<host> 'uptime; systemctl --no-pager list-units "actions.runner.*"; df -h /; cat /proc/pressure/io'
ssh root@<host> 'bash /opt/ci-server/scripts/verify-server.sh --config /opt/ci-server/server.conf --only host'
```

- A runner is offline and runs are queued: restart it.
- Jobs are slow or time out: compare the load average with the CPU count, and run `sizing.sh` on the host.
- A job fails at start on a heavy runner: look for a listener in the runner's port block. `verify-server.sh` names it.
- To tell a host fault from a branch fault, find the same job on another runner or on the default branch and compare the failing step.
- The disk fills: run the Docker sweep now, then remove unused images and the build cache. Do not prune volumes: that removes the volumes that `docker_sweep_keep` keeps.

  ```bash
  ssh root@<host> 'systemctl start <unit_prefix>-docker-sweep.service; docker image prune -af; docker builder prune -af; df -h /'
  ```

## Restart a runner

```bash
ssh root@<host> 'systemctl restart actions.runner.<owner>-<repo>.<name_prefix>-<slot>.service'
ssh root@<host> 'systemctl status --no-pager actions.runner.<owner>-<repo>.<name_prefix>-<slot>.service'
```

To drain a runner before a change, take its custom labels off (do not deregister it). Wait until `pgrep -a Runner.Worker` prints nothing on the host, make the change, then add the labels back: `gh api -X POST repos/<owner>/<repo>/actions/runners/<id>/labels -f 'labels[]=<label>'`. A runner of another project needs that project's owner's go before a drain.

## Tests

`scripts/tests/ci-server.test.mjs` checks the `--plan` output, the config refusals, the sizing rule, the API checks of `verify-server.sh` and the Docker sweep. `scripts/tests/container.test.mjs` runs `provision.sh` for real in an Ubuntu 24.04 container, with fake `systemctl`, `apt-get`, `mount` and similar commands. It checks the dry run, a real run with registration, idempotence and `verify-server.sh`. It needs Docker. Without Docker it is skipped on a laptop and fails in CI. Neither test reaches a real host, real `apt`, `systemd` or GitHub.
