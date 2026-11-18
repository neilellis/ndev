import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { LoadedConfig } from './config'
import { firstLine, gh, ghLines, makeRun, ofRepo, orca, orcaProject, orcaWorktrees, readPullRow, start as startFixPrs, closedPulls, START_ORCA, type OrcaWorktree, type Run } from './fix-all-prs'
import { pullUrl } from './links'
import { triageRemote } from './remote'
import { loadEpic } from './workflow/epic'
import { isOrcaChat } from './workflow/effects'
import type { PrRow, TriageAgent, TriageComplexity, TriageGroup, TriageIssue, TriageView } from '../types'

// /dev triage: this session's model groups the open issues and then coordinates, and Orca does the
// work. Each group becomes one Task of one Orca Run; Orca makes the workspace, linked to the group's issues, and starts a
// supervised Claude worker in it that takes the group through the ndev workflow on one pull request. The session answers
// the workers and reports to the human. The mod keeps only the plan and reads the rest back from Orca.
// With --codex the workers are Codex: they have no mcp__ndev__ tools, so their Task gives the workflow's steps by hand.
const PANE = 'triage'
const TITLE = 'Triage'
const TOOL = 'mcp__ndev__triage_groups'
// Orca's inbox wait hears each worker at once, so the timer is only the safety net: GitHub limits calls, and Orca may spend them.
const TICK_MS = 15 * 60_000
// How often each group's open pull request is read, and its worker prodded when the pull request cannot merge.
const PR_CHECK_MS = 10 * 60_000
// The same fault on the same head is sent again only after this long: a fix and its checks take a while.
const PROD_AGAIN_MS = 30 * 60_000
// One blocking inbox check at a time; a check that times out is an empty wait.
const WAIT_MS = 300_000
const LIMIT = 200

type Size = { model: string; effort: string; when: string }
const WHEN: Record<TriageComplexity, string> = {
  'very-complex': 'very complex, or an epic with more than 2 sub-issues', complex: 'complex', average: 'average', simple: 'simple', 'very-simple': 'very simple',
}
const sized = (m: Record<TriageComplexity, [string, string]>) =>
  Object.fromEntries(Object.entries(m).map(([k, [model, effort]]) => [k, { model, effort, when: WHEN[k as TriageComplexity] }])) as Record<TriageComplexity, Size>
// Codex's sol, terra and luna stand where Claude's opus, sonnet and haiku do.
const SIZES: Record<TriageAgent, Record<TriageComplexity, Size>> = {
  claude: sized({
    'very-complex': ['claude-fable-5-1', 'high'], complex: ['claude-opus-5-5', 'high'], average: ['claude-sonnet-5-5', 'medium'],
    simple: ['claude-haiku-5-5', 'xhigh'], 'very-simple': ['claude-haiku-5-5', 'medium'],
  }),
  codex: sized({
    'very-complex': ['gpt-6.1-sol', 'xhigh'], complex: ['gpt-6.1-sol', 'high'], average: ['gpt-6.1-terra', 'medium'],
    simple: ['gpt-6-luna', 'xhigh'], 'very-simple': ['gpt-6-luna', 'medium'],
  }),
}
const isSize = (s: unknown): s is TriageComplexity => typeof s === 'string' && Object.hasOwn(WHEN, s)
const agentOf = (v: Pick<TriageView, 'agent'>): TriageAgent => v.agent ?? 'claude'
const AGENT_NAME: Record<TriageAgent, string> = { claude: 'Claude', codex: 'Codex' }
// batch: how many workers run at once, each batch after the last has ended; 0 for no limit.
// hint: the human's own steer for the coordinator (--hint), empty for none.
// since: only the issues with a number above it (--since <n>), 0 for all. isReverse: the newest issues first (--reverse).
// isMine: only the issues that the gh login opened (--mine).
// isBugsOnly: group only the bugs, and label each issue by its kind (--bugs-only).
// remote: the saved Orca server that holds the workspaces and runs the workers (--remote), by id, id prefix or name;
// '' for the one saved server, undefined for this machine.
type Options = { isDryRun: boolean; agent: TriageAgent; isOpen: boolean; batch: number; hint: string; since: number; isReverse: boolean; isBugsOnly: boolean; isMine: boolean; remote?: string }
// With --bugs-only, each issue that is not a bug is screened out with one of these kinds, and gets its label when it has one.
const SCREEN_KINDS: Record<string, { when: string; label?: string }> = {
  enhancement: { when: 'a feature or improvement to add now', label: 'enhancement' },
  proposal: { when: 'a speculative idea or feature proposal, not yet agreed', label: 'proposed' },
  human: { when: 'a human action: a decision, an account, a key, a payment or a manual step that no code change does' },
  other: { when: 'anything else: a question, a discussion, a chore with no defect' },
}
const BUG_LABEL = 'bug'
type Label = [issue: number, label: string]

// Writes each label with gh.sh, and records each one written in the view, so a later call knows it. Returns one line for each failure.
async function writeLabels($: EngineInterface, repo: string, wanted: Label[]): Promise<string[]> {
  const run = runner($, 60_000, { GH_REPO: repo })
  const failed: string[] = []
  for (const [n, label] of wanted) {
    const r = await run(['bash', `${$.plugin.root}/scripts/github/gh.sh`, 'label', String(n), label])
    if (r.exitCode !== 0) failed.push(`#${n}: gh.sh label ${n} ${label} exited ${r.exitCode}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`)
    else await update($, view, (x): TriageView => ({ ...x, labelled: [...(x.labelled ?? []).filter(([m, l]) => m !== n || l !== label), [n, label]] }))
  }
  if (failed.length) await note($, `${failed.length} labels failed: ${failed.map(f => f.split(':')[0]).join(' ')}`)
  return failed
}

function labelRepair(repo: string, wanted: Label[]): string {
  return `Repair: when a label is missing, make it with ${[...new Set(wanted.map(([, l]) => l))].map(l => `\`gh label create ${l} --repo ${repo}\``).join(' or ')}`
}
// The issues in the order of the run: oldest first, or newest first with --reverse.
const ordered = (issues: TriageIssue[], isReverse: boolean) => issues.slice().sort((a, b) => (isReverse ? b.number - a.number : a.number - b.number))

const EMPTY: TriageView = { phase: 'idle', issues: [], groups: [], log: [] }
const view = atom({ plugin: 'ndev', key: 'triage' } as const, EMPTY, { shape: 'triage-1' })

// Module state, which a reload resets: the tick starts the inbox wait again, and starts run one after another.
let isWaiting = false
let isWatchingPrs = false
let starting: Promise<unknown> = Promise.resolve()
// The inbox messages handled, so a delivery Orca sends again after a failed ack is not handled twice.
const handled = new Set<string>()

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
// The host refuses each $ call once it has unloaded this mod, at the end of a session or a test.
const isUnloaded = (err: unknown) => message(err).includes('no hooks module of that name is loaded')
// Ends a chain that runs detached from its hook. Its own report of a failure calls $ too, so that report fails once
// the mod is unloaded, and nothing is left to show it to. Any other failure is raised again, and stays unhandled.
function detach(work: Promise<unknown>): void {
  void work.catch((err: unknown) => { if (!isUnloaded(err)) throw err })
}
function runner($: EngineInterface, timeoutMs: number, env?: Record<string, string>): Run {
  return makeRun($, timeoutMs, env)
}

async function note($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, view, v => ({ ...v, log: [...v.log, { at, text }].slice(-50) }))
  unsent.push(text)
}

// Orca's Chat UI draws no pane and no toast, so there the triage writes into the chat as well (isOrcaChat).
// The progress lines that have not reached the chat yet. A reload loses them; the pane and /dev triage status keep the log.
let unsent: string[] = []
const FOR_THE_USER = 'Show this to the user as it is, in Markdown. It asks nothing of you: go on with what you were doing.'

// A result or failure for the human: a toast, and in Orca's Chat UI a chat message too.
async function tell($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text)
  unsent = []
  if (!(await isOrcaChat($))) return
  // A text that begins with / would run as a command, and prompt.submit refuses it: the label comes first.
  ask($, 'a notice for the user', `Triage notice:\n\n${text}\n\n${FOR_THE_USER}`)
}

// In Orca's Chat UI: the progress lines since the last flush, as one message with the groups' table. Called at the end
// of each piece of work (a launch, an inbox delivery, a tick, a pull request check), so a batch of lines is one message.
async function flush($: EngineInterface): Promise<void> {
  if (!unsent.length) return
  if (!(await isOrcaChat($))) { unsent = []; return }
  const lines = unsent
  unsent = []
  const table = groupTable(await read($, view))
  ask($, 'the triage progress', `Triage progress:\n${lines.map(l => `- ${l}`).join('\n')}${table ? `\n\n${table}` : ''}\n\n${FOR_THE_USER}`)
}

// What the pane calls each group's state.
function stateOf(g: TriageGroup): { word: string; color: string } {
  return g.error ? { word: 'failed', color: 'error' }
    : g.blockedBy !== undefined ? { word: 'blocked', color: 'warning' }
      : g.question ? { word: 'question', color: 'warning' }
        : g.task === 'completed' ? { word: 'done', color: 'success' }
          : g.task === 'failed' ? { word: 'failed', color: 'error' }
            : g.dispatchId ? { word: 'working', color: 'claude' }
              : g.taskId ? { word: 'waiting', color: 'subtle' } : { word: 'planned', color: 'subtle' }
}
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

// The groups as a GitHub-flavoured Markdown table, for /dev triage status and the chat; empty with no group.
function groupTable(v: TriageView): string {
  if (!v.groups.length) return ''
  const issueUrl = (n: number) => v.issues.find(i => i.number === n)?.url ?? `https://github.com/${v.repo}/issues/${n}`
  const row = (cells: string[]) => `|${cells.map(c => (c ? ` ${c} ` : ' ')).join('|')}|`
  return [
    row(['Group', 'Issues', 'State', 'PR', 'Worker']),
    row(['---', '---', '---', '---', '---']),
    ...v.groups.map(g => row([
      `[#${g.lead}](${issueUrl(g.lead)}) ${cell(g.title)}`,
      g.issues.map(n => `#${n}`).join(' '),
      stateOf(g).word,
      g.pr && v.repo ? `[#${g.pr}](${pullUrl(v.repo, g.pr)})` : g.pr ? `#${g.pr}` : '',
      g.dispatchId ?? '',
    ])),
  ].join('\n')
}

// /dev triage status: the phase, the error, every group and the latest activity, in Markdown.
function statusText(v: TriageView): string {
  const head = v.repo ? `Triage of ${v.repo}: ${v.phase}, ${v.groups.length} groups, ${AGENT_NAME[agentOf(v)]} workers${v.runId ? `, Orca Run ${v.runId}` : ''}.`
    : v.error ? 'The last /dev triage did not start a triage.' : 'No triage yet. /dev triage start reads the issues.'
  const error = v.error ? `**Error:** ${v.error}` : ''
  const table = groupTable(v)
  const log = v.log.length ? `Latest activity:\n${v.log.slice(-8).map(e => `- ${e.text}`).join('\n')}` : ''
  return [head, error, table, log].filter(Boolean).join('\n\n')
}

// Sends a prompt to this session's model; a prompt the engine drops is shown, never lost.
function ask($: EngineInterface, what: string, text: string): void {
  detach($.prompt.submit({ text }).catch((err: unknown) => {
    $.ui.toast(`/dev triage could not send ${what} to the model: ${message(err)}`)
    return update($, view, v => ({ ...v, error: `${what} was not sent to the model: ${message(err)}` }))
  }))
}

function setGroup($: EngineInterface, lead: number, change: Partial<TriageGroup>) {
  return update($, view, v => ({ ...v, groups: v.groups.map(g => (g.lead === lead ? { ...g, ...change } : g)) }))
}

// The issues to group: the board's Ready and In progress issue cards, else (and always with --open) the open issues,
// with a linked pull request or not. An issue an Orca workspace already links is someone's work, so it is left out.
async function collect($: EngineInterface, project: LoadedConfig | undefined, o: Options): Promise<string> {
  const g = project?.config.github
  if (!g?.repo) throw new Error(`no GitHub repository is set for this project.\nRepair: run /dev setup, which saves it in .neil-dev.json.`)
  if (project?.config.workflow === false) throw new Error(`each triage worker needs the ndev workflow, and ${project.path} sets "workflow": false.\nRepair: remove that setting, or work the issues without /dev triage.`)
  const repo = g.repo
  if ((await read($, view)).phase === 'running') return `A triage of ${(await read($, view)).repo} is running. /dev triage refresh reads it again.`
  const remote = o.remote === undefined ? undefined : await triageRemote($, project, o.remote)
  await update($, view, () => ({ ...EMPTY, repo, isDryRun: o.isDryRun, agent: o.agent, isOpen: o.isOpen, batch: o.batch || undefined, hint: o.hint || undefined, since: o.since || undefined, isReverse: o.isReverse || undefined, isBugsOnly: o.isBugsOnly || undefined, isMine: o.isMine || undefined, remote }))
  const got = await openIssues($, repo, g.board && !o.isOpen ? g.board : undefined, '', `/dev triage start again${g.board ? ' without --open' : ''}`, o.since, o.isMine, remote?.id)
  // An epic coordinator links no workspace to its epic, so its record says which issues it works. Only a workspace on
  // this machine can be read.
  const epics = await epicsInWork($, got.local, `/dev triage start again`)
  const inEpic = new Set(epics.flatMap(e => [e.epic, ...e.subs]))
  const { issues } = got
  const left = ordered(got.left.filter(i => !inEpic.has(i.number)), o.isReverse)
  const skipped = issues.length - left.length
  const epicLines = epics.map(e => `left out epic #${e.epic}${e.subs.length ? ` and its sub-issues ${e.subs.map(n => `#${n}`).join(' ')}` : ''}: its coordinator works them (${e.path})`)
  for (const line of epicLines) await note($, line)
  const epicText = epicLines.map(l => ` It ${l}.`).join('')
  if (issues.length > LIMIT) {
    throw new Error(`${repo} has more than ${LIMIT} open issues, more than one triage groups well.\nRepair: put the issues to work on in a GitHub project board's Ready column, save the board with /dev setup, and run /dev triage start again${g.board ? ' without --open' : ''}. /dev triage clean closes the outdated ones first.`)
  }
  if (!left.length) {
    await note($, `${issues.length} issues read${o.since ? ` above #${o.since}` : ''}; none is left without an Orca workspace or an epic coordinator`)
    return `No issue of ${repo}${o.since ? ` above #${o.since}` : ''} is left to triage: ${issues.length} read, ${skipped} already linked to an Orca workspace or in an epic that its coordinator works.${epicText}`
  }
  await update($, view, (v): TriageView => ({ ...v, phase: 'grouping', issues: left }))
  await note($, `asked the model to group ${left.length} issues${skipped ? ` (${skipped} already in Orca workspaces or epics)` : ''}`)
  ask($, 'the issues to group', brief(repo, left, o.agent, o.batch, o.hint, o.isReverse, o.isBugsOnly))
  return `Triage of ${repo}: ${left.length} issues sent to the model to group.${epicText}`
}

// /dev triage clean: code gathers a fact record for every open issue (the board's too, whatever its column): its body,
// comments, labels, sub-issues, parent, closing and cross-referenced pull requests, the merged pull requests and the
// default branch's commits that name it, and its Orca workspace. Code flags what it can tell on its own. The model gets
// the records in chunks of CLEAN_CHUNK and judges each issue through mcp__ndev__clean_verdicts, which refuses a chunk
// that leaves an issue without a verdict, or a close verdict with no evidence. Only then is the model told to ask the
// human and close the picked ones, and the end report is built from the recorded verdicts. A clean groups nothing,
// starts no worker and leaves the triage pane as it is. It reads the issues with a linked pull request too: one a
// merged pull request fixed but never closed is the commonest leftover.
const CLEAN_TOOL = 'mcp__ndev__clean_verdicts'
// Issues per chunk: few enough that the model judges each one and does not skim.
const CLEAN_CHUNK = 10
// Issues per GraphQL query.
const GRAPHQL_BATCH = 20
// The pull requests read for the ones that name an issue, newest first; the brief says when the list is cut.
const PR_LIMIT = 300
const LOG_LIMIT = 3000
const VERDICTS = ['done', 'outdated', 'superseded', 'duplicate', 'needs_work'] as const
type VerdictKind = (typeof VERDICTS)[number]
const CONFIDENCES = ['high', 'medium', 'low'] as const
// What a close verdict's evidence must name: a pull request or issue number, a commit sha or a file:line.
const EVIDENCE = /#\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|[\w./-]+\.\w+:\d+/

type IssueNode = {
  number: number; title: string; url: string; body?: string | null
  labels?: { nodes?: { name: string }[] }
  comments?: { nodes?: { author?: { login?: string } | null; body?: string; createdAt?: string }[] }
  subIssues?: { nodes?: { number: number; title?: string; state: string }[] }
  parent?: { number: number; state: string } | null
  closedByPullRequestsReferences?: { nodes?: Pull[] }
  timelineItems?: { nodes?: { source?: (Partial<Pull> & { __typename?: string }) | null; willCloseTarget?: boolean }[] }
}
type Pull = { number: number; title: string; state: string; mergedAt: string | null; changedFiles?: number; headRefName?: string }
type Found = { number: number; title: string; state: string; merged?: boolean; merged_at?: string | null; body?: string }
type Workspace = { path: string; branch?: string; ahead: number | string; pr?: number }
type CleanRecord = {
  issue: TriageIssue; isLinked: boolean; body: string; labels: string[]; comments: string[]
  subIssues: { number: number; state: string }[]; parent?: { number: number; state: string }
  closingPrs: Pull[]; crossRefs: string[]; namingPrs: Found[]; commits: string[]; workspaces: Workspace[]; flags: string[]
}
type Verdict = { issue: number; verdict: VerdictKind; confidence: string; evidence: string; by?: number }
type Cleaning = { repo: string; issues: TriageIssue[]; members: number[][]; chunks: string[]; at: number; verdicts: Map<number, Verdict> }
// Module state, which a reload loses: the tool then says to run the clean again.
let cleaning: Cleaning | undefined

const ISSUE_FIELDS = `fragment F on Issue {
  number title url body
  labels(first: 20) { nodes { name } }
  comments(last: 5) { nodes { author { login } body createdAt } }
  subIssues(first: 50) { nodes { number title state } }
  parent { number state }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title state mergedAt changedFiles headRefName } }
  timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { willCloseTarget source { __typename ... on PullRequest { number title state mergedAt changedFiles } ... on Issue { number title state } } } } }
}`

const slices = <T,>(xs: T[], size: number) => Array.from({ length: Math.ceil(xs.length / size) }, (_, k) => xs.slice(k * size, (k + 1) * size))
const flat = (s: string | null | undefined, max: number) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }
const names = (n: number) => new RegExp(`(^|[^\\w&])#${n}\\b`)
const words = (title: string) => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
function likeness(a: Set<string>, b: Set<string>): number {
  const both = [...a].filter(w => b.has(w)).length
  return both / (a.size + b.size - both || 1)
}
const pullText = (p: Pull) => `#${p.number} ${p.state.toLowerCase()}${p.mergedAt ? ` (merged ${p.mergedAt.slice(0, 10)})` : ''}${p.changedFiles === 0 ? ' (no changed files)' : ''}`

