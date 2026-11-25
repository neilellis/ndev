// The epic workflow: one coordinator session plans an epic and then coordinates its sub-issues, which
// Orca workers implement and review under the usual workflow. The record is the worktree's
// .neil-dev.epic-<issue>.json. The pure part (the phases, the slicing checks, the frontier, the briefs
// and the worker command) is first; the tools, the system line and /flow epic come after it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoadedConfig } from '../config'
import { type Server, triageRemote } from '../remote'
import { Refuse, defaultBranch, gh, ghOne, gitOut, git, paths, readChecks, readPr, repoFromOrigin, run, type Pr } from './effects'
import { SECTION, boundRoot, inFreeTurn, loadWorkflow, registerWorkflowFailure, setDeclined, workflowToolFailed } from './tools'

import { EPIC_STATES, nextEpicState, mergedSubIssue, resliced, sliceProblems, SLICE_CAP, capNote, sourcePaths, sourceProblem, SOURCE_FORM, coreIdeaProblem, specPrLinkProblem, specPrLinkRepair, specPrProblem, stackPlan, frontierText, implementerBrief, reviewerBrief, unstackSteps, ISSUE_STATES, IN_FLIGHT, PLAN_STATES, ROUND_LIMIT, DEFAULT_PARALLEL, OWNER_LIVE_MS, KEY, SHORT_NAME, tag, tags, link, type EpicState, type IssueState, type Role, type SubIssue, type Epic, type Slice, type Stack } from '../../scripts/ndev/epic-model'
export * from '../../scripts/ndev/epic-model'
import { DebtRefused, closingFollowups, closingProblems, closingSha, configureClosing, debtProblem, decisionIds, mergeDebts, recordDebt, recordDebts, requirementIds, rulingProblem, type ClosingEvidence, type DebtRuling } from '../../scripts/ndev/epic-closing'

// What the human can do next in each epic state, as options. kb/workflow.md "What the human can do next" lists them.
export function epicHumanStep(epic: Epic): string {
  switch (epic.state) {
    case 'framing': return 'Answer the agent\'s questions on what the epic is for, name the sources of its requirements, and sign off the one-page core idea and its acceptance examples.'
    case 'researching': return 'Wait for the research notes, or point the agent at code, documents or people it should read.'
    case 'specifying': return 'Wait for the spec, then read it. Send a correction at any time.'
    case 'deciding': return 'Settle each open decision with the agent: pick an option, or ask for more detail.'
    case 'spec-review': return 'Read the spec review and the agent\'s ruling on each finding. Agree, or overrule a ruling.'
    case 'slicing': return 'Read the proposed sub-issues, then approve them or ask for changes before they are filed.'
    case 'coordinating': return 'Run /flow epic status to see each sub-issue. Answer a blocked sub-issue, review or merge a verified PR, or let the coordinator merge it.'
    case 'closing': return 'Wait for the closing report, then read it: what was verified, and what remains. Ask for more checks, or agree to close.'
    case 'done': return 'The epic is done. Close the epic issue if it is open, and file what remains as new issues.'
  }
}

// The next step for each state, which names the skill to load.
export function epicStep(epic: Epic): string {
  return `${epicAgentStep(epic)} End your turn with these options for the human. Tell the human: ${epicHumanStep(epic)}`
}

