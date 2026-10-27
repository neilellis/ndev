#!/usr/bin/env node
// Run one round of the video finish loop: push, wait for the pull request checks and the preview deployment, then decide.
//
// Usage (from the video project's folder):
//   node finish.mjs [--base <branch>] [--repo <owner/repo>] [--title <text> --body-file <path>] [--scene <n|credits>]... [--restart]
//
// --base               the branch the pull request merges into (default: main)
// --repo               the GitHub repository (default: GH_REPO, else `gh repo view`)
// --title/--body-file  open a draft pull request when the branch has none
// --scene              a scene the change affects (changed scenes are also found from the diff)
// --restart            reset the round count after the user has made a decision
//
// Lines starting with "[agent]" are for the agent. Show every other line to the user as written.
//
// Exit codes:
//   0  ready: green, mergeable, preview ready, marked ready for review
//   1  fix needed: fix the failures listed, commit, and run again
//   2  cannot start: see the message (for example, uncommitted work or no pull request title)
//   3  stopped: round limit, repeated failure or a blocker; tell the user
//   4  still waiting after the bounded wait; run again
import { spawnSync } from "node:child_process";
import { setTimeout as sleepFor } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_ROUNDS, blockedMessage, evaluate, failureSignature, firstErrorLine, nextRound, readyMessage, scenesForChanges, sortScenes } from "./finish-lib.mjs";

const HERE = import.meta.dirname;
const WAITER = path.resolve(realpathSync(HERE), "../../../scripts/github/wait-for-pr-change.sh");
const PUSH = path.join(HERE, "push-checked.sh");
const SETTLE_TRIES = 12;
const SETTLE_SECONDS = 10;
const env = { ...process.env };
delete env.GITHUB_TOKEN;
let ROOT = process.cwd();
let REPO = "";
let BASE = "main";