async function clean($: EngineInterface, project: LoadedConfig | undefined, o: Pick<Options, 'hint' | 'since' | 'isReverse' | 'isMine'>): Promise<string> {
  const g = project?.config.github
  // A new clean ends the one before it, even when this one fails or finds nothing: its verdicts must not be taken for this one's.
  cleaning = undefined
  if (!g?.repo) throw new Error(`no GitHub repository is set for this project.\nRepair: run /dev setup, which saves it in .neil-dev.json.`)
  const repo = g.repo
  const got = await openIssues($, repo, undefined, o.isReverse ? 'sort:created-desc' : 'sort:created-asc', '/dev triage clean again', o.since, o.isMine)
  // More than LIMIT: the oldest LIMIT (the newest with --reverse) go now, and the human is told; the closed ones drop out, so a second clean takes the next.
  const isCut = got.issues.length > LIMIT
  // An issue an Orca workspace links is checked too: its work may have merged, or the workspace may be stale. Its record gives the workspace.
  const issues = ordered(ordered(got.issues, o.isReverse).slice(0, LIMIT), o.isReverse)
  const end = o.isReverse ? 'newest' : 'oldest'
  if (!issues.length) return `No open issue of ${repo}${o.since ? ` above #${o.since}` : ''} to clean.`
  const { records, base, isPrListCut } = await cleanFacts($, repo, project!.root, issues, got.worktrees, got.linked)
  const byNumber = new Map(records.map(r => [r.issue.number, r]))
  const members = slices(issues.map(i => i.number), CLEAN_CHUNK)
  const chunks = members.map((m, k) => chunkText(k, members.length, m.map(n => byNumber.get(n)!), base))
  cleaning = { repo, issues, members, chunks, at: 0, verdicts: new Map() }
  const inWorkspace = issues.filter(i => got.linked.has(i.number)).length
  ask($, 'the issues to clean', cleanBrief(repo, issues.length, members.length, chunks[0]!, o.hint, isPrListCut))
  return `Clean of ${repo}: a fact record for each of ${issues.length} issues sent to the model in ${members.length} chunks${inWorkspace ? ` (${inWorkspace} linked to an Orca workspace)` : ''}.${isCut ? ` ${repo} has more than ${LIMIT} open issues: these are the ${end} ${LIMIT}, and /dev triage clean again takes the next.` : ''}`
}

