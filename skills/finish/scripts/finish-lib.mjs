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
    return { outcome: "fix", reasons: ["The change clashes with newer work on the base branch (a merge conflict)."], failed: [{ name: "merge conflict", state: "failed", link: "" }] };
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

/** Check a --page value: a site path that starts with "/". Returns the page, or throws. */
export function checkPage(page) {
  if (!/^\/(?!\/)[^\s?#]*$/.test(page ?? "")) throw new Error(`--page values must be a site path that starts with / (got '${page ?? ""}')`);
  return page;
}

const PAGE_EXT = "(?:tsx|ts|jsx|js|mdx|md)";
const APP_PAGE = new RegExp(`^(?:src/)?app/(?:(.*)/)?page\\.${PAGE_EXT}$`);
const PAGES_FILE = new RegExp(`^(?:src/)?pages/(.+)\\.${PAGE_EXT}$`);

/** The URL path for route segments, or null if the route has no single URL (dynamic, private or intercepting). */
function routeFor(segments) {
  const parts = [];
  for (const segment of segments) {
    if (segment.includes("[") || segment.startsWith("_")) return null;
    if (/^\([^)]*\)$/.test(segment) || segment.startsWith("@")) continue; // route groups and parallel slots are not in the URL
    if (segment.startsWith("(")) return null; // intercepting route
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

/**
 * Map changed repository files to the site pages they affect.
 * Knows the Next.js app router (app/ or src/app/) and pages router (pages/ or src/pages/).
 * Other files map to no page; the agent names those pages with --page.
 */
export function pagesForFiles(files) {
  const pages = new Set();
  for (const file of files) {
    const app = file.match(APP_PAGE);
    if (app) {
      const route = routeFor((app[1] ?? "").split("/").filter(Boolean));
      if (route) pages.add(route);
      continue;
    }
    const legacy = file.match(PAGES_FILE);
    if (legacy) {
      const segments = legacy[1].split("/");
      if (segments[0] === "api") continue;
      if (segments.at(-1) === "index") segments.pop();
      const route = routeFor(segments);
      if (route) pages.add(route);
    }
  }
  return [...pages].sort();
}

/** A preview link for each page, or the home page when no page is known. */
export function previewLinks(previewUrl, pages) {
  const base = previewUrl.replace(/\/$/, "");
  return (pages.length ? pages : ["/"]).map((page) => base + page);
}

/** The plain-English report the agent shows the user when the pull request is ready. */
export function readyMessage({ prUrl, previewUrl, pages, markedReady }) {
  return [
    "Your change is ready.",
    "",
    "All the checks passed and the pull request can be merged.",
    markedReady ? "I've also moved it out of draft, so it's ready for review." : "It's marked ready for review.",
    "",
    `Pull request: ${prUrl}`,
    "",
    pages.length ? "Please open each changed page on the preview and check you're happy with it." : "Please open the preview and check you're happy with it.",
    "The preview host may ask you to sign in.",
    ...previewLinks(previewUrl, pages).map((link) => `- ${link}`),
    "",
    "When you're happy, type /publish to put it live.",
  ].join("\n");
}

export function blockedMessage({ prUrl, reasons }) {
  return ["I've stopped, because I can't finish this change on my own.", "", ...reasons.map((reason) => `- ${reason}`), "", `Pull request: ${prUrl}`].join("\n");
}
