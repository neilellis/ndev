#!/usr/bin/env bash

[ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || { echo "ci-server: these scripts need bash 4 or later; this is bash ${BASH_VERSION:-unknown}." >&2; exit 2; }

sizing_cpus_per_heavy_runner=4
sizing_cpus_per_runner=2
sizing_gb_per_runner=8
sysctl_values=("fs.inotify.max_user_watches=524288" "fs.inotify.max_user_instances=512" "vm.max_map_count=1048576" "vm.swappiness=10")
declare -A r_repo r_labels r_work r_tmp
config_keys="name_prefix port_base work_size tmp_size swap_size timezone supabase heavy_label node_major chrome cockpit packages services runner_sudo runner_version runner_sha256 runner sweep_repo image docker_sweep_project docker_sweep_keep docker_sweep_container docker_sweep_image"

cis_defaults() {
  name_prefix="" port_base=21000 work_size=10G tmp_size=3G swap_size=16G timezone=UTC
  supabase=no heavy_label=supabase node_major="" chrome=no cockpit=no packages="" services=""
  runner_sudo="/usr/bin/apt-get, /usr/bin/ss"
  runner_version=2.338.2
  runner_sha256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
  config_file=""
  runner_specs=() cli_runner_specs=() sweep_repos=() images=()
  docker_sweep_projects=() docker_sweep_keeps=() docker_sweep_containers=() docker_sweep_images=()
  cpus_override="" mem_override=""
}

cis_load_config() {
  local file=$1 line key value n=0 version_set=0 sha_set=0
  [ -r "$file" ] || usage_fail "cannot read the config file '$file'."
  config_file=$file
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || usage_fail "$file line $n: '$line' is not key=value."
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    case "$key" in
      runner) runner_specs+=("$value") ;;
      sweep_repo) sweep_repos+=("$value") ;;
      image) images+=("$value") ;;
      docker_sweep_project) docker_sweep_projects+=("$value") ;;
      docker_sweep_keep) docker_sweep_keeps+=("$value") ;;
      docker_sweep_container) docker_sweep_containers+=("$value") ;;
      docker_sweep_image) docker_sweep_images+=("$value") ;;
      runner_version) runner_version=$value; version_set=1 ;;
      runner_sha256) runner_sha256=$value; sha_set=1 ;;
      name_prefix|port_base|work_size|tmp_size|swap_size|timezone|supabase|heavy_label|node_major|chrome|cockpit|packages|services|runner_sudo)
        printf -v "$key" '%s' "$value" ;;
      *) usage_fail "$file line $n: unknown key '$key'. The keys are: $config_keys." ;;
    esac
  done <"$file"
  [ "$version_set" = "$sha_set" ] || usage_fail "$file: runner_version and runner_sha256 go together; give both or neither."
}

cis_common_option() {
  case "$1" in
    --config|--runner|--name-prefix|--work-size|--tmp-size|--port-base|--swap-size|--cpus|--mem-gb)
      [ "$#" -ge 2 ] || usage_fail "$1 needs a value." ;;
    *) return 1 ;;
  esac
  case "$1" in
    --config) ;;
    --runner) cli_runner_specs+=("$2") ;;
    --name-prefix) name_prefix=$2 ;;
    --work-size) work_size=$2 ;;
    --tmp-size) tmp_size=$2 ;;
    --port-base) port_base=$2 ;;
    --swap-size) swap_size=$2 ;;
    --cpus) cpus_override=$2 ;;
    --mem-gb) mem_override=$2 ;;
  esac
  return 0
}

