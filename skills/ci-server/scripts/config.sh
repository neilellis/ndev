#!/usr/bin/env bash

config_fields="name_prefix, runner, port_base, work_size, tmp_size, swap_size, timezone, unit_prefix, heavy_label, cpus_per_heavy_runner, cpus_per_runner, gb_per_runner, apt_sources, packages, services, env.<NAME>, port.<NAME>, sweep_repos, docker_sweep_projects, docker_sweep_keep, docker_sweep_containers, docker_sweep_service_images, docker_sweep_images, docker_sweep_min_age, prepull_images, runner_version, runner_sha256"
config_reserved_env=" LANG TMPDIR CI_RUNNER_SLOT CI_PORT_BASE RUNNER_TOOL_CACHE "
config_example="examples/fcc-analytics.conf in the ci-server skill shows every field"

config_fail() { echo "ci-server: $1" >&2; exit 2; }
line_fail() { config_fail "$config_file line $config_line: $1. Repair: $2."; }

trim() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

size_ok() { [[ "$1" =~ ^[1-9][0-9]*[MG]$ ]]; }
count_ok() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
ere_ok() {
  local status
  [[ "" =~ $1 ]] && return 0
  status=$?
  [ "$status" -lt 2 ]
}

slot_list() {
  local IFS='|'
  echo "${slots[*]}"
}

