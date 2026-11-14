// The epic workflow: one coordinator session plans an epic and then coordinates its sub-issues, which
// Orca workers implement and review under the usual workflow. The record is the worktree's
// .neil-dev.epic-<issue>.json. The pure part (the phases, the slicing checks, the frontier, the briefs
// and the worker command) is first; the tools, the system line and /flow epic come after it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoadedConfig } from '../config'
import { Refuse, defaultBranch, gh, ghOne, gitOut, git, paths, readChecks, readPr, repoFromOrigin, run } from './effects'
import { SECTION, boundRoot, inTurn, loadWorkflow, setDeclined } from './tools'

export type EpicState = 'framing' | 'researching' | 'specifying' | 'deciding' | 'spec-review' | 'slicing' | 'coordinating' | 'closing' | 'done'
export type IssueState = 'waiting' | 'implementing' | 'reviewing' | 'fixing' | 'verified' | 'merged' | 'blocked'
export type Role = { agent: string; model?: string }
export type SubIssue = {
  issue: number
  key: string
  title: string
  blockedBy: number[]
  state: IssueState
  pr?: number
  implementer?: string
  reviewer?: string
  // The implementer's worktree, where the reviewer works too.
  workspace?: string
  verdict?: 'approve' | 'changes'
  rounds: number
  note?: string
  // The state that a block interrupted, and the only state the issue goes back to.
  previous?: IssueState
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
  evidence: Partial<Record<EpicState, { at: number; text: string; files?: string[] }>>
  parallel: number
  roles: { implementer: Role; reviewer: Role }
  // The Orca run and repository ids, for the worker-start command.
  run?: string
  repoId?: string
  issues: Record<string, SubIssue>
  history: { at: number; tool: string; from?: string; to: string }[]
}
export type Slice = { issue: number; key: string; title: string; blockedBy: number[] }

export const EPIC_STATES: EpicState[] = ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing', 'coordinating', 'closing', 'done']
const ISSUE_STATES: IssueState[] = ['waiting', 'implementing', 'reviewing', 'fixing', 'verified', 'merged', 'blocked']
const IN_FLIGHT: IssueState[] = ['implementing', 'reviewing', 'fixing', 'verified']
const PLAN_STATES: EpicState[] = ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing']
const ROUND_LIMIT = 3
const DEFAULT_PARALLEL = 4
const OWNER_LIVE_MS = 10 * 60_000
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/
const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+){1,4}$/

export const nextEpicState = (state: EpicState): EpicState | undefined => EPIC_STATES[EPIC_STATES.indexOf(state) + 1]
const tag = (n: number) => `#${n}`
const tags = (ns: number[]) => ns.map(tag).join(', ')

