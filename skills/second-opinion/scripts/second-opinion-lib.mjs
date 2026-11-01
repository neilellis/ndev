// The /second-opinion policy: which agent to ask, on which model, from the quota that Orca reports.

// Orca's `account list --json` reports each provider's rate limits under `rateLimits.<key>`.
export const AGENTS = {
  codex: { key: "codex", label: "Codex" },
  claude: { key: "claude", label: "Claude" },
};

// The order to ask in. Codex comes first: a second opinion from another model family sees more.
export const DEFAULT_AGENTS = ["codex", "claude"];

// The share of a quota that the second opinion leaves for the agents' own work.
export const DEFAULT_MIN_HEADROOM = 15;

export const KINDS = ["design", "code", "plan", "general"];

// Each tier applies from its headroom (the percent left) up. The first tier that the headroom reaches applies.
// `deepEffort` replaces `effort` for a design or plan question, which gains most from a long think.
const TIERS = {
  codex: [
    { from: 60, model: "gpt-6-astra", effort: "high", deepEffort: "xhigh" },
    { from: 30, model: "gpt-6.1-sol", effort: "high" },
    { from: 0, model: "gpt-6.1-sol", effort: "medium" },
  ],
  claude: [
    { from: 60, model: "opus", effort: "high", deepEffort: "xhigh" },
    { from: 30, model: "sonnet", effort: "high" },
    { from: 0, model: "sonnet", effort: "medium" },
  ],
};

const WINDOWS = ["session", "weekly", "monthly"];

// What is left of a provider's quota: the percent left in its fullest window, that window and when it resets.
// Null when Orca cannot read the provider's usage.
export function headroom(limit) {
  if (!limit || limit.status !== "ok") return null;
  const windows = WINDOWS.filter((w) => typeof limit[w]?.usedPercent === "number");
  if (windows.length === 0) return null;
  const fullest = windows.reduce((a, b) => (limit[b].usedPercent > limit[a].usedPercent ? b : a));
  return { percent: Math.max(0, 100 - limit[fullest].usedPercent), window: fullest, resetsAt: limit[fullest].resetsAt ?? null };
}

const when = (ms) => (ms ? new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "at an unknown time");

export function describe(agent, limit) {
  const h = headroom(limit);
  if (!h) return `${agent}: usage unknown (${limit?.error ?? limit?.status ?? "Orca reports no rate limits"})`;
  return `${agent}: ${h.percent}% left in the ${h.window} window, resets ${when(h.resetsAt)}`;
}

// The agent, model and effort for a second opinion, or `agent: null` with the reason when no agent has quota to spare.
export function choose(rateLimits, { kind = "design", agents = DEFAULT_AGENTS, minHeadroom = DEFAULT_MIN_HEADROOM } = {}) {
  const deep = kind === "design" || kind === "plan";
  const looked = [];
  for (const agent of agents) {
    if (!AGENTS[agent]) throw new Error(`unknown agent "${agent}"; use one of: ${Object.keys(AGENTS).join(", ")}`);
    const limit = rateLimits?.[AGENTS[agent].key];
    const h = headroom(limit);
    looked.push(describe(agent, limit));
    if (!h || h.percent <= minHeadroom) continue;
    const tier = TIERS[agent].find((t) => h.percent >= t.from);
    return { agent, model: tier.model, effort: deep && tier.deepEffort ? tier.deepEffort : tier.effort, headroom: h, reason: looked.join("; ") };
  }
  return { agent: null, reason: looked.join("; ") };
}

const LENS = {
  design: "Judge the design: its boundaries and interfaces, data model, failure modes, what it makes hard to change later, and the simplest alternative that meets the same need. For a user interface, judge the user's path, clarity and accessibility too.",
  code: "Judge the code: correctness, edge cases, error handling, security and simpler ways to do the same thing.",
  plan: "Judge the plan: whether the steps reach the goal, the order and dependencies, the risks, what is missing and what can be cut.",
  general: "Judge the proposal on its merits: what is right, what is wrong and what you would do instead.",
};

// The worker's Task spec, in Orca's task-spec contract: target, change, constraints, ownership and acceptance.
export function spec({ question, kind, contextFiles = [], reportPath }) {
  return [
    `Give an independent second opinion (${kind}). Another agent asks:`,
    "",
    question.trim(),
    "",
    "Target: the question above, the current workspace" + (contextFiles.length ? ", and these files, which you read first:" : "."),
    ...contextFiles.map((f) => `- ${f}`),
    "",
    `Change: none to the workspace. ${LENS[kind]} Read the code that the question concerns; do not rely on the question's account of it. Disagree where you disagree.`,
    "Constraints: Do not edit, create or delete any file except the report file. Do not commit, push, install anything or start other agents. Do not ask questions: when something is unclear, state your assumption and continue.",
    "Ownership: you own only the report file.",
    `Report file: ${reportPath}`,
    "Observable acceptance: the report file holds, in Markdown: `## Verdict` (agree, agree with changes, or disagree, in one line), `## Reasons`, `## Risks`, `## What I would do instead`, and `## Confidence` (high, medium or low, with why). Cite files as path:line. Then send worker_done with --outcome succeeded and --report-path set to the report file.",
  ].join("\n");
}
