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
    }
  }
}
