export type Mode = 'light' | 'heavy'
export type Steering = 'interactive' | 'auto'

// The fix-all-prs loop's state.

export type PrRow = {
  number: number
  title: string
  branch: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  mergeable: string
  // GitHub's verdict on the required checks and reviews: CLEAN means it may merge now.
  mergeState: string
  mergeCommit?: string
  head: string
  failing: string[]
  pending: number
}

export type Snapshot = {
  repo?: string
  queue: number[]
  rows: PrRow[]
  checkedAt: number
  defaultBranch?: string
  mergeMethod?: 'merge' | 'squash' | 'rebase'
  isBusy?: boolean
  agentsError?: string
  // Why the Orca worktrees could not be read to find an owner.
  orcaError?: string
  error?: string
}

// What passed between this session and one pull request's owning agent.
export type Comm = {
  owner?: string
  // How the owner was found, when a search found it ("the listed session that signed its commits").
  via?: string
  presence?: string
  // The newest title of the owning session's transcript.
  title?: string
  // The head and the listed agents at which the commits were searched for the session that signed them,
  // and none was listed.
  searchedFor?: string
  sentAt?: number
  sent?: string
  sendError?: string
  heardAt?: number
  heard?: string
  // The reply began "blocked:".
  isBlocked?: boolean
}

// Who is working on the current pull request, and since when.
//   asked:  its owning agent was messaged and has not answered
//   orca:   a Claude agent was started in an Orca workspace and its session is not listed yet
//   model:  this session's model was handed the pull request
//   merging: the merge was requested and GitHub has not reported it yet
export type Step = 'asked' | 'orca' | 'model' | 'merging'

export type Outcome = {
  // ready: green, and left for a human to merge (a --no-merge run)
  kind: 'merged' | 'ready' | 'blocked' | 'closed' | 'skipped'
  detail: string
  by?: string
}

export type LogEntry = { at: number; text: string }

// A GitHub quota that ran out, and when the loop goes on.
//   api:     the API rate limit; GitHub states the reset time, and no tick reaches GitHub before it;
//            `detail` names the used-up resources (core, graphql…)
//   storage: the Actions artifact storage quota failed the checks of `pr` at `head`; at `until`
//            the loop reruns the failed jobs of `runs` and records `rerunAt`; `detail` is GitHub's message
export type Quota = {
  kind: 'api' | 'storage'
  until: number
  detail: string
  pr?: number
  head?: string
  runs?: number[]
  rerunAt?: number
}

export type Loop = {
  phase: 'idle' | 'running' | 'paused' | 'done'
  current?: number
  step?: Step
  stepAt?: number
  // The head commit when the round began: a new head means someone pushed.
  askedHead?: string
  // The model reported a push through the report tool.
  isRoundDone?: boolean
  by?: string
  // The model holds the pull request only because the agents could not be listed: an owner found later takes it over.
  isAwaitingOwner?: boolean
  // The folder of the Orca worktree an agent was started in: in the orca step, only a session in it owns the pull request.
  orcaPath?: string
  // Fix rounds on the current pull request; the loop blocks it past the limit.
  attempts: number
  outcomes: Record<string, Outcome>
  log: LogEntry[]
  error?: string
  // Failed ticks in a row; reset by a tick that runs clean.
  ghFailures?: number
  // No tick reaches GitHub before this time, unless the person asks.
  ghRetryAt?: number
  mergeFailures?: number
  // No merge is tried before this time after GitHub refused one.
  mergeRetryAt?: number
  // Where the round stood before a merge was requested, restored if GitHub refuses it.
  preMerge?: { step?: Step; stepAt?: number; askedHead?: string }
  quota?: Quota
  // Started with --no-merge: a green pull request is recorded as ready, not merged.
  isNoMerge?: boolean
}

// The /triage run (hooks/triage.tsx): this session's model groups the open issues, and each group becomes
// one Orca Task with a supervised Claude worker that opens one draft pull request.
export type TriageComplexity = 'very-complex' | 'complex' | 'average' | 'simple' | 'very-simple'

export type TriageIssue = { number: number; title: string; url: string }