cis_preload_config() {
  local i args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = --config ]; then
      [ $((i + 1)) -lt ${#args[@]} ] || usage_fail "--config needs a file."
      cis_load_config "${args[$((i + 1))]}"
    fi
  done
}

cis_size_ok() { [[ "$1" =~ ^[1-9][0-9]*[MG]$ ]]; }
cis_yes_no() { [ "$2" = yes ] || [ "$2" = no ] || usage_fail "$1 must be yes or no; got '$2'."; }

cis_validate() {
  [ "${#cli_runner_specs[@]}" = 0 ] || runner_specs=("${cli_runner_specs[@]}")
  [ "${#runner_specs[@]}" -gt 0 ] || usage_fail "give at least one runner: a runner= line in the --config file, or --runner."
  [ -n "$name_prefix" ] || usage_fail "give the runner name prefix: name_prefix= in the --config file, or --name-prefix."
  [[ "$name_prefix" =~ ^[a-z0-9-]+$ ]] || usage_fail "the name prefix must be lowercase letters, digits and hyphens; got '$name_prefix'."
  local pair
  for pair in "work-size:$work_size" "tmp-size:$tmp_size" "swap-size:$swap_size"; do
    cis_size_ok "${pair#*:}" || usage_fail "${pair%%:*} must be a whole number with M or G, such as 10G; got '${pair#*:}'."
  done
  [[ "$port_base" =~ ^[1-9][0-9]{3,4}$ ]] || usage_fail "the port base must be a whole number such as 21000; got '$port_base'."
  [ -z "$cpus_override" ] || [[ "$cpus_override" =~ ^[1-9][0-9]*$ ]] || usage_fail "--cpus must be a whole number; got '$cpus_override'."
  [ -z "$mem_override" ] || [[ "$mem_override" =~ ^[1-9][0-9]*$ ]] || usage_fail "--mem-gb must be a whole number; got '$mem_override'."
  cis_yes_no supabase "$supabase"; cis_yes_no chrome "$chrome"; cis_yes_no cockpit "$cockpit"
  [ -z "$node_major" ] || [[ "$node_major" =~ ^[1-9][0-9]*$ ]] || usage_fail "node_major must be a Node.js major version such as 22, or empty; got '$node_major'."
  [[ "$heavy_label" =~ ^[a-z0-9-]+$ ]] || usage_fail "heavy_label must be one lowercase label; got '$heavy_label'."
  [[ "$timezone" =~ ^[A-Za-z0-9_+/-]+$ ]] || usage_fail "timezone must be a name such as UTC or Europe/Berlin; got '$timezone'."
  [[ "$packages" =~ ^[a-z0-9.+:\ -]*$ ]] || usage_fail "packages must be package names separated by spaces; got '$packages'."
  [[ "$services" =~ ^[A-Za-z0-9_.@\ -]*$ ]] || usage_fail "services must be unit names separated by spaces; got '$services'."
  [[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage_fail "runner_version must be a version such as 2.338.2; got '$runner_version'."
  [[ "$runner_sha256" =~ ^[0-9a-f]{64}$ ]] || usage_fail "runner_sha256 must be 64 lowercase hex digits; got '$runner_sha256'."

  slots=() r_repo=() r_labels=() r_work=() r_tmp=()
  local spec slot repo labels work tmp extra
  for spec in "${runner_specs[@]}"; do
    IFS=: read -r slot repo labels work tmp extra <<<"$spec"
    [ -z "${extra:-}" ] || usage_fail "runner '$spec' has more than five fields."
    [[ "$slot" =~ ^([1-9]|[1-9][0-9])$ ]] || usage_fail "runner '$spec': the slot must be a number from 1 to 99."
    [[ "${repo:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage_fail "runner '$spec': the repository must be <owner>/<repo>."
    [[ "${labels:-}" =~ ^[a-z0-9,-]+$ ]] || usage_fail "runner '$spec': labels must be a comma-separated list of lowercase names."
    [ -z "${r_repo[$slot]:-}" ] || usage_fail "runner slot $slot is named twice."
    work=${work:-$work_size}; tmp=${tmp:-$tmp_size}
    cis_size_ok "$work" && cis_size_ok "$tmp" || usage_fail "runner '$spec': sizes must be whole numbers with M or G, such as 10G."
    [ $((port_base + 100 * slot + 99)) -lt 32768 ] || usage_fail "runner '$spec': slot $slot with port base $port_base ends at $((port_base + 100 * slot + 99)), which is not below 32768, where Linux starts the ports it gives to outgoing connections."
    slots+=("$slot"); r_repo[$slot]=$repo; r_labels[$slot]=$labels; r_work[$slot]=$work; r_tmp[$slot]=$tmp
  done

  local r found n
  for r in "${sweep_repos[@]}"; do
    found=0
    for n in "${slots[@]}"; do [ "${r_repo[$n]}" = "$r" ] && found=1; done
    [ "$found" = 1 ] || usage_fail "sweep_repo $r has no runner in this plan."
  done
  for r in "${images[@]}"; do
    [[ "$r" =~ ^[A-Za-z0-9._/:@-]+$ ]] || usage_fail "image '$r' is not an image reference such as postgres:17."
  done

  runner_count=${#slots[@]}
  heavy_count=0
  for n in "${slots[@]}"; do
    case ",${r_labels[$n]}," in *",$heavy_label,"*) heavy_count=$((heavy_count + 1)) ;; esac
  done
}

cis_unit_name() { echo "actions.runner.${r_repo[$1]/\//-}.$name_prefix-$1.service"; }

cis_host_size() {
  if [ -n "$cpus_override" ]; then cpus=$cpus_override; else cpus=$(nproc); fi
  if [ -n "$mem_override" ]; then mem_gb=$mem_override; else mem_gb=$(awk '/^MemTotal:/ {print int($2 / 1048576)}' /proc/meminfo); fi
}

sizing_problems() {
  local cpus=$1 mem_gb=$2 runners=$3 heavy=$4 label=$5
  if [ "$heavy" -gt $((cpus / sizing_cpus_per_heavy_runner)) ]; then
    echo "$heavy runners carry the $label label, but $cpus CPUs carry at most $((cpus / sizing_cpus_per_heavy_runner)) (one per $sizing_cpus_per_heavy_runner CPUs). On 2026-11-24 six runners with a full Supabase stack each on 16 CPUs ran at a load average of 58 and test files that take 28 seconds alone hit their 120 second timeout."
  fi
  if [ "$runners" -gt $((cpus / sizing_cpus_per_runner)) ]; then
    echo "$runners runners on $cpus CPUs is more than one runner per $sizing_cpus_per_runner CPUs ($((cpus / sizing_cpus_per_runner)))."
  fi
  if [ "$mem_gb" -lt $((runners * sizing_gb_per_runner)) ]; then
    echo "$runners runners need at least $((runners * sizing_gb_per_runner)) GB of memory ($sizing_gb_per_runner GB each), and the host has $mem_gb GB."
  fi
  return 0
}

cis_runner_env() {
  local n=$1 base=$((port_base + 100 * $1))
  cat <<EOF
LANG=en_US.UTF-8
TMPDIR=/home/ci$n/tmp
CI_RUNNER_SLOT=ci$n
CI_PORT_BASE=$base
RUNNER_TOOL_CACHE=/home/ci$n/toolcache
EOF
  [ "$supabase" = yes ] || return 0
  cat <<EOF
SUPABASE_PROJECT_ID_SUFFIX=-ci$n
SUPABASE_SHADOW_PORT=$base
SUPABASE_API_PORT=$((base + 1))
SUPABASE_DB_PORT=$((base + 2))
SUPABASE_STUDIO_PORT=$((base + 3))
SUPABASE_INBUCKET_PORT=$((base + 4))
SUPABASE_SMTP_PORT=$((base + 5))
SUPABASE_POP3_PORT=$((base + 6))
SUPABASE_ANALYTICS_PORT=$((base + 7))
SUPABASE_POOLER_PORT=$((base + 9))
SUPABASE_EDGE_INSPECTOR_PORT=$((base + 83))
EOF
}

cis_sweep_unit_globs() {
  local r out=""
  for r in "${sweep_repos[@]}"; do out+="actions.runner.${r/\//-}.*.service "; done
  echo "${out% }"
}

cis_docker_sweep_conf() {
  local v
  for v in "${docker_sweep_projects[@]}"; do echo "project=$v"; done
  for v in "${docker_sweep_keeps[@]}"; do echo "keep=$v"; done
  for v in "${docker_sweep_containers[@]}"; do echo "container=$v"; done
  for v in "${docker_sweep_images[@]}"; do echo "image=$v"; done
}
