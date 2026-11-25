// The workflow tools: each one does the work of a phase, records the state in the worktree's
// .neil-dev.issue-<id>.json, and answers with the next step. machine.ts decides the moves.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { reportBug, reportFault } from './bug-report'
import { iNeedA, NEED_KINDS } from './i-need-a'

import { loadConfigAt } from '../config'
import type { LoadedConfig, ProjectLevel } from '../config'
import type { Mode, WorkflowLive } from '../../types'
import { readSettings } from '../worktree-settings'
import { RECORD } from '../worktree-stacks'
import { isComponent, reviewText } from '../component-files'
import { type Pr, CHECK_DIR, CheckFailed, MARKER, Refuse, defaultBranch, isOrcaChat, markReady, repoFromOrigin, gh, ghLines, ghOne, changedPaths, comment, git, gitOut, head, missingChecks, must, newFeedback, orca, paths, porcelain, raiseAlert, readChecks, readPr, readPrHealth, run, runCheck, said, withdrawAlert } from './effects'
import type { Check, PrHealth, Ran } from './effects'
import { runningNow, withStep, withToolProgress } from './progress'
import { CHANGE_TYPES, inferChangeTypes, isDocsOnly, isDocsPath, isUserProsePath, isWebPath, requiredSmokeTypes, reviewerBrief, type ChangeType } from './change-types'
import { CHANGE_MAP_LIMIT, buildChangeMap, changeMapBlock, withChangeBlock } from './change-map'
import { takeScreenshots } from './screenshot'
import { CHECKS_WAIT, gitCode, gitFolder, OWN_WAIT, pushNames, pushesOnly, RAW_GIT } from './git-guard.ts'
import { liveCallEnd, liveCallFailed, liveCallStart, liveGitDir, liveName, livePath, readLive, shownArgs, shownValue, writeLive } from './live'
import { ATTEMPT_LIMIT, BEFORE_REVIEW, MACHINES, hasPlanned, reopenState, MERGEABLE_BEFORE_DONE, afterStarted, afterTool, baseCheckScript, boardColumn, mayCommitToBase, mayMerge, maySkipReview, needsSmoke, nextStep, orcaView, hooksFiredBy, type OrcaView, type StageHook, FLOW, STATES } from './machine'
import type { Facts, Position, State, Tool } from './machine'
import { answeredRounds, answerText, commentBody, emptyFile, exitProblem, finishRound, interviewFileName, INTERVIEW_FILE_PATTERN, INTERVIEW_KEYS, interviewOnly, parseChatAnswers, parseRound, resultOf, roundMarkdown, startingAnswers } from './interview-model'
import type { InterviewFile, InterviewRound } from './interview-model'
import { clearInterview, closeInterviewPane, interviewCall, openInterviewPane, showInterview } from './interview'
import type { EarlierQuestion } from './interview'
import { SECRET_NAME, findInText, secretFiles } from './secrets'
import { RECORDS_DIR, citedIds, issueRecordNotes, planLine, recordFileOf, summarise, traceProblems, verificationProblems, type RecordSummary } from './records'

async function checked($: EngineInterface, wf: Workflow, check: Check, args: string[] = [], declared: readonly ChangeType[] = []): Promise<string | undefined> {
  if (wf.noChecks && !(await $.fs.exists(`${wf.root}/${CHECK_DIR}/${check}`))) return `${CHECK_DIR}/${check} did not run: the human skipped the set-up.`
  return runCheck($, wf.root, wf.base, check, args, [...(wf.changeTypes ?? []), ...declared])
}

export type Evidence = { sha: string; text: string }
export type IssueSettings = { mode?: Mode; steering?: 'interactive' | 'auto' }

export type Workflow = {
  // The interview tool call holds, and its notification. Gone when the human has answered.
  asking?: { at: number; group?: string; pid?: number }
  rev?: number
  // The issue, or on a PR record its lead: the lowest number of its issues.
  issue: number
  // Only on a PR record, which the lead issue's file holds under prs from the merge point on.
  pr?: number
  issues?: number[]
  root: string
  repo: string
  base: string
  branch: string
  direct?: boolean
  prs: number[]
  prTitle?: string
  prBody?: string
  // Two to five lower-case words from the agent. The Orca workspace is <issue>-<shortName>, and <PR>-<shortName> once a PR is added.
  shortName?: string
  // What Orca shows now, so that a save sends only a change.
  orca?: OrcaView
  // The board column that this record's cards are in, and one that a failed move left to try again.
  board?: string
  boardTried?: string
  // The check on the base, after the interview and before any code. A failure is recorded, and the work can go on.
  baseCheck?: { sha: string; script: string; exitCode: number; at: number; note?: string }
  // The plugin's dead-code sweep at the start of the review. An exit code of 1 is findings, and above 1 no measure.
  deadcode?: { sha: string; results: { language: string; exitCode: number; output: string }[] }
  // The worktree of an urgent fix: this session is on another issue, so the Orca workspace does not show it.
  hotfix?: boolean
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
  // done ended the issue before its review: it was closed with no change, so nothing waits for a human.
  closedNoChange?: boolean
  attempts: number
  nudges: { count: number; fingerprint?: string }
  // issues and dispatchId belong to the mode worktree: the existing issues its worker carries, lead first,
  // and the Orca dispatch that shows the worker started.
  followUps: { hash: string; mode: string; issue: number; title: string; worktree?: string; issues?: number[]; dispatchId?: string }[]
  // The record of a followUp subagent's own worktree: the issue it came from. The session's Orca
  // workspace shows the session's workflow, not this one.
  followUpOf?: number
  // followUp this_agent: the interview and the base check of the PR that carries the issue stand for it.
  noInterview?: true
  migrations: { name: string; path: string }[]
  merged?: boolean
  feedbackAt?: number
  blocked?: { message: string; at: number; group: string; pid?: number }
  // This issue only. With no value, it follows the worktree and then the project.
  mode?: Mode
  steering?: 'interactive' | 'auto'
  waiting?: { id: string; tool: string; what: string; at: number; period?: number; most?: number; timeoutS?: number; args?: Record<string, string>; alert?: { group: string; pid?: number } }
  waitAnswer?: { id: string; message: string }
  op?: { id: string; tool: string }
  history: { at: number; tool: string; from?: State; to: State }[]
  // The commit whose pending checks refused `done`. The session watches them as it does in `ci`.
  doneWaitsFor?: string
  // What the /view pane last showed live for this record, at the last save. The hot copy is in the git dir.
  live?: WorkflowLive
  // Why the last read of the live file failed.
  liveUnread?: string
  // The stage hooks that a change of state fired, and the result that the tool leaving the stage took.
  hooks?: Partial<Record<StageHook, { firedAt: number; result?: string; agentId?: string; answer?: string }>>
  // Heavy mode only: the second reviewer. hooks.review holds the standards axis, this the specification axis.
  reviewSpec?: { agentId?: string; answer?: string }
  // The copy editor, which starts beside the code review when the change holds prose for users.
  reviewCopy?: { agentId?: string; answer?: string; failed?: string }
  // What the change holds: the union of each type that the agent declared and that the diff showed.
  changeTypes?: ChangeType[]
  // The changed web files, for the screenshots that the next step asks for.
  webFiles?: string[]
  // Why the last read of the diff failed. Until the next good read, nothing is called documents only.
  typesUnread?: string
}

const OWNER_LIVE_MS = 10 * 60_000
export const SECTION = /<!-- ndev:migrations -->[\s\S]*?<!-- \/ndev:migrations -->\n?/

const workflowRoot = atom({ plugin: 'ndev', key: 'workflowRoot' } as const, null as string | null, { shape: 'workflow-root-1' })
// The issue that this agent works on now. A worktree can hold several; each agent has its own.
const workflowIssue = atom({ plugin: 'ndev', key: 'workflowIssue' } as const, null as number | null, { shape: 'workflow-issue-1' })
// The human chose to work without the workflow in this session.
const workflowDeclined = atom({ plugin: 'ndev', key: 'workflowDeclined' } as const, false, { shape: 'workflow-declined-1' })
// False in a session with no human, such as claude -p. Set at session start.
const sessionHasHuman = atom({ plugin: 'ndev', key: 'workflowSessionHasHuman' } as const, true, { shape: 'workflow-session-human-1' })
// The work skills that this session's context holds. A compaction clears them, so started loads them again.
const workSkillsLoaded = atom({ plugin: 'ndev', key: 'workflowSkillsLoaded' } as const, [] as string[], { shape: 'workflow-skills-loaded-1' })
// The worktrees of this session's hotfixes: a commit there passes the git guard when it names the worktree with -C.
const hotfixWorktrees = atom({ plugin: 'ndev', key: 'workflowHotfixWorktrees' } as const, [] as { dir: string; branch: string }[], { shape: 'workflow-hotfix-worktrees-2' })
const hotfixPrs = atom({ plugin: 'ndev', key: 'workflowHotfixPrs' } as const, [] as number[], { shape: 'workflow-hotfix-prs-1' })
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

// Each issue and PR in this worktree. Each issue has its own file, and the file of a PR's lead holds that PR.
// The old keys of the worktree file still read until the next write moves them, and an issue file wins over them.
export type HeldRecords = { issues: Workflow[]; prs: Workflow[]; interviews: InterviewFile[] }
type IssueFile = { workflow?: Workflow; prs?: Record<string, Workflow> }
const ISSUE_FILE = /^\.neil-dev\.issue-[1-9]\d*\.json$/
async function parsed<T>($: EngineInterface, path: string): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)}). Repair: fix the file, then call the tool again.`)
  }
}
// The same rules as readIssue in scripts/work/worktree_env.mjs, which refuses to save over a file that breaks them.
function issueFileProblem(n: number, raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'must hold a JSON object'
  const held = raw as { version?: unknown; issue?: unknown; workflow?: { issue?: unknown }; prs?: unknown }
  const unknown = Object.keys(raw).filter(key => !['version', 'issue', 'workflow', 'prs', ...INTERVIEW_KEYS].includes(key))
  if (unknown.length) return `has the unknown top-level key ${unknown.map(key => `"${key}"`).join(', ')}; the keys are version, issue, workflow, prs, ${INTERVIEW_KEYS.join(', ')}`
  if (held.version !== 1) return `has "version" ${JSON.stringify(held.version)}; this plugin reads version 1`
  if (held.issue !== n) return `must hold "issue" ${n}, and holds ${JSON.stringify(held.issue)}`
  if (held.workflow !== undefined && held.workflow?.issue !== n) return `must hold under workflow an object whose issue is ${n}, and that issue is ${JSON.stringify(held.workflow?.issue)}`
  if (held.prs === undefined) return undefined
  if (typeof held.prs !== 'object' || held.prs === null) return 'must hold "prs" as an object'
  const wrong = Object.entries(held.prs).find(([key, value]) => String((value as { pr?: unknown } | null)?.pr) !== key)
  return wrong ? `must hold under prs.${wrong[0]} an object whose pr is ${wrong[0]}` : undefined
}

// A tool stops at the first bad file. The pane says why that file failed and draws the others.
export async function readHeld($: EngineInterface, root: string): Promise<HeldRecords> {
  return gatherHeld($, root, error => {
    throw error
  })
}
export async function readHeldForPane($: EngineInterface, root: string): Promise<{ held: HeldRecords; problems: string[] }> {
  const problems: string[] = []
  const held = await gatherHeld($, root, error => problems.push(error.message))
  return { held, problems }
}

async function gatherHeld($: EngineInterface, root: string, refused: (error: Error) => void): Promise<HeldRecords> {
  const issues: Record<string, Workflow> = {}
  const prs: Record<string, Workflow> = {}
  const interviews: InterviewFile[] = []
  const path = `${root}/${RECORD}`
  if (await $.fs.exists(path)) {
    const held = await parsed<{ workflow?: Workflow; workflows?: Record<string, Workflow>; prs?: Record<string, Workflow> }>($, path)
    Object.assign(issues, held.workflow ? { [held.workflow.issue]: held.workflow } : {}, held.workflows)
    Object.assign(prs, held.prs)
  }
  if (await $.fs.exists(root)) {
    for (const entry of await $.fs.list(root)) {
      if (!ISSUE_FILE.test(entry.name)) continue
      const file = `${root}/${entry.name}`
      const n = Number(/\d+/.exec(entry.name)?.[0])
      let held: IssueFile
      try {
        held = await parsed<IssueFile>($, file)
        const problem = issueFileProblem(n, held)
        if (problem) throw new Error(`${file} ${problem}. Repair: fix the file, then call the tool again.`)
      } catch (error) {
        refused(error as Error)
        continue
      }
      if (held.workflow) issues[held.workflow.issue] = held.workflow
      Object.assign(prs, held.prs)
      if (INTERVIEW_KEYS.some(key => key in held)) interviews.push(interviewOnly(n, held))
    }
  }
  const filled = (wf: Workflow) => ({ ...wf, migrations: wf.migrations ?? [] })
  return { issues: Object.values(issues).map(filled), prs: Object.values(prs).map(filled), interviews }
}

export async function readWorkflows($: EngineInterface, root: string): Promise<Workflow[]> {
  return (await readHeld($, root)).issues
}

// An issue that finished development belongs to its PR record, while that PR is past its developers.
const effectiveRecord = (wf: Workflow, prs: Workflow[]) => (wf.state === 'developed' ? prs.find(p => p.pr === wf.prs[0] && p.state !== 'developing') : undefined) ?? wf

// One entry for each thing a worktree is doing now: an issue, or a PR that took its issues over.
export const effectiveRecords = ({ issues, prs }: HeldRecords): Workflow[] => [...new Set(issues.map(wf => effectiveRecord(wf, prs)))]
export async function readEffective($: EngineInterface, root: string): Promise<Workflow[]> {
  return effectiveRecords(await readHeld($, root))
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
  if (wf.followUpOf || wf.hotfix || !(await $.env.get('ORCA_WORKSPACE_ID'))) return
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

// The live file holds display data only, so a failed read costs the snapshot and never the save. The record says why.
async function liveSnapshot($: EngineInterface, wf: Workflow): Promise<{ live?: WorkflowLive; error?: string }> {
  try {
    return await readLive($, livePath(await liveGitDir($, wf.root), liveName(wf)))
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 200) }
  }
}

// One place, as for Orca: each way the state changes moves the card. A board that fails does not stop
// the work. A missing card stays missing, so its column is recorded and the board is not read at each save.
async function syncBoard($: EngineInterface, wf: Workflow): Promise<void> {
  if (wf.off) return
  const column = boardColumn(wf)
  if (!column) return
  if (column === wf.board) {
    wf.boardTried = undefined
    return
  }
  if (column === wf.boardTried) return
  // The worktree's copy of the settings can be absent or older than the board, as in view.tsx.
  let loaded = await loadConfigAt($, wf.root)
  if (!loaded.error && !loaded.config.github?.board) {
    const { main } = await paths($, wf.root)
    if (main !== wf.root) loaded = await loadConfigAt($, main)
  }
  if (loaded.error) {
    $.ui.toast(`workflow: the board does not show ${column} for ${labelOf(wf)}: ${loaded.path} has an error (${loaded.error}). Repair: fix the file. The next change of column tries again.`)
    wf.boardTried = column
    return
  }
  if (!loaded.config.github?.board) return
  const { problems, retry } = await moveCards($, wf, column, loaded.path.replace(/\/[^/]+$/, ''))
  if (problems.length) $.ui.toast(`workflow: the board does not show ${column} for ${labelOf(wf)}: ${problems.join(' ')}${retry ? ' The next change of column tries again.' : ''}`)
  if (retry) wf.boardTried = column
  else {
    wf.board = column
    wf.boardTried = undefined
  }
}

export async function saveWorkflow($: EngineInterface, wf: Workflow): Promise<void> {
  await syncOrca($, wf)
  await syncBoard($, wf)
  const shown = await liveSnapshot($, wf)
  const r = await run($, ['bash', envScript($), 'set-workflow', '--expect-rev', String(wf.rev ?? 0), '--worktree', wf.root], { cwd: wf.root, stdin: JSON.stringify({ ...wf, live: shown.live, liveUnread: shown.error }), timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error(`worktree-env.sh set-workflow exited ${r.exitCode} for ${wf.root}: ${said(r)}`)
  wf.rev = (wf.rev ?? 0) + 1
}

// A PR that carries several issues follows the strictest of them.
export const strictest = (records: IssueSettings[]): IssueSettings => {
  // From the strictest down: the first that an issue holds wins.
  const pick = <T extends string>(values: (T | undefined)[], strict: T[]) => strict.find(v => values.includes(v)) ?? values.find(Boolean)
  const mode = pick(records.map(r => r.mode), ['heavy', 'hack'])
  const steering = pick(records.map(r => r.steering), ['interactive'])
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
    planned: own && 'history' in own ? hasPlanned((own as Workflow).history) : undefined,
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

// An agent that followUp started has no interview: it goes on from its brief. A mode with no base check (hack) starts on the code at once.
const isBaseChecked = (wf: Workflow, mode: Mode) => !MACHINES[mode].baseCheck || !!wf.baseCheck || !!wf.followUpOf || !!wf.noInterview

// A declaration of docs proves nothing when the diff could not be read.
const reviewTypes = (wf: Workflow): ChangeType[] => (wf.changeTypes ?? []).filter(type => !wf.typesUnread || type !== 'docs')

export const stepOf = (wf: Workflow, facts: Facts) => nextStep(wf.state, { ...facts, merged: wf.merged, remembered: !!wf.hooks?.remember?.result, changeTypes: reviewTypes(wf), webFiles: wf.webFiles, baseChecked: isBaseChecked(wf, facts.mode) })

async function answer($: EngineInterface, wf: Workflow, facts: Facts, detail: string[] = [], next?: string): Promise<string> {
  const lines = [`State: ${wf.state}. ${whoOf(wf)}. Worktree: ${wf.root}.`, ...detail.filter(Boolean)]
  if (wf.prs[0]) lines.push(`PR: https://github.com/${wf.repo}/pull/${wf.prs[0]}`)
  else if (wf.prTitle) lines.push('PR: none yet. The first push opens the draft PR.')
  const others = (await readEffective($, wf.root)).filter(o => !sameRecord(o, wf) && o.state !== 'done')
  if (others.length) lines.push(`Other issues in this worktree: ${others.map(o => `${o.pr ? `PR #${o.pr}` : `#${o.issue}`} ("${o.state}"${!o.pr && o.prs[0] && o.prs[0] === wf.prs[0] ? `, same PR #${o.prs[0]}` : ''})`).join(', ')}.`)
  lines.push(`Next: ${next ?? stepOf(wf, facts)}`)
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
// Model: models/workflow/issue_workflow.qnt#watchdogBlocksClosedPr
// Model: models/workflow/issue_workflow.qnt#watchdogBlocksStall
export async function blockWorkflow($: EngineInterface, wf: Workflow, message: string): Promise<void> {
  if (wf.state === 'blocked' || wf.state === 'wait' || wf.state === 'done') return
  await enterBlocked($, wf, message, wf.state, 'watchdog')
  await saveWorkflow($, wf)
}