function epicAgentStep(epic: Epic): string {
  const n = epic.epic
  const phase = (finished: EpicState, needs: string) => `call mcp__ndev__epicPhase with issue ${n}, finished "${finished}", ${needs}.`
  switch (epic.state) {
    case 'framing': return `Load the skill ndev:epic-plan. Settle with the human what the epic is for and where its requirements come from, write the one-page core idea and have the human sign it off, then ${phase('framing', 'aim (one or two sentences), sources (a path or link to each source document, or "no source: <reason>"), files (the core idea, with 3 to 5 acceptance examples) and evidence')}`
    case 'researching': return `Load the skill ndev:epic-plan. Read the code and the sources, write research notes to a file, then ${phase('researching', 'files (the notes) and evidence')}`
    case 'specifying': return `Load the skill ndev:epic-plan. Write the spec to a file, then ${phase('specifying', 'files (the spec) and evidence')}`
    case 'deciding': return `Load the skill ndev:epic-plan. Settle each open decision of the spec with the human, then ${phase('deciding', 'evidence (the decisions, and that none is open)')}`
    case 'spec-review': return `Load the skill ndev:epic-plan. Get an independent review of the spec and rule on each finding. Open the spec PR with "Refs #${n}" in its body and never a closing keyword for #${n}, then ${phase('spec-review', 'files (the review), specPr (the number of the spec PR) and evidence (the ruling on each finding)')}`
    case 'slicing': return `Load the skill ndev:epic-plan. Show the breakdown (title, blocked by, what it delivers) to the human, file the sub-issues on GitHub only once the human approves it, then ${phase('slicing', `issues ([{ issue, key, title, blockedBy }], at most ${SLICE_CAP} unless the human overrides the cap with capOverride), approval (the human's approval of the breakdown) and evidence`)}`
    case 'coordinating': return `Load the skill ndev:epic-coordinate. Call mcp__ndev__epicNext with issue ${n}; for each sub-issue that it lists as ready or as able to start stacked call mcp__ndev__epicBrief and run the command that it gives, and record each move with mcp__ndev__epicIssue. When every sub-issue is merged, ${phase('coordinating', 'and evidence')}`
    case 'closing': return `Load the skill ndev:epic-coordinate. Verify the whole default branch at the closing SHA, obtain a different-model base..main review for every R-id, and rule on each debt. Run the retro skill on this coordinator session and record its lessons with the remember or dev-wiki skill. Then ${phase('closing', 'evidence and closingFile (the structured receipts and review)')}`
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

// A value safe in a POSIX shell: plain when it holds only safe characters, else in single quotes.
export const shellQuote = (value: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

const REPO_SELECTOR = /^(id|name|path):\S/
// The worktree id that Orca gives a workspace: <repoId>::<absolute path>.
const WORKTREE_ID = /^\S.*?::\/.+$/
const served = (s: Server) => `${s.name} (${s.id})`
const worktreeIdRepair = (s: Server) => `\`orca worktree list --environment ${s.id} --json\` lists it as the \`id\` of the new worktree`

// Where a worker of the sub-issue runs: a sub-issue that has not started goes where the epic says now, and one in
// flight stays where its workspace is. undefined is this machine.
export function workerRemote(epic: Epic, sub: SubIssue, role: 'implementer' | 'reviewer'): Server | undefined {
  const isStarted = sub.state !== 'waiting' && !(sub.state === 'blocked' && sub.previous === 'waiting')
  return role === 'implementer' && !isStarted ? epic.remote : sub.remote
}

export type WorkerStartInput = { role: 'implementer' | 'reviewer'; briefPath: string; epic: Epic; sub: SubIssue; base?: string; pr?: number }
// The orca orchestration worker-start command for one worker. A flag whose value the record lacks is
// left out, and missing says which value and how to set it. On a saved server (--on) Orca takes only an exact
// selector of that server, so a value it needs and the record lacks is refused, never guessed.
export function workerStartCommand(o: WorkerStartInput): { command: string; missing: string[] } | { refused: string } {
  const { epic, sub } = o
  const role = epic.roles[o.role]
  const remote = workerRemote(epic, sub, o.role)
  const missing: string[] = []
  const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, shellQuote(value)])
  if (!epic.run) missing.push(`run: the Orca run id is not recorded, so --run is left out. Set it with mcp__ndev__epicStarted with issue ${epic.epic} and run <id>.`)
  const on = remote ? ['--on', shellQuote(remote.id)] : []
  let place: string[]
  if (o.role === 'implementer') {
    if (!o.base) return { refused: `Refused: the default branch of ${epic.repo} is not known, so the implementer command has no --base-branch. Nothing was written.` }
    if (remote) {
      // The repository id of this machine's Orca is not an id on the server.
      if (!epic.remoteRepo) return { refused: `Refused: remoteRepo is not recorded, so the implementer of #${sub.issue} cannot start on ${served(remote)}: with --on, Orca needs --repo to name the repository on that server, and the id of this machine's Orca${epic.repoId ? ` (${epic.repoId})` : ''} is not one. Nothing was written. Repair: read the repository of ${epic.repo} on the server with \`orca repo list --environment ${remote.id} --json\`, then call mcp__ndev__epicStarted with issue ${epic.epic} and remoteRepo "id:<its id>" (or "name:<its name>"), then call epicBrief again. To start the workers on this machine instead, call mcp__ndev__epicStarted with issue ${epic.epic} and remote false.` }
      place = ['--worktree', 'new-top-level', '--repo', shellQuote(epic.remoteRepo), '--name', shellQuote(`${sub.issue}-${sub.key}`), '--base-branch', shellQuote(`origin/${o.base}`)]
    } else {
      if (!epic.repoId) missing.push(`repoId: the Orca repository id is not recorded, so --repo is left out. Set it with mcp__ndev__epicStarted with issue ${epic.epic} and repoId <id>.`)
      place = ['--worktree', 'new-top-level', ...flag('--repo', epic.repoId && `id:${epic.repoId}`), '--name', shellQuote(`${sub.issue}-${sub.key}`), '--base-branch', shellQuote(`origin/${o.base}`)]
    }
  } else {
    if (!sub.workspace) return { refused: `Refused: #${sub.issue} has no workspace, so the reviewer has no worktree to work in. Nothing was written. Repair: call mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "${sub.state}" and workspace (${remote ? `the worktree id on ${served(remote)}, <repoId>::<path>: ${worktreeIdRepair(remote)}` : `the absolute path of the implementer's worktree`}), then call epicBrief again.` }
    if (remote && !WORKTREE_ID.test(sub.workspace)) return { refused: `Refused: the workspace of #${sub.issue} is on ${served(remote)}, and the record holds "${sub.workspace}", which is not a worktree id (<repoId>::<path>). With --on, Orca takes only an exact selector of that server, and a path of the server is not known to be one. Nothing was written. Repair: call mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "${sub.state}" and workspace (the worktree id: ${worktreeIdRepair(remote)}), then call epicBrief again.` }
    place = ['--worktree', shellQuote(remote ? `id:${sub.workspace}` : `path:${sub.workspace}`)]
  }
  const title = o.role === 'implementer' ? `#${sub.issue} ${sub.title} (implementer)` : `#${sub.issue} ${sub.title} (reviewer, PR #${o.pr ?? sub.pr})`
  const argv = ['orca', 'orchestration', 'worker-start', '--spec-file', shellQuote(o.briefPath), '--task-title', shellQuote(title), ...flag('--run', epic.run), ...on, ...place, '--agent', shellQuote(role.agent), ...flag('--model', role.model), '--json']
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
  if (!epic || epic.epic !== n || !EPIC_STATES.includes(epic.state as EpicState) || !Array.isArray(epic.history)) {
    throw new Refuse(`${path} is not an epic record for #${n}: it needs epic ${n}, a state from ${EPIC_STATES.join(', ')}, issues and history. Repair: fix the file, then call the tool again.`)
  }
  if (typeof epic.issues !== 'object' || epic.issues === null || Array.isArray(epic.issues)) {
    throw new Refuse(`${path} is not an epic record for #${n}: its "issues" field is ${JSON.stringify(epic.issues) ?? 'missing'}, and it must be an object that maps each sub-issue number to its record, {} before slicing. Repair: set "issues" to {} or to the sub-issue records that slicing saved, then call the tool again.`)
  }
  try { configureClosing({}, { baseSha: epic.baseSha, coordinatorModel: epic.coordinatorModel, fullSuites: epic.fullSuites, posture: epic.posture }) } catch (error) { throw new Refuse(`${path}: ${error instanceof Error ? error.message : String(error)}. Repair the closing configuration.`) }
  if (epic.debts !== undefined && (!Array.isArray(epic.debts) || epic.debts.some(debt => debtProblem(debt)))) throw new Refuse(`${path} has invalid debt. Repair the record.`)
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
const answer = (epic: Epic, lead: string) => `${lead}\nDebt: ${JSON.stringify(epic.debts ?? [])}\nEpic #${epic.epic} is in the state "${epic.state}". Next: ${epicStep(epic)}`

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
  const remoteRepo = str(args, 'remoteRepo')
  if (args.remoteRepo !== undefined && !REPO_SELECTOR.test(remoteRepo)) throw new Refuse(`Refused: remoteRepo must be an Orca repository selector on the server, id:<id>, name:<name> or path:<path>, and it is ${JSON.stringify(args.remoteRepo)}. Nothing changed. Repair: read the selectors with \`orca repo list --environment <server> --json\`.`)
  if (args.remote !== undefined && typeof args.remote !== 'boolean' && !str(args, 'remote')) throw new Refuse(`Refused: remote must be true (the server that /dev remote saved for this project, else the only one Orca has), a saved server's name or id, or false (this machine), and it is ${JSON.stringify(args.remote)}. Nothing changed.`)
  // The server is resolved once, here, before anything is filed or recorded. A server that cannot be resolved never
  // becomes this machine.
  let remote: Server | undefined
  if (args.remote !== undefined && args.remote !== false) {
    const again = `mcp__ndev__epicStarted with${args.issue === undefined ? '' : ` issue ${String(args.issue)} and`} remote`
    try {
      remote = await triageRemote($, project, args.remote === true ? '' : str(args, 'remote'), 'epicStarted remote', again)
    } catch (error) {
      throw new Refuse(`Refused: ${error instanceof Error ? error.message : String(error)}\nNothing changed, and no worker placement was switched to this machine. To start the workers on this machine, call mcp__ndev__epicStarted with remote false.`)
    }
  }
  const placed = (epic: Epic) => (args.remote === undefined ? '' : epic.remote
    ? `\nNew sub-issues start on the saved Orca server ${served(epic.remote)}${epic.remoteRepo ? `, in its repository ${epic.remoteRepo}` : `. remoteRepo is not recorded yet: read it with \`orca repo list --environment ${epic.remote.id} --json\` and call mcp__ndev__epicStarted with issue ${epic.epic} and remoteRepo "id:<its id>"`}. A sub-issue in flight stays where its workspace is. remote false turns it off.`
    : `\nNew sub-issues start on this machine. A sub-issue in flight on a server stays there.`)
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
      if (remoteRepo) existing.remoteRepo = remoteRepo
      if (remote) existing.remote = { id: remote.id, name: remote.name }
      else if (args.remote === false) delete existing.remote
      if (shortName) existing.shortName = shortName
      configureEpic(existing, args)
      moved(existing, 'epicStarted', existing.state, now)
      return begin($, existing, `Resumed epic #${n}: ${link(existing, n)}${placed(existing)}`)
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
    ...(remote ? { remote: { id: remote.id, name: remote.name } } : {}), ...(remoteRepo ? { remoteRepo } : {}),
    issues: {}, history: [],
  }
  configureEpic(epic, args)
  moved(epic, 'epicStarted', 'framing', now)
  return begin($, epic, `${lead}${placed(epic)}`)
}

function configureEpic(epic: Epic, args: Args): void {
  try { configureClosing(epic, { baseSha: args.baseSha, coordinatorModel: args.coordinatorModel, posture: args.posture, fullSuites: args.fullSuites }) }
  catch (error) { throw new Refuse(`Refused: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`) }
  epic.posture ??= 'standard'
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

async function epicClosing($: EngineInterface, epic: Epic, file: string): Promise<ClosingEvidence> {
  if (!file) throw new Refuse('Refused: closing needs structured evidence in closingFile. Nothing changed.')
  let receipt: unknown
  try { receipt = JSON.parse(await $.fs.read(file)) }
  catch (error) { throw new Refuse(`Refused: closing evidence ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}.`) }
  const main = await defaultBranch($, epic.root, epic.repo)
  if (typeof main !== 'string' || !main.trim()) throw new Refuse('Refused: GitHub returned no default branch for closing.')
  const head = await gitOut(epic.root, $, 'rev-parse', 'HEAD')
  const branch = await gitOut(epic.root, $, 'branch', '--show-current')
  const dirty = Boolean(await gitOut(epic.root, $, 'status', '--porcelain', '--untracked-files=all'))
  if (closingSha(epic.baseSha)) await gitOut(epic.root, $, 'merge-base', '--is-ancestor', epic.baseSha, head)
  const remote = await ghOne<{ sha: string }>($, epic.root, epic.repo, ['api', `repos/${epic.repo}/commits/${encodeURIComponent(main)}`])
  const specs = epic.evidence.specifying?.files ?? []
  if (!specs.length) throw new Refuse('Refused: closing needs committed spec files with numbered requirements.')
  const ids: string[] = []
  const decisions: string[] = []
  for (const spec of specs) {
    const name = spec.startsWith(epic.root + '/') ? spec.slice(epic.root.length + 1) : ''
    if (!name || name.split('/').includes('..')) throw new Refuse(`Refused: spec ${spec} must be committed inside ${epic.root}.`)
    const source = await gitOut(epic.root, $, 'show', `${head}:${name}`)
    ids.push(...requirementIds(source))
    decisions.push(...decisionIds(source))
  }
  const problems = closingProblems(epic, receipt, { branch, defaultBranch: main, head, remoteHead: remote?.sha, dirty, requirements: [...new Set(ids)], decisions: [...new Set(decisions)] })
  if (problems.length) throw new Refuse(`Refused: epic #${epic.epic} cannot close:\n- ${problems.join('\n- ')}. Record evidence and rule on debt, then retry.`)
  const report = receipt as ClosingEvidence
  for (const followup of closingFollowups(epic, report)) {
    const found = await ghOne<{ number: number; pull_request?: unknown }>($, epic.root, epic.repo, ['api', `repos/${epic.repo}/issues/${followup.issue}`])
    if (found?.number !== followup.issue || found.pull_request) throw new Refuse(`Refused: ${followup.id} needs a real follow-up issue #${followup.issue} in ${epic.repo}.`)
  }
  for (const suite of report.suites) {
    const slash = suite.log.lastIndexOf('/')
    const entries = await $.fs.list(suite.log.slice(0, slash) || '/')
    if (!entries.some(entry => entry.name === suite.log.slice(slash + 1) && entry.kind === 'file')) throw new Refuse(`Refused: closing suite log ${suite.log} is missing or not a file.`)
  }
  for (const adr of report.adrs) {
    try { await gitOut(epic.root, $, 'cat-file', '-e', `${head}:${adr.path}`) }
    catch (error) { throw new Refuse(`Refused: ADR ${adr.path} for ${adr.decision} is not committed at the closing SHA ${head}: ${error instanceof Error ? error.message : String(error)}. Nothing changed. Repair: write it in the kb/adr.md form, merge it to ${main}, and record new closing evidence.`) }
  }
  return report
}

// Model: models/workflow/epic_workflow.qnt#recordDebt
async function epicDebt($: EngineInterface, c: Ctx): Promise<string> {
  const epic = await boundEpic($, c, 'epicDebt')
  const debt = { key: str(c.args, 'key'), kind: str(c.args, 'kind'), note: str(c.args, 'note'), ...(c.args.sub !== undefined ? { sub: Number(c.args.sub) } : {}), ...(str(c.args, 'check') ? { check: str(c.args, 'check') } : {}) }
  if (debt.sub !== undefined && !epic.issues[String(debt.sub)]) throw new Refuse(`Refused: #${debt.sub} is outside epic #${epic.epic}.`)
  const count = epic.debts?.length ?? 0
  try { recordDebt(epic, debt as Parameters<typeof recordDebt>[1], await $.clock.now()) }
  catch (error) { throw error instanceof DebtRefused ? error : new Refuse(`Refused: ${error instanceof Error ? error.message : String(error)}.`) }
  if (epic.debts?.length !== count) { moved(epic, 'epicDebt', epic.state, await $.clock.now()); await saveEpic($, epic) }
  return answer(epic, `Debt ${debt.key} is recorded.`)
}

// Model: models/workflow/epic_workflow.qnt#ruleDebt
async function epicDebtRuling($: EngineInterface, c: Ctx): Promise<string> {
  const epic = await boundEpic($, c, 'epicDebtRuling')
  const key = str(c.args, 'key')
  const debt = epic.debts?.find(item => item.key === key)
  if (!debt) throw new Refuse(`Refused: debt ${key} is not recorded in epic #${epic.epic}.`)
  const problem = rulingProblem(c.args.ruling)
  if (problem) throw new Refuse(`Refused: debt ${key} ${problem}.`)
  const ruling = c.args.ruling as DebtRuling
  if (ruling.verdict === 'issue-filed') {
    const found = await ghOne<{ number: number; state: string; pull_request?: unknown }>($, epic.root, epic.repo, ['api', `repos/${epic.repo}/issues/${ruling.issue}`])
    if (found?.number !== ruling.issue || found.state !== 'open' || found.pull_request) throw new Refuse(`Refused: debt ${key} needs open follow-up issue #${ruling.issue}.`)
  }
  if (JSON.stringify(debt.ruling) !== JSON.stringify(ruling)) {
    debt.ruling = ruling
    moved(epic, 'epicDebtRuling', epic.state, await $.clock.now())
    await saveEpic($, epic)
  }
  return answer(epic, `Debt ${key} ruled ${ruling.verdict}: ${ruling.reason}`)
}

// Model: models/workflow/epic_workflow.qnt#finishPhase
async function epicPhase($: EngineInterface, c: Ctx): Promise<string> {
  const { args } = c
  const epic = await boundEpic($, c, 'epicPhase')
  const finished = str(args, 'finished')
  if (finished !== epic.state) throw new Refuse(`Refused: epic #${epic.epic} is in the state "${epic.state}", and the call says "${finished}" is finished. Nothing changed. Only the human skips a phase, with /flow epic skip.`)
  const evidence = str(args, 'evidence')
  if (!evidence) throw new Refuse(`Refused: "${epic.state}" needs evidence: what the phase did and showed. Nothing changed.`)
  if (args.specPr !== undefined && epic.state !== 'spec-review') throw new Refuse(`Refused: specPr is only for "spec-review", and the epic is in the state "${epic.state}". Nothing changed. Repair: call epicPhase again without specPr.`)
  if (args.sources !== undefined && epic.state !== 'framing') throw new Refuse(`Refused: sources are only for "framing", and the epic is in the state "${epic.state}". Nothing changed. Repair: call epicPhase again without sources.`)
  for (const key of ['approval', 'capOverride']) if (args[key] !== undefined && epic.state !== 'slicing') throw new Refuse(`Refused: ${key} is only for "slicing", and the epic is in the state "${epic.state}". Nothing changed. Repair: call epicPhase again without ${key}.`)
  if (args.sources !== undefined && !Array.isArray(args.sources)) throw new Refuse(`Refused: sources must be a list of strings, each ${SOURCE_FORM}, and it is ${JSON.stringify(args.sources)}. Nothing changed.`)
  const now = await $.clock.now()
  let files: string[] | undefined
  let after = ''
  let approval = ''
  switch (epic.state) {
    case 'framing': {
      const aim = str(args, 'aim')
      if (!aim) throw new Refuse('Refused: "framing" needs aim: one or two sentences that say what the epic is for. Nothing changed.')
      const sources = ((args.sources ?? []) as unknown[]).map(s => String(s).trim()).filter(Boolean)
      const problem = sourceProblem(sources)
      if (problem) throw new Refuse(`Refused: "framing" needs sources: ${problem}. Nothing changed. Repair: call epicPhase again with sources, each ${SOURCE_FORM}.`)
      const full = (s: string) => (sourcePaths([s]).length && !s.startsWith('/') ? `${epic.root}/${s}` : s)
      const missing: string[] = []
      for (const path of sourcePaths(sources).map(full)) if (!(await $.fs.exists(path))) missing.push(path)
      if (missing.length) throw new Refuse(`Refused: these framing sources do not exist: ${missing.join(', ')}. Nothing changed. Repair: give the right paths or links.`)
      files = await phaseFiles($, epic, args, 'the one-page core idea, with the aim, the central mechanism and 3 to 5 acceptance examples that the human signed off')
      if (files.length !== 1) throw new Refuse(`Refused: "framing" takes one file, the one-page core idea, and it got ${files.length}: ${files.join(', ')}. Nothing changed.`)
      const thin = coreIdeaProblem(await $.fs.read(files[0]!))
      if (thin) throw new Refuse(`Refused: the core idea ${files[0]}: ${thin}. Nothing changed. Repair: write the acceptance examples that the human signs off into it, and call epicPhase again.`)
      epic.aim = aim
      epic.sources = sources.map(full)
      epic.coreIdea = files[0]
      break
    }
    case 'researching': files = await phaseFiles($, epic, args, 'the research notes, each of which exists'); break
    case 'specifying': files = await phaseFiles($, epic, args, 'the spec, which exists'); break
    case 'spec-review': {
      files = await phaseFiles($, epic, args, 'at least one review file of the spec, which exists')
      if (!isCount(args.specPr)) throw new Refuse(`Refused: "spec-review" needs specPr, the number of the spec PR, whose body says "Refs #${epic.epic}" and no closing keyword for it; it got ${JSON.stringify(args.specPr)}. Nothing changed.`)
      const specPr = Number(args.specPr)
      const pr = await readPr($, epic.root, epic.repo, specPr)
      const wrong = specPrProblem(pr.body ?? '', epic.repo, epic.epic)
      if (wrong) throw new Refuse(`Refused: spec PR #${specPr}: ${wrong}. Nothing changed. Repair: run \`gh pr edit ${specPr} --repo ${epic.repo} --body-file <file>\` with "Refs #${epic.epic}" and no closing keyword for #${epic.epic} (the sub-issue PRs close their own issues, and the epic closes after closing), then call epicPhase again.`)
      const linked = specPrLinkProblem((await ghOne<{ closingIssuesReferences?: unknown }>($, epic.root, epic.repo, ['view-json', 'pr', String(specPr), '--fields', 'closingIssuesReferences'])).closingIssuesReferences, epic.repo, epic.epic)
      if (linked) throw new Refuse(`Refused: spec PR #${specPr}: ${linked}. Nothing changed. Repair: ${specPrLinkRepair(specPr, epic.repo, epic.epic)}, then call epicPhase again.`)
      epic.specPr = specPr
      break
    }
    case 'slicing': {
      approval = str(args, 'approval')
      if (!approval) throw new Refuse('Refused: "slicing" needs approval: the human\'s approval of the breakdown (title, blocked by, what it delivers), given before any issue was filed. Nothing changed. Repair: show the breakdown to the human, file the issues once approved, and call epicPhase again with approval.')
      const { state } = await ghOne<{ state: string }>($, epic.root, epic.repo, ['issue-read', String(epic.epic)])
      if (state !== 'open') throw new Refuse(`Refused: epic #${epic.epic} is ${state} on GitHub, so its sub-issues cannot be coordinated. Nothing changed. Repair: gh issue reopen ${epic.epic} --repo ${epic.repo}${epic.specPr ? `, and check that spec PR #${epic.specPr} no longer closes it: ${specPrLinkRepair(epic.specPr, epic.repo, epic.epic)}` : ''}, then call epicPhase again.`)
      const merged = mergedSubIssue(epic.issues)
      if (merged) throw new Refuse(`Refused: #${merged.issue} is merged, so epic #${epic.epic} cannot be sliced again: a new breakdown must keep each merged sub-issue, and slicing needs each sub-issue open. Nothing changed. Repair: file new work as new sub-issues of #${epic.epic} on GitHub, then run ndev epic import ${epic.epic} --issues-file <json> --evidence <text> in a terminal: it keeps each merged sub-issue, records the new ones and moves the epic to coordinating.`)
      const slices = slicesOf(args)
      const problem = sliceProblems(slices)
      if (problem) throw new Refuse(`Refused: ${problem}. Nothing changed. Repair: correct the list and call epicPhase again.`)
      const capOverride = str(args, 'capOverride')
      if (slices.length > SLICE_CAP && !capOverride) throw new Refuse(`Refused: the breakdown has ${slices.length} sub-issues, above the cap of ${SLICE_CAP}. Nothing changed. Repair: split the epic into child epics, each with its own part of the spec, or record the human's override with capOverride "<reason>".`)
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
      const kept = resliced(epic.issues, slices)
      if ('problem' in kept) throw new Refuse(`Refused: ${kept.problem}. Nothing changed. Repair: ${kept.repair}, and call epicPhase again.`)
      epic.issues = kept
      if (slices.length > SLICE_CAP) recordDebt(epic, { key: `slicing:cap:${epic.history.length}`, kind: 'gate-override', note: capNote(slices.length, capOverride) }, now)
      after = `\n${frontierText(epic)}`
      break
    }
    case 'coordinating': {
      const open = Object.values(epic.issues).filter(i => i.state !== 'merged').sort((a, b) => a.issue - b.issue)
      if (open.length) throw new Refuse(`Refused: these sub-issues are not merged: ${open.map(i => `#${i.issue} ("${i.state}")`).join(', ')}. Nothing changed.`)
      break
    }
    case 'closing': { epic.closing = await epicClosing($, epic, str(args, 'closingFile')); files = [str(args, 'closingFile')]; break }
    case 'done': throw new Refuse(`Refused: epic #${epic.epic} is done. Nothing changed.`)
    default: break
  }
  const from = epic.state
  epic.evidence[from] = { at: now, text: evidence, ...(files ? { files } : {}), ...(approval ? { approval } : {}) }
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

// Model: models/workflow/epic_workflow.qnt#brief
async function epicBrief($: EngineInterface, c: Ctx): Promise<string> {
  const { args } = c
  const epic = await boundEpic($, c, 'epicBrief')
  if (epic.state !== 'coordinating') throw new Refuse(`Refused: briefs are written only in the state "coordinating", and epic #${epic.epic} is in "${epic.state}". Nothing was written.`)
  const sub = subOf(epic, args)
  const role = str(args, 'role')
  if (role !== 'implementer' && role !== 'reviewer') throw new Refuse(`Refused: role must be "implementer" or "reviewer", and it is ${JSON.stringify(args.role)}. Nothing was written.`)
  if (role === 'implementer' && sub.state !== 'waiting') throw new Refuse(`Refused: #${sub.issue} is in the state "${sub.state}", and an implementer brief is only for a waiting sub-issue. Nothing was written. Repair: ${sub.implementer ? `its implementer is dispatch:${sub.implementer}; message it with \`orca orchestration send --to dispatch:${sub.implementer}\`` : `call mcp__ndev__epicStatus with issue ${epic.epic} for its owner`}.`)
  const specFiles = epic.evidence.specifying?.files ?? []
  let pr: number | undefined
  let base: string | undefined
  let stack: Stack | undefined
  let unstacked = false
  if (role === 'reviewer') {
    if (args.pr !== undefined && !isCount(args.pr)) throw new Refuse(`Refused: pr must be a PR number, and it is ${JSON.stringify(args.pr)}. Nothing was written.`)
    pr = args.pr !== undefined ? Number(args.pr) : sub.pr
    if (!pr) throw new Refuse(`Refused: a reviewer brief needs the PR: #${sub.issue} has no pr recorded. Nothing was written. Repair: call epicBrief with pr, the number of the implementer's PR.`)
  } else {
    const main = await defaultBranch($, epic.root, epic.repo)
    const plan = stackPlan(epic, sub)
    if (plan && 'why' in plan) throw new Refuse(`Refused: #${sub.issue} cannot start yet: ${plan.why}. Nothing was written. Repair: call mcp__ndev__epicNext with issue ${epic.epic} for what can start now.`)
    if (plan) {
      const on = plan.on
      const again = `then call epicBrief again`
      const head = await readPr($, epic.root, epic.repo, on.pr!)
      // Model: models/workflow/epic_workflow.qnt#humanMergesPr
      if (head.merged) throw new Refuse(`Refused: GitHub says PR #${on.pr} of #${on.issue} is merged, and the record has #${on.issue} in the state "${on.state}", so #${sub.issue} must not start from its branch. Nothing was written. Repair: call mcp__ndev__epicIssue with issue ${epic.epic}, sub ${on.issue} and state "merged"${on.state === 'verified' ? '' : ` (it is "${on.state}": move it to "verified" first)`}, ${again}: #${sub.issue} then starts from ${main}.`)
      // Model: models/workflow/epic_workflow.qnt#humanClosesPr
      // Model: models/workflow/epic_workflow.qnt#humanReopensPr
      if (head.state !== 'open') throw new Refuse(`Refused: GitHub says PR #${on.pr} of #${on.issue} is ${head.state} and not merged, so #${sub.issue} cannot start from its branch ${head.head.ref}. Nothing was written. Repair: reopen it with \`gh pr reopen ${on.pr} --repo ${epic.repo}\`, or record the new PR of #${on.issue}, ${again}.`)
      stack = { on, branch: head.head.ref, base: main }
    }
    base = stack?.branch ?? main
    unstacked = !stack && sub.stackedOn !== undefined
  }
  const { gitDir } = await paths($, epic.root)
  const folder = `${gitDir}/ndev-epic`
  const path = `${folder}/epic-${epic.epic}-${sub.issue}-${role}.md`
  const built = workerStartCommand({ role, briefPath: path, epic, sub, base, pr })
  if ('refused' in built) throw new Refuse(built.refused)
  const made = await run($, ['mkdir', '-p', folder], { cwd: epic.root })
  if (made.exitCode !== 0) throw new Error(`mkdir -p ${folder} exited ${made.exitCode}: ${made.stderr.trim()}`)
  const remote = workerRemote(epic, sub, role)
  // The server has no file of this machine: there, a spec file is its path in the repository.
  const inRepo = (f: string) => (f.startsWith(`${epic.root}/`) ? f.slice(epic.root.length + 1) : f)
  const shown = remote ? specFiles.map(inRepo) : specFiles
  await $.fs.write(path, role === 'implementer' ? implementerBrief(epic, sub, shown, stack) : reviewerBrief(epic, sub, shown, pr))
  // Where the sub-issue starts is recorded with the command that starts it, so a later change of the epic's remote
  // does not move a sub-issue in flight.
  const movesServer = role === 'implementer' && sub.remote?.id !== remote?.id
  if (movesServer) {
    if (remote) sub.remote = remote
    else delete sub.remote
  }
  // The record follows the brief: the base that the worker starts from is the stack it is on.
  const restacks = (stack && sub.stackedOn !== stack.on.issue) || unstacked
  if (stack) sub.stackedOn = stack.on.issue
  else if (unstacked) delete sub.stackedOn
  if (movesServer || restacks) await saveEpic($, epic)
  const stackedNote = stack ? `\nStacked on #${stack.on.issue}: the worktree starts from origin/${stack.branch}, the head of PR #${stack.on.pr}, which is not merged. The record has stackedOn ${stack.on.issue} for #${sub.issue}. The brief tells the worker to give its PR the base ${stack.branch}.` : ''
  const record = role === 'implementer'
    ? `mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "implementing", worker (the dispatch id) and workspace (${remote ? `the worktree id on the server, <repoId>::<path>: ${worktreeIdRepair(remote)}` : 'the absolute path of the new worktree'})`
    : `mcp__ndev__epicIssue with issue ${epic.epic}, sub ${sub.issue}, state "reviewing", pr ${pr} and worker (the dispatch id)`
  const missing = built.missing.length ? `\nMissing values:\n${built.missing.map(m => `- ${m}`).join('\n')}` : ''
  const outside = specFiles.filter(f => !f.startsWith(`${epic.root}/`))
  const there = remote
    ? `\nThis worker runs on the saved Orca server ${served(remote)}; the Run, its Tasks and its mail stay on this machine. Address the worker by its dispatch id only, never by a terminal handle. The server has only what is pushed: the brief names each spec file by its path in the repository, so each must be on origin/${base ?? (await defaultBranch($, epic.root, epic.repo))} or on the PR branch.${outside.length ? ` These spec files are outside ${epic.root}, so the server does not have them: ${outside.join(', ')}.` : ''}`
    : ''
  return `Brief for the ${role} of #${sub.issue}: ${path}\nRun this command:\n${built.command}${missing}${there}${stackedNote}\nNext: run the command, then record the dispatch id with ${record}.`
}

// "merged" from "reviewing" or "fixing" is only for a PR that a human already merged: GitHub must say so.
const MOVES: Record<IssueState, IssueState[]> = {
  waiting: ['implementing'],
  implementing: ['reviewing'],
  reviewing: ['fixing', 'verified', 'merged'],
  fixing: ['reviewing', 'merged'],
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
  if (args.workspace !== undefined && sub.remote && !WORKTREE_ID.test(workspace)) throw new Refuse(`Refused: #${sub.issue} starts on the saved Orca server ${served(sub.remote)}, so its workspace must be the worktree id there, <repoId>::<path>, and it is ${JSON.stringify(args.workspace)}. Nothing changed. Repair: give the id; ${worktreeIdRepair(sub.remote)}. If the worker in fact started on this machine, call mcp__ndev__epicStarted with issue ${epic.epic} and remote false, then epicBrief for the implementer again.`)
  if (args.workspace !== undefined && !sub.remote && !workspace.startsWith('/')) throw new Refuse(`Refused: workspace must be the absolute path of the implementer's worktree, and it is ${JSON.stringify(args.workspace)}. Nothing changed.`)
  const now = await $.clock.now()
  const from = sub.state
  let extra = ''
  // The same state with a workspace records the workspace and moves nothing.
  if (to === from && workspace && to !== 'blocked') {
    sub.workspace = workspace
    await saveEpic($, epic)
    return answer(epic, `#${sub.issue} keeps the state "${from}"; its workspace is ${workspace}.`)
  }
  if (to === 'merged' && from !== 'merged' && !['reviewing', 'fixing', 'verified'].includes(from)) {
    if (!str(args, 'override')) throw new Refuse(`Refused: #${sub.issue} never reached reviewing. Supply override with the reason to record debt.`)
    if (isCount(args.pr) && sub.pr && Number(args.pr) !== sub.pr && !(from === 'blocked' && sub.lost)) throw new Refuse(`Refused: the record of #${sub.issue} has PR #${sub.pr}, and its review does not transfer to PR #${args.pr}. Nothing changed. Repair: record the merge of PR #${sub.pr}; only a sub-issue that is blocked because its PR was lost takes a new PR.`)
    if (isCount(args.pr)) sub.pr = Number(args.pr)
    if (!sub.pr) throw new Refuse(`Refused: merging #${sub.issue} needs its PR number.`)
  }
  // Model: models/workflow/epic_workflow.qnt#block
  if (to === 'blocked') {
    if (from === 'blocked' || from === 'merged') throw new Refuse(`Refused: #${sub.issue} is "${from}" and cannot be blocked. Nothing changed.`)
    if (!note) throw new Refuse(`Refused: a block needs note: what blocks #${sub.issue} and who can end it. Nothing changed.`)
    sub.previous = from
    sub.note = note
    delete sub.lost
  // Model: models/workflow/epic_workflow.qnt#unblock
  } else if (from === 'blocked' && to !== 'merged') {
    if (to !== sub.previous) throw new Refuse(`Refused: #${sub.issue} is blocked, and goes back only to the state it was in, "${sub.previous}". Nothing changed.`)
    const inFlight = Object.values(epic.issues).filter(i => IN_FLIGHT.includes(i.state))
    if (IN_FLIGHT.includes(to) && inFlight.length >= epic.parallel) throw new Refuse(`Refused: #${sub.issue} goes back to "${to}", and all ${epic.parallel} parallel places are taken by ${tags(inFlight.map(i => i.issue))}. Nothing changed. Repair: wait for one to merge, or ask the human to raise parallel (epicStarted with parallel).`)
    sub.previous = undefined
    delete sub.lost
  } else {
    if (!MOVES[from].includes(to) && to !== 'merged') throw new Refuse(`Refused: #${sub.issue} is in the state "${from}", and "${to}" does not follow it. From "${from}" it goes to: ${[...MOVES[from], ...(from === 'merged' ? [] : ['blocked'])].join(', ') || 'nothing'}. Nothing changed.`)
    switch (`${from}>${to}`) {
      // Model: models/workflow/epic_workflow.qnt#start
      case 'waiting>implementing': {
        const merged = new Set(Object.values(epic.issues).filter(i => i.state === 'merged').map(i => i.issue))
        const open = sub.blockedBy.filter(b => !merged.has(b))
        const plan = stackPlan(epic, sub)
        if (plan && 'why' in plan) throw new Refuse(`Refused: #${sub.issue} is not on the frontier: it waits for ${tags(open)} to merge, and it cannot start stacked: ${plan.why}. Nothing changed.`)
        // A stacked start needs the stacked brief first: the brief is what gives the worker the blocker's branch.
        if (plan && sub.stackedOn !== plan.on.issue) throw new Refuse(`Refused: #${sub.issue} waits for ${tags(open)} to merge. It can start stacked on #${plan.on.issue} (PR #${plan.on.pr}), and the record has ${sub.stackedOn === undefined ? 'no stack for it' : `it stacked on #${sub.stackedOn}`}, so its worker did not start from that branch. Nothing changed. Repair: call mcp__ndev__epicBrief with issue ${epic.epic}, sub ${sub.issue} and role "implementer", start the worker with the command it gives, then call epicIssue again.`)
        // The blockers merged after a stacked brief: the worktree is on the old branch, which the verify checks handle.
        const inFlight = Object.values(epic.issues).filter(i => IN_FLIGHT.includes(i.state))
        if (inFlight.length >= epic.parallel) throw new Refuse(`Refused: all ${epic.parallel} parallel places are taken by ${tags(inFlight.map(i => i.issue))}. Nothing changed. Repair: wait for one to merge, or ask the human to raise parallel (epicStarted with parallel).`)
        if (!worker) throw new Refuse(`Refused: "implementing" needs worker, the dispatch id of the implementer. Nothing changed.`)
        sub.implementer = worker
        if (workspace) sub.workspace = workspace
        break
      }
      // Model: models/workflow/epic_workflow.qnt#toReviewing
      case 'implementing>reviewing': {
        if (!isCount(args.pr)) throw new Refuse(`Refused: "reviewing" needs pr, the number of the implementer's PR, and it got ${JSON.stringify(args.pr)}. Nothing changed.`)
        if (!worker) throw new Refuse(`Refused: "reviewing" needs worker, the dispatch id of the reviewer. Nothing changed.`)
        const pr = await readPr($, epic.root, epic.repo, Number(args.pr))
        if (pr.state !== 'open' || pr.merged || pr.draft !== false) throw new Refuse(`Refused: PR #${Number(args.pr)} of #${sub.issue} must be open and ready for review, and GitHub says state "${pr.state}", merged ${Boolean(pr.merged)}, draft ${pr.draft}. Nothing changed. Repair: have the implementer open the PR or mark it ready with \`gh pr ready ${Number(args.pr)} --repo ${epic.repo}\`, then call epicIssue again.`)
        sub.pr = Number(args.pr)
        sub.reviewer = worker
        if (workspace) sub.workspace = workspace
        break
      }
      // Model: models/workflow/epic_workflow.qnt#toFixing
      case 'reviewing>fixing': {
        if (args.verdict !== 'changes' || !note) throw new Refuse(`Refused: "fixing" needs verdict "changes" and note: your ruling on each finding. Nothing changed.`)
        sub.verdict = 'changes'
        sub.note = note
        sub.rounds += 1
        if (sub.rounds >= ROUND_LIMIT) extra = `\n#${sub.issue} has had ${sub.rounds} rounds of review. Stop and decide: narrow the issue, take it over, or ask the human.`
        break
      }
      // Model: models/workflow/epic_workflow.qnt#fixedToReviewing
      case 'fixing>reviewing': {
        if (worker) sub.reviewer = worker
        break
      }
      // Model: models/workflow/epic_workflow.qnt#verify
      case 'reviewing>verified': {
        if (args.verdict !== 'approve' && !(args.verdict === 'changes' && note)) throw new Refuse(`Refused: "verified" needs verdict "approve", or verdict "changes" with a note that says each finding was fixed or overruled. Nothing changed.`)
        const report = await verify($, epic, sub)
        sub.verdict = args.verdict as 'approve' | 'changes'
        if (note) sub.note = note
        extra = `\n${report}\nNext: merge PR #${sub.pr}, then call epicIssue with state "merged".`
        break
      }
      // Model: models/workflow/epic_workflow.qnt#recordMerged
      case 'waiting>merged':
      case 'implementing>merged':
      case 'blocked>merged':
      case 'reviewing>merged':
      case 'fixing>merged':
      case 'verified>merged': {
        const pr = await readPr($, epic.root, epic.repo, sub.pr!)
        const reviewed = Boolean(sub.reviewer && sub.verdict)
        // Model: models/workflow/epic_workflow.qnt#workerPushes
        const moved = from === 'verified' && sub.verification?.sha !== pr.head.sha
        const early = from !== 'verified' || moved
        const pushed = `PR #${sub.pr} is at ${pr.head.sha.slice(0, 8)}, not the head ${(sub.verification?.sha ?? 'unknown').slice(0, 8)} that verify checked`
        // Model: models/workflow/epic_workflow.qnt#humanMergesPr
        if (!pr.merged) throw new Refuse(`Refused: GitHub says PR #${sub.pr} is not merged (state "${pr.state}"). Nothing changed. Repair: ${moved ? `${pushed}, so its merge will owe verification debt. Merge it` : early ? `from "${from}", "merged" records only a PR that a human already merged. Move #${sub.issue} to "verified" first, then merge it` : 'merge it'}, then call epicIssue again.`)
        const main = await defaultBranch($, epic.root, epic.repo).catch((e: unknown) => {
          throw new Refuse(`Refused: the default branch of ${epic.repo} was not read, so it is not known whether PR #${sub.pr} reached it: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}. Nothing changed. Repair: check gh auth status and the GitHub rate limit (gh api rate_limit), then call epicIssue again.`)
        })
        if (pr.base?.ref !== main) await landedThroughBlocker($, epic, sub, pr, main, from, now)
        delete sub.lost
        if (pr.merge_commit_sha) sub.mergeSha = pr.merge_commit_sha
        if (early) {
          sub.mergedUnverified = true
          extra = `\nA human merged PR #${sub.pr}${sub.mergeSha ? ` (merge commit ${sub.mergeSha})` : ''} ${moved ? `after a push: ${pushed}, so the merged head is unverified` : `while #${sub.issue} was in "${from}", so the verify checks did not run`} and the record says so. If the PR added migrations, ndev:merge did not run them: check them with the human.`
        }
        mergeDebts(epic, sub, reviewed, !early, now, str(args, 'override'))
        const above = Object.values(epic.issues).filter(i => i.stackedOn === sub.issue && i.state !== 'merged').sort((a, b) => a.issue - b.issue)
        if (above.length) {
          let base = '<the default branch>'
          try {
            base = await defaultBranch($, epic.root, epic.repo)
          } catch (e) {
            extra += `\nThe default branch was not read (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}): put it in the place of ${base} below.`
          }
          const told = (i: SubIssue) => !i.implementer ? `- ${tag(i.issue)} (${i.state}${i.pr ? `, PR #${i.pr}` : ', no PR recorded'}) has no implementer to tell. ${['external', 'human-pending'].includes(i.state) ? `Tell its existing owner to rebase onto ${base} and retarget its PR; this epic does not message it.` : `Its brief was on origin/${pr.head.ref}: ${i.state === 'blocked' ? `call mcp__ndev__epicIssue with issue ${epic.epic}, sub ${i.issue} and state "${i.previous}", then ` : ''}call mcp__ndev__epicBrief with issue ${epic.epic}, sub ${i.issue} and role "implementer" again, so it starts from ${base}.`}` : `- ${tag(i.issue)} (${i.state}${i.pr ? `, PR #${i.pr}` : ', no PR recorded'}): \`orca orchestration send --to dispatch:${i.implementer}\` this: "PR #${sub.pr} of #${sub.issue} is merged, so #${i.issue} is no longer stacked on origin/${pr.head.ref}. Now ${unstackSteps(epic.repo, base, i.pr ? String(i.pr) : '<your PR>')}. Report when it is done."`
          extra += `\nStacked on #${sub.issue}: ${tags(above.map(i => i.issue))}. Each has the change of #${sub.issue} in its branch and a PR based on ${pr.head.ref}. Tell each worker now:\n${above.map(told).join('\n')}\nThe record keeps stackedOn for each until epicIssue moves it to "verified", which refuses while the base of its PR is not ${base}.`
        }
        break
      }
    }
  }
  sub.state = to
  moved(epic, `epicIssue #${sub.issue}`, to, now, from)
  await saveEpic($, epic)
  return answer(epic, `#${sub.issue} moved from "${from}" to "${to}".${extra}${to === 'merged' ? `\n${frontierText(epic)}` : ''}`)
}

// Model: models/workflow/epic_workflow.qnt#recordMerged
async function landedThroughBlocker($: EngineInterface, epic: Epic, sub: SubIssue, pr: Pr, main: string, from: IssueState, now: number): Promise<void> {
  const into = pr.base?.ref ?? '(no base)'
  const again = `call epicIssue with sub ${sub.issue}, state "merged", pr <the new PR> and override`
  const reopen = `run \`gh pr create --repo ${epic.repo} --base ${main} --head ${pr.head.ref}\`, merge that PR, then ${again}`
  const on = sub.stackedOn === undefined ? undefined : epic.issues[String(sub.stackedOn)]
  const under = on?.pr ? await readPr($, epic.root, epic.repo, on.pr) : undefined
  if (!on || !under || under.head.ref !== into) throw new Refuse(`Refused: GitHub says PR #${sub.pr} of #${sub.issue} merged into "${into}", which is not the default branch "${main}"${on?.pr ? ` and not the branch of PR #${on.pr} of #${on.issue}` : ''}, so ${main} does not have it. Nothing changed. Repair: ${reopen}.`)
  const closed = !under.merged && under.state === 'closed'
  if (!under.merged && !closed) throw new Refuse(`Refused: PR #${sub.pr} of #${sub.issue} merged into ${into}, the branch of PR #${on.pr} of #${on.issue}, which is not merged, so ${main} does not have it yet. Nothing changed. Repair: merge PR #${on.pr}, call epicIssue with sub ${on.issue} and state "merged", then call it for #${sub.issue} again.`)
  if (!closed) {
    const landed = Date.parse(under.merged_at ?? '')
    const rode = Date.parse(pr.merged_at ?? '')
    if (Number.isNaN(landed) || Number.isNaN(rode)) throw new Refuse(`Refused: GitHub gave no merge time for PR #${Number.isNaN(rode) ? sub.pr : on.pr} (merged_at ${JSON.stringify(Number.isNaN(rode) ? pr.merged_at : under.merged_at)}), so it is not known whether PR #${sub.pr} merged into ${into} before PR #${on.pr} took that branch to ${main}. Nothing changed. Repair: read both with \`gh pr view <n> --repo ${epic.repo} --json mergedAt\` and call epicIssue again.`)
    if (landed > rode) return
  }
  const why = closed ? `PR #${on.pr} of #${on.issue} closed without merging` : `PR #${on.pr} of #${on.issue} had merged into ${main}`
  const note = `PR #${sub.pr} merged into ${into} after ${why}, so its change is not on ${main}. Repair: ${reopen}.`
  if (from === 'blocked') throw new Refuse(`Refused: ${note.replace(' Repair:', ' Nothing changed. Repair:')}`)
  // Model: models/workflow/epic_workflow.qnt#recordLost
  sub.state = 'blocked'
  sub.previous = from
  sub.note = note
  sub.lost = true
  moved(epic, `epicIssue #${sub.issue}`, 'blocked', now, from)
  await saveEpic($, epic)
  throw new Refuse(`Not recorded as merged: ${note} #${sub.issue} is now blocked (it was "${from}").`)
}

// The checks before a sub-issue counts as verified. Each one is passed, failed or not run.
// Model: models/workflow/epic_workflow.qnt#verify
async function verify($: EngineInterface, epic: Epic, sub: SubIssue): Promise<string> {
  const passed: string[] = []
  const failed: string[] = []
  const notRun: string[] = []
  const n = sub.pr!
  const error = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
  let body = ''
  let verifiedSha = ''
  let omittedChecks: string[] = []
  // A merged PR has its own refusal: its old checks say nothing, and the repair is another move.
  let merged: Refuse | undefined
  let main = '<the default branch>'
  let wrongBase = false
  const under = sub.stackedOn === undefined ? undefined : epic.issues[String(sub.stackedOn)]
  const early = under && under.state !== 'merged' ? under : undefined
  if (early) failed.push(`it is stacked on #${early.issue}, which is "${early.state}" and not merged in the record`)
  try {
    const pr = await readPr($, epic.root, epic.repo, n)
    body = pr.body ?? ''
    verifiedSha = pr.head.sha
    if (pr.merged) merged = new Refuse(`Refused: PR #${n} for #${sub.issue} is already merged${pr.merge_commit_sha ? ` (merge commit ${pr.merge_commit_sha})` : ''}, so the verify checks cannot run on it. Nothing changed. Repair: call epicIssue with state "merged", which records a PR that a human merged.`)
    // Model: models/workflow/epic_workflow.qnt#humanClosesPr
    // Model: models/workflow/epic_workflow.qnt#workerMarksReady
    if (pr.state !== 'open') failed.push(`the PR is ${pr.state}`)
    else if (pr.draft) failed.push('the PR is a draft')
    else passed.push('open and not a draft')
    // A PR on another base merges into that branch, not into the default branch, so it is never verified.
    try {
      main = await defaultBranch($, epic.root, epic.repo)
      if (!pr.base?.ref) notRun.push('base: GitHub gave no base branch for the PR')
      // Model: models/workflow/epic_workflow.qnt#retarget
      else if (pr.base.ref !== main) {
        wrongBase = true
        failed.push(`the base is "${pr.base.ref}", not the default branch "${main}"`)
      } else passed.push(`base is ${main}`)
    } catch (e) {
      notRun.push(`base: the default branch was not read: ${error(e)}`)
    }
    // Model: models/workflow/epic_workflow.qnt#baseMoves
    if (pr.mergeable === true) passed.push('mergeable')
    else if (pr.mergeable === false) failed.push(`not mergeable (${pr.mergeable_state ?? 'unknown'})`)
    else notRun.push('mergeable: GitHub has not computed it yet')
    try {
      // Model: models/workflow/epic_workflow.qnt#ciEnds
      const checks = await readChecks($, epic.root, epic.repo, pr.head.sha, n)
      omittedChecks = checks.skipped ?? []
      if (!checks.green.length && !checks.pending.length && !checks.red.length) omittedChecks = ['ci:no-checks']
      if (checks.red.length) failed.push(`checks failed: ${checks.red.join(', ')}`)
      if (checks.pending.length) failed.push(`checks not ended: ${checks.pending.join(', ')}`)
      if (!checks.red.length && !checks.pending.length) passed.push(`checks (${checks.green.length} passed${checks.green.length ? `: ${checks.green.join(', ')}` : ''})`)
    } catch (e) {
      notRun.push(`checks: ${error(e)}`)
    }
  } catch (e) {
    notRun.push(`the PR, its checks and mergeability: ${error(e)}`)
  }
  if (merged) throw merged
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
  if (!failed.length && !notRun.length) {
    // The PR is on the default branch and what it was stacked on is merged: the stack is over.
    delete sub.stackedOn
    sub.verification = { sha: verifiedSha, at: await $.clock.now() }
    recordDebts(epic, omittedChecks.map((check, index) => ({ key: `verify:${sub.issue}:${verifiedSha}:${index}`, kind: 'skipped-check' as const, sub: sub.issue, check, note: `PR #${sub.pr} skipped ${check} at ${verifiedSha}` })), await $.clock.now(), { places: 1 })
    return report
  }
  const repairs = [
    ...(early ? [`merge PR #${early.pr} of #${early.issue} first and call epicIssue with sub ${early.issue} and state "merged"`] : []),
    ...(wrongBase ? [`the implementer of #${sub.issue} must ${unstackSteps(epic.repo, main, String(n))}`] : []),
    ...(missingMigrations.length ? [`the implementer must add each migration with mcp__ndev__addMigration, so the PR body lists it`] : []),
    ...(notRun.length ? ['run the verify again when GitHub answers'] : []),
    ...(failed.length && !missingMigrations.length && !early && !wrongBase ? ['send the failures to the implementer, or move the issue to "fixing"'] : []),
  ]
  throw new Refuse(`Refused: PR #${n} for #${sub.issue} is not verified. Nothing changed.\n${report}\nRepair: ${repairs.join('; ')}.`)
}

function statusText(epic: Epic): string {
  const rows = Object.values(epic.issues).sort((a, b) => a.issue - b.issue).map(i => `- #${i.issue} "${i.title}": ${i.state}${i.pr ? `, PR #${i.pr}` : ''}${i.rounds ? `, ${i.rounds} rounds` : ''}${i.blockedBy.length ? `, after ${tags(i.blockedBy)}` : ''}${i.remote ? `, on ${i.remote.name}` : ''}${i.stackedOn ? `, stacked on ${tag(i.stackedOn)}` : ''}${i.state === 'blocked' && i.note ? ` (${i.note})` : ''}`)
  const place = epic.remote ? `\nNew sub-issues start on the saved Orca server ${served(epic.remote)}${epic.remoteRepo ? `, repository ${epic.remoteRepo}` : ' (remoteRepo is not recorded)'}.` : ''
  return `Epic #${epic.epic} "${epic.title}" in ${epic.root} is in the state "${epic.state}". Next: ${epicStep(epic)}${place}\nDebt: ${JSON.stringify(epic.debts ?? [])}${rows.length ? `\nSub-issues:\n${rows.join('\n')}` : ''}`
}

async function epicStatus($: EngineInterface, c: Ctx): Promise<string> {
  return statusText(await boundEpic($, c, 'epicStatus'))
}

// The engine follows $ only into functions named at the top of a file, so the tools are a switch.
async function dispatch($: EngineInterface, name: string, c: Ctx): Promise<string> {
  switch (name) {
    case 'epicStarted': return epicStarted($, c)
    case 'epicPhase': return epicPhase($, c)
    case 'epicDebt': return epicDebt($, c)
    case 'epicDebtRuling': return epicDebtRuling($, c)
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
      remote: { description: 'Optional, and only when the human asks for it: start the workers of new sub-issues on a saved Orca server. true is the server that /dev remote saved for this project, else the only one Orca has; a string names one by name, recipe id or id; false goes back to this machine. With no value, nothing changes', anyOf: [{ type: 'boolean' }, { type: 'string' }] },
      remoteRepo: string('With remote: the selector of the repository on that server, such as id:<id> or name:<name>, from `orca repo list --environment <server> --json`'),
      baseSha: string('The original full base commit before the epic implementation; it cannot be replaced'),
      coordinatorModel: string('The original coordinator model identifier; closing review uses another model'),
      posture: { type: 'string', enum: ['standard', 'deadline'] },
      fullSuites: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'The full-suite command argument arrays; later changes can only add commands' },
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
      files: { type: 'array', items: { type: 'string' }, description: 'framing: the one-page core idea, with 3 to 5 acceptance examples "A1: <input> → <expected output>"; researching: the notes; specifying: the spec; spec-review: the review. Each must exist' },
      closingFile: string('closing only: structured exact-SHA full-suite receipts and whole-epic R-id review'),
      aim: string('framing only: one or two sentences that say what the epic is for'),
      sources: { type: 'array', items: { type: 'string' }, description: 'framing only: a path or link to each source document of the requirements, or the one entry "no source: <reason>". A path must exist' },
      issues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'number' }, key: { type: 'string' }, title: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'number' } } }, required: ['issue', 'key', 'title'] }, description: `slicing only: the sub-issues, each open on GitHub; at most ${SLICE_CAP} without capOverride` },
      approval: string('slicing only: the human\'s approval of the breakdown (title, blocked by, what it delivers), given before any issue was filed'),
      specPr: num('spec-review only: the spec PR, whose body says "Refs #<epic>" and has no closing keyword for the epic'),
      capOverride: string(`slicing only: the human's reason to keep more than ${SLICE_CAP} sub-issues in one epic instead of child epics. It is recorded as a gate-override debt`),
    },
    required: ['issue', 'finished', 'evidence'],
  },
  { name: 'epicNext', description: 'Read-only: the sub-issues that can start now, from the default branch or stacked on the PR branch of a blocker that is not merged, what is in flight, and what waits or is blocked.', properties: { issue: num('The epic issue') }, required: ['issue'] },
  {
    name: 'epicBrief',
    description: 'Write the brief for a worker of one sub-issue to a file, and answer with its path and the orca orchestration worker-start command to run. An implementer whose blocker has a pushed PR that is not merged starts from the branch of that PR, and the record keeps the stack.',
    properties: { issue: num('The epic issue'), sub: num('The sub-issue'), role: { type: 'string', enum: ['implementer', 'reviewer'] }, pr: num('reviewer only: the PR, when the record has none yet') },
    required: ['issue', 'sub', 'role'],
  },
  {
    name: 'epicIssue',
    description: 'Record a move of one sub-issue: waiting→implementing, implementing→reviewing, reviewing→fixing, fixing→reviewing, reviewing→verified (runs the verify checks, which refuse a PR whose base is not the default branch), verified→merged (names each sub-issue stacked on it and what to tell its worker), reviewing or fixing→merged (only when a human already merged the PR), any→blocked and back. The same state with workspace records the workspace only.',
    properties: {
      issue: num('The epic issue'),
      sub: num('The sub-issue'),
      state: { type: 'string', enum: ISSUE_STATES },
      pr: num('implementing→reviewing: the PR'),
      worker: string('The dispatch id of the worker that starts now'),
      workspace: string("The absolute path of the implementer's worktree; for a sub-issue on a saved Orca server, its worktree id there, <repoId>::<path>"),
      verdict: { type: 'string', enum: ['approve', 'changes'] },
      override: string('merged before reviewing: the explicit reason, recorded as debt'),
      note: string('fixing: your ruling on each finding; blocked: what blocks it'),
    },
    required: ['issue', 'sub', 'state'],
  },
  { name: 'epicDebt', description: 'Record a skipped check, unreviewed merge or gate override as unresolved epic debt.', properties: { issue: num('The epic'), key: string('Stable event key for retries'), kind: { type: 'string', enum: ['skipped-check', 'merge-without-review', 'gate-override'] }, note: string('What happened and why'), sub: num('Optional sub-issue'), check: string('Required for a skipped check') }, required: ['issue', 'key', 'kind', 'note'] },
  { name: 'epicDebtRuling', description: 'Rule on a recorded debt. Closing refuses unresolved items.', properties: { issue: num('The epic'), key: string('The recorded debt key'), ruling: { type: 'object', properties: { verdict: { type: 'string', enum: ['fixed', 'issue-filed', 'accepted'] }, reason: string('Required reason'), evidence: string('Required when fixed'), issue: num('Required open follow-up for issue-filed') }, required: ['verdict', 'reason'] } }, required: ['issue', 'key', 'ruling'] },
  { name: 'epicStatus', description: 'Read-only: the epic state, the next step and the sub-issues by state.', properties: { issue: num('Optional: the epic issue') }, required: [] },
]

export async function startEpic($: EngineInterface): Promise<void> {
  for (const s of SPECS) await $.tool.register({ name: s.name, description: s.description, inputSchema: { type: 'object', properties: s.properties, required: s.required }, isDeferred: false })
}

export async function epicFailureScope($: EngineInterface): Promise<{ root?: string; issue?: number; error?: string } | null> {
  try {
    return await read($, epicBound)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export const epicTools = (on: Parameters<Register>[0], project: () => Project) => {
  for (const s of SPECS) {
    registerWorkflowFailure(s.name, 'epicStatus')
    on('tool.call', { tool: `mcp__ndev__${s.name}` }, async ($, e): Promise<{ result: string; isError?: true }> => {
      const args = e as unknown as Args
      if (args.agentId) return { result: `Refused: only the main agent calls ${s.name}. A helper does not move the epic. Report to the main agent.`, isError: true as const }
      try {
        return { result: await inFreeTurn($, () => dispatch($, s.name, { args, project: project() })) }
      } catch (error) {
        if (error instanceof Refuse) return { result: error.message, isError: true as const }
        if (error instanceof DebtRefused) return { result: `Refused: ${error.message} Nothing changed. Repair: ${error.repair}`, isError: true as const }
        return (await workflowToolFailed($, e.tool, { kind: 'throw', message: error instanceof Error ? error.message : String(error) }, args, s.name === 'epicStarted' ? undefined : await epicFailureScope($)))!
      }
    }).catch(async ($, e, next) => workflowToolFailed($, e.tool, next.error, e as unknown as Args, s.name === 'epicStarted' ? undefined : await epicFailureScope($)))
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

// Model: models/workflow/epic_workflow.qnt#humanMove
async function humanMove($: EngineInterface, epic: Epic, to: EpicState, how: 'skip' | 'goto', reason: string): Promise<string> {
  if (to === 'done') throw new Refuse('Refused: the closing gate cannot be skipped or bypassed. Complete epicPhase closing with structured evidence and ruled debt.')
  const now = await $.clock.now()
  const from = epic.state
  recordDebt(epic, { key: `phase:${from}:${to}:${epic.history.length}`, kind: 'gate-override', note: reason || 'Human override' }, now)
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
    // Model: models/workflow/epic_workflow.qnt#humanSkip
    if (epic.state === 'done') return `/flow epic ${verb}: Refused: Epic #${epic.epic} is done, and ${verb} cannot reopen it. Nothing changed. Repair: file what remains as new issues, or start a new epic with /flow epic <title>.`
    // Model: models/workflow/epic_workflow.qnt#humanGoto
    const to = verb === 'skip' ? nextEpicState(epic.state)! : rest[0] as EpicState | undefined
    if (!to || !EPIC_STATES.includes(to)) return `/flow epic goto needs a state: ${EPIC_STATES.join(', ')}.`
    try {
      return await humanMove($, epic, to, verb, verb === 'skip' ? reason : rest.slice(1).join(' '))
    } catch (error) {
      if (error instanceof DebtRefused) return `/flow epic ${verb}: Refused: ${error.message} Nothing changed. Repair: ${error.repair}`
      throw error
    }
  }
  if (epic && epic.state !== 'done') return statusText(epic)
  if (!project) return 'Not started: the project folder is not known yet.'
  const all = words.join(' ').trim()
  const target = /^#?[1-9]\d*$/.test(all) ? `issue ${all.replace('#', '')}` : `title ${JSON.stringify(all)} (it files the epic issue) and a shortName of two to five words`
  if (!all) return `${none}\n\n${EPIC_HELP.join('\n')}`
  tellCoordinator($, `The human ran /flow epic. Call mcp__ndev__epicStarted with ${target}, then load the skill that its answer names and follow its next step.`)
  return /^#?[1-9]\d*$/.test(all) ? `The agent is told to start or resume epic #${all.replace('#', '')}.` : `The agent is told to file and start the epic "${all}".`
}