export type TriageGroup = {
  // The lowest issue number: it names the Task, the workspace and the branch.
  lead: number
  issues: number[]
  title: string
  complexity: TriageComplexity
  model: string
  effort: string
  hint: string
  implemented: boolean
  evidence?: string
  // The leads of the groups whose workers must succeed first.
  after: number[]
  // Orca's ids for the group, as Orca reported them.
  taskId?: string
  worktree?: string
  dispatchId?: string
  terminal?: string
  // The model and effort Orca says it started, which can differ from the ones asked for.
  effective?: string
  // Orca's own state, read back from Orca on each refresh: the Task status, the worker's liveness,
  // the workspace's board status and the pull request linked to the workspace.
  task?: string
  liveness?: string
  workspaceStatus?: string
  pr?: number
  // The worker's open question, sent to this session's model to answer.
  question?: { id: string; text: string }
  error?: string
  // The lead of the failed or blocked group this one waits for; it never starts.
  blockedBy?: number
  summary?: string
}

export type TriageView = {
  repo?: string
  phase: 'idle' | 'grouping' | 'planned' | 'running' | 'done'
  isDryRun?: boolean
  runId?: string
  // The issues the model is grouping.
  issues: TriageIssue[]
  groups: TriageGroup[]
  log: { at: number; text: string }[]
  error?: string
  checkedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ndev': {
      mode: Mode
      steering: Steering
      // The fix-all-prs loop (hooks/fix-all-prs.tsx).
      snapshot: Shaped<Snapshot>
      comms: Shaped<Record<string, Comm>>
      loop: Shaped<Loop>
      activity: Shaped<{ at?: number }>
      // The /walk-doc run (hooks/walk-doc/).
      walkRun: Shaped<WalkRun | null>
      // The responsive-check matrix pane (hooks/responsive-check.tsx).
      responsiveView: Shaped<ResponsiveView>
      // The worktree of this session's workflow, and when the session was last active (hooks/workflow/).
      workflowRoot: Shaped<string | null>
      workflowIssue: Shaped<number | null>
      workflowDoneWaitsFor: Shaped<string | null>
      workflowFollowUpWorktrees: Shaped<string[]>
      workflowDeclined: Shaped<boolean>
      workflowIssueAsked: Shaped<boolean>
      workflowCheckRead: Shaped<{ at: number }>
      workflowWatchNote: Shaped<{ at: number; why: string }>
      workflowActivity: Shaped<{ at: number; isTurnRunning: boolean }>
      // The /triage run (hooks/triage.tsx).
      triage: Shaped<TriageView>
      // The /view pane (hooks/view.tsx).
      resourceView: Shaped<ResourceView>
    }
  }
}

// The /walk-doc state (hooks/walk-doc/): one run, kept in $.state and mirrored to walk-run/<runId>/run.json.
export type WalkFinding = {
  n: number
  code: 'OMISSION' | 'BUG' | 'INCORRECT' | 'BLOCKED' | 'ENHANCE' | 'RECORD'
  step: string
  expected: string
  actual: string
  evidence: string
  attempt: number
  at: number
  resolution: { action: 'CONTINUE' | 'RESTART' | 'ESCALATED' | 'NOTED'; note: string; changed: string[]; at: number } | null
}

// A question the main agent sent the Walk agent with walk_ask, and the reader's walk_answer.
export type WalkAsk = { n: number; question: string; at: number; answer: { text: string; at: number } | null }

export type WalkRun = {
  runId: string
  phase: 'walking' | 'awaiting' | 'escalated' | 'done' | 'finished'
  target: string
  startUrls: string[]
  persona: string
  root: string
  home: string
  port: number
  pid: number
  // The attempt that runs now, from 1; restarts so far are attempt - 1.
  attempt: number
  agentId: string | null
  // Every Walk agent of this run, so the guard covers a resumed or replaced one.
  agentIds: string[]
  stepBlocks: Record<string, number>
  // Blocking reports, ENHANCE notes and RECORD requests, numbered in the order they came.
  findings: WalkFinding[]
  denials: { tool: string; detail: string; at: number }[]
  // Repo-relative or ~ paths the docs tell the reader to open or edit.
  allowedPaths: string[]
  startedAt: number
  summary: string | null
  // Times the current Walk agent ended its turn without a report and was told to carry on.
  nudges: number
  // /walk-doc --re-record: every reader records each recording on the page again. Absent in runs from before the flag.
  reRecord?: boolean
  // Walk Bash commands recorded so far; each one's cast is numbered from this. Absent in runs from before recording.
  recorded?: number
  // Files Claude Code saved a Walk agent's own oversized tool output to; the guard opens exactly these under ~/.claude.
  savedOutputs?: string[]
  // Questions the main agent asked the reader, numbered in the order sent. Absent in runs from before walk_ask.
  asks?: WalkAsk[]
  // A walkArrow.point with untilClick is up, so the reader's next browser_click may go ahead. Absent in runs from before the rule.
  arrowArmed?: boolean
  // When that arrow went up (ms) and how long its caption needs before the click is allowed (ms).
  arrowArmedAt?: number
  arrowDwellMs?: number
}