// One fact record for each issue, read in batches: one GraphQL query per GRAPHQL_BATCH issues, one list of the
// repository's pull requests, one log of the default branch, and one rev-list for each linked Orca workspace.
async function cleanFacts($: EngineInterface, repo: string, root: string, issues: TriageIssue[], worktrees: OrcaWorktree[], linked: Set<number>) {
  const run = runner($, 120_000, { GH_REPO: repo })
  const base = ((await gh(run, ['default-branch'])) as { default_branch?: string }).default_branch
  if (!base) throw new Error(`gh.sh default-branch gave no default branch for ${repo}.\nRepair: run \`gh repo view ${repo} --json defaultBranchRef\` to see why, then /dev triage clean again.`)
  const [owner, name] = repo.split('/')
  const nodes = new Map<number, IssueNode>()
  for (const batch of slices(issues.map(i => i.number), GRAPHQL_BATCH)) {
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${batch.map(n => `i${n}: issue(number: ${n}) { ...F }`).join(' ')} } } ${ISSUE_FIELDS}`
    const span = `#${batch[0]}–#${batch[batch.length - 1]}`
    const got = (await gh(run, ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`]).catch((err: unknown) => {
      throw new Error(`the GraphQL read of ${span} of ${repo} failed: ${message(err)}`)
    })) as { data?: { repository?: Record<string, IssueNode | null> } }
    for (const n of batch) {
      const x = got.data?.repository?.[`i${n}`]
      if (!x) throw new Error(`the GraphQL read of issues ${batch.map(m => `#${m}`).join(' ')} of ${repo} gave no record for #${n}, so the clean cannot judge it: ${JSON.stringify(got).slice(0, 300)}\nRepair: check #${n} with \`gh issue view ${n} --repo ${repo}\`, then run /dev triage clean again.`)
      nodes.set(n, x)
    }
  }
  const pulls = await ghLines<Found>(run, ['pr-search', 'sort:updated-desc', '--limit', String(PR_LIMIT)])
  // The log must be of the default branch as GitHub has it now, or a commit merged since the last fetch reads as missing.
  const fetched = await run(['git', '-C', root, 'fetch', 'origin', base])
  if (fetched.exitCode !== 0) throw new Error(`git -C ${root} fetch origin ${base} exited ${fetched.exitCode}: ${(fetched.stderr.trim() || fetched.stdout.trim()).slice(0, 300)}\nRepair: check the remote and the network with \`git -C ${root} remote -v\` and \`git -C ${root} fetch origin ${base}\`, then /dev triage clean again.`)
  const log = await run(['git', '-C', root, 'log', `origin/${base}`, '-n', String(LOG_LIMIT), '--format=%h%x1f%s%x1f%b%x1e'])
  if (log.exitCode !== 0) throw new Error(`git -C ${root} log origin/${base} exited ${log.exitCode}: ${(log.stderr.trim() || log.stdout.trim()).slice(0, 300)}\nRepair: run \`git -C ${root} fetch origin ${base}\`, then /dev triage clean again.`)
  // A cut log would drop commits, and their issues would read "no commit names it".
  if (log.isStdoutTruncated) throw new Error(`git -C ${root} log origin/${base} -n ${LOG_LIMIT} printed more than the engine keeps, so commits would be missing from the records.\nRepair: lower LOG_LIMIT in hooks/triage.tsx, then /dev triage clean again.`)
  const commits = log.stdout.split('\x1e').map(c => c.trim()).filter(Boolean).map(c => c.split('\x1f'))
  const ahead = new Map<string, number | string>()
  for (const w of worktrees) {
    if (!(w.linkedItems ?? []).some(i => i.type === 'issue' && issues.some(x => x.number === i.number))) continue
    const r = await run(['git', '-C', w.path, 'rev-list', '--count', `origin/${base}..HEAD`])
    // A workspace that git cannot read is a fact for the model too, and the record says why.
    ahead.set(w.path, r.exitCode === 0 ? Number(r.stdout.trim()) : `not read (git rev-list exited ${r.exitCode}: ${flat(r.stderr || r.stdout, 200)})`)
  }
  const titles = issues.map(i => ({ number: i.number, title: i.title, words: words(i.title) }))
  const records = issues.map((i): CleanRecord => {
    const x = nodes.get(i.number)!
    const n = i.number
    const closingPrs = x.closedByPullRequestsReferences?.nodes ?? []
    const subIssues = (x.subIssues?.nodes ?? []).map(s => ({ number: s.number, state: s.state }))
    const refs = (x.timelineItems?.nodes ?? []).flatMap(t => (t.source?.number === undefined ? [] : [{ ...t.source, willCloseTarget: t.willCloseTarget }]))
    const crossRefs = [...new Map(refs.map(r => [r.number, r])).values()].filter(r => !closingPrs.some(p => p.number === r.number))
      .map(r => (r.__typename === 'PullRequest' ? `PR ${pullText(r as Pull)}` : `issue #${r.number} ${String(r.state).toLowerCase()}`))
    const namingPrs = pulls.filter(p => names(n).test(`${p.title}\n${p.body ?? ''}`))
    const named = commits.filter(([, s, b]) => names(n).test(`${s}\n${b ?? ''}`)).map(([sha, s]) => `${sha} ${s}`)
    const workspaces = worktrees.filter(w => (w.linkedItems ?? []).some(l => l.type === 'issue' && l.number === n))
      .map(w => ({ path: w.path, branch: w.branch, ahead: ahead.get(w.path) ?? 'not read', pr: w.linkedPR ?? undefined }))
    const openPrs = [...closingPrs, ...refs.filter((r): r is Pull & { __typename?: string } => r.__typename === 'PullRequest')]
    const flags = [
      ...closingPrs.filter(p => p.mergedAt).map(p => `closed by merged PR #${p.number} (merged ${p.mergedAt!.slice(0, 10)}) but still open`),
      ...(subIssues.length && subIssues.every(s => s.state === 'CLOSED') ? [`every sub-issue is closed: ${subIssues.map(s => `#${s.number}`).join(', ')}`] : []),
      ...[...new Map(openPrs.filter(p => p.state === 'OPEN' && p.changedFiles === 0).map(p => [p.number, p])).values()].map(p => `open PR #${p.number} has no changed files`),
      ...workspaces.filter(w => w.ahead === 0 && !w.pr).map(() => 'the workspace has no commits and no PR'),
      ...titles.filter(t => t.number !== n && likeness(t.words, words(i.title)) >= 0.75).map(t => `title near #${t.number} "${t.title}": a possible duplicate`),
      ...namingPrs.filter(p => p.merged && !closingPrs.some(c => c.number === p.number)).map(p => `merged PR #${p.number} names #${n} but does not close it`),
    ]
    return {
      issue: i, isLinked: linked.has(n), body: flat(x.body, 1500), labels: (x.labels?.nodes ?? []).map(l => l.name),
      comments: (x.comments?.nodes ?? []).map(c => `${c.author?.login ?? 'someone'} ${(c.createdAt ?? '').slice(0, 10)}: ${flat(c.body, 400)}`),
      subIssues, parent: x.parent ?? undefined, closingPrs, crossRefs, namingPrs, commits: named, workspaces, flags,
    }
  })
  return { records, base, isPrListCut: pulls.length >= PR_LIMIT }
}

function recordText(r: CleanRecord, base: string): string {
  const n = r.issue.number
  return [
    `### #${n} ${r.issue.title} — ${r.issue.url}${r.isLinked ? ' (linked to an Orca workspace)' : ''}`,
    `labels: ${r.labels.join(', ') || 'none'}${r.parent ? ` · parent: #${r.parent.number} (${r.parent.state.toLowerCase()})` : ''}`,
    ...(r.subIssues.length ? [`sub-issues: ${r.subIssues.map(s => `#${s.number} ${s.state.toLowerCase()}`).join(', ')}`] : []),
    `closing PRs: ${r.closingPrs.map(pullText).join(', ') || 'none'}`,
    ...(r.crossRefs.length ? [`cross-referenced by: ${r.crossRefs.join(', ')}`] : []),
    `PRs naming #${n}: ${r.namingPrs.map(p => `#${p.number} ${p.merged ? `merged ${(p.merged_at ?? '').slice(0, 10)}` : p.state} "${flat(p.title, 80)}"`).join(', ') || 'none'}`,
    `commits naming #${n}: ${r.commits.join('; ') || `none on ${base}`}`,
    ...r.workspaces.map(w => `workspace ${w.path} (branch ${w.branch ?? 'unknown'}): ${typeof w.ahead === 'number' ? `${w.ahead} commits ahead of ${base}` : `commits ahead of ${base} ${w.ahead}`}, ${w.pr ? `PR #${w.pr}` : 'no PR'}`),
    `flags: ${r.flags.join('; ') || 'none'}`,
    `body: ${r.body || '(empty)'}`,
    ...r.comments.map(c => `comment by ${c}`),
  ].join('\n')
}

function chunkText(k: number, total: number, records: CleanRecord[], base: string): string {
  return [
    `Chunk ${k + 1} of ${total}: ${records.map(r => `#${r.issue.number}`).join(', ')}`,
    '',
    records.map(r => recordText(r, base)).join('\n\n'),
    '',
    `Judge each of these ${records.length} issues, then call \`${CLEAN_TOOL}\` once with { verdicts } for exactly these ${records.length}.`,
  ].join('\n')
}

function cleanBrief(repo: string, count: number, chunkCount: number, first: string, hint: string, isPrListCut: boolean): string {
  return [
    `Clean: judge each of these ${count} open issues of ${repo}: done, outdated, superseded, duplicate or needs work. Do no other work on them.`,
    `Code has read every issue: the record of each gives its body, comments, labels, sub-issues, parent, closing and cross-referenced pull requests, the merged pull requests and commits on the default branch that name it, and its Orca workspace, with flags for what code could tell. The issues come in ${chunkCount} chunks; this message holds the first, and each answer of the tool holds the next.`,
    ...(isPrListCut ? [`The pull request list holds the newest ${PR_LIMIT} pull requests of ${repo}: an older one that names an issue is not in its record.`] : []),
    '',
    'For each issue of a chunk:',
    '- Judge it from its record. Where the record does not settle it, compare what it asks with the code on the default branch and with later pull requests and commits (`git log --grep`, `git log -S`, the files it names).',
    '- An issue linked to an Orca workspace may be in progress: its record gives the workspace branch, its commits ahead and its pull request. Its work merged means done; open work means needs_work.',
    '- A flag is a lead, not a verdict. An open pull request alone does not make an issue need work, and a merged pull request that fixed or closes it is strong evidence of done.',
    '- verdict: done (a merged pull request or commit fixed it), outdated (the code or plan it is about is gone), superseded (a later issue or pull request covers it: give it in by), duplicate (another issue asks the same: give it in by), or needs_work. confidence: high, medium or low. evidence: for every verdict but needs_work, a pull request or issue number (#n), a commit sha or a file:line. When you are not sure, the verdict is needs_work.',
    `- Call \`${CLEAN_TOOL}\` with { verdicts: [{ issue, verdict, confidence, evidence, by }] } for exactly the issues of the chunk. If it refuses, fix what it names and call it again.`,
    '- You may judge a chunk in a subagent: give it the chunk as it stands, and call the tool yourself with the verdicts it returns.',
    '',
    'When every issue has a verdict, the tool answers with the issues to ask the user about and how to close them. Ask nothing and close nothing before that.',
    ...(hint ? ['', `The human's hint for this clean: ${hint}`] : []),
    '',
    first,
  ].join('\n')
}

// The reasons a verdicts call is refused; none when it can be recorded.
function verdictProblems(c: Cleaning, items: unknown[]): string[] {
  const own = c.members[c.at]!
  const range = `chunk ${c.at + 1} (${own.map(n => `#${n}`).join(', ')})`
  const out: string[] = []
  const seen = new Set<number>()
  items.forEach((x, k) => {
    if (x === null || typeof x !== 'object') { out.push(`verdict item ${k + 1} is not an object; give { issue, verdict, confidence, evidence, by }`); return }
    const v = x as { issue?: unknown; verdict?: unknown; confidence?: unknown; evidence?: unknown; by?: unknown }
    const n = v.issue
    if (!Number.isInteger(n)) { out.push(`verdict item ${k + 1} names the issue ${JSON.stringify(n)}; give its number`); return }
    const m = n as number
    if (!own.includes(m)) {
      out.push(c.issues.some(i => i.number === m) ? `#${m} is not in ${range}; give its verdict with its own chunk` : `#${m} is not one of the issues of this clean`)
      return
    }
    if (seen.has(m)) out.push(`#${m} has two verdicts; give it one`)
    seen.add(m)
    if (typeof v.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(v.verdict)) { out.push(`#${m}: ${JSON.stringify(v.verdict)} is not a verdict; use one of ${VERDICTS.join(', ')}`); return }
    if (typeof v.confidence !== 'string' || !(CONFIDENCES as readonly string[]).includes(v.confidence)) out.push(`#${m}: ${JSON.stringify(v.confidence)} is not a confidence; use one of ${CONFIDENCES.join(', ')}`)
    if (v.verdict === 'needs_work') return
    if (typeof v.evidence !== 'string' || !EVIDENCE.test(v.evidence)) out.push(`#${m} is ${v.verdict} but its evidence names no PR number, commit sha or file:line`)
    if ((v.verdict === 'superseded' || v.verdict === 'duplicate') && (!Number.isInteger(v.by) || v.by === m)) out.push(`#${m} is ${v.verdict} but gives no by: the number of the issue or pull request that covers it`)
  })
  for (const n of own) if (!seen.has(n)) out.push(`#${n} has no verdict`)
  return out
}

const isAsked = (v: Verdict) => v.verdict !== 'needs_work' && v.confidence !== 'low'
const verdictLine = (v: Verdict, title: string) =>
  `- #${v.issue} ${v.verdict}${v.by ? ` ${v.verdict === 'superseded' ? 'by' : 'of'} #${v.by}` : ''}: ${v.evidence} (${v.confidence} confidence) — "${title}"`

function askText(c: Cleaning): string {
  const asked = [...c.verdicts.values()].filter(isAsked)
  const title = (n: number) => c.issues.find(i => i.number === n)?.title ?? ''
  if (!asked.length) return `Recorded: all ${c.issues.length} issues have a verdict, and none is a close you are sure of. Ask the user nothing and close nothing. Call \`${CLEAN_TOOL}\` with { closed: [] } for the end report, and give the user that report.`
  return [
    `Recorded: all ${c.issues.length} issues have a verdict. Ask the user which of these ${asked.length} to close with AskUserQuestion (multiSelect, at most 4 issues a question, 4 questions a call; ask again for the rest). Each option is one issue: "#<n> <title>", and its description gives the verdict and the evidence.`,
    ...asked.map(v => verdictLine(v, title(v.issue))),
    '',
    `Close each issue the user picks, and only those: \`gh issue close <n> --repo ${c.repo} --reason "not planned" --comment "<verdict and evidence>"\`, or --reason completed for done. Never close an issue the user did not pick.`,
    `Then call \`${CLEAN_TOOL}\` with { closed: [<each issue closed>], failed: [{ issue, error }] } for the end report, and give the user that report.`,
  ].join('\n')
}

// The end report, from the recorded verdicts: what was closed, what failed, and what stays open and why.
function cleanReport(c: Cleaning, closed: number[], failed: { issue: number; error: string }[]): string {
  const done = new Set([...closed, ...failed.map(f => f.issue)])
  const all = [...c.verdicts.values()].filter(v => !closed.includes(v.issue))
  const list = (vs: Verdict[]) => vs.map(v => v.issue).sort((a, b) => a - b).map(n => `#${n}`).join(', ')
  const needs = all.filter(v => v.verdict === 'needs_work')
  const unsure = all.filter(v => v.verdict !== 'needs_work' && v.confidence === 'low')
  const notPicked = all.filter(v => isAsked(v) && !done.has(v.issue))
  const why = (n: number) => { const v = c.verdicts.get(n); return v ? `${v.verdict}${v.verdict !== 'needs_work' && v.confidence === 'low' ? ', low confidence' : ''}` : 'not in this clean' }
  // A close the verdicts did not allow (needs work, low confidence, or an issue outside this clean) is reported, never hidden.
  const stray = closed.filter(n => { const v = c.verdicts.get(n); return !v || !isAsked(v) })
  return [
    `Clean of ${c.repo}. Closed ${closed.length} of ${c.issues.length} issues${closed.length ? `: ${closed.map(n => `#${n} (${why(n)})`).join(', ')}` : ''}.`,
    ...(stray.length ? [`Closed with no close verdict, so check them: ${stray.map(n => `#${n} (${why(n)})`).join(', ')}. To undo: \`gh issue reopen <n> --repo ${c.repo}\`.`] : []),
    ...(failed.length ? [`Failed to close ${failed.length}: ${failed.map(f => `#${f.issue}: ${f.error}`).join('; ')}.`] : []),
    ...(notPicked.length ? [`${notPicked.length} not picked and left open: ${list(notPicked)}.`] : []),
    ...(unsure.length ? [`${unsure.length} left open with a low-confidence verdict: ${unsure.map(v => `#${v.issue} (${v.verdict})`).join(', ')}.`] : []),
    `${needs.length} judged needs work and left open${needs.length ? `: ${list(needs)}` : ''}.`,
  ].join('\n')
}

// The answer to one mcp__ndev__clean_verdicts call: a chunk's verdicts, or the closes for the end report.
async function cleanVerdicts(input: { verdicts?: unknown; closed?: unknown; failed?: unknown }): Promise<{ result: string; isError?: true }> {
  const c = cleaning
  const refuse = (wrong: string[]) => ({ result: `Refused, nothing recorded:\n- ${wrong.join('\n- ')}\nFix these and call ${CLEAN_TOOL} again.`, isError: true as const })
  if (!c) return { result: 'Refused: no /dev triage clean is waiting for verdicts (a reload ends one). Run /dev triage clean to start one.', isError: true }
  if (input.closed !== undefined || input.failed !== undefined) {
    const missing = c.issues.filter(i => !c.verdicts.has(i.number)).map(i => `#${i.number}`)
    if (missing.length) return refuse([`${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no verdict yet: give the verdicts of chunk ${c.at + 1} first`])
    const closed = Array.isArray(input.closed) ? input.closed : []
    const failedItems = Array.isArray(input.failed) ? input.failed : []
    const wrong: string[] = []
    // Only malformed input is refused. A close that has already happened is reported whatever its verdict, so the human sees it.
    const named = new Set<number>()
    const check = (n: unknown, what: string) => {
      if (!Number.isInteger(n) || (n as number) < 1) return wrong.push(`${what} names ${JSON.stringify(n)}, which is not an issue number`)
      if (named.has(n as number)) return wrong.push(`#${n} is named twice; name each issue once, in closed or in failed`)
      named.add(n as number)
    }
    closed.forEach(n => check(n, 'closed'))
    const failed = failedItems.flatMap((f, k) => {
      const x = f as { issue?: unknown; error?: unknown } | null
      if (x === null || typeof x !== 'object' || typeof x.error !== 'string' || !x.error.trim()) { wrong.push(`failed item ${k + 1} needs { issue, error }`); return [] }
      check(x.issue, 'failed')
      return [{ issue: x.issue as number, error: x.error.trim() }]
    })
    if (wrong.length) return refuse(wrong)
    cleaning = undefined
    return { result: `${cleanReport(c, closed as number[], failed)}\nGive the user this report as it stands.` }
  }
  if (c.at >= c.members.length) return refuse([`every chunk has its verdicts; call ${CLEAN_TOOL} with { closed, failed } for the end report`])
  const items = Array.isArray(input.verdicts) ? (input.verdicts as unknown[]) : []
  const wrong = verdictProblems(c, items)
  if (wrong.length) return refuse(wrong)
  for (const x of items as Verdict[]) {
    c.verdicts.set(x.issue, { issue: x.issue, verdict: x.verdict, confidence: x.confidence, evidence: typeof x.evidence === 'string' ? x.evidence.trim() : '', ...(Number.isInteger(x.by) ? { by: x.by } : {}) })
  }
  c.at += 1
  if (c.at < c.members.length) return { result: `Recorded the verdicts of chunk ${c.at} of ${c.members.length}.\n\n${c.chunks[c.at]}` }
  return { result: askText(c) }
}

// The open issues of repo: the board's Ready and In progress issue cards when board is given, else up to limit open
// issues that match query, oldest first. With since above 0, only the issues with a higher number. With isMine, only
// the issues that the gh login opened. An issue an Orca
// workspace already links is someone's work, so it is left out of left.
async function openIssues($: EngineInterface, repo: string, board: { owner: string; number: number } | undefined, query: string, again: string, since = 0, isMine = false, environment?: string) {
  const run = runner($, 120_000)
  let issues: TriageIssue[]
  if (board) {
    const env = { GH_REPO: repo, GH_PROJECT_OWNER: board.owner, GH_PROJECT_NUMBER: String(board.number) }
    const out = await runner($, 120_000, env)(['bash', `${$.plugin.root}/scripts/github/gh.sh`, 'board', 'items'])
    if (out.exitCode !== 0) {
      throw new Error(`gh.sh board items for ${board.owner} #${board.number} exited ${out.exitCode}: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}\nRepair: check the board with /dev setup, and \`gh auth refresh -s project\` if gh lacks the project scope.`)
    }
    const cards = out.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as TriageIssue & { status?: string })
    // A shared board holds other repositories' cards, and a draft card has no url.
    const own = `https://github.com/${repo}/issues/`.toLowerCase()
    const login = isMine ? await myLogin(run, again) : undefined
    issues = cards.filter(c => (c.status === 'Ready' || c.status === 'In progress') && typeof c.url === 'string' && c.url.toLowerCase().startsWith(own))
      .filter(c => !login || (c as { author?: string | null }).author?.toLowerCase() === login.toLowerCase())
      .map(({ number, title, url }) => ({ number, title, url }))
  } else {
    // GitHub search has no range of numbers. Numbers go up with time, so the date that #since was opened bounds the
    // search, and the number check below drops #since itself and any issue opened in the same second.
    const from = since ? ` created:>=${await openedAt(run, repo, since)}` : ''
    // The date bound matches #since too, which the number check drops: one more result keeps a cut visible.
    issues = await ghLines<TriageIssue>(run, ['issue-search', `${query}${isMine ? ' author:@me' : ''}${from}`.trim(), '--limit', String(LIMIT + (since ? 2 : 1))])
  }
  if (since) issues = issues.filter(i => i.number > since)
  // With --remote, a workspace on this machine and one on the server are each someone's work.
  const retry = `, then run ${again}`
  const [local, far = []] = environment ? await Promise.all([orcaWorktrees(run, retry), orcaWorktrees(run, retry, environment)]) : [await orcaWorktrees(run, retry)]
  const worktrees = ofRepo([...local, ...far], repo).filter(w => !w.isArchived)
  const linked = new Set(worktrees.flatMap(w => w.linkedItems ?? []).filter(i => i.type === 'issue').map(i => i.number!))
  const left = issues.filter(i => !linked.has(i.number)).sort((a, b) => a.number - b.number)
  return { issues, left, skipped: issues.length - left.length, linked, worktrees, local: ofRepo(local, repo).filter(w => !w.isArchived) }
}

const EPIC_RECORD = /^\.neil-dev\.epic-([1-9]\d*)\.json$/

// Each epic, not done, whose .neil-dev.epic-<n>.json sits in one of the worktrees: its coordinator owns it and its sub-issues.
async function epicsInWork($: EngineInterface, worktrees: OrcaWorktree[], again: string) {
  const found: { epic: number; subs: number[]; path: string }[] = []
  for (const w of worktrees) {
    if (!(await $.fs.exists(w.path))) continue
    for (const entry of await $.fs.list(w.path)) {
      const n = Number(EPIC_RECORD.exec(entry.name)?.[1])
      if (!n) continue
      const path = `${w.path}/${entry.name}`
      let epic
      try {
        epic = await loadEpic($, w.path, n)
      } catch (error) {
        throw new Error(`${(error as Error).message.replace(/ Repair:.*$/s, '')}\nRepair: fix or delete the file, then run ${again}.`)
      }
      if (epic && epic.state !== 'done') found.push({ epic: n, subs: Object.values(epic.issues).map(i => i.issue).filter(i => typeof i === 'number'), path })
    }
  }
  return found
}

// The login that gh is signed in as, for --mine on a board, whose cards carry their author's login.
async function myLogin(run: Run, again: string): Promise<string> {
  let got: unknown
  try {
    got = await gh(run, ['api', 'user'])
  } catch (err) {
    throw new Error(`--mine: GitHub did not give the signed-in user. ${err instanceof Error ? err.message : String(err)}\nRepair: run \`gh auth status\`, sign in with \`gh auth login\` if needed, then run ${again}.`)
  }
  const login = (got as { login?: unknown }).login
  if (typeof login !== 'string' || !login) throw new Error(`--mine: GitHub gave the signed-in user with no login: ${JSON.stringify(got).slice(0, 200)}`)
  return login
}

// When issue or pull request #n of repo was opened, as GitHub gives it (2026-05-01T00:00:00Z).
async function openedAt(run: Run, repo: string, n: number): Promise<string> {
  let got: unknown
  try {
    got = await gh(run, ['api', `repos/${repo}/issues/${n}`])
  } catch (err) {
    throw new Error(`--since ${n}: GitHub did not give #${n} of ${repo}. ${err instanceof Error ? err.message : String(err)}\nRepair: give --since the number of an issue or pull request of ${repo}.`)
  }
  const at = (got as { created_at?: unknown }).created_at
  if (typeof at !== 'string' || !at) throw new Error(`--since ${n}: GitHub gave #${n} of ${repo} with no created_at: ${JSON.stringify(got).slice(0, 200)}`)
  return at
}

function brief(repo: string, issues: TriageIssue[], agent: TriageAgent, batch: number, hint: string, isReverse = false, isBugsOnly = false): string {
  const kinds = Object.entries(SCREEN_KINDS).map(([k, s]) => `  - ${k}: ${s.when}${s.label ? ` (the mod labels it ${s.label})` : ''}`).join('\n')
  const sizes = Object.entries(SIZES[agent]).map(([k, s]) => `  - ${k}: ${s.when} (${s.model}, effort ${s.effort})`).join('\n')
  return [
    `Triage: group these ${issues.length} open issues of ${repo} for ${AGENT_NAME[agent]} Orca workers, one draft pull request per group.`,
    `Read each issue with \`gh issue view <n> --repo ${repo}\` (body, comments, sub-issues) and check the code for work already done.`,
    '',
    ...issues.map(i => `#${i.number} ${i.title} — ${i.url}`),
    '',
    'Rules:',
    '- Put issues about the same bug or area in one group. An epic goes in one group with its sub-issues. A risky change (schema, auth, migration) gets its own group.',
    '- Each issue is in exactly one group. The lead is the lowest issue number in the group.',
    `- complexity sets the worker's model:\n${sizes}`,
    '- hint: where the worker starts: the files, the cause, the approach.',
    '- implemented: true when the code already does what the issues ask, with evidence (file and line, or the commit).',
    '- after: the leads of groups that must finish first: when this group needs their change, or when both change the same files, so the two never edit the same lines at once. Groups with no after run in parallel.',
    ...(isBugsOnly ? [`- This triage takes bugs only. A bug is code that does the wrong thing, fails or breaks. Group only the bugs: the mod labels each grouped issue ${BUG_LABEL}. List every other issue in screened, as { issue, kind, reason }, with one of these kinds:\n${kinds}\n  When you are not sure that an issue is a bug, screen it out. A human action issue stays unlabelled for a person to do.`] : []),
    ...(isReverse ? ['- This triage works the newest issues first: list the groups with the newest issues first, unless after or a risk needs another order.'] : []),
    ...(batch === 1 ? ['- This triage runs one worker at a time, in the order you list the groups: you decide that order. Put first what unblocks others, is most urgent, or is smallest and safest, so each pull request can merge before the next starts. A group still waits for the groups in its after.'] : []),
    ...(batch > 1 ? [`- This triage runs at most ${batch} workers at a time, in batches, in the order you list the groups: you decide that order. The next batch starts only when every worker of the last one has ended. Put first what unblocks others, is most urgent, or is smallest and safest, and put groups that touch the same files in different batches. A group still waits for the groups in its after.`] : []),
    '- When the human asks you, in a hint or in this conversation, to skip or leave out issues without closing them, list them in skipped as { issue, reason } instead of in a group: they stay open, untouched, and get no worker. Never skip an issue that the human did not ask you to leave out.',
    `- A linked pull request does not end the check of an issue. Read each one with \`gh issue view <n> --repo ${repo} --json closedByPullRequestsReferences\` and \`gh pr view <pr> --repo ${repo}\`.`,
    '  - Its pull request merged: check the code. When the code does all that the issue asks, the issue is done but open. Ask the user with AskUserQuestion which of these to close,'
    + ` close only those the user picks with \`gh issue close <n> --repo ${repo} --reason completed --comment "<the pull request and the evidence>"\`, and list them in closed. When work is left, group the issue for that work.`,
    '  - Its pull request closed without a merge: the work is not done. Group the issue.',
    '  - It has an open pull request: that pull request is the unfinished work, and no group starts it again. List it in unfinished as { issue, pr }. The mod hands each one to the /fix-prs loop, which works it with its owner until it is green and merged.',
    ...(hint ? ['', `The human's hint for this triage: ${hint}`, `Follow it where it goes beyond these rules. When it asks you to close issues that need no work, ask the user first with AskUserQuestion, close only those the user picks with \`gh issue close <n> --repo ${repo} --comment "<why>"\`, and list them in closed instead of in a group.`] : []),
    '',
    `Then call \`${TOOL}\` once with { groups: [{ issues, title, complexity, hint, implemented, evidence, after }], closed, skipped, unfinished: [{ issue, pr }]${isBugsOnly ? ', screened' : ''} }.`,
    'If it refuses, fix what it names and call it again.',
    '',
    `You are the coordinator of this triage: one Orca worker takes each group through the ndev workflow (kb/workflow.md), and you do none of that work. Never call mcp__ndev__started for these issues, and never edit, commit or open a pull request for them. Answer the workers, decide what to do when one fails, and report to the user. The mod sends you each of these moments.`,
  ].join('\n')
}

type Proposed = { issues?: unknown; title?: unknown; complexity?: unknown; hint?: unknown; implemented?: unknown; evidence?: unknown; after?: unknown }

// The reasons a groups report is refused; none when it can run.
function problems(issues: TriageIssue[], groups: Proposed[]): string[] {
  const out: string[] = []
  const known = new Set(issues.map(i => i.number))
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : [])
  const leads = new Map<number, number[]>()
  groups.forEach((g, i) => {
    const own = nums(g.issues)
    if (!own.length) { out.push(`group ${i + 1} has no issues`); return }
    const lead = Math.min(...own)
    leads.set(lead, nums(g.after))
    if (g.after !== undefined && (!Array.isArray(g.after) || nums(g.after).length !== g.after.length)) {
      out.push(`the group led by #${lead} has after ${JSON.stringify(g.after)}; give the leads as numbers, as in [12]`)
    }
    if (!isSize(g.complexity)) out.push(`"${String(g.complexity)}" is not a complexity; use one of ${Object.keys(WHEN).join(', ')}`)
    if (typeof g.title !== 'string' || !g.title.trim()) out.push(`the group led by #${lead} has no title`)
    if (g.implemented === true && (typeof g.evidence !== 'string' || !g.evidence.trim())) out.push(`the group led by #${lead} is implemented but gives no evidence`)
    for (const n of own) if (!known.has(n)) out.push(`#${n} is not one of the issues to group`)
  })
  for (const n of known) {
    const count = groups.filter(g => nums(g.issues).includes(n)).length
    if (count === 0) out.push(`#${n} is in no group; put it in a group, or in skipped as { issue, reason } when the human asked you to leave it out`)
    if (count > 1) out.push(`#${n} is in ${count} groups`)
  }
  for (const [lead, after] of leads) for (const a of after) if (a === lead || !leads.has(a)) out.push(`the group led by #${lead} runs after #${a}, which leads no group`)
  if (!out.length) {
    // A depth-first walk of the order finds a cycle.
    const seen = new Set<number>()
    const walk = (lead: number, path: number[]): number[] | undefined => {
      if (path.includes(lead)) return [...path.slice(path.indexOf(lead)), lead]
      if (seen.has(lead)) return undefined
      seen.add(lead)
      for (const a of leads.get(lead) ?? []) { const c = walk(a, [...path, lead]); if (c) return c }
      return undefined
    }
    for (const lead of leads.keys()) { const c = walk(lead, []); if (c) { out.push(`the order has a cycle: ${c.map(n => `#${n}`).join(' → ')}`); break } }
  }
  return out
}

function toGroup(g: Proposed, agent: TriageAgent): TriageGroup {
  const issues = (g.issues as number[]).slice().sort((a, b) => a - b)
  const complexity = g.complexity as TriageComplexity
  const implemented = g.implemented === true
  const title = String(g.title).trim()
  return {
    lead: issues[0]!, issues, complexity, ...SIZES[agent][complexity], implemented,
    title: implemented && !title.startsWith('Confirm implemented:') ? `Confirm implemented: ${title}` : title,
    hint: typeof g.hint === 'string' ? g.hint : '', evidence: typeof g.evidence === 'string' ? g.evidence : undefined,
    after: Array.isArray(g.after) ? g.after.filter((n): n is number => Number.isInteger(n)) : [],
  }
}

// The worker's Task: Target, Change, Constraints, Ownership and Observable acceptance, as Orca's worker contract asks.
function spec(repo: string, g: TriageGroup, issues: TriageIssue[], agent: TriageAgent, root: string): string {
  if (agent === 'codex') return codexSpec(repo, g, issues, root)
  const url = (n: number) => issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`
  const [lead, ...others] = g.issues
  return [
    `Target: ${repo} ${g.issues.map(n => `#${n} (${url(n)})`).join(', ')}. ${g.title}`,
    `Change: ${g.implemented ? `The code may already do this: ${g.evidence}. Confirm it with a test that proves the behaviour; change code only where it falls short. ` : ''}${g.hint}`,
    'Constraints:',
    `- Use the ndev workflow, with one pull request for this group. Call mcp__ndev__started with issue ${lead}, a shortName that you choose and the mode: heavy for a multi-step, cross-cutting or high-risk change, and light for the others. Then follow the answer of each tool.`,
    ...(others.length ? [`- Then call mcp__ndev__started for ${others.map(n => `#${n}`).join(', ')}, each with the same shortName: each joins the same worktree and PR, with its own closing line.`] : []),
    '- No human is at this terminal, because the coordinator session answers you. After each started, call mcp__ndev__setSteering with steering auto and the reason "An Orca worker of /dev triage: no human is at this terminal, and the coordinator session answers its questions."',
    '- Read each issue with `gh issue view` first. Work test first: a failing regression test through a public interface, then the smallest fix.',
    ...(g.after.length
      ? [
          `- This group follows ${g.after.map(a => `#${a}`).join(', ')}. Your workspace starts from the branch of the first of their open pull requests, or from the default branch when none is open.${g.after.length > 1 ? ' Merge the branches of the other open pull requests into it first.' : ''} Orca mail with the subject "Base branch" names <that branch> when it is not the default branch. Then, when the workflow has opened your draft pull request, run \`gh api -X PATCH repos/{owner}/{repo}/pulls/<number> -f base=<that branch>\`, so the pull request shows only this group's change. With no such mail, change no base.`,
          '- If a tool tells you to move or remove a file that came from a group this one follows, leave the file and ask the coordinator.',
        ]
      : []),
    '- Save work with mcp__ndev__checkpoint and not with git commit or git push. The workflow opens the pull request and links it to this workspace. Merge only when mcp__ndev__done does it.',
    `- The pull request body ends with these lines: Model: ${g.model} and Effort: ${g.effort}.`,
    '- When you need a product or scope decision, ask the coordinator and never guess. Run `orca orchestration ask --question "<question>" --wait --timeout-ms 540000 --json` in the foreground, with a command timeout of 600000 ms. After a timeout, run `orca orchestration ask --resume <message_id> --wait --timeout-ms 540000 --json`. Do not end your turn while a question is open, because the workflow counts that as no progress.',
    '- Call mcp__ndev__blocked only when a person must act on this machine, such as a sign-in.',
    `- If the workflow blocks this issue, for example on an open blocked-by issue, read the message. ${g.after.length ? `When it names only issues of the groups that this group follows (${g.after.map(a => `#${a}`).join(', ')}), their change is in your branch, so call mcp__ndev__unblocked and go on. ` : ''}Ask the coordinator about any other block, and call mcp__ndev__unblocked when it is clear. If nobody can clear it, send worker_done with --outcome failed and the block message.`,
    'Ownership: this workspace and its branch only.',
    `Observable acceptance: mcp__ndev__done accepted a pull request that closes ${g.issues.map(n => `#${n}`).join(', ')}.`,
    'Then send worker_done once, with --outcome succeeded and a body that starts with PR #<number>. If you cannot finish, send it with --outcome failed and the reason.',
  ].join('\n')
}

// A Codex worker's Task. The mcp__ndev__ tools are in Claude Code only, so it follows the workflow's stages by hand,
// with the project's check scripts, and stops at a ready pull request with green checks: a human merges it.
function codexSpec(repo: string, g: TriageGroup, issues: TriageIssue[], root: string): string {
  const url = (n: number) => issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`
  const closes = g.issues.map(n => `Closes #${n}`).join(', ')
  return [
    `Target: ${repo} ${g.issues.map(n => `#${n} (${url(n)})`).join(', ')}. ${g.title}`,
    `Change: ${g.implemented ? `The code may already do this: ${g.evidence}. Confirm it with a test that proves the behaviour; change code only where it falls short. ` : ''}${g.hint}`,
    'Constraints:',
    `- Follow the ndev workflow by hand, with one pull request for this group. Its guide is ${root}/kb/workflow.md; read the states, Checks and Rules that the tools enforce. You have none of the ndev plugin\'s tools: they are in Claude Code only, so do each stage yourself as below.`,
    '- No human is at this terminal, because the coordinator session answers you.',
    '- Read each issue with `gh issue view` first. Work test first: a failing regression test through a public interface, watch it fail for the intended reason, then the smallest fix.',
    '- Before each commit, run the project\'s checks in scripts/ndev/workflow/ when they are there: fast-checks.sh <staged files>, then pre-commit-check.sh. Before each push, run pre-push-check.sh. Never skip or weaken a check that fails: fix the cause, or ask the coordinator when the failure is not from this change.',
    '- Commit with git on this workspace\'s branch and push it with `git push -u origin HEAD`. Never push to the default branch.',
    `- After the first push, open the pull request with \`gh pr create --draft --repo ${repo}\`. Its body gives the problem, the result, the test evidence and the limits, then one line each: ${closes}. It ends with these lines: Model: ${g.model} and Effort: ${g.effort}. Then link it to this workspace with \`orca worktree set --worktree "path:$(git rev-parse --show-toplevel)" --pr <number> --workspace-status in-review --json\`, so the coordinator sees it.`,
    ...(g.after.length
      ? [
          `- This group follows ${g.after.map(a => `#${a}`).join(', ')}. Your workspace starts from the branch of the first of their open pull requests, or from the default branch when none is open.${g.after.length > 1 ? ' Merge the branches of the other open pull requests into it first.' : ''} Orca mail with the subject "Base branch" names <that branch> when it is not the default branch. Then give your pull request that base, with \`gh pr create --base <that branch>\` or, once it is open, \`gh pr edit <number> --base <that branch>\`, so it shows only this group's change. With no such mail, keep the default base.`,
          '- If a check or a review tells you to move or remove a file that came from a group this one follows, leave the file and ask the coordinator.',
        ]
      : []),
    '- When the change is complete, review your own diff against the base for scope and accidental changes, run pre-ready-check.sh when it is there, push, and mark the pull request ready with `gh pr ready`. Then wait for its checks with `gh pr checks --watch` and fix each failure until they pass. Do not merge: a human merges.',
    '- When you need a product or scope decision, ask the coordinator and never guess. Run `orca orchestration ask --question "<question>" --wait --timeout-ms 540000 --json` in the foreground, with a command timeout of 600000 ms. After a timeout, run `orca orchestration ask --resume <message_id> --wait --timeout-ms 540000 --json`. Do not end your turn while a question is open.',
    `- If an open blocked-by issue blocks this work, ${g.after.length ? `and it is not one of ${g.after.map(a => `#${a}`).join(', ')}, whose change is in your branch, ` : ''}ask the coordinator. If a person must act on this machine, such as a sign-in, or nobody can clear a block, send worker_done with --outcome failed and the reason.`,
    'Ownership: this workspace and its branch only.',
    `Observable acceptance: a ready pull request on ${repo} whose checks pass and that closes ${g.issues.map(n => `#${n}`).join(', ')}.`,
    'Then send worker_done once, with --outcome succeeded and a body that starts with PR #<number>. If you cannot finish, send it with --outcome failed and the reason.',
  ].join('\n')
}

// One Orca Run, one Task per group in dependency order, then the workers for the ready Tasks.
// The plan is claimed (phase running) before Orca is called, so a second Launch or Start meanwhile is refused.
async function launch($: EngineInterface): Promise<void> {
  // A --bugs-only dry run keeps its labels for the launch, which writes them before it starts a worker.
  const pending = await read($, view)
  if (pending.phase === 'planned' && pending.repo && pending.labels?.length) {
    const failed = await writeLabels($, pending.repo, pending.labels)
    if (failed.length) throw new Error(`${failed.length} of ${pending.labels.length} labels failed, so no worker started:\n- ${failed.join('\n- ')}\n${labelRepair(pending.repo, pending.labels)}, then run /dev triage launch again.`)
    await update($, view, (x): TriageView => ({ ...x, labels: undefined }))
  }
  // A dry run keeps the pull requests of its unfinished issues for the launch, which hands them to the /fix-prs loop.
  if (pending.phase === 'planned' && pending.unfinished?.length) {
    const prs = [...new Set(pending.unfinished.map(([, pr]) => pr))]
    await startFixPrs($, false, prs)
    await note($, `handed ${prs.map(n => `PR #${n}`).join(', ')} to the /fix-prs loop`)
    await update($, view, (x): TriageView => ({ ...x, unfinished: undefined }))
  }
  // A dry run with no group has nothing more to launch.
  if (pending.phase === 'planned' && !pending.groups.length && (pending.labels?.length || pending.unfinished?.length)) {
    await update($, view, (x): TriageView => ({ ...x, phase: 'done' }))
    return
  }
  let v: TriageView | undefined
  await update($, view, (x): TriageView => {
    v = x
    return x.phase === 'planned' && x.repo ? { ...x, phase: 'running' } : x
  })
  if (v?.phase !== 'planned' || !v.repo) throw new Error(`there is no plan to launch (the triage is ${v?.phase}).\nRepair: run /dev triage start.`)
  try {
    await create($, v)
  } catch (err) {
    const runId = (await read($, view)).runId
    await update($, view, (x): TriageView => ({ ...x, phase: 'done' }))
    ask($, 'the failed launch', `Triage: the launch stopped part way: ${message(err)}\nNo worker will write to you. Tell the user, with the repair: /dev triage reset clears this triage, then /dev triage start begins again.`)
    throw new Error(`the launch stopped part way: ${message(err)}\n${runId ? `Orca Run ${runId} keeps the Tasks it made. ` : ''}Repair: /dev triage reset clears this triage, then /dev triage start begins again.`)
  }
  await startReady($)
  await flush($)
  waitLater($)
}

async function create($: EngineInterface, v: TriageView): Promise<void> {
  const repo = v.repo!
  const run = runner($, 120_000)
  const created = (await orca(run, ['orchestration', 'run-create', '--objective', `Triage ${repo}: ${v.groups.length} groups`])) as { run?: { id?: string } }
  const runId = created.run?.id
  if (!runId) throw new Error(`orca orchestration run-create answered no Run id: ${JSON.stringify(created).slice(0, 300)}`)
  handled.clear()
  await update($, view, (x): TriageView => ({ ...x, runId }))
  await note($, `Orca Run ${runId} created`)
  const taskOf = new Map<number, string>()
  const ordered: TriageGroup[] = []
  const place = (g: TriageGroup) => {
    if (ordered.includes(g)) return
    for (const a of g.after) place(v.groups.find(x => x.lead === a)!)
    ordered.push(g)
  }
  v.groups.forEach(place)
  for (const g of ordered) {
    const deps = g.after.map(a => taskOf.get(a)!)
    const made = (await orca(run, [
      'orchestration', 'task-create', '--run', runId, '--task-title', g.title, '--display-name', `issue-${g.lead}`,
      '--spec', spec(repo, g, v.issues, agentOf(v), $.plugin.root), ...(deps.length ? ['--deps', JSON.stringify(deps)] : []),
    ])) as { task?: { id?: string; status: string } }
    if (!made.task?.id) throw new Error(`orca orchestration task-create for #${g.lead} answered no Task id: ${JSON.stringify(made).slice(0, 300)}`)
    taskOf.set(g.lead, made.task.id)
    await setGroup($, g.lead, { taskId: made.task.id, task: made.task.status })
  }
}

// Starts a worker for each Task Orca reports ready. A group whose start failed is never started again:
// its error carries Orca's recovery.
function startReady($: EngineInterface): Promise<unknown> {
  starting = starting.then(() => startNow($)).catch((err: unknown) => note($, `starting workers failed: ${message(err)}`))
  return starting
}

// A worker is in flight until it reports worker_done or fails to start, or until its Task ends in Orca: a worker that
// exits with no worker_done leaves its Task for the coordinator to complete or fail by hand.
const isInFlight = (g: TriageGroup) => !!g.dispatchId && !g.summary && !g.error && g.task !== 'completed' && g.task !== 'failed'
// The batch size: --batch <n>, or 1 for a triage saved by --sequential before --batch; 0 for no limit.
const batchOf = (v: TriageView) => v.batch ?? (v.isSequential ? 1 : 0)

async function startNow($: EngineInterface): Promise<void> {
  const v = await read($, view)
  if (v.phase !== 'running' || !v.runId || !v.repo) return
  // --batch: no start while a worker of the last batch is in flight.
  const batch = batchOf(v)
  if (batch && v.groups.some(isInFlight)) return
  const ready = (await orca(runner($, 60_000), ['orchestration', 'task-list', '--ready', '--run', v.runId])) as { tasks: { id: string }[] }
  // --batch: the coordinator's order of the groups decides which ready groups start next.
  const rank = (id: string) => { const i = v.groups.findIndex(x => x.taskId === id); return i < 0 ? Infinity : i }
  const tasks = batch ? ready.tasks.slice().sort((a, b) => rank(a.id) - rank(b.id)) : ready.tasks
  for (const t of tasks) {
    if (batch && (await read($, view)).groups.filter(isInFlight).length >= batch) break
    const g = (await read($, view)).groups.find(x => x.taskId === t.id)
    if (!g || g.dispatchId || g.error) continue
    try {
      const worktree = g.worktree ?? await makeWorkspace($, v.repo, g, v.issues)
      await startWorker($, v.runId, g, worktree, agentOf(v))
      const now = (await read($, view)).groups.find(x => x.lead === g.lead)
      if (now?.dispatchId && !now.error && now.base) await tellBase($, v.runId, now, now.base)
    } catch (err) {
      await setGroup($, g.lead, { error: message(err) })
      await note($, `#${g.lead}: ${firstLine(message(err))}`)
      askToDecide($, `the failed start of #${g.lead}`, `Triage: the worker for #${g.lead} (${g.title}) did not start:`, message(err), g, v.runId)
    }
  }
  await settle($)
}

// A group that waits for a failed or blocked group never starts. When every group is done, failed or blocked,
// the triage is done.
async function settle($: EngineInterface): Promise<void> {
  const before = await read($, view)
  let hasEnded = false
  await update($, view, (x): TriageView => {
    const groups = x.groups.slice()
    const isStuck = (g: TriageGroup) => !!g.error || g.task === 'failed' || g.blockedBy !== undefined
    for (let changed = true; changed;) {
      changed = false
      groups.forEach((g, i) => {
        if (g.dispatchId || isStuck(g)) return
        const by = g.after.find(a => { const d = groups.find(y => y.lead === a); return d && isStuck(d) })
        if (by !== undefined) { groups[i] = { ...g, blockedBy: by }; changed = true }
      })
    }
    const isOver = groups.every(g => g.task === 'completed' || isStuck(g))
    hasEnded = x.phase === 'running' && isOver
    return { ...x, groups, phase: x.phase === 'running' && isOver ? 'done' : x.phase }
  })
  const after = await read($, view)
  for (const g of after.groups) {
    if (g.blockedBy !== undefined && before.groups.find(y => y.lead === g.lead)?.blockedBy === undefined) await note($, `#${g.lead}: blocked, as #${g.blockedBy} failed`)
  }
  if (hasEnded) {
    await note($, 'every group is done, failed or blocked')
    ask($, 'the end of the triage', [
      `Triage of ${after.repo}: every group has ended. Report to the user, with a link to each pull request and issue, what each group reached and what needs them. Read each pull request with gh first, because this list can be behind.`,
      '',
      ...after.groups.map(g => `#${g.lead} ${g.title}: ${g.error ?? (g.blockedBy !== undefined ? `blocked, as #${g.blockedBy} failed` : g.task ?? 'no state')}${g.pr && after.repo ? `, ${pullUrl(after.repo, g.pr)}` : ', no pull request recorded'}`),
    ].join('\n'))
  }
}

// Orca makes the workspace from the default branch and links the group's issues to it before setup runs.
async function makeWorkspace($: EngineInterface, repo: string, g: TriageGroup, issues: TriageIssue[]): Promise<string> {
  const refs = g.issues.flatMap(n => ['--reference', issues.find(i => i.number === n)?.url ?? `https://github.com/${repo}/issues/${n}`])
  const base = await baseOf($, repo, g)
  const remote = (await read($, view)).remote
  const made = (await orca(runner($, 600_000), [
    'worktree', 'create', ...(remote ? ['--environment', remote.id] : []), '--project', orcaProject(repo), '--name', `issue-${g.lead}`, '--no-parent', '--setup', 'run', '--comment', g.title, ...refs,
    ...(base ? ['--base-branch', `origin/${base}`] : []),
  ])) as { worktree?: { id?: string } }
  const id = made.worktree?.id
  if (!id) throw new Error(`orca worktree create for #${g.lead} answered no worktree id: ${JSON.stringify(made).slice(0, 300)}${START_ORCA}`)
  await setGroup($, g.lead, { worktree: id, base })
  await note($, `#${g.lead}: Orca made workspace issue-${g.lead}${remote ? ` on ${remote.name}` : ''}`)
  return id
}

// A group that follows others starts from the head branch of the first of their open pull requests, so it carries the
// change it waits for and its own pull request stacks on that one. Undefined when none is open: a merged pull request
// has its change on the default branch, and its branch may be gone.
async function baseOf($: EngineInterface, repo: string, g: TriageGroup): Promise<string | undefined> {
  if (!g.after.length) return undefined
  const { groups, remote } = await read($, view)
  const worktrees = await orcaWorktrees(runner($, 60_000), '', remote?.id)
  for (const a of g.after) {
    const before = groups.find(x => x.lead === a)
    const pr = worktrees.find(w => w.id === before?.worktree)?.linkedPR ?? before?.pr
    if (!pr) { await note($, `#${g.lead}: #${a}, which it follows, has no known pull request`); continue }
    const pr_ = await gh(runner($, 60_000), ['pr-read', String(pr)]) as { state?: string; head?: { ref?: string } }
    if (pr_.state !== 'open') continue
    const headRefName = pr_.head?.ref
    if (!headRefName) throw new Error(`gh.sh pr-read ${pr} of ${repo} answered no head branch, so the branch #${g.lead} follows is unknown`)
    return headRefName
  }
  return undefined
}

// Codex stops at a "Hooks need review" screen when a hook is new or changed, and orchestration worker-start passes no CLI flags.
const HOOK_TRUST = 'Codex waits for the user to trust hooks that are new or changed. Repair: in Orca Settings → Agents, give Codex the default argument --dangerously-bypass-hook-trust (or choose "Trust all and continue" once in a Codex tab), then release this worker and start the Task again.'

type StartReceipt = {
  dispatchId?: string; state?: string; failedStage?: string; lastError?: string; recovery?: string
  launch?: { effective?: { model?: string; effort?: string } }; effects?: { kind?: string; role?: string; id?: string }[]
}

// worker-start prints its receipt with `ok: true` even when the start failed and it exits 1, so the receipt's
// state decides, not the exit code.
async function startWorker($: EngineInterface, runId: string, g: TriageGroup, worktree: string, agent: TriageAgent): Promise<void> {
  // With --remote the worker runs on the saved server; the Run, its mail and its Tasks stay on this machine's Orca.
  const remote = (await read($, view)).remote
  const args = ['orchestration', 'worker-start', '--task', g.taskId!, '--run', runId, ...(remote ? ['--on', remote.id] : []), '--worktree', `id:${worktree}`,
    '--agent', agent, '--model', g.model, '--effort', g.effort, '--timeout-ms', '120000', '--full', '--json']
  const out = await $.process.run(['orca', ...args], { timeoutMs: 180_000 })
  let reply: { ok?: boolean; result?: StartReceipt; error?: { code?: string; message?: string } } | undefined
  try {
    reply = JSON.parse(out.stdout) as typeof reply
  } catch {
    throw new Error(`orca orchestration worker-start for #${g.lead} exited ${out.exitCode} and printed no JSON: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}${START_ORCA}`)
  }
  if (!reply?.ok || !reply.result) {
    throw new Error(`orca orchestration worker-start for #${g.lead} refused: ${reply?.error?.code ?? ''}: ${reply?.error?.message ?? JSON.stringify(reply).slice(0, 300)}\nRepair: fix what Orca names, then /dev triage reset and /dev triage start again; \`orca orchestration task-list --run ${runId} --json\` shows the Task.`)
  }
  const r = reply.result
  const terminal = r.effects?.find(x => x.kind === 'terminal' && x.role === 'agent')?.id
  const effective = r.launch?.effective ? `${r.launch.effective.model ?? g.model} · ${r.launch.effective.effort ?? g.effort}` : undefined
  if (r.state !== 'ready') {
    const waits = r.lastError === 'agent_prompt_blocked' ? '\nA prompt waits in the worker\'s terminal: Jump to it and answer it.'
      : /hooks-review/.test(r.lastError ?? '') ? `\n${HOOK_TRUST}` : ''
    await setGroup($, g.lead, { dispatchId: r.dispatchId, terminal, error: `worker-start failed: ${r.lastError ?? r.state} at ${r.failedStage ?? 'an unknown stage'}${waits}\n${r.recovery ?? 'Orca gave no recovery.'}` })
    await note($, `#${g.lead}: the worker did not start: ${r.lastError ?? r.state}`)
    askToDecide($, `the failed start of #${g.lead}`, `Triage: the worker for #${g.lead} (${g.title}) did not start: ${r.lastError ?? r.state} at ${r.failedStage ?? 'an unknown stage'}.${waits}`, r.recovery ?? 'Orca gave no recovery.', g, runId)
    return
  }
  await setGroup($, g.lead, { dispatchId: r.dispatchId, terminal, effective })
  await note($, `#${g.lead}: worker ${r.dispatchId} started (${effective ?? `${g.model} · ${g.effort}`})`)
}

// The spec is written before the first of the groups ends, so only now is the branch known.
async function tellBase($: EngineInterface, runId: string, g: TriageGroup, base: string): Promise<void> {
  try {
    await orca(runner($, 60_000), ['orchestration', 'send', '--to', `dispatch:${g.dispatchId}`, '--run', runId, '--subject', 'Base branch',
      '--body', `Your workspace started from branch ${base}. When the workflow has opened your draft pull request, set its base to ${base}, as your Task says.`])
  } catch (err) {
    askToDecide($, `the base branch of #${g.lead}`, `Triage: the worker for #${g.lead} was not told its base branch, ${base}:`, message(err), g, runId)
  }
}

type Message = { id: string; from_handle: string; type: string; body: string; payload: string | null }

// The Run's inbox, one blocking check at a time, while the triage runs.
function waitLater($: EngineInterface): void {
  if (isWaiting) return
  isWaiting = true
  detach(waitLoop($).catch((err: unknown) => note($, `the Orca inbox wait stopped: ${message(err)}. The next tick starts it again.`))
    .finally(() => { isWaiting = false }))
}

async function waitLoop($: EngineInterface): Promise<void> {
  for (;;) {
    const v = await read($, view)
    if (v.phase !== 'running' || !v.runId) return
    const got = (await orca(runner($, WAIT_MS + 60_000), [
      'orchestration', 'check', '--run', v.runId, '--wait', '--types', 'worker_done,escalation,question', '--timeout-ms', String(WAIT_MS),
    ])) as { deliveryId?: string | null; messages?: Message[]; timedOut?: boolean }
    for (const m of got.messages ?? []) {
      if (handled.has(m.id)) continue
      handled.add(m.id)
      await handle($, m).catch((err: unknown) => note($, `Orca message ${m.id} (${m.type} from ${m.from_handle}) not handled: ${message(err)}`))
    }
    if (got.deliveryId) await orca(runner($, 60_000), ['orchestration', 'check', '--run', v.runId, '--ack', got.deliveryId])
    // A wait that ended with no message changed nothing, so the timer's refresh is enough.
    if (got.messages?.length) await refresh($)
    await flush($)
  }
}

// A worker that cannot go on needs a decision, and the coordinator makes it or takes it to the human.
function askToDecide($: EngineInterface, what: string, head: string, body: string, g: TriageGroup | undefined, runId: string | undefined): void {
  ask($, what, [
    head, '', body, '',
    'Find the cause from the pull request and the workspace of the worker, and tell the user what it needs. Ask the user with AskUserQuestion when the decision is theirs. Do not do the work of the worker yourself.',
    ...(g?.dispatchId ? [`To answer a worker that is still open: \`orca orchestration send --to dispatch:${g.dispatchId} --run ${runId} --subject "<topic>" --body "<guidance>" --json\`.`] : []),
    ...(g?.taskId ? [`To end its group when it cannot go on: \`orca orchestration task-update --id ${g.taskId} --status failed --run ${runId} --json\`.`] : []),
  ].join('\n'))
}

async function handle($: EngineInterface, m: Message): Promise<void> {
  const payload = m.payload ? (JSON.parse(m.payload) as { taskId?: string; dispatchId?: string; outcome?: string; stopReason?: string; _orcaLifecycleRejection?: { code?: string; reason?: string } }) : {}
  if (payload._orcaLifecycleRejection) {
    await note($, `Orca rejected a ${m.type} from ${m.from_handle}: ${payload._orcaLifecycleRejection.code ?? ''} ${payload._orcaLifecycleRejection.reason ?? ''}`)
    return
  }
  let v = await read($, view)
  let g = v.groups.find(x => (payload.dispatchId && x.dispatchId === payload.dispatchId) || (payload.taskId && x.taskId === payload.taskId) || x.terminal === m.from_handle)
  // A Dispatch the triage does not hold, of a Task it knows: the coordinator may have restarted the Task by hand.
  if (g && payload.dispatchId && payload.taskId === g.taskId && g.dispatchId !== payload.dispatchId && v.runId) {
    await followRestarts($, v.runId)
    v = await read($, view)
    g = v.groups.find(x => x.lead === g!.lead)
    if (g?.dispatchId !== payload.dispatchId) {
      await note($, `#${g?.lead}: a ${m.type} from Dispatch ${payload.dispatchId}, which is not the Task's newest in Orca (${g?.dispatchId ?? 'none'}), was left out: ${firstLine(m.body)}`)
      return
    }
  }
  const who = g ? `#${g.lead} (${g.title})` : `an unknown worker (${m.from_handle})`
  if (m.type === 'question') {
    if (g) await setGroup($, g.lead, { question: { id: m.id, text: m.body } })
    await note($, `${who} asks: ${firstLine(m.body)}`)
    ask($, `the question from ${who}`, [
        `Triage: the Orca worker for ${who} asks:`, '', m.body, '',
        'Answer it from the issues, the code and what the user already decided. For a product or scope decision, ask the user first with AskUserQuestion.',
        'Then reply with:', `orca orchestration reply --id ${m.id} --run ${v.runId} --body "<answer>" --json`,
      ].join('\n'))
  } else if (m.type === 'worker_done') {
    const isDone = payload.outcome === 'succeeded'
    const reported = /\bPR #(\d+)/.exec(m.body)
    if (g) await setGroup($, g.lead, { summary: firstLine(m.body), question: undefined, ...(reported ? { pr: Number(reported[1]) } : {}), ...(isDone ? {} : { error: `the worker reported ${payload.outcome ?? 'no outcome'}: ${m.body}` }) })
    await note($, `${who}: worker done, ${payload.outcome ?? 'no outcome'}`)
    if (!isDone) askToDecide($, `the failure of ${who}`, `Triage: the Orca worker for ${who} ended with ${payload.outcome ?? 'no outcome'}:`, m.body, g, v.runId)
    // Keep the worker's terminal open for review.
    if (payload.dispatchId) {
      await orca(runner($, 60_000), ['orchestration', 'worker-retain', '--dispatch', payload.dispatchId])
        .catch((err: unknown) => note($, `${who}: worker-retain failed: ${message(err)}`))
    }
    await startReady($)
  } else if (m.type === 'escalation') {
    // Orca writes this when a turn ends with no worker_done, and the workflow ends the turn of a worker that waits for
    // its checks. The workflow wakes that worker, and its own reminders catch a worker that has stopped.
    if (payload.stopReason === 'finished') { await note($, `${who} ended a turn and its Dispatch stays open`); return }
    // Its Dispatch stays open, so this settles nothing: only worker_done or the Task's status ends a group.
    if (g) await setGroup($, g.lead, { summary: `Needs a decision: ${firstLine(m.body)}` })
    await note($, `${who} escalated: ${firstLine(m.body)}`)
    $.ui.toast(`/dev triage: ${who} escalated: ${firstLine(m.body)}`)
    askToDecide($, `the escalation from ${who}`, `Triage: the Orca worker for ${who} escalated:`, m.body, g, v.runId)
  }
}

type Worker = { dispatchId: string; taskId?: string; workerState?: string; agentTerminalHandle?: string | null; projection?: { liveness?: { verdict?: string } } }

// A coordinator restarts a failed Task by hand (orca orchestration worker-start --retry-of <old ctx>), and Orca makes a
// new Dispatch of the same Task. worker-list lists a Run's workers newest first, so the first one of a Task is its
// current Dispatch. Each group whose Task has a newer Dispatch than the one it holds takes it: its terminal, no old
// failure or summary, a fresh PR-watch prod, and its followers no longer blocked by it. Returns the leads it moved.
function restarted(groups: TriageGroup[], workers: Worker[]): { groups: TriageGroup[]; moved: { lead: number; from?: string; to: string; isFailed: boolean }[] } {
  const moved: { lead: number; from?: string; to: string; isFailed: boolean }[] = []
  let out = groups.map((g): TriageGroup => {
    const w = g.taskId ? workers.find(x => x.taskId === g.taskId) : undefined
    if (!w || w.dispatchId === g.dispatchId) return g
    const isFailed = w.workerState === 'failed'
    moved.push({ lead: g.lead, from: g.dispatchId, to: w.dispatchId, isFailed })
    return {
      ...g, dispatchId: w.dispatchId, terminal: w.agentTerminalHandle ?? undefined, prod: undefined, question: undefined, summary: undefined, blockedBy: undefined,
      error: isFailed ? `the restarted worker ${w.dispatchId} failed too; \`orca orchestration worker-show --dispatch ${w.dispatchId} --json\` shows why` : undefined,
    }
  })
  // A follower blocked by a group that runs again waits again; settle blocks it once more if another of its groups is stuck.
  const freed = new Set(moved.filter(x => !x.isFailed).map(x => x.lead))
  for (let changed = true; changed;) {
    changed = false
    out = out.map(g => {
      if (g.blockedBy === undefined || !freed.has(g.blockedBy)) return g
      freed.add(g.lead)
      changed = true
      return { ...g, blockedBy: undefined }
    })
  }
  return { groups: out, moved }
}

async function adoptRestarts($: EngineInterface, workers: Worker[]): Promise<void> {
  let moved: ReturnType<typeof restarted>['moved'] = []
  await update($, view, (x): TriageView => {
    const r = restarted(x.groups, workers)
    moved = r.moved
    if (!moved.length) return x
    // A triage that ended because this group failed runs again.
    const isRunning = x.phase === 'done' && moved.some(m => !m.isFailed)
    return { ...x, groups: r.groups, phase: isRunning ? 'running' : x.phase }
  })
  for (const m of moved) {
    await note($, `#${m.lead}: Orca holds a newer worker for its Task, ${m.to}${m.from ? ` (was ${m.from})` : ''}, so the triage follows it${m.isFailed ? '; it failed too' : ''}`)
  }
}

// One worker-list read, for a message or a prod that may concern a worker restarted by hand.
async function followRestarts($: EngineInterface, runId: string): Promise<void> {
  const listed = (await orca(runner($, 60_000), ['orchestration', 'worker-list', '--run', runId])) as { workers: Worker[] }
  await adoptRestarts($, listed.workers)
}

// Reads Orca's own state back: each Task's status, each worker's liveness, each workspace's board status and pull request.
async function refresh($: EngineInterface): Promise<void> {
  const v = await read($, view)
  if (!v.runId || !v.repo) return
  const run = runner($, 60_000)
  const [tasks, workers, worktrees] = await Promise.all([
    orca(run, ['orchestration', 'task-list', '--run', v.runId]) as Promise<{ tasks: { id: string; status: string }[] }>,
    orca(run, ['orchestration', 'worker-list', '--run', v.runId]) as Promise<{ workers: Worker[] }>,
    orcaWorktrees(run, '', v.remote?.id),
  ])
  await adoptRestarts($, workers.workers)
  const wasExited = new Set((await read($, view)).groups.filter(g => g.liveness === 'exited').map(g => g.dispatchId))
  const now = await $.clock.now()
  for (const g of v.groups) {
    if (g.task !== 'failed' && tasks.tasks.find(t => t.id === g.taskId)?.status === 'failed') {
      askToDecide($, `the failed Task of #${g.lead}`, `Triage: the Task of #${g.lead} (${g.title}) is failed in Orca.`, g.error ?? g.summary ?? 'Orca gave no reason.', g, v.runId)
    }
  }
  await update($, view, x => {
    const groups = x.groups.map(g => {
      const wt = worktrees.find(w => w.id === g.worktree) as { workspaceStatus?: string; linkedPR?: number | null } | undefined
      return {
        ...g,
        task: tasks.tasks.find(t => t.id === g.taskId)?.status ?? g.task,
        liveness: workers.workers.find(w => w.dispatchId === g.dispatchId)?.projection?.liveness?.verdict ?? g.liveness,
        workspaceStatus: wt?.workspaceStatus ?? g.workspaceStatus,
        pr: wt?.linkedPR ?? g.pr,
      }
    })
    return { ...x, groups, checkedAt: now }
  })
  // A worker that exits with no worker_done holds its batch until its Task ends, so the coordinator hears of it once.
  for (const g of (await read($, view)).groups) {
    if (!isInFlight(g) || g.liveness !== 'exited' || wasExited.has(g.dispatchId)) continue
    const pr = g.pr ? `PR #${g.pr} (${pullUrl(v.repo, g.pr)}) ${g.prClosed === g.pr ? 'is merged or closed' : 'is open'}` : 'it recorded no pull request'
    await note($, `#${g.lead}: worker ${g.dispatchId} exited without worker_done; ${pr}`)
    askToDecide($, `the exited worker of #${g.lead}`, `Triage: the worker ${g.dispatchId} of #${g.lead} (${g.title}) exited without worker_done; ${pr}. Its Task ${g.taskId} is ${g.task ?? 'in an unknown state'}, so the groups after it wait.`,
      `When its work is done: \`orca orchestration task-update --id ${g.taskId} --status completed --run ${v.runId} --json\`. The next refresh reads the Task back and starts the next groups.`, g, v.runId)
  }
  await settle($)
}

// What keeps an open pull request from merging that its worker can fix. Running checks are not a fault: they are read
// again at the next check. A review the base branch requires is the human's, so a BLOCKED state alone is not one.
function unready(r: PrRow): string[] {
  const out: string[] = []
  // A draft is still in development: the worker's own workflow brings it to ready.
  if (r.isDraft) return out
  if (r.mergeable === 'CONFLICTING' || r.mergeState === 'DIRTY') out.push('it conflicts with its base branch')
  else if (r.mergeState === 'BEHIND') out.push('it is behind its base branch')
  if (r.failing.length) out.push(`failing checks: ${r.failing.join(', ')}`)
  return out
}

// Every PR_CHECK_MS while the triage runs (its inbox wait hears the answers only then): reads the open pull request of
// each group, and prods the worker of one that is not mergeable and green. A send to a worker that has ended opens a
// follow-up turn for it in Orca, so a finished worker hears it too; but a paired server refuses mail to a finished
// worker (dispatch_inactive), so with --remote a new worker starts in the group's workspace with the prod.
async function watchPrs($: EngineInterface): Promise<void> {
  if (isWatchingPrs) return
  isWatchingPrs = true
  try {
    const v = await read($, view)
    if (v.phase !== 'running' || !v.runId || !v.repo) return
    const run = runner($, 120_000)
    let hasFollowed = false
    for (const listed of v.groups) {
      if (!listed.pr || listed.prClosed === listed.pr) continue
      let g: TriageGroup & { pr: number } = { ...listed, pr: listed.pr }
      const r = await readPullRow(run, v.repo, g.pr).catch(async (err: unknown) => { await note($, `#${g.lead}: PR #${g.pr} not read: ${message(err)}`); return undefined })
      if (!r) continue
      if (r.state !== 'OPEN') { await setGroup($, g.lead, { prClosed: g.pr }); continue }
      const problems = unready(r)
      if (!problems.length) continue
      // A worker restarted by hand since the last refresh has a new Dispatch: one worker-list read per pass finds it.
      if (!hasFollowed) {
        hasFollowed = true
        await followRestarts($, v.runId)
        // The pull request is the one this pass read.
        const fresh = (await read($, view)).groups.find(x => x.lead === g.lead)
        if (fresh) g = { ...fresh, pr: g.pr }
      }
      const key = `${r.head} ${problems.join('; ')}`
      const now = await $.clock.now()
      if (g.prod?.key === key && now - g.prod.at < PROD_AGAIN_MS) continue
      await setGroup($, g.lead, { prod: { key, at: now } })
      const url = pullUrl(v.repo, g.pr)
      if (!g.dispatchId) {
        await note($, `#${g.lead}: PR #${g.pr} cannot merge (${problems.join('; ')}), and the group has no worker to prod`)
        askToDecide($, `the stuck PR of #${g.lead}`, `Triage: PR #${g.pr} (${url}) of #${g.lead} (${g.title}) cannot merge, and no Orca worker holds it:`, problems.join('\n'), g, v.runId)
        continue
      }
      const body = [
        `PR #${g.pr} (${url}) is not mergeable and green at ${r.head}: ${problems.join('; ')}.`,
        'Fix it now: merge the base branch and resolve the conflicts, fix the cause of each failing check (never weaken or skip a check), and push the fix through the workflow (mcp__ndev__checkpoint, or by hand when you have no ndev tools). Then wait for the checks.',
        'If you cannot fix it, send an escalation that says why and what you need.',
      ].join('\n')
      const sent = await orca(runner($, 60_000), ['orchestration', 'send', '--to', `dispatch:${g.dispatchId}`, '--run', v.runId, '--subject', `PR #${g.pr} is not mergeable and green`, '--body', body])
        .then(() => note($, `#${g.lead}: PR #${g.pr} cannot merge (${problems.join('; ')}); prodded its worker`).then(() => true))
        .catch(async (err: unknown) => {
          if (v.remote && g.worktree && /dispatch_inactive/.test(message(err))) return false
          await note($, `#${g.lead}: PR #${g.pr} cannot merge, and the prod to its worker failed: ${message(err)}`)
          return true
        })
      if (!sent) await reprod($, v, g, body)
    }
  } finally {
    isWatchingPrs = false
  }
}

// A finished worker on a paired server takes no mail, and its completed Task cannot start again: a new worker, with a
// new Task that holds the group's brief and the prod, starts in the group's workspace on that server, and the group
// follows it.
async function reprod($: EngineInterface, v: TriageView, g: TriageGroup & { pr: number }, body: string): Promise<void> {
  const remote = v.remote!
  const brief = `${spec(v.repo!, g, v.issues, agentOf(v), $.plugin.root)}\n\n## Why you start now\n\nThe worker before you finished this Task. ${body}`
  const args = ['orchestration', 'worker-start', '--spec', brief, '--task-title', `${g.title}: PR #${g.pr}`, '--run', v.runId!, '--on', remote.id,
    '--worktree', `id:${g.worktree}`, '--agent', agentOf(v), '--model', g.model, '--effort', g.effort, '--timeout-ms', '120000']
  try {
    const r = (await orca(runner($, 180_000), args)) as StartReceipt & { taskId?: string }
    if (r.state !== 'ready' || !r.dispatchId || !r.taskId) throw new Error(`the new worker did not start: ${r.lastError ?? r.state} at ${r.failedStage ?? 'an unknown stage'}\n${r.recovery ?? 'Orca gave no recovery.'}`)
    const terminal = r.effects?.find(x => x.kind === 'terminal' && x.role === 'agent')?.id
    await setGroup($, g.lead, { taskId: r.taskId, task: 'dispatched', dispatchId: r.dispatchId, terminal })
    await note($, `#${g.lead}: its worker ${g.dispatchId} had finished on ${remote.name}, so worker ${r.dispatchId} started there to fix PR #${g.pr}`)
  } catch (err) {
    await note($, `#${g.lead}: PR #${g.pr} cannot merge, its worker ${g.dispatchId} had finished on ${remote.name}, and a new worker did not start: ${message(err)}`)
    askToDecide($, `the stuck PR of #${g.lead}`, `Triage: PR #${g.pr} (${pullUrl(v.repo!, g.pr)}) of #${g.lead} (${g.title}) cannot merge. Its worker finished on ${remote.name}, which takes no mail for it, and a new worker did not start:`,
      `${message(err)}\nRepair: \`orca orchestration worker-start --spec "<the fix>" --run ${v.runId} --on ${remote.id} --worktree id:${g.worktree} --agent ${agentOf(v)} --json\``, g, v.runId)
  }
}

async function prTick($: EngineInterface): Promise<void> {
  await watchPrs($).catch((err: unknown) => note($, `the pull request check stopped: ${message(err)}`))
  await flush($)
}

async function tick($: EngineInterface): Promise<void> {
  const v = await read($, view)
  // A triage that ended still reads Orca back, because a Task restarted by hand makes it run again.
  if (v.phase !== 'running' && !(v.phase === 'done' && v.runId)) return
  await refresh($).catch((err: unknown) => update($, view, v => ({ ...v, error: `Orca not read: ${message(err)}` })))
  await startReady($)
  await flush($)
  waitLater($)
}

function openPane($: EngineInterface): Promise<unknown> {
  return $.ui.open({ id: PANE, title: TITLE })
}

// Moves the pane's Orca window to the worker's terminal.
async function jump($: EngineInterface, g: TriageGroup): Promise<void> {
  if (!g.dispatchId) { $.ui.toast(`#${g.lead} has no worker yet.`); return }
  const shown = (await orca(runner($, 60_000), ['orchestration', 'worker-show', '--dispatch', g.dispatchId])) as
    { worker?: { agentTerminalHandle?: string | null }; terminal?: { handle?: string | null } }
  const handle = shown.worker?.agentTerminalHandle ?? shown.terminal?.handle ?? g.terminal
  if (!handle) { $.ui.toast(`#${g.lead}: the worker ${g.dispatchId} has no terminal (a chat worker); open its workspace for #${g.lead} in Orca.`); return }
  // A terminal handle belongs to the server that issued it: a remote worker's is stale without its server.
  const remote = (await read($, view)).remote
  await orca(runner($, 60_000), ['terminal', 'switch', '--terminal', handle, ...(remote ? ['--environment', remote.id] : [])])
}

// A function declaration, not an arrow: /dev triage reaches triageCommand from register.ts, and the engine follows $
// across an import only into a function declaration.
function fail($: EngineInterface, what: string) {
  return async (err: unknown) => {
    await update($, view, v => ({ ...v, error: `/dev triage ${what} failed: ${message(err)}` }))
    await tell($, `/dev triage ${what} failed: ${message(err)}`)
  }
}

export async function startTriage($: EngineInterface) {
  await $.tool.register({
    name: 'triage_groups',
    description:
      'Report the /dev triage groups: each open issue in exactly one group, with its complexity, a hint for the worker and, ' +
      'when needed, the leads of the groups it must follow. The mod then starts one Orca worker per group.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issues: { type: 'array', items: { type: 'number' } },
              title: { type: 'string' },
              complexity: { type: 'string', enum: Object.keys(SIZES) },
              hint: { type: 'string' },
              implemented: { type: 'boolean' },
              evidence: { type: 'string' },
              after: { type: 'array', items: { type: 'number' }, description: 'Leads (lowest issue numbers) of the groups that must finish first' },
            },
            required: ['issues', 'title', 'complexity', 'hint'],
          },
        },
        closed: { type: 'array', items: { type: 'number' }, description: 'Issues closed after the human confirmed, as done by a merged pull request or on the human\'s --hint; they are in no group' },
        unfinished: {
          type: 'array',
          description: 'Each issue whose open pull request is the unfinished work; the mod hands the pull request to the /fix-prs loop, and the issue is in no group',
          items: { type: 'object', properties: { issue: { type: 'number' }, pr: { type: 'number' } }, required: ['issue', 'pr'] },
        },
        skipped: {
          type: 'array',
          description: 'Each issue the human asked to leave out, in --hint or in the conversation, with the reason; it stays open and is in no group. Never an issue the human did not name',
          items: { type: 'object', properties: { issue: { type: 'number' }, reason: { type: 'string' } }, required: ['issue', 'reason'] },
        },
        screened: {
          type: 'array',
          description: 'Only with /dev triage start --bugs-only: each issue that is not a bug, with its kind; they are in no group',
          items: {
            type: 'object',
            properties: { issue: { type: 'number' }, kind: { type: 'string', enum: Object.keys(SCREEN_KINDS) }, reason: { type: 'string' } },
            required: ['issue', 'kind', 'reason'],
          },
        },
      },
      required: ['groups'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'clean_verdicts',
    description:
      'Report the /dev triage clean verdicts, one chunk at a time: a verdict for each issue of the chunk, with evidence for each close. ' +
      'Once every issue has one, call it again with the issues closed and the closes that failed, for the end report.',
    inputSchema: {
      type: 'object',
      properties: {
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issue: { type: 'number' },
              verdict: { type: 'string', enum: [...VERDICTS] },
              confidence: { type: 'string', enum: [...CONFIDENCES] },
              evidence: { type: 'string', description: 'For every verdict but needs_work: a PR or issue number (#n), a commit sha or a file:line' },
              by: { type: 'number', description: 'superseded or duplicate: the issue or pull request that covers it' },
            },
            required: ['issue', 'verdict', 'confidence', 'evidence'],
          },
        },
        closed: { type: 'array', items: { type: 'number' }, description: 'After every verdict: the issues closed on the user\'s pick' },
        failed: {
          type: 'array',
          description: 'After every verdict: each close that failed, with its error',
          items: { type: 'object', properties: { issue: { type: 'number' }, error: { type: 'string' } }, required: ['issue', 'error'] },
        },
      },
    },
    isDeferred: false,
  })
  $.clock.every(TICK_MS, () => { detach(tick($)) })
  $.clock.every(PR_CHECK_MS, () => { detach(prTick($)) })
}

// /dev triage <args> (register.ts dispatches it). Answers at once: the work runs detached, since gh and Orca can outlast the hook's budget.
const START_OPTIONS = ['--dry-run', '--codex', '--open', '--batch', '--sequential', '--since', '--reverse', '--bugs-only', '--mine', '--remote', '--hint'] as const
const CLEAN_OPTIONS = ['--since', '--reverse', '--mine', '--hint'] as const
// Workers at once when start names no size: enough to make progress, few enough for one machine.
const DEFAULT_BATCH = 5
// What each option does, and the value it takes. The refusal, /dev help and the /dev argument hint are all built from
// this, so a new option shows in each of them or fails to compile.
const OPTIONS: Record<(typeof START_OPTIONS)[number], { value?: string; text: string }> = {
  '--dry-run': { text: 'plans and starts nothing' },
  '--codex': { text: 'runs the fixes in Codex workers' },
  '--open': { text: 'takes every open issue and not only the board\'s' },
  '--batch': { value: '<size>', text: `runs that many workers at once, batch after batch (${DEFAULT_BATCH} by default)` },
  '--sequential': { text: 'is --batch 1' },
  '--since': { value: '<n>', text: 'takes only the issues above #n' },
  '--reverse': { text: 'works the newest issues first' },
  '--bugs-only': { text: 'groups only the bugs and labels each issue by its kind' },
  '--mine': { text: 'takes only the issues you opened' },
  '--remote': { value: '[<server>]', text: 'makes each workspace and runs each worker on a saved Orca server: the one named, else the one /dev remote set, else the only one' },
  '--hint': { value: '"<text>"', text: 'gives the model your own steer' },
}
const named = (o: keyof typeof OPTIONS) => (OPTIONS[o].value ? `${o} ${OPTIONS[o].value}` : o)
const usage = (options: readonly (keyof typeof OPTIONS)[]) => options.map(o => `[${named(o)}]`).join(' ')
const OPTION_TEXT = START_OPTIONS.map(o => `${named(o)} ${OPTIONS[o].text}`).join(', ')
const VERBS = `start ${usage(START_OPTIONS)}, clean ${usage(CLEAN_OPTIONS)}, launch, refresh or reset`
// The triage part of the /dev argument hint and of /dev help.
export const TRIAGE_ARGUMENT_HINT = `triage [start ${usage(START_OPTIONS)}|clean ${usage(CLEAN_OPTIONS)}|launch|refresh|reset]`
export const TRIAGE_HELP = [
  '  /dev triage start [options]         group the open issues and coordinate an Orca worker on each group (Triage pane)',
  '  /dev triage clean [options]         close the open issues that are done, outdated or superseded, after you confirm each',
  `    start: ${usage(START_OPTIONS)}`,
  `    clean: ${usage(CLEAN_OPTIONS)}`,
  `    ${OPTION_TEXT}`,
  '  /dev triage [launch|refresh|reset]  launch a dry run, read the triage back from Orca, or clear it; with no word, show its state',
]
// The options that take the next word as their value; --remote takes it only when it is not an option.
const VALUED = ['--batch', '--since', '--remote']
const SINCE_USAGE = '--since <n> takes an issue number above 0: only the issues with a higher number, as in --since 120.'

// The value of --since <n>; 0 when it is not given. A bad number returns the refusal.
function sinceOption(verb: string, words: string[]): number | string {
  const at = words.indexOf('--since')
  if (at < 0) return 0
  const raw = words[at + 1]
  if (!raw || !/^[1-9]\d*$/.test(raw)) return `/dev triage ${verb} --since ${raw ?? ''}`.trimEnd() + ` is not an issue number. ${SINCE_USAGE}`
  return Number(raw)
}
const HINT_USAGE = '--hint takes a text for the model, in quotes when it holds a word that starts with --, as in --hint "close outdated issues".'

// Takes --hint <text> out of the arguments: the text in quotes, or the words up to the next option. A --hint with no
// text returns the refusal.
function hintOption(args: string): { rest: string; hint: string } | string {
  const m = /(^|\s)--hint(?:\s+(?:"([^"]*)"|'([^']*)'|((?:(?!\s--)[^])*)))?/.exec(args)
  if (!m) return { rest: args, hint: '' }
  const hint = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  if (!hint) return `/dev triage --hint has no text. ${HINT_USAGE}`
  return { rest: `${args.slice(0, m.index)} ${args.slice(m.index + m[0].length)}`, hint }
}
const BATCH_USAGE = `--batch <size> takes a whole number above 0: how many workers run at once, each batch after the last has ended (${DEFAULT_BATCH} when not given). --sequential is --batch 1.`

// The value of --batch <size>, with --sequential as 1; DEFAULT_BATCH when neither is given. A bad size returns the refusal.
function batchOption(words: string[]): number | string {
  const at = words.indexOf('--batch')
  const isSequential = words.includes('--sequential')
  if (at < 0) return isSequential ? 1 : DEFAULT_BATCH
  const raw = words[at + 1]
  if (!raw || !/^[1-9]\d*$/.test(raw)) return `/dev triage start --batch ${raw ?? ''}`.trimEnd() + ` is not a size. ${BATCH_USAGE}`
  const size = Number(raw)
  if (isSequential && size !== 1) return `/dev triage start --sequential --batch ${size} asks for two sizes. ${BATCH_USAGE}`
  return size
}

export async function triageCommand($: EngineInterface, args: string, project: () => LoadedConfig | undefined): Promise<{ text: string }> {
  const hinted = hintOption(args)
  if (typeof hinted === 'string') return { text: hinted }
  const { hint } = hinted
  const words = hinted.rest.trim().split(/\s+/).filter(Boolean)
  const [named] = words.filter((w, i) => !w.startsWith('--') && !(i > 0 && VALUED.includes(words[i - 1]!)))
  const verb = named ?? 'status'
  const options = [...words, ...(hint ? ['--hint'] : [])].filter(w => w.startsWith('--'))
  // Options with no verb, such as /dev triage --batch 2: start nothing, and name the start command they belong to.
  if (!named && options.length && options.every(w => (START_OPTIONS as readonly string[]).includes(w))) {
    return { text: `/dev triage ${args.trim()} names no verb, so nothing started. Did you mean /dev triage start ${args.trim()}? /dev help lists every option.` }
  }
  const allowed: readonly string[] = verb === 'start' ? START_OPTIONS : verb === 'clean' ? CLEAN_OPTIONS : []
  const unknown = options.find(w => !allowed.includes(w))
  if (unknown) return { text: `/dev triage ${verb} does not know "${unknown}". Use /dev triage ${VERBS}: ${OPTION_TEXT}.` }
  const since = sinceOption(verb, words)
  if (typeof since === 'string') return { text: since }
  const isReverse = words.includes('--reverse')
  const isMine = words.includes('--mine')
  if (verb === 'clean') {
    detach(clean($, project(), { hint, since, isReverse, isMine }).then(text => tell($, text), fail($, 'clean')))
    return { text: 'Clean started: reading the open issues. The model checks each one and asks you before it closes any.' }
  }
  detach(openPane($))
  if (verb === 'start') {
    const batch = batchOption(words)
    if (typeof batch === 'string') return { text: batch }
    const at = words.indexOf('--remote')
    const remote = at < 0 ? undefined : words[at + 1] && !words[at + 1]!.startsWith('--') ? words[at + 1]! : ''
    if (remote !== undefined && words.includes('--codex')) {
      return { text: `/dev triage start --remote does not work with --codex: a Codex worker's Task names the workflow file in this machine's copy of the plugin, which the server does not have. Use --remote with Claude workers, or --codex without --remote.` }
    }
    detach(collect($, project(), { isDryRun: words.includes('--dry-run'), agent: words.includes('--codex') ? 'codex' : 'claude', isOpen: words.includes('--open'), batch, hint, since, isReverse, isBugsOnly: words.includes('--bugs-only'), isMine, remote })
      .then(text => tell($, text), fail($, 'start')))
    return { text: `Triage started: reading the issues. ${(await isOrcaChat($)) ? 'Progress comes here in the chat, and /dev triage status shows every group.' : 'The Triage pane shows progress.'}` }
  }
  if (verb === 'launch') { detach(launch($).catch(fail($, 'launch'))); return { text: 'Launching the planned groups in Orca.' } }
  if (verb === 'refresh') { detach(tick($).catch(fail($, 'refresh'))); return { text: 'Reading the triage back from Orca.' } }
  if (verb === 'reset') {
    const v = await read($, view)
    await update($, view, () => EMPTY)
    return { text: v.runId ? `Triage cleared. Orca Run ${v.runId} and its workspaces stay in Orca.` : 'Triage cleared.' }
  }
  if (verb !== 'status') return { text: `/dev triage does not know "${verb}". Use /dev triage ${VERBS}.` }
  return { text: statusText(await read($, view)) }
}

export const triage = (on: On, project: () => LoadedConfig | undefined) => {
  // The engine passes the tool's arguments on the event itself, beside `tool`.
  on('tool.call', { tool: CLEAN_TOOL }, async (_$, e) => cleanVerdicts(e as unknown as { verdicts?: unknown; closed?: unknown; failed?: unknown }))
  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The engine passes the tool's arguments on the event itself, beside `tool`.
    const input = e as unknown as { groups?: Proposed[]; closed?: unknown; screened?: unknown; skipped?: unknown; unfinished?: unknown }
    const v = await read($, view)
    if (v.phase !== 'grouping') return { result: `Refused: /dev triage is not waiting for groups (it is ${v.phase}). /dev triage start begins one.`, isError: true as const }
    const groups = Array.isArray(input.groups) ? input.groups : []
    // The issues the coordinator closed on the human's hint, with the human's yes: they are in no group.
    const closed = Array.isArray(input.closed) ? input.closed : []
    const known = new Set(v.issues.map(i => i.number))
    const badClosed = closed.filter(n => !Number.isInteger(n) || !known.has(n as number)).map(n => `closed names ${JSON.stringify(n)}, which is not one of the issues to group`)
    // With --bugs-only, the issues that are not bugs, by kind: they are in no group.
    const items = Array.isArray(input.screened) ? (input.screened as unknown[]) : []
    const notObjects = items.flatMap((x, i) => (x !== null && typeof x === 'object' ? [] : [`screened item ${i + 1} is not an object; give { issue, kind, reason }`]))
    const screened = items.filter((x): x is { issue?: unknown; kind?: unknown; reason?: unknown } => x !== null && typeof x === 'object')
    const named = screened.map(x => x.issue)
    const twice = [...new Set(named.filter((n, i) => named.indexOf(n) !== i))].map(n => `screened names #${String(n)} twice; give each issue one kind`)
    const inGroups = new Set(groups.flatMap(g => (Array.isArray(g.issues) ? g.issues : [])))
    const badScreened = input.screened !== undefined && !v.isBugsOnly
      ? ['screened needs /dev triage start --bugs-only; put every issue in a group']
      : [...notObjects, ...twice, ...screened.flatMap(x => [
        ...(!Number.isInteger(x?.issue) || !known.has(x.issue as number) ? [`screened names ${JSON.stringify(x?.issue)}, which is not one of the issues to group`] : []),
        ...(typeof x?.kind !== 'string' || !Object.hasOwn(SCREEN_KINDS, x.kind) ? [`"${String(x?.kind)}" is not a kind; use one of ${Object.keys(SCREEN_KINDS).join(', ')}`] : []),
        ...(typeof x?.reason !== 'string' || !x.reason.trim() ? [`screened #${String(x?.issue)} gives no reason`] : []),
        ...(inGroups.has(x?.issue) ? [`#${String(x?.issue)} is in a group and in screened`] : []),
        ...(closed.includes(x?.issue) ? [`#${String(x?.issue)} is in closed and in screened`] : []),
      ])]
    // The issues the human asked to leave out, in --hint or in the conversation: they stay open and are in no group.
    const skipItems = Array.isArray(input.skipped) ? (input.skipped as unknown[]) : []
    const skipped = skipItems.filter((x): x is { issue?: unknown; reason?: unknown } => x !== null && typeof x === 'object')
    const skipNamed = skipped.map(x => x.issue)
    const screenedNamed = new Set(named)
    const badSkipped = [
        ...skipItems.flatMap((x, i) => (x !== null && typeof x === 'object' ? [] : [`skipped item ${i + 1} is not an object; give { issue, reason }`])),
        ...[...new Set(skipNamed.filter((n, i) => skipNamed.indexOf(n) !== i))].map(n => `skipped names #${String(n)} twice; give each issue once`),
        ...skipped.flatMap(x => [
          ...(!Number.isInteger(x.issue) || !known.has(x.issue as number) ? [`skipped names ${JSON.stringify(x.issue)}, which is not one of the issues to group`] : []),
          ...(typeof x.reason !== 'string' || !x.reason.trim() ? [`skipped #${String(x.issue)} gives no reason`] : []),
          ...(inGroups.has(x.issue) ? [`#${String(x.issue)} is in a group and in skipped`] : []),
          ...(closed.includes(x.issue) ? [`#${String(x.issue)} is in closed and in skipped`] : []),
          ...(screenedNamed.has(x.issue) ? [`#${String(x.issue)} is in screened and in skipped`] : []),
        ]),
    ]
    // The issues whose open pull request is the unfinished work: the /fix-prs loop takes the pull request.
    const open = Array.isArray(input.unfinished) ? (input.unfinished as unknown[]) : []
    const unfinished = open.filter((x): x is { issue?: unknown; pr?: unknown } => x !== null && typeof x === 'object')
    const screenedIssues = new Set(screened.map(x => x.issue))
    const badUnfinished = [
      ...open.flatMap((x, i) => (x !== null && typeof x === 'object' ? [] : [`unfinished item ${i + 1} is not an object; give { issue, pr }`])),
      ...unfinished.flatMap(x => [
        ...(!Number.isInteger(x.issue) || !known.has(x.issue as number) ? [`unfinished names ${JSON.stringify(x.issue)}, which is not one of the issues to group`] : []),
        ...(!Number.isInteger(x.pr) || (x.pr as number) <= 0 ? [`unfinished #${String(x.issue)} gives no pull request number`] : []),
        ...(inGroups.has(x.issue) ? [`#${String(x.issue)} is in a group and in unfinished`] : []),
        ...(closed.includes(x.issue) ? [`#${String(x.issue)} is in closed and in unfinished`] : []),
        ...(screenedIssues.has(x.issue) ? [`#${String(x.issue)} is in screened and in unfinished`] : []),
        ...(skipNamed.includes(x.issue) ? [`#${String(x.issue)} is in skipped and in unfinished`] : []),
      ]),
      ...[...new Set(unfinished.map(x => x.issue))].filter(n => unfinished.filter(x => x.issue === n).length > 1).map(n => `unfinished names #${String(n)} twice`),
    ]
    const handed = unfinished as { issue: number; pr: number }[]
    // The /fix-prs loop takes only an open pull request: a merged or closed one means that the issue is done or needs a group.
    if (!badUnfinished.length && handed.length) {
      const shut = await closedPulls(makeRun($, 60_000), [...new Set(handed.map(x => x.pr))])
      badUnfinished.push(...handed.flatMap(x => shut.filter(b => b.pr === x.pr).map(b => `unfinished #${x.issue}: ${b.problem}. Group the issue, or close it when its work is done.`)))
    }
    const out = new Set<unknown>([...closed, ...screened.map(x => x.issue), ...skipNamed, ...handed.map(x => x.issue)])
    const rest = v.issues.filter(i => !out.has(i.number))
    const early = [...badClosed, ...badScreened, ...badSkipped, ...badUnfinished]
    const wrong = [...early, ...(early.length ? [] : problems(rest, groups))]
    if (wrong.length) return { result: `Refused, nothing recorded:\n- ${wrong.join('\n- ')}\nFix these and call ${TOOL} again.`, isError: true as const }
    const kinds = screened as { issue: number; kind: string; reason: string }[]
    let labelled = ''
    const wanted: Label[] = v.isBugsOnly ? [...rest.map((i): Label => [i.number, BUG_LABEL]), ...kinds.flatMap((x): Label[] => (SCREEN_KINDS[x.kind]!.label ? [[x.issue, SCREEN_KINDS[x.kind]!.label!]] : []))] : []
    if (v.isBugsOnly) {
      // A refused call can leave labels on GitHub. The mod does not remove a label, because a human can own it too,
      // so a retry must keep the kind of each issue that it labelled.
      const want = new Set(wanted.map(([n, l]) => `${n} ${l}`))
      const changed = (v.labelled ?? []).filter(([n, l]) => !want.has(`${n} ${l}`))
        .map(([n, l]) => `#${n} has the label ${l} from an earlier call, and this call gives it another kind. Keep its kind, or remove the label first: gh issue edit ${n} --repo ${v.repo} --remove-label ${l}`)
      if (changed.length) return { result: `Refused, nothing recorded:\n- ${changed.join('\n- ')}\nThen call ${TOOL} again.`, isError: true as const }
      if (v.isDryRun) labelled = ' This is a dry run: no label written. /dev triage launch writes the labels.'
      else {
        // Adding a label that an issue has is no change, so the next call labels again after a refusal.
        const failed = await writeLabels($, v.repo ?? '', wanted)
        if (failed.length) return { result: `Refused, nothing recorded: ${failed.length} of ${wanted.length} labels failed.\n- ${failed.join('\n- ')}\n${labelRepair(v.repo ?? '', wanted)}, then call ${TOOL} again.`, isError: true as const }
        labelled = ` Labelled ${wanted.map(([n, l]) => `#${n} ${l}`).join(', ')}.`
      }
      if (kinds.length) await note($, `the model screened out ${kinds.map(x => `#${x.issue} (${x.kind})`).join(' ')}`)
    }
    const skips = skipped as { issue: number; reason: string }[]
    const asked = v.hint ? 'on the hint' : 'as the human asked'
    const skippedText = skips.length ? ` It skipped ${skips.length} issues ${asked}: ${skips.map(x => `#${x.issue}`).join(', ')}; they stay open with no worker.` : ''
    const screenedText = (kinds.length ? ` It screened out ${kinds.length} issues that are not bugs: ${kinds.map(x => `#${x.issue} ${x.kind}`).join(', ')}.${labelled}` : labelled) + skippedText
    if (closed.length) await note($, `the model closed ${closed.map(n => `#${String(n)}`).join(' ')}`)
    // One line on the pane for each reason, so the human sees why each issue was left out.
    const reasons = new Map<string, number[]>()
    for (const x of skips) reasons.set(x.reason.trim(), [...(reasons.get(x.reason.trim()) ?? []), x.issue])
    for (const [reason, ns] of reasons) await note($, `skipped ${ns.map(n => `#${n}`).join(' ')} ${asked}: ${reason}`)
    const prs = [...new Set(handed.map(x => x.pr))]
    const prText = prs.map(n => `PR #${n}`).join(', ')
    let handText = !prs.length ? '' : ` /dev triage launch hands ${prText} to the /fix-prs loop.`
    if (prs.length && !v.isDryRun) {
      const said = await startFixPrs($, false, prs)
      await note($, `handed ${prText} to the /fix-prs loop`)
      handText = ` The /fix-prs loop has ${prText}: ${said} The PR queue pane shows it.`
    }
    if (!groups.length) {
      // A dry run keeps what its launch must still do: the labels, and the pull requests for the /fix-prs loop.
      const kept = v.isDryRun && (prs.length || wanted.length)
      await update($, view, () => (kept ? { ...EMPTY, repo: v.repo, phase: 'planned', isDryRun: true,
        labels: wanted.length ? wanted : undefined, unfinished: prs.length ? handed.map((x): [number, number] => [x.issue, x.pr]) : undefined } : EMPTY))
      return { result: `Recorded: no issue is left in a group, so there is nothing to start.${screenedText}${handText} Report the closed, screened, skipped and unfinished issues to the user.` }
    }
    const planned = groups.map(g => toGroup(g, agentOf(v)))
    await update($, view, (x): TriageView => ({ ...x, phase: 'planned', issues: rest, groups: planned, labels: v.isDryRun && wanted.length ? wanted : undefined,
      unfinished: v.isDryRun && handed.length ? handed.map((x): [number, number] => [x.issue, x.pr]) : undefined }))
    await note($, `the model made ${planned.length} groups`)
    if (v.isDryRun) return { result: `Recorded ${planned.length} groups as a dry run: nothing started in Orca. /dev triage launch starts them.${screenedText}${handText}` }
    detach(launch($).catch(fail($, 'launch')))
    return { result: `Recorded ${planned.length} groups.${screenedText}${handText} The mod creates the Orca Run and starts the workers; the Triage pane shows them. You are the coordinator now: start no work on these issues, and wait for what the mod sends you.` }
  })

  // The model's reply to a worker's question closes the question on the pane.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    const id = /orca orchestration reply\b.*?--id[ =](\S+)/.exec(String((e as { command?: unknown }).command ?? ''))?.[1]
    const g = id ? (await read($, view)).groups.find(x => x.question?.id === id) : undefined
    if (!g) return result
    const out = result.text ?? JSON.stringify(result.result ?? '')
    if (result.deny !== undefined || result.isError || /"ok"\s*:\s*false/.test(out)) {
      await note($, `#${g.lead}: the reply to ${id} failed, so the question stays open: ${firstLine(out)}`)
    } else {
      await setGroup($, g.lead, { question: undefined })
      await note($, `#${g.lead}: question answered`)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const v = await read($, view)
    const columns = e.props.bodyColumns
    const width = Math.max(20, columns - 4 - 2 - 9 - 6 - 22)
    const fit = (s: string, w = width) => (s.length > w ? `${s.slice(0, w - 1)}…` : s)
    const pad = '             '
    const under = Math.max(20, columns - 4 - pad.length - 1)
    const done = v.groups.filter(g => g.task === 'completed').length
    const workers = v.repo ? ` · ${AGENT_NAME[agentOf(v)]} workers${v.remote ? ` on ${v.remote.name}` : ''}${v.isOpen ? ' · every open issue' : ''}${v.since ? ` · above #${v.since}` : ''}${v.isReverse ? ' · newest first' : ''}${v.isBugsOnly ? ' · bugs only' : ''}${v.isMine ? ' · opened by me' : ''}${batchOf(v) === 1 ? ' · one at a time' : batchOf(v) > 1 ? ` · batches of ${batchOf(v)}` : ''}` : ''
    const phase = v.phase === 'grouping' ? `the model is grouping ${v.issues.length} issues`
      : v.phase === 'planned' ? `${v.groups.length} groups planned, nothing started${v.isDryRun ? ' (dry run)' : ''}`
        : v.phase === 'running' ? `Orca Run ${v.runId ?? 'not made yet'}` : v.phase === 'done' ? (v.runId ? `done · Orca Run ${v.runId}` : 'stopped: no Orca Run was made') : 'not started'
    const url = (n: number) => v.issues.find(i => i.number === n)?.url ?? `https://github.com/${v.repo}/issues/${n}`
    const titled = (n: number) => v.issues.find(i => i.number === n)?.title ?? ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Box justifyContent="space-between">
            <Text weight="bold" color="claude">{v.repo ?? 'No triage yet'}</Text>
            <Text color="subtle">
              {v.groups.length ? `${done} of ${v.groups.length} done` : ''}
              {v.checkedAt ? ` · ${new Date(v.checkedAt).toLocaleTimeString()}` : ''}
            </Text>
          </Box>
          <Text color="subtle">{fit(`${phase}${workers}`, columns - 4)}</Text>
        </Box>
        <Box gap={2}>
          {v.phase !== 'running' && v.phase !== 'grouping' &&
            <Button key="start" label="Start" hotkey="s" plain onPress={() => { detach(collect($, project(), { isDryRun: false, agent: agentOf(v), isOpen: !!v.isOpen, batch: batchOf(v), hint: v.hint ?? '', since: v.since ?? 0, isReverse: !!v.isReverse, isBugsOnly: !!v.isBugsOnly, isMine: !!v.isMine, remote: v.remote?.id }).then(t => tell($, t), fail($, 'start'))) }} />}
          {v.phase === 'planned' && <Button key="launch" label="Launch" hotkey="l" plain onPress={() => { detach(launch($).catch(fail($, 'launch'))) }} />}
          {v.runId && <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => { detach(tick($).catch(fail($, 'refresh'))) }} />}
        </Box>
        {v.error && v.error.split('\n').map((line, i) => <Text key={`error-${i}`} color="error">{line}</Text>)}
        {v.phase === 'idle' && !v.error && <Text color="subtle">Start reads the open issues, has this session group them, and works each group in its own Orca workspace.</Text>}
        <Box flexDirection="column">
          {v.groups.map(g => {
            const m = stateOf(g)
            const facts = [g.effective ?? `${g.model} · ${g.effort}`, g.workspaceStatus].filter(Boolean).join(' · ')
            const after = g.liveness ? ` · ${g.liveness}` : ''
            return (
              // Each group is a box that lists its issues, so the grouping reads at a glance.
              <Box key={`group-${g.lead}`} flexDirection="column" borderStyle="round" borderColor={m.color} paddingX={1}>
                <Box justifyContent="space-between">
                  <Text>
                    <Text color={m.color}>{m.word.padEnd(9)}</Text>
                    <Link href={url(g.lead)} label={`#${g.lead}`} />
                    <Text> {fit(g.title)}</Text>
                  </Text>
                  <Box gap={2}>
                    {g.dispatchId && <Button key={`jump-${g.lead}`} label="Jump" plain onPress={() => { detach(jump($, g).catch(fail($, 'jump'))) }} />}
                    {g.pr && <Button key={`pr-${g.lead}`} label="PR" plain dimColor
                      onPress={() => { void $.process.run(['gh', 'pr', 'view', String(g.pr), '--repo', v.repo!, '--web']) }} />}
                    <Button key={`issue-${g.lead}`} label="Issue" plain dimColor onPress={() => { void $.process.run(['open', url(g.lead)]) }} />
                  </Box>
                </Box>
                <Text color="subtle">{pad}{fit(facts, under)}{g.pr && v.repo ? ' · PR ' : g.pr ? ` · PR #${g.pr}` : ''}{g.pr && v.repo && <Link href={pullUrl(v.repo, g.pr)} label={`#${g.pr}`} />}{after}</Text>
                {g.issues.map(n => (
                  <Text key={`member-${g.lead}-${n}`}>{pad}<Link href={url(n)} label={`#${n}`} /> {fit(titled(n), under - String(n).length - 2)}</Text>
                ))}
                {g.question && <Text color="warning">{pad}{fit(`asks: ${g.question.text}`, under)}</Text>}
                {g.summary && <Text color="subtle">{pad}{fit(g.summary, under)}</Text>}
                {g.blockedBy !== undefined && <Text color="warning">{pad}waits for <Link href={url(g.blockedBy)} label={`#${g.blockedBy}`} />, which failed</Text>}
                {g.error && g.error.split('\n').map((line, i) => <Text key={`gerr-${g.lead}-${i}`} color="error">{pad}{line}</Text>)}
              </Box>
            )
          })}
        </Box>
        {v.log.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text weight="bold" color="claude">Activity</Text>
            {v.log.slice(-8).map((entry, i) => (
              <Text key={`log-${i}`}>
                <Text color="subtle">{new Date(entry.at).toLocaleTimeString()} </Text>{fit(entry.text, columns - 16)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