// advisory: the hack's commits, where fast-checks.sh only advises and pre-commit-check.sh waits for hardening.
async function commitAndPush($: EngineInterface, wf: Workflow, tool: string, message: string, files: string[], push = true, declared: readonly ChangeType[] = [], advisory = false): Promise<string[]> {
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
  // A deletion that git rm staged is in neither the tree nor the index, so git add of its path exits 128.
  // It is already staged: leave it out of git add, and the commit still carries it.
  // The old path of a staged rename is such a deletion too, but rename detection lists it as R, so --no-renames.
  const removed = files.length ? (await gitOut(root, $, 'diff', '--cached', '--name-only', '--diff-filter=D', '--no-renames')).split('\n').filter(Boolean) : []
  const committedDeletion = async (f: string) => !(await $.fs.exists(`${root}/${f}`)) && !(await gitOut(root, $, 'ls-files', '--', f)) && !!(await gitOut(root, $, 'log', '-1', '--format=%H', 'HEAD', '--', f))
  // A named folder whose files were all removed is gone from the tree too.
  const toAdd: string[] = []
  for (const f of files) {
    const under = removed.some(r => r === f || r.startsWith(`${f.replace(/\/$/, '')}/`))
    if (under ? removed.includes(f) || !(await $.fs.exists(`${root}/${f}`)) : await committedDeletion(f)) continue
    toAdd.push(f)
  }
  if (toAdd.length) await must($, ['git', 'add', '--', ...toAdd], { cwd: root })
  const staged = (await git(root, $, 'diff', '--cached', '--quiet')).exitCode !== 0
  // A merge that changes no file still has a commit to make: the merge, with its second parent.
  const merging = (await git(root, $, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).exitCode === 0
  if (staged || merging) {
    try {
      // The fast tools first: they name the line in seconds, before the slower script starts.
      let stagedFiles = (await gitOut(root, $, 'diff', '--cached', '--name-only', '--diff-filter=d')).split('\n').filter(Boolean)
      // A merge stages all that the base brought in. A file whose staged version is the base's version
      // is not this branch's change: its faults are the base's, so the fast checks leave it out.
      if (merging) {
        const differs = new Set((await gitOut(root, $, 'diff', '--cached', '--name-only', '--diff-filter=d', 'MERGE_HEAD')).split('\n').filter(Boolean))
        const fromBase = stagedFiles.filter(f => !differs.has(f))
        stagedFiles = stagedFiles.filter(f => differs.has(f))
        if (fromBase.length) notes.push(`A merge is in progress: ${fromBase.length} staged files came from the base unchanged, so fast-checks.sh did not check them, and a fault in them is the base's (baseline), not this branch's: ${fromBase.slice(0, 10).join(', ')}${fromBase.length > 10 ? ', …' : ''}.`)
      }
      if (advisory) {
        try {
          const fast = stagedFiles.length ? await checked($, wf, 'fast-checks.sh', stagedFiles, declared) : undefined
          if (fast) notes.push(fast)
        } catch (error) {
          if (!(error instanceof CheckFailed)) throw error
          notes.push(`Advice only, because this is the hack: the commit was made. ${error.message.replace(' Nothing was pushed.', '')} Hardening runs the full checks, and there a failure stops the commit.`)
        }
      } else {
        const fast = stagedFiles.length ? await checked($, wf, 'fast-checks.sh', stagedFiles, declared) : undefined
        for (const note of [fast, await checked($, wf, 'pre-commit-check.sh', [], declared)]) {
          if (note) notes.push(note)
        }
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
    const note = await checked($, wf, 'pre-push-check.sh', [], declared)
    if (note) notes.push(note)
    const mapNote = await writeChangeMap($, wf, declared)
    if (mapNote) notes.push(mapNote)
    const pushed = await withStep($, 'git push', 300_000, () => run($, ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, timeoutMs: 300_000 }))
    if (pushed.exitCode !== 0) {
      if (!/\[rejected\]|non-fast-forward|fetch first/.test(`${pushed.stdout}\n${pushed.stderr}`)) throw new Refuse(`git push of ${branch} exited ${pushed.exitCode}: ${said(pushed)}\nThe commit is local. Fix the cause and call the tool again.`)
      notes.push(await pushRebased($, root, branch, said(pushed)))
    }
  }
  if (push) {
    const opened = await openPendingPr($, wf)
    if (opened) notes.push(`${opened}, after the first push.`)
  }
  wf.op = undefined
  return notes
}

// A push that the remote rejected as behind. After a rebase, such as onto a new stack base, the remote
// branch holds the old copies of this branch's commits and the old base. A force push with a lease
// loses nothing when each commit that only this remote branch holds has its change in HEAD (git cherry
// marks it -): the old base stays on its own remote branch. Any other commit is real work: refuse and name it.
async function pushRebased($: EngineInterface, root: string, branch: string, rejected: string): Promise<string> {
  const read = async (...args: string[]) => {
    const r = await run($, ['git', ...args], { cwd: root })
    if (r.exitCode !== 0) throw new Refuse(`git push of ${branch} was rejected (${rejected}), and git ${args.join(' ')} exited ${r.exitCode}: ${said(r)}. The commit is local.`)
    return r.stdout
  }
  await read('fetch', 'origin', branch)
  const remote = `origin/${branch}`
  const lease = (await read('rev-parse', remote)).trim()
  // The commits that HEAD lacks and that no other remote branch holds.
  const only = (await read('rev-list', remote, '--not', 'HEAD', `--exclude=refs/remotes/${remote}`, '--remotes=origin')).split('\n').filter(Boolean)
  const replaced = new Set((await read('cherry', 'HEAD', remote)).split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()))
  const kept = only.filter(c => !replaced.has(c))
  if (kept.length) {
    const subjects = (await read('log', '--no-walk', '--format=%H %s', ...kept)).trim()
    throw new Refuse(`git push of ${branch} was rejected: the remote branch is at ${lease.slice(0, 8)} and holds ${kept.length} commit(s) that HEAD lacks, whose change is not in HEAD and that no other remote branch holds:\n${subjects}\nThe commit is local, and nothing was forced. Repair: git -C ${root} pull --rebase origin ${branch} to take them, then call the tool again. If they are meant to go, ask the human.`)
  }
  const forced = await withStep($, 'git push', 300_000, () => run($, ['git', 'push', '-u', `--force-with-lease=refs/heads/${branch}:${lease}`, 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, timeoutMs: 300_000 }))
  if (forced.exitCode !== 0) throw new Refuse(`git push --force-with-lease of ${branch} (expected remote ${lease.slice(0, 8)}) exited ${forced.exitCode}: ${said(forced)}\nThe commit is local. The remote branch may have moved since the fetch: call the tool again.`)
  return `The remote branch ${branch} was behind a rebase: each of its ${only.length} commit(s) that HEAD lacks (${only.map(c => c.slice(0, 8)).join(', ') || 'none'}) has its change in HEAD or stays on another remote branch, so the push replaced ${lease.slice(0, 8)} with --force-with-lease.`
}

async function flagForHuman($: EngineInterface, wf: Workflow, notes: string[]) {
  if (wf.prs[0] && notes.length) await comment($, wf.root, wf.repo, wf.prs[0], `${MARKER}\n**work-heavy-auto:** ${notes.join(' ')}`)
}

async function noAgentsRunning($: EngineInterface) {
  const running = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending')
  if (running.length) throw new Refuse(`Refused: ${running.length} agent(s) still run (${running.map(a => a.id).join(', ')}), and their edits could enter this commit. Nothing changed. Wait for them, then call the tool again.`)
}

const ISSUE_LINK = ':?\\s+(?:(?:[\\w.-]+\\/[\\w.-]+)?#|https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/issues\\/)'
const CLOSING = `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${ISSUE_LINK}`
const PART = `\\b(?:part of|refs?)${ISSUE_LINK}`
const hasIssueRef = (body: string, n: number) => new RegExp(`${CLOSING}${n}\\b`, 'i').test(body)
const namesIssue = (body: string, n: number) => hasIssueRef(body, n) || new RegExp(`${PART}${n}\\b`, 'i').test(body)

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

async function doneProblems($: EngineInterface, wf: Workflow, sha: string, pr: Pr | undefined): Promise<{ problems: string[]; feedback: string[] }> {
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
      wf.doneWaitsFor = sha
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
  if (pr) {
    // Model: models/workflow/issue_workflow.qnt#humanClosesPr
    if (pr.state !== 'open') problems.push(`PR #${pr.number} is closed with no merge. Repair: gh pr reopen ${pr.number} --repo ${repo}.`)
    // Model: models/workflow/issue_workflow.qnt#humanConvertsToDraft
    if (pr.draft) problems.push(`PR #${pr.number} is still a draft. Repair: gh pr ready ${pr.number}.`)
    // GitHub does not compute this for a closed PR, so calling again would never end.
    // Model: models/workflow/issue_workflow.qnt#baseMoves
    if (pr.state === 'open' && pr.mergeable === false) problems.push(`PR #${pr.number} has conflicts with ${wf.base}. Merge ${wf.base} in and call checkpoint.`)
    // Model: models/workflow/issue_workflow.qnt#humanReopensPr
    if (pr.state === 'open' && pr.mergeable === null) problems.push(`GitHub has not finished computing whether PR #${pr.number} can merge. Call done again.`)
    if (pr.head.sha !== sha) problems.push(`PR #${pr.number} is at ${pr.head.sha.slice(0, 8)}, not HEAD ${sha.slice(0, 8)}. Repair: git pull --rebase origin ${wf.branch} when the PR is ahead; call checkpoint with no files when HEAD is ahead.`)
    const body = pr.body ?? ''
    for (const f of wf.followUps.filter(x => x.mode === 'this_agent')) {
      if (!hasIssueRef(body, f.issue)) problems.push(`The PR body has lost "Closes #${f.issue}". Put it back: that sub-issue is carried by this PR.`)
    }
    problems.push(...(await planTraceProblems($, wf, body)).map(p => `${p}.`))
    // Model: models/workflow/issue_workflow.qnt#reviewerComments
    feedback = await newFeedback($, root, repo, wf.issue, pr, wf.feedbackAt ?? 0)
  }
  return { problems, feedback }
}

// A human merged the PR, so its checks and feedback are settled. What the merge left out is for the human to know.
// Model: models/workflow/issue_workflow.qnt#doneAfterHumanMerge
async function afterHumanMerge($: EngineInterface, wf: Workflow, pr: Pr, sha: string): Promise<string[]> {
  await gitOut(wf.root, $, 'fetch', 'origin', wf.base, `refs/pull/${pr.number}/head`)
  const left = await gitOut(wf.root, $, 'rev-list', '--count', '--no-merges', 'HEAD', `^${pr.head.sha}`, `^origin/${wf.base}`)
  if (!/^\d+$/.test(left)) throw new Error(`git rev-list --count --no-merges HEAD ^${pr.head.sha} ^origin/${wf.base} printed ${JSON.stringify(left)}, not a count`)
  if (left !== '0') throw new Refuse(`Not done: PR #${pr.number} merged at ${pr.head.sha.slice(0, 8)}, and HEAD ${sha.slice(0, 8)} holds ${left} commits that are in neither that merge nor ${wf.base}, so done would leave them behind. Nothing changed. Repair: save them with git push origin HEAD:refs/heads/${wf.branch}-rest, file their work with followUp and the mode issue_only and name that branch, then git reset --keep ${pr.head.sha}, which keeps uncommitted changes, and call done again.`)
  const notes = [`PR #${pr.number} is already merged, so done ran no checks and read no feedback.`]
  const dirty = await porcelain($, wf.root)
  if (dirty.length) notes.push(`The tree is not clean: ${changedPaths(dirty).join(', ')}. That work did not merge.`)
  if (pr.head.sha !== sha) notes.push(`HEAD ${sha.slice(0, 8)} is not the merged head ${pr.head.sha.slice(0, 8)}. Check that no commit here was left out.`)
  const siblings = await prSiblings($, wf)
  const migrations = [...new Set([wf, ...siblings].flatMap(o => o.migrations.map(m => m.path)))]
  if (migrations.length) {
    const repairs = migrations.map(path => `supabase migration repair ${/(\d+)_[^/]*$/.exec(path)?.[1] ?? '<version>'} --status applied`)
    notes.push(`Migrations after merge: ${migrations.join(', ')}. Done did not run them. Ask the human to confirm each one. /ndev:merge ${pr.number} runs the pending ones and does not merge again. For one that was already applied by hand, record that with ${repairs.join(', ')}, so that nothing runs it again.`)
  }
  wf.merged = true
  for (const o of siblings) {
    o.merged = true
    await saveWorkflow($, o)
  }
  return notes
}

async function setUpPr($: EngineInterface, wf: Workflow, title: string, shared?: number): Promise<void> {
  if (wf.direct || wf.prs.length) return
  const open = shared ? [] : await ghLines<{ number: number }>($, wf.root, wf.repo, ['pr-list', '--head', wf.branch, '--state', 'open'])
  if (shared ?? open[0]) {
    wf.prs = [(shared ?? open[0]!.number)]
    const pending = wf.prBody
    wf.prTitle = wf.prBody = undefined
    // The branch's PR can carry several issues, and each one closes by it.
    await editBody($, wf, old => {
      const body = pending && !old.trim() ? pending : old
      return namesIssue(body, wf.issue) ? body : `${body.trimEnd()}\n\nCloses #${wf.issue}\n`
    })
    return
  }
  const ahead = await gitOut(wf.root, $, 'rev-list', '--count', `origin/${wf.base}..HEAD`)
  if (ahead === '0') {
    wf.prTitle = title
    return
  }
  const remote = await git(wf.root, $, 'rev-parse', `origin/${wf.branch}`)
  if (remote.exitCode !== 0 || remote.stdout.trim() !== await head(wf.root, $)) {
    await checked($, wf, 'pre-push-check.sh', [], wf.changeTypes ?? [])
    await must($, ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${wf.branch}`], { cwd: wf.root, timeoutMs: 300_000 })
  }
  const { gitDir } = await paths($, wf.root)
  const bodyFile = `${gitDir}/ndev-pr-body.md`
  await $.fs.write(bodyFile, wf.prBody ?? `Plan incoming.\n\nCloses #${wf.issue}\n`)
  const made = await gh($, wf.root, wf.repo, ['pr-new', '--title', title, '--body-file', bodyFile, '--base', wf.base, '--head', wf.branch])
  const number = /\/pull\/(\d+)/.exec(made)?.[1]
  if (!number) throw new Error(`gh.sh pr-new printed no pull request URL: ${made.slice(0, 200)}`)
  wf.prs = [Number(number)]
  wf.prTitle = wf.prBody = undefined
}

async function openPendingPr($: EngineInterface, wf: Workflow): Promise<string | undefined> {
  if (!wf.prTitle || wf.prs.length) return undefined
  await setUpPr($, wf, wf.prTitle)
  if (!wf.prs.length) throw new Refuse(`Issue #${wf.issue} on ${wf.branch} has no commits beyond ${wf.base}. Repair: make a real change and call checkpoint before opening its draft PR.`)
  await saveWorkflow($, wf)
  return `Opened draft PR #${wf.prs[0]}: https://github.com/${wf.repo}/pull/${wf.prs[0]}`
}

async function editBody($: EngineInterface, wf: Workflow, edit: (body: string) => string) {
  if (!wf.prs[0] && wf.prTitle) {
    wf.prBody = edit(wf.prBody ?? `Plan incoming.\n\nCloses #${wf.issue}\n`)
    return
  }
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
  if (wf.direct || (!wf.prs[0] && !wf.prTitle)) return undefined
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
const OFF_SESSION = 'Refused: the human turned the workflow off for this session. Nothing changed. Do the work without these tools, or ask the human to type /flow on.'
// While the workflow is off for the session, these still work: they record a fact and do not move a state.
const KEEP_STATE_TOOLS = ['addMigration', 'finishedInterview']

// From the merge point on, these act on the PR and not on one issue.
const PR_TOOLS = ['finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'done']

// Claude Code continues a session that ran out of context in a new session id. It writes `continuedInSessionId`
// into the old transcript, so the new session is the same agent and keeps the workflow of the old one.
const CONTINUED_SCRIPT = 'for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do [ -f "$f" ] && grep -o \'"continuedInSessionId":"[^"]*"\' "$f" | tail -1 | cut -d\'"\' -f4; done'
async function continuedInto($: EngineInterface, root: string, owner: string, session: string): Promise<boolean> {
  let from = owner
  for (let hop = 0; hop < 10 && from !== session; hop++) {
    const r = await run($, ['bash', '-c', CONTINUED_SCRIPT, '_', from], { cwd: root, timeoutMs: 10_000 })
    const next = r.stdout.trim().split('\n')[0]
    if (r.exitCode !== 0 || !next) return false
    from = next
  }
  return from === session
}

async function current($: EngineInterface, { project, args, tool }: Ctx): Promise<Workflow> {
  if (project?.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  // A session-wide /flow off stops the tools that move a state, also on a record that the call names.
  if (!KEEP_STATE_TOOLS.includes(tool ?? '') && (await read($, workflowDeclined))) throw new Refuse(OFF_SESSION)
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
  if (wf.owner && wf.owner.session !== session && now - wf.owner.at < OWNER_LIVE_MS && !(await continuedInto($, wf.root, wf.owner.session, session))) throw new Refuse(`Refused: the session ${wf.owner.session} owns this workflow, and no transcript of it says it continued into ${session}. Nothing changed. Leave it to that session. If that session is dead, call started with takeOver true.`)
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

// The method of the mode, for the answer of started. The board skills (work-light-auto, work-heavy-auto)
// dispatch other agents, and an agent on one issue does not, so steering does not change the choice.
// A skill that cannot be read does not stop the work: the workflow has already moved, and the note names the repair.
async function workSkill($: EngineInterface, mode: Facts['mode']): Promise<string> {
  const name = mode === 'heavy' ? 'work-heavy' : mode === 'hack' ? 'work-hack' : 'work-light'
  if ((await read($, workSkillsLoaded)).includes(name)) return ''
  const folder = `${$.plugin.root}/skills/${name}`
  const path = `${folder}/SKILL.md`
  const notLoaded = (why: string) => `The ${name} skill was not loaded: ${path} ${why}. Repair: call the Skill tool with ndev:${name}.`
  let file: string
  try {
    file = await $.fs.read(path)
  } catch (error) {
    return notLoaded(`could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = file.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  if (!body) return notLoaded('has no text')
  await update($, workSkillsLoaded, loaded => [...loaded, name])
  return `The ${name} skill follows. Develop by it. Its relative paths start at ${folder}.\n\n${body.replaceAll('${CLAUDE_PLUGIN_ROOT}', $.plugin.root)}`
}

// A new issue in a worktree takes the branch that is checked out. The work of a merged PR is finished,
// so a new issue on that branch would carry old commits. A PR closed without a merge can go on.
async function refuseMergedBranch($: EngineInterface, root: string, repo: string, branch: string, base: string, issue: number): Promise<void> {
  const prs = await ghLines<{ number: number; state: string; merged: boolean }>($, root, repo, ['pr-list', '--head', branch, '--state', 'all'])
  const merged = prs.find(p => p.merged)
  if (!merged || prs.some(p => p.state === 'open')) return
  throw new Refuse(`Refused: the branch ${branch} of ${root} has merged in PR #${merged.number} and has no open PR, so issue #${issue} cannot start on it. Nothing changed. Repair: git -C ${root} fetch origin ${base} && git -C ${root} switch -c issue-${issue} origin/${base}, then call started again. Or start #${issue} from the main checkout, which claims a new worktree.`)
}

// GitHub marks a PR merged when another PR lands its head commit, and a human can close one, while the issue
// goes on. A record before the merge point that names such a PR would send each later tool to a dead PR.
// A merged PR cannot open again, so the record drops it and setUpPr opens a new draft PR. A closed one can.
const BEFORE_PR = ['setup', 'interviewing', 'planning', 'developing', 'hardening']
// Model: models/workflow/issue_workflow.qnt#startedReplacesMergedPr
async function replaceDeadPr($: EngineInterface, wf: Workflow, issueState: string): Promise<string | undefined> {
  const n = wf.prs[0]
  const stage = wf.state === 'blocked' || wf.state === 'wait' ? wf.previous : wf.state
  if (wf.direct || wf.merged || n === undefined || !BEFORE_PR.includes(stage ?? '') || issueState !== 'open') return undefined
  const pr = await readPr($, wf.root, wf.repo, n)
  // Model: models/workflow/issue_workflow.qnt#humanReopensPr
  if (pr.state === 'open') return undefined
  if (!pr.merged) throw new Refuse(`Refused: PR #${n} is closed with no merge, and issue #${wf.issue} is open in the state "${wf.state}", so its work has no PR. Nothing changed. Repair: gh pr reopen ${n} --repo ${wf.repo}, then call started again. If the PR was closed on purpose, ask the human.`)
  // A stale origin base counts commits that the merge put on the base, and the new PR needs one of its own.
  await must($, ['git', 'fetch', 'origin', wf.base], { cwd: wf.root, timeoutMs: 120_000 })
  wf.prs = []
  wf.prsClosed = undefined
  return `PR #${n} is merged (head ${pr.head.sha.slice(0, 8)}), but issue #${wf.issue} is open in the state "${wf.state}". The record no longer names #${n}: this call opens a new draft PR for the branch ${wf.branch}.`
}

// Model: models/workflow/issue_workflow.qnt#started
async function started($: EngineInterface, c: Ctx): Promise<string> {
  if (await read($, workflowDeclined)) throw new Refuse('Refused: the human chose to work without the workflow in this session. Do the work without these tools, or ask the human to type /flow on.')
  const { args, project } = c
  const issue = Number(args.issue)
  if (!Number.isInteger(issue) || issue <= 0) throw new Refuse(`Refused: issue must be an issue number, and it is ${JSON.stringify(args.issue)}.`)
  const shortName = text(args, 'shortName') || undefined
  if (shortName) refuseShortName(shortName, issue)
  const chosen = text(args, 'mode') || undefined
  if (chosen && chosen !== 'light' && chosen !== 'heavy' && chosen !== 'hack') throw new Refuse(`Refused: mode is ${JSON.stringify(chosen)}. Use "light", "heavy" or "hack".`)
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
  // Model: models/workflow/issue_workflow.qnt#humanClosesIssue
  // Model: models/workflow/issue_workflow.qnt#humanReopensIssue
  const issueInfo = await ghOne<{ state: string; title: string; body?: string }>($, root, repo, ['issue-read', String(issue)])
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
    if (isMine && active.branch !== branchHere) throw new Refuse(`Refused: ${root} is on ${branchHere}, and ${whoOf(active)} of this session is on ${active.branch} here, so issue #${issue} cannot join its PR. Nothing changed. Repair: git switch ${active.branch} and call started again to join that PR, or start #${issue} from the main checkout, which claims its own worktree.`)
    else if (isMine) joined = active
    else if (active.state !== 'done') throw new Refuse(`Refused: ${whoOf(active)} in ${active.root} belongs to the session ${active.owner?.session ?? active.lastSession ?? 'of another agent'}, and issue #${issue} would join its PR. Nothing changed. Repair: start #${issue} from the main checkout, which claims its own worktree. If that session is dead, call started with takeOver true.`)
    else if (!info.isMain) neighbour = active
  }
  const beside = joined ?? neighbour
  // The PR of this worktree has ended. A session here cannot change its folder to the main checkout,
  // so the new issue gets a new worktree claimed from the main checkout, as a start there would.
  let claimFromMain: string | undefined
  if (beside?.prs[0]) {
    const n = beside.prs[0]
    const prState = beside.merged ? 'merged' : (await readPr($, root, repo, n)).state
    if (prState !== 'open') {
      if (!info.isMain) claimFromMain = `PR #${n} of ${root} is ${prState}, so issue #${issue} did not join it: it has a new worktree, claimed from the main checkout ${info.main}.`
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
    else if (info.isMain || claimFromMain) {
      mayOpen()
      const main = info.main
      await must($, ['git', 'fetch', 'origin', base], { cwd: main, timeoutMs: 120_000 })
      const claimed = await run($, ['bash', `${$.plugin.root}/scripts/work/worktree_claim.sh`, main, String(issue), `origin/${base}`], { cwd: main, timeoutMs: 120_000 })
      if (claimed.exitCode !== 0) throw new Refuse(`worktree_claim.sh exited ${claimed.exitCode} for issue #${issue} in ${main}: ${said(claimed)}`)
      root = claimed.stdout.trim().split('\n').pop()!
      claimNote = await initSubmodules($, project, main, root)
    } else if (branchHere === base) {
      throw new Refuse(`Refused: ${home} is on the base branch ${base}. Create a branch first, or set "projectLevel": "straw_man" to commit to it from the main checkout.`)
    } else {
      await refuseMergedBranch($, home, repo, branchHere, base, issue)
    }
  }
  if (wf?.owner && wf.owner.session !== session && now - wf.owner.at < OWNER_LIVE_MS && args.takeOver !== true && !(await continuedInto($, root, wf.owner.session, session))) {
    throw new Refuse(`Refused: the session ${wf.owner.session} owns issue #${issue} in ${root}, and it was active in the last 10 minutes. If that session is dead, call started again with takeOver true.`)
  }

  // Past setup the work has started, so a change of mode is the human's.
  if (chosen && wf && wf.state !== 'setup' && chosen !== (await factsFor($, root, project, wf)).mode) {
    throw new Refuse(`Refused: the mode of issue #${issue} is set when its workflow starts, and it is in the state "${wf.state}". The human can change it with /flow mode ${chosen} ${issue}.`)
  }
  const facts = await factsFor($, root, project, chosen ? { ...wf, mode: chosen as IssueSettings['mode'] } : wf)
  if (facts.mode === 'hack' && facts.steering === 'auto') throw new Refuse(HACK_AUTO(`issue #${issue}`, issue))
  if (!wf) mayOpen()
  // Model: models/workflow/issue_workflow.qnt#startedReplacesMergedPr
  const deadPr = wf ? await replaceDeadPr($, wf, issueInfo.state) : undefined
  const blockers = (await ghLines<{ number: number; state: string }>($, root, repo, ['blocked-by', 'list', String(issue)])).filter(b => b.state === 'open')
  const missing = await missingChecks($, root)
  const branch = wf?.branch ?? joined?.branch ?? (await gitOut(root, $, 'rev-parse', '--abbrev-ref', 'HEAD'))

  const claimNotes: string[] = []
  const record: Workflow = wf ?? { issue, root, repo, base: joined?.base ?? base, branch, direct: direct || undefined, prs: [], state: 'setup', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [] }
  const isNew = !wf
  record.owner = { session, at: now }
  // A hold lives in the tool call that made it, so a new call finds no one asking.
  if (record.asking) {
    const failed = await withdrawAlert($, root, record.asking)
    if (failed) claimNotes.push(`The old interview notification stays on screen: ${failed}`)
    record.asking = undefined
  }
  // A running wait withdraws its own notice. The notice of a wait that nothing holds is for this call to withdraw.
  if (record.waiting?.alert && !isWaitRunning(record.waiting.id)) {
    const failed = await withdrawAlert($, root, record.waiting.alert)
    if (failed) claimNotes.push(`The notice of the old wait stays on screen: ${failed}`)
  }
  claimNotes.push(...(await prepareInterview($, root, issue)))
  if (shortName) record.shortName = shortName
  if (chosen) record.mode = chosen as IssueSettings['mode']

  let feedback: string[] = []
  let prConflict = false
  // Model: models/workflow/issue_workflow.qnt#startedAfterDone
  // Model: models/workflow/issue_workflow.qnt#reviewerComments
  // Model: models/workflow/issue_workflow.qnt#baseMoves
  if (record.state === 'done' && record.prs[0]) {
    const pr = await readPr($, root, repo, record.prs[0])
    if (pr.state === 'open') {
      feedback = await newFeedback($, root, repo, issue, pr, record.feedbackAt ?? 0)
      prConflict = pr.mergeable === false
    }
  }
  // Model: models/workflow/issue_workflow.qnt#startedEndsWait
  const to = afterStarted(isNew ? undefined : { state: record.state, previous: record.previous }, { mode: facts.mode, steering: facts.steering, scriptsMissing: missing.length > 0, blockerOpen: blockers.length > 0, feedback: feedback.length > 0, prConflict })
  const notes: string[] = [...(claimFromMain ? [claimFromMain] : []), ...(claimNote ? [claimNote] : []), ...(deadPr ? [deadPr] : []), ...claimNotes]
  if (prConflict) notes.push(`PR #${record.prs[0]} has conflicts with ${record.base}. Merge origin/${record.base} into this branch, resolve the conflicts, and call checkpoint.`)
  notes.push(`Mode: ${facts.mode}, steering: ${facts.steering}, for issue #${issue}.`)
  notes.push('If this issue has the label "incomprehensible", a human could not understand it: rewrite it for clarity before any other work (work-heavy F0c).')
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
    notes.push(`These check scripts are missing or not executable: ${missing.join(', ')}. fast-checks.sh takes the changed files as arguments and runs only very fast tools on them, such as ruff, ty, oxlint and ast-grep; start from ${$.plugin.root}/scripts/workflow/fast-checks-template.sh. pre-commit-check.sh runs the full lint and typecheck. pre-push-check.sh runs the unit tests. pre-ready-check.sh runs the full suite and E2E. Each exits non-zero on failure. A check that compares with the base reads NDEV_MERGE_BASE, not git merge-base HEAD, which is the old base while a merge commit is made. A check that chooses its tests reads NDEV_CHANGE_TYPES (comma-separated web, backend, database, docs, tests, config), and reads its own diff when it is unset. Take the commands from the project's CLAUDE.md.`)
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
      notes.push(await backToDevelopers($, project, carrier, issue, 'started'))
    }
  }
  if (isNew) notes.push(...(await issueRecords($, root, issue, issueInfo.body ?? '')))
  if (root !== home) notes.push(`The work is in ${root}, not this session's folder. Change to it before you edit.`)
  if (record.direct) notes.push('This straw_man project commits directly to the base branch, with no PR.')
  if (feedback.length) notes.push(`New feedback:\n${feedback.join('\n')}`)
  if (record.state === 'reviewing') {
    notes.push(await resumeReview($, record, facts))
    await saveWorkflow($, record)
  }
  const skill = await workSkill($, facts.mode)
  const reply = await answer($, record, facts, notes)
  return skill ? `${reply}\n\n${skill}` : reply
}

const PLANS = /<!-- ndev:plan:(\d+) -->[\s\S]*?<!-- \/ndev:plan:\1 -->\n?/g
const CLOSING_REFS = new RegExp(`${CLOSING}(\\d+)\\b`, 'gi')

// A PR can carry several issues, so each plan has its own section. This plan replaces only the earlier
// plan of its issue, and no closing reference is lost: a sub-issue that followUp added is outside the plans.
// The PR body that the agent writes has its own section: the plan and a sign-off in the plan stay.
const BODY = /<!-- ndev:body -->[\s\S]*?<!-- \/ndev:body -->\n?/
function withBodySection(old: string, issue: number, text: string): string {
  const section = `<!-- ndev:body -->\n${text.trim()}\n<!-- /ndev:body -->`
  const rest = old.replace(BODY, '').replace(/^Plan incoming\.\s*$/m, '').split('\n').filter(line => {
    const bare = /^\s*closes #(\d+)\s*$/i.exec(line)
    return !bare || !namesIssue(section, Number(bare[1]))
  }).join('\n').trim()
  const closes = namesIssue(section, issue) || namesIssue(rest, issue) ? '' : `Closes #${issue}\n`
  return `${section}\n\n${rest ? `${rest}\n` : ''}${closes}`
}

function planBody(old: string, issue: number, plan: string): string {
  const others = [...old.matchAll(PLANS)].filter(m => Number(m[1]) !== issue).map(m => m[0].trim())
  const own = `<!-- ndev:plan:${issue} -->\n${plan.trim()}\n${namesIssue(plan, issue) ? '' : `Closes #${issue}\n`}<!-- /ndev:plan:${issue} -->`
  const plans = [...others, own].join('\n\n')
  // All that is not a plan stays, such as a note from the human. A plain closing line that a plan now holds goes.
  const kept = old.replace(PLANS, '').replace(SECTION, '').replace(/^Plan incoming\.\s*$/m, '').split('\n').filter(line => {
    const bare = /^\s*closes #(\d+)\s*$/i.exec(line)
    return !bare || !namesIssue(plans, Number(bare[1]))
  }).join('\n').trim()
  // A reference that only the replaced plan held is still carried by this PR.
  const refs = [...new Set([...old.matchAll(CLOSING_REFS)].map(m => Number(m[1])))].filter(n => !namesIssue(plans, n) && !hasIssueRef(kept, n))
  return `${plans}\n\n${kept ? `${kept}\n` : ''}${refs.map(n => `Closes #${n}\n`).join('')}${SECTION.exec(old)?.[0] ?? ''}`
}

async function citedRecords($: EngineInterface, root: string, ids: string[]): Promise<RecordSummary[]> {
  const dir = `${root}/${RECORDS_DIR}`
  if (!ids.length || !(await $.fs.exists(dir))) return []
  const files = (await $.fs.list(dir)).map(e => e.name)
  const found: RecordSummary[] = []
  for (const id of ids) {
    const file = recordFileOf(id, files)
    if (file) found.push(summarise(file, await $.fs.read(`${dir}/${file}`)))
  }
  return found
}

async function issueRecords($: EngineInterface, root: string, issue: number, body: string): Promise<string[]> {
  if (!(await $.fs.exists(`${root}/${RECORDS_DIR}`))) return []
  const ids = citedIds(body)
  return issueRecordNotes(issue, ids, await citedRecords($, root, ids))
}

async function planTraceProblems($: EngineInterface, wf: Workflow, body: string): Promise<string[]> {
  const line = planLine(body, 'Requirements')
  return line ? traceProblems(await citedRecords($, wf.root, citedIds(line)), `https://github.com/${wf.repo}/pull/${wf.prs[0]}`) : []
}

async function planRecordProblems($: EngineInterface, root: string, text: string): Promise<string[]> {
  const records = `${root}/${RECORDS_DIR}`
  if (!(await $.fs.exists(records))) return []
  const problems: string[] = []
  const requirements = planLine(text, 'Requirements')
  if (requirements === undefined) problems.push('it has no "Requirements:" line')
  else if (!requirements) problems.push('its "Requirements:" line is empty; write the value on the same line')
  else {
    const files = (await $.fs.list(records)).map(e => e.name)
    for (const id of citedIds(requirements)) {
      if (!recordFileOf(id, files)) problems.push(`${id} has no record in ${RECORDS_DIR}`)
    }
    problems.push(...verificationProblems(text, citedIds(requirements)))
  }
  const model = planLine(text, 'Model')
  if (model === undefined) problems.push('it has no "Model:" line')
  else {
    const none = /^none\b/i.test(model)
    const paths = none ? [] : model.match(/[^\s,;`()[\]"'|<>]+\.qnt\b/g) ?? []
    if (none ? !/^none\b\W*\w/i.test(model) : !paths.length) problems.push(`"Model: ${model || 'none'}" needs a reason: write "Model: none, <reason>", or name the .qnt files`)
    for (const path of paths) {
      if (path.startsWith('/') || path.split('/').includes('..')) problems.push(`the model ${path} is outside the worktree: name it relative to ${root}`)
      else if (!(await $.fs.exists(`${root}/${path}`))) problems.push(`the model ${path} does not exist in ${root}`)
    }
  }
  return problems
}

// Model: models/workflow/issue_workflow.qnt#finishedPlan
async function finishedPlan($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedPlan', facts)
  havePr(wf, true)
  const name = text(args, 'markdown_file')
  const path = name.startsWith('/') ? name : `${wf.root}/${name}`
  if (!name || !(await $.fs.exists(path))) throw new Refuse(`Refused: the plan file ${path || '(none given)'} does not exist. Nothing changed.`)
  const plan = await $.fs.read(path)
  if (!/^\W*(Test entry point|Seam):/im.test(plan)) throw new Refuse(`Refused: ${path} has no "Test entry point:" line. Name the public interface that the tests go through, and call finishedPlan again.`)
  const recordProblems = await planRecordProblems($, wf.root, plan)
  if (recordProblems.length) throw new Refuse(`Refused: the plan ${path} does not name its requirement records and model:\n${recordProblems.map(p => `- ${p}`).join('\n')}\nAdd "Requirements: REQ-NNNN, ..." (or "none, <reason>") and "Model: <path.qnt[#name]>, ..." (or "none, <reason>"), as kb/requirements.md "In the workflow" says, and call finishedPlan again.`)
  await editBody($, wf, old => planBody(old, wf.issue, plan))
  // Before the sign-off, so that the human reads the plan and the state of the base together.
  const base = await runBaseCheck($, wf, facts)
  const to = afterTool({ state: wf.state }, 'finishedPlan', facts) as Position
  const notes: string[] = [...base.notes]
  if (to.state === 'blocked') notes.push(...(await enterBlocked($, wf, `The plan for #${wf.issue} waits for your sign-off in ${wf.prs[0] ? 'the PR body' : path}.${base.failed ? ` Also: ${base.failed}` : ''}`, to.previous!, 'finishedPlan')))
  else moved(wf, 'finishedPlan', to, await $.clock.now())
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// The base check: after the interview and before any code, so that a broken base does not cost the human's
// attention later. A failure is recorded and does not stop the tool: the agent decides what to do with it.
async function runBaseCheck($: EngineInterface, wf: Workflow, facts: Facts): Promise<{ notes: string[]; failed?: string }> {
  const script = baseCheckScript(facts.mode)
  if (!script) return { notes: [`${facts.mode} mode has no base check, so none ran.`] }
  const sha = await head(wf.root, $)
  const at = await $.clock.now()
  // A record from before this check, or a second call, can already hold commits.
  const ahead = await git(wf.root, $, 'rev-list', '--count', `origin/${wf.base}..HEAD`)
  const startCommit = await git(wf.root, $, 'log', '-1', '--format=%(trailers:key=Ndev-Op,valueonly)')
  const fresh = ahead.exitCode === 0 && (ahead.stdout.trim() === '0' || (ahead.stdout.trim() === '1' && startCommit.stdout.includes('start-')))
  try {
    const note = await checked($, wf, script)
    wf.baseCheck = { sha, script, exitCode: 0, at, ...(note ? { note } : {}) }
    return { notes: [note ? `Base check: ${note}` : `Base check: ${script} passed on ${sha.slice(0, 8)}.`] }
  } catch (error) {
    if (!(error instanceof CheckFailed)) throw error
    const { exitCode, log, output } = error.detail
    wf.baseCheck = { sha, script, exitCode, at }
    if (exitCode === 0) return { notes: [`Base check: ${error.message}`] }
    return {
      failed: `${script} exited ${exitCode} ${fresh ? 'on the base' : 'on this branch'} (${sha.slice(0, 8)}).`,
      notes: [`Base check: ${script} exited ${exitCode} on ${sha.slice(0, 8)}${fresh ? ', before this work changed anything' : ', and this branch already holds commits, so the cause can be in them'}. Log: ${log}\n${output}\nThe commits of this work run the same checks, so this failure also stops them. Decide now: fix it here if the fix is small, file it with followUp, or call blocked if only the human can decide. Record a failure that this work did not cause in the PR: it is not a pass.`],
    }
  }
}

// Model: models/workflow/issue_workflow.qnt#finishedInterview
async function finishedInterview($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  if (wf.state !== 'developing') throw new Refuse(`Refused: finishedInterview is valid only in the state "developing", and ${labelOf(wf)} is in the state "${wf.state}". No check ran. Next: ${stepOf(wf, facts)}`)
  const { notes } = await runBaseCheck($, wf, facts)
  const receipt = wf.baseCheck
  return retryWorkflowSave('finishedInterview', async () => {
    const latest = await current($, c)
    const latestFacts = await factsFor($, latest.root, c.project, latest)
    if (latest.state !== 'developing') throw new Refuse(`Refused: finishedInterview cannot save the base check for ${labelOf(latest)} in state "${latest.state}". Repair: call status and follow its next step.`)
    if (receipt && (receipt.sha !== await head(latest.root, $) || receipt.script !== baseCheckScript(latestFacts.mode))) throw new Refuse(`Refused: the base check for ${labelOf(latest)} no longer matches its commit or mode. Repair: call finishedInterview again to check the current commit.`)
    latest.baseCheck = receipt
    await saveWorkflow($, latest)
    return answer($, latest, latestFacts, notes)
  })
}

// Development starts with the base check. The refusal comes before any commit.
function refuseBeforeBaseCheck(wf: Workflow, tool: string, mode: Mode) {
  if (wf.state === 'developing' && !isBaseChecked(wf, mode)) throw new Refuse(`Refused: the interview of ${labelOf(wf)} has not ended, so ${tool} did nothing. Repair: after the last question, call finishedInterview. It runs the base check, and then ${tool} works.`)
}

// False when the range cannot be read, such as after a rebase: then the evidence is stale.
async function onlyDocsBetween($: EngineInterface, wf: Workflow, from: string, to: string): Promise<boolean> {
  const r = await git(wf.root, $, 'diff', '--name-only', from, to)
  return r.exitCode === 0 && r.stdout.split('\n').filter(Boolean).every(isDocsPath)
}

function havePr(wf: Workflow, pending = false) {
  if (!wf.direct && !wf.prs.length && !(pending && wf.prTitle)) throw new Refuse(`Refused: the workflow of #${wf.issue} has no PR. Nothing changed. Call started with issue ${wf.issue}: it opens the draft PR.`)
}

// A human can merge the PR while the workflow is still in review, ci, smoke or revising. Its branch then takes no
// commit that the PR would carry, and only done is left: it ends the record as after a merge in finishing.
// Model: models/workflow/issue_workflow.qnt#humanMergesPr
async function mergedBeforeDone($: EngineInterface, wf: Workflow): Promise<Pr | undefined> {
  const n = wf.prs[0]
  if (wf.direct || !n || !MERGEABLE_BEFORE_DONE.includes(wf.state)) return undefined
  const pr = await readPr($, wf.root, wf.repo, n)
  return pr.merged ? pr : undefined
}
// Model: models/workflow/issue_workflow.qnt#checkpointWith
async function mergedBeforeCheckpoint($: EngineInterface, wf: Workflow): Promise<Pr | undefined> {
  const n = wf.prs[0]
  if (wf.direct || !n || wf.state === 'done') return undefined
  const pr = await readPr($, wf.root, wf.repo, n).catch((error: unknown) => {
    throw new Refuse(`Refused: checkpoint could not read PR #${n} of ${wf.repo} to check that it is not merged: ${String(error).slice(0, 300)}. Nothing changed. Repair: check gh auth status and the GitHub rate limit (gh api rate_limit), then call checkpoint again.`)
  })
  return pr.merged ? pr : undefined
}
const doneRoute = (state: State) =>
  MERGEABLE_BEFORE_DONE.includes(state) || state === 'finishing' ? 'call done with a message and remembered: it ends the workflow of a merged PR'
    : BEFORE_REVIEW.includes(state) ? 'with its issue closed, call done with a message and remembered: it ends the workflow of a merged PR. While the issue is open, ask the human to run /flow goto reviewing, then call done'
    : 'ask the human to run /flow goto reviewing, then call done with a message and remembered: it ends the workflow of a merged PR'
const mergedRefusal = (pr: Pr, tool: string, sha: string, route = doneRoute('reviewing')) =>
  `Refused: PR #${pr.number} is merged, at ${pr.head.sha.slice(0, 8)}${pr.head.sha === sha ? '' : `, and HEAD is ${sha.slice(0, 8)}`}, so ${tool === 'checkpoint' ? 'its branch takes no commit that the PR would carry' : tool === 'finishedReview' ? 'a push to its branch reaches no PR' : 'there are no checks left for it'}. Nothing changed. Repair: ${route}. Done refuses while commits did not merge. File other work with followUp and the mode issue_only.`

// A finished PR can still take a commit, such as a conflict fix, until it merges or closes.
async function isOpenAfterDone($: EngineInterface, wf: Workflow): Promise<boolean> {
  const n = wf.prs[0]
  if (wf.state !== 'done' || wf.direct || !n) return false
  const pr = wf.merged ? undefined : await readPr($, wf.root, wf.repo, n)
  if (pr?.state === 'open') return true
  throw new Refuse(`Refused: PR #${n} is ${wf.merged || pr?.merged ? 'merged' : 'closed with no merge'}, so it cannot carry a new commit. Nothing changed. Repair: file the work with followUp and the mode issue_only.`)
}

// The checks between the read and the save can take minutes, and another session or hook can save the record
// meanwhile. The save then refuses, so checkpoint reads the record again and redoes the call: the Ndev-Op
// trailer finds a commit that the last try made, so the redo neither commits nor pushes twice.
const CHECKPOINT_TRIES = 3
// In these states the last commit waits for the review, so only finishedReview, or a human's skip of the review, pushes it.
const holdsForReview = (state: string) => state === 'reviewing' || state === 'developed'
// A hack keeps its commits on this computer until the review: in the hack, and in hardening.
const holdsLocally = (state: State, mode: Mode) => state === 'hardening' || !!MACHINES[mode].localOnly?.includes(state)
const LOCAL_PUSH_ROUTES = (state: State) => `${state === 'hardening' ? '' : 'call finishedHacking, harden the change, then '}call finishedDevelopment with the hardening evidence. finishedReview makes the first push.`
const REVIEW_PUSH_ROUTES = 'finishedReview runs pre-ready-check.sh and pushes it. When that cannot pass, a human skips the review with /flow skip <reason>, and then checkpoint with no files pushes the held commit.'
// "developed" has no phase to skip: the review starts when each issue on the PR has called finishedDevelopment.
const reviewPushRoutes = (state: string) => (state === 'reviewing' ? REVIEW_PUSH_ROUTES : `the review starts once each issue on the PR has called finishedDevelopment, and then ${REVIEW_PUSH_ROUTES}`)

async function checkpoint($: EngineInterface, c: Ctx): Promise<string> {
  return retryWorkflowSave('checkpoint', () => checkpointOnce($, c))
}

async function retryWorkflowSave<T>(tool: string, step: () => Promise<T>, canRetry = () => true): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await step()
    } catch (error) {
      if (!isStaleWrite(error) || !canRetry()) throw error
      if (tries >= CHECKPOINT_TRIES) throw new Error(`${(error as Error).message} ${tool} read the record again ${tries} times, and each time another writer saved it first. A commit that a try made carries its Ndev-Op trailer. Repair: call status, then ${tool} again with the same arguments.`)
    }
  }
}

// Model: models/workflow/issue_workflow.qnt#checkpoint
async function checkpointOnce($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const files = list(args, 'files')
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: checkpoint needs a commit message.')
  const declared = declaredTypes(args)
  const facts = await factsFor($, wf.root, project, wf)
  const prOpen = await isOpenAfterDone($, wf)
  legal(wf, 'checkpoint', { ...facts, prOpen })
  const mergedPr = await mergedBeforeCheckpoint($, wf)
  if (mergedPr) throw new Refuse(mergedRefusal(mergedPr, 'checkpoint', await head(wf.root, $), doneRoute(wf.state)))
  refuseBeforeBaseCheck(wf, 'checkpoint', facts.mode)
  havePr(wf, true)
  const before = await head(wf.root, $)
  // An issue that finished development holds its commit for the review of the PR, so this one must not push it.
  const holders: Workflow[] = []
  if (!wf.pr) for (const o of await prSiblings($, wf)) if (!o.pr && (o.state === 'developed' || holdsLocally(o.state, (await factsFor($, o.root, project, o)).mode))) holders.push(o)
  const local = holdsLocally(wf.state, facts.mode)
  const hold = holdsForReview(wf.state) || local || holders.length > 0
  // With no files, a checkpoint only pushes a held commit, such as after a human skips the review.
  const held = (await git(wf.root, $, 'rev-parse', `origin/${wf.branch}`)).stdout.trim() !== before
  if (!files.length && !held && !(wf.prTitle && wf.op?.tool === 'checkpoint')) throw new Refuse(`Refused: checkpoint needs the files to commit, each by name.${wf.state === 'reviewing' ? ' With nothing more to commit, finishedReview goes on.' : ''}`)
  if (!files.length && local) throw new Refuse(`Refused: ${labelOf(wf)} is ${wf.state === 'hardening' ? 'in hardening' : 'in the hack'}, so its commits stay on this computer until the review, and checkpoint with no files does not push commit ${before.slice(0, 8)}. Nothing was pushed. Repair: ${LOCAL_PUSH_ROUTES(wf.state)}`)
  if (!files.length && hold) {
    const why = holdsForReview(wf.state) ? `issue #${wf.issue} is in the state "${wf.state}"` : `${holders.map(o => `#${o.issue}`).join(', ')} on this PR finished development and holds a commit for the review`
    throw new Refuse(`Refused: ${why}, so commit ${before.slice(0, 8)} is held for the review, and checkpoint with no files does not push it. Nothing was pushed. Repair: ${reviewPushRoutes(holdsForReview(wf.state) ? wf.state : 'developed')}`)
  }
  const advisory = !!MACHINES[facts.mode].localOnly?.includes(wf.state)
  const notes = await commitAndPush($, wf, 'checkpoint', message, files, !hold, declared, advisory)
  if (local) notes.push(`Committed ${(await head(wf.root, $)).slice(0, 8)} on this computer only: ${wf.state === 'hardening' ? 'hardening' : 'the hack'} pushes nothing, and no CI runs.`)
  if (holders.length) notes.push(`This commit is held and not pushed, because ${holders.map(o => `#${o.issue}`).join(', ')} on this PR ${holders.some(o => o.state !== 'developed') ? 'holds its commits for the review' : 'finished development and holds a commit for the review'}.`)
  addTypes(wf, declared)
  const unread = await readChangeTypes($, wf)
  if (unread) notes.push(unread)
  const sha = await head(wf.root, $)
  // Documents leave the tested code as it was, so the evidence moves with them. The commits decide
  // this, not the names in the call, and it also holds on a retry, when HEAD did not move this time.
  for (const e of [wf.evidence.review, wf.evidence.checks, wf.evidence.smoke]) if (e && e.sha !== sha && (await onlyDocsBetween($, wf, e.sha, sha))) e.sha = sha
  // A human who skipped the checks or the smoke test has decided: a commit of documents does not undo that.
  const smokeDue = (requiredSmokeTypes(wf.changeTypes ?? []).length > 0 || !!MACHINES[facts.mode].alwaysSmoke) && !wf.evidence.smoke && !wf.evidence.checks?.byHuman
  await move($, c, wf, 'checkpoint', { ...facts, prOpen, docsOnly: wf.evidence.checks?.sha === sha, smoke: smokeDue })
  await flagForHuman($, wf, notes)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// An agent that followUp started has its own worktree and record, so the session's workflow does not
// move. A worktree with no check scripts commits nothing, as in setup: only a human skips them.
// The worktrees of the agents that followUp started from this session's workflow: each commits there through checkpoint.
async function followUpAgentWorktrees($: EngineInterface): Promise<string[]> {
  const root = await read($, workflowRoot)
  if (!root) return []
  const { issues, prs } = await readHeld($, root)
  return [...issues, ...prs].flatMap(wf => (wf.followUps ?? []).flatMap(f => (f.mode === 'subagent' && f.worktree ? [f.worktree] : [])))
}

async function followUpCheckpoint($: EngineInterface, { args, project }: Ctx): Promise<string> {
  const root = text(args, 'worktree').replace(/\/$/, '')
  const known = await followUpAgentWorktrees($)
  const hotfix = (await read($, hotfixWorktrees)).find(h => h.dir === root)
  if (hotfix) throw new Refuse(`Refused: ${root} is the worktree of a hotfix, and checkpoint does not commit there. Nothing was committed. Repair: use plain git with -C and the full path: git -C ${root} commit, then git -C ${root} push origin ${hotfix.branch}.`)
  const wf = await loadWorkflow($, root, Number(args.issue))
  // Only followUp writes followUpOf, so the agent's own record proves that followUp started it, also
  // when this session no longer reads the record that holds the followUp entry (a lost hooks worker).
  if (!known.includes(root) && wf?.followUpOf === undefined) {
    const bound = (await read($, workflowRoot)) ?? project?.root
    throw new Refuse(`Refused: followUp did not start an agent in ${root}: ${root}/${interviewFileName(Number(args.issue))} ${wf ? `holds issue #${wf.issue} with no followUpOf` : `holds no workflow for issue #${String(args.issue)}`}, and the followUp entries of this session's workflow in ${bound ?? 'no worktree'} name ${known.join(', ') || 'no worktree'}. Nothing was committed. Repair: the main agent calls followUp again with the same text.`)
  }
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
const BEFORE_MERGE: State[] = ['setup', 'interviewing', 'planning', 'developing', 'hardening']
const isBeforeMerge = (o: Workflow) => BEFORE_MERGE.includes(o.state) || (['blocked', 'wait'].includes(o.state) && BEFORE_MERGE.includes(o.previous ?? 'done'))

// The record goes into review: the code review starts at once, and the stage hooks fire.
const sweepText = (deadcode: NonNullable<Workflow['deadcode']>) => (deadcode.results.length
  ? deadcode.results.map(({ language, exitCode, output }) => {
    if (exitCode === 0) return `Dead-code sweep (${language}): it found nothing new. ${output}`.trim()
    if (exitCode === 1) return `Dead-code sweep (${language}): these names need triage:\n${output}`
    return `Dead-code sweep (${language}) did not measure: it exited ${exitCode}. This is not a pass. Repair the cause and run the ndev:deadcode skill, or say why not in deadcode.\n${output}`
  }).join('\n')
  : 'Dead-code sweep: this change has no Python or TypeScript, so nothing was swept.')

// The sweep of each language that the change holds. Findings and a failed run go to the agent, and neither stops the review.
async function sweepDeadCode($: EngineInterface, wf: Workflow): Promise<string> {
  const scripts = `${$.plugin.root}/skills/deadcode/scripts`
  const ref = wf.direct ? 'HEAD~1' : `origin/${wf.base}`
  const results: NonNullable<Workflow['deadcode']>['results'] = []
  const sha = await head(wf.root, $)
  const range = wf.direct ? 'HEAD~1..HEAD' : `${ref}...HEAD`
  const listed = await git(wf.root, $, 'diff', '--name-only', '--diff-filter=d', range)
  const sweep = async (language: string, argv: string[]) => {
    const r = await run($, argv, { cwd: wf.root, timeoutMs: 300_000 })
    const { gitDir } = await paths($, wf.root)
    const log = `${gitDir}/ndev-deadcode-${language}.log`
    const all = `${r.stdout}\n${r.stderr}`.trim()
    await $.fs.write(log, all)
    results.push({ language, exitCode: r.exitCode, output: all.length > 2000 ? `${all.slice(0, 2000)}\nThe rest is in ${log}.` : all })
  }
  if (listed.exitCode !== 0) results.push({ language: 'all', exitCode: listed.exitCode || 2, output: `git diff ${range} exited ${listed.exitCode}: ${said(listed)}` })
  else {
    const names = listed.stdout.split('\n').filter(Boolean)
    if (names.some(name => name.endsWith('.py'))) {
      // Every root that holds Python goes in one run: a root left out hides callers, and live names then read as dead.
      const tracked = await git(wf.root, $, 'ls-files', '*.py')
      if (tracked.exitCode !== 0) results.push({ language: 'Python', exitCode: tracked.exitCode || 2, output: `git ls-files exited ${tracked.exitCode}: ${said(tracked)}` })
      else {
        const tops = [...new Set(tracked.stdout.split('\n').filter(Boolean).map(name => (name.includes('/') ? name.split('/')[0]! : '.')))].sort()
        await sweep('Python', ['bash', `${scripts}/sweep.sh`, '--base', ref, ...(tops.includes('.') ? ['.'] : tops)])
      }
    }
    if (names.some(name => /\.tsx?$/.test(name))) await sweep('TypeScript', ['bash', `${scripts}/sweep-ts.sh`, ref])
  }
  wf.deadcode = { sha, results }
  return sweepText(wf.deadcode)
}

async function intoReview($: EngineInterface, c: Ctx, wf: Workflow, facts: Facts, notes: string[], reviewStarted: () => void): Promise<string> {
  await move($, c, wf, 'finishedDevelopment', facts)
  await flagForHuman($, wf, notes)
  await saveWorkflow($, wf)
  const unlisted = await unlistedMigrations($, wf)
  if (unlisted.length) notes.push(migrationText(unlisted))
  const ui = await componentNote($, wf)
  if (ui) notes.push(ui)
  const before = structuredClone(wf)
  reviewStarted()
  notes.push(await startReview($, wf, facts, ui))
  const fields = (Object.keys({ ...before, ...wf }) as (keyof Workflow)[]).filter(key => key !== 'rev' && JSON.stringify(before[key]) !== JSON.stringify(wf[key]))
  const guarded = new Set<keyof Workflow>([...fields, 'hooks', 'reviewSpec', 'reviewCopy'])
  try {
    await retryWorkflowSave('finishedDevelopment', async () => {
      const latest = wf.pr ? await loadPrRecord($, wf.root, wf.pr) : await loadWorkflow($, wf.root, wf.issue)
      if (!latest || latest.state !== wf.state || latest.off) throw new Refuse(`Review started for ${labelOf(wf)} in ${wf.root}, but its current workflow changed.`)
      for (const key of guarded) {
        if (JSON.stringify(latest[key]) !== JSON.stringify(before[key]) && JSON.stringify(latest[key]) !== JSON.stringify(wf[key])) throw new Refuse(`Review field ${key} changed for ${labelOf(wf)} in ${wf.root}. Pending value: ${JSON.stringify(wf[key])}.`)
      }
      Object.assign(latest, Object.fromEntries(fields.map(key => [key, wf[key]])))
      await saveWorkflow($, latest)
      Object.assign(wf, latest)
    })
  } catch (error) {
    throw new Refuse(`${error instanceof Error ? error.message : String(error)} Review already started for ${labelOf(wf)} in ${wf.root}. Receipts: ${JSON.stringify({ review: wf.hooks?.review, specification: wf.reviewSpec, copy: wf.reviewCopy })}. Repair: call status and reconcile these receipts with the running reviewers before continuing.`)
  }
  return answer($, wf, facts, notes)
}

// Hack mode: the human agrees that the hack works, and hardening starts. Nothing is pushed.
// Model: models/workflow/issue_workflow.qnt#finishedHacking
async function finishedHacking($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  await move($, c, wf, 'finishedHacking', facts)
  const ahead = await git(wf.root, $, 'rev-list', '--count', `origin/${wf.base}..HEAD`)
  const notes = [ahead.exitCode === 0 ? `The hack holds ${ahead.stdout.trim()} commits on ${wf.branch} that are not on ${wf.base}, all on this computer.` : `git rev-list of origin/${wf.base}..HEAD exited ${ahead.exitCode}: ${said(ahead)}`]
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

// Hardening ends with the checks that a push would run, so the first push in the review finds nothing new.
async function prePushForHardening($: EngineInterface, wf: Workflow, declared: readonly ChangeType[]): Promise<string[]> {
  const note = await checked($, wf, 'pre-push-check.sh', [], declared)
  return [note ?? `pre-push-check.sh passed on ${(await head(wf.root, $)).slice(0, 8)}.`]
}

// The merge point. Each named issue finishes here. When no issue on the PR is still in development, the
// PR record takes over: from here on the PR, and not one issue, goes through review, the checks and done.
async function finishedDevelopment($: EngineInterface, c: Ctx): Promise<string> {
  const review = { started: false }
  return retryWorkflowSave('finishedDevelopment', () => finishedDevelopmentOnce($, c, review), () => !review.started)
}

// Model: models/workflow/issue_workflow.qnt#finishedDevelopment
async function finishedDevelopmentOnce($: EngineInterface, c: Ctx, review: { started: boolean }): Promise<string> {
  const { args, project } = c
  const named = args.issues as number[]
  const root = (await read($, workflowRoot)) ?? project?.root
  const active = root ? await loadWorkflow($, root) : undefined
  const lead = active && !active.pr && named.includes(active.issue) ? active.issue : named[0]!
  const wf = await current($, { ...c, args: { ...args, issue: lead } })
  const facts = await factsFor($, wf.root, project, wf)
  // A retry after a crash finds this issue finished, and goes on from there.
  if (wf.state !== 'developed') {
    legal(wf, 'finishedDevelopment', facts)
    refuseBeforeBaseCheck(wf, 'finishedDevelopment', facts.mode)
  }
  await noAgentsRunning($)
  // Before any commit, so that a wrong name leaves the commit undone.
  const bodyName = text(args, 'body_file')
  const bodyPath = bodyName.startsWith('/') ? bodyName : `${wf.root}/${bodyName}`
  if (bodyName && !(await $.fs.exists(bodyPath))) throw new Refuse(`Refused: the PR body file ${bodyPath} does not exist. Nothing was committed. Repair: write the file, or leave out body_file.`)
  const prBody = bodyName ? await $.fs.read(bodyPath) : undefined
  const declared = declaredTypes(args)
  const files = list(args, 'files')
  const unnamed = changedPaths(await porcelain($, wf.root)).filter(p => !files.some(f => p === f || p.startsWith(`${f.replace(/\/$/, '')}/`)))
  if (unnamed.length) throw new Refuse(`Refused: these changed files are not named: ${unnamed.join(', ')}. Name each one, or remove it. Nothing was committed.`)
  const message = text(args, 'message') || `Finish work on ${named.map(n => `#${n}`).join(', ')}`
  // A hack proves in hardening what test first would have proved, and the evidence goes on the PR.
  const hardening = text(args, 'hardening')
  const hardenRefusal = (who: string) => `Refused: ${who} is a hack, so finishedDevelopment needs hardening: each test that pins the change, the command and the failing line on the base, and its pass on HEAD. Nothing was committed. Repair: follow "Harden" in the ndev:work-hack skill, then call finishedDevelopment again with hardening.`
  if (wf.state !== 'developed' && MACHINES[facts.mode].hardens && !hardening) throw new Refuse(hardenRefusal(labelOf(wf)))

  if (wf.direct) {
    if (named.length > 1) throw new Refuse(`Refused: a project that commits directly to the base branch has one issue at a time, and this call names ${named.map(n => `#${n}`).join(', ')}. Nothing was committed.`)
    const notes = await commitAndPush($, wf, 'finishedDevelopment', message, files, false, declared)
    if (hardening) notes.push(...(await prePushForHardening($, wf, declared)), `Hardening: ${hardening}`)
    if (prBody !== undefined) notes.push(`This project commits directly to the base branch, so it has no PR and ${bodyPath} was not used.`)
    addTypes(wf, declared)
    return intoReview($, c, wf, facts, notes, () => { review.started = true })
  }

  for (const n of list(args, 'prs').map(Number)) {
    const pr = await readPr($, wf.root, wf.repo, n)
    if (pr.head.ref !== wf.branch) throw new Refuse(`Refused: PR #${n} is on ${pr.head.ref}, and this workflow is on ${wf.branch}.`)
    if (!wf.prs.includes(n)) wf.prs.push(n)
  }
  havePr(wf, true)
  let n = wf.prs[0]!
  const session = await $.session.id()
  const now = await $.clock.now()
  const held = await readHeld($, wf.root)
  const listed = named.map(i => (i === wf.issue ? wf : held.issues.find(o => o.issue === i)))
  const modes: Mode[] = []
  for (const o of listed) modes.push(o ? (await factsFor($, wf.root, project, o)).mode : facts.mode)
  const problems = named.flatMap((i, at) => {
    const o = listed[at]
    const mode = modes[at]!
    if (!o) return [`#${i} has no workflow in ${wf.root}. Repair: call started with issue ${i}.`]
    if (o.prs[0] !== n) return [`#${i} is not on PR #${n}${o.prs[0] ? `: it is on PR #${o.prs[0]}` : ''}.`]
    if (o.state !== 'developing' && o.state !== 'hardening' && o.state !== 'developed') return [`#${i} is in the state "${o.state}".`]
    if (o.state !== 'developed' && 'refused' in afterTool({ state: o.state }, 'finishedDevelopment', { ...facts, mode })) return [`#${i} is still in the hack. Repair: call finishedHacking with issue ${i}, and harden it.`]
    if (o.state === 'developing' && !isBaseChecked(o, mode)) return [`#${i} has no base check. Repair: call finishedInterview with issue ${i}.`]
    if (o.state !== 'developed' && MACHINES[mode].hardens && !hardening) return [hardenRefusal(`#${i}`).replace('Refused: ', '').replace(' Nothing was committed.', '')]
    if (o.owner && o.owner.session !== session && now - o.owner.at < OWNER_LIVE_MS) return [`The session ${o.owner.session} owns #${i}. Leave it to that session.`]
    return []
  })
  if (problems.length) throw new Refuse(`Refused: finishedDevelopment cannot take these issues. Nothing was committed.\n- ${problems.join('\n- ')}`)
  const finishing = listed as Workflow[]

  const notes = finishing.every(o => o.state === 'developed') && !files.length ? [] : await commitAndPush($, wf, 'finishedDevelopment', message, files, false, declared)
  if (!n) {
    if (prBody !== undefined) await editBody($, wf, old => withBodySection(old, wf.issue, prBody))
    const opened = await openPendingPr($, wf)
    if (opened) notes.push(opened)
    n = wf.prs[0]!
    for (const o of finishing) o.prs = [n]
  }
  const hardened = finishing.filter((o, at) => o.state !== 'developed' && MACHINES[modes[at]!].hardens)
  if (hardened.length) {
    notes.push(...(await prePushForHardening($, wf, declared)))
    await comment($, wf.root, wf.repo, n, `${MARKER}\n**Hardening** of ${hardened.map(o => `#${o.issue}`).join(', ')} at ${await head(wf.root, $)}\n\n${hardening}`)
    notes.push(`The hardening evidence is on PR #${n}.`)
  }
  if (prBody !== undefined) await editBody($, wf, old => withBodySection(old, wf.issue, prBody))
  const traced = await planTraceProblems($, wf, (await readPr($, wf.root, wf.repo, n)).body ?? '')
  if (traced.length) {
    await saveWorkflow($, wf)
    throw new Refuse(`Refused: a record that PR #${n} fulfils does not link it:\n- ${traced.join('\n- ')}\nThe commit is held here and not pushed. Call finishedDevelopment again with the record in files.`)
  }
  addTypes(wf, declared)
  for (const o of finishing.filter(x => x.state !== 'developed')) {
    if (MACHINES[(await factsFor($, wf.root, project, o)).mode].gates) {
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
  const settings = await settingsOfAll($, wf.root, project, [...(prior ? [prior] : []), ...all])
  const changeTypes = union(o => o.changeTypes)
  const webFiles = union(o => o.webFiles)
  const record: Workflow = {
    ...(prior ?? { ...wf, rev: undefined, op: undefined, previous: undefined, waiting: undefined, blocked: undefined }),
    ...settings,
    pr: n,
    prs: [n],
    issue: issues[0]!,
    issues,
    // The PR record enters the review by its mode's last step before it: a hack PR by hardening.
    state: MACHINES[(await factsFor($, wf.root, project, settings)).mode].reopen,
    previous: undefined,
    owner: { session, at: now },
    evidence: {},
    hooks: undefined,
    reviewSpec: undefined,
    reviewCopy: undefined,
    doneMessage: undefined,
    followUps: union(o => o.followUps, f => f.hash),
    migrations: union(o => o.migrations, m => m.path),
    changeTypes: changeTypes.length ? changeTypes : undefined,
    webFiles: webFiles.length ? webFiles : undefined,
    typesUnread: all.find(o => o.typesUnread)?.typesUnread,
  }
  notes.push(`From here on PR #${n} goes through the review, the checks and done: give pr ${n} to each tool. It carries ${issues.map(i => `#${i}`).join(', ')}.`)
  return intoReview($, c, record, await factsFor($, wf.root, project, record), notes, () => { review.started = true })
}

// An issue joins a PR, which goes back to its developers, because what was reviewed and tested is no
// longer the whole change. Issues can join until the PR merges.
async function backToDevelopers($: EngineInterface, project: LoadedConfig | undefined, carrier: Workflow, issue: number, tool: string): Promise<string> {
  carrier.issues = [...new Set([...issuesOf(carrier), issue])].sort((a, b) => a - b)
  carrier.issue = carrier.issues[0]!
  // A hack PR goes back to hardening: the new work must be pinned like the rest before it is pushed.
  const reopen = reopenState(await factsFor($, carrier.root, project, carrier))
  const wasBack = carrier.state === reopen
  if (carrier.state === 'blocked' || carrier.state === 'wait') carrier.previous = reopen
  else if (!wasBack) moved(carrier, tool, { state: reopen }, await $.clock.now())
  carrier.evidence = {}
  carrier.hooks = carrier.hooks ? { ...carrier.hooks, review: undefined } : undefined
  carrier.reviewSpec = undefined
  carrier.reviewCopy = undefined
  carrier.doneMessage = undefined
  await saveWorkflow($, carrier)
  return `PR #${carrier.pr} now carries #${issue} too${wasBack ? '' : ', and it goes back to its developers: its review and check results no longer count'}. When the work is complete, call finishedDevelopment with the issues.`
}

export async function startReview($: EngineInterface, wf: Workflow, facts: Facts, ui?: string): Promise<string> {
  // The sweep comes first. It can take minutes, and a reviewer that ends must find its id in the record on disk.
  const sweep = await sweepDeadCode($, wf)
  const code = await startCodeReview($, wf, facts, ui)
  const copy = await startCopyEdit($, wf)
  return `${copy ? `${code} ${copy}` : code}\n${sweep}`
}

// The copy editor reads the prose for users in this change. Its failure to start does not stop the code review, and it is told.
async function startCopyEdit($: EngineInterface, wf: Workflow): Promise<string> {
  wf.reviewCopy = undefined
  const range = wf.direct ? 'HEAD~1..HEAD' : `origin/${wf.base}...HEAD`
  const listed = await git(wf.root, $, 'diff', '--name-only', '--diff-filter=d', range)
  if (listed.exitCode !== 0) wf.reviewCopy = { failed: `git diff ${range} exited ${listed.exitCode}` }
  if (listed.exitCode !== 0) return `The copy editor did not start, because the changed files were not listed: git diff ${range} exited ${listed.exitCode}: ${said(listed)}. Start the ndev:copy-editor agent yourself on the changed docs pages.`
  const files = listed.stdout.split('\n').filter(isUserProsePath)
  if (!files.length) return ''
  const hand = `Start it yourself: the ndev:copy-editor agent, on ${files.join(', ')} in ${wf.root}.`
  try {
    const editor = await $.agent.spawn({
      subagentType: 'ndev:copy-editor', description: `Copy edit ${wf.pr ? `PR #${wf.pr}` : `#${wf.issue}`}`, cwd: wf.root,
      prompt: `Edit the copy of these files, which readers of the project read:\n${files.join('\n')}\n\nThe project root is ${wf.root}. The plugin root is ${$.plugin.root}. Run ${$.plugin.root}/scripts/docs/readability.sh on each file, as your instructions say, and read each whole file. Put the findings in the lines that \`git diff ${range}\` changes first, and start the Fault line of any other finding with "Already there:". Judge the language only: the code review checks the rest.`,
    })
    if ('deny' in editor && editor.deny) {
      wf.reviewCopy = { failed: String(editor.deny) }
      return `The copy editor did not start: ${String(editor.deny)}. ${hand}`
    }
    wf.reviewCopy = { agentId: editor.agentId }
    return `The plugin started the copy editor on ${files.length} ${files.length === 1 ? 'page' : 'pages'}. Do not start another. Its answer comes to you when it ends.`
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    wf.reviewCopy = { failed: why }
    return `The copy editor did not start: ${why}. ${hand}`
  }
}

async function startCodeReview($: EngineInterface, wf: Workflow, facts: Facts, ui?: string): Promise<string> {
  const hand = `Start it yourself: the ndev:diff-reviewer agent, on origin/${wf.base}...HEAD in ${wf.root}.`
  const unread = await readChangeTypes($, wf)
  const after = unread ? ` ${unread}` : ''
  const prompt = [
    issuesOf(wf).length > 1
      ? `Review the diff origin/${wf.base}...HEAD in ${wf.root}. It is the work on the issues ${issuesOf(wf).map(n => `#${n}`).join(', ')} of ${wf.repo}, on one PR. Read each issue with ndev github issue-read and its number. The base branch is ${wf.base}: do not look it up.`
      : `Review the diff origin/${wf.base}...HEAD in ${wf.root}. It is the work on issue #${wf.issue} of ${wf.repo}. Read the issue with ndev github issue-read ${wf.issue}. The base branch is ${wf.base}: do not look it up.`,
    MACHINES[facts.mode].reviewBrief ?? '',
    ui ?? '',
    ...reviewerBrief(reviewTypes(wf)),
    'Report only. Do not edit, commit or push. Give each finding with its file and line, Critical and Important first.',
  ].filter(Boolean).join('\n')
  // A heavy change gets two reviewers, because one who holds both questions lets each hide the other (work-heavy F3c).
  const twoAxes = MACHINES[facts.mode].twoAxisReview && !isDocsOnly(reviewTypes(wf))
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
const AXIS_SPECIFICATION = 'Review axis: specification. Does this diff do what the issue, the plan in the PR body and the interview answers (the keys rounds and draft of the .neil-dev.issue-*.json files at the worktree root) ask, and all of it? Name each requirement that is missing, partial or wrong, and each change that nothing asked for. When the plan has a "Requirements:" line, read each record that it names in docs/formal/requirements and check that the diff meets its Statement. When the plan has a "Model:" line, check that the PR body proves each new invariant with a mutant and each witness with a run that reaches it. Do not judge the code style: another reviewer does that.'

export async function recordOfReviewer($: EngineInterface, root: string, agentId: string): Promise<Workflow | undefined> {
  const { issues, prs } = await readHeld($, root)
  return [...prs, ...issues].find(o => o.hooks?.review?.agentId === agentId || o.reviewSpec?.agentId === agentId || o.reviewCopy?.agentId === agentId)
}

const COPY_ANSWER_STEP = `Judge each finding, and keep the facts. Fix the ones that you accept with checkpoint, which holds those commits. A finding marked "Already there" is outside this change: fix it only if it is small, and otherwise tell the human. A "VALE: not run" line is not a pass: run the check again, or tell the human why it did not run. Put what you did in the review field of finishedReview.`

// Keeps the answer on the fresh record. The turn of a tool can be saving it at this moment, so this
// takes its place in the queue and tries again after a stale write. The answer of the result is 'kept',
// 'already' for a reviewer that has answered, or why the write failed.
async function keepAnswer($: EngineInterface, root: string, agentId: string, reply: string): Promise<string> {
  const answer = reply.slice(0, 20_000)
  for (let tries = 1; ; tries += 1) {
    await whenTurnsFree($)
    try {
      return await inTurn(async () => {
        const wf = await recordOfReviewer($, root, agentId)
        if (!wf) return 'already'
        const copy = wf.reviewCopy
        const spec = wf.reviewSpec
        const review = wf.hooks?.review
        if (copy?.agentId === agentId && copy.answer === undefined) wf.reviewCopy = { ...copy, answer }
        else if (spec?.agentId === agentId && spec.answer === undefined) wf.reviewSpec = { ...spec, answer }
        else if (review?.agentId === agentId && review.answer === undefined) wf.hooks = { ...wf.hooks, review: { ...review, answer } }
        else return 'already'
        await saveWorkflow($, wf)
        return 'kept'
      })
    } catch (error) {
      if (tries >= 3 || !isStaleWrite(error)) return error instanceof Error ? error.message : String(error)
    }
  }
}

// What each code reviewer is called, and what its report is for. Two reviewers on one PR must not read as one report sent twice.
const STANDARDS_REPORT = { name: 'standards review', purpose: 'It checks the diff against the rules that the repository wrote down, and not whether the change meets the issue.', question: AXIS_STANDARDS, other: 'specification review' }
const SPECIFICATION_REPORT = { name: 'specification review', purpose: 'It checks whether the diff does all that the issue, the plan and the interview answers ask, and nothing more. It does not judge the code style.', question: AXIS_SPECIFICATION, other: 'standards review' }
const ONE_REPORT = { name: 'code review', purpose: 'It checks the diff for correctness and security, against the written rules of the repository and the issue.', question: '', other: '' }
const reportOf = (wf: Workflow, agentId: string) => (!wf.reviewSpec ? ONE_REPORT : wf.reviewSpec.agentId === agentId ? SPECIFICATION_REPORT : STANDARDS_REPORT)

// The reviewer has ended: keep its answer in the record, and give it to the main agent.
// The main agent gets the answer even when the record does not. An empty ending or an error is not an answer.
export async function reviewerAnswered($: EngineInterface, wf: Workflow, agentId: string, reply: string, reason?: string): Promise<void> {
  const isCopy = wf.reviewCopy?.agentId === agentId
  const report = reportOf(wf, agentId)
  const who = isCopy ? 'copy editor' : report.name
  const send = (text: string) => {
    void $.prompt.submit({ text }).catch((error: unknown) => {
      $.ui.toast(`workflow: the answer of the ${who} for ${labelOf(wf)} was not sent to the model: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const isError = reason === 'error' || reason === 'aborted'
  if (isError || reply.trim() === '') {
    const ending = isError ? `its turn ended with the reason "${reason}"` : 'it gave no answer'
    send(`The ${who} of ${labelOf(wf)} failed: ${ending}.${reply.trim() === '' ? '' : ` Its last text:\n\n${reply}\n\n`} Repair: start the ${isCopy ? 'ndev:copy-editor' : 'ndev:diff-reviewer'} agent yourself in ${wf.root}${!isCopy && report.question ? `, with this question: ${report.question}` : ''}, or call started to restart it.`)
    return
  }
  const kept = await keepAnswer($, wf.root, agentId, reply)
  if (kept === 'already') return
  const lost = kept === 'kept' ? '' : `\n\nThis answer was not saved, so a resume does not know it: ${kept}.`
  if (isCopy) send(`The copy edit of ${labelOf(wf)} has ended. It checks only the language of the prose that readers see.\n\n${reply}${lost}\n\n${COPY_ANSWER_STEP}`)
  else send(`The ${report.name} of ${labelOf(wf)} has ended. ${report.purpose}${report.other ? ` The ${report.other} gives its own report.` : ''}\n\n${reply}${lost}\n\nFix what it found with checkpoint, which holds those commits. Then call finishedReview with the result${report.other ? ', when both reports have come' : ''}.`)
}

// A resume in the review stage. Each reviewer is known, still runs, or a restart lost it, and only a lost one starts again.
async function resumeReview($: EngineInterface, wf: Workflow, facts: Facts): Promise<string> {
  const busy = new Set((await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(a.status)).map(a => a.id))
  const isLost = (p: { agentId?: string; answer?: string } | undefined) => p?.answer === undefined && !(p?.agentId && busy.has(p.agentId))
  const code = [wf.hooks?.review, ...(wf.reviewSpec ? [wf.reviewSpec] : [])]
  const codeLost = code.some(isLost)
  const copyLost = wf.reviewCopy !== undefined && isLost(wf.reviewCopy)
  const kept = [...(codeLost ? [] : code.map(p => [reportOf(wf, p?.agentId ?? '').name, p] as const)), ...(wf.reviewCopy && !copyLost ? [['copy edit', wf.reviewCopy] as const] : [])]
  const lines = kept.map(([name, p]) => (p?.answer !== undefined ? `The ${name} answered:\n${p.answer}` : `The ${name} still runs: agent ${p?.agentId}.`))
  // The answers come first, so the note of a start is the last thing the agent reads.
  lines.sort((a, b) => Number(a.includes('still runs')) - Number(b.includes('still runs')))
  // Before a new start, as in startReview.
  const swept = wf.deadcode ? sweepText(wf.deadcode) : await sweepDeadCode($, wf)
  if (codeLost) lines.push(await startCodeReview($, wf, facts, await componentNote($, wf)))
  if (copyLost) {
    const started = await startCopyEdit($, wf)
    if (started) lines.push(started)
  }
  lines.push(swept)
  return lines.join('\n')
}

// Model: models/workflow/issue_workflow.qnt#finishedReview
async function finishedReview($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedReview', facts)
  await openPendingPr($, wf)
  havePr(wf)
  await noAgentsRunning($)
  const pr = wf.prs[0] ? await readPr($, wf.root, wf.repo, wf.prs[0]) : undefined
  if (pr?.merged) throw new Refuse(mergedRefusal(pr, 'finishedReview', await head(wf.root, $)))
  if (pr && pr.state !== 'open') throw new Refuse(`Refused: PR #${pr.number} is closed with no merge, so a push to ${wf.branch} reaches no open PR. Nothing was pushed. Repair: gh pr reopen ${pr.number} --repo ${wf.repo}, then call finishedReview again. If the PR was closed on purpose, ask the human.`)
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
  // Model: models/workflow/issue_workflow.qnt#humanConvertsToDraft
  if (pr?.draft) await markReady($, wf.root, wf.repo, pr.number)
  const swept = wf.deadcode ? `\nplugin sweep: ${sweepText(wf.deadcode).slice(0, 500)}` : ''
  wf.evidence.review = { sha: await head(wf.root, $), text: `${fields.map(([k, v]) => `${k}: ${v}`).join('\n').slice(0, 2000)}${swept}` }
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

// retry is true when the board could not answer. A card that does not exist needs a human, so a retry does not help.
async function moveCards($: EngineInterface, wf: Workflow, status: string, cwd: string): Promise<{ problems: string[]; retry: boolean }> {
  const board = `${$.plugin.root}/scripts/board/board.sh`
  const items = await run($, ['bash', board, 'items'], { cwd, env: { GH_REPO: wf.repo } })
  if (items.exitCode !== 0) return { problems: [`board.sh items exited ${items.exitCode}: ${said(items)}`], retry: true }
  let cards: { number: number; itemId: string }[]
  try {
    cards = items.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as { number: number; itemId: string })
  } catch (error) {
    return { problems: [`board.sh items printed a line that is not JSON: ${String(error).slice(0, 200)}`], retry: true }
  }
  const problems: string[] = []
  let retry = false
  for (const issue of issuesOf(wf)) {
    const card = cards.find(i => i.number === issue)
    if (!card) {
      problems.push(`Issue #${issue} has no card on the board. Repair: run ndev github board add ${issue}.`)
      continue
    }
    const moved = await run($, ['bash', board, 'move', card.itemId, status], { cwd, env: { GH_REPO: wf.repo } })
    if (moved.exitCode !== 0) {
      problems.push(`board.sh move ${card.itemId} ${status} exited ${moved.exitCode} for #${issue}: ${said(moved)}`)
      retry = true
    }
  }
  return { problems, retry }
}

// Model: models/workflow/issue_workflow.qnt#finishedChecks
async function finishedChecks($: EngineInterface, c: Ctx): Promise<string> {
  const { project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  legal(wf, 'finishedChecks', { ...facts })
  const sha = await head(wf.root, $)
  if (wf.prs[0]) {
    const pr = await readPr($, wf.root, wf.repo, wf.prs[0])
    if (pr.merged) throw new Refuse(mergedRefusal(pr, 'finishedChecks', sha))
    if (pr.head.sha !== sha) throw new Refuse(`Refused: PR #${pr.number} is at ${pr.head.sha.slice(0, 8)}, and HEAD is ${sha.slice(0, 8)}. Push it: call checkpoint with no files, which pushes a held commit.`)
  }
  // Model: models/workflow/issue_workflow.qnt#ciEnds
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

// Model: models/workflow/issue_workflow.qnt#finishedSmoke
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
  if (skipped && MACHINES[facts.mode].alwaysSmoke) throw new Refuse(`Refused: ${labelOf(wf)} is a hack, and hack mode requires a smoke test of each change, so finishedSmoke does not take skipped ("${skipped}"). Repair: smoke test HEAD (${sha.slice(0, 7)}) and give the report. Only a human can skip it, with /flow skip <reason>.`)
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

// Model: models/workflow/issue_workflow.qnt#finishedRevision
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

// Model: models/workflow/issue_workflow.qnt#agentHolds
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

// Model: models/workflow/issue_workflow.qnt#humanUnblock
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
  const noChange = BEFORE_REVIEW.includes(wf.state)
  const mergedEarly = noChange ? undefined : await mergedBeforeDone($, wf)
  if (!noChange) legal(wf, 'done', { ...facts, prMerged: !!mergedEarly })
  await noAgentsRunning($)
  const message = text(args, 'message')
  if (!message) throw new Refuse('Refused: done needs a message that says what was finished.')
  const remembered = text(args, 'remembered') || wf.hooks?.remember?.result || ''
  if (!remembered) throw new Refuse('Refused: the remember hook has no result. Update the docs and the wiki, then call done with remembered: what you recorded, or "nothing: <reason>".')
  if (!maySkipReview(facts.level) && /^skipped\b/i.test(remembered)) throw new Refuse('Refused: a formal_project does not skip the remember hook. Do the step and call done again.')
  // Model: models/workflow/issue_workflow.qnt#doneNoChange
  if (noChange) {
    const { problems, merged } = await noChangeProblems($, wf)
    if (problems.length) throw new Refuse(`Not done: in the state "${wf.state}", done only ends an issue that was closed with no change, such as one that another change fixed, or one whose PR has merged. Nothing changed. Fix each of these and call done again, or go on with finishedDevelopment:\n- ${problems.join('\n- ')}`)
    wf.doneMessage = message
    wf.hooks = { ...wf.hooks, remember: { firedAt: wf.hooks?.remember?.firedAt ?? (await $.clock.now()), result: remembered.slice(0, 2000) } }
    // The PR is closed, so the watchdog has nothing to watch.
    if (wf.prs.length) wf.prsClosed = true
    if (!merged) wf.closedNoChange = true
    // A PR merged outside the workflow, such as by gh pr merge, ends the work as a merge by done would.
    const ended = merged ? await afterHumanMerge($, wf, merged, await head(wf.root, $)) : [`Issue ${issuesOf(wf).map(n => `#${n}`).join(', ')} was closed with no change, so the workflow ended with no review and no merge.`]
    const left: string[] = []
    if (wf.state === 'interviewing') {
      await closeInterviewFile($, wf, await readInterview($, wf.root, wf.issue), 'call done again')
      left.push(...(await endAsking($, wf)))
    }
    await move($, c, wf, 'done', { ...facts, noChange: true })
    await saveWorkflow($, wf)
    return answer($, wf, facts, [...ended, ...left, ...(await stopResources($, wf, project))])
  }
  const sha = await head(wf.root, $)
  await openPendingPr($, wf)
  havePr(wf)
  const pr = mergedEarly ?? (!wf.direct && wf.prs[0] ? await readPr($, wf.root, wf.repo, wf.prs[0]) : undefined)
  const { problems, feedback } = pr?.merged ? { problems: [], feedback: [] } : await doneProblems($, wf, sha, pr)
  // Model: models/workflow/issue_workflow.qnt#doneWithFeedback
  if (feedback.length) {
    await move($, c, wf, 'done', { ...facts, feedback: true })
    await saveWorkflow($, wf)
    return answer($, wf, facts, [`Not done: this feedback has no answer:\n${feedback.join('\n')}\nThe workflow cannot tell your own unmarked note from a request by the human, because both use one GitHub login. If a comment asks for no change, call comment on the PR with the message "ack:<its id>", then finishedRevision.`, ...problems.map(p => `Also: ${p}`)])
  }
  if (wf.doneWaitsFor === sha) await saveWorkflow($, wf)
  if (problems.length) throw new Refuse(`Not done. Fix each of these, then call done again:\n- ${problems.join('\n- ')}`)

  const notes: string[] = []
  const n = wf.prs[0]
  let merged = false
  // Model: models/workflow/issue_workflow.qnt#doneAfterHumanMerge
  if (pr?.merged) notes.push(...(await afterHumanMerge($, wf, pr, sha)))
  // Model: models/workflow/issue_workflow.qnt#doneReady
  else if (n && !wf.direct) {
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
  if (followUps.length) notes.push(`Follow-ups elsewhere: ${followUps.map(f => `${(f.issues ?? [f.issue]).map(i => `#${i}`).join(', ')} (${f.mode})`).join(', ')}.`)
  wf.doneMessage = message
  wf.hooks = { ...wf.hooks, remember: { firedAt: wf.hooks?.remember?.firedAt ?? (await $.clock.now()), result: remembered.slice(0, 2000) } }
  await move($, c, wf, 'done', { ...facts, prMerged: !!mergedEarly })
  await saveWorkflow($, wf)
  if (wf.state === 'done') notes.push(...(await stopResources($, wf, project)))
  return answer($, wf, facts, notes)
}

// Each reason that done cannot end an issue before its review: the issue must be closed, the branch must hold
// no change from its base, and no PR may stay open. All of them are named, so that one pass fixes them.
// A merged PR carried the branch's change already: a squash merge leaves the branch different from its base.
// Model: models/workflow/issue_workflow.qnt#humanMergesPr
// Model: models/workflow/issue_workflow.qnt#humanClosesIssue
async function noChangeProblems($: EngineInterface, wf: Workflow): Promise<{ problems: string[]; merged?: Pr }> {
  const problems: string[] = []
  const n = wf.direct ? undefined : wf.prs[0]
  const pr = n === undefined ? undefined : await readPr($, wf.root, wf.repo, n)
  const merged = pr?.merged ? pr : undefined
  for (const issue of issuesOf(wf)) {
    const { state } = await ghOne<{ state: string }>($, wf.root, wf.repo, ['issue-read', String(issue)])
    if (state !== 'closed') problems.push(`issue #${issue} is ${state}. If it needs no change, close it on GitHub with the reason. If it needs one, make it and call finishedDevelopment.`)
  }
  if (!merged) {
    const range = `origin/${wf.base}...HEAD`
    const diff = await git(wf.root, $, 'diff', '--name-only', range)
    if (diff.exitCode !== 0) throw new Error(`git diff --name-only ${range} exited ${diff.exitCode} in ${wf.root}: ${said(diff)}`)
    const changed = diff.stdout.split('\n').filter(Boolean)
    if (changed.length) problems.push(`the branch ${wf.branch} changes ${changed.join(', ')} from origin/${wf.base}, and ${n === undefined ? 'it has no PR' : `PR #${n} is ${pr!.state} with no merge`}. A change goes through the review: call finishedDevelopment.`)
  }
  const dirty = await porcelain($, wf.root)
  if (dirty.length) problems.push(`the tree is not clean: ${changedPaths(dirty).join(', ')}. ${merged ? `That work is not in the merged PR #${n}: commit it on a new issue, or remove it.` : 'Commit the work with finishedDevelopment, or remove it.'}`)
  if (pr?.state === 'open') problems.push(`PR #${n} is open. Repair: gh pr close ${n} --repo ${wf.repo} --comment "<why no change is needed>".`)
  return { problems, merged }
}

// The local stacks and dev servers of a finished worktree. Orca removes the worktree itself, so this does not.
// Another unfinished issue in the worktree may still need them.
async function stopResources($: EngineInterface, wf: Workflow, project: LoadedConfig | undefined): Promise<string[]> {
  if ((await readEffective($, wf.root)).some(o => o.state !== 'done' && !o.off)) return []
  // A file with an error reads as empty, and the default policy deletes data, as in worktree-stacks.ts.
  if (project?.error) return [`The stacks and dev servers of ${wf.root} did not stop: ${project.path} has an error (${project.error}). Repair: fix the file, then run bash ${envScript($)} stop-all --worktree ${wf.root} --on-end <its worktreeStacks.onSessionEnd>.`]
  const policy = project?.config.worktreeStacks?.onSessionEnd ?? 'stop-and-delete'
  const r = await run($, ['bash', envScript($), 'stop-all', '--background', '--on-end', policy, '--worktree', wf.root], { cwd: wf.root, timeoutMs: 60_000 })
  return r.exitCode === 0 ? [] : [`The stacks and dev servers of ${wf.root} did not stop: worktree-env.sh stop-all exited ${r.exitCode}: ${said(r)}. Repair: bash ${envScript($)} stop-all --worktree ${wf.root} --on-end ${policy}.`]
}

const SHORT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function refuseShortName(shortName: string, issue?: number): void {
  if (!SHORT_NAME.test(shortName) || shortName.length > 40 || (issue && shortName.startsWith(`${issue}-`))) {
    throw new Refuse(`Refused: shortName must be two to five lower-case words joined by hyphens, at most 40 characters, with no issue number, such as "fix-login-redirect". It is ${JSON.stringify(shortName)}.`)
  }
}

const hashOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7).toString(16)

// A human steers each step of a hack, so hack mode is interactive only.
const HACK_AUTO = (who: string, issue?: number) => `Refused: hack mode is interactive only, because a human steers each step of the hack, and the steering of ${who} is auto. Nothing changed. Repair: the human sets the steering to interactive (/flow steering interactive${issue ? ` ${issue}` : ''} for one issue, or /dev steering interactive), or start in light or heavy mode.`

// A new issue, and its workflow. Once the issue exists, each failure names it, so that a retry does not file it twice.
async function create($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const shortName = text(args, 'shortName')
  if (args.mode !== undefined && args.mode !== 'light' && args.mode !== 'heavy' && args.mode !== 'hack') throw new Refuse(`Refused: mode is ${JSON.stringify(args.mode)}. Use "light", "heavy" or "hack".`)
  const [title, ...rest] = text(args, 'description').split('\n')
  if (!shortName) throw new Refuse('Refused: create needs a shortName. Nothing was filed.')
  refuseShortName(shortName)
  if (!title) throw new Refuse('Refused: create needs a description: its first line is the issue title. Nothing was filed.')
  if (!project) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  if (project.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  const root = (await read($, workflowRoot)) ?? project.root
  const active = await loadWorkflow($, root)
  if (active?.off) throw new Refuse(OFF_HERE(active))
  if (args.mode === 'hack' && (await factsFor($, root, project, { mode: 'hack' })).steering === 'auto') throw new Refuse(`${HACK_AUTO('this worktree')} Nothing was filed.`)
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

const hotfixSteps = (root: string, n: number, base: string, pr: string) => [
  'How to do this hotfix:',
  `1. Work only in ${root}. Do not touch this session's own issue: its record stays as it is.`,
  '2. Make the smallest change that stops the harm. Add a regression test if you can do it now. If you cannot, say why in the PR.',
  `3. Run ${CHECK_DIR}/pre-commit-check.sh and pre-push-check.sh if the project has them. The workflow tools do not run here and they refuse here, so no other step runs them.`,
  `4. Stage each file by name, and commit and push with plain git, with -C and the full path: git -C ${root} commit, then git -C ${root} push. Never use --no-verify, and never force-push.`,
  `5. Put the problem, the fix and the evidence in the body of ${pr}. Then mark it ready: ndev github pr-ready ${n}.`,
  `6. Wait for its checks once: ndev wait checks ${n}. Read the conclusions for your commit. Then tell the human that it is ready: a human merges it into ${base}.`,
  '7. File the root cause and each thing that you left out with the create tool, so that it gets the full workflow.',
].join('\n')

// An urgent fix: its own issue, worktree, branch and PR, with the workflow off there. It never joins the
// session's issue, and the session stays on that issue. Once the issue exists, a failure names it.
async function hotfix($: EngineInterface, { args, project }: Ctx): Promise<string> {
  const shortName = text(args, 'shortName')
  if (!shortName) throw new Refuse('Refused: hotfix needs a shortName. Nothing was filed.')
  refuseShortName(shortName)
  if (!project) throw new Refuse('Refused: the project settings were not read. Start a new session in the project.')
  if (project.config.workflow === false) throw new Refuse(OFF_PROJECT(project.path))
  const [first, ...rest] = text(args, 'description').split('\n')
  const title = first || `Hotfix: ${shortName.replace(/-/g, ' ')}`
  const here = (await read($, workflowRoot)) ?? project.root
  const repo = project.config.github?.repo ?? (await repoFromOrigin($, project.root))
  const { main, gitDir } = await paths($, here)
  const base = await defaultBranch($, here, repo)
  const retried = args.issue === undefined ? undefined : Number(args.issue)
  if (retried !== undefined && (!Number.isInteger(retried) || retried <= 0)) throw new Refuse(`Refused: issue must be the number of the hotfix issue that an earlier call filed. It got ${JSON.stringify(args.issue)}. Nothing was filed.`)
  if (retried !== undefined) {
    const { state } = await ghOne<{ state: string }>($, here, repo, ['issue-read', String(retried)])
    if (state?.toUpperCase() !== 'OPEN') throw new Refuse(`Refused: issue #${retried} is ${state}, so a hotfix cannot use it. Nothing changed. Repair: call hotfix without issue to file a new one.`)
  }
  let issue = retried
  if (!issue) {
    const bodyFile = `${gitDir}/ndev-new-issue.md`
    await $.fs.write(bodyFile, `${rest.join('\n').trim() || title}\n`)
    const made = await gh($, here, repo, ['issue-new', '--title', title, '--body-file', bodyFile])
    issue = Number(/(?:\/issues\/|"number":\s*)(\d+)/.exec(made)?.[1])
    if (!issue) throw new Error(`gh.sh issue-new printed no issue number: ${made.slice(0, 200)}`)
  }
  const link = `Issue #${issue}: https://github.com/${repo}/issues/${issue}`
  if (mayCommitToBase(project.config.projectLevel as ProjectLevel | undefined)) {
    return `${link}\nThis straw_man project commits directly to the base branch, so this hotfix has no worktree and no PR. Make the smallest fix in ${main} on ${base}. If this session is on an issue here, commit the named files with mcp__ndev__checkpoint and name issue #${issue} in the message: the git guard stays on, because the fix and the session's work share this checkout. With no workflow in this session, use plain git. Never use --no-verify, and never force-push.`
  }
  try {
    await must($, ['git', 'fetch', 'origin', base], { cwd: main, timeoutMs: 120_000 })
    const script = `${$.plugin.root}/scripts/work/worktree_claim.sh`
    const claimed = await run($, ['bash', script, main, String(issue), `origin/${base}`], { cwd: main, timeoutMs: 120_000 })
    if (claimed.exitCode !== 0) throw new Error(`worktree_claim.sh exited ${claimed.exitCode}: ${said(claimed)}`)
    const root = claimed.stdout.trim().split('\n').pop()!
    const note = await initSubmodules($, project, main, root)
    const at = await $.clock.now()
    const branch = await gitOut(root, $, 'rev-parse', '--abbrev-ref', 'HEAD')
    const record: Workflow = (await loadWorkflow($, root, issue)) ?? { issue, root, repo, base, branch, prs: [], shortName, mode: 'light', state: 'developing', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], hotfix: true, off: { at, reason: `hotfix: ${title}` } }
    await saveWorkflow($, record)
    await update($, hotfixWorktrees, known => (known.some(h => h.dir === root) ? known : [...known, { dir: root, branch }]))
    await setUpPr($, record, title)
    await saveWorkflow($, record)
    if (record.prs[0]) await update($, hotfixPrs, known => (known.includes(record.prs[0]!) ? known : [...known, record.prs[0]!]))
    const pr = `https://github.com/${repo}/pull/${record.prs[0]}`
    return [link, `Worktree: ${root}, on the branch ${branch}.`, `Draft PR: ${pr}`, ...(note ? [note] : []), hotfixSteps(root, record.prs[0]!, base, pr)].join('\n')
  } catch (error) {
    throw new Refuse(`${link} is filed, and the hotfix set-up failed: ${error instanceof Error ? error.message : String(error)}\nRepair: fix the cause, then call hotfix again with issue: ${issue}, which files nothing new. A call without issue files a second one.`)
  }
}

// On an issue or a PR, with or without a workflow. The mark keeps it out of the feedback that done reads.
// Model: models/workflow/issue_workflow.qnt#answerFeedback
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

// The existing issues of a worktree follow-up, lowest first. The lowest one names the workspace.
function namedIssues(raw: unknown, own: number): number[] {
  if (!Array.isArray(raw) || !raw.length) throw new Refuse(`Refused: issues must list at least one issue number, and it got ${JSON.stringify(raw)}. Nothing changed.`)
  const bad = raw.filter(x => !Number.isInteger(Number(x)) || Number(x) <= 0 || x === null || x === '')
  if (bad.length) throw new Refuse(`Refused: issues holds ${JSON.stringify(bad)}, which is not an issue number. Nothing changed.`)
  const numbers = [...new Set(raw.map(Number))].sort((a, b) => a - b)
  if (numbers.includes(own)) throw new Refuse(`Refused: issues names #${own}, the issue that this call comes from. Nothing changed.`)
  return numbers
}

// Each problem is named at once, so one retry can repair them all.
async function mustBeOpen($: EngineInterface, wf: Workflow, issues: number[]): Promise<void> {
  const problems: string[] = []
  for (const n of issues) {
    try {
      const { state } = JSON.parse(await gh($, wf.root, wf.repo, ['issue-read', String(n)])) as { state?: string }
      if (state !== 'open') problems.push(`#${n} is ${state ?? 'of no known state'}`)
    } catch (error) {
      problems.push(`#${n} could not be read: ${String(error).slice(-300)}`)
    }
  }
  if (problems.length) throw new Refuse(`Refused: ${problems.join('; ')}. Nothing started.`)
}

// One supervised worker, so Orca wakes this session when it asks or ends. --full because the concise receipt has no
// recovery. worker-start prints its receipt with ok: true even when the start failed and it exits 1, so the state in the receipt decides, not the exit code.
async function startWorktreeWorker($: EngineInterface, wf: Workflow, entry: Workflow['followUps'][number], message: string): Promise<string[]> {
  const issues = entry.issues ?? [entry.issue]
  const who = issues.map(i => `#${i}`).join(', ')
  if (entry.dispatchId) return [`The worker ${entry.dispatchId} already carries ${who}, so nothing new started.`]
  const handed = await handOverInterviews($, wf, issues)
  // A hand-over with no worker would relax the heavy gate for whoever starts that issue later.
  const fail = async (message: string): Promise<never> => {
    const common = await commonDir($, wf.root, wf.root)
    const left: string[] = []
    if (common) {
      for (const i of issues) {
        const removed = await run($, ['rm', '-f', handOverPath(common, i)], { cwd: wf.root })
        if (removed.exitCode !== 0) left.push(`${handOverPath(common, i)} stays: rm exited ${removed.exitCode}: ${said(removed)}. Repair: delete it.`)
      }
    }
    throw new Refuse([message, ...left].join('\n'))
  }
  const lead = issues[0]!
  const slug = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40).replace(/-$/, '') || 'follow-up'
  const others = issues.slice(1)
  const join = others.length ? ` Then call started for ${others.map(i => `#${i}`).join(', ')}: each joins the same worktree and PR, with its own closing line.` : ''
  const spec = `Use the ndev plugin to work on ${who} of ${wf.repo}, in this new workspace with one PR. Call started with issue ${lead} and shortName "${slug}".${join} It came up during #${wf.issue}.${handed.length ? ` The answers of its interview are in ${handed.join(', ')} in your worktree. Read them first.` : ''}\n\n${message}`
  const { main } = await paths($, wf.root)
  const out = await run($, ['orca', 'orchestration', 'worker-start', '--spec', spec, '--task-title', entry.title, '--worktree', 'new-top-level', '--repo', `path:${main}`, '--name', `${lead}-${slug}`, '--agent', 'claude', '--keep-open', '--timeout-ms', '120000', '--full', '--json'], { cwd: wf.root, timeoutMs: 180_000 })
  const retry = `Call followUp again with the same text to retry: it reuses what exists.`
  let reply: { ok?: boolean; result?: { state?: string; dispatchId?: string; runId?: string; lastError?: string; failedStage?: string; recovery?: string }; error?: { code?: string; message?: string } } | undefined
  try {
    reply = JSON.parse(out.stdout) as typeof reply
  } catch {
    return fail(`orca orchestration worker-start for ${who} exited ${out.exitCode} and printed no JSON: ${said(out)}\nIf Orca is closed, run orca open. ${retry}`)
  }
  const receipt = reply?.result
  if (!reply?.ok || !receipt) return fail(`orca orchestration worker-start for ${who} refused: ${reply?.error?.code ?? ''}: ${reply?.error?.message ?? JSON.stringify(reply).slice(0, 300)}\n${retry}`)
  if (receipt.state !== 'ready') return fail(`The worker for ${who} did not start: ${receipt.lastError ?? receipt.state ?? 'no state'} at ${receipt.failedStage ?? 'an unknown stage'}. ${receipt.recovery ?? 'Orca gave no recovery.'}\n${retry}`)
  entry.dispatchId = receipt.dispatchId
  await saveWorkflow($, wf)
  const notes = [`The Orca worker ${receipt.dispatchId} carries ${who} in the workspace ${lead}-${slug}, on one PR. Run ${receipt.runId}: Orca wakes this session when it asks or ends.`]
  for (const i of issues) {
    try {
      await gh($, wf.root, wf.repo, ['subissues', 'link', String(wf.issue), String(i)])
    } catch (error) {
      notes.push(`#${i} is not a sub-issue of #${wf.issue}: ${String(error).slice(-300)}\nRepair: ndev github subissues link ${wf.issue} ${i}`)
    }
  }
  return notes
}

async function followUp($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const mode = text(args, 'mode')
  const message = text(args, 'message')
  if (!['this_agent', 'subagent', 'worktree', 'issue_only'].includes(mode)) throw new Refuse(`Refused: mode is ${JSON.stringify(mode)}; use this_agent, subagent, worktree or issue_only.`)
  if (!message) throw new Refuse('Refused: followUp needs a message: its first line is the issue title.')
  if (args.issues !== undefined && mode !== 'worktree') throw new Refuse(`Refused: issues goes only with the mode worktree, and the mode is ${mode}. Nothing changed.`)
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  const tool: Tool = mode === 'this_agent' ? 'followUpThisAgent' : mode === 'issue_only' ? 'followUpIssue' : 'followUpOther'
  legal(wf, tool, facts)
  if (mode === 'this_agent' && wf.direct) throw new Refuse('Refused: a project that commits directly to the base branch has no PR to carry a sub-issue. Use issue_only, or do the work and commit it.')
  if (mode === 'this_agent') await openPendingPr($, wf)
  if (mode === 'this_agent' && wf.prs[0]) {
    const prState = wf.merged ? 'merged' : (await readPr($, wf.root, wf.repo, wf.prs[0])).state
    if (prState !== 'open') throw new Refuse(`Refused: PR #${wf.prs[0]} is ${prState}, so it cannot carry a new issue. Nothing was filed. Repair: use the mode issue_only, or worktree to start the work in its own worktree.`)
  }
  const named = args.issues === undefined ? undefined : namedIssues(args.issues, wf.issue)

  // A retry after a failed Orca call or a crash reuses the issue, so nothing is filed twice.
  const hash = hashOf(named ? `${mode}\n${message}\n${named.join(',')}` : `${mode}\n${message}`)
  let entry = wf.followUps.find(f => f.hash === hash)
  const [title, ...rest] = message.split('\n')
  if (!entry && named) {
    const taken = named.filter(n => wf.followUps.some(f => f.dispatchId && (f.issues ?? [f.issue]).includes(n)))
    if (taken.length) throw new Refuse(`Refused: a worker from an earlier followUp already carries ${taken.map(n => `#${n}`).join(', ')}. Nothing started.`)
    await mustBeOpen($, wf, named)
    entry = { hash, mode, issue: named[0]!, issues: named, title: title! }
    wf.followUps.push(entry)
    await saveWorkflow($, wf)
  }
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
  const notes = (entry.issues ?? [n]).map(i => `Issue: https://github.com/${wf.repo}/issues/${i}`)
  // Model: models/workflow/issue_workflow.qnt#followUpThisAgent
  if (mode === 'this_agent') {
    await gh($, wf.root, wf.repo, ['subissues', 'link', String(wf.issue), String(n)])
    await editBody($, wf, old => (hasIssueRef(old, n) ? old : `${old.trimEnd()}\n\nCloses #${n}\n`))
    await comment($, wf.root, wf.repo, n, `${MARKER}\nCarried by #${wf.prs[0]}.`)
    notes.push(`This PR now closes #${n}. Do that work here.`)
    const pr = wf.prs[0]!
    let child = (await readHeld($, wf.root)).issues.find(o => o.issue === n)
    if (!child) {
      child = { issue: n, root: wf.root, repo: wf.repo, base: wf.base, branch: wf.branch, prs: [pr], state: 'developing', owner: wf.owner, evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], noInterview: true }
      await saveWorkflow($, child)
    }
    const carrier = wf.pr ? wf : await loadPrRecord($, wf.root, pr)
    if (carrier && !carrier.issues?.includes(n)) notes.push(await backToDevelopers($, project, carrier, n, 'followUp:this_agent'))
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
    const spawned = await $.agent.spawn({ subagentType: 'ndev:issue-implementer', prompt: `Work on issue #${n} of ${wf.repo}, in its own worktree ${worktree} on the branch ${branch}, and open its own PR. The worktree is claimed for you: do not claim another, and do not call started. Commit and push only through mcp__ndev__checkpoint with issue ${n}, worktree "${worktree}", the message and each file: it runs the check scripts, and a raw git commit or push is refused. It came up during #${wf.issue}. ${message}`, description: `Follow-up issue #${n}`, cwd: worktree })
    if ('deny' in spawned && spawned.deny) throw new Refuse(`The issue #${n} and the worktree ${worktree} exist, and the agent did not start: ${String(spawned.deny)}\nCall followUp again with the same text to retry: it reuses both.`)
    notes.push(`An agent works on #${n} in its own worktree ${worktree} and PR, by this followUp call. It commits there through checkpoint with issue ${n}, which refuses until that worktree has the check scripts.`)
  }
  if (mode === 'worktree') notes.push(...(await startWorktreeWorker($, wf, entry, message)))
  await move($, c, wf, tool, facts, `followUp:${mode}`)
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes)
}

const normalPath = (path: string) => `/${path.split('/').reduce<string[]>((kept, part) => (part === '..' ? kept.slice(0, -1) : part && part !== '.' ? [...kept, part] : kept), []).join('/')}`

async function addMigration($: EngineInterface, c: Ctx): Promise<string> {
  const { args, project } = c
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, project, wf)
  const name = text(args, 'name')
  if (!/^[a-z0-9_]+$/.test(name)) throw new Refuse(`Refused: the migration name ${JSON.stringify(name)} must hold only lower-case letters, digits and underscores.`)
  if (wf.direct || (!wf.prs[0] && !wf.prTitle)) throw new Refuse('Refused: this workflow has no PR, so nothing runs a migration after a merge. Add it with supabase migration new, and run it yourself.')
  if (['setup', 'done', 'blocked', 'wait'].includes(wf.state)) throw new Refuse(`Refused: addMigration is not valid in the state "${wf.state}".`)
  const workdir = text(args, 'workdir').replace(/\/$/, '')
  const prefix = workdir ? `${workdir}/` : ''
  if (!(await $.fs.exists(`${wf.root}/${prefix}supabase/config.toml`))) throw new Refuse(`Refused: ${wf.root}/${prefix}supabase/config.toml does not exist. Repair: run supabase init there, or pass workdir with the folder that holds supabase/.`)
  // A version must sort after every migration here, and a project may date its versions after the clock,
  // so the clock alone can still sort before migrations already applied.
  const stamp = async () => {
    const dir = `${wf.root}/${prefix}supabase/migrations`
    const versions = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(e => /^(\d{14})_/.exec(e.name)?.[1]).filter((v): v is string => !!v) : []
    const newest = versions.sort().pop()
    const after = newest ? Date.UTC(+newest.slice(0, 4), +newest.slice(4, 6) - 1, +newest.slice(6, 8), +newest.slice(8, 10), +newest.slice(10, 12), +newest.slice(12, 14)) + 1000 : 0
    return new Date(Math.max(await $.clock.now(), after)).toISOString().replace(/\D/g, '').slice(0, 14)
  }
  const notes: string[] = []
  const adopt = text(args, 'adopt')
  if (adopt && args.newVersion === true) throw new Refuse(`Refused: adopt lists an existing file and newVersion moves a listed one. Repair: pass only one of them for ${name}.`)
  let entry = wf.migrations.find(m => m.name === name)
  if (adopt) {
    if (entry) throw new Refuse(`Refused: Migration ${name} is already listed as ${entry.path} on #${wf.issue}. Repair: leave out adopt, or pass newVersion true to move it.`)
    const root = normalPath(wf.root)
    const dir = normalPath(`${wf.root}/${prefix}supabase/migrations`)
    if (!dir.startsWith(`${root}/`)) throw new Refuse(`Refused: cannot adopt ${adopt}: the migration folder ${dir} is outside ${root}. Repair: pass a workdir inside the worktree.`)
    const target = normalPath(adopt.startsWith('/') ? adopt : `${wf.root}/${adopt}`)
    const slash = target.lastIndexOf('/')
    const file = target.slice(slash + 1)
    if (target.slice(0, slash) !== dir) throw new Refuse(`Refused: cannot adopt ${adopt}: it is not directly inside ${dir}. Repair: pass a path of the form ${prefix}supabase/migrations/<version>_${name}.sql.`)
    if (!(await $.fs.exists(target))) throw new Refuse(`Refused: cannot adopt ${adopt}: ${target} does not exist. Repair: pass the path of the existing migration file, or leave out adopt to create a new empty one.`)
    if (!(await $.fs.list(dir)).some(e => e.name === file && e.kind === 'file' && !e.isLink)) throw new Refuse(`Refused: cannot adopt ${adopt}: ${target} is not a file. Repair: pass the path of the migration file itself.`)
    const adopted = target.slice(root.length + 1)
    const holder = [wf, ...(await prSiblings($, wf))].find(o => o.migrations.some(m => normalPath(`${wf.root}/${m.path}`) === target))
    if (holder) throw new Refuse(`Refused: cannot adopt ${adopted}: it is already listed on #${holder.issue}. Repair: leave it on #${holder.issue}, or adopt a file that no issue lists.`)
    if (!new RegExp(`^\\d{14}_${name}\\.sql$`).test(file)) throw new Refuse(`Refused: cannot adopt ${adopted}: the file name does not match the migration name ${name}. Repair: pass adopt with a file named <14-digit version>_${name}.sql, or use the name that the file already has.`)
    entry = { name, path: adopted }
    wf.migrations.push(entry)
    await saveWorkflow($, wf)
    notes.push(`Adopted: ${wf.root}/${entry.path} is listed as it is, with no rename or rewrite. Commit it with checkpoint if it is not committed. /ndev:merge runs it after the merge.`)
  } else if (!entry) {
    entry = { name, path: `${prefix}supabase/migrations/${await stamp()}_${name}.sql` }
    await $.fs.write(`${wf.root}/${entry.path}`, '')
    wf.migrations.push(entry)
    await saveWorkflow($, wf)
  } else if (args.newVersion === true) {
    // A newer migration reached the database first: the file needs a later version before the merge.
    const old = entry.path
    const sql = (await $.fs.exists(`${wf.root}/${old}`)) ? await $.fs.read(`${wf.root}/${old}`) : ''
    entry.path = `${prefix}supabase/migrations/${await stamp()}_${name}.sql`
    if (entry.path === old) throw new Refuse(`Refused: the new version of ${old} would be the same as the old one. Call addMigration again a second later.`)
    await $.fs.write(`${wf.root}/${entry.path}`, sql)
    await saveWorkflow($, wf)
    // The PR record and each issue on the PR keep their own copy of the list.
    for (const o of await prSiblings($, wf)) {
      const listed = o.migrations.find(m => m.path === old)
      if (!listed) continue
      listed.path = entry.path
      await saveWorkflow($, o)
    }
    notes.push(`New version: ${wf.root}/${entry.path} replaces ${old} in the list${sql ? ' and holds its SQL' : ''}. Now delete ${wf.root}/${old}, and commit both with checkpoint.`)
  } else if (!(await $.fs.exists(`${wf.root}/${entry.path}`))) {
    throw new Refuse(`Refused: the listed migration ${wf.root}/${entry.path} does not exist. Repair: put its file back, or call addMigration with name ${JSON.stringify(name)} and newVersion true to give it a new version.`)
  }
  const lines = [...new Set([wf, ...(await prSiblings($, wf))].flatMap(o => o.migrations.map(m => m.path)))].map(path => `- \`${path}\``).join('\n')
  const section = `<!-- ndev:migrations -->\n## Migrations to run after merge\n\n${lines}\n<!-- /ndev:migrations -->\n`
  await editBody($, wf, old => (SECTION.test(old) ? old.replace(SECTION, section) : `${old.trimEnd()}\n\n${section}`))
  await saveWorkflow($, wf)
  return answer($, wf, facts, notes.length ? notes : [`Migration file: ${wf.root}/${entry.path}. Write its SQL and commit it with checkpoint. /ndev:merge runs it after the merge.`])
}

async function status($: EngineInterface, c: Ctx): Promise<string> {
  const { project } = c
  const root = (await read($, workflowRoot)) ?? project?.root
  const named = c.args.issue === undefined ? undefined : Number(c.args.issue)
  const pr = c.args.pr === undefined ? undefined : Number(c.args.pr)
  const wf = !root ? undefined : pr !== undefined ? await loadPrRecord($, root, pr) : await loadWorkflow($, root, named)
  if (!wf || !root) return `No workflow${pr ? ` for PR #${pr}` : named ? ` for issue #${named}` : ''} in this session. Next: call started with the issue number.`
  const facts = await factsFor($, root, project, wf)
  const holder = wf.state === 'wait' ? await waitHolder($, wf) : undefined
  const extra = [wf.off ? `Off: ${wf.off.reason}. /flow on turns it back on.` : '', project?.config.workflow === false ? `Off for this project: ${project.path}.` : '', wf.blocked ? `Blocked: ${wf.blocked.message}` : '', holder?.detail ?? '', wf.changeTypes?.length ? `Change types: ${wf.changeTypes.join(', ')}.` : '', wf.migrations.length ? `Migrations after merge: ${wf.migrations.map(m => m.path).join(', ')}` : '']
  const merge = await finishedPrNow($, wf, facts)
  return answer($, wf, facts, [...extra, merge?.detail ?? ''], holder?.next ?? merge?.next)
}

// The base can move after done, so only a read of the PR can say that a finished PR is still ready to merge.
async function finishedPrNow($: EngineInterface, wf: Workflow, facts: Facts): Promise<{ detail?: string; next?: string } | undefined> {
  const n = wf.prs[0]
  if (wf.state !== 'done' || wf.merged || wf.direct || !n) return undefined
  let health: PrHealth
  try {
    health = await readPrHealth($, wf.root, wf.repo, n)
  } catch (error) {
    return { detail: `PR #${n} was not read: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`, next: `Whether PR #${n} can merge is not known, so do not report it as ready. Call status again.` }
  }
  if (health.merged) return { next: `PR #${n} is merged. Nothing is left to do.` }
  if (health.closed) return { next: `PR #${n} was closed with no merge, so no merge is waiting. Repair: gh pr reopen ${n} --repo ${wf.repo}.` }
  const seen = `GitHub says of PR #${n} at ${health.sha.slice(0, 8)}: mergeable ${health.seen.mergeable}.`
  if (health.problems.length) return { detail: `${seen}\n${health.problems.join('\n')}`, next: `PR #${n} is not ready to merge, so do not report it as ready. Fix each problem above and commit with checkpoint, which takes the PR back to the checks.` }
  if (health.computing) return { detail: seen, next: `GitHub has not finished computing whether PR #${n} can merge, so do not report it as ready. Call status again in a minute.` }
  return mayMerge(facts.level) ? { detail: seen } : { detail: seen, next: 'The work is finished and ready for a human to merge. Nothing is left to do.' }
}

// Says what holds a record in "wait". Only a wait tool in this process, or another session that is still live, can.
export async function waitHolder($: EngineInterface, wf: Workflow): Promise<{ detail: string; next?: string }> {
  const what = wf.waiting?.what ?? 'a condition that the record does not name'
  // /unblock reads the record that this session is on, and that can be another one.
  const bound = await loadWorkflow($, wf.root)
  const canUnblock = !!bound && sameRecord(bound, wf)
  if (wf.waiting && isWaitRunning(wf.waiting.id)) return { detail: `Waiting for ${what}.${canUnblock ? ' /unblock <message> ends it.' : ''}` }
  const other = wf.owner && wf.owner.session !== (await $.session.id()) && (await $.clock.now()) - wf.owner.at < OWNER_LIVE_MS ? wf.owner.session : undefined
  if (other) return { detail: `Waiting for ${what} in the session ${other}.`, next: `The session ${other} holds this wait, so leave it to that session. If that session is dead, call started with issue ${wf.issue} and takeOver true.` }
  return { detail: `No wait tool runs: ${wf.waiting?.tool ?? 'the wait'} for ${what} ended without an answer, or its session died.`, next: `Call started with issue ${wf.issue} to go back to the state "${wf.previous ?? 'developing'}"${canUnblock ? ', or the human types /unblock <message>' : ''}.` }
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

// The most that one wait call can hold the agent, with all its checks and pauses.
const WAIT_MAX_S = 1200
const WAIT_CHECK_MAX_MS = 60_000
// The last part of a timeout, or a tenth of it if that is less: one part for the last check, and one to end the wait.
const WAIT_END_MS = 10_000
// GitHub calls are limited, so a wait on GitHub reads seldom. Each check is one read.
const WAIT_GITHUB_PERIOD_S = { fallback: 300, least: 60 }
const WAIT_PR_STATES = ['open', 'closed', 'merged', 'draft', 'ready', 'mergeable']
const WAIT_ISSUE_STATES = ['open', 'closed']
const WAIT_LIMITS = { attempts: { type: 'integer', description: 'The most checks. The default is as many as the timeout allows' }, timeout: { type: 'number', description: `In seconds: the most time this wait can hold the agent, with all its checks and pauses. The default and the highest value is ${WAIT_MAX_S} (20 minutes)` } }
const ISSUE_ARG = { type: 'number', description: 'The issue this call is for: the one that this agent is on. A worktree can hold several issues.' }
const PR_ARG = { type: 'number', description: 'The PR this call is for. From finishedDevelopment on, the PR goes through the review, the checks and done. Give issue or pr.' }
const SPEC_LIST: Spec[] = [
  { name: 'create', description: 'File a new issue and start its workflow, as started does. The answer gives the issue number.', properties: { mode: { type: 'string', enum: ['light', 'heavy', 'hack'], description: 'Optional, and only at the start: heavy for a multi-step, cross-cutting or high-risk change, hack when the human wants to find the solution by trial and error first (interactive only), and light for the others. With no value, the issue follows the worktree.' }, shortName: { ...STR, description: 'Two to five lower-case words joined by hyphens. The Orca workspace is <issue>-<shortName>, and <PR>-<shortName> once a PR is added.' }, description: { ...STR, description: 'The first line is the issue title, and the rest is its body' } }, required: ['shortName', 'description'] },
  { name: 'comment', description: 'Add a comment to an issue or a PR. Give issue or pr, not both. It works with or without a workflow.', properties: { issue: { type: 'number' }, pr: { type: 'number' }, message: STR }, required: ['message'] },
  { name: 'started', description: 'Start or resume the workflow of an issue. Call it first in each work session. It records the state, claims the worktree, opens the draft PR and answers with the next step.', properties: { mode: { type: 'string', enum: ['light', 'heavy', 'hack'], description: 'Optional, and only at the start: heavy for a multi-step, cross-cutting or high-risk change, hack when the human wants to find the solution by trial and error first (interactive only), and light for the others. With no value, the issue follows the worktree.' }, shortName: { ...STR, description: 'Two to five lower-case words joined by hyphens, chosen from the issue. A new workflow needs it. The Orca workspace is <issue>-<shortName>, and <PR>-<shortName> once a PR is added.' }, issue: { type: 'number' }, takeOver: { type: 'boolean', description: 'Only when the session that owns the workflow is dead' } }, required: ['issue'] },
  { name: 'interview', description: 'With interviewJson: show one round of questions to the human in the interview pane, hold until the human answers, and return the answers and notes. In Orca Chat, which has no pane, it returns the round as Markdown to post in the chat, and answersJson then records the human\'s answers. With no arguments: the interview is over, so go on to the next state. Only that call leaves the state "interviewing". Load the ndev:interview skill for the method.', properties: { interviewJson: { description: 'One round: { title, intro?, questions: [{ id, header, question, context?, multiSelect?, followUpTo?, options?: [{ label, description?, preview?, recommended? }], suggested? }] }. Markdown works in question, context, description and preview. Each question needs a recommendation: an option with recommended true, or suggested when it has no options. Ids are unique across all rounds of the issue. followUpTo names the earlier question that this one follows.' }, answersJson: { description: 'Only in Orca Chat, after interviewJson: the human\'s chat answers to that round, as { "<question id>": { selected?: [option labels], other?: "the human\'s own words", notes? } }, with an entry for each question.' } }, required: [] },
  { name: 'setSteering', description: 'No human can answer in this session, such as with -p or an unattended prompt: set this issue to auto. Only a human can set it back. In the state "interviewing" this goes on to the next state. The reason goes on the issue and the PR. A preference is not a reason.', properties: { steering: { type: 'string', enum: ['auto'] }, reason: { ...STR, description: 'Why no human can answer' } }, required: ['steering', 'reason'] },
  { name: 'finishedPlan', description: 'The plan is written: put it in the PR body and go on to development.', properties: { markdown_file: { ...STR, description: 'The plan file' } }, required: ['markdown_file'] },
  { name: 'checkpoint', description: 'Commit the named files and push, after the check scripts. Use this and not git commit or git push.', properties: { message: STR, files: FILES, changeTypes: CHANGE_TYPES_ARG, worktree: { ...STR, description: 'Only for an agent that followUp started: its own worktree' } }, required: ['message', 'files'] },
  { name: 'finishedInterview', description: 'The interview with the human has ended, and development can start. This runs the base check: pre-commit-check.sh in light mode and pre-push-check.sh in heavy mode. Hack mode has none. Call it after the last question and before any code. It answers with a failure and does not block, and it can run again.', properties: {}, required: [] },
  { name: 'hotfix', description: 'An urgent fix that must not wait for the workflow. This files an issue, and gives it its own worktree and draft PR with the workflow off there. The answer gives the hotfix instructions. This session stays on its own issue. Use it only for an urgent fix.', properties: { issue: { type: 'number', description: 'Only for a retry after a failed set-up: the issue that the earlier call filed. Nothing new is filed.' }, shortName: { ...STR, description: 'Two to five lower-case words joined by hyphens, such as fix-login-redirect.' }, description: { ...STR, description: 'Optional. The first line is the issue title, and the rest is its body. With no value, the title comes from shortName.' } }, required: ['shortName'] },
  { name: 'finishedHacking', description: 'Hack mode: the human agrees that the hack works. Go on to hardening, where the change is pinned with tests and checked before anything is pushed.', properties: {}, required: [] },
  { name: 'finishedDevelopment', description: 'Development is complete: commit the named files and go on to review. This runs the dead-code sweep, starts the code review and fires the remember hook. This commit is not pushed until finishedReview.', properties: { issues: { type: 'array', items: { type: 'number' }, description: 'Each issue that this call finishes. An issue on the same PR that is still in development makes the PR wait for it, and the last one to finish starts the review.' }, prs: { type: 'array', items: { type: 'number' } }, message: STR, files: FILES, changeTypes: CHANGE_TYPES_ARG, body_file: { ...STR, description: 'Optional. A markdown file for the PR body: the problem, the result, the test evidence and the limits. The tool adds the closing reference, unless the file says "Part of #<issue>" or "Refs #<issue>" for an issue that must stay open. Keep it outside the worktree, or name it in files.' }, hardening: { ...STR, description: 'Needed for a hack issue: each test that pins the change, the command and the failing line on the base, and its pass on HEAD. It goes on the PR.' } }, required: ['issues', 'prs'] },
  { name: 'finishedReview', description: 'Reviews are complete: run pre-ready-check.sh, push, mark the PR ready and go on to the checks. Each field is the result or "skipped: <reason>". remembered is what the remember hook recorded in the docs and the wiki, or "nothing: <reason>".', properties: { review: STR, deadcode: STR, remembered: STR }, required: ['review', 'deadcode', 'remembered'] },
  { name: 'finishedChecks', description: 'The checks have ended: the tool reads them for HEAD and goes on, or refuses and names them.', properties: {}, required: [] },
  { name: 'finishedSmoke', description: 'The smoke test is complete: post the report, which names the HEAD sha. Or give skipped with the reason.', properties: { report: STR, skipped: STR }, required: [] },
  { name: 'finishedRevision', description: 'Each piece of feedback has an answer: go back to the checks.', properties: {}, required: [] },
  { name: 'blocked', description: 'Nothing can go on without the human. This raises a persistent notification and an Orca flag, and stops the reminders. Say what the human must do.', properties: { message: STR }, required: ['message'] },
  { name: 'unblocked', description: 'The block is resolved: withdraw the notification and go back to the earlier state.', properties: { message: STR }, required: [] },
  { name: 'done', description: 'All the work is complete. The tool checks all of it, lists every problem, and marks it done. It merges only when the project level lets the agent merge. remembered is needed only when the review stage was skipped: what you recorded in the docs and the wiki, or "nothing: <reason>".', properties: { message: STR, remembered: STR }, required: ['message'] },
  { name: 'followUp', description: 'File a new issue for work that does not belong to this issue, and act by mode: this_agent (this PR carries it), subagent, worktree (a new Orca workspace with a supervised worker and its own PR) or issue_only. With the mode worktree, issues names existing issues instead: nothing is filed, and one worker carries them all on one PR.', properties: { mode: { type: 'string', enum: ['this_agent', 'subagent', 'worktree', 'issue_only'] }, message: { ...STR, description: 'The first line is the issue title. With issues, it names the workspace, and the whole message is the brief for the worker' }, issues: { type: 'array', items: { type: 'number' }, description: 'Only with the mode worktree: the open issues that the one worker and PR carry' } }, required: ['mode', 'message'], forSubagents: true },
  { name: 'addMigration', description: 'Add a named Supabase migration, to run after the merge. This makes the empty migration file and lists it in the PR body. /ndev:merge runs it.', properties: { name: { ...STR, description: 'Lower-case letters, digits and underscores' }, workdir: { ...STR, description: 'The folder that holds supabase/, when it is not the root' }, newVersion: { type: 'boolean', description: 'Only for a listed migration, before the merge: give it a new version, such as when a newer migration reached the database first. The SQL moves to the new file, and the list names it.' }, adopt: { ...STR, description: 'The path, from the worktree root, of a migration file that already exists in supabase/migrations: list it as it is, with no rename or rewrite. Its file name must be <14-digit version>_<name>.sql. Not with newVersion.' } }, required: ['name'] },
  { name: 'reportWorkflowBug', description: 'The ndev workflow or plugin itself did something wrong: a tool answered wrongly, crashed, or refused for no reason. This starts an Orca agent that fixes it on main of the plugin, so go on with your own work. Not for a bug in the project, and not for a refusal that is correct.', properties: { title: { type: 'string', description: 'One line that names the bug' }, details: { type: 'string', description: 'The tool and arguments, what it answered, and what you expected' } }, required: ['title', 'details'], forSubagents: true },
  { name: 'iNeedA', description: 'Ask the plugin for guidance before you choose or write one of these, so that the work keeps to the approved set: react-component, library, brand-style (a call on a font, a colour and so on) or animation (a micro-interaction, a simple animation or a full showy one). The answer gives suggestions and where to get them. It is guidance: you can still choose otherwise and say why.', properties: { kind: { type: 'string', enum: [...NEED_KINDS] }, description: { type: 'string', description: 'What it is for: the component type, the job of the library, the style question or the moment to animate' } }, required: ['kind', 'description'], forSubagents: true },
  { name: 'screenshot', description: 'Take images of one page in the Orca browser, at each viewport and colour scheme, and save them as files. The answer gives each full path. The answer warns when the page did not change between light and dark. The tab closes after, unless the page lands on a login, which the human signs in to once. Orca must run. It makes no GitHub call, and the images do not reach the PR.', properties: { url: { ...STR, description: 'The full http or https URL' }, viewports: { type: 'array', items: STR, description: 'Sizes such as 390x844. The default is 390x844, 820x1180 and 1440x900.' }, schemes: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] }, description: 'The default is light and dark.' }, fullPage: { type: 'boolean', description: 'Take the whole page and not only the viewport: one image for each scrolled step, named -part1, -part2 and so on when the page is taller than the viewport. A pane that scrolls inside the page gives a warning: only its visible part is taken.' }, waitSeconds: { type: 'number', description: 'A pause after the load, for a page that fills in late.' } }, required: ['url'], forSubagents: true },
  { name: 'waitForSubAgent', description: 'Hold this agent until the named subagent ends. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { claude_agent_id: { ...STR, description: 'The id of the agent' }, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['claude_agent_id'] },
  { name: 'waitForURL', description: 'Hold this agent until the URL answers with a 2xx status. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { url: STR, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['url'] },
  { name: 'waitForProcessEnd', description: 'Hold this agent until the process ends. It cannot read the exit code: read the log or the result file of the process. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { pid: { type: 'integer' }, period: { type: 'number', description: 'Seconds between checks. The default is 5' }, ...WAIT_LIMITS }, required: ['pid'] },
  { name: 'waitForSeconds', description: 'Hold this agent for this many seconds. attempts has no effect here, because no check runs. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { secs: { type: 'number', description: `The seconds to hold, at most ${WAIT_MAX_S}` }, ...WAIT_LIMITS }, required: ['secs'] },
  { name: 'waitFor', description: 'Hold this agent and run the shell command every period seconds, in the worktree, until it exits 0. Each run may last 60 s, or what is left of the timeout if that is less. It gives up after attempts or timeout. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.', properties: { shell_command: STR, period: { type: 'number', description: 'Seconds between checks. The default is 30' }, ...WAIT_LIMITS }, required: ['shell_command'] },
  { name: 'waitForPR', description: `Hold this agent until the PR reaches the state: ${WAIT_PR_STATES.join(', ')}. Do not use it for the checks of this PR: the workflow watches those. Each check is one GitHub read, so period is at least ${WAIT_GITHUB_PERIOD_S.least} s. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.`, properties: { pr: { type: 'integer' }, state: { type: 'string', enum: [...WAIT_PR_STATES] }, period: { type: 'number', description: `Seconds between checks. The default is ${WAIT_GITHUB_PERIOD_S.fallback}` }, ...WAIT_LIMITS }, required: ['pr', 'state'] },
  { name: 'waitForIssue', description: `Hold this agent until each named issue reaches the state: ${WAIT_ISSUE_STATES.join(', ')}. Each check is one GitHub read, so period is at least ${WAIT_GITHUB_PERIOD_S.least} s. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.`, properties: { waitOn: { type: 'array', items: { type: 'integer' }, description: 'The issues to wait for. The wait ends when all of them reach the state' }, state: { type: 'string', enum: [...WAIT_ISSUE_STATES] }, period: { type: 'number', description: `Seconds between checks. The default is ${WAIT_GITHUB_PERIOD_S.fallback}` }, ...WAIT_LIMITS }, required: ['waitOn', 'state'] },
  { name: 'waitForState', description: `Hold this agent until another issue's workflow reaches the state, or is past it on the main line. It reads the workflow records in the worktrees of this repository and makes no GitHub call. An issue with no record yet counts as not there, so the wait goes on. The workflow is in the state "wait" meanwhile. The human can end the wait with /unblock.`, properties: { issue_id: { type: 'integer', description: 'The issue to watch. It is not the issue of this agent' }, state: { type: 'string', enum: [...STATES] }, period: { type: 'number', description: 'Seconds between checks. The default is 30' }, ...WAIT_LIMITS }, required: ['issue_id', 'state'] },
  { name: 'status', description: 'Read the workflow state and the next step. This changes nothing. With no issue, it reads the issue that this agent is on.', properties: { issue: { type: 'number' }, pr: { type: 'number' } }, required: [], forSubagents: true },
  { name: 'requestSecret', description: 'Find where a named secret is set: .neil-dev.env, then .env, then ~/.zshrc, then ~/.bashrc. The answer gives the file and the line number, never the value.', properties: { name: STR }, required: ['name'], forSubagents: true },
]

// Each of these acts on one workflow, so each names its issue.
const STATE_TOOLS = new Set(['interview', 'setSteering', 'finishedPlan', 'finishedInterview', 'finishedHacking', 'checkpoint', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'blocked', 'unblocked', 'done', 'followUp', 'addMigration', ...SPEC_LIST.filter(s => s.name.startsWith('wait')).map(s => s.name)])
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
  await endDeadWaits($, project, true)
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
  return wf?.state === 'planning' || wf?.state === 'developing' || wf?.state === 'hardening'
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
// A worktree's own git folder, and the one that each worktree of the repository shares. Undefined when git cannot read the folder.
async function gitDirs($: EngineInterface, cwd: string, dir: string): Promise<{ own: string; common: string } | undefined> {
  const out = await git(cwd, $, '-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
  if (out.exitCode !== 0) return undefined
  const [own, common] = out.stdout.trim().split('\n')
  return own && common ? { own, common } : undefined
}

async function commonDir($: EngineInterface, cwd: string, dir: string): Promise<string | undefined> {
  return (await gitDirs($, cwd, dir))?.common
}

// Git's environment wins over its folder.
// The guard is for the workflow's own worktree, and for the worktrees that followUp started, which have the
// checkpoint tool. A helper's own worktree and each other repository have no checks here, so they pass.
// The main checkout of the repository does not pass. A command that does not show its folder for sure counts as the workflow's.
async function reachesWorkflowRepo($: EngineInterface, wf: Workflow, command: string, agentId: string | undefined): Promise<boolean> {
  const own = await gitDirs($, wf.root, wf.root)
  if (!own) return true
  const home = await $.env.get('HOME')
  const hotfixes = await read($, hotfixWorktrees)
  const code = gitCode(command)
  for (const match of code.matchAll(RAW_GIT)) {
    const dir = gitFolder(code, code.slice(0, match.index), match[1] ?? '', agentId ? await $.session.cwd() : undefined, home)
    if (!dir) return true
    const hotfixEntry = hotfixes.find(h => h.dir === dir.replace(/\/$/, ''))
    if (hotfixEntry) {
      // Refs are shared between worktrees, so this worktree can reach the held commits of the session's own branch.
      if (match[2] === 'push' && !pushesOnly(code.slice(match.index + match[0].length), hotfixEntry.branch)) return true
      continue
    }
    const there = await gitDirs($, wf.root, dir)
    if (!there) return true
    if (there.common !== own.common) continue
    if (match[2] === 'push' && pushNames(code.slice(match.index + match[0].length).split(/[;&|)\n]/)[0] ?? '', wf)) return true
    if (there.own === own.own || there.own === there.common) return true
    for (const f of wf.followUps) {
      if (f.worktree && (await gitDirs($, wf.root, f.worktree))?.own === there.own) return true
    }
  }
  return false
}

// A compaction takes the loaded skill out of the context, so the next started loads it again.
export const workflowSkillReset = (on: Parameters<Register>[0]) => {
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && !('skip' in result)) await update($, workSkillsLoaded, () => [])
    return result
  })
}

export const workflowGitGuard = (on: Parameters<Register>[0], getProject: () => LoadedConfig | undefined) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (OWN_WAIT.test(command) || CHECKS_WAIT.test(command)) {
      const project = getProject()
      if (project?.config.workflow === false) return next(e)
      const root = (await read($, workflowRoot)) ?? project?.root
      const wf = root ? await loadWorkflow($, root) : undefined
      if (wf && (await watchesChecks($, wf))) {
        // The watchdog does not watch a hotfix PR, so the agent's own wait is the only one.
        const named = CHECKS_WAIT.exec(command)?.[1]
        if (!named || !(await read($, hotfixPrs)).includes(Number(named))) return { deny: `workflow: The workflow watches the checks and merge conflicts of issue #${wf.issue} and prompts you when they end or when one fails, so this wait only spends GitHub calls. If nothing else is open, end your turn. A human can stop this with /flow off.` }
      }
    }
    if (!gitCode(command).match(RAW_GIT)) return next(e)
    const project = getProject()
    if (!(await workflowOwnsChecks($, project))) return next(e)
    const root = (await read($, workflowRoot)) ?? project?.root
    const wf = root ? await guardedRecord($, root) : undefined
    if (!wf || !(await reachesWorkflowRepo($, wf, command, (e as { agentId?: string }).agentId))) return next(e)
    const own = wf.followUps.filter(f => f.worktree)
    if ((e as { agentId?: string }).agentId && own.length) return { deny: `workflow: a commit or push here runs no check script. An agent that followUp started calls mcp__ndev__checkpoint with its own issue and worktree: ${own.map(f => `#${f.issue} in ${f.worktree}`).join(', ')}. Any other helper reports to the agent that started it.` }
    const hotfixes = (await read($, hotfixWorktrees)).map(h => `git -C ${h.dir} push origin ${h.branch}`)
    return { deny: `workflow: issue #${wf.issue} is in the state "${wf.state}", so this commit or push goes through the checkpoint tool, which runs the check scripts. From a hotfix worktree, a push goes only to the branch of the hotfix${hotfixes.length ? `, such as ${hotfixes.join(' or ')}` : ''}. It also ends a merge. ${holdsForReview(wf.state) ? `In this state the last commit is held for the review: ${reviewPushRoutes(wf.state)}` : 'With no files it pushes a held commit.'} A commit in another repository, such as ~/dev-wiki, passes when each git in the command names it with -C and a full path. A human can turn this off with /flow off.` }
  })
}

// True while this session's watchdog reads the checks, so the agent has no reason to wait: in `ci`,
// and in `finishing` after pending checks on this commit refused `done`.
export async function watchesChecks($: EngineInterface, wf: Workflow): Promise<boolean> {
  if (wf.off) return false
  if (wf.owner && wf.owner.session !== (await $.session.id())) return false
  if (wf.state === 'ci') return true
  if (wf.state !== 'finishing') return false
  const sha = wf.doneWaitsFor
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
    case 'hotfix': return hotfix($, c)
    case 'finishedInterview': return finishedInterview($, c)
    case 'finishedHacking': return finishedHacking($, c)
    case 'comment': return addComment($, c)
    case 'interview': return c.args.answersJson !== undefined ? recordChatAnswers($, c) : leaveInterview($, c)
    case 'setSteering': return setSteering($, c)
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
// On a busy computer each wake of the loop costs the hook far more of its own time (fcc-proto, load 150 on 10
// cores: 100-230 ms a slice, so a 1200 s wait stopped after 1-4 checks). The pauses then grow, and the checks
// space out, so that the time left lasts to the end of the wait. At most this long, so the owner stays live.
const WAIT_PAUSE_MAX_S = 240

// One pause of a waiting loop. The host aborts a pause that outran its limit, as when the computer
// slept through it. Its time has passed, so it did its work, and the loop reads the clock again.
// A pause that fails before its time cannot start, and that is a failure.
async function pause($: EngineInterface, root: string, secs: number): Promise<void> {
  const from = await $.clock.now()
  const r = await run($, ['sleep', String(secs)], { cwd: root, timeoutMs: Math.ceil((secs + 10) * 1000) })
  if (r.exitCode === 0) return
  const ran = (await $.clock.now()) - from
  if (ran >= secs * 1000) return
  throw new Error(`sleep ${secs} exited ${r.exitCode} after ${ran}ms in ${root}: ${r.stderr.trim().slice(0, 300) || 'no output'}`)
}
const WAIT_BUDGET_LOW_MS = 2_000
const WAIT_TOOLS = ['waitForSubAgent', 'waitForURL', 'waitForProcessEnd', 'waitForSeconds', 'waitFor', 'waitForPR', 'waitForIssue', 'waitForState']
const activeWaits = new Set<string>()
export const isWaitRunning = (id: string) => activeWaits.has(id)

type WaitSpec = { what: string; period: number }

function waitNumber(a: Args, tool: string, key: string, fallback: number, isWhole = false): number {
  const value = a[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (isWhole && !Number.isInteger(value))) throw new Refuse(`Refused: ${tool} needs ${key} to be a ${isWhole ? 'whole ' : ''}number above 0, and it got ${JSON.stringify(value)}. Nothing changed.`)
  return value
}

function waitLimit(value: number, tool: string, key: string): number {
  if (value > WAIT_MAX_S) throw new Refuse(`Refused: ${tool} can hold the agent for at most ${WAIT_MAX_S} s in all, and ${key} is ${value}. Nothing changed. Repair: give ${WAIT_MAX_S} or less. If the wait gives up, call it again, or call blocked if only the human can go on.`)
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
      const secs = waitLimit(waitNumber(a, name, 'secs', 0), name, 'secs')
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
    case 'waitForState': {
      const state = text(a, 'state')
      if (!isState(state)) throw new Refuse(`Refused: waitForState needs state to be one of ${STATES.join(', ')}, and it got "${state}". Nothing changed.`)
      if (a.issue_id === undefined) throw new Refuse('Refused: waitForState needs issue_id. Nothing changed.')
      return { what: `issue #${waitNumber(a, name, 'issue_id', 0, true)} to reach the state "${state}"`, period: waitNumber(a, name, 'period', 30) }
    }
    default: throw new Refuse(`There is no wait tool named ${name}.`)
  }
}

const isState = (value: string): value is State => (STATES as readonly string[]).includes(value)

// Where a state stands on the main line. developed comes between FLOW's hardening and reviewing, and a side state has no place.
const LINE: State[] = FLOW.flatMap(state => (state === 'hardening' ? [state, 'developed' as const] : [state]))

// A wait can sleep through a state, and an issue can be past it before the wait starts, so the current state alone would hold a wait that can never end.
function reachedState(wf: Workflow, wanted: State, startedAt: number): string | undefined {
  if (wf.state === wanted) return `It is in the state "${wanted}".`
  if (wf.history.some(h => h.at >= startedAt && h.to === wanted)) return `It was in the state "${wanted}" during this wait, and it is now in the state "${wf.state}".`
  // A held issue is at the stage it will go back to. A plan sign-off holds before that stage ever began, so the history must show it.
  const held = wf.state === 'blocked' || wf.state === 'wait'
  const stage = held ? (wf.previous ?? wf.state) : wf.state
  if (held && stage === wanted && wf.history.some(h => h.to === wanted)) return `It is at "${wanted}", held in "${wf.state}".`
  const at = LINE.indexOf(stage === 'revising' ? 'ci' : stage)
  const place = LINE.indexOf(wanted)
  return place >= 0 && at > place ? `It is in the state "${wf.state}", which is past "${wanted}".` : undefined
}

// The issue can be in any worktree of this repository. One unreadable file must not hide the record in another worktree, so a problem counts only if the record is not found.
async function checkIssueState($: EngineInterface, root: string, issue: number, wanted: State, startedAt: number, untilMs: number): Promise<{ isOver: boolean; detail: string; seen?: Record<string, string> }> {
  const listed = await waitRun($, ['git', 'worktree', 'list', '--porcelain'], root, untilMs)
  if (listed.exitCode !== 0) return { isOver: false, detail: `git worktree list in ${root}: exit code ${listed.exitCode}: ${listed.stderr.trim().slice(-300)}` }
  const worktrees = listed.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  const found: Workflow[] = []
  const problems: string[] = []
  for (const worktree of worktrees) {
    try {
      const { held, problems: bad } = await readHeldForPane($, worktree)
      problems.push(...bad)
      const own = held.issues.find(wf => wf.issue === issue)
      const record = own ? effectiveRecord(own, held.prs) : held.prs.find(p => p.issues?.includes(issue))
      if (record) found.push(record)
    } catch (error) {
      problems.push(`${worktree}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const lastMove = (wf: Workflow) => wf.history.at(-1)?.at ?? 0
  const wf = found.sort((a, b) => lastMove(b) - lastMove(a))[0]
  if (!wf) return { isOver: false, detail: `Issue #${issue} has no workflow record in ${worktrees.join(', ')}. It has not started, or its worktree is gone. If it is gone, waitForIssue can read it.${problems.length ? ` Not read: ${problems.join(' ').slice(0, 300)}` : ''}`, seen: { state: 'no record' } }
  const seen = { state: wf.state }
  const label = `Issue #${issue} (${labelOf(wf)}, in ${wf.root})`
  const reached = reachedState(wf, wanted, startedAt)
  if (reached) return { isOver: true, detail: `${label} has reached it. ${reached}`, seen }
  if (wf.state === 'done') return { isOver: true, detail: `${label} is done and did not reach the state "${wanted}", so nothing can end this wait.`, seen }
  if (wf.off) return { isOver: true, detail: `${label} has its workflow off, so it will not reach the state "${wanted}".`, seen }
  return { isOver: false, detail: `${label} is in the state "${wf.state}".`, seen }
}

// One check. A check is short: a command that hangs is killed, and counts as a failed attempt.
// One process of a check, limited to what is left of the wait's time. A process past that limit makes the host reject, which run reports as a process that did not start.
async function waitRun($: EngineInterface, argv: string[], cwd: string, untilMs: number, env?: Record<string, string>): Promise<Ran> {
  const at = await $.clock.now()
  const timeoutMs = Math.min(WAIT_CHECK_MAX_MS, Math.ceil(untilMs - at))
  if (timeoutMs < 1) return { exitCode: 124, stdout: '', stderr: `${argv[0]} did not start: the time of this wait is up.` }
  const r = await run($, argv, { cwd, timeoutMs, ...(env ? { env } : {}) })
  return r.exitCode === 127 && (await $.clock.now()) - at >= timeoutMs ? { ...r, exitCode: 124, stderr: `${argv[0]} was stopped after ${timeoutMs} ms, the most that this check could use.` } : r
}

async function waitCheck($: EngineInterface, name: string, a: Args, root: string, startedAt: number, untilMs: number): Promise<{ isOver: boolean; detail: string; seen?: Record<string, string> }> {
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
        const r = await waitRun($, ['bash', `${$.plugin.root}/scripts/github/gh.sh`, isPr ? 'pr-read' : 'issue-read', String(number)], root, untilMs, { GH_REPO: wf?.repo ?? '' })
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
    case 'waitForState':
      return checkIssueState($, root, Number(a.issue_id), text(a, 'state') as State, startedAt, untilMs)
    case 'waitForSubAgent': {
      const id = text(a, 'claude_agent_id')
      const agent = (await $.agent.list()).find(x => x.id === id)
      if (!agent) return { isOver: true, detail: `Agent ${id} is not listed, so it ended or the id is wrong. Read its result.` }
      return { isOver: !['pending', 'running', 'waiting'].includes(agent.status), detail: `Agent ${id} is ${agent.status}.`, seen: { status: agent.status } }
    }
    case 'waitForURL': {
      const r = await waitRun($, ['curl', '-sS', '-L', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', text(a, 'url')], root, untilMs)
      const code = r.stdout.trim()
      return { isOver: r.exitCode === 0 && /^2\d\d$/.test(code), detail: `HTTP ${code || 'no answer'}, curl exit code ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`, seen: { status: code || 'no answer' } }
    }
    case 'waitForProcessEnd': {
      const r = await waitRun($, ['ps', '-o', 'stat=', '-p', String(a.pid)], root, untilMs)
      const stat = r.stdout.trim()
      // ps exits 1 for no such process. A zombie has ended, and waits only for its parent to read it.
      if (r.exitCode === 1 || stat.startsWith('Z')) return { isOver: true, detail: `Process ${String(a.pid)} has ended. Read its log or result file for how it ended.` }
      return { isOver: false, detail: `Process ${String(a.pid)} has the status "${stat}", ps exit code ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}`, seen: { status: stat } }
    }
    case 'waitForSeconds':
      return { isOver: (await $.clock.now()) - startedAt >= Number(a.secs) * 1000, detail: `${String(a.secs)} s have passed.` }
    default: {
      const r = await waitRun($, ['bash', '-c', text(a, 'shell_command')], root, untilMs)
      return { isOver: r.exitCode === 0, detail: `exit code ${r.exitCode}${r.stdout.trim() || r.stderr.trim() ? `: ${(r.stderr.trim() || r.stdout.trim()).slice(-400)}` : ''}`, seen: { 'exit code': String(r.exitCode), said: shownValue('said', r.stderr.trim() || r.stdout.trim()) } }
    }
  }
}

export const isStaleWrite = (error: unknown) => error instanceof Error && error.message.includes('set-workflow exited 5')

// A save of a record that another writer changed first exits 5 and changes nothing. The change is read and made again.
// After the last try the error names the record and both revisions, and its repair.
async function retryStale<T>($: EngineInterface, step: () => Promise<T>, deadline?: TurnDeadline): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await inFreeTurn($, step, deadline)
    } catch (error) {
      if (tries >= 3 || !isStaleWrite(error)) throw error
    }
  }
}

// The record that a wait is on. The agent can go to another issue during the wait, so a wait names its own record.
type WaitWho = { issue: number; pr?: number }
const WAIT_RECORD_READS = 3
class WaitRecordLost extends Error {}

const readWaitRecord = ($: EngineInterface, root: string, who: WaitWho) => (who.pr ? loadPrRecord($, root, who.pr) : loadWorkflow($, root, who.issue))

// A plugin update or a move of the record can hide it for a moment, so a missing record is read again before the wait fails.
async function waitRecord($: EngineInterface, root: string, who: WaitWho): Promise<Workflow> {
  for (let reads = 1; ; reads += 1) {
    const wf = await readWaitRecord($, root, who)
    if (wf) return wf
    if (reads >= WAIT_RECORD_READS) break
    await run($, ['sleep', '1'], { cwd: root, timeoutMs: 11_000 })
  }
  const there = async (name: string) => `${name} ${(await $.fs.exists(`${root}/${name}`)) ? 'exists' : 'is absent'}`
  const held = await readEffective($, root).then(all => (all.length ? all.map(labelOf).join(', ') : 'none'), (e: unknown) => `unreadable: ${e instanceof Error ? e.message : String(e)}`)
  throw new WaitRecordLost(`the workflow record of ${who.pr ? `PR #${who.pr} (issue #${who.issue})` : `issue #${who.issue}`} was not found in ${root} after ${WAIT_RECORD_READS} reads: ${await there('.neil-dev.worktree.json')}, ${await there(interviewFileName(who.issue))}, and the records read there are: ${held}. A plugin update can leave this session on older code that reads another layout, so a new session may read it. Repair: call started with issue ${who.issue}.`)
}

// Only the main agent can call a wait tool, so at the end of its turn a record of this session in "wait"
// has no holder, unless the wait tool still runs. After an interrupt the host goes on without the hook, and
// the wait tool may never run again, so `isOver` ends a running wait too. Its late code finds the wait over.
export async function endDeadWaits($: EngineInterface, project: LoadedConfig | undefined, isOver: boolean): Promise<void> {
  const root = (await read($, workflowRoot)) ?? project?.root
  if (!root) return
  const session = await $.session.id()
  // An agent that went to another issue during the wait released this record, and the wait is still its own.
  const isOurs = (wf: Workflow) => wf.owner?.session === session || (!wf.owner && wf.lastSession === session)
  const isDead = (wf: Workflow) => wf.state === 'wait' && isOurs(wf) && (isOver || !wf.waiting || !isWaitRunning(wf.waiting.id))
  // Each record: a PR back with its developers can hold a wait that no issue record shows.
  const records = async () => {
    const { issues, prs } = await readHeld($, root)
    return [...issues, ...prs]
  }
  // Only the waits of the turn that ended: a new turn can start a wait while this hook waits for the queue.
  const ended = new Set((await records()).filter(isDead).map(wf => wf.waiting?.id))
  if (!ended.size) return
  for (let tries = 1; ; tries += 1) {
    await whenTurnsFree($)
    try {
      const problems = await inTurn(async () => {
        const notes: string[] = []
        for (const wf of (await records()).filter(wf => isDead(wf) && ended.has(wf.waiting?.id))) {
          if (wf.waiting) activeWaits.delete(wf.waiting.id)
          const failed = wf.waiting?.alert && (await withdrawAlert($, root, wf.waiting.alert))
          if (failed) notes.push(failed)
          // Model: models/workflow/issue_workflow.qnt#waitEnds
          moved(wf, 'waitAbandoned', { state: wf.previous ?? 'developing' }, await $.clock.now())
          await saveWorkflow($, wf)
        }
        return notes
      })
      if (problems.length) await $.ui.toast(`ndev: the notice of an ended wait stays on screen: ${problems.join(' ')}`)
      return
    } catch (error) {
      if (tries >= 3 || !isStaleWrite(error)) throw error
    }
  }
}

// Whether the record still holds this wait. It reads and does not take a human's answer.
async function waitGoesOn($: EngineInterface, root: string, who: WaitWho, id: string): Promise<boolean> {
  const wf = await waitRecord($, root, who)
  if (wf.state !== 'wait' || wf.waiting?.id !== id) return false
  // The owner stays live through a long wait, or another session could take the workflow over.
  // A busy queue or a lost write only puts this off until the next slice.
  const now = await $.clock.now()
  if (wf.owner && now - wf.owner.at > OWNER_LIVE_MS / 2 && !turnsQueued) {
    await inTurn(async () => {
      const fresh = await readWaitRecord($, root, who)
      if (fresh?.owner && fresh.state === 'wait' && fresh.waiting?.id === id) {
        fresh.owner = { ...fresh.owner, at: now }
        await saveWorkflow($, fresh)
      }
    }).catch((error: unknown) => {
      if (!isStaleWrite(error)) throw error
    })
  }
  return true
}

// Ends the wait in one step: the state goes back, or the human's answer is taken if a human came first.
// The wait's time includes this. Past untilMs it does not wait for the queue: the save refuses a record that another writer changed.
// Model: models/workflow/issue_workflow.qnt#waitEnds
async function waitEnds($: EngineInterface, c: Ctx, root: string, who: WaitWho, id: string, label: string, untilMs: number): Promise<string> {
  for (let tries = 1; ; tries += 1) {
    try {
      const end = async () => {
        const wf = await waitRecord($, root, who)
        const isHeld = wf.state === 'wait' && wf.waiting?.id === id
        const given = wf.waitAnswer?.id === id ? wf.waitAnswer.message : undefined
        if (isHeld) moved(wf, label, { state: wf.previous ?? 'developing' }, await $.clock.now())
        if (given !== undefined) wf.waitAnswer = undefined
        if (isHeld || given !== undefined) await saveWorkflow($, wf)
        const said = given ? `The human ended the wait and says: ${given}\n` : isHeld ? '' : `A human moved the workflow to the state "${wf.state}", so the wait ended.\n`
        return said + (await answer($, wf, await factsFor($, wf.root, c.project, wf)))
      }
      const expired = new Error('The wait reached its ending deadline')
      try {
        return await inFreeTurn($, end, { untilMs, expired })
      } catch (error) {
        if (error !== expired) throw error
        return await end()
      }
    } catch (error) {
      if (tries >= 3 || !isStaleWrite(error)) throw error
    }
  }
}

type WaitLimits = { signal: AbortSignal; budget: { remainingMs: number } }

// Model: models/workflow/issue_workflow.qnt#agentHolds
async function waitTool($: EngineInterface, name: string, c: Ctx, limits: WaitLimits): Promise<string> {
  const spec = waitSpec(name, c.args)
  const attempts = name === 'waitForSeconds' ? Infinity : waitNumber(c.args, name, 'attempts', Infinity, true)
  const timeoutS = waitLimit(waitNumber(c.args, name, 'timeout', WAIT_MAX_S), name, 'timeout')
  if (name === 'waitForSeconds' && spec.period > timeoutS) throw new Refuse(`Refused: waitForSeconds cannot hold for ${spec.period} s with a timeout of ${timeoutS} s. Nothing changed. Repair: give secs of ${timeoutS} or less, or a longer timeout.`)
  const startedAt = await $.clock.now()
  const id = `${name}-${startedAt}`
  const deadline = startedAt + timeoutS * 1000
  // A set time runs no process and has its own end, so it keeps nothing back.
  const endMs = name === 'waitForSeconds' ? 0 : Math.min(WAIT_END_MS, timeoutS * 100)
  const checksEndAt = deadline - endMs
  const lastCheckAt = checksEndAt - endMs
  // A set time is not a retry, so waitForSeconds never raises the notice.
  const most = name === 'waitForSeconds' ? Infinity : Math.min(attempts, Math.ceil((lastCheckAt - startedAt) / (spec.period * 1000)) + 1)
  const expired = new Refuse(`${name} did not start its wait for ${spec.what}, because starting it or other tool calls used its timeout of ${timeoutS} s. Nothing changed. Repair: call it again when they end.`)
  const { root, live, who } = await retryStale($, async () => {
    const wf = await current($, c)
    if (name === 'waitForState' && issuesOf(wf).includes(Number(c.args.issue_id))) throw new Refuse(`Refused: waitForState cannot watch issue #${String(c.args.issue_id)}, because this agent is on it and its state stays "wait" while the wait holds it. Nothing changed. Repair: name another issue.`)
    legal(wf, 'wait', await factsFor($, wf.root, c.project, wf))
    wf.waiting = { id, tool: name, what: shownValue('what', spec.what), at: startedAt, period: spec.period, ...(Number.isFinite(most) ? { most } : {}), timeoutS, args: shownArgs(c.args) }
    wf.waitAnswer = undefined
    moved(wf, name, { state: 'wait', previous: wf.state }, startedAt)
    await saveWorkflow($, wf)
    return { root: wf.root, live: liveName(wf), who: { issue: wf.issue, pr: wf.pr } }
  }, { untilMs: checksEndAt, expired })
  activeWaits.add(id)
  let alert: { group: string; pid?: number } | undefined
  let problem: string | undefined
  const told = (result: string) => (problem ? `${result}\nNo persistent notification: ${problem}` : result)
  try {
    let tries = 0
    let last = ''
    const gaveUp = async () => new Refuse(`${name} gave up on ${spec.what} within its timeout of ${timeoutS} s, after ${tries} attempts. ${tries ? `The last check: ${last}` : 'No check ran, because starting the wait used up the time'}.${paceNote()} Repair: call it again, for at most ${WAIT_MAX_S} s more, or call blocked if only the human can go on.\n${await waitEnds($, c, root, who, id, 'waitGaveUp', deadline)}`)
    const pastHalf = async () => name !== 'waitForSeconds' && (tries * 2 > most || ((await $.clock.now()) - startedAt) * 2 > timeoutS * 1000)
    // The hook's own time that one wake of the loop costs, from the first pause on, sets how far apart the wakes
    // must be for the time left to last until the deadline. On a calm computer that is less than WAIT_SLICE_S.
    let wakes = 0
    let budgetAtFirstPause: number | undefined
    let longestPauseS = 0
    let widestGapS = 0
    const pacedMs = async () => {
      const left = limits.budget.remainingMs
      if (!Number.isFinite(left)) return 0
      budgetAtFirstPause ??= left
      const perWake = wakes ? (budgetAtFirstPause - left) / wakes : 0
      if (perWake <= 0) return 0
      // One wake more is kept back for the answer.
      const wakesLeft = Math.max(1, (left - WAIT_BUDGET_LOW_MS) / perWake - 1)
      return Math.min(WAIT_PAUSE_MAX_S * 1000, (deadline - (await $.clock.now())) / wakesLeft)
    }
    const paceNote = () => (longestPauseS > WAIT_SLICE_S
      ? `\nThe computer was busy, so each wake cost the hook more of its own ${HOOK_BUDGET_S} s time budget. To make it last, the wait paused for up to ${Math.round(longestPauseS)} s at a time${widestGapS > spec.period ? ` and checked every ${Math.round(widestGapS)} s, not every ${spec.period} s` : ''}, so /unblock could take that long to end it.`
      : '')
    for (;;) {
      if (!(await waitGoesOn($, root, who, id))) return told(await waitEnds($, c, root, who, id, name, deadline))
      if (limits.signal.aborted) throw new Refuse(`Refused: ${name} for ${spec.what} was interrupted.\n${await waitEnds($, c, root, who, id, 'waitInterrupted', deadline)}`)
      if (limits.budget.remainingMs < WAIT_BUDGET_LOW_MS) throw new Refuse(`${name} stopped its wait for ${spec.what} after ${tries} attempts and ${Math.round(((await $.clock.now()) - startedAt) / 1000)} s, because the host's time budget for one hook is nearly spent: ${Math.round(limits.budget.remainingMs)} ms are left of ${limits.budget.ms} ms. That budget is the hook's own running time, and a busy computer spends it sooner.${paceNote()} Repair: call ${name} again.\n${await waitEnds($, c, root, who, id, 'waitGaveUp', deadline)}`)
      // The time includes the checks, so none starts or runs past checksEndAt. waitForSeconds runs no process: its last check reads the clock.
      if (name !== 'waitForSeconds' && (await $.clock.now()) >= checksEndAt) throw await gaveUp()
      const check = await waitCheck($, name, c.args, root, startedAt, checksEndAt)
      tries += 1
      last = check.detail
      const checkedAt = await $.clock.now()
      const gapMs = Math.max(spec.period * 1000, await pacedMs())
      await writeLive($, root, live, l => ({ ...l, wait: { id, tries, checkedAt, nextAt: Math.min(lastCheckAt, checkedAt + gapMs), detail: shownValue('detail', check.detail), seen: check.seen } }))
      // A human can come during a check, which can last a minute. The answer goes first.
      if (!(await waitGoesOn($, root, who, id))) return told(await waitEnds($, c, root, who, id, name, deadline))
      if (check.isOver) return told(`The wait for ${spec.what} ended after ${tries} checks. ${check.detail}${paceNote()}\n${await waitEnds($, c, root, who, id, 'waitEnded', deadline)}`)
      if (tries < attempts && (await $.clock.now()) >= lastCheckAt) throw await gaveUp()
      if (tries < attempts && !alert && (await pastHalf())) {
        const raised = await waitAlert($, root, who, id, name, spec.what, tries, most, check.detail, checksEndAt)
        alert = raised.alert
        problem = raised.problem
      }
      if (tries >= attempts) throw new Refuse(`${name} gave up on ${spec.what} after ${tries} attempts. The last check: ${check.detail}. Repair: call it again with more attempts, or call blocked if only the human can go on.\n${await waitEnds($, c, root, who, id, 'waitGaveUp', deadline)}`)
      const nextAt = Math.min(lastCheckAt, (await $.clock.now()) + gapMs)
      widestGapS = Math.max(widestGapS, gapMs / 1000)
      for (let now = await $.clock.now(); now < nextAt; now = await $.clock.now()) {
        const secs = Math.min(Math.max(WAIT_SLICE_S * 1000, await pacedMs()), nextAt - now) / 1000
        longestPauseS = Math.max(longestPauseS, secs)
        await pause($, root, secs)
        wakes += 1
        // Each slice costs the hook some of its own time, and more on a busy computer. Past its budget the host
        // drops the hook, and the agent reads only "no tool.call hook answered this call". So the pause ends here,
        // and the top of the loop gives the answer.
        if (limits.signal.aborted || limits.budget.remainingMs < WAIT_BUDGET_LOW_MS || !(await waitGoesOn($, root, who, id))) break
      }
    }
  } catch (error) {
    if (error instanceof Refuse) throw error
    // An unexpected failure must not leave the record in "wait", and if it does, the agent is told.
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof WaitRecordLost) throw new Error(`${name} for ${spec.what}: ${message}`)
    const stuck = await waitEnds($, c, root, who, id, 'waitFailed', deadline).then(() => '', (e: unknown) => ` The state stays "wait", because going back also failed: ${e instanceof Error ? e.message : String(e)}. Repair: the human types /unblock <message>, or call started.`)
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
async function waitAlert($: EngineInterface, root: string, who: WaitWho, id: string, name: string, what: string, tries: number, most: number, last: string, untilMs: number): Promise<{ alert?: { group: string; pid?: number }; problem?: string }> {
  const { issue } = who
  const raised = await raiseAlert($, root, issue, `${name} for ${what} has run ${tries} of ${most} checks. Last: ${last} /unblock ends the wait.`, `ndev: #${issue}: a wait is past half its retries`)
  const alert = { group: raised.group, pid: raised.pid }
  // The record lets a later session withdraw the notice if this process dies. It does not hold the wait past its time.
  const expired = new Error('The wait alert reached its deadline')
  try {
    await retryStale($, async () => {
      const wf = await readWaitRecord($, root, who)
      if (wf?.waiting?.id === id) {
        wf.waiting.alert = alert
        await saveWorkflow($, wf)
      }
    }, { untilMs, expired })
  } catch (error) {
    if (error !== expired) throw error
  }
  return { alert, problem: raised.problem }
}

export async function noteSessionHuman($: EngineInterface, isInteractive: boolean) {
  await update($, sessionHasHuman, () => isInteractive)
}

// Whether the session started with a person at it, as noteSessionHuman recorded.
export async function sessionHuman($: EngineInterface): Promise<boolean> {
  return read($, sessionHasHuman)
}

// ---- The interview ----
// A round holds the tool call, as a wait does, so the agent stays blocked and spends nothing. The pane
// changes its atom; this loop reads the atom, saves the draft, and acts on the outcome.
const activeInterviews = new Set<number>()
export const isInterviewRunning = (issue: number) => activeInterviews.has(issue)
const interviewPath = (root: string, issue: number) => `${root}/${interviewFileName(issue)}`
const handOverPath = (common: string, issue: number) => `${common}/ndev-interview-handover-${issue}.json`

async function readInterview($: EngineInterface, root: string, issue: number): Promise<InterviewFile> {
  const path = interviewPath(root, issue)
  if (!(await $.fs.exists(path))) return emptyFile(issue)
  try {
    return interviewOnly(issue, JSON.parse(await $.fs.read(path)) as object)
  } catch (error) {
    throw new Refuse(`Refused: ${path} is not valid JSON (${String(error).slice(0, 160)}). Nothing changed. Repair: fix the file, then call interview again.`)
  }
}
// Through the script, under the lock of the issue file, because the workflow is in that file too.
async function writeInterview($: EngineInterface, root: string, file: InterviewFile): Promise<void> {
  const expected = file.interviewRev ?? 0
  const r = await run($, ['bash', envScript($), 'set-interview', '--worktree', root, '--expect-rev', String(expected)], { cwd: root, stdin: JSON.stringify(file) })
  if (r.exitCode !== 0) throw new Error(`${interviewPath(root, file.issue)} was not saved: set-interview exited ${r.exitCode}: ${said(r)}`)
  file.interviewRev = expected + 1
}

// The file stays out of commits, in the exclude file that all worktrees share. A failure is a note,
// because checkpoint commits only the files that it names.
async function excludeInterviewFiles($: EngineInterface, root: string, common: string | undefined): Promise<string[]> {
  if (!common) return [`${INTERVIEW_FILE_PATTERN} is not in the git exclude file: git rev-parse --git-common-dir failed in ${root}. Do not commit these files.`]
  const path = `${common}/info/exclude`
  try {
    const was = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    if (!was.split('\n').includes(INTERVIEW_FILE_PATTERN)) await $.fs.write(path, `${was}${was && !was.endsWith('\n') ? '\n' : ''}${INTERVIEW_FILE_PATTERN}\n`)
    return []
  } catch (error) {
    return [`${INTERVIEW_FILE_PATTERN} is not in ${path}: ${error instanceof Error ? error.message : String(error)}. Do not commit these files.`]
  }
}

// A parent's followUp left its answers in the shared git folder, because the child's worktree does not exist then.
async function prepareInterview($: EngineInterface, root: string, issue: number): Promise<string[]> {
  const common = await commonDir($, root, root)
  const notes = await excludeInterviewFiles($, root, common)
  if (!common || !(await $.fs.exists(handOverPath(common, issue)))) return notes
  const path = handOverPath(common, issue)
  try {
    const handed = JSON.parse(await $.fs.read(path)) as { followUpOf: number; at: number; files: { name: string; text: string }[] }
    for (const f of handed.files) {
      const n = Number(/\d+/.exec(f.name)?.[0])
      await writeInterview($, root, { ...interviewOnly(n, JSON.parse(f.text) as object), interviewRev: (await readInterview($, root, n)).interviewRev })
    }
    const own = await readInterview($, root, issue)
    if (!own.rounds.length && !own.startedByFollowUp) await writeInterview($, root, { ...own, startedByFollowUp: { of: handed.followUpOf, at: handed.at } })
    const removed = await run($, ['rm', '-f', path], { cwd: root })
    if (removed.exitCode !== 0) notes.push(`${path} stays: rm exited ${removed.exitCode}: ${said(removed)}`)
  } catch (error) {
    throw new Refuse(`Refused: the interview hand-over ${path} did not reach ${root}: ${error instanceof Error ? error.message : String(error)}. Nothing changed. Repair: fix the cause and call started again, or delete the file to start with no answers.`)
  }
  return notes
}

async function handOverInterviews($: EngineInterface, wf: Workflow, children: number[]): Promise<string[]> {
  const common = await commonDir($, wf.root, wf.root)
  if (!common) throw new Refuse(`Refused: git rev-parse --git-common-dir failed in ${wf.root}, so the interview answers cannot reach the worker. Nothing changed. Repair: fix the worktree, then call followUp again.`)
  const files: { name: string; text: string }[] = []
  const held = await readHeld($, wf.root)
  for (const n of new Set([wf.issue, ...held.issues.map(o => o.issue), ...held.interviews.map(o => o.issue)])) {
    const path = interviewPath(wf.root, n)
    if (!(await $.fs.exists(path))) continue
    try {
      const inFile = JSON.parse(await $.fs.read(path)) as object
      if ('rounds' in inFile) files.push({ name: interviewFileName(n), text: JSON.stringify(interviewOnly(n, inFile)) })
    } catch (error) {
      throw new Refuse(`Refused: the interview file ${path} cannot be read, so its answers cannot reach the worker: ${error instanceof Error ? error.message : String(error)}. No worker started. Repair: fix the file, then call followUp again with the same text.`)
    }
  }
  const at = await $.clock.now()
  for (const child of children) {
    const path = handOverPath(common, child)
    try {
      await $.fs.write(path, JSON.stringify({ followUpOf: wf.issue, at, files }))
    } catch (error) {
      throw new Refuse(`Refused: the interview answers for #${child} were not written to ${path}: ${error instanceof Error ? error.message : String(error)}. No worker started. Repair: fix the cause, then call followUp again with the same text.`)
    }
  }
  return files.map(f => f.name)
}

// One comment on the issue and one on the PR, edited in place. The file holds what they could not show.
async function postInterview($: EngineInterface, wf: Workflow, file: InterviewFile): Promise<string[]> {
  const body = `${MARKER}\n${commentBody(file)}`
  const problems: string[] = []
  const ids = { ...file.commentIds }
  const targets: ['issue' | 'pr', number | undefined][] = [['issue', file.issue], ['pr', wf.prs[0]]]
  for (const [key, n] of targets) {
    if (n === undefined) continue
    const id = ids[key]
    const post = async () => {
      const url = await comment($, wf.root, wf.repo, n, body)
      const found = /#issuecomment-(\d+)/.exec(String(url))
      if (!found) throw new Error(`it printed no comment URL: ${JSON.stringify(String(url).slice(0, 200))}`)
      ids[key] = Number(found[1])
      if (key === 'pr') ids.prNumber = n
    }
    try {
      if (id) {
        // A comment that someone deleted cannot be edited, so it goes up again. Any other failure stays a failure.
        await gh($, wf.root, wf.repo, ['comment-edit', String(id), '--body', body]).catch((error: unknown) => {
          if (!/HTTP 404|Not Found/i.test(error instanceof Error ? error.message : String(error))) throw error
          return post()
        })
      } else {
        await post()
      }
    } catch (error) {
      problems.push(`scripts/github/gh.sh ${id ? `comment-edit ${id}` : `comment ${n}`} for the interview on #${n} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!wf.direct && !wf.prs[0] && !wf.prTitle) problems.push(`#${wf.issue} has no PR yet, so the interview is not on a PR. Repair: call started with issue ${wf.issue}: it opens the draft PR. Then call interview with no arguments.`)
  file.commentIds = ids
  file.posted = !problems.length
  await writeInterview($, wf.root, file)
  return problems
}

// interview() with no arguments: the only way out of the state.
// A reload ends a hold and leaves its notification and its pane on screen. Each way out of the
// interview that does not come through the hold comes through here. A live hold closes its own pane.
export async function endAsking($: EngineInterface, wf: Workflow): Promise<string[]> {
  if (!wf.asking) return []
  const notes: string[] = []
  const failed = await withdrawAlert($, wf.root, wf.asking)
  if (failed) notes.push(`The interview notification stays on screen: ${failed}`)
  wf.asking = undefined
  if (!interviewCall()) await closeInterviewPane($).catch((e: unknown) => { notes.push(`The interview pane stays open: ${e instanceof Error ? e.message : String(e)}`) })
  return notes
}

// What goes to GitHub goes before the state moves, so that a failure leaves the issue where it can retry.
async function closeInterviewFile($: EngineInterface, wf: Workflow, file: InterviewFile, retry = 'call this tool again') {
  if (file.rounds.length && !file.posted) {
    const failed = await postInterview($, wf, file)
    if (failed.length) throw new Refuse(`Refused: the interview is not on GitHub, so #${wf.issue} stays in "${wf.state}". ${failed.join(' ')} Repair: fix the cause, then ${retry}.`)
  }
  file.draft = undefined
  file.chatRound = undefined
  file.closed = { at: await $.clock.now(), asked: answeredRounds(file) > 0 }
  await writeInterview($, wf.root, file)
}

export async function closeInterviewForHuman($: EngineInterface, wf: Workflow, retry: string) {
  await closeInterviewFile($, wf, await readInterview($, wf.root, wf.issue), retry)
}

// Model: models/workflow/issue_workflow.qnt#leaveInterview
async function leaveInterview($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  legal(wf, 'interview', facts)
  const showing = interviewCall()
  if (showing) throw new Refuse(`Refused: the interview pane still shows the round "${showing.round.title}" for #${showing.issue}, and its answers would arrive after the interview. Nothing changed. Repair: wait until the human submits or closes the round, then call interview with no arguments.`)
  const file = await readInterview($, wf.root, wf.issue)
  const problem = exitProblem(file, facts)
  if (problem) throw new Refuse(`Refused: ${problem} Nothing changed.`)
  const dropped = file.chatRound
  await closeInterviewFile($, wf, file)
  const notes = await endAsking($, wf)
  if (dropped) notes.push(`The chat round "${dropped.title}" had no answers, and it is dropped. Tell the human that its questions are no longer open.`)
  const asked = !!file.closed?.asked
  await move($, c, wf, 'interview', facts, asked ? 'interview' : 'interview: no questions asked')
  // Light goes straight to development, so the base check runs here. Heavy runs it in finishedPlan.
  if (wf.state === 'developing' && !isBaseChecked(wf, facts.mode)) notes.push(...(await runBaseCheck($, wf, facts)).notes)
  await saveWorkflow($, wf)
  return answer($, wf, facts, [asked ? `The answers are in ${interviewPath(wf.root, wf.issue)}.` : 'No questions asked.', ...notes])
}

// Model: models/workflow/issue_workflow.qnt#setAuto
async function setSteering($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  if (facts.mode === 'hack') throw new Refuse(`Refused: ${labelOf(wf)} is in hack mode, which is interactive only, because a human steers each step of the hack. The steering stays interactive. Nothing changed. Repair: if no human can answer, call blocked; the human can set /flow mode light ${wf.issue} and then steering can go to auto.`)
  if (text(c.args, 'steering') !== 'auto') throw new Refuse(`Refused: an agent can only set steering to auto, and it got ${JSON.stringify(c.args.steering)}. Only a human sets it back, with /flow steering interactive. Nothing changed.`)
  const reason = text(c.args, 'reason')
  if (!reason) throw new Refuse('Refused: setSteering needs a reason: why no human can answer in this session. A preference is not a reason. Nothing changed.')
  legal(wf, 'setAuto', facts)
  const notes: string[] = []
  if (wf.state === 'interviewing' || wf.previous === 'interviewing') {
    await closeInterviewFile($, wf, await readInterview($, wf.root, wf.issue))
    notes.push(...(await endAsking($, wf)))
  }
  wf.steering = 'auto'
  const after = { ...facts, steering: 'auto' as const }
  await move($, c, wf, 'setAuto', after, 'setSteering')
  await saveWorkflow($, wf)
  const body = `${MARKER}\nThe agent set the steering of #${wf.issue} to auto: ${reason}`
  for (const n of [wf.issue, ...wf.prs.slice(0, 1)]) {
    try {
      await comment($, wf.root, wf.repo, n, body)
    } catch (error) {
      notes.push(`The reason did not reach #${n}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  $.ui.notify(reason, { title: `ndev: #${wf.issue} is now on auto steering` })
  return answer($, wf, after, notes)
}

// Orca Chat shows no pane, and a human answers there in the chat. So the round goes back to the agent as Markdown
// to post, and the file keeps it until interview(answersJson) records the human's answers.
// Model: models/workflow/issue_workflow.qnt#askRound
async function askInChat($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  legal(wf, 'interview', facts)
  if (facts.steering === 'auto') throw new Refuse('Refused: this issue is on auto steering, so no human answers an interview. Nothing changed. Call interview with no arguments to go on.')
  const file = await readInterview($, wf.root, wf.issue)
  const parsed = parseRound(c.args.interviewJson, file, facts.mode)
  if ('problems' in parsed) throw new Refuse(`Refused: this round cannot be asked. Nothing changed.\n${parsed.problems.map(p => `- ${p}`).join('\n')}`)
  const replaced = file.chatRound
  await writeInterview($, wf.root, { ...file, chatRound: parsed.round })
  return [
    `This session is in Orca Chat, which shows no interview pane. Post the round below to the human in the chat as it is, in Markdown, and end your turn to wait for the reply. Then call interview with answersJson: one entry for each question id, as { "<id>": { "selected": ["<option label>"], "other": "<the human's own words>", "notes": "<notes>" } }. Record only what the human said. If the human leaves a question to you, record your recommendation only when the human accepts it.${replaced ? ` The open round "${replaced.title}" had no answers, and this one replaces it.` : ''}`,
    '',
    roundMarkdown(parsed.round, file),
  ].join('\n')
}

// interview(answersJson): the human's chat answers to the open chat round go into the file and both comments.
// Model: models/workflow/issue_workflow.qnt#chatAnswers
async function recordChatAnswers($: EngineInterface, c: Ctx): Promise<string> {
  const wf = await current($, c)
  const facts = await factsFor($, wf.root, c.project, wf)
  legal(wf, 'interview', facts)
  const path = interviewPath(wf.root, wf.issue)
  const file = await readInterview($, wf.root, wf.issue)
  const round = file.chatRound
  if (!round) throw new Refuse(`Refused: #${wf.issue} has no chat round open (no chatRound in ${path}), so answersJson has nothing to answer. Nothing changed. Repair: call interview with interviewJson in an Orca Chat session, post the round to the human, then call interview with answersJson.`)
  const parsed = parseChatAnswers(c.args.answersJson, round)
  if ('problems' in parsed) throw new Refuse(`Refused: these answers to the round "${round.title}" cannot be recorded. Nothing changed, and the round stays open.\n${parsed.problems.map(p => `- ${p}`).join('\n')}`)
  const done = finishRound(round, parsed.answers, 'submitted', await $.clock.now())
  const next: InterviewFile = { ...file, rounds: [...file.rounds, done], chatRound: undefined, posted: false }
  try {
    await writeInterview($, wf.root, next)
  } catch (error) {
    throw new Refuse(`Refused: the answers did not reach ${path}: ${error instanceof Error ? error.message : String(error)}. The round stays open. Repair: fix the cause, then call interview again with the same answersJson.`)
  }
  const failed = await postInterview($, wf, next)
  return [JSON.stringify(resultOf(done, round)), ...failed, ...(failed.length ? ['The answers are safe in the file, and the exit call refuses until both comments are posted.'] : []), 'Ask the next round, or call interview with no arguments when no decision is open.', await answer($, wf, facts)].join('\n')
}

// Model: models/workflow/issue_workflow.qnt#askRound
async function askInterview($: EngineInterface, c: Ctx, limits: WaitLimits): Promise<string> {
  if (c.args.answersJson !== undefined) throw new Refuse('Refused: interview takes interviewJson or answersJson, not both. Nothing changed. Repair: record the answers of the open round with answersJson first, then ask the next round with interviewJson.')
  await whenTurnsFree($)
  if (await isOrcaChat($)) return inTurn(() => askInChat($, c))
  const at = await $.clock.now()
  const id = `interview-${at}`
  const { root, issue, round, warnings } = await inTurn(async () => {
    const wf = await current($, c)
    const facts = await factsFor($, wf.root, c.project, wf)
    legal(wf, 'interview', facts)
    if (facts.steering === 'auto') throw new Refuse('Refused: this issue is on auto steering, so no human answers an interview. Nothing changed. Call interview with no arguments to go on.')
    if (!(await read($, sessionHasHuman))) throw new Refuse('Refused: this session has no human to answer: it started as not interactive (claude -p or an SDK session), and it is not Orca Chat (ORCA_STRUCTURED_SESSION and ORCA_CHAT_SCRATCH_DIR are not set), so neither a pane nor the chat can show the round. Nothing changed. Repair: if no human is there, call setSteering with steering "auto" and the reason. If a human does answer in this session, call reportWorkflowBug and say how the session runs.')
    const showing = interviewCall()
    if (showing) throw new Refuse(`Refused: an interview round for #${showing.issue} is already open, and the pane shows one round at a time. Wait for its answers, then call interview again. Nothing changed.`)
    const file = await readInterview($, wf.root, wf.issue)
    const parsed = parseRound(c.args.interviewJson, file, facts.mode)
    if ('problems' in parsed) throw new Refuse(`Refused: this round cannot show. Nothing changed.\n${parsed.problems.map(p => `- ${p}`).join('\n')}`)
    const earlier: EarlierQuestion[] = file.rounds.flatMap(r => r.questions.map(q => {
      const a = r.answers.find(x => x.id === q.id)
      return { id: q.id, question: q, answer: a ? answerText(a) : 'no answer', notes: a?.notes }
    }))
    await writeInterview($, wf.root, file)
    const left = await endAsking($, wf)
    const message = `#${wf.issue} has interview questions for you: ${parsed.round.title}`
    const alert = await raiseAlert($, wf.root, wf.issue, message, `ndev: #${wf.issue} has questions`)
    try {
      $.ui.notify(message, { title: `ndev: #${wf.issue} has questions` })
      wf.asking = { at, group: alert.group, pid: alert.pid }
      await saveWorkflow($, wf)
      activeInterviews.add(wf.issue)
      await showInterview($, { id, issue: wf.issue, round: parsed.round, answers: startingAnswers(parsed.round, file.draft), index: 0, stage: 'question', earlier })
    } catch (error) {
      // No hold starts, so nothing later lets go of these.
      activeInterviews.delete(wf.issue)
      await clearInterview($)
      const failed = await withdrawAlert($, wf.root, { at, group: alert.group, pid: alert.pid })
      const fresh = await loadWorkflow($, wf.root, wf.issue)
      if (fresh?.asking?.at === at) {
        fresh.asking = undefined
        await saveWorkflow($, fresh)
      }
      if (failed) throw new Error(`${error instanceof Error ? error.message : String(error)}. Also, the interview notification stays on screen: ${failed}`)
      throw error
    }
    return { root: wf.root, issue: wf.issue, round: parsed.round, warnings: [...left, ...(alert.problem ? [`No persistent notification: ${alert.problem}`] : [])] }
  })
  // Each way out of the hold comes through here: the notification goes, and the record stops asking.
  // A failure here is a warning: the round has its result, and an error would lose it.
  const release = async () => {
    activeInterviews.delete(issue)
    await clearInterview($).catch((e: unknown) => { warnings.push(`The interview pane did not clear: ${e instanceof Error ? e.message : String(e)}`) })
    await closeInterviewPane($).catch((e: unknown) => { warnings.push(`The interview pane stays open: ${e instanceof Error ? e.message : String(e)}`) })
    await whenTurnsFree($)
    await inTurn(async () => {
      const wf = await loadWorkflow($, root, issue)
      if (!wf?.asking) return
      const failed = await withdrawAlert($, root, wf.asking)
      if (failed) warnings.push(`The notification stays on screen: ${failed}`)
      wf.asking = undefined
      await saveWorkflow($, wf)
    }).catch((e: unknown) => { warnings.push(`The record of #${issue} still says that a round is open, and the next call clears it: ${e instanceof Error ? e.message : String(e)}`) })
  }
  try {
    const placed = await openInterviewPane($)
    if (!placed.isPlaced) $.ui.notify('The interview pane waits for a wider terminal. Make this terminal at least 110 columns wide.', { title: `ndev: #${issue} has questions` })
    let saved = ''
    for (;;) {
      const call = interviewCall()
      if (call?.id !== id) throw new Refuse('Refused: another interview round took the pane, and this one ended unanswered. Call interview again with this round.')
      // Before the outcome too, so that the answers outlive a failure while the round ends.
      const draft = JSON.stringify(call.answers)
      if (draft !== saved) {
        const file = await readInterview($, root, issue)
        await writeInterview($, root, { ...file, draft: call.answers })
        saved = draft
      }
      // Model: models/workflow/issue_workflow.qnt#paneEnds
      if (call.outcome) {
        const outcome = call.outcome
        const answers = call.answers
        await whenTurnsFree($)
        const reply = await inTurn(async () => {
          const wf = await loadWorkflow($, root, issue)
          if (!wf) throw new Error(`the workflow of #${issue} is gone from ${root}`)
          const facts = await factsFor($, root, c.project, wf)
          const file = await readInterview($, root, issue)
          const done = finishRound(round, answers, outcome, await $.clock.now())
          // Model: models/workflow/issue_workflow.qnt#paneAbandoned
          if (wf.state !== 'interviewing' || (file.closed && file.closed.at >= at)) {
            await writeInterview($, root, { ...file, draft: undefined })
            const given = done.answers.length ? ` They were: ${JSON.stringify(resultOf(done, round))}.` : ''
            return `The human moved #${issue} out of the interview before this round ended, so its answers are not recorded as an interview round and do not go to GitHub. The state is now "${wf.state}".${given} Read status for the next step.`
          }
          if (done.answers.length) {
            file.rounds.push(done)
            file.posted = false
          }
          file.draft = undefined
          try {
            await writeInterview($, root, file)
          } catch (error) {
            throw new Refuse(`Refused: the answers did not reach ${interviewPath(root, issue)}: ${error instanceof Error ? error.message : String(error)}. They are saved as its draft. Repair: fix the cause, then call interview again with the same round, and the pane restores them.`)
          }
          const failed = done.answers.length ? await postInterview($, wf, file) : []
          const after = outcome === 'trustMeBro' ? 'The human chose Trust Me Bro: ask no more questions. State each remaining decision as an assumption, then call interview with no arguments.'
            : outcome === 'dismissed' ? 'The human closed the pane. The state stays "interviewing". Ask again later, or call blocked if only the human can go on.'
              : 'Ask the next round, or call interview with no arguments when no decision is open.'
          return [JSON.stringify(resultOf(done, round)), ...failed, ...(failed.length ? ['The answers are safe in the file, and the exit call refuses until both comments are posted.'] : []), after, await answer($, wf, facts)].join('\n')
        })
        await release()
        return [reply, ...warnings].join('\n')
      }
      const wf = await loadWorkflow($, root, issue)
      // Model: models/workflow/issue_workflow.qnt#paneAbandoned
      if (wf?.state !== 'interviewing') {
        await release()
        return `The human moved #${issue} to the state "${wf?.state ?? 'unknown'}" while the round was open, so this round ended unanswered. Read status for the next step.`
      }
      // The owner stays live while the human thinks, or another session could take the workflow over.
      const now = await $.clock.now()
      if (wf.owner && now - wf.owner.at > OWNER_LIVE_MS / 2 && !turnsQueued) {
        await inTurn(async () => {
          const fresh = await loadWorkflow($, root, issue)
          if (fresh?.owner && fresh.state === 'interviewing') {
            fresh.owner = { ...fresh.owner, at: now }
            await saveWorkflow($, fresh)
          }
        }).catch((error: unknown) => {
          if (!isStaleWrite(error)) throw error
        })
      }
      if (limits.signal.aborted) throw new Refuse('Refused: the interview round was interrupted. The answers so far are saved. Repair: call interview again with the same round, and the pane restores them.')
      if (limits.budget.remainingMs < WAIT_BUDGET_LOW_MS) throw new Refuse("Refused: the host's time budget for one hook is nearly spent. The answers so far are saved. Repair: call interview again with the same round, and the pane restores them.")
      await pause($, root, WAIT_SLICE_S)
    }
  } catch (error) {
    await release()
    throw error
  }
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
// With untilMs it stops there and answers false, for a caller whose own time is limited.
export async function whenTurnsFree($: EngineInterface, untilMs?: number): Promise<boolean> {
  while (turnsQueued) {
    if (untilMs !== undefined && (await $.clock.now()) >= untilMs) return false
    await $.process.run(['sleep', '0.2'])
  }
  return true
}

type TurnDeadline = { untilMs: number; expired: Error }

export async function inFreeTurn<T>($: EngineInterface, fn: () => Promise<T>, deadline?: TurnDeadline): Promise<T> {
  do {
    if (!(await whenTurnsFree($, deadline?.untilMs))) throw deadline!.expired
    if (deadline && (await $.clock.now()) >= deadline.untilMs) throw deadline.expired
  } while (turnsQueued)
  return inTurn(fn)
}

// Each state tool call shows in the /view pane, with its arguments and how it ended.
function workflowTarget(tool: string, args: Args): { name: string; label: string } | undefined {
  const valid = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value !== '') && Number.isSafeInteger(Number(value)) && Number(value) > 0
  if (tool !== 'waitForPR' && !tool.startsWith('epic') && valid(args.pr)) return { name: `pr-${Number(args.pr)}`, label: `PR #${Number(args.pr)}` }
  const issues = Array.isArray(args.issues) ? args.issues : [args.issue]
  if (!issues.length || !issues.every(valid)) return undefined
  return { name: `issue-${Number(issues[0])}`, label: issues.length === 1 ? `issue #${Number(issues[0])}` : `issues ${issues.map(n => '#' + Number(n)).join(', ')}` }
}

async function liveStart($: EngineInterface, tool: string, args: Args, project: LoadedConfig | undefined): Promise<{ root: string; name: string; at: number } | undefined> {
  if (tool === 'status' || project?.config.workflow === false) return undefined
  const target = workflowTarget(tool, args)
  const root = text(args, 'worktree') || (await boundRoot($)) || project?.root
  if (!root || !target) return undefined
  return { root, name: target.name, at: await liveCallStart($, root, target.name, tool, args) }
}

async function liveEnd($: EngineInterface, logged: { root: string; name: string; at: number } | undefined, tool: string, outcome: 'ok' | 'refused' | 'failed', result: string): Promise<void> {
  if (logged) await liveCallEnd($, logged.root, logged.name, tool, logged.at, outcome, result)
}

type FailureScope = { root?: string; issue?: number | null; error?: string }
const failureRepairs = new Map(SPECS.map(s => [s.name, 'status']))
export function registerWorkflowFailure(name: string, recovery: string): void {
  failureRepairs.set(name, recovery)
}

const HOOK_BUDGET_S = 10
// What each workflow tool call in flight does now, so that the answer for a lost hook can say it. An entry goes
// when its call answers.
const callsNow = new Map<string, 'waiting' | 'running'>()
export function workflowToolLost(tool: string, error: { kind: string; message?: string }, args: Args = {}): { result: string; isError: true } | undefined {
  const name = tool.startsWith('mcp__ndev__') ? tool.slice('mcp__ndev__'.length) : ''
  const recovery = failureRepairs.get(name)
  if (!recovery) return undefined
  const context = workflowTarget(name, args)
  const target = context ? ` for ${context.label}` : ''
  const cause = error.kind === 'timeout'
    ? `its hook ran past the host's time budget for one hook (${HOOK_BUDGET_S} s of its own running time, which a busy computer spends sooner)${error.message ? `: ${error.message}` : ''}`
    : `its hook failed outside its own error handling: ${error.message ?? 'no message'}`
  const now = callsNow.get(name)
  callsNow.delete(name)
  const holder = runningNow()
  const doing = now === 'waiting' ? ` It was waiting for its turn${holder ? ` behind ${holder}` : ''}: workflow tool calls run one at a time.` : now === 'running' ? ` It had its turn and was running${holder ? ` (${holder})` : ''}.` : ''
  return { result: `workflow ${name} gave no answer${target}, because ${cause} (kind=${error.kind}).${doing} The call may have stopped part way, so the workflow record can show a step that did not finish. Repair: call ${recovery} and read the state, then call ${name} again. If it fails again when the computer is not busy, call reportWorkflowBug with this message.`, isError: true }
}

const failedCalls = new WeakMap<object, Awaited<ReturnType<typeof liveStart>>>()

export async function workflowToolFailed($: EngineInterface, tool: string, error: { kind: string; message?: string }, args: Args, scope?: FailureScope | null): Promise<{ result: string; isError: true } | undefined> {
  const name = tool.startsWith('mcp__ndev__') ? tool.slice('mcp__ndev__'.length) : ''
  if (!failureRepairs.has(name)) return undefined
  const logged = failedCalls.get(args)
  failedCalls.delete(args)
  let context = args
  let contextFailure = scope?.error ? ` The bound issue could not be read: ${scope.error}.` : ''
  if (!workflowTarget(name, args)) {
    if (scope?.issue) context = { ...args, issue: scope.issue }
    else if (name === 'status') {
      try {
        context = { ...args, issue: await read($, workflowIssue) }
      } catch (failure) {
        contextFailure = ` The bound issue could not be read: ${failure instanceof Error ? failure.message : String(failure)}.`
      }
    }
  }
  const result = workflowToolLost(tool, error, context)!
  result.result += contextFailure
  try {
    const root = logged?.root || text(args, 'worktree') || scope?.root || await boundRoot($) || await $.session.cwd()
    const target = workflowTarget(name, context)
    if (root && (logged?.name || target)) await liveCallFailed($, root, logged?.name || target!.name, name, args, `kind=${error.kind}: ${error.message ?? 'no message'}. ${result.result}`, logged?.at)
  } catch (failure) {
    result.result += ` Failure evidence could not be recorded: ${failure instanceof Error ? failure.message : String(failure)}.`
  }
  $.ui.log(result.result, { to: 'debug' })
  return result
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
      failedCalls.set(e, logged)
      const name = s.name
      const isHeld = WAIT_TOOLS.includes(name) || (name === 'interview' && args.interviewJson !== undefined)
      // A hook's time runs on while it awaits the turn of another call, and a check script there can run for an
      // hour: the host then dropped the call behind it after ten seconds (fcc-proto #876, checkpoint, twice).
      // The pauses of whenTurnsFree are processes, which cost the hook nothing. The loop reads the count again,
      // as another call can take the turn between the last pause and here.
      if (!isHeld) {
        callsNow.set(name, 'waiting')
        while (turnsQueued) await whenTurnsFree($)
        callsNow.set(name, 'running')
      }
      try {
        const result = WAIT_TOOLS.includes(name) ? await waitTool($, name, { args, project: project(), tool: name }, next) : isHeld ? await askInterview($, { args, project: project(), tool: name }, next) : await inTurn(() => withToolProgress($, name, () => dispatch($, name, { args, project: project(), tool: name })))
        await liveEnd($, logged, s.name, 'ok', result)
        callsNow.delete(name)
        failedCalls.delete(e)
        return { result }
      } catch (error) {
        if (error instanceof Refuse) {
          await liveEnd($, logged, s.name, 'refused', error.message)
          callsNow.delete(name)
          failedCalls.delete(e)
          return { result: error.message, isError: true as const }
        }
        const message = `workflow ${s.name} failed: ${error instanceof Error ? error.message : String(error)}`
        const failure = (await workflowToolFailed($, e.tool, { kind: 'throw', message: error instanceof Error ? error.message : String(error) }, args))!
        return { ...failure, result: failure.result + (await reportFault($, `workflow tool ${s.name}`, message, `the project ${project()?.root ?? 'unknown'}`)) }
      }
    }).catch(($, e, next) => workflowToolFailed($, e.tool, next.error, e as unknown as Args))
  }
}