// The responsive-check matrix pane (hooks/responsive-check.tsx). The skill's runner
// (skills/responsive-check/scripts/responsive-check.mjs) writes RcProgress to <out>/progress.json
// and points ~/.cache/ndev/responsive-check/latest.json at it; the pane reads both.
export type RcStatus = 'pending' | 'running' | 'ok' | 'warn' | 'error' | 'failed'

export type RcCell = {
  route: string
  viewport: string
  scheme: 'light' | 'dark'
  status: RcStatus
  errors: number
  warnings: number
  top?: string
  error?: string
}

export type RcProgress = {
  state: 'running' | 'done' | 'failed'
  startedAt: number
  updatedAt: number
  base: string
  out: string
  routes: string[]
  viewports: { name: string; short: string; width: number; height: number; engine: string }[]
  schemes: ('light' | 'dark')[]
  cells: RcCell[]
  summary?: { cells: number; failed: number; errors: number; warnings: number }
  report?: string
  error?: string
}

// One finding, grouped across the cells it shows in.
export type RcTop = { check: string; severity: 'error' | 'warning'; selector: string; detail: string; cells: number }

export type ResponsiveView = {
  progress?: RcProgress
  top?: RcTop[]
  // Why the newest run could not be read.
  error?: string
  // Counts the polls, so a running cell's spinner moves.
  frame: number
  // When a Bash call started the runner: until its run appears, older runs are not shown.
  since?: number
}

// The /view pane: the ndev files and the running resources of every git worktree.
export type ViewFile = { name: string; isKnown: boolean; present: boolean; isIgnored: boolean }
export type ViewServer = { name: string; pid: number; port: number; command: string; cwd: string; live: boolean; lastStopOutput?: string }
export type ViewStack = { kind: string; projectId: string; workdir: string; live: boolean | null; liveError?: string; lastStopOutput?: string }
export type ViewTree = {
  path: string
  branch: string
  isMain: boolean
  files: ViewFile[]
  servers: ViewServer[]
  stacks: ViewStack[]
  // Why this worktree could not be inspected (its folder or .git is gone), with the repair.
  problem?: string
  // Why this worktree's record could not be read, with the repair.
  resourceError?: string
  // The workflow of each issue in this worktree.
  workflows?: WorkflowView[]
  // Why the workflows could not be read, with the repair. The resources still draw.
  workflowError?: string
}
// One workflow as the pane draws it: an issue record, or the record of a PR with its issues.
export type WorkflowView = {
  kind: 'issue' | 'pr'
  state: string
  previous?: string
  issue: number
  pr?: number
  issues?: number[]
  repo?: string
  prs: number[]
  // Set for this issue. The worktree and the project decide when these are empty.
  mode?: string
  steering?: string
  blocked?: string
  blockedAt?: number
  visited?: string[]
  waiting?: { id: string; tool: string; what: string; at: number; period?: number; most?: number; timeoutS?: number; args?: Record<string, string> }
  review?: { name: string; firedAt?: number; answered: boolean }[]
  live?: WorkflowLive
  // Why the live file could not be read. The pane still draws the record.
  liveError?: string
}
// What the tools write beside the record while they work: <git dir>/ndev-live-<issue|pr>-<n>.json.
export type WorkflowLive = {
  at: number
  wait?: { id: string; tries: number; checkedAt?: number; nextAt?: number; detail?: string; seen?: Record<string, string> }
  watch?: { at: number; nextAt?: number; sha?: string; red: string[]; pending: string[]; green: number; problems: string[]; seen?: Record<string, string> }
  calls?: { tool: string; args: Record<string, string>; at: number; endedAt?: number; outcome: 'running' | 'ok' | 'refused' | 'failed'; note?: string }[]
}
export type ResourceView = {
  // The services of .neil-dev.json (the current worktree's, else the main checkout's), shown as links.
  services?: Record<string, { url: string }>
  // Why .neil-dev.json could not be read, with its path.
  servicesError?: string
  trees: ViewTree[]
  // The repo the lists were read for; a failed read of the whole list sits in error.
  repo?: string
  // The worktree the session is in: the only one the pane shows. The main checkout is read for Copy from main.
  current?: string
  error?: string
  checkedAt?: number
  // The button pressed once and waiting for its second press (a stop), and when.
  armed?: { key: string; at: number }
  // The keys of the actions that run now.
  busy: string[]
  // What the last action did, or why it failed, with the repair.
  notice?: { text: string; isError: boolean }
}
