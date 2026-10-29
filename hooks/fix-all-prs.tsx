import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, TurnCompleteInput } from 'claude-code'

import type { Comm, Loop, Outcome, PrRow, Quota, Snapshot } from '../types'

const PANE = 'fix-all-prs'
const TITLE = 'PR queue'
const TICK_MS = 60_000
// Fix rounds on one pull request before the loop records it as blocked.
const MAX_ROUNDS = 3
// How long an owning agent has to answer before this session's model takes the pull request.
const ASK_WAIT_MS = 30 * 60_000
const REPORT_TOOL = 'mcp__ndev__report'
// After a GitHub error the loop waits 1, 2, 4… minutes before the next try, never longer than this.
const MAX_BACKOFF_MS = 30 * 60_000
// Refused merges of one pull request before the loop records it as blocked.
const MAX_MERGE_FAILURES = 3
// gh failures that need the person (sign in, the wrong folder): the loop still retries, and says so with a toast.
const NEEDS_PERSON = /not a git repository|authentication|HTTP 401|HTTP 403|Could not resolve to a Repository|no git remotes/i
// gh's refusal once the API quota is used up; `gh api rate_limit` then says when it is back.
const RATE_LIMIT = /rate limit/i
// The annotation of a check that could not upload because the Actions storage quota is used up.
const STORAGE_QUOTA = /storage quota has been hit/i
// GitHub recounts Actions storage every 6 to 12 hours, so the loop tries again after the shorter.
const STORAGE_WAIT_MS = 6 * 60 * 60_000
// How long a rerun has to show as running before the loop judges its checks afresh.
const RERUN_GRACE_MS = 5 * 60_000

const snapshot = atom(
  { plugin: 'ndev', key: 'snapshot' } as const,
  { queue: [], rows: [], checkedAt: 0 } as Snapshot,
  { shape: 'snapshot-3' },
)

// What passed between this session and each pull request's owning agent, by pull request number.
const comms = atom({ plugin: 'ndev', key: 'comms' } as const, {} as Record<string, Comm>, { shape: 'comms-1' })

// The loop: which pull request it is on, who is fixing it, and what became of the others.
const loop = atom(
  { plugin: 'ndev', key: 'loop' } as const,
  { phase: 'idle', attempts: 0, outcomes: {}, log: [] } as Loop,
  { shape: 'loop-1' },
)

// When this session last worked: a turn ended or a message arrived. In an owning session, the loop's
// message compacts the conversation first past STALE_MS, since the prompt cache has gone cold by then.
const activity = atom({ plugin: 'ndev', key: 'activity' } as const, {} as { at?: number }, { shape: 'activity-1' })
const STALE_MS = 50 * 60_000

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number
  title: string
  headRefName: string
  state: PrRow['state']
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  mergeCommit: { oid: string } | null
  headRefOid: string
  createdAt: string
  statusCheckRollup: Check[] | null
}

const FIELDS = 'number,title,headRefName,headRefOid,state,isDraft,mergeable,mergeStateStatus,mergeCommit,createdAt,statusCheckRollup'
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

function toRow(pr: GhPr): PrRow {
  const checks = pr.statusCheckRollup ?? []
  // A check run reports status + conclusion; a commit status reports state alone.
  const result = (c: Check) => c.conclusion || c.state || ''
  const done = (c: Check) => (c.status ? c.status === 'COMPLETED' : c.state !== 'PENDING' && c.state !== 'EXPECTED')
  return {
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    mergeCommit: pr.mergeCommit?.oid,
    head: pr.headRefOid,
    failing: checks.filter(c => done(c) && FAILED.has(result(c))).map(c => c.name || c.context || '?'),
    pending: checks.filter(c => !done(c)).length,
  }
}

export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function gh(run: Run, args: string[], isJson = true): Promise<unknown> {
  const out = await run(['gh', ...args])
  if (out.exitCode !== 0) {
    const detail = out.stderr.trim() || out.stdout.trim()
    throw new Error(
      `gh ${args.slice(0, 3).join(' ')} exited ${out.exitCode}: ${detail}\n` +
        'Repair: run Claude Code inside a clone of a GitHub repository, and `gh auth login` if gh is not signed in.',
    )
  }
  return isJson ? JSON.parse(out.stdout) : out.stdout.trim()
}

// When a used-up API quota is back, from GitHub's own reset times; none when no quota is at zero
// (a secondary rate limit, which states no time).
async function apiQuotaBack(run: Run): Promise<{ at: number; which: string } | undefined> {
  type Limits = { resources: Record<string, { remaining: number; reset: number }> }
  const { resources } = (await gh(run, ['api', 'rate_limit'])) as Limits
  const out = Object.entries(resources).filter(([, r]) => r.remaining === 0)
  if (!out.length) return undefined
  return { at: Math.max(...out.map(([, r]) => r.reset)) * 1000, which: out.map(([name]) => name).join(', ') }
}

// The workflow runs whose failed checks at `head` could not upload for the Actions storage quota,
// with GitHub's message; none when no failed check says so.
async function storageQuotaHit(run: Run, repo: string, head: string): Promise<{ runs: number[]; message: string } | undefined> {
  const failed = String(await gh(run, [
    'api', `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=latest`,
    '--jq', '.check_runs[] | select(.conclusion == "failure") | "\\(.id) \\(.details_url)"',
  ], false))
  const runs = new Set<number>()
  let message = ''
  for (const line of failed.split('\n').filter(Boolean)) {
    const [id, url = ''] = line.split(' ')
    const runId = /actions\/runs\/(\d+)/.exec(url)?.[1]
    if (!runId) continue // a check from another app: GitHub cannot rerun it
    const notes = String(await gh(run, ['api', `repos/${repo}/check-runs/${id}/annotations`, '--jq', '.[].message'], false))
    const hit = notes.split('\n').find(m => STORAGE_QUOTA.test(m))
    if (hit) {
      runs.add(Number(runId))
      message ||= hit
    }
  }
  return runs.size ? { runs: [...runs], message } : undefined
}

// Lists the open pull requests by the signed-in user, oldest first.
async function openQueue(run: Run): Promise<PrRow[]> {
  const prs = (await gh(run, ['pr', 'list', '--state', 'open', '--author', '@me', '--limit', '100', '--json', FIELDS])) as GhPr[]
  return prs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toRow)
}

// Reads the queued pull requests again in one call, so merged and closed ones stay in the pane,
// and adds those opened since, oldest first after the queue.
async function refreshQueue(run: Run, queue: number[]): Promise<PrRow[]> {
  const all = (await gh(run, ['pr', 'list', '--state', 'all', '--author', '@me', '--limit', '200', '--json', FIELDS])) as GhPr[]
  const byNumber = new Map(all.map(pr => [pr.number, pr]))
  const queued = await Promise.all(
    queue.map(async n => toRow(byNumber.get(n) ?? ((await gh(run, ['pr', 'view', String(n), '--json', FIELDS])) as GhPr))),
  )
  const opened = all.filter(pr => pr.state === 'OPEN' && !queue.includes(pr.number))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toRow)
  return [...queued, ...opened]
}

type Agent = { name: string; status: string }

// Lists the agents this session can message, as ListAgents does.
async function listAgents($: EngineInterface): Promise<Agent[]> {
  const out = await $.tool.call({ tool: 'ListAgents' })
  if (out.deny !== undefined) throw new Error(`ListAgents refused: ${out.deny}`)
  type Listing = { sections?: { rows: { name?: string; status?: string }[] }[] }
  const listing = out.result as Listing
  if (typeof listing !== 'object' || listing === null) throw new Error(`ListAgents answered ${JSON.stringify(out.result)}`)
  return (listing.sections ?? []).flatMap(section =>
    section.rows.flatMap(row => (row.name ? [{ name: row.name, status: row.status ?? 'unknown' }] : [])),
  )
}

const RANK: Record<string, number> = { busy: 0, waiting: 1, idle: 2 }

// The agent that owns a pull request by its name: pr-<n>, or issue-<k> when the branch ends in issue-<k>.
function matchOwner(row: PrRow, agents: Agent[]): Agent | undefined {
  const issue = /issue-(\d+)$/.exec(row.branch)?.[1]
  const fits = (name: string) =>
    name === `pr-${row.number}` || name.startsWith(`pr-${row.number}-`) ||
    (issue !== undefined && (name === `issue-${issue}` || name.startsWith(`issue-${issue}-`)))
  return agents
    .filter(a => fits(a.name))
    .sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3))[0]
}

// Prints each Claude Code session registry file on one line; a failed read exits with its status.
const REGISTRY_SCRIPT =
  'for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/sessions/*.json; do [ -f "$f" ] || continue; cat "$f" || exit $?; echo; done'
const SESSION_TRAILER = /^Claude-Session:.*\b(session_\w+)/gm

type Session = { name?: string; sessionId?: string; cwd?: string; bridgeSessionId?: string; messagingSocketPath?: string; updatedAt?: number }
type Registry = { sessions: Session[]; isPartial: boolean }

