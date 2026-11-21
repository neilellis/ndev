import type { ClosingEvidence, EpicDebt } from './epic-closing'
import type { Server } from '../../hooks/remote-store'

export type EpicState = 'framing' | 'researching' | 'specifying' | 'deciding' | 'spec-review' | 'slicing' | 'coordinating' | 'closing' | 'done'
export type IssueState = 'waiting' | 'implementing' | 'reviewing' | 'fixing' | 'verified' | 'merged' | 'blocked' | 'human-pending' | 'external'
export type Role = { agent: string; model?: string }
export type SubIssue = {
  issue: number
  key: string
  title: string
  blockedBy: number[]
  state: IssueState
  pr?: number
  kind?: 'implementation' | 'human'
  implementer?: string
  reviewer?: string
  // The implementer's worktree, where the reviewer works too.
  workspace?: string
  verdict?: 'approve' | 'changes'
  rounds: number
  note?: string
  // The merge commit that GitHub named when the issue went to "merged".
  mergeSha?: string
  // True when a human merged the PR before "verified", so the verify checks did not run.
  mergedUnverified?: boolean
  verification?: { sha: string; at?: number }
  // The state that a block interrupted, and the only state the issue goes back to.
  previous?: IssueState
  // The saved Orca server that holds the workspace, set when the implementer brief is written for a start there.
  // Without it the workspace is on this machine. The workspace is then the worktree id on the server, <repoId>::<path>.
  remote?: Server
  // The sub-issue whose PR branch this one started from, while that PR was not merged. epicBrief sets it with the
  // stacked brief, and only a pass of the verify checks clears it: by then the PR's base is the default branch.
  stackedOn?: number
}
export type Epic = {
  epic: number
  repo: string
  root: string
  title: string
  state: EpicState
  shortName?: string
  owner?: { session: string; at: number }
  aim?: string
  baseSha?: string
  coordinatorModel?: string
  fullSuites?: string[][]
  posture?: 'standard' | 'deadline'
  debts?: EpicDebt[]
  closing?: ClosingEvidence
  evidence: Partial<Record<EpicState, { at: number; text: string; files?: string[] }>>
  parallel: number
  roles: { implementer: Role; reviewer: Role }
  // The Orca run and repository ids, for the worker-start command.
  run?: string
  repoId?: string
  // The saved Orca server that new sub-issues start on, set only by epicStarted with remote and resolved once there;
  // and the selector of the repository on that server, which its Orca needs to make a worktree.
  remote?: Server
  remoteRepo?: string
  externalBlockers?: Record<string, SubIssue>
  issues: Record<string, SubIssue>
  history: { at: number; tool: string; from?: string; to: string }[]
}
export type Slice = { issue: number; key: string; title: string; blockedBy: number[] }

export const EPIC_STATES: EpicState[] = ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing', 'coordinating', 'closing', 'done']
export const ISSUE_STATES: IssueState[] = ['waiting', 'implementing', 'reviewing', 'fixing', 'verified', 'merged', 'blocked', 'human-pending', 'external']
export const IN_FLIGHT: IssueState[] = ['implementing', 'reviewing', 'fixing', 'verified', 'external']
// The states in which the implementer has pushed its branch and the record holds its PR.
const PUSHED: IssueState[] = ['reviewing', 'fixing', 'verified']
export const PLAN_STATES: EpicState[] = ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing']
export const ROUND_LIMIT = 3
export const DEFAULT_PARALLEL = 4
export const OWNER_LIVE_MS = 10 * 60_000
export const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/
export const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/

export const nextEpicState = (state: EpicState): EpicState | undefined => EPIC_STATES[EPIC_STATES.indexOf(state) + 1]
export const tag = (n: number) => `#${n}`
export const tags = (ns: number[]) => ns.map(tag).join(', ')