config_runner() {
  local spec=$1 slot repo labels work tmp extra
  IFS=: read -r slot repo labels work tmp extra <<<"$spec"
  [ -z "${extra:-}" ] || line_fail "runner \"$spec\" has more than five fields" "write it as <slot>:<owner>/<repo>:<labels>[:<work size>:<tmp size>]"
  [[ "$slot" =~ ^([1-9]|[1-9][0-9])$ ]] || line_fail "runner \"$spec\": the slot must be a number from 1 to 99" "start the line with the slot, such as runner = 1:<owner>/<repo>:<labels>"
  [[ "${repo:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || line_fail "runner \"$spec\": the repository must be <owner>/<repo>" "write the GitHub repository as <owner>/<repo> after the slot"
  [[ "${labels:-}" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]] || line_fail "runner \"$spec\": labels must be a comma-separated list of lowercase names" "write the labels as lowercase names separated by commas, such as app,heavy"
  [ -z "${r_line[$slot]:-}" ] || line_fail "runner \"$spec\": slot $slot is already on line ${r_line[$slot]}" "give each runner its own slot"
  if [ -n "${work:-}" ] || [ -n "${tmp:-}" ]; then
    size_ok "${work:-}" && size_ok "${tmp:-}" || line_fail "runner \"$spec\": the sizes must be whole numbers with M or G, such as 10G" "give both sizes, such as :16G:4G, or neither"
  fi
  slots+=("$slot")
  r_line[$slot]=$config_line
  r_spec[$slot]=$spec
  r_repo[$slot]=$repo
  r_labels[$slot]=$labels
  r_work[$slot]=${work:-}
  r_tmp[$slot]=${tmp:-}
}

config_env() {
  local kind=$1 name=$2 value=$3 i
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || line_fail "$kind.$name: the name must be upper-case letters, digits and underscores" "write it as $kind.NAME = <value>"
  case "$config_reserved_env" in *" $name "*) line_fail "$kind.$name sets $name, which runner-env.sh writes itself" "remove the line; runner-env.sh writes${config_reserved_env% }" ;; esac
  i=0
  while [ "$i" -lt "${#env_names[@]}" ]; do
    [ "${env_names[$i]}" != "$name" ] || line_fail "$kind.$name sets $name, which line ${env_lines[$i]} already sets" "keep one"
    i=$((i + 1))
  done
  if [ "$kind" = port ]; then
    [[ "$value" =~ ^([0-9]|[1-9][0-9])$ ]] || line_fail "port.$name must be an offset from 0 to 99; got \"$value\"" "give the offset of the port inside the runner's block of 100"
    i=0
    while [ "$i" -lt "${#env_names[@]}" ]; do
      if [ "${env_kinds[$i]}" = port ] && [ "${env_values[$i]}" = "$value" ]; then
        line_fail "port.$name uses offset $value, which port.${env_names[$i]} on line ${env_lines[$i]} already uses" "give each port its own offset"
      fi
      i=$((i + 1))
    done
  fi
  env_kinds+=("$kind")
  env_names+=("$name")
  env_values+=("$value")
  env_lines+=("$config_line")
}

config_words() {
  local field=$1 pattern=$2 value=$3 word
  for word in $value; do
    [[ "$word" =~ $pattern ]] || line_fail "$field names \"$word\", which is not a valid name" "separate the names with spaces"
  done
}

load_config() {
  config_file=$1
  [ -f "$config_file" ] && [ -r "$config_file" ] || config_fail "cannot read the config file $config_file. Repair: give the path of a readable config file; $config_example."
  config_dir=$(cd "$(dirname "$config_file")" && pwd)
  name_prefix="" port_base=21000 work_size=10G tmp_size=3G swap_size=16G timezone=UTC unit_prefix=ci
  heavy_label="" cpus_per_heavy_runner=4 cpus_per_runner=2 gb_per_runner=8
  apt_sources="" packages="" services="" sweep_repos=""
  docker_sweep_projects="" docker_sweep_keep="" docker_sweep_containers="" docker_sweep_service_images="" docker_sweep_images="" docker_sweep_min_age=7200
  prepull_images="" runner_version=2.338.2 runner_sha256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
  slots=() r_line=() r_spec=() r_repo=() r_labels=() r_work=() r_tmp=()
  env_kinds=() env_names=() env_values=() env_lines=()
  local seen_keys=() seen_lines=() given_version="" given_sha="" set_field unset_field sweep_line="" raw line key value i word slot found unit
  config_line=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    config_line=$((config_line + 1))
    line=$(trim "$raw")
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) line_fail "\"$line\" is not \"key = value\"" "write each field as key = value; $config_example" ;; esac
    key=$(trim "${line%%=*}")
    value=$(trim "${line#*=}")
    if [ "$key" != runner ]; then
      i=0
      while [ "$i" -lt "${#seen_keys[@]}" ]; do
        [ "${seen_keys[$i]}" != "$key" ] || line_fail "$key is already on line ${seen_lines[$i]}" "keep one"
        i=$((i + 1))
      done
      seen_keys+=("$key")
      seen_lines+=("$config_line")
    fi
    case "$key" in
      runner) config_runner "$value" ;;
      name_prefix|unit_prefix|heavy_label)
        [[ "$value" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || line_fail "$key must be lowercase letters, digits and single hyphens; got \"$value\"" "use a name such as build-server"
        printf -v "$key" '%s' "$value" ;;
      port_base)
        [[ "$value" =~ ^[1-9][0-9]{3,4}$ ]] || line_fail "port_base must be a whole number from 1000 to 99999; got \"$value\"" "use a base such as 21000"
        port_base=$value ;;
      work_size|tmp_size|swap_size)
        size_ok "$value" || line_fail "$key must be a whole number with M or G, such as 10G; got \"$value\"" "write a number followed by M or G"
        printf -v "$key" '%s' "$value" ;;
      timezone)
        [[ "$value" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] || line_fail "timezone must be a zone name such as Europe/Berlin; got \"$value\"" "use a name that timedatectl list-timezones prints"
        timezone=$value ;;
      cpus_per_heavy_runner|cpus_per_runner|gb_per_runner)
        count_ok "$value" || line_fail "$key must be a whole number above 0; got \"$value\"" "give a number such as 4"
        printf -v "$key" '%s' "$value" ;;
      docker_sweep_min_age)
        count_ok "$value" || line_fail "docker_sweep_min_age must be a whole number of seconds above 0; got \"$value\"" "give the age in seconds, such as 7200"
        docker_sweep_min_age=$value ;;
      apt_sources)
        for word in ${value//,/ }; do
          case "$word" in docker|github-cli|google-chrome|nodesource-22) ;; *) line_fail "apt_sources names \"$word\"" "use docker, github-cli, google-chrome or nodesource-22, separated by commas" ;; esac
        done
        apt_sources=$value ;;
      packages) config_words packages '^[a-z0-9][a-z0-9.+-]*$' "$value"; packages=$value ;;
      services) config_words services '^[A-Za-z0-9@_.-]+$' "$value"; services=$value ;;
      sweep_repos)
        for word in ${value//,/ }; do
          [[ "$word" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || line_fail "sweep_repos names \"$word\", which is not <owner>/<repo>" "separate the repositories with commas"
        done
        sweep_repos=$value
        sweep_line=$config_line ;;
      docker_sweep_projects|docker_sweep_keep|docker_sweep_containers|docker_sweep_service_images|docker_sweep_images)
        ere_ok "${value//'{slots}'/1}" || line_fail "$key \"$value\" is not a valid extended regular expression" "check the brackets and parentheses"
        printf -v "$key" '%s' "$value" ;;
      prepull_images)
        case "$value" in */*) line_fail "prepull_images must be a file name in the config's own folder, not \"$value\"" "put the image list beside the config and give its file name" ;; esac
        [ -r "$config_dir/$value" ] || line_fail "prepull_images names $config_dir/$value, which cannot be read" "put the image list, one image per line, beside the config"
        prepull_images=$value ;;
      runner_version)
        [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || line_fail "runner_version must be a version such as 2.338.2; got \"$value\"" "copy it from the release page of actions/runner"
        runner_version=$value given_version=1 ;;
      runner_sha256)
        [[ "$value" =~ ^[0-9a-f]{64}$ ]] || line_fail "runner_sha256 must be 64 lowercase hex digits" "copy the sha256 of actions-runner-linux-x64-<version>.tar.gz from the release page"
        runner_sha256=$value given_sha=1 ;;
      env.*) config_env env "${key#env.}" "$value" ;;
      port.*) config_env port "${key#port.}" "$value" ;;
      *) line_fail "$key is not a known field" "use one of $config_fields" ;;
    esac
  done <"$config_file"

  [ -n "$name_prefix" ] || config_fail "$config_file: no name_prefix. Repair: add \"name_prefix = <name>\"; the runners are named <name>-<slot>."
  [ "${#slots[@]}" -gt 0 ] || config_fail "$config_file: no runner. Repair: add one \"runner = <slot>:<owner>/<repo>:<labels>\" line for each runner."
  if [ "$given_version" != "$given_sha" ]; then
    if [ -n "$given_version" ]; then set_field=runner_version unset_field=runner_sha256; else set_field=runner_sha256 unset_field=runner_version; fi
    config_fail "$config_file: $set_field is set but $unset_field is not. Repair: give both, from the release page of actions/runner, or neither."
  fi
  [ -z "$docker_sweep_keep" ] || [ -n "$docker_sweep_projects" ] || config_fail "$config_file: docker_sweep_keep is set but docker_sweep_projects is not. Repair: set docker_sweep_projects to the projects the sweep owns, or remove docker_sweep_keep."
  for slot in "${slots[@]}"; do
    [ -n "${r_work[$slot]}" ] || r_work[$slot]=$work_size
    [ -n "${r_tmp[$slot]}" ] || r_tmp[$slot]=$tmp_size
    if [ $((port_base + 100 * slot + 99)) -ge 32768 ]; then
      config_line=${r_line[$slot]}
      line_fail "runner \"${r_spec[$slot]}\": slot $slot with port base $port_base ends at $((port_base + 100 * slot + 99)), which is not below 32768, where Linux starts the ports it gives to outgoing connections" "use a lower port_base or a lower slot"
    fi
    unit=$(unit_name "$slot")
    if [ "${#unit}" -gt 80 ]; then
      config_line=${r_line[$slot]}
      line_fail "runner \"${r_spec[$slot]}\": its service name $unit has ${#unit} characters, and the runner shortens a name over 80, so the scripts would not find the unit" "use a shorter name_prefix"
    fi
  done
  for word in ${sweep_repos//,/ }; do
    found=0
    for slot in "${slots[@]}"; do [ "${r_repo[$slot]}" != "$word" ] || found=1; done
    [ "$found" = 1 ] || { config_line=$sweep_line; line_fail "sweep_repos names $word, which no runner line has" "name the repository of a runner, or remove it from sweep_repos"; }
  done

  runner_count=${#slots[@]}
  heavy_count=0
  if [ -n "$heavy_label" ]; then
    for slot in "${slots[@]}"; do
      case ",${r_labels[$slot]}," in *",$heavy_label,"*) heavy_count=$((heavy_count + 1)) ;; esac
    done
  fi
  docker_sweep_on=0
  [ -z "$docker_sweep_projects$docker_sweep_containers$docker_sweep_images" ] || docker_sweep_on=1
}

require_slot() {
  [[ "$1" =~ ^([1-9]|[1-9][0-9])$ ]] && [ -n "${r_repo[$1]:-}" ] || config_fail "slot $1 has no runner line in $config_file. Repair: add \"runner = $1:<owner>/<repo>:<labels>\" to it, or give one of its slots: ${slots[*]}."
}

unit_name() { echo "actions.runner.${r_repo[$1]/\//-}.$name_prefix-$1.service"; }

is_sweep_repo() { case ",$sweep_repos," in *",$1,"*) return 0 ;; esac; return 1; }

runner_env() {
  local n=$1 base i value
  base=$((port_base + 100 * n))
  printf 'LANG=en_US.UTF-8\nTMPDIR=/home/ci%s/tmp\nCI_RUNNER_SLOT=ci%s\nCI_PORT_BASE=%s\n' "$n" "$n" "$base"
  i=0
  while [ "$i" -lt "${#env_names[@]}" ]; do
    if [ "${env_kinds[$i]}" = port ]; then value=$((base + env_values[i])); else value=${env_values[$i]//'{slot}'/$n}; fi
    printf '%s=%s\n' "${env_names[$i]}" "$value"
    i=$((i + 1))
  done
  printf 'RUNNER_TOOL_CACHE=/home/ci%s/toolcache\n' "$n"
}

host_size() {
  if [ -n "${cpus_override:-}" ]; then cpus=$cpus_override
  else cpus=$(getconf _NPROCESSORS_ONLN) || config_fail "getconf _NPROCESSORS_ONLN failed, so the CPU count is not known. Repair: give --cpus N."
  fi
  if [ -n "${mem_override:-}" ]; then mem_gb=$mem_override
  elif [ -r /proc/meminfo ]; then mem_gb=$(awk '/^MemTotal:/ {print int($2 / 1048576)}' /proc/meminfo)
  else config_fail "cannot read /proc/meminfo, so the memory size is not known. Repair: give --mem-gb N."
  fi
}

sizing_problems() {
  local cpus=$1 mem_gb=$2
  if [ -n "$heavy_label" ] && [ "$heavy_count" -gt $((cpus / cpus_per_heavy_runner)) ]; then
    echo "$heavy_count runners carry the $heavy_label label, but $cpus CPUs carry at most $((cpus / cpus_per_heavy_runner)) (one per $cpus_per_heavy_runner CPUs). On 2026-11-24 six supabase runners on 16 CPUs ran at a load average of 58 and test files that take 28 seconds alone hit their 120 second timeout."
  fi
  if [ "$runner_count" -gt $((cpus / cpus_per_runner)) ]; then
    echo "$runner_count runners on $cpus CPUs is more than one runner per $cpus_per_runner CPUs ($((cpus / cpus_per_runner)))."
  fi
  if [ "$mem_gb" -lt $((runner_count * gb_per_runner)) ]; then
    echo "$runner_count runners need at least $((runner_count * gb_per_runner)) GB of memory ($gb_per_runner GB each), and the host has $mem_gb GB."
  fi
  return 0
}

sizing_rule() {
  local rule="one runner per $cpus_per_runner CPUs, $gb_per_runner GB per runner"
  [ -z "$heavy_label" ] || rule="one $heavy_label runner per $cpus_per_heavy_runner CPUs, $rule"
  echo "$rule"
}

sizing_fit() {
  local heavy=""
  [ -z "$heavy_label" ] || heavy=", $heavy_count with $heavy_label,"
  echo "$runner_count runners$heavy fit $1 CPUs and $2 GB."
}
