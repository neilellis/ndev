---
name: hyperfine
description: "Benchmark and compare command durations when a speed claim or before/after measurement is needed. Use the project speed gate for test lanes and a profiler for in-process attribution."
---

# Benchmark commands

Use `hyperfine` to explore. Use `scripts/ab.sh` in this skill's folder for a number that you will report:

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.

```bash
hyperfine --warmup 3 --runs 20 --shell=none 'command'
hyperfine --warmup 3 --runs 20 --shell=none 'old' 'new'
scripts/ab.sh 'old' 'new' 20
```

## Measure the noise floor first

Compare A with itself before you publish A against B. `ab.sh` runs repeated A/A rounds and takes the worst spread as the noise floor. It also refuses to run above a load ceiling.

| Setting | Default | Meaning |
|---|---|---|
| `NOISE_ROUNDS` | 3 | A/A rounds for the noise floor |
| `MAX_LOAD_PER_CPU` | 5.0 | load average per core above which timings are not stable |

| Exit | Meaning |
|---|---|
| 0 | B differs from A by more than the noise floor. You can report it. |
| 1 | The difference is inside the noise floor. There is no result. |
| 2 | No valid benchmark. Never a pass. |

## Rules

- Warm up. Use `--shell=none` for short commands.
- Use enough runs to show the noise. Export JSON when a script reads the result.
- Do not use `-i` to turn failed commands into timings. Do not hide a status in a pipe.
- Below about 5 ms, a single run is noise: loop the command and use `-N`.
- Use the median to compare. Use the minimum for a standalone lower-bound cost.
- Report the command, run count, noise floor, load, date and scope. Never publish a bare multiplier.

Do not use this skill to time a test lane (use the project's speed gate) or to find in-process hot spots (use a profiler).