// The local sessions in Claude Code's session registry.
// `isPartial`: a file did not parse (a session writing it at that moment), so a miss is not final.
async function readRegistry(run: Run): Promise<Registry> {
  const out = await run(['sh', '-c', REGISTRY_SCRIPT])
  if (out.exitCode !== 0) {
    throw new Error(`reading the Claude Code session registry exited ${out.exitCode}: ${out.stderr.trim() || out.stdout.trim()}`)
  }
  const sessions: Session[] = []
  let isPartial = false
  for (const line of out.stdout.split('\n').filter(Boolean)) {
    let entry: Session
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      isPartial = true // recorded: the pull request is searched again on the next refresh
      continue
    }
    if (entry.name) sessions.push(entry)
  }
  return { sessions, isPartial }
}

// Prints each transcript's path, a tab and its newest `"aiTitle":"…"`, or nothing after the tab.
const TITLE_SCRIPT =
  'base="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; for f; do [ -f "$base/$f" ] || { printf "%s\\t\\n" "$f"; continue; }; ' +
  't=$(grep -o \'"aiTitle":"\\([^"\\\\]\\|\\\\.\\)*"\' "$base/$f" | tail -1); printf "%s\\t%s\\n" "$f" "$t"; done'

// The titles of the named sessions, by name, from the newest title in each one's transcript.
async function sessionTitles(run: Run, registry: Registry, names: string[]): Promise<Record<string, string>> {
  const newest = (name: string) => registry.sessions
    .filter(x => x.name === name && x.sessionId && x.cwd)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  const files = new Map<string, string>()
  for (const name of names) {
    const x = newest(name)
    if (x) files.set(`projects/${x.cwd!.replace(/[^a-zA-Z0-9]/g, '-')}/${x.sessionId}.jsonl`, name)
  }
  if (!files.size) return {}
  const out = await run(['sh', '-c', TITLE_SCRIPT, 'sh', ...files.keys()])
  if (out.exitCode !== 0) throw new Error(`reading session titles exited ${out.exitCode}: ${out.stderr.trim() || out.stdout.trim()}`)
  const titles: Record<string, string> = {}
  for (const line of out.stdout.split('\n').filter(Boolean)) {
    const [file = '', found = ''] = line.split('\t')
    const name = files.get(file)
    if (name && found) titles[name] = (JSON.parse(`{${found}}`) as { aiTitle: string }).aiTitle
  }
  return titles
}

// The listed agent whose session signed the pull request's commits (the `Claude-Session:` trailer),
// newest commit first; `isFinal` false when the search should run again.
async function signedOwner(run: Run, n: number, agents: Agent[], registry: Registry):
  Promise<{ owner?: string; isFinal: boolean }> {
  const bodies = String(await gh(run, ['pr', 'view', String(n), '--json', 'commits', '--jq', '.commits[].messageBody'], false))
  const sessions = [...bodies.matchAll(SESSION_TRAILER)].map(m => m[1]!).reverse()
  const owner = sessions.map(id => registry.sessions.find(x => x.bridgeSessionId === id)?.name)
    .find(name => name !== undefined && agents.some(a => a.name === name))
  return { owner, isFinal: owner !== undefined || !registry.isPartial }
}

export type OrcaWorktree = {
  id: string
  repoId: string
  projectId?: string
  path: string
  branch?: string
  displayName?: string
  isArchived?: boolean
  isMainWorktree?: boolean
  linkedPR?: number | null
  linkedItems?: { type?: string; number?: number }[]
}

type OrcaReply = { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; data?: { nextSteps?: unknown } } }

export const START_ORCA = '\nRepair: start the Orca app (`orca open`) and check it with `orca status`.'

// Runs an Orca CLI command with --json and answers its result. A failure names the command and Orca's own error, with
// Orca's next steps as the repair, else the advice to start Orca. `noAnswer` is the repair when the command can have
// gone ahead without answering.
export async function orca(run: Run, args: string[], noAnswer = START_ORCA): Promise<unknown> {
  const what = `orca ${args.slice(0, 2).join(' ')}`
  const out = await run(['orca', ...args, '--json']).catch((err: unknown) => {
    throw new Error(`${what} gave no answer: ${firstLine(err instanceof Error ? err.message : String(err)).replace(/\.$/, '')}.${noAnswer}`)
  })
  let reply: OrcaReply | undefined
  try {
    reply = JSON.parse(out.stdout) as OrcaReply
  } catch {
    reply = undefined // recorded below: a failure without JSON keeps its exit code and output
  }
  if (reply && reply.ok !== true) {
    const e = reply.error
    const steps = Array.isArray(e?.data?.nextSteps) ? e.data.nextSteps.filter((s): s is string => typeof s === 'string') : []
    const why = e?.code && e.message && e.code !== e.message ? `${e.code}: ${e.message}` : e?.code ?? e?.message ?? JSON.stringify(reply)
    const repair = steps.length ? `\nRepair: ${steps.join(' ')}` : e?.code === 'runtime_unavailable' ? START_ORCA : ''
    throw new Error(`${what} refused: ${why}${repair}`)
  }
  if (out.exitCode !== 0) throw new Error(`${what} exited ${out.exitCode}: ${out.stderr.trim() || out.stdout.trim()}${START_ORCA}`)
  if (!reply) throw new Error(`${what} printed no JSON: ${out.stdout.trim().slice(0, 200)}${START_ORCA}`)
  return reply.result
}

// Every Orca worktree, of every repository, since one can sit inside another's folder. A list cut short is refused:
// the worktree missing from it could hold the pull request. `retry` ends the repair.
export async function orcaWorktrees(run: Run, retry = ''): Promise<OrcaWorktree[]> {
  const listed = (await orca(run, ['worktree', 'list', '--limit', '1000'])) as { worktrees: OrcaWorktree[]; totalCount?: number; truncated?: boolean }
  if (listed.truncated) {
    throw new Error(`orca worktree list answered ${listed.worktrees.length} of ${listed.totalCount ?? 'more'} worktrees, so one that holds the pull request could be missing.\nRepair: archive the Orca workspaces you no longer need${retry}.`)
  }
  return listed.worktrees
}

export const ofRepo = (worktrees: OrcaWorktree[], repo: string) => worktrees.filter(w => w.projectId === `github:${repo.toLowerCase()}`)

// The repository's Orca worktrees that hold a pull request: linked to it, or on its head branch. A main checkout
// never does, since agents do not work in it.
const prWorktrees = (worktrees: OrcaWorktree[], repo: string, r: PrRow) => ofRepo(worktrees, repo).filter(w => !w.isArchived && !w.isMainWorktree && (
  w.linkedPR === r.number || (w.linkedItems ?? []).some(i => i.type === 'pr' && i.number === r.number) ||
  w.branch === `refs/heads/${r.branch}`))

// The Orca worktree a folder is in: the deepest that holds it, since Orca lists worktrees nested inside others.
const worktreeOf = (cwd: string | undefined, worktrees: OrcaWorktree[]) => cwd === undefined ? undefined : worktrees
  .filter(w => cwd === w.path || cwd.startsWith(`${w.path}/`))
  .sort((a, b) => b.path.length - a.path.length)[0]

// The listed agent whose session runs in an Orca worktree of the pull request, by the folder it runs in.
function orcaOwner(r: PrRow, repo: string, worktrees: OrcaWorktree[], agents: Agent[], registry: Registry): { owner: string; workspace: string } | undefined {
  for (const w of prWorktrees(worktrees, repo, r)) {
    const inside = registry.sessions.filter(x => worktreeOf(x.cwd, worktrees) === w).map(x => x.name)
    const owner = agents.filter(a => inside.includes(a.name)).sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3))[0]
    if (owner) return { owner: owner.name, workspace: w.displayName ?? w.path }
  }
  return undefined
}

const isListed = (name: string | undefined, agents: Agent[]) => name !== undefined && agents.some(a => a.name === name)

// The pull request's owner: its recorded owner while listed, else an agent named after it, else one a search found.
// An owner no longer listed stays recorded until another is found.
const ownerOf = (r: PrRow, was: Comm | undefined, agents: Agent[], found: { owner?: string } | undefined) =>
  (isListed(was?.owner, agents) ? was?.owner : undefined) ?? matchOwner(r, agents)?.name ?? found?.owner ?? was?.owner

type Repo = {
  nameWithOwner: string
  defaultBranchRef: { name: string }
  mergeCommitAllowed: boolean
  squashMergeAllowed: boolean
  rebaseMergeAllowed: boolean
}

