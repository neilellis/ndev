---
name: requirements-model
description: "Write a Quint model of the requirements that suit one, with a manifest that ties its actions to the code, and check it with mutants, witnesses and a drift check. Use when a requirement is about state, order or concurrency, when model-check fails or reports drift, or when the user says model the requirements, Quint model, model manifest, model-check or model-pin."
---

# Model the requirements

The records are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md`. Read the sections "Models" and "Model manifests" first. The manifest, its keys and the checks are there.

Use the `quint-modeling` skill to write the model, and the `quint-lang` skill for the language. The section "Install the Quint skills" of that page tells what to do when they are not installed.

The commands are `ndev requirements <command>`. Run them from the project.

| Command | What it does |
|---|---|
| `ndev requirements model-check [<manifest>...]` | Checks each manifest, or the named ones. Runs the project's own `node_modules/.bin/quint`. |
| `ndev requirements model-pin <manifest>...` | Writes the pin of each code reference, with the commit. |

## Choose the requirements

1. List the records with `ndev requirements list`, and search them with `ndev requirements search <words>`.
2. Choose records about state, order or concurrency, where a test cannot show all the cases. A fixed fact, a layout or a word on a page needs no model.
3. Choose records about the same state. One model covers one small part of the system.
4. Read the code that implements them. Use the `- File:` lines of each Trace.
5. Tell the human which records you chose, and why you left out the others.

## Write the model

1. Write `docs/formal/models/<name>.qnt`. Name each record ID in a comment at the part that specifies it.
2. Write one action for each step that the code takes. Give the model each path that the code has, also the failure paths.
3. Write one invariant for each property that a record states. Write a witness for each state that the model must reach, so that an invariant cannot pass because nothing happens. Each is a `val` or `pure val` that the main module declares. That module also declares `init` and `step`. The model must move: when `step` never fires, `model-check` does not accept an invariant.
4. Write the tests in `<name>_test.qnt`, as runs with names that end in `Test`.
5. Add the model to each record with `ndev requirements model <REQ-NNNN> docs/formal/models/<name>.qnt`.

## Write the manifest

Write `docs/formal/models/<name>.json`. Leave out each `pin`.

- **assumptions**: what the model takes as given, for example "one process writes the file". State each one that the code does not enforce.
- **bounds**: the steps, the samples and the seed of the search. In `limits`, say what the model does not cover.
- **mutants**: at least one for each invariant. A mutant copies a possible fault of the code, such as a guard that is removed. Say the fault in `why`. It changes an action, a guard or a value that `init` or `step` uses. It cannot change an invariant, a witness or a definition that only they use. It cannot add, remove or rename a definition, or change only comments. "Model manifests" gives the full rule.
- **actions**: each action of the model. Cite the smallest lines that do what the action says. Give `none` with the reason only when no code stands behind the action.

## Check, then pin

1. Run `ndev requirements model-check docs/formal/models/<name>.json`. The first run fails, because no reference has a pin. Correct each other failure.
2. **Do not make a check pass by making it weaker.** A mutant that survives shows a weak invariant, or a fault that the model cannot reach. A violated invariant can show a bug in the code: report it to the human.
3. Commit the cited code. `model-pin` refuses cited lines that do not match the last commit. Cite the real file, not a link.
4. **Read the cited lines against each action, one action at a time.** Compare the guard, each change of state and each failure path. When they differ, correct the model or report the bug.
5. Only after that, run `ndev requirements model-pin docs/formal/models/<name>.json`. A pin says that an agent read these lines against the action. Never run it only to remove a failure.
6. Run `ndev requirements model-check` and `ndev requirements check` again. Commit the model, the manifest and the records.

## Drift

When the cited lines changed, read the new code against the action. When the message gives new line numbers, put them in `lines`. Read the lines at the new place too.

When the behaviour changed, change the model first. Ask the human about a record that no longer holds. Then commit the code, run `model-pin` and run `model-check`.

## Finish

Report to the human the records in the model, and the counts and bounds that `model-check` printed. Give the assumptions, the limits, and each place where the code and a record differ. Say that the result is a bounded random search, not an exhaustive proof.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.

## The workflow

While a workflow runs, this skill is one step of the current stage. Read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