// The slicing checks that need no GitHub call: undefined when the list is good.
export function sliceProblems(slices: Slice[], external: number[] = []): string | undefined {
  if (!slices.length) return 'the issues list is empty; slicing needs at least one sub-issue'
  const problems: string[] = []
  const seen = new Set<number>()
  for (const s of slices) {
    if (seen.has(s.issue)) problems.push(`the list names ${tag(s.issue)} twice`)
    seen.add(s.issue)
  }
  for (const s of slices) {
    const unknown = s.blockedBy.filter(b => !seen.has(b) && !external.includes(b))
    if (unknown.length) problems.push(`${tag(s.issue)} is blocked by ${tags(unknown)}, which is not in the list`)
  }
  if (problems.length) return problems.join('; ')
  const cycle = findCycle(slices)
  return cycle ? `the blockers make a cycle: ${cycle.map(tag).join(' → ')}` : undefined
}

function findCycle(slices: Slice[]): number[] | undefined {
  const by = new Map(slices.map(s => [s.issue, s.blockedBy]))
  const done = new Set<number>()
  const path: number[] = []
  const visit = (n: number): number[] | undefined => {
    const at = path.indexOf(n)
    if (at >= 0) return [...path.slice(at), n]
    if (done.has(n)) return undefined
    path.push(n)
    for (const b of by.get(n) ?? []) {
      const found = visit(b)
      if (found) return found
    }
    path.pop()
    done.add(n)
    return undefined
  }
  for (const s of [...slices].sort((a, b) => a.issue - b.issue)) {
    const found = visit(s.issue)
    if (found) return found
  }
  return undefined
}

export type StackPlan = { on: SubIssue } | { why: string; split?: true }
// Where a sub-issue with an unmerged blocker can start: on the PR branch of that blocker (on), or nowhere yet (why).
// undefined when every blocker is merged, so it starts from the default branch. With several unmerged blockers it
// stacks only on the one whose branch holds the others: the record shows that as a chain of stackedOn.
export function stackPlan(epic: Epic, sub: SubIssue): StackPlan | undefined {
  const missing = sub.blockedBy.filter(b => !epic.issues[b] && !epic.externalBlockers?.[b])
  if (missing.length) return { why: `${tag(sub.issue)} has unrecorded blockers ${tags(missing)}. Run ndev epic import ${epic.epic} --issues-file <json> --evidence <text>.` }
  const external = sub.blockedBy.filter(b => epic.externalBlockers?.[b]?.state !== 'merged' && !epic.issues[b])
  if (external.length) return { why: `${tag(sub.issue)} waits for external blockers ${tags(external)}. Refresh with ndev epic import ${epic.epic} --issues-file <json> --evidence <text>.` }
  const open = sub.blockedBy.map(b => epic.issues[String(b)]).filter((b): b is SubIssue => !!b && b.state !== 'merged')
  if (!open.length) return undefined
  const early = open.filter(b => !(PUSHED.includes(b.state) && b.pr))
  if (early.length) return { why: `it waits for ${early.map(b => `${tag(b.issue)} ("${b.state}"${b.pr ? '' : ', no PR recorded'})`).join(', ')}: a blocker can carry a stack only in the states ${PUSHED.join(', ')}, when its branch is pushed` }
  const below = (top: SubIssue) => {
    const seen: number[] = []
    for (let at = top.stackedOn; at !== undefined && !seen.includes(at); at = epic.issues[String(at)]?.stackedOn) seen.push(at)
    return seen
  }
  const top = open.find(t => open.every(o => o === t || below(t).includes(o.issue)))
  if (top) return { on: top }
  return { split: true, why: `its unmerged blockers ${tags(open.map(b => b.issue))} are on different branches, and no one of those branches holds the others, so no one branch can be its base. It starts when all but one of them are merged` }
}