// The slicing checks that need no GitHub call: undefined when the list is good.
export function sliceProblems(slices: Slice[]): string | undefined {
  if (!slices.length) return 'the issues list is empty; slicing needs at least one sub-issue'
  const problems: string[] = []
  const seen = new Set<number>()
  for (const s of slices) {
    if (seen.has(s.issue)) problems.push(`the list names ${tag(s.issue)} twice`)
    seen.add(s.issue)
  }
  for (const s of slices) {
    const unknown = s.blockedBy.filter(b => !seen.has(b))
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

export type Frontier = { ready: SubIssue[]; held: SubIssue[]; inFlight: SubIssue[]; waitingOn: { issue: number; open: number[] }[]; blocked: SubIssue[]; free: number }
// The issues that can start now: waiting, with each blocker merged, in number order, cut to the free places.
export function frontier(epic: Epic): Frontier {
  const all = Object.values(epic.issues).sort((a, b) => a.issue - b.issue)
  const merged = new Set(all.filter(i => i.state === 'merged').map(i => i.issue))
  const inFlight = all.filter(i => IN_FLIGHT.includes(i.state))
  const free = Math.max(0, epic.parallel - inFlight.length)
  const startable = all.filter(i => i.state === 'waiting' && i.blockedBy.every(b => merged.has(b)))
  const waitingOn = all.filter(i => i.state === 'waiting' && !startable.includes(i)).map(i => ({ issue: i.issue, open: i.blockedBy.filter(b => !merged.has(b)) }))
  return { ready: startable.slice(0, free), held: startable.slice(free), inFlight, waitingOn, blocked: all.filter(i => i.state === 'blocked'), free }
}

export function frontierText(epic: Epic): string {
  const f = frontier(epic)
  const named = (i: SubIssue) => `${tag(i.issue)} "${i.title}"`
  return [
    `Ready to start (${f.free} of ${epic.parallel} places free): ${f.ready.map(named).join(', ') || 'none'}.`,
    ...(f.held.length ? [`Ready, but no place is free: ${tags(f.held.map(i => i.issue))}.`] : []),
    ...(f.waitingOn.length ? [`Waiting on blockers: ${f.waitingOn.map(w => `${tag(w.issue)} waits for ${tags(w.open)}`).join('; ')}.`] : []),
    ...(f.inFlight.length ? [`In flight: ${f.inFlight.map(i => `${tag(i.issue)} ${i.state}${i.pr ? ` (PR #${i.pr})` : ''}`).join(', ')}.`] : []),
    ...(f.blocked.length ? [`Blocked: ${f.blocked.map(i => `${tag(i.issue)}: ${i.note ?? 'no reason recorded'}`).join('; ')}.`] : []),
  ].join('\n')
}

// The next step for each state, which names the skill to load.
export function epicStep(epic: Epic): string {
  const n = epic.epic
  const phase = (finished: EpicState, needs: string) => `call mcp__ndev__epicPhase with issue ${n}, finished "${finished}", ${needs}.`
  switch (epic.state) {
    case 'framing': return `Load the skill ndev:epic-plan. Settle with the human what the epic is for, then ${phase('framing', 'aim (one or two sentences) and evidence')}`
    case 'researching': return `Load the skill ndev:epic-plan. Read the code and the sources, write research notes to a file, then ${phase('researching', 'files (the notes) and evidence')}`
    case 'specifying': return `Load the skill ndev:epic-plan. Write the spec to a file, then ${phase('specifying', 'files (the spec) and evidence')}`
    case 'deciding': return `Load the skill ndev:epic-plan. Settle each open decision of the spec with the human, then ${phase('deciding', 'evidence (the decisions, and that none is open)')}`
    case 'spec-review': return `Load the skill ndev:epic-plan. Get an independent review of the spec and rule on each finding, then ${phase('spec-review', 'files (the review) and evidence (the ruling on each finding)')}`
    case 'slicing': return `Load the skill ndev:epic-plan. File the sub-issues on GitHub, then ${phase('slicing', 'issues ([{ issue, key, title, blockedBy }]) and evidence')}`
    case 'coordinating': return `Load the skill ndev:epic-coordinate. Call mcp__ndev__epicNext with issue ${n}; for each ready sub-issue call mcp__ndev__epicBrief and run the command that it gives, and record each move with mcp__ndev__epicIssue. When every sub-issue is merged, ${phase('coordinating', 'and evidence')}`
    case 'closing': return `Load the skill ndev:epic-coordinate. Verify the whole epic end to end, then ${phase('closing', 'evidence (what was verified, and what remains)')}`
    case 'done': return 'The epic is done. Nothing remains.'
  }
}

export const epicLineOf = (epic: Epic) => `Epic: #${epic.epic} "${epic.title}" in ${epic.root} is in the state "${epic.state}". You are the coordinator: you plan, decide, verify and merge; workers implement and review. Next: ${epicStep(epic)}`

// Each file that the PR adds under a supabase/migrations/ folder. `files` is one "status<tab>path"
// line per changed file, as PR_FILES prints them.
export function addedMigrations(files: string): string[] {
  const out: string[] = []
  for (const line of files.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const path = line.slice(tab + 1).trim()
    if (line.slice(0, tab) === 'added' && /(^|\/)supabase\/migrations\/[^/]+$/.test(path)) out.push(path)
  }
  return out
}
// The added migrations that the section addMigration writes in the PR body does not list.
export function unlistedMigrations(files: string, body: string): string[] {
  const section = SECTION.exec(body)?.[0] ?? ''
  const listed = new Set([...section.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]))
  return addedMigrations(files).filter(p => !listed.has(p))
}
// The changed files of a PR, a page at a time. Not pr-diff: GitHub refuses the diff of a PR over
// 300 files (HTTP 406), and lists up to 3000 files here.
const PR_FILES = (repo: string, n: number) => ['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', '.[] | [.status, .filename] | @tsv']

const link = (epic: Epic, n: number) => `https://github.com/${epic.repo}/issues/${n}`
const fileList = (files: string[]) => (files.length ? files.map(f => `- ${f}`).join('\n') : '- (the epic records no spec file: read the epic issue)')

export function implementerBrief(epic: Epic, sub: SubIssue, specFiles: string[]): string {
  return `# Implement #${sub.issue}: ${sub.title}

You are the implementer of one sub-issue of epic #${epic.epic} ("${epic.title}", ${link(epic, epic.epic)}).

Aim of the epic: ${epic.aim ?? '(not recorded)'}

Sub-issue: #${sub.issue} "${sub.title}", ${link(epic, sub.issue)}

Spec files:
${fileList(specFiles)}

## Rules

1. Read the issue, and the spec file(s) it names, before any code.
2. Work in this worktree under the usual workflow: call mcp__ndev__started with issue ${sub.issue} and set the steering to auto. Work test first.
3. Make one PR to the default branch.
4. Register each migration with mcp__ndev__addMigration.
5. Stay inside the issue. Report a discovery outside it; do not fix it, unless it blocks the checks.
6. Do not merge.
7. Do no hosted or paid action (real model calls, publishes, hosted migrations) without the coordinator's word.
8. When the spec and the code disagree, ask the coordinator with orca orchestration ask, and give a proposed default.
9. Finish with worker_done. Give the PR, the checks as passed / failed / not run, each departure from the spec, and the open questions.
`
}

export function reviewerBrief(epic: Epic, sub: SubIssue, specFiles: string[], pr = sub.pr): string {
  return `# Review PR #${pr ?? '?'} for #${sub.issue}: ${sub.title}

You are the reviewer of one sub-issue of epic #${epic.epic} ("${epic.title}", ${link(epic, epic.epic)}). This review is read-only: change no file, and make no commit, push or comment.

Aim of the epic: ${epic.aim ?? '(not recorded)'}

Sub-issue: #${sub.issue} "${sub.title}", ${link(epic, sub.issue)}
PR: PR #${pr ?? '?'}

Spec files:
${fileList(specFiles)}

## Rules

1. Review the diff against the issue and the spec, not against the implementer's summary.
2. Look for omissions, incorrect behaviour, missing or weak tests, over-engineering and breaks of the project rules.
3. Give each finding a severity (Critical, Important, Minor), its file:line, the spec text it breaks and the smallest fix.
4. Give the verdict APPROVE or CHANGES NEEDED.
5. Say what you did not run.
6. Report with worker_done.
`
}

// A value safe in a POSIX shell: plain when it holds only safe characters, else in single quotes.
export const shellQuote = (value: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

export type WorkerStartInput = { role: 'implementer' | 'reviewer'; briefPath: string; epic: Epic; sub: SubIssue; base?: string; pr?: number }
// The orca orchestration worker-start command for one worker. A flag whose value the record lacks is
// left out, and missing says which value and how to set it.
export function workerStartCommand(o: WorkerStartInput): { command: string; missing: string[] } | { refused: string } {
  const { epic, sub } = o
  const role = epic.roles[o.role]
  const missing: string[] = []
  const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, shellQuote(value)])
  if (!epic.run) missing.push(`run: the Orca run id is not recorded, so --run is left out. Set it with mcp__ndev__epicStarted with issue ${epic.epic} and run <id>.`)
  let place: string[]
  if (o.role === 'implementer') {
    if (!o.base) return { refused: `Refused: the default branch of ${epic.repo} is not known, so the implementer command has no --base-branch. Nothing was written.` }
    if (!epic.repoId) missing.push(`repoId: the Orca repository id is not recorded, so --repo is left out. Set it with mcp__ndev__epicStarted with issue ${epic.epic} and repoId <id>.`)
    place = ['--worktree', 'new-top-level', ...flag('--repo', epic.repoId && `id:${epic.repoId}`), '--name', shellQuote(`${sub.issue}-${sub.key}`), '--base-branch', shellQuote(`origin/${o.base}`)]
  } else {
    if (!sub.workspace) return { refused: `Refused: #${sub.issue} has no workspace, so the reviewer has no worktree to work in. Nothing was written. Repair: call mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "${sub.state}" and workspace (the absolute path of the implementer's worktree), then call epicBrief again.` }
    place = ['--worktree', shellQuote(`path:${sub.workspace}`)]
  }
  const title = o.role === 'implementer' ? `#${sub.issue} ${sub.title} (implementer)` : `#${sub.issue} ${sub.title} (reviewer, PR #${o.pr ?? sub.pr})`
  const argv = ['orca', 'orchestration', 'worker-start', '--spec-file', shellQuote(o.briefPath), '--task-title', shellQuote(title), ...flag('--run', epic.run), ...place, '--agent', shellQuote(role.agent), ...flag('--model', role.model), '--json']
  return { command: argv.join(' '), missing }
}

