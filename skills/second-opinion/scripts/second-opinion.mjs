#!/usr/bin/env node
// Get a second opinion from another agent through Orca orchestration. The agent and its model follow the quota that
// Orca reports for each provider.
//
// Usage:
//   node second-opinion.mjs quota [--kind <kind>] [--agent <agent>]... [--min-headroom <n>] [--json]
//   node second-opinion.mjs ask (--question <text> | --question-file <path>) [--kind design|code|plan|general]
//        [--context <path>]... [--agent codex|claude]... [--min-headroom <n>] [--timeout-min <n>] [--out <path>]
//        [--worktree <selector>] [--dry-run] [--json]
//   node second-opinion.mjs wait --run <run_id> --dispatch <dispatch_id> --out <path> [--timeout-min <n>] [--json]
//
// quota   prints what each agent has left and the agent that `ask` would use.
// ask     starts one read-only worker on its own Orca Run, waits for its report and prints it.
// wait    keeps waiting for a worker that `ask` started, after `ask` exited 4.
//
// --kind          what to judge (default: design). design and plan get the deepest reasoning.
// --context       a file the worker reads first. Repeat for more files.
// --agent         the agents to consider, in order (default: codex, then claude).
// --min-headroom  the percent of quota to leave for the agent's own work (default: 15).
// --timeout-min   how long to wait for the report (default: 30).
// --out           the report file (default: a new file in $SECOND_OPINION_DIR, else <tmp>/ndev-second-opinion).
// --worktree      the Orca worktree the worker reads (default: current).
// --dry-run       print the choice and the worker's Task spec, and start nothing.
//
// Exit codes:
//   0  the opinion is printed (ask, wait), or the quota is printed (quota)
//   1  failed: see the message, which names the repair
//   2  usage error
//   3  skipped: no agent has quota to spare; carry on without a second opinion
//   4  still waiting: the worker runs on; the message gives the `wait` command
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENTS, DEFAULT_AGENTS, DEFAULT_MIN_HEADROOM, KINDS, choose, describe, headroom, spec } from "./second-opinion-lib.mjs";

const ORCA = process.env.ORCA_BIN || "orca";
const SELF = import.meta.filename;
const START_ORCA = "\nRepair: start the Orca app (`orca open`) and check it with `orca status`.";
const MESSAGE_TYPES = "worker_done,escalation,question";
const WAIT_SLICE_MS = 300_000;
const NO_QUESTIONS = "No more context is available. State your assumption, continue, and put the assumption in the report.";
const NO_HELP = "No help is available. Put what blocks you in the report under ## Risks, finish the report from what you can read, and send worker_done. If you cannot write the report, send worker_done with --outcome failed.";
// Orca's orchestration contract: after three empty waits, look at the worker instead of waiting blindly.
const EMPTY_WAITS_BEFORE_LOOK = 3;

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const note = (text) => process.stderr.write(`${text}\n`);
const firstLine = (text) => String(text).trim().split("\n")[0];

