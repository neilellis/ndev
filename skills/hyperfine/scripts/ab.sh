#!/usr/bin/env bash
# A/B two commands with hyperfine, and refuse to report a speedup that this
# machine's own noise can produce.
#
# Usage: ab.sh 'command A' 'command B' [runs]
#
# Exit 0 = B differs from A by more than the measured noise floor.
# Exit 1 = the difference is inside the noise floor. There is no result to report.
# Exit 2 = the benchmark did not run. Never a pass.
set -uo pipefail

MAX_LOAD_PER_CPU="${MAX_LOAD_PER_CPU:-5.0}"
WARMUP="${WARMUP:-3}"

die() { printf 'ab.sh: %s\n' "$1" >&2; exit 2; }

[ "$#" -ge 2 ] || die "usage: ab.sh 'command A' 'command B' [runs]"
CMD_A="$1"
CMD_B="$2"
RUNS="${3:-20}"

case "$RUNS" in ''|*[!0-9]*) die "runs must be a whole number, got '$RUNS'" ;; esac
case "$MAX_LOAD_PER_CPU" in ''|*[!0-9.]*) die "MAX_LOAD_PER_CPU must be a number, got '$MAX_LOAD_PER_CPU'" ;; esac
case "${NOISE_ROUNDS:-3}" in ''|*[!0-9]*|0) die "NOISE_ROUNDS must be a whole number of 1 or more, got '${NOISE_ROUNDS:-}'" ;; esac

command -v hyperfine >/dev/null 2>&1 || die "hyperfine is not installed. Fix: brew install hyperfine (or cargo install hyperfine)"
command -v python3 >/dev/null 2>&1 || die "python3 is not on PATH"

# --- The load ceiling. Above it, this machine cannot give a stable timing. ---
# Override with MAX_LOAD_PER_CPU (load average per core; default 5.0).
if [ "$(uname)" = "Darwin" ]; then
  CPUS="$(sysctl -n hw.ncpu)"
else
  CPUS="$(nproc)"
fi
LOAD="$(uptime | sed -E 's/.*load averages?: *//' | tr -d ',' | awk '{print $1}')"
case "$LOAD" in
  ''|*[!0-9.]*) die "could not read the load average from uptime (got '$LOAD'), so the load ceiling cannot be checked." ;;
esac
CEILING="$(python3 -c "print($CPUS * $MAX_LOAD_PER_CPU)")"
OVER="$(python3 -c "print(1 if float('$LOAD') > float('$CEILING') else 0)")"
if [ "$OVER" = "1" ]; then
  printf 'ab.sh: SKIPPED. Load %s is above the ceiling %s (%s cores x %s).\n' \
    "$LOAD" "$CEILING" "$CPUS" "$MAX_LOAD_PER_CPU" >&2
  printf 'ab.sh: This box cannot judge a benchmark now. Wait, or measure elsewhere.\n' >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Stage 1: the noise floor. Run command A against ITSELF, several times. ---
# Whatever ratio this reports is a difference the machine invented. A real
# result must beat it.
#
# ONE A/A round is not the floor. A single round is itself a noisy sample and
# lands low as often as high: one round can read 1.002x while an A/B round of the
# SAME command against ITSELF reads 1.022x, so a single-round floor calls pure noise
# a real result. Take the WORST of several (NOISE_ROUNDS, default 3).
NOISE_ROUNDS="${NOISE_ROUNDS:-3}"
printf 'ab.sh: measuring the noise floor (A against itself, %s rounds of %s runs)...\n' \
  "$NOISE_ROUNDS" "$RUNS" >&2
for round in $(seq 1 "$NOISE_ROUNDS"); do
  hyperfine --warmup "$WARMUP" --runs "$RUNS" --shell=none \
    --export-json "$TMP/aa-$round.json" -- "$CMD_A" "$CMD_A" >/dev/null 2>"$TMP/aa.err" \
    || { cat "$TMP/aa.err" >&2; die "the noise-floor run failed. The command above never completed."; }
done

# --- Stage 2: the real comparison. ---
printf 'ab.sh: measuring A against B (%s runs)...\n' "$RUNS" >&2
hyperfine --warmup "$WARMUP" --runs "$RUNS" --shell=none \
  --export-json "$TMP/ab.json" -- "$CMD_A" "$CMD_B" >"$TMP/ab.out" 2>"$TMP/ab.err" \
  || { cat "$TMP/ab.err" >&2; die "the A/B run failed. The command above never completed."; }

cat "$TMP/ab.out"

python3 - "$TMP/ab.json" "$TMP"/aa-*.json <<'PY'
import json
import sys

def load(path):
    with open(path) as handle:
        return json.load(handle)["results"]

real = load(sys.argv[1])
noise_rounds = [load(path) for path in sys.argv[2:]]
if not noise_rounds:
    print("ab.sh: no noise-floor rounds were written.", file=sys.stderr)
    raise SystemExit(2)

for row in real + [row for rows in noise_rounds for row in rows]:
    if any(code != 0 for code in row.get("exit_codes", [])):
        print(f"ab.sh: {row['command']!r} exited non-zero. The benchmark timed a failure.",
              file=sys.stderr)
        raise SystemExit(2)

def ratio(rows):
    # Median, not mean. One outlier moves a mean and does not move a median.
    lo, hi = sorted(row["median"] for row in rows)
    return hi / lo if lo > 0 else float("inf")

floor = max(ratio(rows) for rows in noise_rounds)
observed = ratio(real)

a_med, b_med = (row["median"] * 1000 for row in real)
print()
print(f"ab.sh: noise floor      {floor:.3f}x  "
      f"(worst of {len(noise_rounds)} A-against-itself rounds)")
print(f"ab.sh: observed         {observed:.3f}x  (A {a_med:.1f} ms, B {b_med:.1f} ms, medians)")

if observed <= floor:
    print(f"ab.sh: INSIDE THE NOISE. {observed:.3f}x does not beat {floor:.3f}x.")
    print("ab.sh: There is no result to report. Do not publish this as a speedup.")
    print("ab.sh: Either the change does nothing, or this machine cannot see it.")
    raise SystemExit(1)

print(f"ab.sh: REAL. {observed:.3f}x is outside this machine's noise floor.")
print(f"ab.sh: Report it as: {observed:.2f}x, median of {len(real[0]['times'])} runs, "
      f"noise floor {floor:.2f}x.")
raise SystemExit(0)
PY
