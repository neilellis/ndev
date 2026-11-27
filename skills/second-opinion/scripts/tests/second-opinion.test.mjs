// Tests for /second-opinion. Run with `node --test tests/*.test.mjs`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { choose, headroom } from "../second-opinion-lib.mjs";

const HERE = import.meta.dirname;
const CLI = path.join(HERE, "..", "second-opinion.mjs");
const FAKE = path.join(HERE, "fake-orca.mjs");
const HOUR = 3_600_000;

const window = (usedPercent, resetsInHours = 2) => ({ usedPercent, windowMinutes: 300, resetsAt: Date.now() + resetsInHours * HOUR });
const limits = ({ codex = [20, 10], claude = [10, 10] } = {}) => ({
  codex: { provider: "codex", status: "ok", session: window(codex[0]), weekly: window(codex[1], 48) },
  claude: { provider: "claude", status: "ok", session: window(claude[0]), weekly: window(claude[1], 48), monthly: null },
  gemini: { provider: "gemini", status: "unavailable", session: null, weekly: null, error: "Gemini CLI OAuth is disabled in settings" },
});

function setup(state) {
  const dir = mkdtempSync(path.join(tmpdir(), "second-opinion-test-"));
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ outcome: "succeeded", report: "## Verdict\nAgree, with one change.", boundRun: null, ...state }));
  writeFileSync(path.join(dir, "calls.jsonl"), "");
  return { dir, env: { ...process.env, ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir, SECOND_OPINION_DIR: dir } };
}

function result(dir, out) {
  const calls = readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bound = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).boundRun;
  return { ...out, calls, bound, called: (cmd) => calls.filter((c) => c.slice(0, cmd.length).join(" ") === cmd.join(" ")) };
}

function run(args, state) {
  const { dir, env } = setup(state);
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return result(dir, { status: out.status, stdout: out.stdout, stderr: out.stderr });
}

async function stopDuringWait(args, state, signal) {
  const { dir, env } = setup(state);
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const closed = new Promise((resolve) => child.on("close", (status, killedBy) => resolve({ status, killedBy })));
  while (!readFileSync(path.join(dir, "calls.jsonl"), "utf8").includes('"check"')) await sleep(50);
  child.kill(signal);
  return result(dir, { ...(await closed), stderr });
}

describe("headroom", () => {
  it("is what is left in the fullest window", () => {
    assert.equal(headroom(limits({ codex: [20, 70] }).codex).percent, 30);
    assert.equal(headroom(limits({ codex: [20, 70] }).codex).window, "weekly");
  });

  it("is unknown for a provider that Orca cannot read", () => {
    assert.equal(headroom(limits().gemini), null);
  });
});

describe("choose", () => {
  it("asks Codex's frontier model at high reasoning when Codex has most of its quota", () => {
    const pick = choose(limits(), { kind: "design" });
    assert.deepEqual([pick.agent, pick.model, pick.effort], ["codex", "gpt-6-astra", "xhigh"]);
  });

  it("steps Codex down to its workhorse model as its quota runs out", () => {
    assert.deepEqual(["model", "effort"].map((k) => choose(limits({ codex: [55, 10] }), { kind: "design" })[k]), ["gpt-6.1-sol", "high"]);
    assert.deepEqual(["model", "effort"].map((k) => choose(limits({ codex: [80, 10] }), { kind: "design" })[k]), ["gpt-6.1-sol", "medium"]);
  });

  it("asks Claude when Codex is below the reserve", () => {
    const pick = choose(limits({ codex: [92, 10], claude: [10, 50] }), { kind: "design" });
    assert.deepEqual([pick.agent, pick.model, pick.effort], ["claude", "sonnet", "high"]);
  });

  it("asks nobody when every agent is below the reserve, and says when quota comes back", () => {
    const pick = choose(limits({ codex: [92, 10], claude: [10, 90] }), { kind: "design" });
    assert.equal(pick.agent, null);
    assert.match(pick.reason, /codex: 8% left in the session window, resets/);
    assert.match(pick.reason, /claude: 10% left in the weekly window, resets/);
  });

  it("keeps to the agents the caller names", () => {
    assert.equal(choose(limits({ codex: [92, 10] }), { kind: "design", agents: ["codex"] }).agent, null);
  });

  it("honours a larger reserve", () => {
    assert.equal(choose(limits({ codex: [70, 10] }), { kind: "design", minHeadroom: 40, agents: ["codex"] }).agent, null);
  });
});

