#!/usr/bin/env node
// A stand-in for the `orca` CLI. It answers from $FAKE_ORCA_DIR/state.json and logs each call to calls.jsonl.
// state.json: { rateLimits, outcome: "succeeded"|"failed"|"timeout"|"dead"|"escalate"|"checkError", report: "<text>"|null,
//   boundRun: "<id>"|null, blocked, startState, payloadReportPath }
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_ORCA_DIR;
const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
const args = process.argv.slice(2);
appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\n");
const flag = (name) => args[args.indexOf(name) + 1];
const reply = (result) => console.log(JSON.stringify({ id: "x", ok: true, result }));
const save = () => writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
const command = args.filter((a) => !a.startsWith("--")).slice(0, 2).join(" ");
// As Orca 1.4 does: with no --full, an orchestration command prints a concise view with other keys.
if (command.startsWith("orchestration ") && !args.includes("--full")) {
  console.log(JSON.stringify({ id: "x", ok: true, result: { runId: null, concise: true } }));
  process.exit(0);
}

switch (command) {
  case "status":
    reply({ runtime: { state: "ready", reachable: true } });
    break;
  case "account list":
    reply({ rateLimits: state.rateLimits });
    break;
  case "orchestration run-current":
    reply({ run: state.boundRun ? { id: state.boundRun } : null });
    break;
  case "orchestration run-create":
    reply({ run: { id: "run_1" } });
    break;
  case "orchestration run-use":
    reply({ run: { id: flag("--id") } });
    break;
  case "orchestration worker-start": {
    state.reportPath = /^Report file: (.+)$/m.exec(flag("--spec"))[1];
    save();
    if (state.startState === "outcome_unknown") {
      reply({ state: "outcome_unknown", dispatchId: "dsp_1", failedStage: "agent_readiness", lastError: "readiness_timeout", residualResources: [{ kind: "terminal", id: "term_1" }] });
      process.exit(1);
    }
    if (state.blocked) {
      reply({ state: "failed", dispatchId: "dsp_1", failedStage: "agent_readiness", lastError: "Agent startup blocked: agent-hooks-review-prompt", recovery: "Close it with: orca orchestration worker-release --dispatch dsp_1", effects: [{ kind: "terminal", role: "agent", id: "term_1" }] });
      process.exit(1);
    }
    reply({ state: "ready", dispatchId: "dsp_1", effects: [{ kind: "terminal", role: "agent", id: "term_1" }], launch: { effective: { model: flag("--model"), effort: flag("--effort") } } });
    break;
  }
  case "orchestration check": {
    if (args.includes("--ack")) {
      reply({ deliveryId: null, messages: [] });
      break;
    }
    if (state.outcome === "checkError") {
      console.log(JSON.stringify({ id: "x", ok: false, error: { code: "runtime_unavailable", message: "the runtime went away" } }));
      process.exit(1);
    }
    if (state.outcome === "escalate" && !state.escalated) {
      state.escalated = true;
      save();
      reply({ deliveryId: "dlv_0", messages: [{ id: "msg_0", from_handle: "term_1", type: "escalation", body: "I am stuck.", payload: JSON.stringify({ dispatchId: "dsp_1" }) }] });
      break;
    }
    if (state.outcome === "timeout" || state.outcome === "dead") {
      reply({ deliveryId: null, messages: [], timedOut: true });
      break;
    }
    if (state.report !== null) writeFileSync(state.reportPath, state.report);
    const outcome = state.outcome === "escalate" ? "succeeded" : state.outcome;
    const payload = JSON.stringify({ taskId: "task_1", dispatchId: "dsp_1", outcome, reportPath: state.payloadReportPath });
    reply({ deliveryId: "dlv_1", messages: [{ id: "msg_1", from_handle: "term_1", type: "worker_done", body: "Summary from the worker.", payload }] });
    break;
  }
  case "terminal read":
    reply({ terminal: { tail: ["  Hooks need review", "  5 hooks are new or changed.", "› 1. Review hooks"] } });
    break;
  case "orchestration reply":
    reply({ id: "msg_reply" });
    break;
  case "orchestration worker-list": {
    const verdict = state.outcome === "dead" ? "exited" : "live";
    reply({ workers: [{ dispatchId: "dsp_1", projection: { liveness: { verdict, source: verdict === "exited" ? "process_exit" : "heartbeat" }, nextAction: { kind: "release", argv: ["orchestration", "worker-release", "--dispatch", "dsp_1"] } } }] });
    break;
  }
  case "orchestration worker-release":
    reply({ state: "released" });
    break;
  default:
    console.log(JSON.stringify({ id: "x", ok: false, error: { code: "unknown_command", message: args.join(" ") } }));
    process.exit(1);
}
