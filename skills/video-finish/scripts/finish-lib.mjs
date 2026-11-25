// Pure decision and wording logic for finish.mjs. Tested in tests/finish-lib.test.mjs.

export const MAX_ROUNDS = 5;

const FAILED_CHECK = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STALE", "STARTUP_FAILURE"]);
const PASSED_CHECK = new Set(["SUCCESS"]);

function newestRuns(rollup) {
  const latest = new Map();
  for (const check of rollup ?? []) {
    const key = `${check.workflowName ?? ""}\0${check.name || check.context || ""}`;
    const started = check.startedAt || (check.status === "COMPLETED" || check.state ? "" : "9999");
    const seen = latest.get(key);
    if (!seen || started >= seen.started) latest.set(key, { started, check });
  }
  return [...latest.values()].map((entry) => entry.check);
}

/** Normalise GitHub's statusCheckRollup into { name, state, link }, where state is passed, failed or pending. */
export function summariseChecks(rollup) {
  return newestRuns(rollup)
    .map((check) => {
      const name = check.name || check.context || "unnamed check";
      const result = check.__typename === "StatusContext" ? check.state : check.status === "COMPLETED" ? check.conclusion : "PENDING";
      const state = PASSED_CHECK.has(result) ? "passed" : FAILED_CHECK.has(result) || (check.status === "COMPLETED" && !PASSED_CHECK.has(result)) ? "failed" : "pending";
      return { name, state, link: check.detailsUrl || check.targetUrl || "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decide what a finished round means.
 * pr: { state, isDraft, mergeable, mergeStateStatus, headRefOid, statusCheckRollup }
 * localHead: the commit this round pushed. preview: { state, url } or null.
 * Returns { outcome: "ready" | "fix" | "wait" | "blocked", reasons: string[], failed: checks[] }.
 */
export function evaluate(pr, localHead, preview) {
  if (pr.state !== "OPEN") return { outcome: "blocked", reasons: [`The pull request is ${pr.state.toLowerCase()}, not open.`], failed: [] };
  if (pr.headRefOid !== localHead) return { outcome: "blocked", reasons: ["Someone else pushed to this pull request. Check their change before continuing."], failed: [] };

  const checks = summariseChecks(pr.statusCheckRollup);
  const failed = checks.filter((check) => check.state === "failed");
  if (failed.length) return { outcome: "fix", reasons: failed.map((check) => `The “${check.name}” check failed.`), failed };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return { outcome: "fix", reasons: ["The change clashes with newer work on the approved film (a merge conflict)."], failed: [{ name: "merge conflict", state: "failed", link: "" }] };
  }
  if (preview && (preview.state === "failure" || preview.state === "error")) {
    return { outcome: "fix", reasons: ["The preview deployment failed to build."], failed: [{ name: "preview deployment", state: "failed", link: preview.url || "" }] };
  }

  const waiting = [];
  if (!checks.length) waiting.push("No checks have started yet.");
  for (const check of checks.filter((check) => check.state === "pending")) waiting.push(`The “${check.name}” check is still running.`);
  if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus === "UNKNOWN") waiting.push("GitHub is still working out whether the change can be merged.");
  if (!preview || preview.state !== "success") waiting.push("The preview deployment is not ready yet.");
  if (waiting.length) return { outcome: "wait", reasons: waiting, failed: [] };

  if (pr.mergeStateStatus !== "CLEAN") {
    return { outcome: "blocked", reasons: [`GitHub says the pull request is not ready to merge (${pr.mergeStateStatus}).`], failed: [] };
  }
  return { outcome: "ready", reasons: [], failed: [] };
}

/** The first line of a log that names an error, without timestamps, so repeated failures compare equal. */
export function firstErrorLine(log) {
  for (const raw of log.split("\n")) {
    const line = raw
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/g, "")
      .replace(new RegExp(String.fromCharCode(27) + "\\[[\\d;]*m", "g"), "")
      .trim();
    if (/\b(error|failed|fail)\b/i.test(line)) return line.slice(0, 300);
  }
  return "";
}

/** A stable fingerprint of what failed, so the same failure twice stops the loop. */
export function failureSignature(failed) {
  return failed
    .map((check) => `${check.name}: ${check.error ?? ""}`)
    .sort()
    .join("|");
}

/** Apply the round limits. state: { rounds, lastSignature }. Returns { stop, reason, state }. */
export function nextRound(state, signature) {
  const rounds = (state?.rounds ?? 0) + 1;
  const next = { rounds, lastSignature: signature };
  if (signature && state?.lastSignature === signature) {
    return { stop: true, reason: "The same check failed again after a fix, so I have stopped to avoid going round in circles.", state: next };
  }
  if (rounds >= MAX_ROUNDS) {
    return { stop: true, reason: `I have tried ${MAX_ROUNDS} rounds of fixes, which is the limit.`, state: next };
  }
  return { stop: false, reason: "", state: next };
}

/** Split film/index.html into its scenes ("0", "1", ...) and "credits", keyed by section id. */
export function filmSections(html) {
  const sections = new Map();
  const opens = [...html.matchAll(/<section class="(?:scene|post)[^"]*" id="(s\d+|credits)"/g)];
  opens.forEach((open, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].index : html.length;
    sections.set(open[1] === "credits" ? "credits" : open[1].slice(1), html.slice(open.index, end));
  });
  return sections;
}

/**
 * Work out which scenes a change affects, from the changed files and the film markup before and after.
 * Returns scene numbers as strings, in film order, with "credits" last.
 */
export function scenesForChanges(files, beforeHtml, afterHtml) {
  const scenes = new Set();
  for (const file of files) {
    const voice = file.match(/^audio\/vo\/s(\d+)\.(?:mp3|json)$/);
    if (voice) scenes.add(voice[1]);
    else if (file === "assets/photos/CREDITS.md") scenes.add("credits");
  }
  if (beforeHtml !== afterHtml) {
    const before = filmSections(beforeHtml);
    for (const [id, section] of filmSections(afterHtml)) if (before.get(id) !== section) scenes.add(id);
  }
  return sortScenes([...scenes]);
}

export function sortScenes(scenes) {
  const rank = (id) => (id === "credits" ? Infinity : Number(id));
  return [...new Set(scenes)].sort((a, b) => rank(a) - rank(b));
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * Preview links for each affected scene: the film cued at the scene's start and the scene's still on the viewing page.
 * timeline: timeline.json. Returns [{ label, links }].
 */
export function previewLinks(previewUrl, scenes, timeline) {
  const base = previewUrl.replace(/\/$/, "");
  if (!scenes.length) return [{ label: "The film", links: [`${base}/`] }];
  return scenes.map((id) => {
    if (id === "credits") {
      const start = Math.floor(timeline.credits.start);
      return { label: `Credits page, at ${clock(start)}`, links: [`${base}/?t=${start}`] };
    }
    const scene = timeline.scenes[Number(id)];
    if (!scene) throw new Error(`scene ${id} is not in timeline.json`);
    const start = Math.floor(scene.start);
    return { label: `Scene ${id}, at ${clock(start)}`, links: [`${base}/?t=${start}`, `${base}/#scene-${id}`] };
  });
}

/** The plain-English report the agent shows the user when the pull request is ready. */
export function readyMessage({ prUrl, previewUrl, scenes, timeline, markedReady }) {
  const links = previewLinks(previewUrl, scenes, timeline).flatMap(({ label, links }) => [`- ${label}:`, ...links.map((link) => `  ${link}`)]);
  return [
    "Your change is ready.",
    "",
    "All the checks passed, the film rendered, and the pull request can be merged.",
    markedReady ? "I've also moved it out of draft, so it's ready for review." : "It's marked ready for review.",
    "",
    `Pull request: ${prUrl}`,
    "",
    "Please watch the preview and check you’re happy with it. The preview host may ask you to sign in.",
    "The first link for each scene starts the film at that moment. The second shows the scene's still.",
    ...links,
    "",
    "When you're happy, type /publish to make it the approved film.",
  ].join("\n");
}

export function blockedMessage({ prUrl, reasons }) {
  return ["I've stopped, because I can't finish this change on my own.", "", ...reasons.map((reason) => `- ${reason}`), "", `Pull request: ${prUrl}`].join("\n");
}