// Runs one Orca CLI command with --json and answers its result. A failure names the command and Orca's own error.
function orca(args, { timeoutMs = 120_000 } = {}) {
  const what = `orca ${args.slice(0, 2).join(" ")}`;
  const r = spawnSync(ORCA, [...args, "--json"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Exit(1, `${what} could not run: ${r.error.message}${START_ORCA}`);
  let reply;
  try {
    reply = JSON.parse(r.stdout);
  } catch {
    throw new Exit(1, `${what} exited ${r.status} and printed no JSON: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}${START_ORCA}`);
  }
  if (reply?.ok !== true) {
    const e = reply?.error;
    const steps = Array.isArray(e?.data?.nextSteps) ? e.data.nextSteps.join("\n") : "";
    throw new Exit(1, `${what} refused: ${e?.code ?? ""}: ${e?.message ?? JSON.stringify(reply).slice(0, 500)}${steps ? `\nRepair: ${steps}` : START_ORCA}`);
  }
  return reply.result;
}

function parseArgs(argv) {
  const o = { command: argv[0], kind: "design", context: [], agents: [], minHeadroom: DEFAULT_MIN_HEADROOM, timeoutMin: 30, worktree: "current", json: false, dryRun: false };
  const value = (i, name) => {
    if (i >= argv.length || argv[i].startsWith("--")) throw new Exit(2, `${name} needs a value`);
    return argv[i];
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--question") o.question = value(++i, a);
    else if (a === "--question-file") o.questionFile = value(++i, a);
    else if (a === "--kind") o.kind = value(++i, a);
    else if (a === "--context") o.context.push(value(++i, a));
    else if (a === "--agent") o.agents.push(...value(++i, a).split(","));
    else if (a === "--min-headroom") o.minHeadroom = Number(value(++i, a));
    else if (a === "--timeout-min") o.timeoutMin = Number(value(++i, a));
    else if (a === "--out") o.out = value(++i, a);
    else if (a === "--worktree") o.worktree = value(++i, a);
    else if (a === "--run") o.run = value(++i, a);
    else if (a === "--dispatch") o.dispatch = value(++i, a);
    else if (a === "--json") o.json = true;
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Exit(2, `unknown option ${a}`);
  }
  if (!["quota", "ask", "wait"].includes(o.command)) throw new Exit(2, `the first argument is quota, ask or wait, not ${o.command ?? "nothing"}`);
  if (!KINDS.includes(o.kind)) throw new Exit(2, `--kind is one of ${KINDS.join(", ")}, not ${o.kind}`);
  if (!o.agents.length) o.agents = DEFAULT_AGENTS;
  const unknown = o.agents.filter((a) => !AGENTS[a]);
  if (unknown.length) throw new Exit(2, `--agent ${unknown.join(", ")} is not known; use ${Object.keys(AGENTS).join(" or ")}`);
  if (!(o.minHeadroom >= 0 && o.minHeadroom < 100)) throw new Exit(2, "--min-headroom is a percent from 0 to 99");
  if (!(o.timeoutMin > 0)) throw new Exit(2, "--timeout-min is a number of minutes above 0");
  return o;
}

// Each provider's rate limits. An Orca that reports none cannot choose an agent, so that is a failure, not a skip.
function rateLimits() {
  const limits = orca(["account", "list"]).rateLimits;
  if (!limits || typeof limits !== "object") {
    throw new Exit(1, "orca account list reports no rateLimits, so no agent can be chosen.\nRepair: update Orca, then check that `orca account list --json` shows rateLimits.");
  }
  return limits;
}

function quota(o) {
  const limits = rateLimits();
  const pick = choose(limits, { kind: o.kind, agents: o.agents, minHeadroom: o.minHeadroom });
  const agents = Object.fromEntries(Object.keys(AGENTS).map((a) => [a, headroom(limits[AGENTS[a].key])]));
  if (o.json) console.log(JSON.stringify({ agents, pick, minHeadroom: o.minHeadroom }, null, 2));
  else {
    for (const a of Object.keys(AGENTS)) console.log(describe(a, limits[AGENTS[a].key]));
    console.log(pick.agent ? `ask uses ${pick.agent} (${pick.model}, ${pick.effort})` : `ask skips: no agent has more than ${o.minHeadroom}% left`);
  }
  return limits;
}

function question(o) {
  if (o.question && o.questionFile) throw new Exit(2, "give --question or --question-file, not both");
  if (o.questionFile) return readFileSync(o.questionFile, "utf8");
  if (o.question) return o.question;
  throw new Exit(2, "ask needs --question <text> or --question-file <path>");
}

function reportFile(o, kind) {
  // The worker writes this file, and the helper prints it, so an older file must never stand in for the opinion.
  if (o.out) {
    if (existsSync(o.out)) throw new Exit(2, `--out ${o.out} already exists; name a new file`);
    return path.resolve(o.out);
  }
  const dir = process.env.SECOND_OPINION_DIR || path.join(tmpdir(), "ndev-second-opinion");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.md`);
}

function ask(o) {
  const text = question(o);
  const contextFiles = o.context.map((f) => path.resolve(f));
  const missing = contextFiles.filter((f) => !existsSync(f));
  if (missing.length) throw new Exit(2, `--context file not found: ${missing.join(", ")}`);
  const status = orca(["status"]);
  if (!status?.runtime?.reachable) throw new Exit(1, `Orca's runtime is not reachable (state: ${status?.runtime?.state ?? "unknown"}).${START_ORCA}`);
  const limits = rateLimits();
  const pick = choose(limits, { kind: o.kind, agents: o.agents, minHeadroom: o.minHeadroom });
  if (!pick.agent && o.agents.every((a) => !headroom(limits[AGENTS[a].key]))) {
    throw new Exit(1, `No second opinion: Orca cannot read the usage of ${o.agents.join(" or ")}. ${pick.reason}.\nRepair: sign in to each agent's CLI, then check with \`orca account list --json\`.`);
  }
  if (!pick.agent) {
    throw new Exit(3, `No second opinion: no agent has more than ${o.minHeadroom}% of its quota left. ${pick.reason}.\nCarry on without one, or ask again after a reset. --min-headroom <n> changes the reserve.`);
  }
  const reportPath = reportFile(o, o.kind);
  const taskSpec = spec({ question: text, kind: o.kind, contextFiles, reportPath });
  note(`Asking ${pick.agent} (${pick.model}, ${pick.effort}) for a ${o.kind} second opinion. ${pick.reason}.`);
  if (o.dryRun) {
    console.log(JSON.stringify({ pick, reportPath, spec: taskSpec }, null, 2));
    return;
  }

  const previous = orca(["orchestration", "run-current"])?.run?.id ?? null;
  let runId, start;
  try {
    runId = orca(["orchestration", "run-create", "--objective", `Second opinion (${o.kind}): ${firstLine(text).slice(0, 80)}`]).run.id;
    // worker-start prints its receipt with `ok: true` even when the start failed, so the receipt's state decides.
    try {
      start = orca([
        "orchestration", "worker-start", "--spec", taskSpec, "--task-title", `Second opinion: ${firstLine(text).slice(0, 60)}`,
        "--run", runId, "--worktree", o.worktree, "--agent", pick.agent, "--model", pick.model, "--effort", pick.effort, "--timeout-ms", "120000",
      ], { timeoutMs: 180_000 });
    } catch (err) {
      // The call can fail after Orca started the worker, so the worker may run.
      if (err instanceof Exit) throw new Exit(4, `${err.message}\n${mayRun(runId)}`);
      throw err;
    }
  } finally {
    if (previous && previous !== runId) rebind(previous);
  }
  if (start.state === "failed") failedStart(start, runId, pick.agent);
  if (start.state !== "ready") {
    throw new Exit(4, [
      `orca orchestration worker-start for the second opinion ended ${start.state} at ${start.failedStage ?? "an unknown stage"}: ${start.lastError ?? "no error given"}.`,
      ...(start.residualResources?.length ? [`Resources it may hold: ${JSON.stringify(start.residualResources)}`] : []),
      ...(start.recovery ? [`Orca's recovery: ${start.recovery}`] : []),
      mayRun(runId),
      ...(start.dispatchId ? [`If it runs, keep waiting: ${waitCommand(runId, start.dispatchId, reportPath)}`] : []),
    ].join("\n"));
  }
  note(`Worker ${start.dispatchId} started on Run ${runId}. Report file: ${reportPath}`);
  wait({ ...o, run: runId, dispatch: start.dispatchId, out: reportPath }, pick);
}

const waitCommand = (run, dispatch, out) => `node ${SELF} wait --run ${run} --dispatch ${dispatch} --out ${out}`;
const mayRun = (run) => `The worker may be running. Do not ask again. Inspect it: orca orchestration worker-list --run ${run} --json`;

// A start that failed never ran the Task. The agent's own screen says why: a prompt such as Codex's "Hooks need
// review" is the user's decision, so it is shown and never answered here. Orca's next action is to release the terminal.
function failedStart(start, runId, agent) {
  const terminal = start.effects?.find((x) => x.kind === "terminal" && x.role === "agent")?.id;
  let screen = "";
  if (terminal) {
    try {
      screen = (orca(["terminal", "read", "--terminal", terminal]).terminal?.tail ?? []).join("\n").trimEnd();
    } catch (err) {
      screen = `(the agent's screen could not be read: ${firstLine(err.message)})`;
    }
  }
  if (start.dispatchId) release(start.dispatchId);
  const prompt = /prompt|blocked/i.test(start.lastError ?? "");
  throw new Exit(1, [
    `orca orchestration worker-start for the second opinion failed: ${start.lastError ?? start.state} at ${start.failedStage ?? "an unknown stage"}.`,
    ...(screen ? ["The agent's screen:", screen] : []),
    prompt
      ? `Repair: start ${agent} yourself in this folder, answer that prompt, then ask again. Or use another agent with --agent.`
      : `Repair: ${start.recovery ?? `inspect the Run: orca orchestration worker-list --run ${runId} --json`}`,
    ...(start.residualResources?.length ? [`Resources it may hold: ${JSON.stringify(start.residualResources)}`] : []),
  ].join("\n"));
}

// A coordinator's later plain `check` uses its bound Run, so the caller's own Run is bound again.
function rebind(previous) {
  try {
    orca(["orchestration", "run-use", "--id", previous]);
  } catch (err) {
    note(`Warning: this terminal was coordinating Run ${previous}, and binding it again failed: ${err.message}\nRepair: orca orchestration run-use --id ${previous} --json`);
  }
}

function wait(o, pick) {
  if (!o.run || !o.dispatch || !o.out) throw new Exit(2, "wait needs --run, --dispatch and --out");
  const runsOn = `Worker ${o.dispatch} runs on, on Run ${o.run}.\nKeep waiting: ${waitCommand(o.run, o.dispatch, o.out)}\nWatch it: orca orchestration worker-read --dispatch ${o.dispatch} --source auto --json`;
  // An Orca failure here says nothing about the worker, so the caller gets the ids to wait again, never "ask again".
  const call = (args, opts) => {
    try {
      return orca(args, opts);
    } catch (err) {
      if (err instanceof Exit) throw new Exit(4, `${err.message}\n${runsOn}`);
      throw err;
    }
  };
  const deadline = Date.now() + o.timeoutMin * 60_000;
  let empty = 0;
  let liveness = "not checked";
  for (;;) {
    const slice = Math.max(1000, Math.min(deadline - Date.now(), WAIT_SLICE_MS));
    const got = call(["orchestration", "check", "--run", o.run, "--wait", "--types", MESSAGE_TYPES, "--timeout-ms", String(slice)], { timeoutMs: slice + 60_000 });
    let settled;
    for (const m of got.messages ?? []) {
      const payload = m.payload ? JSON.parse(m.payload) : {};
      if (payload._orcaLifecycleRejection) {
        note(`Orca rejected a ${m.type} from ${m.from_handle}: ${payload._orcaLifecycleRejection.code ?? ""} ${payload._orcaLifecycleRejection.reason ?? ""}`);
      } else if (payload.dispatchId && payload.dispatchId !== o.dispatch) {
        note(`Ignored a ${m.type} from another worker (${payload.dispatchId}) on Run ${o.run}.`);
      } else if (m.type === "question") {
        call(["orchestration", "reply", "--id", m.id, "--run", o.run, "--body", NO_QUESTIONS]);
      } else if (m.type === "escalation") {
        // An escalation does not settle the worker. Nobody can help it, so it is told to finish what it can.
        note(`The worker escalated: ${m.body}\nIt was told to finish the report without help.`);
        call(["orchestration", "reply", "--id", m.id, "--run", o.run, "--body", NO_HELP]);
      } else if (m.type === "worker_done") {
        settled = { outcome: payload.outcome, body: m.body };
      }
    }
    if (got.deliveryId) call(["orchestration", "check", "--run", o.run, "--ack", got.deliveryId]);
    if (settled) return settle(o, settled, pick);
    empty = got.messages?.length ? 0 : empty + 1;
    if (empty >= EMPTY_WAITS_BEFORE_LOOK) {
      empty = 0;
      liveness = look(o, call);
    }
    if (Date.now() >= deadline) {
      throw new Exit(4, `The second opinion is not ready after ${o.timeoutMin} min (Orca's liveness verdict: ${liveness}).\n${runsOn}`);
    }
  }
}

// Orca's liveness verdict for the worker. Only `exited` proves that no report comes; any other verdict means wait.
function look(o, call) {
  const row = (call(["orchestration", "worker-list", "--run", o.run]).workers ?? []).find((w) => w.dispatchId === o.dispatch);
  const live = row?.projection?.liveness;
  if (!live) return "unknown: the worker is not in Orca's list";
  const why = live.reason ?? live.source ?? "no reason given";
  if (live.verdict !== "exited") return `${live.verdict} (${why})`;
  const argv = row.projection.nextAction?.argv ?? [];
  const next = argv.length ? `${argv[0] === "orca" ? "" : "orca "}${argv.join(" ")}` : "none";
  throw new Exit(1, `The second-opinion worker ${o.dispatch} exited (${why}) and sent no worker_done, so no opinion comes.\nRead its screen: orca orchestration worker-read --dispatch ${o.dispatch} --source auto --json\nOrca's next action: ${next}`);
}

function settle(o, s, pick) {
  const read = `orca orchestration worker-read --dispatch ${o.dispatch} --source auto --json`;
  // Only the file that the helper named is the opinion. A path in the worker's message is never read.
  const report = existsSync(o.out) ? o.out : null;
  release(o.dispatch);
  if (s.outcome !== "succeeded") throw new Exit(1, `The second-opinion worker ${o.dispatch} reported ${s.outcome ?? "no outcome"}: ${s.body}\nRead its output: ${read}`);
  if (!report) throw new Exit(1, `The second-opinion worker ${o.dispatch} settled but wrote no report at ${o.out}. Its summary: ${s.body}\nRead its output: ${read}`);
  const text = readFileSync(report, "utf8");
  if (o.json) console.log(JSON.stringify({ agent: pick?.agent, model: pick?.model, effort: pick?.effort, run: o.run, dispatch: o.dispatch, reportPath: report, summary: s.body, report: text }, null, 2));
  else {
    note(`Second opinion${pick ? ` from ${pick.agent} (${pick.model}, ${pick.effort})` : ""}, saved at ${report}:`);
    console.log(text);
  }
}

// Release is post-settlement cleanup. A failure leaves the opinion valid, so it is a warning with its repair.
function release(dispatch) {
  try {
    orca(["orchestration", "worker-release", "--dispatch", dispatch]);
  } catch (err) {
    note(`Warning: releasing worker ${dispatch} failed: ${err.message}\nRepair: orca orchestration worker-release --dispatch ${dispatch} --json`);
  }
}

try {
  const o = parseArgs(process.argv.slice(2));
  if (o.command === "quota") quota(o);
  else if (o.command === "ask") ask(o);
  else wait(o);
} catch (err) {
  if (!(err instanceof Exit)) throw err;
  note(err.message);
  process.exit(err.code);
}