describe("second-opinion CLI", () => {
  it("quota prints each agent's headroom and the pick", () => {
    const r = run(["quota", "--json"], { rateLimits: limits() });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pick.agent, "codex");
    assert.equal(out.agents.codex.percent, 80);
  });

  it("ask starts a read-only Codex worker on its own Run, prints its opinion and releases it", () => {
    const r = run(["ask", "--question", "Is a queue table better than a cron job here?", "--kind", "design"], { rateLimits: limits() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Agree, with one change\./);
    const [start] = r.called(["orchestration", "worker-start"]);
    assert.deepEqual([start[start.indexOf("--agent") + 1], start[start.indexOf("--model") + 1], start[start.indexOf("--run") + 1]], ["codex", "gpt-6-astra", "run_1"]);
    const spec = start[start.indexOf("--spec") + 1];
    assert.match(spec, /Is a queue table better than a cron job here\?/);
    assert.match(spec, /Do not edit, create or delete any file except the report file/);
    assert.deepEqual(r.called(["orchestration", "worker-release"])[0].slice(2, 4), ["--dispatch", "dsp_1"]);
  });

  it("ask starts no worker and exits 3 when no agent has quota to spare", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits({ codex: [95, 10], claude: [95, 10] }) });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /No second opinion: no agent has more than 15% of its quota left/);
    assert.equal(r.called(["orchestration", "worker-start"]).length, 0);
    assert.equal(r.called(["orchestration", "run-create"]).length, 0);
  });

  it("ask shows the agent's own start-up prompt, releases the dead terminal and answers nothing for the user", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), blocked: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Agent startup blocked: agent-hooks-review-prompt at agent_readiness/);
    assert.match(r.stderr, /Hooks need review\n.*5 hooks are new or changed/);
    assert.match(r.stderr, /Repair: start codex yourself in this folder, answer that prompt, then ask again/);
    assert.equal(r.called(["terminal", "send"]).length, 0);
    assert.deepEqual(r.called(["orchestration", "worker-release"])[0].slice(2, 4), ["--dispatch", "dsp_1"]);
  });

  it("ask exits 1 with the worker's summary when the worker reports failure", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), outcome: "failed", report: null });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /worker dsp_1 reported failed: Summary from the worker\./);
    assert.equal(r.called(["orchestration", "worker-release"]).length, 1);
  });

  it("ask exits 1 and names worker-read when the worker settles without a report", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), report: null });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /wrote no report/);
    assert.match(r.stderr, /orchestration worker-read --dispatch dsp_1/);
  });

  it("ask leaves the worker running and exits 4 with the command to keep waiting when the wait ends first", () => {
    const r = run(["ask", "--question", "Is this right?", "--timeout-min", "0.001"], { rateLimits: limits(), outcome: "timeout" });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /second-opinion\.mjs wait --run run_1 --dispatch dsp_1 --out /);
    assert.equal(r.called(["orchestration", "worker-release"]).length, 0);
  });

  it("ask releases nothing and says not to ask again when Orca cannot tell whether the worker started", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), startState: "outcome_unknown" });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /outcome_unknown/);
    assert.match(r.stderr, /Do not ask again/);
    assert.match(r.stderr, /orca orchestration worker-list --run run_1 --json/);
    assert.equal(r.called(["orchestration", "worker-release"]).length, 0);
  });

  it("ask keeps the worker's ids and the wait command when Orca fails after the start", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), outcome: "checkError" });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /runtime_unavailable: the runtime went away/);
    assert.match(r.stderr, /second-opinion\.mjs wait --run run_1 --dispatch dsp_1 --out /);
  });

  it("ask stops waiting with the worker's next action when Orca shows the worker exited without a report", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), outcome: "dead" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /worker dsp_1 exited \(process_exit\) and sent no worker_done/);
    assert.match(r.stderr, /orca orchestration worker-release --dispatch dsp_1/);
  });

  it("ask answers an escalation and keeps waiting for the report", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), outcome: "escalate" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Agree, with one change\./);
    assert.deepEqual(r.called(["orchestration", "reply"])[0].slice(2, 4), ["--id", "msg_0"]);
  });

  it("ask fails with the repair, not a skip, when Orca cannot read any agent's usage", () => {
    const unread = { codex: { status: "unavailable", error: "Not signed in to Codex" }, claude: { status: "unavailable", error: "Not signed in to Claude" } };
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: unread });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /codex: usage unknown \(Not signed in to Codex\)/);
    assert.match(r.stderr, /orca account list --json/);
    assert.equal(run(["ask", "--question", "Is this right?"], {}).status, 1);
  });

  it("ask refuses an --out file that already exists", () => {
    const old = path.join(mkdtempSync(path.join(tmpdir(), "second-opinion-old-")), "opinion.md");
    writeFileSync(old, "an old opinion");
    const r = run(["ask", "--question", "Is this right?", "--out", old], { rateLimits: limits() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /already exists/);
  });

  it("ask prints no file but its own report file, whatever path the worker names", () => {
    const other = path.join(mkdtempSync(path.join(tmpdir(), "second-opinion-other-")), "secret.md");
    writeFileSync(other, "not the opinion");
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), report: null, payloadReportPath: other });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /not the opinion/);
  });

  it("ask waits for its worker while its own Run is bound, then binds the caller's own Run again", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), boundRun: "run_mine" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Agree, with one change\./);
    assert.deepEqual(r.called(["orchestration", "run-use"]).map((c) => c[c.indexOf("--id") + 1]), ["run_1", "run_mine"]);
    assert.equal(r.bound, "run_mine");
  });

  it("ask stops with exit 1 and names the reply when Orca's run-current reply has no run", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits(), boundRun: "run_mine", runCurrent: { runId: "run_mine" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /orca orchestration run-current answered no run, so the bound Run is unknown.*\{"runId":"run_mine"\}/);
    assert.equal(r.called(["orchestration", "run-create"]).length, 0);
    assert.equal(r.bound, "run_mine");
  });

  for (const [outcome, status, extra] of [["failed", 1, []], ["timeout", 4, ["--timeout-min", "0.001"]], ["checkError", 4, []]]) {
    it(`ask binds the caller's own Run again when the worker ends ${outcome}`, () => {
      const r = run(["ask", "--question", "Is this right?", ...extra], { rateLimits: limits(), boundRun: "run_mine", outcome, report: null });
      assert.equal(r.status, status, r.stderr);
      assert.doesNotMatch(r.stderr, /consumer_fenced/);
      assert.equal(r.bound, "run_mine");
    });
  }

  const waitArgs = (dir) => ["wait", "--run", "run_1", "--dispatch", "dsp_1", "--out", path.join(dir, "opinion.md")];
  const waitDir = () => mkdtempSync(path.join(tmpdir(), "second-opinion-wait-"));

  it("wait binds its Run for the wait from a terminal bound to another Run, then binds the earlier Run again", () => {
    const dir = waitDir();
    const r = run(waitArgs(dir), { boundRun: "run_mine", reportPath: path.join(dir, "opinion.md") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Agree, with one change\./);
    assert.equal(r.bound, "run_mine");
  });

  for (const [outcome, status, extra] of [["failed", 1, []], ["timeout", 4, ["--timeout-min", "0.001"]], ["checkError", 4, []]]) {
    it(`wait binds the earlier Run again when the wait ends ${outcome}`, () => {
      const dir = waitDir();
      const r = run([...waitArgs(dir), ...extra], { boundRun: "run_mine", reportPath: path.join(dir, "opinion.md"), outcome, report: null });
      assert.equal(r.status, status, r.stderr);
      assert.doesNotMatch(r.stderr, /consumer_fenced/);
      assert.equal(r.bound, "run_mine");
    });
  }

  it("a consumer_fenced refusal names run-use for the Run, not starting Orca", () => {
    const dir = waitDir();
    const r = run(waitArgs(dir), { boundRun: "run_mine", fencedBy: "run_elsewhere", reportPath: path.join(dir, "opinion.md") });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /consumer_fenced: This caller is bound to Run run_elsewhere, not Run run_1\./);
    assert.match(r.stderr, /Repair: orca orchestration run-use --id run_1 --json/);
    assert.doesNotMatch(r.stderr, /start the Orca app/);
    assert.equal(r.bound, "run_mine");
  });

  it("wait from a terminal already bound to its Run binds nothing", () => {
    const dir = waitDir();
    const r = run(waitArgs(dir), { boundRun: "run_1", reportPath: path.join(dir, "opinion.md") });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.called(["orchestration", "run-use"]).length, 0);
    assert.equal(r.bound, "run_1");
  });

  it("ask from a terminal with no bound Run says that its Run stays bound", () => {
    const r = run(["ask", "--question", "Is this right?"], { rateLimits: limits() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /This terminal stays bound to Run run_1\./);
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    it(`ask stopped by ${signal} during the wait binds the caller's own Run again`, async () => {
      const r = await stopDuringWait(["ask", "--question", "Is this right?", "--timeout-min", "5"], { rateLimits: limits(), boundRun: "run_mine", outcome: "hang" }, signal);
      assert.equal(r.bound, "run_mine");
      assert.equal(r.status, 128 + constants.signals[signal], `killed by ${r.killedBy}; ${r.stderr}`);
      assert.match(r.stderr, /If this process is stopped, bind your Run again: orca orchestration run-use --id run_mine --json/);
    });
  }
});