// ---- effects ----

type Args = Record<string, unknown> & { agentId?: string }
type Project = LoadedConfig | undefined
type Ctx = { args: Args; project: Project }

// The epic that this session coordinates.
const epicBound = atom({ plugin: 'ndev', key: 'epicBound' } as const, null as { root: string; issue: number } | null, { shape: 'epic-bound-1' })

const recordName = (n: number) => `.neil-dev.epic-${n}.json`
const recordPath = (root: string, n: number) => `${root}/${recordName(n)}`
const IGNORE_LINE = '.neil-dev.epic-*.json'
const str = (a: Args, key: string) => (typeof a[key] === 'string' ? (a[key] as string).trim() : '')
const isCount = (x: unknown) => typeof x === 'number' ? Number.isInteger(x) && x > 0 : typeof x === 'string' && /^[1-9]\d*$/.test(x.trim())

async function rootOf($: EngineInterface, project: Project): Promise<string> {
  const root = (await boundRoot($)) ?? project?.root
  if (!root) throw new Refuse('Refused: the project folder is not known. Start a new session in the project.')
  return root
}

export async function loadEpic($: EngineInterface, root: string, n: number): Promise<Epic | undefined> {
  const path = recordPath(root, n)
  if (!(await $.fs.exists(path))) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Refuse(`${path} is not valid JSON (${String(error).slice(0, 160)}). Repair: fix the file, then call the tool again.`)
  }
  const epic = raw as Partial<Epic> | null
  if (!epic || epic.epic !== n || !EPIC_STATES.includes(epic.state as EpicState) || typeof epic.issues !== 'object' || !Array.isArray(epic.history)) {
    throw new Refuse(`${path} is not an epic record for #${n}: it needs epic ${n}, a state from ${EPIC_STATES.join(', ')}, issues and history. Repair: fix the file, then call the tool again.`)
  }
  return epic as Epic
}