// `isQuiet` keeps a failed background read out of a toast: it still shows in the pane.
async function refresh($: EngineInterface, isQuiet = false): Promise<Snapshot> {
  const run: Run = argv => $.process.run(argv, { timeoutMs: 60_000 })
  const { queue } = await read($, snapshot)
  await update($, snapshot, s => ({ ...s, isBusy: true }))
  try {
    const repo = (await gh(run, [
      'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
    ])) as Repo
    const rows = queue.length > 0 ? await refreshQueue(run, queue) : await openQueue(run)
    let agentsError: string | undefined
    const agents = await listAgents($).catch((err: unknown) => {
      agentsError = err instanceof Error ? err.message : String(err) // shown in the pane
      return [] as Agent[]
    })
    // An open pull request with no listed owner and no agent named after it: look once per head for the session
    // that signed it, then, on each refresh, for a listed session in an Orca worktree of it (one list call).
    const found: Record<number, { owner?: string; isFinal: boolean; via?: string }> = {}
    const known = await read($, comms)
    // An agent started in Orca keeps its pull request while the loop waits for it: until its session is listed in its
    // workspace, no other owner is looked for, so two agents never fix one branch. Once the head moves, the round is done
    // and the owner is looked for as for any pull request.
    const l = await read($, loop)
    const started = l.step === 'orca' && l.orcaPath !== undefined && !l.isRoundDone
      ? rows.find(r => r.state === 'OPEN' && r.number === l.current && r.head === l.askedHead)
      : undefined
    const ownerFor = (r: PrRow, was: Comm | undefined) => (r === started ? found[r.number]?.owner : ownerOf(r, was, agents, found[r.number]))
    // A search holds until the head moves or another agent is listed: a session can sign in after it.
    const searchKey = (r: PrRow) => `${r.head} ${agents.map(a => a.name).sort().join(' ')}`
    const unnamed = rows.filter(r => r.state === 'OPEN' && r !== started && !isListed(known[r.number]?.owner, agents) && !matchOwner(r, agents))
    let titles: Record<string, string> = {}
    let orcaError: string | undefined
    if (agentsError === undefined && rows.some(r => r.state === 'OPEN')) {
      try {
        const registry = await readRegistry(run)
        for (const r of unnamed.filter(r => known[r.number]?.searchedFor !== searchKey(r))) {
          found[r.number] = { ...(await signedOwner(run, r.number, agents, registry)), via: 'the listed session that signed its commits' }
        }
        const lost = unnamed.filter(r => !found[r.number]?.owner)
        if (lost.length || started) {
          try {
            const worktrees = await orcaWorktrees(run)
            for (const r of lost) {
              const o = orcaOwner(r, repo.nameWithOwner, worktrees, agents, registry)
              if (o) found[r.number] = { isFinal: false, ...found[r.number], owner: o.owner, via: `in Orca workspace ${o.workspace}` }
            }
            if (started) {
              const inside = registry.sessions.filter(x => worktreeOf(x.cwd, worktrees)?.path === l.orcaPath).map(x => x.name)
              const owner = agents.filter(a => inside.includes(a.name)).sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3))[0]
              if (owner) found[started.number] = { isFinal: false, owner: owner.name, via: `started in ${l.by}` }
            }
          } catch (err) {
            orcaError = err instanceof Error ? err.message : String(err) // shown in the pane; the lookup runs again next refresh
          }
        }
        const owners = rows.filter(r => r.state === 'OPEN').map(r => ownerFor(r, known[r.number]))
        titles = await sessionTitles(run, registry, [...new Set(owners.filter((o): o is string => !!o))])
      } catch (err) {
        agentsError = err instanceof Error ? err.message : String(err) // shown in the pane, as a ListAgents failure is
      }
    }
    await update($, comms, all => {
      const copy = { ...all }
      for (const row of rows) {
        const was = copy[row.number] ?? {}
        const search = found[row.number]
        const owner = ownerFor(row, was)
        const presence = agents.find(a => a.name === owner)?.status
        // A new owner starts a new conversation: what the last one was sent and said is not its own.
        const isNewOwner = was.owner !== undefined && owner !== was.owner
        copy[row.number] = {
          ...was,
          ...(isNewOwner ? { sentAt: undefined, sent: undefined, sendError: undefined, heardAt: undefined, heard: undefined, isBlocked: undefined } : {}),
          owner, presence: owner === undefined ? undefined : agentsError === undefined ? presence ?? 'gone' : was.presence,
          title: owner ? titles[owner] ?? was.title : undefined,
          via: search?.owner !== undefined && search.owner === owner ? search.via : owner === was.owner ? was.via : undefined,
          ...(search?.isFinal ? { searchedFor: searchKey(row) } : {}),
        }
      }
      return copy
    })
    const fresh: Snapshot = {
      repo: repo.nameWithOwner,
      defaultBranch: repo.defaultBranchRef.name,
      mergeMethod: repo.mergeCommitAllowed ? 'merge' : repo.squashMergeAllowed ? 'squash' : 'rebase',
      queue: rows.map(r => r.number),
      rows,
      checkedAt: await $.clock.now(),
      isBusy: false,
      agentsError,
      orcaError,
    }
    await update($, snapshot, () => fresh)
    for (const [n, f] of Object.entries(found)) {
      if (f.owner) await noteOnce($, `#${n}: owner ${f.owner}, ${f.via}`)
    }
    const { phase } = await read($, loop)
    $.ui.status(rows.length ? `PRs ${rows.filter(r => r.state !== 'OPEN').length}/${rows.length} done · ${phase}` : undefined)
    if (!isQuiet) $.ui.toast(`fix-all-prs: refreshed: ${rows.length} pull request${rows.length === 1 ? '' : 's'}`)
    return fresh
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, snapshot, s => ({ ...s, error, isBusy: false }))
    if (!isQuiet) $.ui.toast(`fix-all-prs: ${error.split('\n')[0]}`)
    throw err
  }
}

// Runs a refresh without holding the hook that asked for it (a press has a 10 s budget).
function refreshLater($: EngineInterface, isQuiet: boolean): void {
  void refresh($, isQuiet).catch(() => undefined) // refresh records the failure in the pane
}

// Adds a line to the loop's activity log, newest last.
async function note($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, loop, (l): Loop => ({ ...l, log: [...l.log, { at, text }].slice(-30) }))
}

// Adds a line the log does not hold already.
async function noteOnce($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, loop, (l): Loop => (l.log.some(x => x.text === text) ? l : { ...l, log: [...l.log, { at, text }].slice(-30) }))
}

async function settle($: EngineInterface, n: number, outcome: Outcome): Promise<void> {
  await update($, loop, (l): Loop => ({ ...l, outcomes: { ...l.outcomes, [n]: outcome }, step: undefined, stepAt: undefined, askedHead: undefined }))
  await note($, `#${n} ${outcome.kind}: ${outcome.detail}`)
}

// The name of the session at a socket address (`uds:<path>`), as ListAgents lists it; any other recipient as given.
// An owner recorded under its address would never be listed, so it would be taken as gone.
async function nameAt($: EngineInterface, to: string): Promise<string> {
  const path = /^uds:(.+)$/.exec(to)?.[1]
  if (path === undefined) return to
  const { sessions, isPartial } = await readRegistry(argv => $.process.run(argv, { timeoutMs: 60_000 }))
  const name = sessions.find(x => x.messagingSocketPath === path)?.name
  if (name === undefined) {
    const partial = isPartial ? ', and a registry file did not parse (a session may have been writing it)' : ''
    await note($, `${to}: no named session in the Claude Code session registry has this socket${partial}, so the message is recorded under the address. Repair: message the owner by the name ListAgents shows.`)
    return to
  }
  return name
}

// Notes a message to an agent against the pull requests it is about.
async function recordSent($: EngineInterface, to: string, text: string, reason: string | undefined): Promise<void> {
  const { queue } = await read($, snapshot)
  const now = await $.clock.now()
  await update($, comms, all => {
    const copy = { ...all }
    for (const n of prsOf(text, to, queue, all)) {
      copy[n] = { ...copy[n], owner: to, sentAt: now, sent: firstLine(text), sendError: reason }
    }
    return copy
  })
}

// A plugin's own send skips its own session.send hook, so this records the message itself.
async function tell($: EngineInterface, to: string, text: string): Promise<boolean> {
  const sent = await $.session.send({ to, text })
  await recordSent($, to, text, sent.isDelivered ? undefined : sent.reason)
  if (!sent.isDelivered) await note($, `Message to ${to} not delivered: ${sent.reason}`)
  return sent.isDelivered
}

// What still stands between a pull request and a merge, in words an agent can act on.
function needs(r: PrRow, base: string): string[] {
  const out: string[] = []
  if (r.mergeable === 'CONFLICTING') out.push(`conflicts with ${base}`)
  if (r.failing.length) out.push(`failing checks: ${r.failing.join(', ')}`)
  if (r.isDraft) out.push('still a draft (mark it ready with `gh pr ready` when it is finished)')
  if (r.mergeState === 'BEHIND') out.push(`behind ${base}`)
  if (r.mergeState === 'BLOCKED' && !r.failing.length) out.push('GitHub reports it blocked: a required check or review is missing')
  return out.length ? out : [`GitHub merge state ${r.mergeState}`]
}

const isGreen = (r: PrRow) => r.state === 'OPEN' && r.mergeState === 'CLEAN' && !r.isDraft && !r.failing.length && !r.pending

