// The workflow tools: each one does the work of a phase, records the state in the worktree's
// .neil-dev.worktree.json, and answers with the next step. machine.ts decides the moves.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { reportBug, reportFault } from './bug-report'
import { iNeedA, NEED_KINDS } from './i-need-a'

import type { LoadedConfig, ProjectLevel } from '../config'
import { readSettings } from '../worktree-settings'
import { RECORD } from '../worktree-stacks'
import { isComponent, reviewText } from '../component-files'
import { CHECK_DIR, MARKER, Refuse, defaultBranch, markReady, repoFromOrigin, gh, ghLines, ghOne, changedPaths, comment, git, gitOut, head, missingChecks, must, newFeedback, orca, paths, porcelain, raiseAlert, readChecks, readPr, run, runCheck, said, withdrawAlert } from './effects'
import type { Check } from './effects'
import { CHANGE_TYPES, inferChangeTypes, isDocsOnly, isDocsPath, isWebPath, requiredSmokeTypes, reviewerBrief, type ChangeType } from './change-types'
import { CHANGE_MAP_LIMIT, buildChangeMap, changeMapBlock, withChangeBlock } from './change-map'
import { takeScreenshots } from './screenshot'
import { liveCallEnd, liveCallStart, liveName, shownArgs, shownValue, writeLive } from './live'
import { ATTEMPT_LIMIT, afterStarted, afterTool, mayCommitToBase, mayMerge, maySkipReview, needsSmoke, nextStep, orcaView, hooksFiredBy, type OrcaView, type StageHook } from './machine'
import type { Facts, Position, State, Tool } from './machine'
import { SECRET_NAME, findInText, secretFiles } from './secrets'

async function checked($: EngineInterface, wf: Workflow, check: Check, args: string[] = []): Promise<string | undefined> {
  if (wf.noChecks && !(await $.fs.exists(`${wf.root}/${CHECK_DIR}/${check}`))) return `${CHECK_DIR}/${check} did not run: the human skipped the set-up.`
  return runCheck($, wf.root, wf.base, check, args)
}

export type Evidence = { sha: string; text: string }
export type IssueSettings = { mode?: 'light' | 'heavy'; steering?: 'interactive' | 'auto' }

export type Workflow = {
  rev?: number
  // The issue, or on a PR record its lead: the lowest number of its issues.
  issue: number
  // Only on a PR record, which the worktree file holds under prs from the merge point on.
  pr?: number
  issues?: number[]
  root: string
  repo: string
  base: string
  branch: string
  direct?: boolean
  prs: number[]
  // Two to five lower-case words from the agent. The Orca workspace is <issue>-<shortName>.
  shortName?: string
  // What Orca shows now, so that a save sends only a change.
  orca?: OrcaView
  doneMessage?: string
  state: State
  previous?: State
  owner?: { session: string; at: number }
  // The session that released the workflow when it ended, so that it can find the workflow again on resume.
  lastSession?: string
  releasedAt?: number
  evidence: { review?: Evidence; checks?: Evidence & { byHuman?: boolean }; smoke?: Evidence }
  // /flow off: the record stays, and the tools and reminders stop.
  off?: { at: number; reason: string }
  // /flow skip in setup: the commits go on without the missing check scripts.
  noChecks?: boolean
  // The heartbeat saw every PR merged or closed, so it reads GitHub no more.
  prsClosed?: boolean
  attempts: number
  nudges: { count: number; fingerprint?: string }
  followUps: { hash: string; mode: string; issue: number; title: string; worktree?: string }[]
  // The record of a followUp subagent's own worktree: the issue it came from. The session's Orca
  // workspace shows the session's workflow, not this one.
  followUpOf?: number
  migrations: { name: string; path: string }[]
  merged?: boolean
  feedbackAt?: number
  blocked?: { message: string; at: number; group: string; pid?: number }
  // This issue only. With no value, it follows the worktree and then the project.
  mode?: 'light' | 'heavy'
  steering?: 'interactive' | 'auto'
  waiting?: { id: string; tool: string; what: string; at: number; period?: number; most?: number; timeoutS?: number; args?: Record<string, string>; alert?: { group: string; pid?: number } }
  waitAnswer?: { id: string; message: string }
  op?: { id: string; tool: string }
  history: { at: number; tool: string; from?: State; to: State }[]
  // The stage hooks that a change of state fired, and the result that the tool leaving the stage took.
  hooks?: Partial<Record<StageHook, { firedAt: number; result?: string; agentId?: string; answer?: string }>>
  // Heavy mode only: the second reviewer. hooks.review holds the standards axis, this the specification axis.
  reviewSpec?: { agentId?: string; answer?: string }
  // What the change holds: the union of each type that the agent declared and that the diff showed.
  changeTypes?: ChangeType[]
  // The changed web files, for the screenshots that the next step asks for.
  webFiles?: string[]
  // Why the last read of the diff failed. Until the next good read, nothing is called documents only.
  typesUnread?: string
}

const OWNER_LIVE_MS = 10 * 60_000
const HISTORY_LIMIT = 50
const SECTION = /<!-- ndev:migrations -->[\s\S]*?<!-- \/ndev:migrations -->\n?/

const workflowRoot = atom({ plugin: 'ndev', key: 'workflowRoot' } as const, null as string | null, { shape: 'workflow-root-1' })
// The issue that this agent works on now. A worktree can hold several; each agent has its own.
const workflowIssue = atom({ plugin: 'ndev', key: 'workflowIssue' } as const, null as number | null, { shape: 'workflow-issue-1' })
// The commit whose pending checks refused `done`. The session watches them as it does in `ci`.
// The human chose to work without the workflow in this session.
const workflowDeclined = atom({ plugin: 'ndev', key: 'workflowDeclined' } as const, false, { shape: 'workflow-declined-1' })
// The worktrees of the agents that followUp started: each commits there through checkpoint.
const followUpWorktrees = atom({ plugin: 'ndev', key: 'workflowFollowUpWorktrees' } as const, [] as string[], { shape: 'workflow-follow-up-worktrees-1' })
const doneWaitsFor = atom({ plugin: 'ndev', key: 'workflowDoneWaitsFor' } as const, null as string | null, { shape: 'workflow-done-waits-1' })
export async function boundRoot($: EngineInterface): Promise<string | null> {
  return read($, workflowRoot)
}
function envScript($: EngineInterface) {
  return `${$.plugin.root}/scripts/work/worktree-env.sh`
}

async function bind($: EngineInterface, root: string, issue: number): Promise<void> {
  await update($, workflowRoot, () => root)
  await update($, workflowIssue, () => issue)
}

// Each issue in this worktree's record. The old "workflow" key still reads, until the next write moves it.
export type HeldRecords = { issues: Workflow[]; prs: Workflow[] }
export async function readHeld($: EngineInterface, root: string): Promise<HeldRecords> {
  const path = `${root}/${RECORD}`
  if (!(await $.fs.exists(path))) return { issues: [], prs: [] }
  try {
    const held = JSON.parse(await $.fs.read(path)) as { workflow?: Workflow; workflows?: Record<string, Workflow>; prs?: Record<string, Workflow> }
    const all: Record<string, Workflow> = { ...(held.workflow ? { [held.workflow.issue]: held.workflow } : {}), ...held.workflows }
    const filled = (wf: Workflow) => ({ ...wf, migrations: wf.migrations ?? [] })
    return { issues: Object.values(all).map(filled), prs: Object.values(held.prs ?? {}).map(filled) }
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)}). Repair: fix the file, then call the tool again.`)
  }
}

export async function readWorkflows($: EngineInterface, root: string): Promise<Workflow[]> {
  return (await readHeld($, root)).issues
}

// An issue that finished development belongs to its PR record, while that PR is past its developers.
const effectiveRecord = (wf: Workflow, prs: Workflow[]) => (wf.state === 'developed' ? prs.find(p => p.pr === wf.prs[0] && p.state !== 'developing') : undefined) ?? wf

// One entry for each thing a worktree is doing now: an issue, or a PR that took its issues over.
export async function readEffective($: EngineInterface, root: string): Promise<Workflow[]> {
  const { issues, prs } = await readHeld($, root)
  return [...new Set(issues.map(wf => effectiveRecord(wf, prs)))]
}

export const sameRecord = (a: Workflow, b: Workflow) => a.pr === b.pr && (a.pr !== undefined || a.issue === b.issue)
export const labelOf = (wf: Workflow) => (wf.pr ? `PR #${wf.pr}` : `issue #${wf.issue}`)
const issuesOf = (wf: Workflow) => wf.issues ?? [wf.issue]
export const whoOf = (wf: Workflow) => (wf.pr ? `PR #${wf.pr} (${(wf.issues ?? [wf.issue]).length > 1 ? 'issues' : 'issue'} ${(wf.issues ?? [wf.issue]).map(n => `#${n}`).join(', ')})` : `Issue #${wf.issue}`)

// The record that this session owns, or else the one it released last, with an unfinished one first.
function ownRecord(all: Workflow[], session: string): Workflow | undefined {
  const owned = all.filter(wf => wf.owner?.session === session).sort((a, b) => b.owner!.at - a.owner!.at)[0]
  if (owned) return owned
  const released = all.filter(wf => !wf.owner && wf.lastSession === session)
  const newest = (list: Workflow[]) => list.sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0))[0]
  return newest(released.filter(wf => wf.state !== 'done')) ?? newest(released)
}

// With an issue: the record for it. With none: the record of this agent, which is the issue it is on.
// A worktree can hold several issues, and only the agent's own one counts as its workflow.
export async function loadWorkflow($: EngineInterface, root: string, issue?: number): Promise<Workflow | undefined> {
  const { issues, prs } = await readHeld($, root)
  const resolved = (n: number) => {
    const found = issues.find(wf => wf.issue === n)
    return found ? effectiveRecord(found, prs) : prs.find(p => p.issues?.includes(n))
  }
  if (issue !== undefined) return resolved(issue)
  const all = [...new Set(issues.map(wf => effectiveRecord(wf, prs)))]
  if (!all.length) return undefined
  if ((await read($, workflowRoot)) === root) {
    const active = await read($, workflowIssue)
    const found = active === undefined || active === null ? undefined : resolved(active)
    if (found) return found
  }
  if (all.length === 1) return all[0]
  return ownRecord(all, await $.session.id())
}

async function loadPrRecord($: EngineInterface, root: string, pr: number): Promise<Workflow | undefined> {
  return (await readHeld($, root)).prs.find(p => p.pr === pr)
}

// Each other record on this PR: its issues and its PR record.
async function prSiblings($: EngineInterface, wf: Workflow): Promise<Workflow[]> {
  if (wf.direct || !wf.prs[0]) return []
  const { issues, prs } = await readHeld($, wf.root)
  return [...issues, ...prs].filter(o => o.prs[0] === wf.prs[0] && !sameRecord(o, wf))
}

// One place, so that each way the state changes reaches Orca: a tool, the heartbeat and /workflow.
// An Orca that fails does not stop the work. The next save sends the change again.
async function syncOrca($: EngineInterface, wf: Workflow): Promise<void> {
  if (wf.followUpOf || !(await $.env.get('ORCA_WORKSPACE_ID'))) return
  const now = orcaView(wf)
  const was = wf.orca
  const args = [
    ...(now.name && now.name !== was?.name ? ['--display-name', now.name] : []),
    ...(now.issue !== was?.issue ? ['--issue', String(now.issue)] : []),
    ...(now.pr && now.pr !== was?.pr ? ['--pr', String(now.pr)] : []),
    ...(now.status !== was?.status ? ['--workspace-status', now.status] : []),
    ...(now.comment !== was?.comment ? ['--comment', now.comment] : []),
    ...(now.attention !== !!was?.attention ? [now.attention ? '--unread' : '--read'] : []),
  ]
  if (!args.length) return
  const problem = await orca($, wf.root, args)
  if (problem) $.ui.toast(`workflow: Orca does not show the state of #${wf.issue} in ${wf.root} (${now.comment.slice(0, 60)}): ${problem}. The next change of state tries again.`)
  else wf.orca = now
}