// The record is git-ignored as the issue records are: in the shared info/exclude when no rule ignores it.
async function ensureIgnored($: EngineInterface, root: string, n: number): Promise<void> {
  const probe = recordName(n)
  const tracked = await git(root, $, 'ls-files', '--', probe)
  if (tracked.exitCode === 0 && tracked.stdout.trim()) throw new Refuse(`Refused: ${probe} is tracked by git in ${root}, so the record would be committed. Nothing was recorded. Repair: git rm --cached ${probe}, add \`${IGNORE_LINE}\` to .gitignore, then call the tool again.`)
  const first = await git(root, $, 'check-ignore', '-q', probe)
  if (first.exitCode === 0) return
  if (first.exitCode !== 1) throw new Error(`git check-ignore ${probe} exited ${first.exitCode} in ${root}: ${first.stderr.trim()}`)
  const common = (await gitOut(root, $, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')).split('\n')[1]!
  const exclude = `${common}/info/exclude`
  const text = (await $.fs.exists(exclude)) ? await $.fs.read(exclude) : ''
  await $.fs.write(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${IGNORE_LINE}\n`)
  const again = await git(root, $, 'check-ignore', '-q', probe)
  if (again.exitCode !== 0) throw new Refuse(`Refused: ${probe} is not git-ignored in ${root} after the line \`${IGNORE_LINE}\` went into ${exclude}, so it could be committed. Nothing was recorded. Repair: add the line to the project's .gitignore, remove any line that un-ignores it, then call the tool again.`)
}

async function saveEpic($: EngineInterface, epic: Epic): Promise<void> {
  await ensureIgnored($, epic.root, epic.epic)
  epic.owner = { session: await $.session.id(), at: await $.clock.now() }
  await $.fs.write(recordPath(epic.root, epic.epic), `${JSON.stringify(epic, null, 2)}\n`)
}

// The epic named by the call, which must be the one that this session coordinates.
async function boundEpic($: EngineInterface, c: Ctx, tool: string): Promise<Epic> {
  const bound = await read($, epicBound)
  const asked = c.args.issue === undefined ? bound?.issue : Number(c.args.issue)
  if (asked === undefined) throw new Refuse(`Refused: this session coordinates no epic. Call mcp__ndev__epicStarted first.`)
  if (!isCount(asked)) throw new Refuse(`Refused: ${tool} needs issue, the number of the epic, and it got ${JSON.stringify(c.args.issue)}. Nothing changed.`)
  if (!bound || bound.issue !== asked) throw new Refuse(`Refused: this session does not coordinate epic #${asked}. Nothing changed. Repair: call mcp__ndev__epicStarted with issue ${asked}.`)
  const epic = await loadEpic($, bound.root, asked)
  if (!epic) throw new Refuse(`Refused: ${recordPath(bound.root, asked)} is gone. Nothing changed. Repair: call mcp__ndev__epicStarted with issue ${asked} to start it again.`)
  return epic
}

const moved = (epic: Epic, tool: string, to: string, at: number, from?: string) => epic.history.push({ at, tool, ...(from ? { from } : {}), to })
const answer = (epic: Epic, lead: string) => `${lead}\nEpic #${epic.epic} is in the state "${epic.state}". Next: ${epicStep(epic)}`

function roleOf(value: unknown, name: string, fallback: Role): Role {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.trim()) return { agent: value.trim() }
  const r = value as { agent?: unknown; model?: unknown } | null
  if (r && typeof r === 'object' && typeof r.agent === 'string' && r.agent.trim() && (r.model === undefined || (typeof r.model === 'string' && r.model.trim()))) return { agent: r.agent.trim(), ...(r.model ? { model: (r.model as string).trim() } : {}) }
  throw new Refuse(`Refused: ${name} must be an agent name such as "claude", or { agent, model? }, and it is ${JSON.stringify(value)}. Nothing changed.`)
}

async function fileEpicIssue($: EngineInterface, root: string, repo: string, title: string): Promise<number> {
  const { gitDir } = await paths($, root)
  const bodyFile = `${gitDir}/ndev-new-epic.md`
  await $.fs.write(bodyFile, `${title}\n\nThis is an epic. The coordinator session plans it and coordinates its sub-issues.\n`)
  const made = await gh($, root, repo, ['issue-new', '--title', title, '--body-file', bodyFile])
  const issue = Number(/(?:\/issues\/|"number":\s*)(\d+)/.exec(made)?.[1])
  if (!issue) throw new Error(`gh.sh issue-new printed no issue number: ${made.slice(0, 200)}`)
  return issue
}

async function epicStarted($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const root = await rootOf($, project)
  const session = await $.session.id()
  const now = await $.clock.now()
  const usual = await loadWorkflow($, root)
  if (usual && usual.state !== 'done' && !usual.off && (!usual.owner || usual.owner.session === session)) {
    throw new Refuse(`Refused: this session has the usual workflow open for #${usual.issue} (state "${usual.state}"). Nothing changed. Repair: finish it, or ask the human to run /flow off, then call epicStarted again.`)
  }
  if (args.parallel !== undefined && !isCount(args.parallel)) throw new Refuse(`Refused: parallel must be a whole number of 1 or more, and it is ${JSON.stringify(args.parallel)}. Nothing changed.`)
  const shortName = str(args, 'shortName')
  if (shortName && !SHORT_NAME.test(shortName)) throw new Refuse(`Refused: shortName must be two to five lower-case words joined by hyphens, such as "rework-billing". It is ${JSON.stringify(shortName)}. Nothing changed.`)
  for (const key of ['run', 'repoId']) if (args[key] !== undefined && !str(args, key)) throw new Refuse(`Refused: ${key} must be a non-empty string, and it is ${JSON.stringify(args[key])}. Nothing changed.`)
  const repo = project?.config.github?.repo ?? (await repoFromOrigin($, root))
  let n: number
  let title: string
  let lead: string
  if (args.issue === undefined) {
    title = str(args, 'title')
    if (!title) throw new Refuse('Refused: epicStarted needs issue (an open epic issue), or title to file a new one. Nothing was filed.')
    n = await fileEpicIssue($, root, repo, title)
    lead = `Filed epic #${n}: ${`https://github.com/${repo}/issues/${n}`}`
  } else {
    if (!isCount(args.issue)) throw new Refuse(`Refused: issue must be the epic's issue number, and it is ${JSON.stringify(args.issue)}. Nothing changed.`)
    n = Number(args.issue)
    const existing = await loadEpic($, root, n)
    if (existing) {
      const owner = existing.owner
      if (owner && owner.session !== session && now - owner.at < OWNER_LIVE_MS && args.takeOver !== true) {
        throw new Refuse(`Refused: the session ${owner.session} owns epic #${n}. Nothing changed. Leave it to that session. If that session is dead, call epicStarted with issue ${n} and takeOver true.`)
      }
      existing.parallel = args.parallel !== undefined ? Number(args.parallel) : existing.parallel
      existing.roles = { implementer: roleOf(args.implementer, 'implementer', existing.roles.implementer), reviewer: roleOf(args.reviewer, 'reviewer', existing.roles.reviewer) }
      if (str(args, 'run')) existing.run = str(args, 'run')
      if (str(args, 'repoId')) existing.repoId = str(args, 'repoId')
      if (shortName) existing.shortName = shortName
      moved(existing, 'epicStarted', existing.state, now)
      return begin($, existing, `Resumed epic #${n}: ${link(existing, n)}`)
    }
    const read = await ghOne<{ state: string; title: string }>($, root, repo, ['issue-read', String(n)])
    if (read.state !== 'open') throw new Refuse(`Refused: #${n} is ${read.state} on GitHub, so it cannot be the epic. Nothing changed. Repair: reopen it, or call epicStarted with title to file a new epic.`)
    title = read.title
    lead = `Started epic #${n}: ${`https://github.com/${repo}/issues/${n}`}`
  }
  const epic: Epic = {
    epic: n, repo, root, title, state: 'framing', ...(shortName ? { shortName } : {}), evidence: {},
    parallel: args.parallel !== undefined ? Number(args.parallel) : DEFAULT_PARALLEL,
    roles: { implementer: roleOf(args.implementer, 'implementer', { agent: 'claude' }), reviewer: roleOf(args.reviewer, 'reviewer', { agent: 'codex' }) },
    ...(str(args, 'run') ? { run: str(args, 'run') } : {}), ...(str(args, 'repoId') ? { repoId: str(args, 'repoId') } : {}),
    issues: {}, history: [],
  }
  moved(epic, 'epicStarted', 'framing', now)
  return begin($, epic, lead)
}

async function begin($: EngineInterface, epic: Epic, lead: string): Promise<string> {
  await saveEpic($, epic)
  await update($, epicBound, () => ({ root: epic.root, issue: epic.epic }))
  // The coordinator is not under the usual one-issue workflow: started refuses and no reminder comes.
  await setDeclined($, true)
  return answer(epic, `${lead}\nThis session coordinates the epic. The usual workflow is off for this session until the epic is done or the human runs /flow epic off.`)
}

async function phaseFiles($: EngineInterface, epic: Epic, args: Args, what: string): Promise<string[]> {
  const files = Array.isArray(args.files) ? (args.files as unknown[]).map(f => String(f).trim()).filter(Boolean) : []
  if (!files.length) throw new Refuse(`Refused: "${epic.state}" needs files: ${what}. Nothing changed.`)
  const full = files.map(f => (f.startsWith('/') ? f : `${epic.root}/${f}`))
  const missing: string[] = []
  for (const f of full) if (!(await $.fs.exists(f))) missing.push(f)
  if (missing.length) throw new Refuse(`Refused: these files do not exist: ${missing.join(', ')}. Nothing changed. Repair: write them, or name the right paths.`)
  return full
}

function slicesOf(args: Args): Slice[] {
  if (!Array.isArray(args.issues)) throw new Refuse(`Refused: "slicing" needs issues, a list of { issue, key, title, blockedBy }, and it got ${JSON.stringify(args.issues)}. Nothing changed.`)
  return (args.issues as unknown[]).map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>
    const blockedBy = s.blockedBy === undefined ? [] : s.blockedBy
    if (!isCount(s.issue)) throw new Refuse(`Refused: issues[${i}].issue must be an issue number, and it is ${JSON.stringify(s.issue)}. Nothing changed.`)
    if (typeof s.key !== 'string' || !KEY.test(s.key)) throw new Refuse(`Refused: issues[${i}].key must be lower-case letters, digits and hyphens (at most 40), such as "schema"; it names the worker. It is ${JSON.stringify(s.key)}. Nothing changed.`)
    if (typeof s.title !== 'string' || !s.title.trim()) throw new Refuse(`Refused: issues[${i}].title is empty. Nothing changed.`)
    if (!Array.isArray(blockedBy) || !blockedBy.every(isCount)) throw new Refuse(`Refused: issues[${i}].blockedBy must be a list of issue numbers, and it is ${JSON.stringify(blockedBy)}. Nothing changed.`)
    return { issue: Number(s.issue), key: s.key, title: s.title.trim(), blockedBy: (blockedBy as unknown[]).map(Number) }
  })
}