function askText(r: PrRow, snap: Snapshot, round: number, isNoMerge: boolean): string {
  const base = snap.defaultBranch ?? 'the default branch'
  return [
    `PR #${r.number} "${r.title}" (branch ${r.branch}) is next in the fix-all-prs queue for ${snap.repo}, round ${round} of ${MAX_ROUNDS}.`,
    `It needs: ${needs(r, base).join('; ')}.`,
    `Please merge origin/${base} into the branch, fix these and address any open review comments, then push through the repository's push script.`,
    'Reply to me when you have pushed. If you are blocked, start the reply with "blocked:" and the reason.',
    isNoMerge ? 'Do not merge it: a human merges it once its checks pass.' : 'Do not merge it: I merge it once its checks pass.',
  ].join('\n')
}

// The brief for this session's model, or, with `self` (this session's name), for an agent started in an Orca
// workspace, which reports back by message because the report tool is this session's own.
function handOverText(r: PrRow, snap: Snapshot, why: string, c: Comm | undefined, isNoMerge: boolean, self?: string): string {
  const base = snap.defaultBranch ?? 'the default branch'
  const merges = isNoMerge ? 'It waits for the checks. A human merges it.' : 'It waits for the checks and merges the pull request itself.'
  const leave = isNoMerge ? 'Do not wait for the checks: the mod does. Do not merge: a human does.' : 'Do not wait for the checks and do not merge: the mod does both.'
  const intro = self
    ? `The fix-all-prs loop in session \`${self}\` runs the pull request queue for ${snap.repo}. It started you in this Orca workspace for this one pull request because ${why}. ${merges}`
    : `The fix-all-prs mod runs the pull request queue for ${snap.repo}. It hands you this one pull request because ${why}. ${merges}`
  const work = self
    ? `2. Work in this workspace. Fetch, make sure it holds the head of \`origin/${r.branch}\`, then merge \`origin/${base}\`. Resolve conflicts. Never use a bare \`git stash\`.`
    : `2. In the pull request's worktree (or a new worktree on its head branch), fetch and merge \`origin/${base}\`. Resolve conflicts. Never use a bare \`git stash\`.`
  const push = self
    ? `4. Push to the pull request's branch only (\`HEAD:${r.branch}\`), through the repository's push script if it has one.`
    : '4. Push the head branch only, through the repository\'s push script if it has one.'
  const done = self
    ? `5. Send \`${self}\` a message (SendMessage) that you have pushed. ${leave}`
    : `5. Call \`${REPORT_TOOL}\` with \`{ "pr": ${r.number}, "outcome": "pushed" }\`. ${leave}`
  const stop = self
    ? `Stop, send \`${self}\` a message that starts with "blocked:" and the reason, and tell the user,`
    : `Stop, call \`${REPORT_TOOL}\` with \`{ "pr": ${r.number}, "outcome": "blocked", "reason": "<why>" }\` and tell the user,`
  return `# Fix pull request #${r.number} for the fix-all-prs loop

${intro}

- #${r.number} ${r.title}, branch \`${r.branch}\`
- Needs: ${needs(r, base).join('; ')}${c?.heard ? `\n- Its owning agent ${c.owner} last said: "${c.heard}"` : ''}

1. Read the repository's own instructions (\`CLAUDE.md\`, \`AGENTS.md\`). Where they name a push script, a wait helper, a precheck or a fix-CI skill, use it. Their rules win over these steps.
${work}
3. Read the failing checks, the open review comments and the mergeability. Reproduce each failure, add a failing test where one applies, make the smallest fix and run the focused checks.
${push} Mark a finished draft ready with \`gh pr ready ${r.number}\`.
${done}

${stop} when a fix needs a product or design decision the pull request and its issue do not settle, when it would weaken, skip or silence a check, or when a reviewer asked for changes you cannot make.`
}

// `isAwaitingOwner`: the owner could not be looked for, so one found later takes the pull request over.
async function handOver($: EngineInterface, r: PrRow, snap: Snapshot, why: string, c: Comm | undefined, isAwaitingOwner = false): Promise<void> {
  const now = await $.clock.now()
  await update($, loop, (l): Loop => ({ ...l, step: 'model', stepAt: now, askedHead: r.head, isRoundDone: false, by: 'this session', isAwaitingOwner }))
  await note($, `#${r.number}: handed to this session's model (${why})`)
  void $.prompt.submit({ text: handOverText(r, snap, why, c, !!(await read($, loop)).isNoMerge) })
}

// Asks the owner for this round's fix; a message it cannot be sent hands the pull request to the model.
async function ask($: EngineInterface, r: PrRow, snap: Snapshot, c: Comm & { owner: string }, round: number, how = ''): Promise<void> {
  const now = await $.clock.now()
  await update($, loop, (l): Loop => ({ ...l, step: 'asked', stepAt: now, askedHead: r.head, isRoundDone: false, by: c.owner, isAwaitingOwner: false }))
  await note($, `#${r.number}: asked ${c.owner}${how} (round ${round})`)
  if (!(await tell($, c.owner, askText(r, snap, round, !!(await read($, loop)).isNoMerge)))) {
    await handOver($, r, snap, `the message to ${c.owner} was not delivered`, c)
  }
}

const NO_OWNER = 'no agent is named after it, no listed session signed its commits and no listed session works in an Orca workspace for it'

// Starts a Claude agent with the hand-over brief in the Orca workspace that holds the pull request, else in a new
// one. Answers true when no agent could start: the pull request is then recorded blocked with Orca's own output.
async function startInOrca($: EngineInterface, run: Run, r: PrRow, snap: Snapshot, why: string, c: Comm | undefined): Promise<boolean> {
  const { isNoMerge } = await read($, loop)
  // A start can run the workspace's setup first, so it gets the longest wait a command can have.
  const start: Run = argv => $.process.run(argv, { timeoutMs: 600_000 })
  const unanswered = (workspace: string) =>
    `\nOrca may still start the agent in workspace ${workspace}.\nRepair: look at Orca workspace ${workspace}; when no agent runs in it, retry #${r.number}.`
  let workspace: string
  let path: string
  try {
    // The owner search could not look in Orca, so a session at work in a workspace of the pull request could own it.
    if (snap.orcaError) {
      throw new Error(`${snap.orcaError}\nNo agent starts while a session in an Orca workspace could own it. When Orca lists its workspaces again, retry #${r.number}.`)
    }
    const id = await $.session.id()
    const self = (await readRegistry(run)).sessions.find(s => s.sessionId === id)?.name
    if (!self) throw new Error(`this session (${id}) has no name, so the agent could not message it.\nRepair: name it with /rename, then retry #${r.number}.`)
    const repo = snap.repo ?? ''
    const worktrees = await orcaWorktrees(run, `, then retry #${r.number}`)
    const brief = handOverText(r, snap, why, c, !!isNoMerge, self)
    const held = prWorktrees(worktrees, repo, r)[0]
    if (held) {
      workspace = held.displayName ?? held.path
      path = held.path
      await orca(start, ['agent', 'launch', '--agent', 'claude', '--worktree', `id:${held.id}`, '--prompt', brief], unanswered(workspace))
    } else {
      const repoId = ofRepo(worktrees, repo)[0]?.repoId
      if (!repoId) throw new Error(`Orca has no repository for ${repo}.\nRepair: run \`orca repo add --path <a clone of ${repo}>\`, then retry #${r.number}.`)
      const name = `pr-${r.number}`
      const made = (await orca(start, [
        'worktree', 'create', '--name', name, '--repo', `id:${repoId}`, '--base-branch', `origin/${r.branch}`,
        '--reference', `https://github.com/${repo}/pull/${r.number}`, '--agent', 'claude', '--prompt', brief,
        '--comment', `Started by the fix-all-prs loop in ${self}: ${why}`,
      ], unanswered(name))) as { worktree?: OrcaWorktree }
      workspace = made.worktree?.displayName ?? name
      if (!made.worktree?.path) {
        throw new Error(`orca worktree create answered no folder for workspace ${workspace}, so the loop cannot tell its agent from another session.${unanswered(workspace)}`)
      }
      path = made.worktree.path
    }
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\.?\n/g, '. ')
    await settle($, r.number, { kind: 'blocked', detail: `Orca could not start an agent (${why}): ${detail}` })
    return true
  }
  const now = await $.clock.now()
  await update($, loop, (l): Loop => ({ ...l, step: 'orca', stepAt: now, askedHead: r.head, isRoundDone: false, by: `Orca workspace ${workspace}`, isAwaitingOwner: false, orcaPath: path }))
  await note($, `#${r.number}: started a Claude agent in Orca workspace ${workspace} (${why})`)
  return false
}