export type Frontier = {
  ready: SubIssue[]; held: SubIssue[]; inFlight: SubIssue[]; waitingOn: { issue: number; open: number[] }[]; blocked: SubIssue[]; free: number
  // The waiting issues that can start now on the PR branch of an unmerged blocker, and those that no place is free for.
  stacked: { sub: SubIssue; on: SubIssue }[]; stackedHeld: SubIssue[]
  // The waiting issues whose blockers all have a pushed PR, and that still cannot stack.
  notStackable: { issue: number; why: string }[]
}
// The issues that can start now, in number order: waiting with each blocker merged (ready), then waiting on the PR
// branch of an unmerged blocker (stacked). The two together are cut to the free places.
export function frontier(epic: Epic): Frontier {
  const all = Object.values(epic.issues).sort((a, b) => a.issue - b.issue)
  const merged = new Set([...all, ...Object.values(epic.externalBlockers ?? {})].filter(i => i.state === 'merged').map(i => i.issue))
  const inFlight = all.filter(i => IN_FLIGHT.includes(i.state))
  const free = Math.max(0, epic.parallel - inFlight.length)
  const waiting = all.filter(i => i.state === 'waiting').map(sub => ({ sub, plan: stackPlan(epic, sub) }))
  const startable = waiting.filter(w => !w.plan).map(w => w.sub)
  const stackable = waiting.flatMap(w => (w.plan && 'on' in w.plan ? [{ sub: w.sub, on: w.plan.on }] : []))
  const cannot = waiting.flatMap(w => (w.plan && 'why' in w.plan ? [{ sub: w.sub, plan: w.plan }] : []))
  const ready = startable.slice(0, free)
  const left = free - ready.length
  return {
    ready, held: startable.slice(free), inFlight, free, blocked: all.filter(i => i.state === 'blocked'),
    waitingOn: cannot.map(c => ({ issue: c.sub.issue, open: c.sub.blockedBy.filter(b => !merged.has(b)) })),
    stacked: stackable.slice(0, left), stackedHeld: stackable.slice(left).map(s => s.sub),
    notStackable: cannot.filter(c => c.plan.split).map(c => ({ issue: c.sub.issue, why: c.plan.why })),
  }
}

