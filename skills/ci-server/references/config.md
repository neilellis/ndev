# The ci-server config file

One config file describes one server. Each line is `key = value`. Blank lines and lines that start with `#` are ignored. A field can appear once, except `runner`, `env.<NAME>` and `port.<NAME>`. The scripts refuse an unknown field, a bad value or a missing required field. The message names the file, the line, the field and the repair, and the exit code is 2.

`examples/fcc-analytics.conf` is the layout of the fcc and analytics server `ssd-build`. Copy it and change the values for another project.

## Runners

| Field | Default | Meaning |
|---|---|---|
| `name_prefix` | required | Runner names are `<name_prefix>-<slot>`. A new server needs its own prefix, so that its runners and the old ones can be online together during the cut-over. The service name `actions.runner.<owner>-<repo>.<name_prefix>-<slot>.service` must not be longer than 80 characters, because the runner shortens a longer name. |
| `runner` | required, repeat | `<slot>:<owner>/<repo>:<labels>[:<work size>:<tmp size>]`. The slot (1 to 99) gives the user `ci<slot>`, the runner name and the port block. Labels are lowercase and comma-separated. |
| `work_size`, `tmp_size` | `10G`, `3G` | The tmpfs sizes of `_work` and of `TMPDIR` for a runner line that gives no sizes. |
| `port_base` | `21000` | Slot `n` gets the ports `port_base + 100n` to `+ 99`. The top port must stay below 32768, where Linux starts the ports it gives to outgoing connections. |
| `swap_size` | `16G` | The swap file that `provision.sh` makes, only when no swap is active. |
| `timezone` | `UTC` | The time zone of the host. |

## Sizing rule

| Field | Default | Meaning |
|---|---|---|
| `heavy_label` | none | The label of runners that start a whole stack, such as `supabase`. |
| `cpus_per_heavy_runner` | `4` | At most one `heavy_label` runner for this many CPUs. |
| `cpus_per_runner` | `2` | At most one runner for this many CPUs. |
| `gb_per_runner` | `8` | At least this much memory, in GB, for each runner. |

## Packages and services

| Field | Default | Meaning |
|---|---|---|
| `apt_sources` | Docker only | More apt sources, comma-separated: `github-cli`, `google-chrome`, `nodesource-22`. |
| `packages` | none | More packages, separated by spaces. Docker, git, jq, curl, sysstat, pcp, Cockpit, fail2ban, ufw and unattended-upgrades are always installed. |
| `services` | none | Services to enable, separated by spaces, such as `redis-server`. |

## The runner's .env

`runner-env.sh` always writes `LANG`, `TMPDIR`, `CI_RUNNER_SLOT`, `CI_PORT_BASE` and `RUNNER_TOOL_CACHE`. These fields add lines, in the order of the config:

| Field | Meaning |
|---|---|
| `env.<NAME> = <value>` | The line `NAME=<value>`. `{slot}` in the value becomes the slot number. |
| `port.<NAME> = <offset>` | The line `NAME=<the slot's port base + offset>`. The offset is 0 to 99, and each offset can be used once. |

## Sweeps and pre-pull

| Field | Default | Meaning |
|---|---|---|
| `sweep_repos` | none | Repositories, comma-separated, whose runners get the recovery drop-in and the cgroup sweep every 5 minutes. |
| `docker_sweep_projects` | none | An extended regular expression. Compose and Supabase projects that match are the job's own; their containers, volumes and networks are removed when old and unused. |
| `docker_sweep_keep` | none | Projects to keep, even when `docker_sweep_projects` matches. `{slots}` becomes the slots joined with `\|`, such as `1\|2\|5`. |
| `docker_sweep_containers` | none | Container names to remove when old. |
| `docker_sweep_service_images` | none | Images of the service containers that Actions names `<32 hex digits>_<name>`; such containers are removed when old. |
| `docker_sweep_images` | none | Image repositories to remove when old and unused. |
| `docker_sweep_min_age` | `7200` | Seconds a leftover must be old before the sweep removes it. Set it above the time of the longest job: the sweep removes a matched container even while it runs. |
| `prepull_images` | none | A file name beside the config. Each line holds one image, and a second word on the line is a note. The pre-pull pulls them after each boot and each day. |
| `unit_prefix` | `ci` | The systemd units are `<unit_prefix>-runner-sweep`, `-docker-sweep` and `-docker-prepull`. |

When you remove `sweep_repos`, all the `docker_sweep_*` fields or `prepull_images` and run `provision.sh` again, it turns the timer off and removes its units.

## Runner version

`runner_version` and `runner_sha256` pin another Actions runner release. Give both or neither. The sha256 is the one of `actions-runner-linux-x64-<version>.tar.gz` on the release page of actions/runner.