// One step of the loop. Answers true when the next step can run at once.
// `isForced`: the person asked, so a quota wait gives way (they may have raised the budget).
async function advance($: EngineInterface, isForced = false): Promise<boolean> {
  if ((await read($, loop)).phase !== 'running') {
    await refresh($, true)
    return false
  }
  const snap = await refresh($, true)
  let state = await read($, loop)
  const row = snap.rows.find(r => r.number === state.current && !state.outcomes[r.number]) ??
    snap.rows.find(r => !state.outcomes[r.number])
  if (!row) {
    const kinds = Object.values(state.outcomes).map(o => o.kind)
    const count = (k: Outcome['kind']) => kinds.filter(x => x === k).length
    await update($, loop, (l): Loop => ({ ...l, phase: 'done', current: undefined, step: undefined }))
    await note($, `Queue finished: ${count('merged')} merged, ${count('ready')} ready, ${count('blocked')} blocked, ${count('closed')} closed, ${count('skipped')} skipped`)
    $.ui.toast('fix-all-prs: the queue is finished')
    return false
  }
  const n = row.number
  if (n !== state.current) {
    await update($, loop, (l): Loop => ({
      ...l, current: n, step: undefined, stepAt: undefined, askedHead: undefined, isRoundDone: false, attempts: 0, by: undefined, isAwaitingOwner: false,
      orcaPath: undefined, mergeFailures: 0, mergeRetryAt: 0, preMerge: undefined,
      // A storage wait belongs to the pull request it failed; the API quota is the whole account's.
      quota: l.quota?.kind === 'api' ? l.quota : undefined,
    }))
    await note($, `#${n}: started`)
    state = await read($, loop)
  }
  const run: Run = argv => $.process.run(argv, { timeoutMs: 120_000 })
  const c = (await read($, comms))[n]
  const now = await $.clock.now()

  if (row.state === 'MERGED') {
    const sha = row.mergeCommit ?? ''
    // The merge stands even when the compare fails: the outcome says so instead of stopping the loop.
    const status = sha && snap.defaultBranch
      ? String(await gh(run, ['api', `repos/${snap.repo}/compare/${snap.defaultBranch}...${sha}`, '--jq', '.status'], false)
        .catch((err: unknown) => `unknown, the compare failed: ${firstLine(err instanceof Error ? err.message : String(err))}`))
      : 'unknown'
    const isOnBase = status === 'behind' || status === 'identical'
    await settle($, n, {
      kind: 'merged',
      detail: `${sha.slice(0, 7) || 'no merge commit read'}${isOnBase ? ` on ${snap.defaultBranch}` : ` (${snap.defaultBranch} compare says ${status})`}`,
      by: state.by,
    })
    if (c?.owner && c.presence !== 'gone') {
      await tell($, c.owner, `PR #${n} is merged (${sha.slice(0, 7)}). Thank you. You can stop work on it and clean up its worktree.`)
    }
    return true
  }
  if (row.state === 'CLOSED') {
    await settle($, n, { kind: 'closed', detail: 'closed without a merge' })
    return true
  }
  // GitHub has not reported the merge yet; after five minutes the loop judges the pull request afresh.
  if (state.step === 'merging' && now - (state.stepAt ?? 0) < 5 * 60_000) return false
  // A refused merge waits a minute before the next try, however often the loop ticks meanwhile.
  if (isGreen(row) && now < (state.mergeRetryAt ?? 0)) return false
  if (isGreen(row) && state.isNoMerge) {
    await settle($, n, { kind: 'ready', detail: `green at ${row.head}, left for a human to merge`, by: state.by })
    if (c?.owner && c.presence !== 'gone') {
      await tell($, c.owner, `PR #${n} passes its checks and is ready for a human to merge. Thank you. Leave it as it is.`)
    }
    return true
  }
  if (isGreen(row)) {
    const prior = state.step === 'merging' ? state.preMerge : state
    await update($, loop, (l): Loop => ({ ...l, step: 'merging', stepAt: now, preMerge: { step: prior?.step, stepAt: prior?.stepAt, askedHead: prior?.askedHead } }))
    try {
      await gh(run, ['pr', 'merge', String(n), `--${snap.mergeMethod ?? 'merge'}`], false)
    } catch (err) {
      // GitHub can refuse a merge it reported clean (the base moved, a rule changed): try again next tick.
      const failures = (state.mergeFailures ?? 0) + 1
      const why = firstLine(err instanceof Error ? err.message : String(err))
      // Each field by name: stored state drops undefined values, so a spread cannot clear `step`.
      await update($, loop, (l): Loop => ({
        ...l, step: l.preMerge?.step, stepAt: l.preMerge?.stepAt, askedHead: l.preMerge?.askedHead, preMerge: undefined, mergeFailures: failures, mergeRetryAt: now + TICK_MS,
      }))
      await note($, `#${n}: merge refused (${failures}/${MAX_MERGE_FAILURES}): ${why}`)
      if (failures >= MAX_MERGE_FAILURES) {
        await settle($, n, { kind: 'blocked', detail: `GitHub refused the merge ${failures} times: ${why}`, by: state.by })
        return true
      }
      return false
    }
    await note($, `#${n}: merge requested (--${snap.mergeMethod})`)
    return true
  }
  // GitHub is still running checks or working out mergeability.
  if (row.pending > 0 || row.mergeState === 'UNKNOWN' || row.mergeable === 'UNKNOWN') return false

  const isRoundDone = state.isRoundDone || (state.askedHead !== undefined && row.head !== state.askedHead)
  if (state.step !== undefined && !isRoundDone) {
    const listed = c?.owner !== undefined && c.presence !== 'gone' ? { ...c, owner: c.owner } : undefined
    if (state.step === 'asked' && c?.owner) {
      // The asked owner was replaced by another: the new one has not been asked yet.
      if (listed && c.sentAt === undefined) {
        await ask($, row, snap, listed, state.attempts, `, in place of ${state.by}`)
        return false
      }
      const hasReplied = c.heardAt !== undefined && c.heardAt >= (state.stepAt ?? 0)
      if (hasReplied && c.isBlocked) {
        await handOver($, row, snap, `its owning agent ${c.owner} is blocked`, c)
        return false
      }
      // Gone as of the last list that worked: while the agents cannot be listed, the owner may be back.
      if (c.presence === 'gone' && snap.agentsError === undefined) {
        return startInOrca($, run, row, snap, `its owning agent ${c.owner} is no longer listed`, c)
      }
      const lastWord = Math.max(state.stepAt ?? 0, hasReplied ? c.heardAt! : 0)
      if (c.sendError || now - lastWord > ASK_WAIT_MS) {
        await handOver($, row, snap, c.sendError ? `the message to ${c.owner} was not delivered` : `${c.owner} has not pushed or answered for 30 minutes`, c)
      }
    }
    // An agent was started in Orca: once its session is listed in its workspace, it is asked as an owner is.
    if (state.step === 'orca') {
      if (listed) {
        await ask($, row, snap, listed, state.attempts, `, listed since the start in ${state.by}`)
      } else if (now - (state.stepAt ?? 0) > ASK_WAIT_MS) {
        // The model does not take it: the agent may yet be working there unlisted.
        const unread = snap.orcaError ? ` (the Orca workspaces could not be read: ${firstLine(snap.orcaError)})` : ''
        await settle($, n, {
          kind: 'blocked',
          detail: `the agent started in ${state.by} was not listed within 30 minutes${unread}. Repair: look at ${state.by}; when no agent runs in it, retry #${n}`,
          by: state.by,
        })
        return true
      }
    }
    // The model holds it only because the agents could not be listed, and the list works again and shows an owner: the
    // owner takes it over, and the model is told to stop. Neither an ask in an earlier round nor a message from the model
    // stops that. While the list still fails, an agent the model wrote to is not known to be listed.
    if (state.step === 'model' && state.isAwaitingOwner && listed && snap.agentsError === undefined) {
      await ask($, row, snap, listed, state.attempts, ', found since the hand-over to this session\'s model')
      if ((await read($, loop)).step === 'asked') {
        const unsent = (why: string) =>
          note($, `#${n}: the model could not be told to stop: ${why}. Repair: tell this session's model to stop work on #${n}; ${listed.owner} has it.`)
        void $.prompt.submit({
          text: `Stop work on pull request #${n}: its owning agent ${listed.owner} has it now. Do not push to it or call \`${REPORT_TOOL}\` for it. ` +
            `If you changed files for it, tell ${listed.owner} what you changed with SendMessage.`,
        }).then(
          r => (r.drop !== undefined ? unsent(`the prompt was dropped (${r.drop})`) : undefined),
          (err: unknown) => unsent(err instanceof Error ? err.message : String(err)),
        )
      }
    }
    return false // the owner or the model is still working
  }
  if (row.failing.length && snap.repo && (await waitsForStorage($, run, row, state.quota, now, isForced, snap.repo))) return false
  if (state.attempts >= MAX_ROUNDS) {
    await settle($, n, {
      kind: 'blocked',
      detail: `after ${MAX_ROUNDS} rounds it still needs: ${needs(row, snap.defaultBranch ?? 'the default branch').join('; ')}`,
      by: state.by,
    })
    return true
  }

  const round = state.attempts + 1
  await update($, loop, (l): Loop => ({ ...l, attempts: round }))
  if (c?.owner && c.presence !== 'gone') {
    await ask($, row, snap, { ...c, owner: c.owner }, round)
  } else if (snap.agentsError !== undefined) {
    // The owner search did not run, so an Orca workspace could duplicate a listed owner's work.
    await handOver($, row, snap, `the agents could not be listed to find its owner (${firstLine(snap.agentsError)})`, c, true)
  } else if (state.step === 'orca') {
    // The agent started in Orca was never listed, so it may still be at work there unlisted.
    await settle($, n, {
      kind: 'blocked',
      detail: `the agent started in ${state.by} was never listed, so round ${round} has no agent to ask, and no second agent starts beside it. Repair: look at ${state.by}; when no agent runs in it, retry #${n}`,
      by: state.by,
    })
    return true
  } else {
    return startInOrca($, run, row, snap, c?.owner ? `its owning agent ${c.owner} is no longer listed` : NO_OWNER, c)
  }
  return false
}