export function frontierText(epic: Epic): string {
  const f = frontier(epic)
  const named = (i: SubIssue) => `${tag(i.issue)} "${i.title}"`
  return [
    `Ready to start (${f.free} of ${epic.parallel} places free): ${f.ready.map(named).join(', ') || 'none'}.`,
    ...(f.stacked.length ? [`Can start stacked, from the PR branch of a blocker that is not merged: ${f.stacked.map(s => `${named(s.sub)} on ${tag(s.on.issue)} (PR #${s.on.pr})`).join(', ')}.`] : []),
    ...(f.held.length || f.stackedHeld.length ? [`Ready, but no place is free: ${tags([...f.held, ...f.stackedHeld].map(i => i.issue))}.`] : []),
    ...(f.waitingOn.length ? [`Waiting on blockers: ${f.waitingOn.map(w => `${tag(w.issue)} waits for ${tags(w.open)}`).join('; ')}.`] : []),
    ...f.notStackable.map(n => `Not stackable: ${tag(n.issue)}: ${n.why}.`),
    ...(f.inFlight.length ? [`In flight: ${f.inFlight.map(i => `${tag(i.issue)} ${i.state}${i.pr ? ` (PR #${i.pr})` : ''}${i.stackedOn ? `, stacked on ${tag(i.stackedOn)}` : ''}`).join(', ')}.`] : []),
    ...(f.blocked.length ? [`Blocked: ${f.blocked.map(i => `${tag(i.issue)}: ${i.note ?? 'no reason recorded'}`).join('; ')}.`] : []),
  ].join('\n')
}

export const link = (epic: Epic, n: number) => `https://github.com/${epic.repo}/issues/${n}`
const fileList = (files: string[]) => (files.length ? files.map(f => `- ${f}`).join('\n') : '- (the epic records no spec file: read the epic issue)')

// What the worker of the stacked issue does when the PR it is stacked on is merged. A merge and not a rebase: the
// branch is pushed, and others may have pulled it.
export const unstackSteps = (repo: string, base: string, pr: string) => `run \`git fetch origin\`, then \`git merge origin/${base}\`, and resolve each conflict. Commit and push with mcp__ndev__checkpoint. Then run \`gh pr edit ${pr} --repo ${repo} --base ${base}\``

// The stack that an implementer starts on: the blocker, the head branch of its PR, and the default branch.
export type Stack = { on: SubIssue; branch: string; base: string }
function stackSection(epic: Epic, s: Stack): string {
  const { on, branch, base } = s
  return `
## Stacked on #${on.issue}

This issue needs the change of #${on.issue} "${on.title}" (PR #${on.pr}, ${link(epic, on.pr!).replace('/issues/', '/pull/')}), which is not merged. Your worktree starts from origin/${branch}, the branch of that PR, so its change is in your branch.

1. Do not change or revert the work of #${on.issue}. If it must change, tell the coordinator.
2. The workflow opens your draft PR against ${base}. As soon as it is open, run \`gh pr edit <your PR> --repo ${epic.repo} --base ${branch}\`, so the PR shows only the change of this issue.
3. If mcp__ndev__started blocks this issue only on the open issue #${on.issue}, call mcp__ndev__unblocked and go on: its change is in your branch.
4. The workflow still compares with ${base}. If a check or done refuses a file that came from #${on.issue}, such as a migration, leave the file and ask the coordinator.
5. If the coordinator says that PR #${on.pr} changed, run \`git fetch origin\` and \`git merge origin/${branch}\`, then push with mcp__ndev__checkpoint.
6. When the coordinator says that PR #${on.pr} is merged: ${unstackSteps(epic.repo, base, '<your PR>')}. Your PR cannot be verified before that.
`
}

export function implementerBrief(epic: Epic, sub: SubIssue, specFiles: string[], stack?: Stack): string {
  return `# Implement #${sub.issue}: ${sub.title}

You are the implementer of one sub-issue of epic #${epic.epic} ("${epic.title}", ${link(epic, epic.epic)}).

Aim of the epic: ${epic.aim ?? '(not recorded)'}

Sub-issue: #${sub.issue} "${sub.title}", ${link(epic, sub.issue)}

Spec files:
${fileList(specFiles)}

Read only the cited sections of \`NORTH_STAR.md\` in the issue or spec. Use those sections to guide implementation and add the checks they require.

## Rules

1. Read the issue, and the spec file(s) it names, before any code.
2. Work in this worktree under the usual workflow: call mcp__ndev__started with issue ${sub.issue} and set the steering to auto. Work test first.
3. Make one PR to the default branch.${stack ? ` While #${stack.on.issue} is not merged, its base is ${stack.branch}: see "Stacked on #${stack.on.issue}" below.` : ''}
4. Register each migration with mcp__ndev__addMigration.
5. Stay inside the issue. Report a discovery outside it; do not fix it, unless it blocks the checks.
6. Do not merge.
7. Do no hosted or paid action (real model calls, publishes, hosted migrations) without the coordinator's word.
8. When the spec and the code disagree, ask the coordinator with orca orchestration ask, and give a proposed default.
9. Finish with worker_done. Give the PR, the checks as passed / failed / not run, each departure from the spec, and the open questions.
${stack ? stackSection(epic, stack) : ''}`
}

export function reviewerBrief(epic: Epic, sub: SubIssue, specFiles: string[], pr = sub.pr): string {
  return `# Review PR #${pr ?? '?'} for #${sub.issue}: ${sub.title}

You are the reviewer of one sub-issue of epic #${epic.epic} ("${epic.title}", ${link(epic, epic.epic)}). This review is read-only: change no file, and make no commit, push or comment.

Aim of the epic: ${epic.aim ?? '(not recorded)'}

Sub-issue: #${sub.issue} "${sub.title}", ${link(epic, sub.issue)}
PR: PR #${pr ?? '?'}

Spec files:
${fileList(specFiles)}

Read only the cited sections of \`NORTH_STAR.md\` in the issue or spec. Check the diff and the test evidence against those sections.

## Rules

1. Review the diff against the issue and the spec, not against the implementer's summary.
2. Look for omissions, incorrect behaviour, missing or weak tests, over-engineering and breaks of the project rules.
3. Give each finding a severity (Critical, Important, Minor), its file:line, the spec text it breaks and the smallest fix.
4. Give the verdict APPROVE or CHANGES NEEDED.
5. Say what you did not run.
6. Report with worker_done.
`
}
