# Guards

[kb](README.md) › guards

**A guard that cannot fail is worse than no guard. A guard that cannot pass is the same bug.** A guard is a test that reads the tree, the config or the run output and asserts a property of it. Prove each guard in both directions: it fails with the defect, and it passes without it.

## Which home a guard belongs in

Answer in order. The first match wins.

| The guard needs | Home |
|---|---|
| a pattern over the syntax tree | a structural rule (ast-grep) with valid and invalid proof cases |
| type information | a local lint rule for that language |
| real execution (spawn a tool, query a database, render a file) | a guard test |
| more than one file at once | a guard test |
| a value, a count or a comparison | a guard test |

A structural matcher sees one file at a time. It answers "does this shape occur", never "how many" or "what value". A rule written against that limit goes vacuous, not red.

### The structural rule pattern

- The rule file's `id` matches its file name, so a reader can open it from a CI finding.
- It carries a `message` (what is wrong) and a `note` (the fix). Its severity is `error`.
- Its proof file holds `invalid` cases (the rule must fire) and `valid` cases (the rule must stay quiet). Both halves are necessary.
- `.ts` and `.tsx` are two grammars. A rule over both needs a twin, and a guard must fail when a twin is missing or drifts. A missing twin is silent: the rule passes its proof and guards nothing.
- The scan script proves every rule before it scans, and it fails closed when the binary is absent.

## Never in a position to fail

A guard is "in a position to fail" only when a real defect makes it go red. Working rules:

- **Assert the property, not a shared symptom.** A symptom that the defect and a correct change both produce cannot tell them apart.
- **Never grep source text for a fact.** A comment satisfies a grep. Read the syntax tree, or execute the code.
- **Ask what would make it fail.** If you cannot name a change that turns it red, it guards nothing.
- **A killed mutation is the evidence.** See [testing.md](testing.md#mutation-proof).
- **A fixture must not build its subject through the code under test.**
- **Distrust a guard that passes the first time.**
- **Assert that the arm was taken,** not only that the result looks correct.
- **One `git status` snapshot is not evidence** of a stable tree.

### A guard reads the tree as it was written

- Derive the scan roots by glob from the repository root. Never type the list from memory. Name the tree, never its parts.
- Refuse an empty glob with exit 2.
- Assert a floor on what was scanned (for example at least 200 files). Set the floor under something that grows, not under a shrink-only list.
- Read tracked files only (`git ls-files`). A guard that reads ignored files sees build output.
- Filter generated folders (`__pycache__`, `*.egg-info`, `node_modules`).
- Watch for a guard narrowed to one language or one extension.
- A parametrised guard needs a completeness pair: one test proves each case, one test proves the case list is whole.

### Hand-maintained lists

A list of "files that must have X" or "files exempt from X" goes stale. Derive the answer from the data. If a list must exist, add a test that makes a third value appear that is in neither list, and prove the guard sees it.

A skip list is a hole. Each skip carries a rot guard that fails when the skipped item changes or disappears. Write the rot guard so that an absent tree passes.

### Config versus outcome

A guard over configuration shows intent only. Prove the outcome too: run the build and read the output, or execute the command with stubs and observe what ran.

**When a guard goes red on a change you believe is correct, the guard is either right or it is a proxy.** Find out which before you touch either. Replace a proxy with an assertion of the property. Never relax it.

### A red guard is not proof that it is stale

Repair the measurement. Never delete the guard to get green.

### A red guard can switch off other guards

- An unparseable test file can stop a whole suite from loading, and the runner can still report success. Zero tests run must fail the run.
- Job ordering is not a gate. A failing first job can mark later jobs as skipped, and a skip reads as amber, not red.

## Hollow gates

**A gate that exists is not a gate that runs, and a gate that runs is not a gate that checks.** Each of these looks like success from outside.

- **A sequential job stops at the first failure.** When stage 5 of 12 fails, stages 6 to 12 did not run. Count them as unrun, not as passed. Each fix lets the queue advance to the next defect behind it.
- **A job that runs only on the main branch is invisible on a PR.** Every PR stays green while the main branch is red. Read main health ([ci.md](ci.md#main-health)).
- **A fuzz target can fail to reach its own check.** Random bytes almost never form a valid credential, policy or message. The target then proves only "does not crash on noise". Measure how many inputs reach the assertion. Keep a list of each target with the seed that reaches its check, and fail by name when a target stops reaching it.
- **A sample is not a search.** A round-trip test with ordinary strings passes on a codec that corrupts unusual characters. Search the format's failure space exhaustively: every pair of the characters that break the format (quotes, backslashes, separators, `\r`, `\n`, non-ASCII). Start the test from the value, not from the parsed text.
- **What a parser accepts, its writer must emit.** A value that the system reads but cannot write back is a defect. A `parse → write → parse` test does not see it.
- **A written lesson is not an applied one.** Make the check structural, so that a new target or case without its proof fails.

## The guard pathology catalogue

Each entry is a way a real guard passed with the defect present, or failed on a healthy tree.

| Pathology | What happens |
|---|---|
| Counts instead of reads | The guard counts matches and never reads what matched. |
| A count by text match | A `grep -c` for a version string also counts another package at the same version. The count is correct until a collision makes it wrong. |
| Source grep satisfied by a comment | A comment holds the searched text. |
| The defect matches the pattern | The bad value has the same shape as the allowed one. |
| A fuzzy selector | The selector matches a sibling element. |
| A locator that matches twice | `.first()` before a count hides the duplicate. |
| The wrong tree | The guard scans a copy, a build output or another worktree. |
| Cannot pass | The guard is red on every tree, so people stop reading it. |
| A different build environment | CI builds with variables that production does not have, or the reverse. |
| An anti-vacuity check that cannot pass | The floor is set above what the tree can reach. |
| An empty loop | The loop body never runs, so no assertion runs. |
| An expired premise | The condition that the guard checks no longer exists. |
| Ready taken for styled | DOM-ready is not styles-ready. |
| It reads its own answer | The expected value comes from the code under test. |
| A cache makes both sides equal | A diff compares two reads of one cache. |
| A filter adds a blind spot | The exclusion hides the defect. |
| It reads ignored files | Use `git ls-files`. |
| The invariant is satisfied by the bug | An empty set satisfies "every item has X". |
| Right by cancellation | Two defects cancel out. |
| A generator that consumes its input | The second pass sees nothing. |
| A one-shot iterator against a list fixture | The fixture is reusable, production input is not. |
| A sibling URL | The guard checks a URL next to the one that matters. |
| A browser's spelling of a value | String comparison of a computed style fails on a valid value. |
| The schema moved under the seed | The seed data no longer matches the schema. |
| Measured before live | The guard reads a value before the system sets it. |
| Prefix comparison of paths | `/a/b` is a prefix of `/a/bc`. |
| A parser that skips input | Unparsed lines are silently dropped. |
| Substring comparison | Use the syntax tree. |
| A guard that knows only the shapes you thought of | A new shape passes. |

**A field-by-field guard misses object-level rules.** A NOT NULL column needs a presence guard and an agreement guard. Give each detector a "can see" test that proves it detects a planted defect.

**A whole-tree ratchet can start to read a file that you only edited.** Check the ratchet's baseline after a rename or a move.

## Edited-file guards

An edited-file guard runs on each file that the agent writes (a Claude Code `PostToolUse` hook on `Edit|Write`). See [hooks/edited-file-guards.sh](hooks/edited-file-guards.sh).

- It is an earlier copy of a check that CI runs. It never replaces the CI check.
- A check that CI does not run must never refuse what CI accepts. It reports as advice only.
- Each rule carries its own file globs, so the hook needs no path logic.
- Never autofix. Remove the tool's "run with --fix" line from the output.
- When a tool is missing, exit 0, but say on stderr that no guard ran. Silence means "judged and clean".
- Read stdin with a shell builtin, not `cat`. A broken `PATH` must not make the payload read as empty.
- Exit 2 returns stderr to the model. The edit has already happened, so the message tells the model to fix it.
- Call each tool's direct binary. A package-manager wrapper can cost 1 to 7 seconds per call.
- Do not type-check one TypeScript file alone. A single-file check does not see the project config.
- Tests for the hook must write into paths that the rules cover.

## Shell guards

A guard over shell scripts (for example "no script calls X") must parse the shell well enough:

- Join backslash continuations before you read a line.
- Strip `#` comments with quote awareness. A `#` inside a string is not a comment.
- Count invocations at a command position, not mentions in text or heredocs.
- Find the repository root by walking up to a marker file, not by `parents[N]`.
- Set a floor on the number of scripts scanned.
- Prove both directions.

A check must refuse when its tool is missing. In `out="$(jq ... 2>/dev/null || true)"`, a missing `jq` reads as an empty answer, not as an error. Check with `command -v` first, and exit 2 when the tool is absent.