// Answers true while failed checks wait on the Actions storage quota: no fix can help them, a rerun can.
async function waitsForStorage(
  $: EngineInterface, run: Run, row: PrRow, q: Quota | undefined, now: number, isForced: boolean, repo: string,
): Promise<boolean> {
  const n = row.number
  if (q?.kind === 'storage' && q.pr === n && q.head === row.head) {
    if (q.rerunAt !== undefined) {
      // GitHub has not shown the rerun as running yet.
      if (now - q.rerunAt < RERUN_GRACE_MS) return true
    } else {
      if (now < q.until && !isForced) return true
      for (const id of q.runs ?? []) await gh(run, ['run', 'rerun', String(id), '--failed'], false)
      await update($, loop, (l): Loop => ({ ...l, quota: { ...q, rerunAt: now } }))
      await note($, `#${n}: reran the failed jobs of run ${(q.runs ?? []).join(', ')} after the storage quota wait`)
      return true
    }
  }
  const hit = await storageQuotaHit(run, repo, row.head)
  if (!hit) {
    if (q?.kind === 'storage') await update($, loop, (l): Loop => ({ ...l, quota: undefined }))
    return false
  }
  const until = now + STORAGE_WAIT_MS
  await update($, loop, (l): Loop => ({
    ...l, quota: { kind: 'storage', until, detail: hit.message, pr: n, head: row.head, runs: hit.runs },
  }))
  await note($, `#${n}: Actions storage full; reruns the failed jobs at ${clockTime(until)} (run ${hit.runs.join(', ')}; GitHub recounts every 6 to 12 hours)`)
  $.ui.toast(`fix-all-prs: the Actions storage quota is used up. It reruns #${n}'s failed jobs at ${clockTime(until)}, or at once when you resume.`)
  return true
}

// The time of day of `at`, in this machine's time zone.
function clockTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

let isTicking = false
// A tick asked for while one runs: it runs again when that one ends, so no request is lost.
let isTickAgain = false