async function epicPhase($: EngineInterface, c: Ctx): Promise<string> {
  const { args } = c
  const epic = await boundEpic($, c, 'epicPhase')
  const finished = str(args, 'finished')
  if (finished !== epic.state) throw new Refuse(`Refused: epic #${epic.epic} is in the state "${epic.state}", and the call says "${finished}" is finished. Nothing changed. Only the human skips a phase, with /flow epic skip.`)
  const evidence = str(args, 'evidence')
  if (!evidence) throw new Refuse(`Refused: "${epic.state}" needs evidence: what the phase did and showed. Nothing changed.`)
  const now = await $.clock.now()
  let files: string[] | undefined
  let after = ''
  switch (epic.state) {
    case 'framing': {
      const aim = str(args, 'aim')
      if (!aim) throw new Refuse('Refused: "framing" needs aim: one or two sentences that say what the epic is for. Nothing changed.')
      epic.aim = aim
      break
    }
    case 'researching': files = await phaseFiles($, epic, args, 'the research notes, each of which exists'); break
    case 'specifying': files = await phaseFiles($, epic, args, 'the spec, which exists'); break
    case 'spec-review': files = await phaseFiles($, epic, args, 'at least one review file of the spec, which exists'); break
    case 'slicing': {
      const slices = slicesOf(args)
      const problem = sliceProblems(slices)
      if (problem) throw new Refuse(`Refused: ${problem}. Nothing changed. Repair: correct the list and call epicPhase again.`)
      const problems: string[] = []
      for (const s of slices) {
        try {
          const got = await ghOne<{ state: string }>($, epic.root, epic.repo, ['issue-read', String(s.issue)])
          if (got.state !== 'open') problems.push(`#${s.issue} is ${got.state}`)
        } catch (error) {
          problems.push(`#${s.issue} could not be read: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (problems.length) throw new Refuse(`Refused: each sub-issue must be open in ${epic.repo}. ${problems.join('; ')}. Nothing changed. Repair: file or reopen them, or correct the list.`)
      epic.issues = Object.fromEntries(slices.map(s => [String(s.issue), { ...s, state: 'waiting' as const, rounds: 0 }]))
      after = `\n${frontierText(epic)}`
      break
    }
    case 'coordinating': {
      const open = Object.values(epic.issues).filter(i => i.state !== 'merged').sort((a, b) => a.issue - b.issue)
      if (open.length) throw new Refuse(`Refused: these sub-issues are not merged: ${open.map(i => `#${i.issue} ("${i.state}")`).join(', ')}. Nothing changed.`)
      break
    }
    case 'done': throw new Refuse(`Refused: epic #${epic.epic} is done. Nothing changed.`)
    default: break
  }
  const from = epic.state
  epic.evidence[from] = { at: now, text: evidence, ...(files ? { files } : {}) }
  epic.state = nextEpicState(from)!
  moved(epic, 'epicPhase', epic.state, now, from)
  await saveEpic($, epic)
  if (epic.state === 'done') {
    await finishEpic($)
    return `Epic #${epic.epic} is done. The usual workflow is on again for this session.`
  }
  return answer(epic, `"${from}" is finished.${after}`)
}

async function finishEpic($: EngineInterface): Promise<void> {
  await update($, epicBound, () => null)
  await setDeclined($, false)
}

async function epicNext($: EngineInterface, c: Ctx): Promise<string> {
  const epic = await boundEpic($, c, 'epicNext')
  if (epic.state !== 'coordinating') return answer(epic, `Epic #${epic.epic} has no frontier in the state "${epic.state}".`)
  return answer(epic, frontierText(epic))
}

function subOf(epic: Epic, args: Args): SubIssue {
  if (!isCount(args.sub)) throw new Refuse(`Refused: sub must be the number of a sub-issue, and it is ${JSON.stringify(args.sub)}. Nothing changed.`)
  const sub = epic.issues[String(Number(args.sub))]
  if (!sub) throw new Refuse(`Refused: #${Number(args.sub)} is not a sub-issue of epic #${epic.epic}. Its sub-issues are ${tags(Object.values(epic.issues).map(i => i.issue)) || 'none yet'}. Nothing changed.`)
  return sub
}

async function epicBrief($: EngineInterface, c: Ctx): Promise<string> {
  const { args } = c
  const epic = await boundEpic($, c, 'epicBrief')
  const sub = subOf(epic, args)
  const role = str(args, 'role')
  if (role !== 'implementer' && role !== 'reviewer') throw new Refuse(`Refused: role must be "implementer" or "reviewer", and it is ${JSON.stringify(args.role)}. Nothing was written.`)
  const specFiles = epic.evidence.specifying?.files ?? []
  let pr: number | undefined
  let base: string | undefined
  if (role === 'reviewer') {
    if (args.pr !== undefined && !isCount(args.pr)) throw new Refuse(`Refused: pr must be a PR number, and it is ${JSON.stringify(args.pr)}. Nothing was written.`)
    pr = args.pr !== undefined ? Number(args.pr) : sub.pr
    if (!pr) throw new Refuse(`Refused: a reviewer brief needs the PR: #${sub.issue} has no pr recorded. Nothing was written. Repair: call epicBrief with pr, the number of the implementer's PR.`)
  } else {
    base = await defaultBranch($, epic.root, epic.repo)
  }
  const { gitDir } = await paths($, epic.root)
  const folder = `${gitDir}/ndev-epic`
  const path = `${folder}/epic-${epic.epic}-${sub.issue}-${role}.md`
  const built = workerStartCommand({ role, briefPath: path, epic, sub, base, pr })
  if ('refused' in built) throw new Refuse(built.refused)
  const made = await run($, ['mkdir', '-p', folder], { cwd: epic.root })
  if (made.exitCode !== 0) throw new Error(`mkdir -p ${folder} exited ${made.exitCode}: ${made.stderr.trim()}`)
  await $.fs.write(path, role === 'implementer' ? implementerBrief(epic, sub, specFiles) : reviewerBrief(epic, sub, specFiles, pr))
  const record = role === 'implementer'
    ? `mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "implementing", worker (the dispatch id) and workspace (the absolute path of the new worktree)`
    : `mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "reviewing", pr ${pr} and worker (the dispatch id)`
  const missing = built.missing.length ? `\nMissing values:\n${built.missing.map(m => `- ${m}`).join('\n')}` : ''
  return `Brief for the ${role} of #${sub.issue}: ${path}\nRun this command:\n${built.command}${missing}\nNext: run the command, then record the dispatch id with ${record}.`
}

const MOVES: Record<IssueState, IssueState[]> = {
  waiting: ['implementing'],
  implementing: ['reviewing'],
  reviewing: ['fixing', 'verified'],
  fixing: ['reviewing'],
  verified: ['merged'],
  merged: [],
  blocked: [],
}

async function epicIssue($: EngineInterface, c: Ctx): Promise<string> {
  const { args } = c
  const epic = await boundEpic($, c, 'epicIssue')
  if (epic.state !== 'coordinating') throw new Refuse(`Refused: sub-issues move only in the state "coordinating", and epic #${epic.epic} is in "${epic.state}". Nothing changed.`)
  const sub = subOf(epic, args)
  const to = str(args, 'state') as IssueState
  if (!ISSUE_STATES.includes(to)) throw new Refuse(`Refused: state must be one of ${ISSUE_STATES.join(', ')}, and it is ${JSON.stringify(args.state)}. Nothing changed.`)
  const worker = str(args, 'worker')
  const note = str(args, 'note')
  const workspace = str(args, 'workspace')
  if (args.workspace !== undefined && !workspace.startsWith('/')) throw new Refuse(`Refused: workspace must be the absolute path of the implementer's worktree, and it is ${JSON.stringify(args.workspace)}. Nothing changed.`)
  const now = await $.clock.now()
  const from = sub.state
  let extra = ''
  // The same state with a workspace records the workspace and moves nothing.
  if (to === from && workspace && to !== 'blocked') {
    sub.workspace = workspace
    await saveEpic($, epic)
    return answer(epic, `#${sub.issue} keeps the state "${from}"; its workspace is ${workspace}.`)
  }
  if (to === 'blocked') {
    if (from === 'blocked' || from === 'merged') throw new Refuse(`Refused: #${sub.issue} is "${from}" and cannot be blocked. Nothing changed.`)
    if (!note) throw new Refuse(`Refused: a block needs note: what blocks #${sub.issue} and who can end it. Nothing changed.`)
    sub.previous = from
    sub.note = note
  } else if (from === 'blocked') {
    if (to !== sub.previous) throw new Refuse(`Refused: #${sub.issue} is blocked, and goes back only to the state it was in, "${sub.previous}". Nothing changed.`)
    sub.previous = undefined
  } else {
    if (!MOVES[from].includes(to)) throw new Refuse(`Refused: #${sub.issue} is in the state "${from}", and "${to}" does not follow it. From "${from}" it goes to: ${[...MOVES[from], ...(from === 'merged' ? [] : ['blocked'])].join(', ') || 'nothing'}. Nothing changed.`)
    switch (`${from}>${to}`) {
      case 'waiting>implementing': {
        const merged = new Set(Object.values(epic.issues).filter(i => i.state === 'merged').map(i => i.issue))
        const open = sub.blockedBy.filter(b => !merged.has(b))
        if (open.length) throw new Refuse(`Refused: #${sub.issue} is not on the frontier: it waits for ${tags(open)} to merge. Nothing changed.`)
        const inFlight = Object.values(epic.issues).filter(i => IN_FLIGHT.includes(i.state))
        if (inFlight.length >= epic.parallel) throw new Refuse(`Refused: all ${epic.parallel} parallel places are taken by ${tags(inFlight.map(i => i.issue))}. Nothing changed. Repair: wait for one to merge, or ask the human to raise parallel (epicStarted with parallel).`)
        if (!worker) throw new Refuse(`Refused: "implementing" needs worker, the dispatch id of the implementer. Nothing changed.`)
        sub.implementer = worker
        if (workspace) sub.workspace = workspace
        break
      }
      case 'implementing>reviewing': {
        if (!isCount(args.pr)) throw new Refuse(`Refused: "reviewing" needs pr, the number of the implementer's PR, and it got ${JSON.stringify(args.pr)}. Nothing changed.`)
        if (!worker) throw new Refuse(`Refused: "reviewing" needs worker, the dispatch id of the reviewer. Nothing changed.`)
        sub.pr = Number(args.pr)
        sub.reviewer = worker
        if (workspace) sub.workspace = workspace
        break
      }
      case 'reviewing>fixing': {
        if (args.verdict !== 'changes' || !note) throw new Refuse(`Refused: "fixing" needs verdict "changes" and note: your ruling on each finding. Nothing changed.`)
        sub.verdict = 'changes'
        sub.note = note
        sub.rounds += 1
        if (sub.rounds >= ROUND_LIMIT) extra = `\n#${sub.issue} has had ${sub.rounds} rounds of review. Stop and decide: narrow the issue, take it over, or ask the human.`
        break
      }
      case 'fixing>reviewing': {
        if (worker) sub.reviewer = worker
        break
      }
      case 'reviewing>verified': {
        if (args.verdict !== 'approve' && !(args.verdict === 'changes' && note)) throw new Refuse(`Refused: "verified" needs verdict "approve", or verdict "changes" with a note that says each finding was fixed or overruled. Nothing changed.`)
        const report = await verify($, epic, sub)
        sub.verdict = args.verdict as 'approve' | 'changes'
        if (note) sub.note = note
        extra = `\n${report}\nNext: merge PR #${sub.pr}, then call epicIssue with state "merged".`
        break
      }
      case 'verified>merged': {
        const pr = await readPr($, epic.root, epic.repo, sub.pr!)
        if (!pr.merged) throw new Refuse(`Refused: GitHub says PR #${sub.pr} is not merged (state "${pr.state}"). Nothing changed. Repair: merge it, then call epicIssue again.`)
        break
      }
    }
  }
  sub.state = to
  moved(epic, `epicIssue #${sub.issue}`, to, now, from)
  await saveEpic($, epic)
  return answer(epic, `#${sub.issue} moved from "${from}" to "${to}".${extra}${to === 'merged' ? `\n${frontierText(epic)}` : ''}`)
}

// The checks before a sub-issue counts as verified. Each one is passed, failed or not run.
async function verify($: EngineInterface, epic: Epic, sub: SubIssue): Promise<string> {
  const passed: string[] = []
  const failed: string[] = []
  const notRun: string[] = []
  const n = sub.pr!
  const error = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
  let body = ''
  try {
    const pr = await readPr($, epic.root, epic.repo, n)
    body = pr.body ?? ''
    if (pr.state !== 'open') failed.push(`the PR is ${pr.state}`)
    else if (pr.draft) failed.push('the PR is a draft')
    else passed.push('open and not a draft')
    if (pr.mergeable === true) passed.push('mergeable')
    else if (pr.mergeable === false) failed.push(`not mergeable (${pr.mergeable_state ?? 'unknown'})`)
    else notRun.push('mergeable: GitHub has not computed it yet')
    try {
      const checks = await readChecks($, epic.root, epic.repo, pr.head.sha, n)
      if (checks.red.length) failed.push(`checks failed: ${checks.red.join(', ')}`)
      if (checks.pending.length) failed.push(`checks not ended: ${checks.pending.join(', ')}`)
      if (!checks.red.length && !checks.pending.length) passed.push(`checks (${checks.green.length} passed${checks.green.length ? `: ${checks.green.join(', ')}` : ''})`)
    } catch (e) {
      notRun.push(`checks: ${error(e)}`)
    }
  } catch (e) {
    notRun.push(`the PR, its checks and mergeability: ${error(e)}`)
  }
  let missingMigrations: string[] = []
  try {
    const files = await gh($, epic.root, epic.repo, PR_FILES(epic.repo, n))
    missingMigrations = unlistedMigrations(files, body)
    const added = addedMigrations(files).length
    if (missingMigrations.length) failed.push(`migrations not listed in the PR body: ${missingMigrations.join(', ')}`)
    else passed.push(`migrations (${added ? `${added} added, each listed` : 'none added'})`)
  } catch (e) {
    notRun.push(`migrations: the changed files of PR #${n} were not read: ${error(e)}`)
  }
  const report = [`Passed: ${passed.join('; ') || 'none'}.`, `Failed: ${failed.join('; ') || 'none'}.`, `Not run: ${notRun.join('; ') || 'none'}.`].join('\n')
  if (!failed.length && !notRun.length) return report
  const repairs = [
    ...(missingMigrations.length ? [`the implementer must add each migration with mcp__ndev__addMigration, so the PR body lists it`] : []),
    ...(notRun.length ? ['run the verify again when GitHub answers'] : []),
    ...(failed.length && !missingMigrations.length ? ['send the failures to the implementer, or move the issue to "fixing"'] : []),
  ]
  throw new Refuse(`Refused: PR #${n} for #${sub.issue} is not verified. Nothing changed.\n${report}\nRepair: ${repairs.join('; ')}.`)
}

function statusText(epic: Epic): string {
  const rows = Object.values(epic.issues).sort((a, b) => a.issue - b.issue).map(i => `- #${i.issue} "${i.title}": ${i.state}${i.pr ? `, PR #${i.pr}` : ''}${i.rounds ? `, ${i.rounds} rounds` : ''}${i.blockedBy.length ? `, after ${tags(i.blockedBy)}` : ''}${i.state === 'blocked' && i.note ? ` (${i.note})` : ''}`)
  return `Epic #${epic.epic} "${epic.title}" in ${epic.root} is in the state "${epic.state}". Next: ${epicStep(epic)}${rows.length ? `\nSub-issues:\n${rows.join('\n')}` : ''}`
}

async function epicStatus($: EngineInterface, c: Ctx): Promise<string> {
  return statusText(await boundEpic($, c, 'epicStatus'))
}

// The engine follows $ only into functions named at the top of a file, so the tools are a switch.
async function dispatch($: EngineInterface, name: string, c: Ctx): Promise<string> {
  switch (name) {
    case 'epicStarted': return epicStarted($, c)
    case 'epicPhase': return epicPhase($, c)
    case 'epicNext': return epicNext($, c)
    case 'epicBrief': return epicBrief($, c)
    case 'epicIssue': return epicIssue($, c)
    case 'epicStatus': return epicStatus($, c)
    default: throw new Error(`no epic tool named ${name}`)
  }
}

const num = (description: string) => ({ type: 'number', description })
const string = (description: string) => ({ type: 'string', description })
const role = (description: string) => ({ description, anyOf: [{ type: 'string' }, { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' } }, required: ['agent'] }] })
type Spec = { name: string; description: string; properties: Record<string, unknown>; required: string[] }
const SPECS: Spec[] = [
  {
    name: 'epicStarted',
    description: 'Start or resume an epic in this session. The session becomes its coordinator, and the usual one-issue workflow turns off for the session. With no issue, title files the epic issue. Answers with the state and the next step.',
    properties: {
      issue: num('The epic issue, to start or resume it'),
      title: string('With no issue: the title of a new epic issue'),
      shortName: string('Optional: two to five lower-case words joined by hyphens'),
      parallel: num('Optional: the most sub-issues in flight at once. The default is 4'),
      implementer: role('Optional: the implementer agent, such as "claude" or { agent, model }. The default is claude'),
      reviewer: role('Optional: the reviewer agent. The default is codex'),
      run: string('Optional: the Orca run id, for the worker-start commands'),
      repoId: string('Optional: the Orca repository id, for the worker-start commands'),
      takeOver: { type: 'boolean', description: 'Only when the session that owns the epic is dead' },
    },
    required: [],
  },
  {
    name: 'epicPhase',
    description: 'The named phase of the epic is complete: check it and go to the next phase. Only the current phase can finish.',
    properties: {
      issue: num('The epic issue'),
      finished: { type: 'string', enum: EPIC_STATES.slice(0, -1), description: 'The phase that is complete: the current state' },
      evidence: string('What the phase did and showed'),
      files: { type: 'array', items: { type: 'string' }, description: 'researching: the notes; specifying: the spec; spec-review: the review. Each must exist' },
      aim: string('framing only: one or two sentences that say what the epic is for'),
      issues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'number' }, key: { type: 'string' }, title: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'number' } } }, required: ['issue', 'key', 'title'] }, description: 'slicing only: the sub-issues, each open on GitHub' },
    },
    required: ['issue', 'finished', 'evidence'],
  },
  { name: 'epicNext', description: 'Read-only: the sub-issues that can start now, what is in flight, and what waits or is blocked.', properties: { issue: num('The epic issue') }, required: ['issue'] },
  {
    name: 'epicBrief',
    description: 'Write the brief for a worker of one sub-issue to a file, and answer with its path and the orca orchestration worker-start command to run.',
    properties: { issue: num('The epic issue'), sub: num('The sub-issue'), role: { type: 'string', enum: ['implementer', 'reviewer'] }, pr: num('reviewer only: the PR, when the record has none yet') },
    required: ['issue', 'sub', 'role'],
  },
  {
    name: 'epicIssue',
    description: 'Record a move of one sub-issue: waiting→implementing, implementing→reviewing, reviewing→fixing, fixing→reviewing, reviewing→verified (runs the verify checks), verified→merged, any→blocked and back. The same state with workspace records the workspace only.',
    properties: {
      issue: num('The epic issue'),
      sub: num('The sub-issue'),
      state: { type: 'string', enum: ISSUE_STATES },
      pr: num('implementing→reviewing: the PR'),
      worker: string('The dispatch id of the worker that starts now'),
      workspace: string("The absolute path of the implementer's worktree"),
      verdict: { type: 'string', enum: ['approve', 'changes'] },
      note: string('fixing: your ruling on each finding; blocked: what blocks it'),
    },
    required: ['issue', 'sub', 'state'],
  },
  { name: 'epicStatus', description: 'Read-only: the epic state, the next step and the sub-issues by state.', properties: { issue: num('Optional: the epic issue') }, required: [] },
]

export async function startEpic($: EngineInterface): Promise<void> {
  for (const s of SPECS) await $.tool.register({ name: s.name, description: s.description, inputSchema: { type: 'object', properties: s.properties, required: s.required }, isDeferred: false })
}

export const epicTools = (on: Parameters<Register>[0], project: () => Project) => {
  for (const s of SPECS) {
    on('tool.call', { tool: `mcp__ndev__${s.name}` }, async ($, e): Promise<{ result: string; isError?: true }> => {
      const args = e as unknown as Args
      if (args.agentId) return { result: `Refused: only the main agent calls ${s.name}. A helper does not move the epic. Report to the main agent.`, isError: true as const }
      try {
        return { result: await inTurn(() => dispatch($, s.name, { args, project: project() })) }
      } catch (error) {
        if (error instanceof Refuse) return { result: error.message, isError: true as const }
        return { result: `epic ${s.name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true as const }
      }
    })
  }
}

// The system line, while this session coordinates an epic that is not done.
export async function epicLine($: EngineInterface): Promise<string | undefined> {
  const bound = await read($, epicBound)
  if (!bound) return undefined
  const epic = await loadEpic($, bound.root, bound.issue)
  if (!epic) return `Epic: #${bound.issue} is bound to this session, and ${recordPath(bound.root, bound.issue)} is gone. Ask the human to run /flow epic off, or call mcp__ndev__epicStarted with issue ${bound.issue}.`
  return epic.state === 'done' ? undefined : epicLineOf(epic)
}

export const EPIC_HELP = [
  '/flow epic [issue|title]: tell the agent to start or resume an epic and coordinate it. With an epic in the session, show its status.',
  '/flow epic status: the epic state, the next step and the sub-issues.',
  '/flow epic skip [reason]: leave the current epic phase and go to the next one.',
  '/flow epic goto <state> [reason]: move the epic to any state.',
  '/flow epic off: stop coordinating the epic in this session, and turn the usual workflow back on. The record stays.',
]

function tellCoordinator($: EngineInterface, text: string): void {
  // A command hook holds the turn, and the host refuses a prompt from inside it: submit just after.
  void $.clock.after(100, async () => {
    try {
      await $.prompt.submit({ text })
    } catch (error) {
      $.ui.toast(`epic: the agent was not told: ${error instanceof Error ? error.message : String(error)}. Tell it: ${text}`.slice(0, 400))
    }
  })
}

async function humanMove($: EngineInterface, epic: Epic, to: EpicState, how: 'skip' | 'goto', reason: string): Promise<string> {
  const now = await $.clock.now()
  const from = epic.state
  epic.evidence[from] = { at: now, text: `The human ran /flow epic ${how}: ${reason || 'no reason given'}`, ...(epic.evidence[from]?.files ? { files: epic.evidence[from]!.files } : {}) }
  epic.state = to
  moved(epic, `human:${how}`, to, now, from)
  await saveEpic($, epic)
  if (to === 'done') {
    await finishEpic($)
    tellCoordinator($, `The human moved epic #${epic.epic} from "${from}" to "done". The usual workflow is on again for this session.`)
    return `Epic #${epic.epic} moved from "${from}" to "done". The usual workflow is on again for this session.`
  }
  tellCoordinator($, `The human moved epic #${epic.epic} from "${from}" to "${to}". Next: ${epicStep(epic)}`)
  return `Epic #${epic.epic} moved from "${from}" to "${to}". The agent is told.`
}

// /flow epic ...: the human's controls over the epic.
export async function epicCommand($: EngineInterface, words: string[], project: Project): Promise<string> {
  const [verb, ...rest] = words
  const reason = rest.join(' ')
  const bound = await read($, epicBound)
  const epic = bound ? await loadEpic($, bound.root, bound.issue) : undefined
  const none = 'No epic in this session. Start one with /flow epic <issue number or title>.'
  if (verb === 'status' || verb === undefined) {
    if (epic) return statusText(epic)
    if (verb === 'status') return none
  }
  if (verb === 'off') {
    if (!bound) return none
    await finishEpic($)
    return `This session no longer coordinates epic #${bound.issue}. The usual workflow is on again. The record ${recordPath(bound.root, bound.issue)} stays: /flow epic ${bound.issue} resumes it.`
  }
  if (verb === 'skip' || verb === 'goto') {
    if (!epic) return none
    if (verb === 'skip') {
      const to = nextEpicState(epic.state)
      if (!to) return `Epic #${epic.epic} is done. Nothing to skip.`
      return humanMove($, epic, to, 'skip', reason)
    }
    const to = rest[0] as EpicState | undefined
    if (!to || !EPIC_STATES.includes(to)) return `/flow epic goto needs a state: ${EPIC_STATES.join(', ')}.`
    return humanMove($, epic, to, 'goto', rest.slice(1).join(' '))
  }
  if (epic && epic.state !== 'done') return statusText(epic)
  if (!project) return 'Not started: the project folder is not known yet.'
  const all = words.join(' ').trim()
  const target = /^#?[1-9]\d*$/.test(all) ? `issue ${all.replace('#', '')}` : `title ${JSON.stringify(all)} (it files the epic issue) and a shortName of two to five words`
  if (!all) return `${none}\n\n${EPIC_HELP.join('\n')}`
  tellCoordinator($, `The human ran /flow epic. Call mcp__ndev__epicStarted with ${target}, then load the skill that its answer names and follow its next step.`)
  return /^#?[1-9]\d*$/.test(all) ? `The agent is told to start or resume epic #${all.replace('#', '')}.` : `The agent is told to file and start the epic "${all}".`
}