const say = (text = "") => console.log(text);
const agent = (text) => console.log(`[agent] ${text}`);

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function must(command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

const ghJson = (args) => JSON.parse(must("gh", args));
const sleep = (seconds) => sleepFor(seconds * 1000);

function parseArgs(argv) {
  const options = { scenes: [], restart: false, title: "", bodyFile: "", base: "main", repo: process.env.GH_REPO ?? "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--restart") options.restart = true;
    else if (arg === "--scene") options.scenes.push(argv[++i] ?? "");
    else if (arg === "--title") options.title = argv[++i] ?? "";
    else if (arg === "--body-file") options.bodyFile = argv[++i] ?? "";
    else if (arg === "--base") options.base = argv[++i] ?? "";
    else if (arg === "--repo") options.repo = argv[++i] ?? "";
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (!options.base) throw new Error("--base needs a branch name");
  if (options.scenes.some((scene) => !/^(\d+|credits)$/.test(scene))) throw new Error("--scene values must be a scene number or credits");
  return options;
}

const PR_FIELDS = "number,url,state,isDraft,mergeable,mergeStateStatus,headRefOid,statusCheckRollup";
function findPr(branch) {
  const result = run("gh", ["pr", "view", branch, "--repo", REPO, "--json", PR_FIELDS]);
  if (result.status !== 0) return null;
  const pr = JSON.parse(result.stdout);
  return pr.state === "OPEN" ? pr : null;
}

function findPreview(sha) {
  const deployments = ghJson(["api", `repos/${REPO}/deployments?sha=${sha}`]);
  const deployment = deployments.find((item) => item.environment !== "Production");
  if (!deployment) return null;
  const [status] = ghJson(["api", `repos/${REPO}/deployments/${deployment.id}/statuses`]);
  return status ? { state: status.state, url: status.environment_url || status.target_url || "" } : { state: "pending", url: "" };
}

function stop(prUrl, reasons, code = 3) {
  say(blockedMessage({ prUrl, reasons }));
  process.exit(code);
}

function usage() {
  const lines = readFileSync(import.meta.filename, "utf8").split("\n").slice(1, 20);
  console.log(lines.map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const top = run("git", ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    agent(`Not a git checkout: ${process.cwd()}. Run this script from the video project's folder.`);
    process.exit(2);
  }
  ROOT = top.stdout.trim();
  BASE = options.base;
  REPO = options.repo || run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).stdout.trim();
  if (!REPO) {
    agent("Cannot find the GitHub repository. Run `gh auth status`, or pass --repo <owner/repo> or set GH_REPO.");
    process.exit(2);
  }
  if (!existsSync(WAITER)) {
    agent(`The pull request waiter is missing: ${WAITER}. Repair: reinstall the neil-development plugin (claude plugin update neil-development); it ships scripts/github/ at its root.`);
    process.exit(2);
  }
  const branch = must("git", ["branch", "--show-current"]);
  if (!branch || branch === BASE) {
    agent(`Create a new branch from current ${BASE} before finishing. This script never pushes ${BASE}.`);
    process.exit(2);
  }
  if (must("git", ["status", "--porcelain"])) {
    agent("Commit the remaining work with the required trailers, then run this script again.");
    process.exit(2);
  }

  const stateDir = path.join(must("git", ["rev-parse", "--absolute-git-dir"]), "video-finish");
  const stateFile = path.join(stateDir, `${branch.replace(/[^\w.-]/g, "_")}.json`);
  mkdirSync(stateDir, { recursive: true });
  let state = { rounds: 0, lastSignature: "" };
  if (options.restart) rmSync(stateFile, { force: true });
  else {
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      // No saved rounds yet for this branch.
    }
  }

  let pr = findPr(branch);
  if (!pr && !(options.title && options.bodyFile)) {
    agent("No open pull request. Run again with --title and --body-file so the script can open one.");
    process.exit(2);
  }

  say("Step 1 of 3: Saving your change and checking the script, voice, timing and viewing page on this computer. This takes a minute.");
  const logFile = path.join(stateDir, `${branch.replace(/[^\w.-]/g, "_")}-push.log`);
  const push = run("bash", [PUSH, "--base", BASE, "-u", "origin", branch]);
  writeFileSync(logFile, push.stdout + push.stderr);
  if (push.status !== 0) {
    const round = nextRound(state, failureSignature([{ name: "local checks", error: firstErrorLine(push.stdout + push.stderr) }]));
    writeFileSync(stateFile, JSON.stringify(round.state));
    if (round.stop) stop(pr?.url ?? "(not opened yet)", ["The checks on this computer failed.", round.reason]);
    say("The checks on this computer found a problem. I'm fixing it now.");
    agent(`Local checks or push failed. Read the log: ${logFile}. Fix the first real error, commit, and run again (round ${round.state.rounds} of ${MAX_ROUNDS}).`);
    process.exit(1);
  }
  const head = must("git", ["rev-parse", "HEAD"]);

  if (!pr) {
    must("gh", ["pr", "create", "--repo", REPO, "--draft", "--base", BASE, "--head", branch, "--title", options.title, "--body-file", options.bodyFile]);
    pr = findPr(branch);
    if (!pr) throw new Error("the pull request was created but cannot be read back");
  }
  say(`Pull request: ${pr.url}`);
  say("");
  say("Step 2 of 3: Waiting for GitHub to check and render the film, and for the preview deployment. This usually takes several minutes.");

  const wait = run("bash", [WAITER, String(pr.number), "--repo", REPO, "--skip-success", "--json", "--timeout", "1200"]);
  if (wait.status !== 0 && wait.status !== 2) throw new Error(`waiting for the pull request failed: ${wait.stderr.trim()}`);

  // GitHub computes mergeability and the host reports the preview shortly after checks finish. Wait a bounded time.
  let verdict;
  let preview = null;
  for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
    pr = findPr(branch) ?? { ...pr, state: "CLOSED" };
    preview = findPreview(head);
    verdict = evaluate(pr, head, preview);
    if (verdict.outcome !== "wait") break;
    await sleep(SETTLE_SECONDS);
  }

  say("");
  say("Step 3 of 3: Checking the results.");
  if (verdict.outcome === "wait") {
    say("GitHub or the preview host is taking longer than usual. I'll check again.");
    for (const reason of verdict.reasons) say(`- ${reason}`);
    agent("Still pending after the bounded wait. Run this script again; this does not count as a fix round.");
    process.exit(4);
  }
  if (verdict.outcome === "blocked") stop(pr.url, verdict.reasons);

  if (verdict.outcome === "fix") {
    for (const check of verdict.failed) {
      const runId = check.link.match(/\/actions\/runs\/(\d+)/)?.[1];
      if (runId) check.error = firstErrorLine(run("gh", ["run", "view", runId, "--repo", REPO, "--log-failed"]).stdout);
    }
    const round = nextRound(state, failureSignature(verdict.failed));
    writeFileSync(stateFile, JSON.stringify(round.state));
    if (round.stop) stop(pr.url, [...verdict.reasons, round.reason]);
    say("Something needs fixing:");
    for (const reason of verdict.reasons) say(`- ${reason}`);
    say(`I'm fixing it now (round ${round.state.rounds} of ${MAX_ROUNDS}).`);
    for (const check of verdict.failed) {
      const runId = check.link.match(/\/actions\/runs\/(\d+)/)?.[1];
      if (runId) agent(`${check.name}: read \`gh run view ${runId} --repo ${REPO} --log-failed\`.`);
      else if (check.name === "merge conflict") agent(`Merge conflict: merge origin/${BASE}, keep both sides' intent, commit.`);
      else if (check.link) agent(`${check.name}: read the build logs for ${check.link} with the preview host's own tool.`);
      else agent(`${check.name}: no log link was reported; inspect the pull request checks.`);
    }
    agent("Fix the first causal error without weakening any check, commit, and run this script again.");
    process.exit(1);
  }

  let markedReady = false;
  if (pr.isDraft) {
    must("gh", ["pr", "ready", String(pr.number), "--repo", REPO]);
    markedReady = true;
  }
  rmSync(stateFile, { force: true });
  const changed = must("git", ["diff", "--name-only", `origin/${BASE}...HEAD`]).split("\n").filter(Boolean);
  const showFilm = (ref) => must("git", ["show", `${ref}:film/index.html`]);
  const scenes = sortScenes([...scenesForChanges(changed, showFilm(`origin/${BASE}`), showFilm("HEAD")), ...options.scenes]);
  const timeline = JSON.parse(readFileSync(path.join(ROOT, "timeline.json"), "utf8"));
  say("");
  say(readyMessage({ prUrl: pr.url, previewUrl: preview.url, scenes, timeline, markedReady }));
  agent(`Smoke-test each preview link in a browser before reporting. Head ${head}.`);
}

main().catch((error) => {
  say("I hit a problem I can't fix on my own, so I've stopped.");
  agent(`finish.mjs error: ${error.message}`);
  process.exit(3);
});