// Runs the loop until it must wait. A failure pauses the loop and shows why.
// `isForced`: the person asked (start, resume, retry, refresh), so a backoff does not hold the tick back.
async function tick($: EngineInterface, isForced = false): Promise<void> {
  if (isTicking) {
    isTickAgain = true
    return
  }
  // Claim the tick before the first await, so two ticks never run side by side.
  isTicking = true
  isTickAgain = false
  try {
    if (!isForced && (await $.clock.now()) < ((await read($, loop)).ghRetryAt ?? 0)) return
    for (let i = 0; i < 50 && (await advance($, isForced && i === 0)); i++);
    const wasLimited = (await read($, loop)).quota?.kind === 'api'
    await update($, loop, (l): Loop => (l.ghFailures || l.quota?.kind === 'api'
      ? { ...l, ghFailures: 0, ghRetryAt: 0, error: undefined, quota: l.quota?.kind === 'api' ? undefined : l.quota }
      : l))
    if (wasLimited) await note($, 'GitHub API quota is back; the loop goes on')
  } catch (err) {
    // Never pause on a GitHub error: an outage, a rate limit or an expired sign-in all end, so back off and retry.
    const error = err instanceof Error ? err.message : String(err)
    const l = await read($, loop)
    // A used-up API quota has a known end: wait for it rather than guess with a backoff.
    const back = l.phase === 'running' && RATE_LIMIT.test(error.split('\n')[0]!)
      ? await apiQuotaBack(argv => $.process.run(argv, { timeoutMs: 60_000 })).catch(async (why: unknown) => {
        await note($, `GitHub rate limit hit, and gh api rate_limit failed, so the loop backs off instead: ${firstLine(why instanceof Error ? why.message : String(why))}`)
        return undefined
      })
      : undefined
    if (back) {
      // A few seconds' margin: GitHub's clock and this one differ.
      const until = back.at + 5_000
      await update($, loop, (s): Loop => ({ ...s, ghRetryAt: until, error, quota: { kind: 'api', until, detail: back.which } }))
      await note($, `GitHub API quota used up (${back.which}); it is back at ${clockTime(until)} and the loop resumes then`)
    } else if (l.phase === 'running') {
      const failures = (l.ghFailures ?? 0) + 1
      const wait = Math.min(TICK_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
      const at = await $.clock.now()
      await update($, loop, (s): Loop => ({ ...s, ghFailures: failures, ghRetryAt: at + wait, error }))
      await note($, `GitHub error (${failures} in a row), retrying in ${Math.round(wait / 60_000)} min: ${firstLine(error)}`)
      // Only gh's own output decides: the repair line under it names `gh auth login` on every failure.
      if (failures === 1 && NEEDS_PERSON.test(error.split('\n')[0]!)) {
        $.ui.toast(`fix-all-prs keeps retrying, but this needs you: ${firstLine(error)}`)
      }
    }
  } finally {
    isTicking = false
  }
  if (isTickAgain) await tick($)
}

function tickLater($: EngineInterface, isForced = false): void {
  void tick($, isForced) // tick records its own failures
}

// `isNoMerge`: fix each pull request until it is green, and leave the merge to a human.
async function start($: EngineInterface, isNoMerge = false): Promise<void> {
  await update($, loop, (): Loop => ({ phase: 'running', attempts: 0, outcomes: {}, log: [], isNoMerge }))
  await note($, isNoMerge ? 'Started the queue without merging' : 'Started the queue')
  // The new log starts empty: it says again how an owner found before the start was found. A refresh still
  // running writes its owners, then its rows, then its notes, so one of the two notes each owner, once.
  const open = (await read($, snapshot)).rows.filter(r => r.state === 'OPEN').map(r => r.number)
  const known = await read($, comms)
  for (const n of open) {
    const c = known[n]
    if (c?.owner && c.via) await noteOnce($, `#${n}: owner ${c.owner}, ${c.via}`)
  }
  await update($, snapshot, () => ({ queue: [], rows: [], checkedAt: 0 }))
  tickLater($, true)
}

async function setPhase($: EngineInterface, phase: Loop['phase']): Promise<void> {
  await update($, loop, (l): Loop => ({ ...l, phase, error: phase === 'running' ? undefined : l.error }))
  await note($, phase === 'running' ? 'Resumed' : 'Paused by the user')
  if (phase === 'running') tickLater($, true)
}

async function skip($: EngineInterface, n: number): Promise<void> {
  await settle($, n, { kind: 'skipped', detail: 'skipped by the user' })
  tickLater($, true)
}

// Takes the pull request up again afresh, oldest first: its outcome, its rounds, its merge failures and
// the GitHub back-off are cleared, and its owner's last reply (a "blocked:" one) no longer counts.
async function retry($: EngineInterface, n: number): Promise<void> {
  await update($, loop, (l): Loop => {
    const outcomes = { ...l.outcomes }
    delete outcomes[n]
    const isCurrent = l.current === n
    return {
      ...l, outcomes, phase: l.phase === 'done' ? 'running' : l.phase, ghFailures: 0, ghRetryAt: 0,
      // Each field by name: stored state drops undefined values, so a spread cannot clear them.
      ...(isCurrent ? {
        step: undefined, stepAt: undefined, askedHead: undefined, isRoundDone: false, attempts: 0, by: undefined,
        mergeFailures: 0, mergeRetryAt: 0, preMerge: undefined,
      } : {}),
    }
  })
  await update($, comms, cur => {
    const c = cur[n]
    return c ? { ...cur, [n]: { ...c, isBlocked: false, sentAt: undefined, sent: undefined, sendError: undefined } } : cur
  })
  await note($, `#${n}: back in the queue, from round 1`)
  tickLater($, true)
}

// The pull requests a message is about: those it names (#182, PR 182), else those its recipient owns.
function prsOf(text: string, to: string, queue: number[], all: Record<string, Comm>): number[] {
  const named = [...text.matchAll(/(?:#|\bPR\s*#?|pull request\s*#?)(\d+)\b/gi)].map(m => Number(m[1]))
  const hits = named.filter(n => queue.includes(n))
  return hits.length ? [...new Set(hits)] : queue.filter(n => all[n]?.owner === to)
}

export const firstLine = (text: string) =>
  text.split('\n').map(l => l.replace(/<[^>]+>/g, '').trim()).find(l => l.length > 0)?.slice(0, 160) ?? ''

function ago(now: number, at: number): string {
  const minutes = Math.round((now - at) / 60_000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

// One line on the owning agent: who, whether it is there, and where the conversation stands.
function talk(c: Comm | undefined, now: number): { text: string; color?: string } {
  if (!c?.owner) return { text: 'no owning agent found', color: 'inactive' }
  const who = `${c.owner}${c.presence ? ` (${c.presence})` : ''}`
  if (c.sendError) return { text: `${who} · message not delivered: ${c.sendError}`, color: 'error' }
  if (c.sentAt === undefined) return { text: `${who} · not contacted` }
  if (c.heardAt !== undefined && c.heardAt >= c.sentAt) {
    return { text: `${who} · replied ${ago(now, c.heardAt)}: ${c.heard ?? ''}`, color: c.isBlocked ? 'error' : 'success' }
  }
  const waited = now - c.sentAt
  return { text: `${who} · asked ${ago(now, c.sentAt)}, no reply yet`, color: waited > ASK_WAIT_MS ? 'error' : 'warning' }
}

// The status word and colour of one pull request, worst first.
function mark(r: PrRow, o?: Outcome): { word: string; color: string } {
  if (o?.kind === 'blocked') return { word: 'blocked', color: 'error' }
  if (o?.kind === 'skipped') return { word: 'skipped', color: 'inactive' }
  if (o?.kind === 'ready') return { word: 'ready', color: 'success' }
  if (r.state === 'MERGED') return { word: 'merged', color: 'success' }
  if (r.state === 'CLOSED') return { word: 'closed', color: 'inactive' }
  if (r.mergeable === 'CONFLICTING') return { word: 'conflict', color: 'error' }
  if (r.failing.length) return { word: 'failing', color: 'error' }
  if (r.pending) return { word: 'running', color: 'warning' }
  if (r.isDraft) return { word: 'draft', color: 'warning' }
  if (r.mergeState !== 'CLEAN') return { word: r.mergeState.toLowerCase(), color: 'warning' }
  return { word: 'green', color: 'success' }
}

// Where the loop stands, in one line.
function where(l: Loop, c: Comm | undefined, now: number): string {
  if (l.phase === 'idle') return 'Not started'
  if (l.phase === 'done') return 'Finished'
  if (l.phase === 'paused') return l.error ? `Paused: ${l.error.split('\n')[0]}` : 'Paused'
  const q = l.quota
  // A quota wait says when the loop goes on; otherwise a GitHub error says when it tries again.
  const retrying = q && q.rerunAt === undefined
    ? ` · ${q.kind === 'api' ? `GitHub API quota used up (${q.detail})` : 'Actions storage quota used up'}, resumes at ${clockTime(q.until)}`
    : l.ghFailures
      ? ` · GitHub error (${l.ghFailures} in a row), retrying ${l.ghRetryAt && l.ghRetryAt > now ? `in ${Math.ceil((l.ghRetryAt - now) / 60_000)} min` : 'now'}`
      : ''
  const mode = l.isNoMerge ? ' · no merge' : ''
  if (l.current === undefined) return `Running${mode}${retrying}`
  const step = l.step === 'asked' ? `waiting on ${c?.owner ?? 'its owner'}` :
    l.step === 'orca' ? `waiting on the agent in ${l.by ?? 'Orca'}` :
    l.step === 'model' ? "with this session's model" : l.step === 'merging' ? 'merging' : 'checking'
  return `Running${mode} · #${l.current} ${step}${l.stepAt !== undefined ? ` since ${ago(now, l.stepAt)}` : ''} · round ${l.attempts}/${MAX_ROUNDS}${retrying}`
}

function report(l: Loop, rows: PrRow[]): string {
  return rows.map(r => {
    const o = l.outcomes[r.number]
    return `- #${r.number} ${r.title}: ${o ? `${o.kind}, ${o.detail}${o.by ? ` (fixed by ${o.by})` : ''}` : 'not finished'}`
  }).join('\n')
}

// The loop's message to an owning session that has sat idle past STALE_MS: compact it before the
// message starts a turn on a cold prompt cache.
async function compactIfStale($: EngineInterface, e: { origin: object; text: string }): Promise<void> {
  const now = await $.clock.now()
  const at = (await read($, activity)).at ?? now
  await update($, activity, () => ({ at: now }))
  const isFromLoop = 'plugin' in e.origin && e.origin.plugin === 'ndev'
  if (!isFromLoop || now - at <= STALE_MS) return
  const pr = /PR #\d+/.exec(e.text)?.[0] ?? 'the pull request'
  const idle = `${Math.round((now - at) / 60_000)} minutes`
  try {
    const { skip } = await $.session.compact({ instructions: `Keep what this session knows about ${pr}: its branch, worktree, changes and open checks.` })
    $.ui.toast(skip ? `fix-all-prs: compaction before ${pr} skipped: ${skip}` : `fix-all-prs: compacted after ${idle} idle, before ${pr}`)
  } catch (err) {
    // The message still goes through: a failed compaction costs a cold cache, not the fix.
    $.ui.toast(`fix-all-prs: compaction after ${idle} idle failed, before ${pr}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function openPane($: EngineInterface): Promise<unknown> {
  return $.ui.open({ id: PANE, title: TITLE })
}

// Registers /fix-prs and the report tool, and picks the loop up where it stood.
// The plugin's session.start hook calls it: a plugin hooks each event once.
export async function startFixAllPrs($: EngineInterface) {
  await $.command.register({
    name: 'fix-prs',
    description: 'Run the loop that fixes and merges every open pull request of this repository, oldest first (--no-merge leaves the merge to a human)',
    argumentHint: '[start [--no-merge]|status|pause|resume|skip <pr>|retry <pr>]',
  })
  await $.tool.register({
    name: 'report',
    description:
      'Report to the fix-all-prs loop what became of the pull request it handed you: "pushed" once a fix is pushed, ' +
      'or "blocked" with the reason when it needs the user. The loop then waits for the checks and merges, or records the block.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number', description: 'The pull request number' },
        outcome: { type: 'string', enum: ['pushed', 'blocked'] },
        reason: { type: 'string', description: 'Why it is blocked' },
      },
      required: ['pr', 'outcome'],
    },
    isDeferred: false,
  })
  const now = await $.clock.now()
  await update($, activity, a => (a.at === undefined ? { at: now } : a))
  // Pick the loop up where it stood, and keep the list current.
  tickLater($)
  $.clock.every(TICK_MS, () => tickLater($))
}

// A main-agent turn ended: the loop reads this as the session's last activity.
// register.ts calls it from the plugin's one turn.complete hook.
export async function fixAllPrsTurn($: EngineInterface, e: TurnCompleteInput) {
  if (e.agentId !== undefined) return
  const now = await $.clock.now()
  await update($, activity, () => ({ at: now }))
}

// The fix-all-prs loop's other hooks: the /fix-prs command, its report tool and the PR queue pane.
export const fixAllPrs = (on: On) => {
  // Answers at once: the work runs detached, since a slow gh would outlast the hook's budget.
  on('command.run', { command: 'fix-prs' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const options = words.filter(w => w.startsWith('--'))
    const [verb = 'start', arg] = words.filter(w => !w.startsWith('--'))
    const unknown = options.find(o => o !== '--no-merge' || verb !== 'start')
    if (unknown) return { text: `/fix-prs ${verb} does not know "${unknown}". The one option is /fix-prs start --no-merge.` }
    const isNoMerge = options.includes('--no-merge')
    const n = Number(arg)
    if ((verb === 'skip' || verb === 'retry') && !Number.isInteger(n)) {
      return { text: `/fix-prs ${verb} needs a pull request number, for example /fix-prs ${verb} 182.` }
    }
    const work = verb === 'start' ? start($, isNoMerge) : verb === 'pause' ? setPhase($, 'paused') : verb === 'resume' ? setPhase($, 'running')
      : verb === 'skip' ? skip($, n) : verb === 'retry' ? retry($, n) : verb === 'status' ? refresh($, false) : undefined
    if (work === undefined) return { text: `/fix-prs does not know "${verb}". Use start, status, pause, resume, skip <pr> or retry <pr>.` }
    void work.catch((err: unknown) => $.ui.toast(`/fix-prs ${verb} failed: ${err instanceof Error ? err.message : String(err)}`))
    void openPane($)
    if (isNoMerge) return { text: 'start requested without merging: the loop leaves each green pull request for a human to merge. The PR queue pane shows the loop.' }
    if (verb !== 'status') return { text: `${verb} requested. The PR queue pane shows the loop.` }
    const l = await read($, loop)
    const { repo, rows } = await read($, snapshot)
    return { text: `fix-all-prs for ${repo ?? 'this repository'}: ${where(l, undefined, await $.clock.now())}${rows.length ? `\n${report(l, rows)}` : ''}` }
  }).catch(($, e, next) => ({
    text: `/fix-prs ${e.args} failed (${next.error.kind} after ${next.error.budget} ms): ${next.error.message ?? 'no message'}`,
  }))

  // The model reports a fix pushed, or a block that needs the user.
  // Matched on the tool: the walk-doc guard is the plugin's one tool.call hook that sees every call.
  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    // The engine passes the tool's arguments on the event itself, beside `tool`.
    const input = e as unknown as { pr?: number; outcome?: string; reason?: string }
    const l = await read($, loop)
    if (input.pr === undefined || input.pr !== l.current) {
      return { result: `Refused: the loop is on #${l.current ?? 'nothing'}, not #${input.pr}.`, isError: true as const }
    }
    // An owner took it over from the model: the model's report would end the owner's round.
    if (l.step !== 'model') {
      return { result: `Refused: #${input.pr} is not with this session's model now (${l.by ?? 'nobody'} has it). Stop work on it.`, isError: true as const }
    }
    if (input.outcome === 'blocked') {
      await settle($, input.pr, { kind: 'blocked', detail: input.reason ?? 'no reason given', by: 'this session' })
    } else {
      await update($, loop, (s): Loop => ({ ...s, isRoundDone: true }))
      await note($, `#${input.pr}: this session's model pushed a fix`)
    }
    tickLater($)
    return { result: `Recorded #${input.pr} as ${input.outcome}. The loop takes it from here.` }
  })

  // Every message to another agent: the model's SendMessage and this mod's own.
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    const to = e.to.replace(/\s*\[[^\]]*\]$/, '')
    const name = await nameAt($, to).catch(async (err: unknown) => {
      await note($, `${to}: its session could not be named, so the message is recorded under the address: ${err instanceof Error ? err.message : String(err)}. Repair: message the owner by the name ListAgents shows.`)
      return to
    })
    await recordSent($, name, e.text, sent.isDelivered ? undefined : sent.reason)
    return sent
  })

  // A reply or an idle notice from an owner: matched by the owner's name in the delivery.
  // In an owning session, the loop's own message compacts a session that sat idle first.
  on('session.receive', async ($, e, next) => {
    if (e.agentId === undefined) await compactIfStale($, e)
    const all = await read($, comms)
    const from = (/from-name="([^"]+)"/.exec(e.text) ?? /from="([^"]+)"/.exec(e.text))?.[1]?.replace(/\s*\[[^\]]*\]$/, '')
    const hits = Object.entries(all).filter(([, c]) =>
      c.owner !== undefined && (from === c.owner || new RegExp(`\\b${c.owner.replace(/[-.]/g, '\\$&')}\\b`).test(e.text)))
    if (hits.length) {
      const now = await $.clock.now()
      const isIdle = /idle notice/i.test(e.text)
      const heard = isIdle ? 'went idle' : firstLine(e.text)
      const isBlocked = !isIdle && /^\s*blocked:/im.test(e.text.replace(/<[^>]+>/g, ''))
      await update($, comms, cur => {
        const copy = { ...cur }
        for (const [n] of hits) copy[n] = { ...copy[n], heardAt: now, heard, isBlocked }
        return copy
      })
      if ((await read($, loop)).phase === 'running') tickLater($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { repo, rows, checkedAt, error, isBusy, agentsError, orcaError } = await read($, snapshot)
    const owners = await read($, comms)
    const l = await read($, loop)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    // The title's room: the marker, the status word and the number before it, the Open button after.
    const width = Math.max(20, columns - 2 - 9 - 6 - 8)
    const done = rows.filter(r => r.state !== 'OPEN' || l.outcomes[r.number]).length
    const fit = (s: string, w = width) => (s.length > w ? `${s.slice(0, w - 1)}…` : s)
    const pad = '             '
    // A line under a row: its room past the indent, so it never wraps back to the left edge.
    const under = Math.max(20, columns - pad.length - 1)
    const isRunning = l.phase === 'running'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Box justifyContent="space-between">
            <Text weight="bold" color="claude">{repo ?? 'No repository read yet'}</Text>
            <Text color="subtle">
              {rows.length ? `${done} of ${rows.length} done` : 'No queue'}
              {checkedAt > 0 ? ` · ${new Date(checkedAt).toLocaleTimeString()}` : ''}
              {isBusy ? ' · refreshing…' : ''}
            </Text>
          </Box>
          <Text color={l.phase === 'paused' && l.error ? 'error' : isRunning ? 'warning' : l.phase === 'done' ? 'success' : 'subtle'}>
            {fit(where(l, l.current === undefined ? undefined : owners[l.current], now), columns - 4)}
          </Text>
        </Box>
        <Box gap={2}>
          {isRunning
            ? <Button key="pause" label="Pause" hotkey="p" plain onPress={() => { void setPhase($, 'paused') }} />
            : l.phase === 'paused'
              ? <Button key="resume" label="Resume" hotkey="p" plain onPress={() => { void setPhase($, 'running') }} />
              : <Box gap={2}>
                <Button key="start" label="Start" hotkey="s" plain onPress={() => { void start($) }} />
                <Button key="start-no-merge" label="Start No Merge" hotkey="n" plain onPress={() => { void start($, true) }} />
              </Box>}
          {isRunning && l.current !== undefined &&
            <Button key="skip" label={`Skip #${l.current}`} hotkey="k" plain onPress={() => { void skip($, l.current!) }} />}
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => refreshLater($, false)} />
        </Box>
        {error && <Text color="error">{error}</Text>}
        {agentsError && <Text color="warning">Agents not listed: {agentsError}</Text>}
        {orcaError && <Text color="warning">Orca workspaces not read: {orcaError}</Text>}
        {rows.length === 0 && !error && <Text color="subtle">Start reads your open pull requests, oldest first, and works them one at a time.</Text>}
        <Box flexDirection="column" gap={1}>
          {rows.map(r => {
            const o = l.outcomes[r.number]
            const m = mark(r, o)
            const isCurrent = r.number === l.current && !o
            const c = owners[r.number]
            const line = talk(c, now)
            const isSettled = !!o && o.kind !== 'blocked'
            return (
              <Box key={String(r.number)} flexDirection="column">
                <Box justifyContent="space-between">
                  <Text weight={isCurrent ? 'bold' : 'regular'}>
                    <Text color="claude">{isCurrent ? '▶ ' : '  '}</Text>
                    <Text color={m.color}>{m.word.padEnd(9)}</Text>
                    <Text color="suggestion">#{r.number}</Text>
                    <Text color={isSettled ? 'subtle' : 'text'}> {fit(r.title)}</Text>
                  </Text>
                  <Box gap={2}>
                    {(o?.kind === 'blocked' || o?.kind === 'skipped') &&
                      <Button key={`retry-${r.number}`} label="Retry" plain onPress={() => { void retry($, r.number) }} />}
                    <Button key={`open-${r.number}`} label="Open" plain dimColor
                      onPress={() => { void $.process.run(['gh', 'pr', 'view', String(r.number), '--web']) }} />
                  </Box>
                </Box>
                {o && <Text color={o.kind === 'blocked' ? 'error' : 'subtle'}>
                  {pad}{fit(`${o.detail}${o.by ? ` · by ${o.by}` : ''}`, under)}
                </Text>}
                {!o && r.state === 'OPEN' && r.failing.length > 0 && <Text color="error">{pad}{fit(r.failing.join(', '), under)}</Text>}
                {!o && r.state === 'OPEN' && c?.title && <Text color="merged" italic>{pad}{fit(`“${c.title}”`, under)}</Text>}
                {!o && r.state === 'OPEN' && <Text color={line.color ?? 'subtle'}>{pad}{fit(line.text, under)}</Text>}
              </Box>
            )
          })}
        </Box>
        {l.log.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text weight="bold" color="claude">Activity</Text>
            {l.log.slice(-8).map((entry, i) => (
              <Text key={`log-${i}`}>
                <Text color="subtle">{new Date(entry.at).toLocaleTimeString()} </Text>{fit(entry.text, columns - 16)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // A one-line band above the prompt while the loop has work.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, loop)
    const { rows } = await read($, snapshot)
    if (e.props.hasSurvey || l.phase === 'idle' || rows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const c = l.current === undefined ? undefined : (await read($, comms))[l.current]
    const done = rows.filter(r => r.state !== 'OPEN' || l.outcomes[r.number]).length
    const blocked = Object.values(l.outcomes).filter(o => o.kind === 'blocked').length
    return (
      <Box gap={1}>
        <Text>
          <Text dimColor>PR queue </Text>
          <Text color={l.phase === 'paused' ? 'error' : l.phase === 'running' ? 'warning' : 'success'}>{where(l, c, await $.clock.now())}</Text>
          <Text dimColor> · {done}/{rows.length} done{blocked ? ` · ${blocked} blocked` : ''}</Text>
        </Text>
      </Box>
    )
  })
}