export async function saveWorkflow($: EngineInterface, wf: Workflow): Promise<void> {
  await syncOrca($, wf)
  const history = wf.history.slice(-HISTORY_LIMIT)
  const r = await run($, ['bash', envScript($), 'set-workflow', '--expect-rev', String(wf.rev ?? 0), '--worktree', wf.root], { cwd: wf.root, stdin: JSON.stringify({ ...wf, history }), timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error(`worktree-env.sh set-workflow exited ${r.exitCode} for ${wf.root}: ${said(r)}`)
  wf.rev = (wf.rev ?? 0) + 1
}

// A PR that carries several issues follows the strictest of them.
export const strictest = (records: IssueSettings[]): IssueSettings => {
  const pick = <T extends string>(values: (T | undefined)[], strict: T) => (values.includes(strict) ? strict : values.find(Boolean))
  const mode = pick(records.map(r => r.mode), 'heavy')
  const steering = pick(records.map(r => r.steering), 'interactive')
  return { ...(mode ? { mode } : {}), ...(steering ? { steering } : {}) }
}

// What a record of several issues stores. An issue with no setting counts with what it inherits. When no
// issue has its own setting, the record stores none, so it goes on following the worktree.
async function settingsOfAll($: EngineInterface, root: string, project: LoadedConfig | undefined, records: IssueSettings[]): Promise<IssueSettings> {
  const resolved: IssueSettings[] = []
  for (const r of records) {
    const facts = await factsFor($, root, project, r)
    resolved.push({ mode: facts.mode, steering: facts.steering })
  }
  const all = strictest(resolved)
  return { ...(records.some(r => r.mode) ? { mode: all.mode } : {}), ...(records.some(r => r.steering) ? { steering: all.steering } : {}) }
}

// The settings of one issue win over the worktree, and the worktree wins over the project.
export async function factsFor($: EngineInterface, root: string, project: LoadedConfig | undefined, own?: IssueSettings): Promise<Facts> {
  let settings
  try {
    settings = await readSettings($, root)
  } catch {
    settings = undefined
  }
  return {
    mode: (own?.mode ?? settings?.mode ?? project?.config.mode ?? 'light') as Facts['mode'],
    steering: (own?.steering ?? settings?.steering ?? project?.config.steering ?? 'interactive') as Facts['steering'],
    level: project?.config.projectLevel as ProjectLevel | undefined,
  }
}

export function moved(wf: Workflow, tool: string, to: Position, at: number) {
  wf.history.push({ at, tool, from: wf.state, to: to.state })
  for (const hook of hooksFiredBy(wf.state, to.state)) {
    wf.hooks = { ...wf.hooks, [hook]: { firedAt: at } }
    wf.history.push({ at, tool: `hook:${hook}`, from: to.state, to: to.state })
  }
  wf.state = to.state
  wf.previous = to.previous
  if (to.state !== 'wait') wf.waiting = undefined
}

// A declaration of docs proves nothing when the diff could not be read.
const reviewTypes = (wf: Workflow): ChangeType[] => (wf.changeTypes ?? []).filter(type => !wf.typesUnread || type !== 'docs')

export const stepOf = (wf: Workflow, facts: Facts) => nextStep(wf.state, { ...facts, merged: wf.merged, remembered: !!wf.hooks?.remember?.result, changeTypes: reviewTypes(wf), webFiles: wf.webFiles })

async function answer($: EngineInterface, wf: Workflow, facts: Facts, detail: string[] = []): Promise<string> {
  const lines = [`State: ${wf.state}. ${whoOf(wf)}. Worktree: ${wf.root}.`, ...detail.filter(Boolean)]
  if (wf.prs[0]) lines.push(`PR: https://github.com/${wf.repo}/pull/${wf.prs[0]}`)
  const others = (await readEffective($, wf.root)).filter(o => !sameRecord(o, wf) && o.state !== 'done')
  if (others.length) lines.push(`Other issues in this worktree: ${others.map(o => `${o.pr ? `PR #${o.pr}` : `#${o.issue}`} ("${o.state}"${!o.pr && o.prs[0] && o.prs[0] === wf.prs[0] ? `, same PR #${o.prs[0]}` : ''})`).join(', ')}.`)
  lines.push(`Next: ${stepOf(wf, facts)}`)
  return lines.join('\n')
}

// Enters the blocked state: the persistent alert and the Orca flag reach the human.
export async function enterBlocked($: EngineInterface, wf: Workflow, message: string, previous: State, tool: string): Promise<string[]> {
  const notes: string[] = []
  const alert = await raiseAlert($, wf.root, wf.issue, message)
  if (alert.problem) notes.push(`No persistent notification: ${alert.problem}`)
  $.ui.notify(message, { title: `ndev: #${wf.issue} is blocked` })
  wf.blocked = { message, at: await $.clock.now(), group: alert.group, pid: alert.pid }
  moved(wf, tool, { state: 'blocked', previous }, wf.blocked.at)
  return notes
}

// The watchdog's way in: a stalled session blocks like any other.
export async function blockWorkflow($: EngineInterface, wf: Workflow, message: string): Promise<void> {
  if (wf.state === 'blocked' || wf.state === 'wait' || wf.state === 'done') return
  await enterBlocked($, wf, message, wf.state, 'watchdog')
  await saveWorkflow($, wf)
}

async function commitAndPush($: EngineInterface, wf: Workflow, tool: string, message: string, files: string[], push = true, declared: readonly ChangeType[] = []): Promise<string[]> {
  const { root, base, branch } = wf
  const current = await gitOut(root, $, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (current !== wf.branch) throw new Refuse(`The worktree ${root} is on ${current}, and this workflow is on ${branch}. Nothing was committed. Repair: git switch ${branch}.`)
  if (branch === base && !wf.direct) throw new Refuse(`Refused: ${branch} is the base branch. Only a straw_man project commits to it.`)
  const notes: string[] = []
  // The intent comes first: after a crash, the retry finds the commit by this trailer.
  const op = wf.op?.tool === tool ? wf.op : { id: `${tool}-${await $.clock.now()}`, tool }
  wf.op = op
  await saveWorkflow($, wf)
  const made = await gitOut(root, $, 'log', '-1', '--format=%H', `--grep=^Ndev-Op: ${op.id}$`)
  // A retry can carry a fix for what stopped the last try, so what is named is always committed.
  if (files.length) await must($, ['git', 'add', '--', ...files], { cwd: root })
  const staged = (await git(root, $, 'diff', '--cached', '--quiet')).exitCode !== 0
  if (staged) {
    try {
      // The fast tools first: they name the line in seconds, before the slower script starts.
      const stagedFiles = (await gitOut(root, $, 'diff', '--cached', '--name-only', '--diff-filter=d')).split('\n').filter(Boolean)
      for (const note of [await checked($, wf, 'fast-checks.sh', stagedFiles), await checked($, wf, 'pre-commit-check.sh')]) {
        if (note) notes.push(note)
      }
    } catch (error) {
      // A refused commit leaves nothing staged, or a later commit of other files would carry these.
      if (files.length) await must($, ['git', 'reset', '-q', '--', ...files], { cwd: root })
      throw error
    }
    await must($, ['git', 'commit', '-m', message, '--trailer', `Ndev-Op: ${op.id}`], { cwd: root })
  } else if (made) {
    // The last try stopped after its commit. A change in the tree may be the fix for that stop, and
    // the checks would test it while the push sends the commit without it.
    const changed = changedPaths((await porcelain($, root)).filter(l => !l.startsWith('??')))
    if (changed.length) throw new Refuse(`Refused: the commit ${made.slice(0, 8)} from an earlier try is not pushed, and these files changed after it: ${changed.join(', ')}. Name them in files to commit them too. Nothing was pushed.`)
    notes.push(`The commit ${made.slice(0, 8)} from an earlier try is already here, so it was not made again.`)
  }
  const upstream = await git(root, $, 'rev-parse', `origin/${branch}`)
  if (push && upstream.stdout.trim() !== (await head(root, $))) {
    const note = await checked($, wf, 'pre-push-check.sh')
    if (note) notes.push(note)
    const mapNote = await writeChangeMap($, wf, declared)
    if (mapNote) notes.push(mapNote)
    const pushed = await run($, ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, timeoutMs: 300_000 })
    if (pushed.exitCode !== 0) throw new Refuse(`git push of ${branch} exited ${pushed.exitCode}: ${said(pushed)}\nThe commit is local. Fix the cause (git pull --rebase for a rejected push) and call the tool again.`)
  }
  wf.op = undefined
  return notes
}

async function flagForHuman($: EngineInterface, wf: Workflow, notes: string[]) {
  if (wf.prs[0] && notes.length) await comment($, wf.root, wf.repo, wf.prs[0], `${MARKER}\n**work-heavy-auto:** ${notes.join(' ')}`)
}

async function noAgentsRunning($: EngineInterface) {
  const running = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending')
  if (running.length) throw new Refuse(`Refused: ${running.length} agent(s) still run (${running.map(a => a.id).join(', ')}), and their edits could enter this commit. Nothing changed. Wait for them, then call the tool again.`)
}

const CLOSING = '\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+(?:(?:[\\w.-]+\\/[\\w.-]+)?#|https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/issues\\/)'
const hasIssueRef = (body: string, n: number) => new RegExp(`${CLOSING}${n}\\b`, 'i').test(body)

// Each reason that `done` must refuse, so that the agent fixes them all in one pass.
// A migration file in this change that nothing will run after the merge. The change itself is the
// evidence, so this makes no GitHub call. A direct workflow has no merge step, so it has none.
async function unlistedMigrations($: EngineInterface, wf: Workflow): Promise<string[]> {
  if (wf.direct) return []
  const r = await git(wf.root, $, 'diff', '--name-only', `origin/${wf.base}...HEAD`)
  if (r.exitCode !== 0) throw new Error(`git diff exited ${r.exitCode} in ${wf.root}: ${said(r)}`)
  const listed = new Set([wf, ...(await prSiblings($, wf))].flatMap(o => o.migrations.map(m => m.path)))
  return r.stdout.split('\n').filter(f => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(f) && !listed.has(f))
}

const migrationText = (files: string[]) => `Nothing will run these migration files after the merge: ${files.join(', ')}. Repair: call addMigration with a name, move the SQL into the file it makes, and delete the old file.`

async function doneProblems($: EngineInterface, wf: Workflow, sha: string): Promise<{ problems: string[]; feedback: string[] }> {
  const { root, repo } = wf
  const problems: string[] = []
  const dirty = await porcelain($, root)
  if (dirty.length) problems.push(`The tree is not clean: ${changedPaths(dirty).join(', ')}.`)
  const upstream = await git(root, $, 'rev-parse', `origin/${wf.branch}`)
  if (upstream.stdout.trim() !== sha) problems.push(`HEAD ${sha.slice(0, 8)} is not pushed to origin/${wf.branch}. Call checkpoint.`)
  const unlisted = await unlistedMigrations($, wf)
  if (unlisted.length) problems.push(migrationText(unlisted))
  const stash = await gitOut(root, $, 'stash', 'list')
  if (stash.includes(`on ${wf.branch}:`) || stash.includes(`On ${wf.branch}:`)) problems.push(`A stash of ${wf.branch} remains. Apply or drop it.`)
  const humanSkip = wf.evidence.checks?.byHuman && wf.evidence.checks.sha === sha
  if (!humanSkip) {
    const checks = await readChecks($, root, repo, sha, wf.prs[0])
    if (checks.red.length) problems.push(`Red checks on HEAD: ${checks.red.join(', ')}.`)
    if (checks.pending.length) {
      problems.push(`Pending checks on HEAD: ${checks.pending.join(', ')}. Do not run a wait helper: the workflow watches them and prompts you when they end.`)
      await update($, doneWaitsFor, () => sha)
    }
  }
  if (wf.evidence.checks?.sha !== sha) problems.push('finishedChecks has no record for HEAD.')
  if (wf.evidence.smoke && wf.evidence.smoke.sha !== sha) problems.push(`The smoke evidence is for ${wf.evidence.smoke.sha.slice(0, 8)}, not HEAD.`)
  for (const m of wf.migrations) {
    const size = (await git(root, $, 'cat-file', '-s', `HEAD:${m.path}`)).stdout.trim()
    if (size === '') problems.push(`The migration ${m.path} is not committed. Call checkpoint.`)
    else if (size === '0') problems.push(`The migration ${m.path} is empty. Write its SQL and call checkpoint.`)
  }
  let feedback: string[] = []
  if (!wf.direct && wf.prs[0]) {
    const pr = await readPr($, root, repo, wf.prs[0])
    if (pr.state !== 'open') problems.push(`PR #${pr.number} is ${pr.state}.`)
    if (pr.draft) problems.push(`PR #${pr.number} is still a draft. Repair: gh pr ready ${pr.number}.`)
    if (pr.mergeable === false) problems.push(`PR #${pr.number} has conflicts with ${wf.base}. Merge ${wf.base} in and call checkpoint.`)
    if (pr.mergeable === null) problems.push(`GitHub has not finished computing whether PR #${pr.number} can merge. Call done again.`)
    if (pr.head.sha !== sha) problems.push(`PR #${pr.number} is at ${pr.head.sha.slice(0, 8)}, not HEAD ${sha.slice(0, 8)}. Repair: git pull --rebase origin ${wf.branch} when the PR is ahead; call checkpoint with no files when HEAD is ahead.`)
    const body = pr.body ?? ''
    for (const f of wf.followUps.filter(x => x.mode === 'this_agent')) {
      if (!hasIssueRef(body, f.issue)) problems.push(`The PR body has lost "Closes #${f.issue}". Put it back: that sub-issue is carried by this PR.`)
    }
    feedback = await newFeedback($, root, repo, wf.issue, pr, wf.feedbackAt ?? 0)
  }
  return { problems, feedback }
}

async function setUpPr($: EngineInterface, wf: Workflow, title: string, shared?: number): Promise<void> {
  if (wf.direct || wf.prs.length) return
  const open = shared ? [] : await ghLines<{ number: number }>($, wf.root, wf.repo, ['pr-list', '--head', wf.branch, '--state', 'open'])
  if (shared ?? open[0]) {
    wf.prs = [(shared ?? open[0]!.number)]
    // The branch's PR can carry several issues, and each one closes by it.
    await editBody($, wf, old => (hasIssueRef(old, wf.issue) ? old : `${old.trimEnd()}\n\nCloses #${wf.issue}\n`))
    return
  }
  const ahead = await gitOut(wf.root, $, 'rev-list', '--count', `origin/${wf.base}..HEAD`)
  if (ahead === '0') await must($, ['git', 'commit', '--allow-empty', '-m', `Start work on #${wf.issue}`, '--trailer', `Ndev-Op: start-${wf.issue}`], { cwd: wf.root })
  await must($, ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${wf.branch}`], { cwd: wf.root, timeoutMs: 300_000 })
  const { gitDir } = await paths($, wf.root)
  const bodyFile = `${gitDir}/ndev-pr-body.md`
  await $.fs.write(bodyFile, `Plan incoming.\n\nCloses #${wf.issue}\n`)
  const made = await gh($, wf.root, wf.repo, ['pr-new', '--title', title, '--body-file', bodyFile, '--base', wf.base, '--head', wf.branch])
  const number = /\/pull\/(\d+)/.exec(made)?.[1]
  if (!number) throw new Error(`gh.sh pr-new printed no pull request URL: ${made.slice(0, 200)}`)
  wf.prs = [Number(number)]
}

async function editBody($: EngineInterface, wf: Workflow, edit: (body: string) => string) {
  const pr = await readPr($, wf.root, wf.repo, wf.prs[0]!)
  const { gitDir } = await paths($, wf.root)
  const file = `${gitDir}/ndev-pr-body.md`
  const body = edit(pr.body ?? '')
  if (body === (pr.body ?? '')) return
  await $.fs.write(file, body)
  await gh($, wf.root, wf.repo, ['pr-edit', String(pr.number), '--body-file', file])
}

// Before the push, so that the event of the push carries the map. The map names its sha, so a map that
// was not written here does not match the next push, and CI runs everything: this never stops the push.
async function writeChangeMap($: EngineInterface, wf: Workflow, declared: readonly ChangeType[]): Promise<string | undefined> {
  if (wf.direct || !wf.prs[0]) return undefined
  const sha = await head(wf.root, $)
  const range = `origin/${wf.base}...HEAD`
  // With no rename detection, the old path of a moved file is in the map too.
  const diff = await git(wf.root, $, 'diff', '--name-only', '--no-renames', range)
  if (diff.exitCode !== 0) return `No change map for ${sha.slice(0, 8)}, so CI runs everything: git diff --name-only ${range} exited ${diff.exitCode}: ${said(diff)}. Repair: git fetch origin ${wf.base}.`
  const changed = diff.stdout.split('\n').filter(Boolean)
  const carried = wf.followUps.filter(f => f.mode === 'this_agent').map(f => f.issue)
  const onPr = (await readHeld($, wf.root)).issues.filter(o => o.prs[0] === wf.prs[0])
  const types = [...(wf.changeTypes ?? []), ...onPr.flatMap(o => o.changeTypes ?? []), ...declared]
  const map = buildChangeMap(sha, [...new Set([...issuesOf(wf), ...onPr.map(o => o.issue), ...carried])].sort((a, b) => a - b).map(issue => ({ issue, changeTypes: types })), changed)
  const block = changeMapBlock(map)
  try {
    await editBody($, wf, body => withChangeBlock(body, block))
  } catch (error) {
    return `No change map for ${sha.slice(0, 8)}, so CI runs everything: the edit of the body of PR #${wf.prs[0]} failed: ${String(error).slice(0, 300)}. The next push writes it again.`
  }
  return changed.length && !block ? `No change map for ${sha.slice(0, 8)}, so CI runs everything: the map of ${changed.length} files is over ${CHANGE_MAP_LIMIT} characters.` : undefined
}

type Args = Record<string, unknown> & { agentId?: string }
type Ctx = { args: Args; project: LoadedConfig | undefined; tool?: string }
const text = (a: Args, key: string) => (typeof a[key] === 'string' ? (a[key] as string).trim() : '')
const list = (a: Args, key: string) => (Array.isArray(a[key]) ? (a[key] as unknown[]).map(String) : [])

function declaredTypes(a: Args): ChangeType[] {
  const value = a.changeTypes
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(type => (CHANGE_TYPES as readonly unknown[]).includes(type))) throw new Refuse(`Refused: changeTypes is ${JSON.stringify(value)}. Use a list of: ${CHANGE_TYPES.join(', ')}. Nothing was committed.`)
  return value as ChangeType[]
}

const addTypes = (wf: Workflow, types: readonly ChangeType[]) => {
  wf.changeTypes = [...new Set([...(wf.changeTypes ?? []), ...types])]
}

const OFF_PROJECT = (path: string) => `Refused: the workflow is off for this project (${path} sets "workflow": false). Do the work without these tools, or ask the human to run /flow on project.`
const OFF_HERE = (wf: Workflow) => `Refused: the human turned this workflow off (${wf.off?.reason}). Do the work without these tools, or ask the human to run /flow on.`

// From the merge point on, these act on the PR and not on one issue.
const PR_TOOLS = ['finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'done']

async function current($: EngineInterface, { project, args, tool }: Ctx): Promise<Workflow> {
  if (project?.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  const root = (await read($, workflowRoot)) ?? project?.root
  // The pr of waitForPR is what it waits on, and not who is calling.
  const pr = args.pr !== undefined && tool !== 'waitForPR' ? Number(args.pr) : undefined
  const issue = args.issue !== undefined ? Number(args.issue) : undefined
  const wf = !root ? undefined : pr !== undefined ? await loadPrRecord($, root, pr) : await loadWorkflow($, root, issue)
  if (!wf) {
    if (pr !== undefined) throw new Refuse(`Refused: PR #${pr} has no workflow in ${root ?? 'this project'}. It gets one when finishedDevelopment has named all of its issues. Until then, give issue. Nothing changed.`)
    throw new Refuse(`Refused: this session has no workflow${issue !== undefined ? ` for issue #${issue}` : ''} in ${root ?? 'this project'}. Call started with the issue number first.`)
  }
  if (wf.off) throw new Refuse(OFF_HERE(wf))
  const active = await loadWorkflow($, wf.root)
  if (active && !sameRecord(active, wf) && !wf.issues?.includes(active.issue)) throw new Refuse(`Refused: this agent is on ${labelOf(active)}, and this call names ${wf.pr ? `PR #${wf.pr}` : `#${wf.issue}`}. Nothing changed. Repair: call started with issue ${wf.issue} to change to it, or name ${active.pr ? `pr ${active.pr}` : `issue ${active.issue}`}.`)
  if (wf.pr && tool && PR_TOOLS.includes(tool) && pr === undefined) throw new Refuse(`Refused: ${tool} acts on the PR from the review stage on, so give pr ${wf.pr}. It carries ${(wf.issues ?? [wf.issue]).map(n => `#${n}`).join(', ')}. Nothing changed.`)
  const session = await $.session.id()
  const now = await $.clock.now()
  if (wf.owner && wf.owner.session !== session && now - wf.owner.at < OWNER_LIVE_MS) throw new Refuse(`Refused: the session ${wf.owner.session} owns this workflow. Nothing changed. Leave it to that session. If that session is dead, call started with takeOver true.`)
  wf.owner = { session, at: now }
  return wf
}

async function move($: EngineInterface, c: Ctx, wf: Workflow, tool: Tool, facts: Facts, label: string = tool): Promise<void> {
  const to = afterTool({ state: wf.state, previous: wf.previous }, tool, facts)
  if ('refused' in to) throw new Refuse(to.refused)
  moved(wf, label, to, await $.clock.now())
}

// A cheap check before the work starts, so a wrong call costs no check-script run.
const legal = (wf: Workflow, tool: Tool, facts: Facts) => {
  const to = afterTool({ state: wf.state, previous: wf.previous }, tool, facts)
  if ('refused' in to) throw new Refuse(to.refused)
}

// The quality hook sees only a `git worktree add` in Bash, and started claims the worktree itself.
// Best effort, like the hook: a failure is a note, because a worktree without submodules can still work.
async function initSubmodules($: EngineInterface, project: LoadedConfig, home: string, root: string): Promise<string | undefined> {
  const settings = (project.config.quality as { worktreeSubmodules?: { paths?: string[] } } | undefined)?.worktreeSubmodules
  if (!settings) return undefined
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: home }
  if (settings.paths) env.WORKTREE_SUBMODULES = settings.paths.join(' ')
  const stdin = JSON.stringify({ tool_input: { command: `git worktree add ${root}` }, cwd: home })
  const r = await run($, ['bash', `${$.plugin.root}/kb/hooks/init-worktree-submodules.sh`], { cwd: home, env, stdin, timeoutMs: 120_000 })
  if (r.exitCode !== 0) return `init-worktree-submodules.sh exited ${r.exitCode} for ${root}: ${said(r)}`
  return r.stderr.trim() || undefined
}

// The changed UI files, for the review stage. The edit hook stands aside while a workflow runs.
const WEB_FILES_KEPT = 40

// The local diff adds its types to the record, so that the agent can add a type and cannot hide one.
// It costs no GitHub call. The answer is a note when the diff cannot be read: the commit still stands.
async function readChangeTypes($: EngineInterface, wf: Workflow): Promise<string | undefined> {
  const range = wf.direct ? 'HEAD~1..HEAD' : `origin/${wf.base}...HEAD`
  const r = await git(wf.root, $, 'diff', '--name-only', range)
  if (r.exitCode !== 0) {
    wf.typesUnread = said(r).slice(0, 300)
    return `The change types were not read: git diff --name-only ${range} exited ${r.exitCode}: ${said(r)}. The review stays full. Repair: git fetch origin ${wf.base}.`
  }
  delete wf.typesUnread
  const changed = r.stdout.split('\n').filter(Boolean)
  addTypes(wf, inferChangeTypes(changed))
  wf.webFiles = [...new Set([...(wf.webFiles ?? []), ...changed.filter(isWebPath)])].slice(0, WEB_FILES_KEPT)
  return undefined
}

async function componentNote($: EngineInterface, wf: Workflow): Promise<string | undefined> {
  const range = wf.direct ? 'HEAD~1..HEAD' : `origin/${wf.base}...HEAD`
  const r = await git(wf.root, $, 'diff', '--name-only', range)
  if (r.exitCode !== 0) return `The changed UI files were not listed: git diff ${range} exited ${r.exitCode}: ${said(r)}. Check them against ${$.plugin.root}/kb/ui-components.md by hand.`
  const files = r.stdout.split('\n').filter(isComponent)
  return files.length ? reviewText(files, `${$.plugin.root}/kb/ui-components.md`) : undefined
}

export async function hasDeclined($: EngineInterface): Promise<boolean> {
  return read($, workflowDeclined)
}
export async function setDeclined($: EngineInterface, value: boolean): Promise<void> {
  await update($, workflowDeclined, () => value)
}

async function started($: EngineInterface, c: Ctx): Promise<string> {
  if (await read($, workflowDeclined)) throw new Refuse('Refused: the human chose to work without the workflow in this session. Do the work without these tools, or ask the human to type /flow on.')
  const { args, project } = c
  const issue = Number(args.issue)
  if (!Number.isInteger(issue) || issue <= 0) throw new Refuse(`Refused: issue must be an issue number, and it is ${JSON.stringify(args.issue)}.`)
  const shortName = text(args, 'shortName') || undefined
  if (shortName) refuseShortName(shortName, issue)
  const chosen = text(args, 'mode') || undefined
  if (chosen && chosen !== 'light' && chosen !== 'heavy') throw new Refuse(`Refused: mode is ${JSON.stringify(chosen)}. Use "light" or "heavy".`)
  if (!project) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  if (project.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  const level = project.config.projectLevel
  const home = project.root
  const repo = project.config.github?.repo ?? (await repoFromOrigin($, home))
  const info = await paths($, home)
  const base = await defaultBranch($, home, repo)
  const branchHere = await gitOut(home, $, 'rev-parse', '--abbrev-ref', 'HEAD')

  // Find the worktree: a record that already names this issue, the worktree of this agent's unfinished
  // issue, this folder, or a new claim.
  let root = (await read($, workflowRoot)) ?? home
  const active = await loadWorkflow($, root)
  if (active?.off) throw new Refuse(OFF_HERE(active))
  let wf = await loadWorkflow($, root, issue)
  const issueInfo = await ghOne<{ state: string; title: string }>($, root, repo, ['issue-read', String(issue)])
  // Before any claim, so that a refusal leaves no worktree behind.
  const mayOpen = () => {
    if (issueInfo.state !== 'open') throw new Refuse(`Refused: issue #${issue} is ${issueInfo.state}, so there is nothing to start.`)
    if (!shortName) throw new Refuse(`Refused: a new workflow needs a shortName. Choose two to five lower-case words joined by hyphens from the issue "${issueInfo.title}", such as "fix-login-redirect", and call started again. The Orca workspace is then ${issue}-<shortName>.`)
  }
  const directHere = info.isMain && branchHere === base && mayCommitToBase(level)
  if (!wf && info.isMain && !directHere) {
    const worktrees = (await gitOut(home, $, 'worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    for (const w of worktrees) {
      const found = await loadWorkflow($, w, issue)
      if (found) {
        root = w
        wf = found
      }
    }
  }
  const session = await $.session.id()
  const now = await $.clock.now()
  // The new issue joins this agent's work: the same worktree, branch and PR, until the PR merges.
  let joined: Workflow | undefined
  // A done record of another session: no join, but this worktree's branch is still that PR's branch.
  let neighbour: Workflow | undefined
  if (!wf && active && !active.direct && (active.state !== 'done' || active.prs[0])) {
    const isMine = active.owner?.session === session || (!active.owner && active.lastSession === session) || args.takeOver === true
    if (isMine) joined = active
    else if (active.state !== 'done') throw new Refuse(`Refused: ${whoOf(active)} in ${active.root} belongs to the session ${active.owner?.session ?? active.lastSession ?? 'of another agent'}, and issue #${issue} would join its PR. Nothing changed. Repair: start #${issue} from the main checkout, which claims its own worktree. If that session is dead, call started with takeOver true.`)
    else if (!info.isMain) neighbour = active
  }
  const beside = joined ?? neighbour
  if (beside?.prs[0]) {
    const n = beside.prs[0]
    const prState = beside.merged ? 'merged' : (await readPr($, root, repo, n)).state
    if (prState !== 'open') {
      if (!info.isMain) throw new Refuse(`Refused: PR #${n} of this worktree is ${prState}, so issue #${issue} cannot join it. Nothing changed. Repair: start #${issue} from the main checkout, which claims a new worktree.`)
      joined = undefined
    } else if (joined && (joined.state === 'blocked' || joined.state === 'wait')) {
      throw new Refuse(`Refused: ${whoOf(joined)} is in the state "${joined.state}", so issue #${issue} cannot join it now. Nothing changed. Repair: end that state first (unblocked, or /unblock <message> for a wait).`)
    }
  }
  if (!wf && !joined && root !== home) {
    root = home
    wf = await loadWorkflow($, root, issue)
  }
  if (wf?.off) throw new Refuse(OFF_HERE(wf))
  let direct = false
  let claimNote: string | undefined
  if (!wf && !joined) {
    if (directHere) direct = true
    else if (info.isMain) {
      mayOpen()
      await must($, ['git', 'fetch', 'origin', base], { cwd: home, timeoutMs: 120_000 })
      const claimed = await run($, ['bash', `${$.plugin.root}/scripts/work/worktree_claim.sh`, home, String(issue), `origin/${base}`], { cwd: home, timeoutMs: 120_000 })
      if (claimed.exitCode !== 0) throw new Refuse(`worktree_claim.sh exited ${claimed.exitCode} for issue #${issue}: ${said(claimed)}`)
      root = claimed.stdout.trim().split('\n').pop()!
      claimNote = await initSubmodules($, project, home, root)
    } else if (branchHere === base) {
      throw new Refuse(`Refused: ${home} is on the base branch ${base}. Create a branch first, or set "projectLevel": "straw_man" to commit to it from the main checkout.`)
    }
  }
  if (wf?.owner && wf.owner.session !== session && now - wf.owner.at < OWNER_LIVE_MS && args.takeOver !== true) {
    throw new Refuse(`Refused: the session ${wf.owner.session} owns issue #${issue} in ${root}, and it was active in the last 10 minutes. If that session is dead, call started again with takeOver true.`)
  }

  // Past setup the work has started, so a change of mode is the human's.
  if (chosen && wf && wf.state !== 'setup' && chosen !== (await factsFor($, root, project, wf)).mode) {
    throw new Refuse(`Refused: the mode of issue #${issue} is set when its workflow starts, and it is in the state "${wf.state}". The human can change it with /flow mode ${chosen} ${issue}.`)
  }
  const facts = await factsFor($, root, project, chosen ? { ...wf, mode: chosen as IssueSettings['mode'] } : wf)
  if (!wf) mayOpen()
  const blockers = (await ghLines<{ number: number; state: string }>($, root, repo, ['blocked-by', 'list', String(issue)])).filter(b => b.state === 'open')
  const missing = await missingChecks($, root)
  const branch = wf?.branch ?? joined?.branch ?? (await gitOut(root, $, 'rev-parse', '--abbrev-ref', 'HEAD'))

  const record: Workflow = wf ?? { issue, root, repo, base: joined?.base ?? base, branch, direct: direct || undefined, prs: [], state: 'setup', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [] }
  const isNew = !wf
  record.owner = { session, at: now }
  if (shortName) record.shortName = shortName
  if (chosen) record.mode = chosen as IssueSettings['mode']

  let feedback: string[] = []
  if (record.state === 'done' && record.prs[0]) {
    const pr = await readPr($, root, repo, record.prs[0])
    if (pr.state === 'open') feedback = await newFeedback($, root, repo, issue, pr, record.feedbackAt ?? 0)
  }
  const to = afterStarted(isNew ? undefined : { state: record.state, previous: record.previous }, { mode: facts.mode, scriptsMissing: missing.length > 0, blockerOpen: blockers.length > 0, feedback: feedback.length > 0 })
  const notes: string[] = claimNote ? [claimNote] : []
  notes.push(`Mode: ${facts.mode}, steering: ${facts.steering}, for issue #${issue}.`)
  if (active && !sameRecord(active, record)) {
    // This agent leaves the other issue, so another agent can take it at once. Its state stays.
    if (active.owner?.session === session) {
      active.lastSession = session
      active.releasedAt = now
      active.owner = undefined
      await saveWorkflow($, active)
    }
    // The workspace now shows this issue. The view that this record remembers is out of date.
    record.orca = undefined
  }
  if (!record.shortName) notes.push(`This workflow has no shortName, so its Orca workspace keeps its name. Call started again with a shortName: two to five lower-case words from the issue "${issueInfo.title}".`)
  if (to.state === 'setup') {
    notes.push(`These check scripts are missing or not executable: ${missing.join(', ')}. fast-checks.sh takes the changed files as arguments and runs only very fast tools on them, such as ruff, ty, oxlint and ast-grep; start from ${$.plugin.root}/scripts/workflow/fast-checks-template.sh. pre-commit-check.sh runs the full lint and typecheck. pre-push-check.sh runs the unit tests. pre-ready-check.sh runs the full suite and E2E. Each exits non-zero on failure. Take the commands from the project's CLAUDE.md.`)
  }
  if (to.state === 'blocked' && record.state !== 'blocked') {
    const message = `Issue #${issue} waits for ${blockers.map(b => `#${b.number}`).join(', ')}.`
    await saveWorkflow($, record) // The record exists before the alert names it.
    notes.push(...(await enterBlocked($, record, message, to.previous!, 'started')))
  } else if (to.state !== record.state || isNew) {
    moved(record, 'started', to, now)
  }
  if (to.state !== 'setup') {
    // The record comes first: if the PR step fails, the retry resumes here and does not claim again.
    await saveWorkflow($, record)
    await bind($, root, issue)
    await setUpPr($, record, issueInfo.title, joined?.prs[0])
  }
  await saveWorkflow($, record)
  await bind($, root, issue)
  if (joined && !joined.pr && !joined.prs[0] && record.prs[0]) {
    // The issue that this one joined had no PR yet: it shares the one that this call opened.
    joined.prs = [...record.prs]
    await saveWorkflow($, joined)
  }
  if (!record.pr && record.prs[0]) {
    const carrier = joined?.pr === record.prs[0] ? joined : await loadPrRecord($, root, record.prs[0])
    if (carrier && !carrier.issues?.includes(issue)) {
      Object.assign(carrier, await settingsOfAll($, root, project, [carrier, record]))
      notes.push(await backToDevelopers($, carrier, issue, 'started'))
    }
  }
  if (root !== home) notes.push(`The work is in ${root}, not this session's folder. Change to it before you edit.`)
  if (record.direct) notes.push('This straw_man project commits directly to the base branch, with no PR.')
  if (feedback.length) notes.push(`New feedback:\n${feedback.join('\n')}`)
  if (record.state === 'reviewing') {
    notes.push(await resumeReview($, record, facts))
    await saveWorkflow($, record)
  }
  return answer($, record, facts, notes)
}

const PLANS = /<!-- ndev:plan:(\d+) -->[\s\S]*?<!-- \/ndev:plan:\1 -->\n?/g
const CLOSING_REFS = new RegExp(`${CLOSING}(\\d+)\\b`, 'gi')

// A PR can carry several issues, so each plan has its own section. This plan replaces only the earlier
// plan of its issue, and no closing reference is lost: a sub-issue that followUp added is outside the plans.
function planBody(old: string, issue: number, plan: string): string {
  const others = [...old.matchAll(PLANS)].filter(m => Number(m[1]) !== issue).map(m => m[0].trim())
  const own = `<!-- ndev:plan:${issue} -->\n${plan.trim()}\n${hasIssueRef(plan, issue) ? '' : `Closes #${issue}\n`}<!-- /ndev:plan:${issue} -->`
  const plans = [...others, own].join('\n\n')
  // All that is not a plan stays, such as a note from the human. A plain closing line that a plan now holds goes.
  const kept = old.replace(PLANS, '').replace(SECTION, '').replace(/^Plan incoming\.\s*$/m, '').split('\n').filter(line => {
    const bare = /^\s*closes #(\d+)\s*$/i.exec(line)
    return !bare || !hasIssueRef(plans, Number(bare[1]))
  }).join('\n').trim()
  // A reference that only the replaced plan held is still carried by this PR.
  const refs = [...new Set([...old.matchAll(CLOSING_REFS)].map(m => Number(m[1])))].filter(n => !hasIssueRef(plans, n) && !hasIssueRef(kept, n))
  return `${plans}\n\n${kept ? `${kept}\n` : ''}${refs.map(n => `Closes #${n}\n`).join('')}${SECTION.exec(old)?.[0] ?? ''}`
}

async function finishedPlan($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedPlan', facts)
  havePr(wf)
  const name = text(args, 'markdown_file')
  const path = name.startsWith('/') ? name : `${wf.root}/${name}`
  if (!name || !(await $.fs.exists(path))) throw new Refuse(`Refused: the plan file ${path || '(none given)'} does not exist. Nothing changed.`)
  const plan = await $.fs.read(path)
  if (!/^\W*(Test entry point|Seam):/im.test(plan)) throw new Refuse(`Refused: ${path} has no "Test entry point:" line. Name the public interface that the tests go through, and call finishedPlan again.`)
  if (wf.prs[0]) {
    await editBody($, wf, old => planBody(old, wf.issue, plan))
  }
  const to = afterTool({ state: wf.state }, 'finishedPlan', facts) as Position
  const notes: string[] = []
  if (to.state === 'blocked') notes.push(...(await enterBlocked($, wf, `The plan for #${wf.issue} waits for your sign-off in the PR body.`, to.previous!, 'finishedPlan')))
  else moved(wf, 'finishedPlan', to, await $.clock.now())
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// False when the range cannot be read, such as after a rebase: then the evidence is stale.
async function onlyDocsBetween($: EngineInterface, wf: Workflow, from: string, to: string): Promise<boolean> {
  const r = await git(wf.root, $, 'diff', '--name-only', from, to)
  return r.exitCode === 0 && r.stdout.split('\n').filter(Boolean).every(isDocsPath)
}

// A skip of setup leaves a workflow with no PR. Only started opens it.
function havePr(wf: Workflow) {
  if (!wf.direct && !wf.prs.length) throw new Refuse(`Refused: the workflow of #${wf.issue} has no PR. Nothing changed. Call started with issue ${wf.issue}: it opens the draft PR.`)
}

async function checkpoint($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const files = list(args, 'files')
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: checkpoint needs a commit message.')
  const declared = declaredTypes(args)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'checkpoint', facts)
  havePr(wf)
  const before = await head(wf.root, $)
  // An issue that finished development holds its commit for the review of the PR, so this one must not push it.
  const holders = wf.pr ? [] : (await prSiblings($, wf)).filter(o => !o.pr && o.state === 'developed')
  const hold = wf.state === 'reviewing' || wf.state === 'developed' || holders.length > 0
  // With no files, a checkpoint only pushes a held commit, such as after a human skips the review.
  const held = (await git(wf.root, $, 'rev-parse', `origin/${wf.branch}`)).stdout.trim() !== before
  if (!files.length && (!held || hold)) throw new Refuse('Refused: checkpoint needs the files to commit, each by name.')
  const notes = await commitAndPush($, wf, 'checkpoint', message, files, !hold, declared)
  if (holders.length) notes.push(`This commit is held and not pushed, because ${holders.map(o => `#${o.issue}`).join(', ')} on this PR finished development and holds a commit for the review.`)
  addTypes(wf, declared)
  const unread = await readChangeTypes($, wf)
  if (unread) notes.push(unread)
  const sha = await head(wf.root, $)
  // Documents leave the tested code as it was, so the evidence moves with them. The commits decide
  // this, not the names in the call, and it also holds on a retry, when HEAD did not move this time.
  for (const e of [wf.evidence.review, wf.evidence.checks, wf.evidence.smoke]) if (e && e.sha !== sha && (await onlyDocsBetween($, wf, e.sha, sha))) e.sha = sha
  // A human who skipped the checks or the smoke test has decided: a commit of documents does not undo that.
  const smokeDue = requiredSmokeTypes(wf.changeTypes ?? []).length > 0 && !wf.evidence.smoke && !wf.evidence.checks?.byHuman
  await move($, c, wf, 'checkpoint', { ...facts, docsOnly: wf.evidence.checks?.sha === sha, smoke: smokeDue })
  await flagForHuman($, wf, notes)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// An agent that followUp started has its own worktree and record, so the session's workflow does not
// move. A worktree with no check scripts commits nothing, as in setup: only a human skips them.
async function followUpCheckpoint($: EngineInterface, { args }: Ctx): Promise<string> {
  const root = text(args, 'worktree').replace(/\/$/, '')
  const known = await read($, followUpWorktrees)
  if (!known.includes(root)) throw new Refuse(`Refused: followUp did not start an agent in ${root}. Its worktrees in this session: ${known.join(', ') || 'none'}. Nothing was committed.`)
  const wf = await loadWorkflow($, root, Number(args.issue))
  if (!wf) throw new Refuse(`Refused: ${root}/${RECORD} holds no workflow for issue #${String(args.issue)}. Nothing was committed. Repair: the main agent calls followUp again with the same text.`)
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: checkpoint needs a commit message.')
  const declared = declaredTypes(args)
  const missing = await missingChecks($, root)
  if (missing.length) throw new Refuse(`Refused: ${root} has no ${missing.join(', ')}, so no check can run, and nothing was committed. Repair: write them in this worktree and name them in files. Start fast-checks.sh from ${$.plugin.root}/scripts/workflow/fast-checks-template.sh. pre-commit-check.sh runs the full lint and typecheck, pre-push-check.sh the unit tests, pre-ready-check.sh the full suite and E2E. Each exits non-zero on failure. Take the commands from the project's CLAUDE.md.`)
  const files = list(args, 'files')
  if (!files.length && (await git(root, $, 'rev-parse', `origin/${wf.branch}`)).stdout.trim() === (await head(root, $))) throw new Refuse('Refused: checkpoint needs the files to commit, each by name.')
  const notes = await commitAndPush($, wf, 'checkpoint', message, files, true, declared)
  addTypes(wf, declared)
  const unread = await readChangeTypes($, wf)
  if (unread) notes.push(unread)
  await saveWorkflow($, wf)
  return [`Committed and pushed ${(await head(root, $)).slice(0, 8)} of #${wf.issue} on ${wf.branch} in ${root}.`, ...notes].join('\n')
}

// An issue that is still before the merge point, also when a block or a wait holds it.
const isBeforeMerge = (o: Workflow) => ['setup', 'planning', 'developing'].includes(o.state) || (['blocked', 'wait'].includes(o.state) && ['setup', 'planning', 'developing'].includes(o.previous ?? ''))

// The record goes into review: the code review starts at once, and the stage hooks fire.
async function intoReview($: EngineInterface, c: Ctx, wf: Workflow, facts: Facts, notes: string[]): Promise<string> {
  await move($, c, wf, 'finishedDevelopment', facts)
  await flagForHuman($, wf, notes)
  await saveWorkflow($, wf)
  const unlisted = await unlistedMigrations($, wf)
  if (unlisted.length) notes.push(migrationText(unlisted))
  const ui = await componentNote($, wf)
  if (ui) notes.push(ui)
  notes.push(await startReview($, wf, facts, ui))
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// The merge point. Each named issue finishes here. When no issue on the PR is still in development, the
// PR record takes over: from here on the PR, and not one issue, goes through review, the checks and done.
async function finishedDevelopment($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const named = args.issues as number[]
  const root = (await read($, workflowRoot)) ?? project?.root
  const active = root ? await loadWorkflow($, root) : undefined
  const lead = active && !active.pr && named.includes(active.issue) ? active.issue : named[0]!
  const wf = await current($, { ...c, args: { ...args, issue: lead } })
  const facts = await factsFor($, wf.root, project, wf)
  // A retry after a crash finds this issue finished, and goes on from there.
  if (wf.state !== 'developed') legal(wf, 'finishedDevelopment', facts)
  await noAgentsRunning($)
  const declared = declaredTypes(args)
  const files = list(args, 'files')
  const unnamed = changedPaths(await porcelain($, wf.root)).filter(p => !files.some(f => p === f || p.startsWith(`${f.replace(/\/$/, '')}/`)))
  if (unnamed.length) throw new Refuse(`Refused: these changed files are not named: ${unnamed.join(', ')}. Name each one, or remove it. Nothing was committed.`)
  const message = text(args, 'message') || `Finish work on ${named.map(n => `#${n}`).join(', ')}`

  if (wf.direct) {
    if (named.length > 1) throw new Refuse(`Refused: a project that commits directly to the base branch has one issue at a time, and this call names ${named.map(n => `#${n}`).join(', ')}. Nothing was committed.`)
    const notes = await commitAndPush($, wf, 'finishedDevelopment', message, files, false)
    addTypes(wf, declared)
    return intoReview($, c, wf, facts, notes)
  }

  for (const n of list(args, 'prs').map(Number)) {
    const pr = await readPr($, wf.root, wf.repo, n)
    if (pr.head.ref !== wf.branch) throw new Refuse(`Refused: PR #${n} is on ${pr.head.ref}, and this workflow is on ${wf.branch}.`)
    if (!wf.prs.includes(n)) wf.prs.push(n)
  }
  havePr(wf)
  const n = wf.prs[0]!
  const session = await $.session.id()
  const now = await $.clock.now()
  const held = await readHeld($, wf.root)
  const listed = named.map(i => (i === wf.issue ? wf : held.issues.find(o => o.issue === i)))
  const problems = named.flatMap((i, at) => {
    const o = listed[at]
    if (!o) return [`#${i} has no workflow in ${wf.root}. Repair: call started with issue ${i}.`]
    if (o.prs[0] !== n) return [`#${i} is not on PR #${n}${o.prs[0] ? `: it is on PR #${o.prs[0]}` : ''}.`]
    if (o.state !== 'developing' && o.state !== 'developed') return [`#${i} is in the state "${o.state}".`]
    if (o.owner && o.owner.session !== session && now - o.owner.at < OWNER_LIVE_MS) return [`The session ${o.owner.session} owns #${i}. Leave it to that session.`]
    return []
  })
  if (problems.length) throw new Refuse(`Refused: finishedDevelopment cannot take these issues. Nothing was committed.\n- ${problems.join('\n- ')}`)
  const finishing = listed as Workflow[]

  const notes = finishing.every(o => o.state === 'developed') && !files.length ? [] : await commitAndPush($, wf, 'finishedDevelopment', message, files, false)
  addTypes(wf, declared)
  for (const o of finishing.filter(x => x.state !== 'developed')) {
    if ((await factsFor($, wf.root, project, o)).mode === 'heavy') {
      const gates = await run($, ['bash', `${$.plugin.root}/scripts/work/gates.sh`, String(o.issue), 'HEAD', String(n)], { cwd: wf.root, env: { GH_REPO: wf.repo } })
      if (gates.exitCode !== 0) {
        await saveWorkflow($, wf)
        throw new Refuse(`gates.sh exited ${gates.exitCode} for #${o.issue}: ${said(gates)}\nThe commit is held here and not pushed. Add what is missing, then call finishedDevelopment again.`)
      }
    }
  }
  for (const o of finishing) {
    if (o.state !== 'developed') moved(o, 'finishedDevelopment', { state: 'developed' }, now)
    await saveWorkflow($, o)
  }

  const members = held.issues.filter(o => o.prs[0] === n && !named.includes(o.issue))
  const waitingFor = members.filter(isBeforeMerge)
  if (waitingFor.length) {
    notes.push(`PR #${n} waits for ${waitingFor.map(o => `#${o.issue} ("${o.state}")`).join(', ')}. The last issue to finish takes the PR through the review, so this call started no review.`)
    return answer($, wf, facts, notes)
  }

  const prior = held.prs.find(p => p.pr === n)
  const all = [...finishing, ...members]
  const union = <T>(pick: (o: Workflow) => readonly T[] | undefined, key: (x: T) => unknown = x => x) => {
    const seen = new Map<unknown, T>()
    for (const o of [...(prior ? [prior] : []), ...all]) for (const x of pick(o) ?? []) seen.set(key(x), x)
    return [...seen.values()]
  }
  const issues = [...new Set([...(prior?.issues ?? []), ...all.map(o => o.issue)])].sort((a, b) => a - b)
  const changeTypes = union(o => o.changeTypes)
  const webFiles = union(o => o.webFiles)
  const record: Workflow = {
    ...(prior ?? { ...wf, rev: undefined, op: undefined, previous: undefined, waiting: undefined, blocked: undefined }),
    ...(await settingsOfAll($, wf.root, project, [...(prior ? [prior] : []), ...all])),
    pr: n,
    prs: [n],
    issue: issues[0]!,
    issues,
    state: 'developing',
    previous: undefined,
    owner: { session, at: now },
    evidence: {},
    hooks: undefined,
    reviewSpec: undefined,
    doneMessage: undefined,
    followUps: union(o => o.followUps, f => f.hash),
    migrations: union(o => o.migrations, m => m.path),
    changeTypes: changeTypes.length ? changeTypes : undefined,
    webFiles: webFiles.length ? webFiles : undefined,
    typesUnread: all.find(o => o.typesUnread)?.typesUnread,
  }
  notes.push(`From here on PR #${n} goes through the review, the checks and done: give pr ${n} to each tool. It carries ${issues.map(i => `#${i}`).join(', ')}.`)
  return intoReview($, c, record, await factsFor($, wf.root, project, record), notes)
}

// An issue joins a PR, which goes back to its developers, because what was reviewed and tested is no
// longer the whole change. Issues can join until the PR merges.
async function backToDevelopers($: EngineInterface, carrier: Workflow, issue: number, tool: string): Promise<string> {
  carrier.issues = [...new Set([...issuesOf(carrier), issue])].sort((a, b) => a - b)
  carrier.issue = carrier.issues[0]!
  const wasBack = carrier.state === 'developing'
  if (carrier.state === 'blocked' || carrier.state === 'wait') carrier.previous = 'developing'
  else if (!wasBack) moved(carrier, tool, { state: 'developing' }, await $.clock.now())
  carrier.evidence = {}
  carrier.hooks = carrier.hooks ? { ...carrier.hooks, review: undefined } : undefined
  carrier.reviewSpec = undefined
  carrier.doneMessage = undefined
  await saveWorkflow($, carrier)
  return `PR #${carrier.pr} now carries #${issue} too${wasBack ? '' : ', and it goes back to its developers: its review and check results no longer count'}. When the work is complete, call finishedDevelopment with the issues.`
}

export async function startReview($: EngineInterface, wf: Workflow, facts: Facts, ui?: string): Promise<string> {
  const hand = `Start it yourself: the ndev:diff-reviewer agent, on origin/${wf.base}...HEAD in ${wf.root}.`
  const unread = await readChangeTypes($, wf)
  const after = unread ? ` ${unread}` : ''
  const prompt = [
    issuesOf(wf).length > 1
      ? `Review the diff origin/${wf.base}...HEAD in ${wf.root}. It is the work on the issues ${issuesOf(wf).map(n => `#${n}`).join(', ')} of ${wf.repo}, on one PR. Read each issue with ${$.plugin.root}/scripts/github/gh.sh issue-read and its number. The base branch is ${wf.base}: do not look it up.`
      : `Review the diff origin/${wf.base}...HEAD in ${wf.root}. It is the work on issue #${wf.issue} of ${wf.repo}. Read the issue with ${$.plugin.root}/scripts/github/gh.sh issue-read ${wf.issue}. The base branch is ${wf.base}: do not look it up.`,
    facts.mode === 'heavy' ? 'The change follows the work-heavy skill, so check what a finished change of that skill must include.' : '',
    ui ?? '',
    ...reviewerBrief(reviewTypes(wf)),
    'Report only. Do not edit, commit or push. Give each finding with its file and line, Critical and Important first.',
  ].filter(Boolean).join('\n')
  // A heavy change gets two reviewers, because one who holds both questions lets each hide the other (work-heavy F3c).
  const twoAxes = facts.mode === 'heavy' && !isDocsOnly(reviewTypes(wf))
  wf.reviewSpec = undefined
  try {
    const first = await $.agent.spawn({ subagentType: 'ndev:diff-reviewer', description: `Review ${wf.pr ? `PR #${wf.pr}` : `#${wf.issue}`}${twoAxes ? ': standards' : ''}`, prompt: twoAxes ? `${prompt}\n${AXIS_STANDARDS}` : prompt, cwd: wf.root })
    if ('deny' in first && first.deny) return `The code review did not start: ${String(first.deny)}. ${hand}${after}`
    wf.hooks = { ...wf.hooks, review: { firedAt: wf.hooks?.review?.firedAt ?? (await $.clock.now()), agentId: first.agentId } }
    if (!twoAxes) return `The plugin started the code review${first.agentId ? `: agent ${first.agentId}` : ''}. Do not start another. Its answer comes to you when it ends.${after}`
    const second = await $.agent.spawn({ subagentType: 'ndev:diff-reviewer', description: `Review ${wf.pr ? `PR #${wf.pr}` : `#${wf.issue}`}: specification`, prompt: `${prompt}\n${AXIS_SPECIFICATION}`, cwd: wf.root })
    if ('deny' in second && second.deny) return `The standards review started, and the specification review did not: ${String(second.deny)}. Start it yourself: the ndev:diff-reviewer agent, with this question. ${AXIS_SPECIFICATION}${after}`
    wf.reviewSpec = { agentId: second.agentId }
    return `The plugin started the two-axis code review: two agents, one for standards and one for the specification. Do not start another. Each answer comes to you when it ends. Keep the two reports apart.${after}`
  } catch (error) {
    return `The code review did not start: ${error instanceof Error ? error.message : String(error)}. ${hand}${after}`
  }
}

const AXIS_STANDARDS = 'Review axis: standards. Where does this diff break a rule that this repository wrote down? Cite the file and the rule. Read AGENTS.md or CLAUDE.md, and the F3c section of skills/work-heavy/references/implement.md in the plugin. Do not judge whether the change meets the issue: another reviewer does that.'
const AXIS_SPECIFICATION = 'Review axis: specification. Does this diff do what the issue and the plan in the PR body ask, and all of it? Name each requirement that is missing, partial or wrong, and each change that nothing asked for. Do not judge the code style: another reviewer does that.'

export async function recordOfReviewer($: EngineInterface, root: string, agentId: string): Promise<Workflow | undefined> {
  const { issues, prs } = await readHeld($, root)
  return [...prs, ...issues].find(o => o.hooks?.review?.agentId === agentId || o.reviewSpec?.agentId === agentId)
}

// The reviewer has ended: keep its answer in the record, and give it to the main agent.
export async function reviewerAnswered($: EngineInterface, wf: Workflow, agentId: string, reply: string): Promise<void> {
  const review = wf.hooks?.review
  const spec = wf.reviewSpec
  if (spec?.agentId === agentId && spec.answer === undefined) wf.reviewSpec = { ...spec, answer: reply.slice(0, 20_000) }
  else if (review?.agentId === agentId && review.answer === undefined) wf.hooks = { ...wf.hooks, review: { ...review, answer: reply.slice(0, 20_000) } }
  else return
  await saveWorkflow($, wf)
  void $.prompt.submit({ text: `The code review of ${labelOf(wf)} has ended:\n\n${reply}\n\nFix what it found with checkpoint, which holds those commits. Then call finishedReview with the result.` }).catch((error: unknown) => {
    $.ui.toast(`workflow: the answer of the review for ${labelOf(wf)} was not sent to the model: ${error instanceof Error ? error.message : String(error)}`)
  })
}

// A resume in the review stage: the answer is known, the reviewer still runs, or a restart lost it.
async function resumeReview($: EngineInterface, wf: Workflow, facts: Facts): Promise<string> {
  const parts = [wf.hooks?.review, ...(wf.reviewSpec ? [wf.reviewSpec] : [])]
  const running = new Set((await $.agent.list()).map(a => a.id))
  const lost = parts.some(p => p?.answer === undefined && !(p?.agentId && running.has(p.agentId)))
  if (lost) return startReview($, wf, facts, await componentNote($, wf))
  const answers = parts.filter(p => p?.answer !== undefined).map(p => `The code review answered:\n${p!.answer}`)
  const live = parts.filter(p => p?.answer === undefined).map(p => `The code review still runs: agent ${p!.agentId}.`)
  return [...answers, ...live].join('\n')
}

async function finishedReview($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedReview', facts)
  havePr(wf)
  await noAgentsRunning($)
  const fields = ['review', 'deadcode', 'remembered'].map(k => [k, text(args, k)] as const)
  const empty = fields.filter(([, v]) => !v).map(([k]) => k)
  if (empty.length) throw new Refuse(`Refused: ${empty.join(', ')} ${empty.length > 1 ? 'are' : 'is'} empty. Give the result, or "skipped: <reason>".`)
  if (!maySkipReview(facts.level)) {
    const skipped = fields.filter(([, v]) => /^skipped\b/i.test(v)).map(([k]) => k)
    if (skipped.length) throw new Refuse(`Refused: a formal_project does not skip ${skipped.join(', ')}. Do the step and call finishedReview again.`)
  }
  const dirty = await porcelain($, wf.root)
  if (dirty.length) throw new Refuse(`Refused: the tree is not clean (${changedPaths(dirty).join(', ')}). Commit with checkpoint first.`)
  const notes: string[] = []
  const note = await checked($, wf, 'pre-ready-check.sh')
  if (note) notes.push(note)
  notes.push(...(await commitAndPush($, wf, 'finishedReview', '', [])))
  if (wf.prs[0]) {
    const pr = await readPr($, wf.root, wf.repo, wf.prs[0])
    if (pr.draft) await markReady($, wf.root, wf.repo, pr.number)
    const board = project?.config.github?.board
    if (board) {
      const moved = await moveCard($, wf, 'review')
      if (moved) notes.push(moved)
    }
  }
  wf.evidence.review = { sha: await head(wf.root, $), text: fields.map(([k, v]) => `${k}: ${v}`).join('\n').slice(0, 2000) }
  const at = await $.clock.now()
  wf.hooks = {
    ...wf.hooks,
    review: { ...wf.hooks?.review, firedAt: wf.hooks?.review?.firedAt ?? at, result: text(args, 'review') },
    remember: { firedAt: wf.hooks?.remember?.firedAt ?? at, result: text(args, 'remembered').slice(0, 2000) },
  }
  await move($, c, wf, 'finishedReview', facts)
  await flagForHuman($, wf, notes)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

async function moveCard($: EngineInterface, wf: Workflow, status: string): Promise<string | undefined> {
  const board = `${$.plugin.root}/scripts/board/board.sh`
  const items = await run($, ['bash', board, 'items'], { cwd: wf.root, env: { GH_REPO: wf.repo } })
  if (items.exitCode !== 0) return `The board card did not move: board.sh items exited ${items.exitCode}: ${said(items)}`
  const cards = items.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as { number: number; itemId: string })
  const problems: string[] = []
  for (const issue of issuesOf(wf)) {
    const card = cards.find(i => i.number === issue)
    if (!card) {
      problems.push(`Issue #${issue} has no card on the board, so no card moved.`)
      continue
    }
    const moved = await run($, ['bash', board, 'move', card.itemId, status], { cwd: wf.root, env: { GH_REPO: wf.repo } })
    if (moved.exitCode !== 0) problems.push(`The board card of #${issue} did not move: board.sh move exited ${moved.exitCode}: ${said(moved)}`)
  }
  return problems.length ? problems.join(' ') : undefined
}

async function finishedChecks($: EngineInterface, c: Ctx): Promise<string> {
  const { project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedChecks', { ...facts })
  const sha = await head(wf.root, $)
  if (wf.prs[0]) {
    const pr = await readPr($, wf.root, wf.repo, wf.prs[0])
    if (pr.head.sha !== sha) throw new Refuse(`Refused: PR #${pr.number} is at ${pr.head.sha.slice(0, 8)}, and HEAD is ${sha.slice(0, 8)}. Push it: call checkpoint with no files, which pushes a held commit.`)
  }
  const checks = await readChecks($, wf.root, wf.repo, sha, wf.prs[0])
  if (checks.pending.length) throw new Refuse(`Refused: pending on ${sha.slice(0, 8)}: ${checks.pending.join(', ')}. Do not run a wait helper: the workflow watches them and prompts you when they end. If nothing else is open, end your turn.`)
  if (checks.red.length) {
    wf.attempts += 1
    if (wf.attempts >= ATTEMPT_LIMIT) {
      const notes = await enterBlocked($, wf, `The checks of #${wf.issue} failed ${wf.attempts} times: ${checks.red.join(', ')}`, wf.state, 'finishedChecks')
      await saveWorkflow($, wf)
      return answer($, wf, facts, notes)
    }
    await saveWorkflow($, wf)
    throw new Refuse(`Refused: red on ${sha.slice(0, 8)}: ${checks.red.join(', ')}. Attempt ${wf.attempts} of ${ATTEMPT_LIMIT}. Fix the cause with checkpoint, then call finishedChecks again.`)
  }
  wf.attempts = 0
  wf.evidence.checks = { sha, text: `green: ${checks.green.join(', ') || 'this repository has no checks'}` }
  const range = wf.direct ? `${sha}~1...${sha}` : `origin/${wf.base}...${sha}`
  const changed = (await gitOut(wf.root, $, 'diff', '--name-only', range)).split('\n').filter(Boolean)
  const withSmoke = { ...facts, smoke: needsSmoke(facts.mode, changed, checks.green, wf.changeTypes) }
  await move($, c, wf, 'finishedChecks', withSmoke)
  await saveWorkflow($, wf)
  return answer($, wf, withSmoke)
}

async function finishedSmoke($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedSmoke', facts)
  const sha = await head(wf.root, $)
  const report = text(args, 'report')
  const skipped = text(args, 'skipped')
  if (!report && !skipped) throw new Refuse('Refused: finishedSmoke needs a report, or skipped with the reason.')
  const required = requiredSmokeTypes(wf.changeTypes ?? [])
  if (skipped && required.length) throw new Refuse(`Refused: the change types of #${wf.issue} hold ${required.join(', ')}, so finishedSmoke does not take skipped ("${skipped}"). Repair: smoke test HEAD (${sha.slice(0, 7)}) and give the report. Only a human can skip it, with /flow skip <reason>.`)
  if (skipped && !maySkipReview(facts.level)) throw new Refuse('Refused: a formal_project does not skip the smoke test. Run it and give the report.')
  if (report) {
    if (!report.includes(sha.slice(0, 7))) throw new Refuse(`Refused: the report does not name HEAD (${sha.slice(0, 7)}). Smoke test HEAD and name its sha.`)
    if (wf.prs[0]) {
      const n = wf.prs[0]
      await gh($, wf.root, wf.repo, ['pr-review', String(n), '--commit', sha, '--body', `<!-- work-heavy-auto:smoke -->\n**Smoke tested** at ${sha}\n\n${report}`])
      await gh($, wf.root, wf.repo, ['label', String(n), 'smoke-tested'])
    }
  }
  wf.evidence.smoke = { sha, text: report || `skipped: ${skipped}` }
  await move($, c, wf, 'finishedSmoke', facts)
  await saveWorkflow($, wf)
  return answer($, wf, facts)
}

async function finishedRevision($: EngineInterface, c: Ctx): Promise<string> {
  const { project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedRevision', facts)
  if (wf.prs[0]) {
    const pr = await readPr($, wf.root, wf.repo, wf.prs[0])
    const feedback = await newFeedback($, wf.root, wf.repo, wf.issue, pr)
    if (feedback.length) throw new Refuse(`Refused: this feedback has no answer. Push a commit that answers it, or reply with the marker "<!-- work-heavy-auto:revision ack:<id> -->":\n${feedback.join('\n')}`)
  }
  // From here, only what comes later is new. A commit made for another reason answers nothing.
  wf.feedbackAt = await $.clock.now()
  await move($, c, wf, 'finishedRevision', facts)
  await saveWorkflow($, wf)
  return answer($, wf, facts)
}

async function blocked($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'blocked', facts)
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: blocked needs a message that says what the human must do.')
  const notes = await enterBlocked($, wf, message, wf.state, 'blocked')
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

async function unblocked($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'unblocked', facts)
  const notes: string[] = []
  if (wf.blocked) {
    const problem = await withdrawAlert($, wf.root, wf.blocked)
    if (problem) notes.push(problem)
  }
  wf.blocked = undefined
  wf.nudges = { count: 0 }
  await move($, c, wf, 'unblocked', facts)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

async function done($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'done', facts)
  await noAgentsRunning($)
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: done needs a message that says what was finished.')
  const remembered = text(args, 'remembered') || wf.hooks?.remember?.result || ''
  if (!remembered) throw new Refuse('Refused: the remember hook has no result. Update the docs and the wiki, then call done with remembered: what you recorded, or "nothing: <reason>".')
  if (!maySkipReview(facts.level) && /^skipped\b/i.test(remembered)) throw new Refuse('Refused: a formal_project does not skip the remember hook. Do the step and call done again.')
  const sha = await head(wf.root, $)
  havePr(wf)
  const { problems, feedback } = await doneProblems($, wf, sha)
  if (feedback.length) {
    await move($, c, wf, 'done', { ...facts, feedback: true })
    await saveWorkflow($, wf)
    return answer($, wf, facts, [`Not done: this feedback has no answer:\n${feedback.join('\n')}`, ...problems.map(p => `Also: ${p}`)])
  }
  if (problems.length) throw new Refuse(`Not done. Fix each of these, then call done again:\n- ${problems.join('\n- ')}`)

  const notes: string[] = []
  const n = wf.prs[0]
  let merged = false
  if (n && !wf.direct) {
    await comment($, wf.root, wf.repo, n, `<!-- work-heavy-auto:state -->\n${MARKER}\n- next: waiting-human\n- sha: ${sha}\n\n${message}`)
    const siblings = await prSiblings($, wf)
    // An issue record ends in developed: its PR record goes on to done for it.
    const unfinished = siblings.filter(o => !o.pr && o.state !== 'done' && o.state !== 'developed')
    const migrations = new Set([wf, ...siblings].flatMap(o => o.migrations.map(m => m.path))).size
    if (unfinished.length) notes.push(`PR #${n} also carries ${unfinished.map(o => `#${o.issue} ("${o.state}")`).join(', ')}, so it must not merge yet. The last of these issues to finish decides the merge.`)
    if (mayMerge(facts.level) && !unfinished.length) {
      if (migrations) notes.push(`This PR has ${migrations} migration(s), so done did not merge it. This project level lets you merge: load the ndev:merge skill now and follow it for PR #${n}.`)
      else {
        const r = await run($, ['bash', `${$.plugin.root}/scripts/workflow/merge.sh`, String(n), '--repo', wf.repo], { cwd: wf.root, timeoutMs: 300_000 })
        if (r.exitCode !== 0) throw new Refuse(`Not done: merge.sh exited ${r.exitCode} for PR #${n}: ${said(r)}`)
        merged = true
        wf.merged = true
        for (const o of siblings) {
          o.merged = true
          await saveWorkflow($, o)
        }
        notes.push(`PR #${n} is merged.`)
      }
    }
  }
  const followUps = wf.followUps.filter(f => f.mode !== 'this_agent')
  if (followUps.length) notes.push(`Follow-ups elsewhere: ${followUps.map(f => `#${f.issue} (${f.mode})`).join(', ')}.`)
  wf.doneMessage = message
  wf.hooks = { ...wf.hooks, remember: { firedAt: wf.hooks?.remember?.firedAt ?? (await $.clock.now()), result: remembered.slice(0, 2000) } }
  await move($, c, wf, 'done', facts)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

const SHORT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function refuseShortName(shortName: string, issue?: number): void {
  if (!SHORT_NAME.test(shortName) || shortName.length > 40 || (issue && shortName.startsWith(`${issue}-`))) {
    throw new Refuse(`Refused: shortName must be two to five lower-case words joined by hyphens, at most 40 characters, with no issue number, such as "fix-login-redirect". It is ${JSON.stringify(shortName)}.`)
  }
}

const hashOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7).toString(16)

// A new issue, and its workflow. Once the issue exists, each failure names it, so that a retry does not file it twice.
async function create($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const shortName = text(args, 'shortName')
  if (args.mode !== undefined && args.mode !== 'light' && args.mode !== 'heavy') throw new Refuse(`Refused: mode is ${JSON.stringify(args.mode)}. Use "light" or "heavy".`)
  const [title, ...rest] = text(args, 'description').split('\n')
  if (!shortName) throw new Refuse('Refused: create needs a shortName. Nothing was filed.')
  refuseShortName(shortName)
  if (!title) throw new Refuse('Refused: create needs a description: its first line is the issue title. Nothing was filed.')
  if (!project) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  if (project.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  const root = (await read($, workflowRoot)) ?? project.root
  const active = await loadWorkflow($, root)
  if (active?.off) throw new Refuse(OFF_HERE(active))
  const repo = project.config.github?.repo ?? (await repoFromOrigin($, project.root))
  const { gitDir } = await paths($, root)
  const bodyFile = `${gitDir}/ndev-new-issue.md`
  await $.fs.write(bodyFile, `${rest.join('\n').trim() || title}\n`)
  const made = await gh($, root, repo, ['issue-new', '--title', title, '--body-file', bodyFile])
  const issue = Number(/(?:\/issues\/|"number":\s*)(\d+)/.exec(made)?.[1])
  if (!issue) throw new Error(`gh.sh issue-new printed no issue number: ${made.slice(0, 200)}`)
  const link = `Issue #${issue}: https://github.com/${repo}/issues/${issue}`
  try {
    return `${link}\n${await started($, { args: { issue, shortName, mode: args.mode }, project })}`
  } catch (error) {
    throw new Refuse(`${link} is filed, and started failed: ${error instanceof Error ? error.message : String(error)}\nRepair: call started with issue ${issue} and shortName ${shortName}. Do not call create again.`)
  }
}

// On an issue or a PR, with or without a workflow. The mark keeps it out of the feedback that done reads.
async function addComment($: EngineInterface, { args, project }: Ctx): Promise<string> {
  const isPr = args.pr !== undefined
  const n = Number(isPr ? args.pr : args.issue)
  if (isPr === (args.issue !== undefined) || !Number.isInteger(n) || n <= 0) throw new Refuse(`Refused: comment needs one number, issue or pr. It got issue ${JSON.stringify(args.issue)} and pr ${JSON.stringify(args.pr)}. Nothing was posted.`)
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: comment needs a message. Nothing was posted.')
  if (!project) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  const root = (await read($, workflowRoot)) ?? project.root
  const repo = project.config.github?.repo ?? (await repoFromOrigin($, project.root))
  await comment($, root, repo, n, `${MARKER}\n${message}`)
  return `Posted on ${isPr ? 'PR' : 'issue'} #${n}: https://github.com/${repo}/${isPr ? 'pull' : 'issues'}/${n}`
}

async function followUp($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const mode = text(args, 'mode')
  const message = text(args, 'message')
  if (!['this_agent', 'subagent', 'orca_workspace', 'issue_only'].includes(mode)) throw new Refuse(`Refused: mode is ${JSON.stringify(mode)}; use this_agent, subagent, orca_workspace or issue_only.`)
  if (!message) throw new Refuse('Refused: followUp needs a message: its first line is the issue title.')
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  const tool: Tool = mode === 'this_agent' ? 'followUpThisAgent' : mode === 'issue_only' ? 'followUpIssue' : 'followUpOther'
  legal(wf, tool, facts)
  if (mode === 'this_agent' && wf.direct) throw new Refuse('Refused: a project that commits directly to the base branch has no PR to carry a sub-issue. Use issue_only, or do the work and commit it.')
  if (mode === 'this_agent' && wf.prs[0]) {
    const prState = wf.merged ? 'merged' : (await readPr($, wf.root, wf.repo, wf.prs[0])).state
    if (prState !== 'open') throw new Refuse(`Refused: PR #${wf.prs[0]} is ${prState}, so it cannot carry a new issue. Nothing was filed. Repair: use the mode issue_only, or orca_workspace to start the work in its own worktree.`)
  }

  // A retry after a failed Orca call or a crash reuses the issue, so nothing is filed twice.
  const hash = hashOf(`${mode}\n${message}`)
  let entry = wf.followUps.find(f => f.hash === hash)
  const [title, ...rest] = message.split('\n')
  if (!entry) {
    const { gitDir } = await paths($, wf.root)
    const bodyFile = `${gitDir}/ndev-follow-up.md`
    await $.fs.write(bodyFile, `${rest.join('\n').trim()}\n\nFollow-up from #${wf.issue}.\n`)
    const made = await gh($, wf.root, wf.repo, ['issue-new', '--title', title!, '--body-file', bodyFile])
    const number = /(?:\/issues\/|"number":\s*)(\d+)/.exec(made)?.[1]
    if (!number) throw new Error(`gh.sh issue-new printed no issue number: ${made.slice(0, 200)}`)
    entry = { hash, mode, issue: Number(number), title: title! }
    wf.followUps.push(entry)
    await saveWorkflow($, wf)
  }
  const n = entry.issue
  const notes = [`Issue: https://github.com/${wf.repo}/issues/${n}`]
  if (mode === 'this_agent') {
    await gh($, wf.root, wf.repo, ['subissues', 'link', String(wf.issue), String(n)])
    await editBody($, wf, old => (hasIssueRef(old, n) ? old : `${old.trimEnd()}\n\nCloses #${n}\n`))
    await comment($, wf.root, wf.repo, n, `${MARKER}\nCarried by #${wf.prs[0]}.`)
    notes.push(`This PR now closes #${n}. Do that work here.`)
    const pr = wf.prs[0]!
    let child = (await readHeld($, wf.root)).issues.find(o => o.issue === n)
    if (!child) {
      child = { issue: n, root: wf.root, repo: wf.repo, base: wf.base, branch: wf.branch, prs: [pr], state: 'developing', owner: wf.owner, evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [] }
      await saveWorkflow($, child)
    }
    const carrier = wf.pr ? wf : await loadPrRecord($, wf.root, pr)
    if (carrier && !carrier.issues?.includes(n)) notes.push(await backToDevelopers($, carrier, n, 'followUp:this_agent'))
    if (wf.pr) {
      // The PR is back with its developers, and this agent goes on the new issue.
      await bind($, wf.root, n)
      await saveWorkflow($, wf)
      return answer($, child, facts, notes)
    }
    notes.push(`When both are complete, call finishedDevelopment with the issues ${wf.issue} and ${n}.`)
  }
  if (mode === 'subagent') {
    if (!entry.worktree) {
      const { main } = await paths($, wf.root)
      await must($, ['git', 'fetch', 'origin', wf.base], { cwd: main, timeoutMs: 120_000 })
      const claimed = await run($, ['bash', `${$.plugin.root}/scripts/work/worktree_claim.sh`, main, String(n), `origin/${wf.base}`], { cwd: main, timeoutMs: 120_000 })
      if (claimed.exitCode !== 0) throw new Refuse(`The issue #${n} exists, and worktree_claim.sh exited ${claimed.exitCode} for it: ${said(claimed)}\nCall followUp again with the same text to retry: it reuses the issue.`)
      entry.worktree = claimed.stdout.trim().split('\n').pop()!
      await saveWorkflow($, wf)
      const note = project && (await initSubmodules($, project, main, entry.worktree))
      if (note) notes.push(note)
    }
    const worktree = entry.worktree
    const branch = await gitOut(worktree, $, 'rev-parse', '--abbrev-ref', 'HEAD')
    if (!(await loadWorkflow($, worktree, n))) await saveWorkflow($, { issue: n, root: worktree, repo: wf.repo, base: wf.base, branch, prs: [], state: 'developing', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], followUpOf: wf.issue })
    await update($, followUpWorktrees, known => (known.includes(worktree) ? known : [...known, worktree]))
    const spawned = await $.agent.spawn({ subagentType: 'ndev:issue-implementer', prompt: `Work on issue #${n} of ${wf.repo}, in its own worktree ${worktree} on the branch ${branch}, and open its own PR. The worktree is claimed for you: do not claim another, and do not call started. Commit and push only through mcp__ndev__checkpoint with issue ${n}, worktree "${worktree}", the message and each file: it runs the check scripts, and a raw git commit or push is refused. It came up during #${wf.issue}. ${message}`, description: `Follow-up issue #${n}`, cwd: worktree })
    if ('deny' in spawned && spawned.deny) throw new Refuse(`The issue #${n} and the worktree ${worktree} exist, and the agent did not start: ${String(spawned.deny)}\nCall followUp again with the same text to retry: it reuses both.`)
    notes.push(`An agent works on #${n} in its own worktree ${worktree} and PR, by this followUp call. It commits there through checkpoint with issue ${n}, which refuses until that worktree has the check scripts.`)
  }
  if (mode === 'orca_workspace') {
    const slug = title!.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40).replace(/-$/, '') || 'follow-up'
    const made = await run($, ['orca', 'worktree', 'create', '--name', `${n}-${slug}`, '--no-parent', '--issue', String(n), '--agent', 'claude', '--prompt', `Use the ndev plugin to work on issue #${n}. Call started with shortName "${slug}".`, '--json'], { cwd: wf.root, timeoutMs: 120_000 })
    if (made.exitCode !== 0) throw new Refuse(`The issue #${n} exists, and orca worktree create exited ${made.exitCode}: ${said(made)}\nCall followUp again with the same text to retry: it reuses the issue.`)
    notes.push(`An Orca workspace works on #${n}.`)
  }
  await move($, c, wf, tool, facts, `followUp:${mode}`)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

async function addMigration($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  const name = text(args, 'name')
  if (!/^[a-z0-9_]+$/.test(name)) throw new Refuse(`Refused: the migration name ${JSON.stringify(name)} must hold only lower-case letters, digits and underscores.`)
  if (wf.direct || !wf.prs[0]) throw new Refuse('Refused: this workflow has no PR, so nothing runs a migration after a merge. Add it with supabase migration new, and run it yourself.')
  if (['setup', 'done', 'blocked', 'wait'].includes(wf.state)) throw new Refuse(`Refused: addMigration is not valid in the state "${wf.state}".`)
  const workdir = text(args, 'workdir').replace(/\/$/, '')
  const prefix = workdir ? `${workdir}/` : ''
  if (!(await $.fs.exists(`${wf.root}/${prefix}supabase/config.toml`))) throw new Refuse(`Refused: ${wf.root}/${prefix}supabase/config.toml does not exist. Repair: run supabase init there, or pass workdir with the folder that holds supabase/.`)
  let entry = wf.migrations.find(m => m.name === name)
  if (!entry) {
    const stamp = new Date(await $.clock.now()).toISOString().replace(/\D/g, '').slice(0, 14)
    entry = { name, path: `${prefix}supabase/migrations/${stamp}_${name}.sql` }
    await $.fs.write(`${wf.root}/${entry.path}`, '')
    wf.migrations.push(entry)
    await saveWorkflow($, wf)
  }
  const lines = [...new Set([wf, ...(await prSiblings($, wf))].flatMap(o => o.migrations.map(m => m.path)))].map(path => `- \`${path}\``).join('\n')
  const section = `<!-- ndev:migrations -->\n## Migrations to run after merge\n\n${lines}\n<!-- /ndev:migrations -->\n`
  await editBody($, wf, old => (SECTION.test(old) ? old.replace(SECTION, section) : `${old.trimEnd()}\n\n${section}`))
  await saveWorkflow($, wf)
  return answer($, wf, facts, [`Migration file: ${wf.root}/${entry.path}. Write its SQL and commit it with checkpoint. /ndev:merge runs it after the merge.`])
}

async function status($: EngineInterface, c: Ctx): Promise<string> {
  const { project } = c
  const root = (await read($, workflowRoot)) ?? project?.root
  const named = c.args.issue === undefined ? undefined : Number(c.args.issue)
  const pr = c.args.pr === undefined ? undefined : Number(c.args.pr)
  const wf = !root ? undefined : pr !== undefined ? await loadPrRecord($, root, pr) : await loadWorkflow($, root, named)
  if (!wf || !root) return `No workflow${pr ? ` for PR #${pr}` : named ? ` for issue #${named}` : ''} in this session. Next: call started with the issue number.`
  const facts = await factsFor($, root, project, wf)
  const extra = [wf.off ? `Off: ${wf.off.reason}. /flow on turns it back on.` : '', project?.config.workflow === false ? `Off for this project: ${project.path}.` : '', wf.blocked ? `Blocked: ${wf.blocked.message}` : '', wf.waiting ? `Waiting for ${wf.waiting.what}. /unblock <message> ends it.` : '', wf.changeTypes?.length ? `Change types: ${wf.changeTypes.join(', ')}.` : '', wf.migrations.length ? `Migrations after merge: ${wf.migrations.map(m => m.path).join(', ')}` : '']
  return answer($, wf, facts, extra)
}

// Works with or without a workflow, for any agent. The answer never holds the value.
async function requestSecret($: EngineInterface, { args, project }: Ctx): Promise<string> {
  const name = text(args, 'name')
  if (!SECRET_NAME.test(name)) throw new Refuse(`Refused: ${JSON.stringify(name)} is not a variable name.`)
  const top = project?.root
  if (!top) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  const root = (await read($, workflowRoot)) ?? top
  const { main } = await paths($, root)
  const files = secretFiles(root, main, await $.env.get('HOME'))
  for (const path of files) {
    if (!(await $.fs.exists(path))) continue
    const line = findInText(name, await $.fs.read(path))
    if (line !== undefined) return `${name} is set in ${path} on line ${line}. Load it from there: do not print it.`
  }
  throw new Refuse(`${name} is not set in any of: ${files.join(', ')}. Repair: ask the human to add it to ${root}/.neil-dev.env, with the blocked tool if nothing else can go on.`)
}

type Spec = { name: string; description: string; properties: Record<string, unknown>; required: string[]; forSubagents?: boolean }
const STR = { type: 'string' }
const FILES = { type: 'array', items: STR, description: 'Each changed file, by name' }
// Works with or without a workflow, for any agent.
async function screenshot($: EngineInterface, { args, project }: Ctx): Promise<string> {
  const root = (await read($, workflowRoot)) ?? project?.root
  if (!root) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  return takeScreenshots($, root, args)
}

const CHANGE_TYPES_ARG = { type: 'array', items: { type: 'string', enum: [...CHANGE_TYPES] }, description: 'Optional. What the change holds, when the changed paths do not show it, such as web for a .ts file that renders a page. The changed paths always add their types too.' }

const WAIT_TIMEOUT_S = 3600
// GitHub calls are limited, so a wait on GitHub reads seldom. Each check is one read.
const WAIT_GITHUB_PERIOD_S = { fallback: 300, least: 60 }
const WAIT_PR_STATES = ['open', 'closed', 'merged', 'draft', 'ready', 'mergeable']
const WAIT_ISSUE_STATES = ['open', 'closed']
const WAIT_LIMITS = { attempts: { type: 'integer', description: 'The most checks. The default is as many as the timeout allows' }, timeout: { type: 'number', description: `The most seconds to wait. The default is ${WAIT_TIMEOUT_S}` } }
const ISSUE_ARG = { type: 'number', description: 'The issue this call is for: the one that this agent is on. A worktree can hold several issues.' }
const PR_ARG = { type: 'number', description: 'The PR this call is for. From finishedDevelopment on, the PR goes through the review, the checks and done. Give issue or pr.' }
const SPEC_LIST: Spec[] = [
  { name: 'create', description: 'File a new issue and start its workflow, as started does. The answer gives the issue number.', properties: { mode: { type: 'string', enum: ['light', 'heavy'], description: 'Optional, and only at the start: heavy for a multi-step, cross-cutting or high-risk change, and light for the others. With no value, the issue follows the worktree.' }, shortName: { ...STR, description: 'Two to five lower-case words joined by hyphens. The Orca workspace is <issue>-<shortName>.' }, description: { ...STR, description: 'The first line is the issue title, and the rest is its body' } }, required: ['shortName', 'description'] },
  { name: 'comment', description: 'Add a comment to an issue or a PR. Give issue or pr, not both. It works with or without a workflow.', properties: { issue: { type: 'number' }, pr: { type: 'number' }, message: STR }, required: ['message'] },
  { name: 'started', description: 'Start or resume the workflow of an issue. Call it first in each work session. It records the state, claims the worktree, opens the draft PR and answers with the next step.', properties: { mode: { type: 'string', enum: ['light', 'heavy'], description: 'Optional, and only at the start: heavy for a multi-step, cross-cutting or high-risk change, and light for the others. With no value, the issue follows the worktree.' }, shortName: { ...STR, description: 'Two to five lower-case words joined by hyphens, chosen from the issue. A new workflow needs it. The Orca workspace is <issue>-<shortName>.' }, issue: { type: 'number' }, takeOver: { type: 'boolean', description: 'Only when the session that owns the workflow is dead' } }, required: ['issue'] },
  { name: 'finishedPlan', description: 'The plan is written: put it in the PR body and go on to development.', properties: { markdown_file: { ...STR, description: 'The plan file' } }, required: ['markdown_file'] },
  { name: 'checkpoint', description: 'Commit the named files and push, after the check scripts. Use this and not git commit or git push.', properties: { message: STR, files: FILES, changeTypes: CHANGE_TYPES_ARG, worktree: { ...STR, description: 'Only for an agent that followUp started: its own worktree' } }, required: ['message', 'files'] },
  { name: 'finishedDevelopment', description: 'Development is complete: commit the named files and go on to review. This starts the code review at once and fires the remember hook. This commit is not pushed until finishedReview.', properties: { issues: { type: 'array', items: { type: 'number' }, description: 'Each issue that this call finishes. An issue on the same PR that is still in development makes the PR wait for it, and the last one to finish starts the review.' }, prs: { type: 'array', items: { type: 'number' } }, message: STR, files: FILES, changeTypes: CHANGE_TYPES_ARG }, required: ['issues', 'prs'] },
  { name: 'finishedReview', description: 'Reviews are complete: run pre-ready-check.sh, push, mark the PR ready and go on to the checks. Each field is the result or "skipped: <reason>". remembered is what the remember hook recorded in the docs and the wiki, or "nothing: <reason>".', properties: { review: STR, deadcode: STR, remembered: STR }, required: ['review', 'deadcode', 'remembered'] },
  { name: 'finishedChecks', description: 'The checks have ended: the tool reads them for HEAD and goes on, or refuses and names them.', properties: {}, required: [] },
  { name: 'finishedSmoke', description: 'The smoke test is complete: post the report, which names the HEAD sha. Or give skipped with the reason.', properties: { report: STR, skipped: STR }, required: [] },
  { name: 'finishedRevision', description: 'Each piece of feedback has an answer: go back to the checks.', properties: {}, required: [] },
  { name: 'blocked', description: 'Nothing can go on without the human. This raises a persistent notification and an Orca flag, and stops the reminders. Say what the human must do.', properties: { message: STR }, required: ['message'] },
  { name: 'unblocked', description: 'The block is resolved: withdraw the notification and go back to the earlier state.', properties: { message: STR }, required: [] },
  { name: 'done', description: 'All the work is complete. The tool checks all of it, lists every problem, and marks it done. It merges only when the project level lets the agent merge. remembered is needed only when the review stage was skipped: what you recorded in the docs and the wiki, or "nothing: <reason>".', properties: { message: STR, remembered: STR }, required: ['message'] },
  { name: 'followUp', description: 'File a new issue for work that does not belong to this issue, and act by mode: this_agent (this PR carries it), subagent, orca_workspace or issue_only.', properties: { mode: { type: 'string', enum: ['this_agent', 'subagent', 'orca_workspace', 'issue_only'] }, message: { ...STR, description: 'The first line is the issue title' } }, required: ['mode', 'message'], forSubagents: true },
  { name: 'addMigration', description: 'Add a named Supabase migration, to run after the merge. This makes the empty migration file and lists it in the PR body. /ndev:merge runs it.', properties: { name: { ...STR, description: 'Lower-case letters, digits and underscores' }, workdir: { ...STR, description: 'The folder that holds supabase/, when it is not the root' } }, required: ['name'] },
  { name: 'reportWorkflowBug', description: 'The ndev workflow or plugin itself did something wrong: a tool answered wrongly, crashed, or refused for no reason. This starts an Orca agent that fixes it on main of the plugin, so go on with your own work. Not for a bug in the project, and not for a refusal that is correct.', properties: { title: { type: 'string', description: 'One line that names the bug' }, details: { type: 'string', description: 'The tool and arguments, what it answered, and what you expected' } }, required: ['title', 'details'], forSubagents: true },
  { name: 'iNeedA', description: 'Ask the plugin for guidance before you choose or write one of these, so that the work keeps to the approved set: react-component, library, brand-style (a call on a font, a colour and so on) or animation (a micro-interaction, a simple animation or a full showy one). The answer gives suggestions and where to get them. It is guidance: you can still choose otherwise and say why.', properties: { kind: { type: 'string', enum: [...NEED_KINDS] }, description: { type: 'string', description: 'What it is for: the component type, the job of the library, the style question or the moment to animate' } }, required: ['kind', 'description'], forSubagents: true },
  { name: 'screenshot', description: 'Take images of one page in the Orca browser, at each viewport and colour scheme, and save them as files. The answer gives each full path. The tab closes after, unless the page lands on a login, which the human signs in to once. Orca must run. It makes no GitHub call, and the images do not reach the PR.', properties: { url: { ...STR, description: 'The full http or https URL' }, viewports: { type: 'array', items: STR, description: 'Sizes such as 390x844. The default is 390x844, 820x1180 and 1440x900.' }, schemes: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] }, description: 'The default is light and dark.' }, fullPage: { type: 'boolean', description: 'Take the whole page and not only the viewport.' }, waitSeconds: { type: 'number', description: 'A pause after the load, for a page that fills in late.' } }, required: ['url'], forSubagents: true },
  { name: 'waitForSubAgent', description: 'Hold this agent until the named subagent ends. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { claude_agent_id: { ...STR, description: 'The id of the agent' }, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['claude_agent_id'] },
  { name: 'waitForURL', description: 'Hold this agent until the URL answers with a 2xx status. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { url: STR, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['url'] },
  { name: 'waitForProcessEnd', description: 'Hold this agent until the process ends. It cannot read the exit code: read the log or the result file of the process. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { pid: { type: 'integer' }, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['pid'] },
  { name: 'waitForSeconds', description: 'Hold this agent for this many seconds. attempts has no effect here, because no check runs. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { secs: { type: 'number' }, ...WAIT_LIMITS }, required: ['secs'] },
  { name: 'waitFor', description: 'Hold this agent and run the shell command every period seconds, in the worktree, until it exits 0. Each run may last 60 s. It gives up after attempts or timeout. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { shell_command: STR, period: { type: 'number', description: 'Seconds between checks. The default is 30' }, ...WAIT_LIMITS }, required: ['shell_command'] },
  { name: 'waitForPR', description: `Hold this agent until the PR reaches the state: ${WAIT_PR_STATES.join(', ')}. Do not use it for the checks of this PR: the workflow watches those. Each check is one GitHub read, so period is at least ${WAIT_GITHUB_PERIOD_S.least} s. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.`, properties: { pr: { type: 'integer' }, state: { type: 'string', enum: [...WAIT_PR_STATES] }, period: { type: 'number', description: `Seconds between checks. The default is ${WAIT_GITHUB_PERIOD_S.fallback}` }, ...WAIT_LIMITS }, required: ['pr', 'state'] },
  { name: 'waitForIssue', description: `Hold this agent until each named issue reaches the state: ${WAIT_ISSUE_STATES.join(', ')}. Each check is one GitHub read, so period is at least ${WAIT_GITHUB_PERIOD_S.least} s. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.`, properties: { waitOn: { type: 'array', items: { type: 'integer' }, description: 'The issues to wait for. The wait ends when all of them reach the state' }, state: { type: 'string', enum: [...WAIT_ISSUE_STATES] }, period: { type: 'number', description: `Seconds between checks. The default is ${WAIT_GITHUB_PERIOD_S.fallback}` }, ...WAIT_LIMITS }, required: ['waitOn', 'state'] },
  { name: 'status', description: 'Read the workflow state and the next step. This changes nothing. With no issue, it reads the issue that this agent is on.', properties: { issue: { type: 'number' }, pr: { type: 'number' } }, required: [], forSubagents: true },
  { name: 'requestSecret', description: 'Find where a named secret is set: .neil-dev.env, then .env, then ~/.zshrc, then ~/.bashrc. The answer gives the file and the line number, never the value.', properties: { name: STR }, required: ['name'], forSubagents: true },
]

// Each of these acts on one workflow, so each names its issue.
const STATE_TOOLS = new Set(['finishedPlan', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'blocked', 'unblocked', 'done', 'followUp', 'addMigration', ...SPEC_LIST.filter(s => s.name.startsWith('wait')).map(s => s.name)])
// These name an issue only. finishedDevelopment names its issues, and each other state tool takes issue or pr.
const ISSUE_ONLY = new Set(['finishedPlan', 'waitForPR'])
const SPECS: Spec[] = SPEC_LIST.map(s => {
  if (!STATE_TOOLS.has(s.name) || s.name === 'finishedDevelopment') return s
  if (ISSUE_ONLY.has(s.name)) return { ...s, properties: { issue: ISSUE_ARG, ...s.properties }, required: ['issue', ...s.required] }
  return { ...s, properties: { issue: ISSUE_ARG, pr: PR_ARG, ...s.properties } }
})

// A session in the main checkout works in a worktree, and its link to that worktree does not survive a
// restart. Without the link the watcher and the reminders see no workflow, so a resumed session looks for
// the record that it owns or released. This reads local files only.
async function findOwnWorkflow($: EngineInterface, cwd: string): Promise<void> {
  if (await read($, workflowRoot)) return
  const listed = await git(cwd, $, 'worktree', 'list', '--porcelain')
  if (listed.exitCode !== 0) return // Not a git folder: there is no worktree to find.
  const session = await $.session.id()
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const wf = ownRecord(await readEffective($, line.slice(9)), session)
    if (!wf) continue
    const owned = wf.owner?.session === session
    await bind($, wf.root, wf.issue)
    if (!owned) {
      wf.owner = { session, at: await $.clock.now() }
      await saveWorkflow($, wf)
    }
    return
  }
}

export async function startWorkflow($: EngineInterface, cwd: string): Promise<void> {
  for (const s of SPECS) {
    await $.tool.register({ name: s.name, description: s.description, inputSchema: { type: 'object', properties: s.properties, required: s.required }, isDeferred: false })
  }
  await findOwnWorkflow($, cwd)
}

// The session has ended, so another session may take the workflow at once.
export async function releaseWorkflow($: EngineInterface, project: LoadedConfig | undefined): Promise<void> {
  const root = (await read($, workflowRoot)) ?? project?.root
  const wf = root ? await loadWorkflow($, root) : undefined
  if (!wf?.owner || wf.owner.session !== (await $.session.id())) return
  wf.lastSession = wf.owner.session
  wf.releasedAt = await $.clock.now()
  wf.owner = undefined
  await saveWorkflow($, wf)
}

// True while the workflow's stages do the work of the edit, commit and push hooks. In setup, or after
// a skipped setup, the check scripts may not exist, so the hooks stay on. An unreadable record also
// leaves them on: the workflow tools report that fault themselves.
// The component list is made at finishedDevelopment, so an edit after that has only the hook.
export async function workflowListsComponents($: EngineInterface, project: LoadedConfig | undefined): Promise<boolean> {
  if (!(await workflowOwnsChecks($, project))) return false
  const root = (await read($, workflowRoot)) ?? project?.root
  const wf = root ? await loadWorkflow($, root) : undefined
  return wf?.state === 'planning' || wf?.state === 'developing'
}

// A worktree of several records, in a session that owns none: the guards still count, by the first open record.
async function guardedRecord($: EngineInterface, root: string): Promise<Workflow | undefined> {
  return (await loadWorkflow($, root)) ?? (await readEffective($, root)).find(o => !o.off && !o.noChecks && o.state !== 'done' && o.state !== 'setup')
}

export async function workflowOwnsChecks($: EngineInterface, project: LoadedConfig | undefined): Promise<boolean> {
  if (project?.config.workflow === false) return false
  const root = (await read($, workflowRoot)) ?? project?.root
  if (!root) return false
  try {
    const wf = await guardedRecord($, root)
    return !!wf && !wf.off && !wf.noChecks && wf.state !== 'done' && wf.state !== 'setup'
  } catch {
    return false
  }
}

// A raw commit runs no check script, and a raw push gets past the review. Each comes through
// checkpoint while the workflow owns the checks, which is not so in setup, off, done or with checks skipped.
const RAW_GIT = /(?:^|[;&|(\n]\s*|\s)git((?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--\S+)*)\s+(?:commit|push)(?=\s|$)/g
// The text of a commit message can name a git command. The message is no command, so it is taken out first.
const COMMIT_MESSAGE = /(\s-[a-zA-Z]*m\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')/g
// A wait of the agent's own. A single read of the checks is not one, and stays allowed.
const OWN_WAIT = /wait-for-pr-change\.sh|wait-for-run\.sh|\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^\n;&|]*--watch/
// Each worktree of a repository has the same common directory. Undefined when git cannot read the folder.
async function commonDir($: EngineInterface, cwd: string, dir: string): Promise<string | undefined> {
  const out = await git(cwd, $, '-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
  return out.exitCode === 0 ? out.stdout.trim().split('\n').at(-1) : undefined
}

// The guard is for the workflow's own repository: the wiki and each other repository have no checks here.
// Only a single -C with a full path can show another repository. Anything else counts as the workflow's.
async function reachesWorkflowRepo($: EngineInterface, wf: Workflow, command: string): Promise<boolean> {
  const own = await commonDir($, wf.root, wf.root)
  if (!own) return true
  const home = await $.env.get('HOME')
  for (const [, options] of command.replace(COMMIT_MESSAGE, '$1""').matchAll(RAW_GIT)) {
    const parts = [...options.matchAll(/\s+(-C\s+|--\S+)("[^"]*"|'[^']*'|\S+)?/g)]
    if (parts.length !== 1 || !parts[0][1].startsWith('-C')) return true
    const dir = (parts[0][2] ?? '').replace(/^["']|["']$/g, '').replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home ?? '$&')
    if (!dir.startsWith('/')) return true
    const common = await commonDir($, wf.root, dir)
    if (!common || common === own) return true
  }
  return false
}

export const workflowGitGuard = (on: Parameters<Register>[0], getProject: () => LoadedConfig | undefined) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (OWN_WAIT.test(command)) {
      const project = getProject()
      if (project?.config.workflow === false) return next(e)
      const root = (await read($, workflowRoot)) ?? project?.root
      const wf = root ? await loadWorkflow($, root) : undefined
      if (!wf || !(await watchesChecks($, wf))) return next(e)
      return { deny: `workflow: The workflow watches the checks and merge conflicts of issue #${wf.issue} and prompts you when they end or when one fails, so this wait only spends GitHub calls. If nothing else is open, end your turn. A human can stop this with /flow off.` }
    }
    if (!command.match(RAW_GIT)) return next(e)
    const project = getProject()
    if (!(await workflowOwnsChecks($, project))) return next(e)
    const root = (await read($, workflowRoot)) ?? project?.root
    const wf = root ? await guardedRecord($, root) : undefined
    if (!wf || !(await reachesWorkflowRepo($, wf, command))) return next(e)
    const own = wf.followUps.filter(f => f.worktree)
    if ((e as { agentId?: string }).agentId && own.length) return { deny: `workflow: a commit or push here runs no check script. An agent that followUp started calls mcp__ndev__checkpoint with its own issue and worktree: ${own.map(f => `#${f.issue} in ${f.worktree}`).join(', ')}. Any other helper reports to the agent that started it.` }
    return { deny: `workflow: issue #${wf.issue} is in the state "${wf.state}", so this commit or push goes through the checkpoint tool, which runs the check scripts. It also ends a merge. With no files it pushes a held commit. A commit in another repository, such as ~/dev-wiki, passes when each git in the command names it with -C and a full path. A human can turn this off with /flow off.` }
  })
}

// True while this session's watchdog reads the checks, so the agent has no reason to wait: in `ci`,
// and in `finishing` after pending checks on this commit refused `done`.
export async function watchesChecks($: EngineInterface, wf: Workflow): Promise<boolean> {
  if (wf.off) return false
  if (wf.owner && wf.owner.session !== (await $.session.id())) return false
  if (wf.state === 'ci') return true
  if (wf.state !== 'finishing') return false
  const sha = await read($, doneWaitsFor)
  return !!sha && sha === (await git(wf.root, $, 'rev-parse', 'HEAD')).stdout.trim()
}

// One line in the system text, so that a compaction cannot lose the state.
export async function workflowLine($: EngineInterface, project: LoadedConfig | undefined): Promise<string | undefined> {
  if (project?.config.workflow === false || (await read($, workflowDeclined))) return undefined
  const root = (await read($, workflowRoot)) ?? project?.root
  const wf = root ? await loadWorkflow($, root) : undefined
  if (!root) return undefined
  if (!wf) return 'Workflow: when you start work on a GitHub issue, call mcp__ndev__started with its number and a shortName of two to five words that you choose from the issue. If the human asks for development work and names no issue, ask which issue, or whether to file a new one with mcp__ndev__create, or whether to work without the workflow; in auto steering, call mcp__ndev__create yourself. Each workflow tool answers with the next step, and takes the issue number. Use mcp__ndev__checkpoint, not git commit or git push.'
  if (wf.off) return undefined
  const facts = await factsFor($, root, project, wf)
  const waitingOn = wf.pr ? [] : (await prSiblings($, wf)).filter(o => !o.pr && o.state !== 'done')
  const also = waitingOn.length ? ` The same PR carries ${waitingOn.map(o => `#${o.issue} ("${o.state}")`).join(', ')}.` : ''
  return `Workflow: ${wf.pr ? `PR #${wf.pr} (${issuesOf(wf).map(n => `#${n}`).join(', ')})` : `issue #${wf.issue}`} in ${wf.root} is in the state "${wf.state}". Give ${wf.pr ? `pr ${wf.pr}` : `issue ${wf.issue}`} to each workflow tool.${also} Next: ${stepOf(wf, facts)} This issue is ${facts.mode} and ${facts.steering}, and that wins over the session's mode and steering above.`
}

// The engine follows $ only into functions named at the top of a file, so the tools are a switch.
async function dispatch($: EngineInterface, name: string, c: Ctx): Promise<string> {
  switch (name) {
    case 'started': return started($, c)
    case 'create': return create($, c)
    case 'comment': return addComment($, c)
    case 'finishedPlan': return finishedPlan($, c)
    case 'checkpoint': return text(c.args, 'worktree') ? followUpCheckpoint($, c) : checkpoint($, c)
    case 'finishedDevelopment': return finishedDevelopment($, c)
    case 'finishedReview': return finishedReview($, c)
    case 'finishedChecks': return finishedChecks($, c)
    case 'finishedSmoke': return finishedSmoke($, c)
    case 'finishedRevision': return finishedRevision($, c)
    case 'blocked': return blocked($, c)
    case 'unblocked': return unblocked($, c)
    case 'done': return done($, c)
    case 'followUp': return followUp($, c)
    case 'addMigration': return addMigration($, c)
    case 'screenshot': return screenshot($, c)
    case 'status': return status($, c)
    case 'requestSecret': return requestSecret($, c)
    case 'reportWorkflowBug': return reportBug($, text(c.args, 'title'), text(c.args, 'details'), `the project ${c.project?.root ?? 'unknown'}`)
    case 'iNeedA': return iNeedA($, text(c.args, 'kind'), text(c.args, 'description'), c.project)
    default: throw new Refuse(`There is no workflow tool named ${name}.`)
  }
}

// ---- The wait tools ----
// A wait holds the tool call, so the agent stays blocked and spends nothing. It does not hold the
// inTurn queue, or /unblock could not get in. A hook's budget of ten seconds runs on through
// $.clock.sleep and not through a $ call in flight, so the pause is a short process.
const WAIT_SLICE_S = 2
const WAIT_BUDGET_LOW_MS = 2_000
const WAIT_TOOLS = ['waitForSubAgent', 'waitForURL', 'waitForProcessEnd', 'waitForSeconds', 'waitFor', 'waitForPR', 'waitForIssue']
const activeWaits = new Set<string>()
export const isWaitRunning = (id: string) => activeWaits.has(id)

type WaitSpec = { what: string; period: number }

function waitNumber(a: Args, tool: string, key: string, fallback: number, isWhole = false): number {
  const value = a[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (isWhole && !Number.isInteger(value))) throw new Refuse(`Refused: ${tool} needs ${key} to be a ${isWhole ? 'whole ' : ''}number above 0, and it got ${JSON.stringify(value)}. Nothing changed.`)
  return value
}

function waitGithubPeriod(a: Args, tool: string): number {
  const period = waitNumber(a, tool, 'period', WAIT_GITHUB_PERIOD_S.fallback)
  if (period < WAIT_GITHUB_PERIOD_S.least) throw new Refuse(`Refused: ${tool} reads GitHub at each check and calls are limited, so period must be at least ${WAIT_GITHUB_PERIOD_S.least} s. It got ${period}. Nothing changed.`)
  return period
}

function waitSpec(name: string, a: Args): WaitSpec {
  switch (name) {
    case 'waitForSubAgent': {
      const id = text(a, 'claude_agent_id')
      if (!id) throw new Refuse('Refused: waitForSubAgent needs claude_agent_id. Nothing changed.')
      return { what: `agent ${id}`, period: waitNumber(a, name, 'period', 5) }
    }
    case 'waitForURL': {
      const url = text(a, 'url')
      if (!/^https?:\/\//.test(url)) throw new Refuse(`Refused: waitForURL needs an http or https url, and it got "${url}". Nothing changed.`)
      return { what: url, period: waitNumber(a, name, 'period', 5) }
    }
    case 'waitForProcessEnd': {
      if (a.pid === undefined) throw new Refuse('Refused: waitForProcessEnd needs pid. Nothing changed.')
      return { what: `process ${waitNumber(a, name, 'pid', 0, true)}`, period: waitNumber(a, name, 'period', 5) }
    }
    case 'waitForSeconds': {
      if (a.secs === undefined) throw new Refuse('Refused: waitForSeconds needs secs. Nothing changed.')
      const secs = waitNumber(a, name, 'secs', 0)
      return { what: `${secs} s`, period: secs }
    }
    case 'waitFor': {
      const command = text(a, 'shell_command')
      if (!command) throw new Refuse('Refused: waitFor needs shell_command. Nothing changed.')
      return { what: `\`${command.slice(0, 120)}\` to exit 0`, period: waitNumber(a, name, 'period', 30) }
    }
    case 'waitForPR': {
      const state = text(a, 'state')
      if (!WAIT_PR_STATES.includes(state)) throw new Refuse(`Refused: waitForPR needs state to be one of ${WAIT_PR_STATES.join(', ')}, and it got "${state}". The workflow watches the checks of this PR itself. Nothing changed.`)
      return { what: `PR #${waitNumber(a, name, 'pr', 0, true)} to be ${state}`, period: waitGithubPeriod(a, name) }
    }
    case 'waitForIssue': {
      const state = text(a, 'state')
      if (!WAIT_ISSUE_STATES.includes(state)) throw new Refuse(`Refused: waitForIssue needs state to be one of ${WAIT_ISSUE_STATES.join(', ')}, and it got "${state}". Nothing changed.`)
      const numbers = a.waitOn
      if (!Array.isArray(numbers) || !numbers.length || !numbers.every(n => Number.isInteger(n) && (n as number) > 0)) throw new Refuse(`Refused: waitForIssue needs waitOn to be a list of issue numbers, and it got ${JSON.stringify(numbers)}. Nothing changed.`)
      return { what: `${numbers.length > 1 ? 'issues' : 'issue'} ${numbers.map(n => `#${String(n)}`).join(', ')} to be ${state}`, period: waitGithubPeriod(a, name) }
    }
    default: throw new Refuse(`There is no wait tool named ${name}.`)
  }
}

// One check. A check is short: a command that hangs is killed, and counts as a failed attempt.
async function waitCheck($: EngineInterface, name: string, a: Args, root: string, startedAt: number): Promise<{ isOver: boolean; detail: string; seen?: Record<string, string> }> {
  switch (name) {
    case 'waitForPR':
    case 'waitForIssue': {
      const isPr = name === 'waitForPR'
      const wf = await loadWorkflow($, root)
      const wanted = text(a, 'state')
      const numbers = isPr ? [a.pr] : (a.waitOn as unknown[])
      const lines: string[] = []
      const shown: Record<string, string> = {}
      let allThere = true
      for (const number of numbers) {
        const label = isPr ? `PR #${String(number)}` : `issue #${String(number)}`
        const r = await run($, ['bash', `${$.plugin.root}/scripts/github/gh.sh`, isPr ? 'pr-read' : 'issue-read', String(number)], { cwd: root, env: { GH_REPO: wf?.repo ?? '' } })
        // A failed read is one failed attempt: the network or the quota can recover. A wrong number cannot.
        if (r.exitCode !== 0) {
          const why = `${label}: gh.sh exit code ${r.exitCode}: ${r.stderr.trim().slice(-300)}`
          return /not found|could not resolve/i.test(r.stderr) ? { isOver: true, detail: `${label} was not found in ${wf?.repo ?? 'this repository'}, so nothing can end this wait. Check the number. ${why}` } : { isOver: false, detail: why }
        }
        const seen = JSON.parse(r.stdout.trim().split('\n')[0] ?? '{}') as { state?: string; merged?: boolean; draft?: boolean; mergeable?: boolean | string | null; mergeable_state?: string; head?: { sha?: string } }
        const now = String(seen.state ?? '').toLowerCase()
        const isOpen = now === 'open'
        const there = wanted === 'merged' ? !!seen.merged
          : wanted === 'draft' ? isOpen && !!seen.draft
            : wanted === 'ready' ? isOpen && !seen.draft
              : wanted === 'mergeable' ? isOpen && (seen.mergeable === true || seen.mergeable === 'MERGEABLE')
                : now === wanted
        if (!there) allThere = false
        lines.push(`${label} is ${seen.merged ? 'merged' : now}${seen.draft ? ', draft' : ''}.`)
        if (isPr) {
          const merges = seen.mergeable === true || seen.mergeable === 'MERGEABLE' ? 'yes' : seen.mergeable === null || seen.mergeable === undefined ? 'unknown' : 'no'
          Object.assign(shown, { state: seen.merged ? 'merged' : now, draft: seen.draft ? 'yes' : 'no', mergeable: seen.mergeable_state ? `${merges} (${seen.mergeable_state})` : merges }, seen.head?.sha ? { head: seen.head.sha.slice(0, 8) } : {})
        } else shown[`#${String(number)}`] = now
      }
      return { isOver: allThere, detail: lines.join(' '), seen: shown }
    }
    case 'waitForSubAgent': {
      const id = text(a, 'claude_agent_id')
      const agent = (await $.agent.list()).find(x => x.id === id)
      if (!agent) return { isOver: true, detail: `Agent ${id} is not listed, so it ended or the id is wrong. Read its result.` }
      return { isOver: !['pending', 'running', 'waiting'].includes(agent.status), detail: `Agent ${id} is ${agent.status}.`, seen: { status: agent.status } }
    }
    case 'waitForURL': {
      const r = await run($, ['curl', '-sS', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', text(a, 'url')], { cwd: root })
      const code = r.stdout.trim()
      return { isOver: r.exitCode === 0 && /^2\d\d$/.test(code), detail: `HTTP ${code || 'no answer'}, curl exit code ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`, seen: { status: code || 'no answer' } }
    }
    case 'waitForProcessEnd': {
      const r = await run($, ['ps', '-o', 'stat=', '-p', String(a.pid)], { cwd: root })
      const stat = r.stdout.trim()
      // ps exits 1 for no such process. A zombie has ended, and waits only for its parent to read it.
      if (r.exitCode === 1 || stat.startsWith('Z')) return { isOver: true, detail: `Process ${String(a.pid)} has ended. Read its log or result file for how it ended.` }
      return { isOver: false, detail: `Process ${String(a.pid)} has the status "${stat}", ps exit code ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`, seen: { status: stat } }
    }
    case 'waitForSeconds':
      return { isOver: (await $.clock.now()) - startedAt >= Number(a.secs) * 1000, detail: `${String(a.secs)} s have passed.` }
    default: {
      const r = await run($, ['bash', '-c', text(a, 'shell_command')], { cwd: root })
      return { isOver: r.exitCode === 0, detail: `exit code ${r.exitCode}${r.stdout.trim() || r.stderr.trim() ? `: ${(r.stderr.trim() || r.stdout.trim()).slice(-400)}` : ''}`, seen: { 'exit code': String(r.exitCode), said: shownValue('said', r.stderr.trim() || r.stdout.trim()) } }
    }
  }
}

const isStaleWrite = (error: unknown) => error instanceof Error && error.message.includes('set-workflow exited 5')

// Whether the record still holds this wait. It reads and does not take a human's answer.
async function waitGoesOn($: EngineInterface, root: string, id: string): Promise<boolean> {
  const wf = await loadWorkflow($, root)
  if (wf?.state !== 'wait' || wf.waiting?.id !== id) return false
  // The owner stays live through a long wait, or another session could take the workflow over.
  // A busy queue or a lost write only puts this off until the next slice.
  const now = await $.clock.now()
  if (wf.owner && now - wf.owner.at > OWNER_LIVE_MS / 2 && !turnsQueued) {
    await inTurn(async () => {
      const fresh = await loadWorkflow($, root)
      if (fresh?.owner && fresh.state === 'wait' && fresh.waiting?.id === id) {
        fresh.owner = { ...fresh.owner, at: now }
        await saveWorkflow($, fresh)
      }
    }).catch(error => {
      if (!isStaleWrite(error)) throw error
    })
  }
  return true
}

// Ends the wait in one step: the state goes back, or the human's answer is taken if a human came first.
async function waitEnds($: EngineInterface, c: Ctx, root: string, id: string, label: string): Promise<string> {
  for (let tries = 1; ; tries += 1) {
    await whenTurnsFree($)
    try {
      return await inTurn(async () => {
        const wf = await loadWorkflow($, root)
        if (!wf) throw new Error(`the workflow record in ${root} is gone`)
        const isHeld = wf.state === 'wait' && wf.waiting?.id === id
        const given = wf.waitAnswer?.id === id ? wf.waitAnswer.message : undefined
        if (isHeld) moved(wf, label, { state: wf.previous ?? 'developing' }, await $.clock.now())
        if (given !== undefined) wf.waitAnswer = undefined
        if (isHeld || given !== undefined) await saveWorkflow($, wf)
        const said = given ? `The human ended the wait and says: ${given}\n` : isHeld ? '' : `A human moved the workflow to the state "${wf.state}", so the wait ended.\n`
        return said + (await answer($, wf, await factsFor($, wf.root, c.project, wf)))
      })
    } catch (error) {
      if (tries >= 3 || !isStaleWrite(error)) throw error
    }
  }
}

type WaitLimits = { signal: AbortSignal; budget: { remainingMs: number } }

async function waitTool($: EngineInterface, name: string, c: Ctx, limits: WaitLimits): Promise<string> {
  const spec = waitSpec(name, c.args)
  const attempts = name === 'waitForSeconds' ? Infinity : waitNumber(c.args, name, 'attempts', Infinity, true)
  const timeoutS = waitNumber(c.args, name, 'timeout', name === 'waitForSeconds' ? Math.max(WAIT_TIMEOUT_S, spec.period) : WAIT_TIMEOUT_S)
  const startedAt = await $.clock.now()
  const id = `${name}-${startedAt}`
  // A set time is not a retry, so waitForSeconds never raises the notice.
  const most = Math.min(attempts, Math.floor(timeoutS / spec.period))
  await whenTurnsFree($)
  const { root, live } = await inTurn(async () => {
    const wf = await current($, c)
    legal(wf, 'wait', await factsFor($, wf.root, c.project, wf))
    wf.waiting = { id, tool: name, what: shownValue('what', spec.what), at: startedAt, period: spec.period, ...(Number.isFinite(most) ? { most } : {}), timeoutS, args: shownArgs(c.args) }
    wf.waitAnswer = undefined
    moved(wf, name, { state: 'wait', previous: wf.state }, startedAt)
    await saveWorkflow($, wf)
    return { root: wf.root, live: liveName(wf) }
  })
  activeWaits.add(id)
  let alert: { group: string; pid?: number } | undefined
  let problem: string | undefined
  const told = (result: string) => (problem ? `${result}\nNo persistent notification: ${problem}` : result)
  try {
    const deadline = startedAt + timeoutS * 1000
    let tries = 0
    const pastHalf = async () => name !== 'waitForSeconds' && (tries * 2 > most || ((await $.clock.now()) - startedAt) * 2 > timeoutS * 1000)
    for (;;) {
      if (!(await waitGoesOn($, root, id))) return told(await waitEnds($, c, root, id, name))
      if (limits.signal.aborted) throw new Refuse(`Refused: ${name} for ${spec.what} was interrupted.\n${await waitEnds($, c, root, id, 'waitInterrupted')}`)
      if (limits.budget.remainingMs < WAIT_BUDGET_LOW_MS) throw new Refuse(`${name} stopped its wait for ${spec.what} after ${tries} attempts, because the host's time budget for one hook is nearly spent. Repair: call it again.\n${await waitEnds($, c, root, id, 'waitGaveUp')}`)
      const check = await waitCheck($, name, c.args, root, startedAt)
      tries += 1
      const checkedAt = await $.clock.now()
      await writeLive($, root, live, l => ({ ...l, wait: { id, tries, checkedAt, nextAt: Math.min(deadline, checkedAt + spec.period * 1000), detail: shownValue('detail', check.detail), seen: check.seen } }))
      // A human can come during a check, which can last a minute. The answer goes first.
      if (!(await waitGoesOn($, root, id))) return told(await waitEnds($, c, root, id, name))
      if (check.isOver) return told(`The wait for ${spec.what} ended after ${tries} checks. ${check.detail}\n${await waitEnds($, c, root, id, 'waitEnded')}`)
      if (tries < attempts && !alert && (await pastHalf())) {
        const raised = await waitAlert($, root, id, name, spec.what, tries, most, check.detail)
        alert = raised.alert
        problem = raised.problem
      }
      if (tries >= attempts) throw new Refuse(`${name} gave up on ${spec.what} after ${tries} attempts. The last check: ${check.detail}. Repair: call it again with more attempts, or call blocked if only the human can go on.\n${await waitEnds($, c, root, id, 'waitGaveUp')}`)
      if ((await $.clock.now()) >= deadline) throw new Refuse(`${name} gave up on ${spec.what} after its timeout of ${timeoutS} s and ${tries} attempts. The last check: ${check.detail}. Repair: call it again with a longer timeout, or call blocked if only the human can go on.\n${await waitEnds($, c, root, id, 'waitGaveUp')}`)
      const nextAt = Math.min(deadline, (await $.clock.now()) + spec.period * 1000)
      for (let now = await $.clock.now(); now < nextAt; now = await $.clock.now()) {
        const secs = Math.min(WAIT_SLICE_S, (nextAt - now) / 1000)
        const pause = await run($, ['sleep', String(secs)], { cwd: root, timeoutMs: Math.ceil((secs + 10) * 1000) })
        if (pause.exitCode !== 0) throw new Error(`sleep ${secs} exited ${pause.exitCode}: ${pause.stderr.trim().slice(0, 300)}`)
        if (limits.signal.aborted || !(await waitGoesOn($, root, id))) break
      }
    }
  } catch (error) {
    if (error instanceof Refuse) throw error
    // An unexpected failure must not leave the record in "wait", and if it does, the agent is told.
    const message = error instanceof Error ? error.message : String(error)
    const stuck = await waitEnds($, c, root, id, 'waitFailed').then(() => '', (e: unknown) => ` The state stays "wait", because going back also failed: ${e instanceof Error ? e.message : String(e)}. Repair: the human types /unblock <message>, or call started.`)
    throw new Error(`${name} for ${spec.what}: ${message}.${stuck}`)
  } finally {
    activeWaits.delete(id)
    if (alert) {
      const failed = await withdrawAlert($, root, alert)
      if (failed) await $.ui.toast(`ndev: the notice for the wait on ${spec.what} stays on screen: ${failed}`)
    }
  }
}

// Past half the retries the wait may never end, so the human hears of it the way a block does. The
// wait goes on, and it withdraws the notice when it ends.
async function waitAlert($: EngineInterface, root: string, id: string, name: string, what: string, tries: number, most: number, last: string): Promise<{ alert?: { group: string; pid?: number }; problem?: string }> {
  const issue = (await loadWorkflow($, root))?.issue ?? 0
  const raised = await raiseAlert($, root, issue, `${name} for ${what} has run ${tries} of ${most} checks. Last: ${last} /unblock ends the wait.`, `ndev: #${issue}: a wait is past half its retries`)
  const alert = { group: raised.group, pid: raised.pid }
  await inTurn(async () => {
    const wf = await loadWorkflow($, root)
    if (wf?.waiting?.id === id) {
      wf.waiting.alert = alert
      await saveWorkflow($, wf)
    }
  })
  return { alert, problem: raised.problem }
}

// One call at a time for this session: two tools in one block, or a retry while the first still
// runs, must each see the state that the other left.
let queue: Promise<unknown> = Promise.resolve()
let turnsQueued = 0
export const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn)
  turnsQueued += 1
  queue = next.catch(() => undefined).then(() => {
    turnsQueued -= 1
  })
  return next
}

// A hook's budget of ten seconds runs on while it awaits the queue, and not through a process.
// So a hook that must not die behind a long tool waits here, and only then joins the queue.
export async function whenTurnsFree($: EngineInterface): Promise<void> {
  while (turnsQueued) await $.process.run(['sleep', '0.2'])
}

// Each state tool call shows in the /view pane, with its arguments and how it ended.
async function liveStart($: EngineInterface, tool: string, args: Args, project: LoadedConfig | undefined): Promise<{ root: string; name: string; at: number } | undefined> {
  if (tool === 'status' || project?.config.workflow === false) return undefined
  // The pr of waitForPR is the PR it waits for, and not the thing that this agent is on.
  const own = tool === 'waitForPR' ? undefined : args.pr
  const number = own ?? args.issue ?? (Array.isArray(args.issues) ? args.issues[0] : undefined)
  const root = text(args, 'worktree') || (await boundRoot($)) || project?.root
  if (!root || number === undefined || number === null) return undefined
  const name = own ? `pr-${String(own)}` : `issue-${String(number)}`
  return { root, name, at: await liveCallStart($, root, name, tool, args) }
}

async function liveEnd($: EngineInterface, logged: { root: string; name: string; at: number } | undefined, tool: string, outcome: 'ok' | 'refused' | 'failed', result: string): Promise<void> {
  if (logged) await liveCallEnd($, logged.root, logged.name, tool, logged.at, outcome, result)
}

export const workflowTools = (on: Parameters<Register>[0], project: () => LoadedConfig | undefined) => {
  for (const s of SPECS) {
    on('tool.call', { tool: `mcp__ndev__${s.name}` }, async ($, e, next): Promise<{ result: string; isError?: true }> => {
      const args = e as unknown as Args
      if (args.agentId && !s.forSubagents && !(s.name === 'checkpoint' && text(args, 'worktree'))) return { result: `Refused: only the main agent calls ${s.name}. A helper does not move the workflow. Report to the main agent.`, isError: true as const }
      if (args.agentId && s.name === 'followUp' && text(args, 'mode') !== 'issue_only') return { result: "Refused: a helper may only file an issue, with followUp mode 'issue_only'.", isError: true as const }
      const isNumber = (x: unknown) => Number.isInteger(Number(x)) && Number(x) > 0 && x !== null && x !== ''
      if (s.name === 'finishedDevelopment') {
        if (!Array.isArray(args.issues) || !args.issues.length || !args.issues.every(isNumber)) return { result: `Refused: finishedDevelopment needs issues, the list of the issues that this call finishes, and it got ${JSON.stringify(args.issues)}. Nothing changed.`, isError: true as const }
      } else if (STATE_TOOLS.has(s.name)) {
        const issueOnly = ISSUE_ONLY.has(s.name)
        if (!isNumber(args.issue) && (issueOnly || !isNumber(args.pr))) return { result: `Refused: ${s.name} needs ${issueOnly ? 'issue, the number of the issue this call is for' : 'issue or pr, the number that this call is for'}, and it got ${JSON.stringify(issueOnly ? args.issue : { issue: args.issue, pr: args.pr })}. Nothing changed.`, isError: true as const }
      }
      const logged = await liveStart($, s.name, args, project())
      try {
        const name = s.name
        const result = WAIT_TOOLS.includes(name) ? await waitTool($, name, { args, project: project(), tool: name }, next) : await inTurn(() => dispatch($, name, { args, project: project(), tool: name }))
        await liveEnd($, logged, s.name, 'ok', result)
        return { result }
      } catch (error) {
        if (error instanceof Refuse) {
          await liveEnd($, logged, s.name, 'refused', error.message)
          return { result: error.message, isError: true as const }
        }
        const message = `workflow ${s.name} failed: ${error instanceof Error ? error.message : String(error)}`
        await liveEnd($, logged, s.name, 'failed', message)
        return { result: message + (await reportFault($, `workflow tool ${s.name}`, message, `the project ${project()?.root ?? 'unknown'}`)), isError: true as const }
      }
    })
  }
}

