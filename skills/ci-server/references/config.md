# The config file

One `key=value` per line. Lines that start with `#` and empty lines are ignored. A value is the rest of the line, with its spaces. An unknown key stops the scripts with exit 2. A command-line option overrides the key of the same name. Any `--runner` replaces all the `runner=` lines.

| Key | Default | Meaning |
|---|---|---|
| `name_prefix` | none, required | Runner names are `<name_prefix>-<slot>`. Give a new server a new prefix. |
| `runner` | none, at least one | `<slot>:<owner>/<repo>:<labels>[:<work size>:<tmp size>]`. Repeat for each runner. Slot 1 to 99. Labels are lowercase and separated by commas. |
| `port_base` | `21000` | Slot `n` gets ports `port_base + 100n` to `+ 99`. The top port must stay below 32768. |
| `work_size`, `tmp_size` | `10G`, `3G` | Size of each runner's `_work` and `TMPDIR` tmpfs, when its `runner=` line gives none. |
| `swap_size` | `16G` | Size of `/swapfile`, made only when no swap is active. |
| `timezone` | `UTC` | Host time zone. |
| `supabase` | `no` | `yes` adds the `SUPABASE_*_PORT` values and `SUPABASE_PROJECT_ID_SUFFIX=-ci<slot>` to each `.env`. |
| `heavy_label` | `supabase` | The label that the sizing rule counts as one full stack per job. |
| `node_major` | empty | A Node.js major version, such as `22`, installs Node from NodeSource. Empty: no Node. |
| `chrome` | `no` | `yes` installs Google Chrome (x64 only). |
| `cockpit` | `no` | `yes` installs Cockpit on `127.0.0.1:9090` and an `admin` user with no password. |
| `packages` | empty | More apt packages, separated by spaces. |
| `services` | empty | More systemd units to enable, separated by spaces. |
| `runner_sudo` | `/usr/bin/apt-get, /usr/bin/ss` | Commands that each `ci<slot>` user can run with `sudo` and no password. Empty: no sudoers file. |
| `runner_version`, `runner_sha256` | `2.338.2` and its sha256 | The Actions runner for linux x64. Give both or neither. |
| `sweep_repo` | none | `<owner>/<repo>`. Its runner units get the recovery drop-in (restart on failure, kill the whole cgroup) and the runner sweep. Repeat for each. |
| `image` | none | A Docker image to pull after each boot and each day, so no job waits for a pull. Repeat for each. |
| `docker_sweep_project` | none | Extended regular expression. Old containers, unused volumes and networks of a matching compose project are removed. |
| `docker_sweep_keep` | none | Extended regular expression. A matching project is kept, even if it matches `docker_sweep_project`. Use it for a stack that a live runner reuses. |
| `docker_sweep_container` | none | Extended regular expression against `<container name> <image>`. Old matching containers are removed. |
| `docker_sweep_image` | none | Extended regular expression against the image repository. Old, unused matching images are removed. |

"Old" is older than two hours. The Docker sweep and the pre-pull are installed only when their keys are present.
