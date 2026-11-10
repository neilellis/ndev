// Keeps the agent on the work, as /goal does. A turn that ends before `done` gets the next step at
// once. A session that sits idle for 20 minutes reads its PR, is compacted and gets the next step,
// with any merge conflict or failed check. While checks run, this watches them for the agent, which
// starts no wait of its own: the turn can end, and a prompt comes when they end or when one fails.
// Repeating with no progress ends in `blocked`, so a stuck agent reaches the human and spends no
// more tokens. GitHub calls are limited: a turn end makes none, the idle check makes one when the
// PR is clean, and a read of the checks makes two, once in each check period.
import { reportFault } from './bug-report'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoadedConfig } from '../config'
import { git, readChecks, readPrHealth } from './effects'
import type { Checks, PrHealth } from './effects'
import { blockWorkflow, boundRoot, factsFor, isInterviewRunning, labelOf, loadWorkflow, isStaleWrite, moved, recordOfReviewer, reviewerAnswered, saveWorkflow, stepOf, watchesChecks } from './tools'
import type { Workflow } from './tools'
import { liveName, shownValue, writeLive } from './live'

export const IDLE_MS = 20 * 60_000
const CHECK_MS = 3 * 60_000 // A read of the checks costs two GitHub calls. NDEV_WORKFLOW_CHECK_MS overrides it.
const STUCK_MS = 60 * 60_000 // Checks pending this long are stuck, not slow.
const TICK_MS = 60_000
const NO_SESSION = /is not available in this mode: no session is bound/
const TURN_END_LIMIT = 3 // Turn ends with no progress before the block.
const IDLE_LIMIT = 1 // Idle nudges with no progress before the block.
const LOST_SAVE_LIMIT = 3 // Ticks in a row that lose their save to another writer before it shows as a fault.

// turnId is the turn that runs now, so the end of an older turn does not mark a newer one as ended.
const activity = atom({ plugin: 'ndev', key: 'workflowActivity' } as const, { at: 0, isTurnRunning: false } as { at: number; isTurnRunning: boolean; turnId?: string }, { shape: 'workflow-activity-2' })
const checkRead = atom({ plugin: 'ndev', key: 'workflowCheckRead' } as const, { at: 0 }, { shape: 'workflow-check-read-1' })
// What the last tick did or why it did nothing. /flow status shows it, so a quiet watcher can be explained.
const watchNote = atom({ plugin: 'ndev', key: 'workflowWatchNote' } as const, { at: 0, why: 'the watcher has not run yet' }, { shape: 'workflow-watch-note-1' })

async function note($: EngineInterface, why: string): Promise<void> {
  const at = await $.clock.now()
  await update($, watchNote, () => ({ at, why }))
}

export async function watcherNote($: EngineInterface): Promise<{ at: number; why: string }> {
  return read($, watchNote)
}

// A finished workflow is watched too, until its PR merges: the base can move under a PR that waits
// for a human, and then the PR is not ready after all.
const isWatched = (wf: Workflow | undefined): wf is Workflow => !!wf && !wf.off && !isInterviewRunning(wf.issue) && wf.state !== 'blocked' && wf.state !== 'wait' && wf.state !== 'developed' && !(wf.state === 'done' && (wf.prsClosed || !wf.prs.length))

const hashOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7).toString(16)

async function fingerprint($: EngineInterface, wf: Workflow, problems: string[]): Promise<string> {
  const head = await git(wf.root, $, 'rev-parse', 'HEAD')
  const tree = await git(wf.root, $, 'status', '--porcelain=v1')
  // The status lists names only, and more edits to a changed file are progress. The record keeps a hash.
  const diff = await git(wf.root, $, 'diff', 'HEAD')
  const others = await git(wf.root, $, 'ls-files', '--others', '--exclude-standard')
  const made = others.stdout.split('\n').filter(Boolean).slice(0, 200)
  const hashes = made.length ? (await $.process.run(['git', 'hash-object', '--', ...made], { cwd: wf.root })).stdout : ''
  return `${wf.state}|${head.stdout.trim()}|${tree.stdout}|${hashOf(diff.stdout + hashes)}|${problems.join('|')}`
}

// The state, or undefined when this is no moment to speak: a person typing, a helper at work, or
// another session's workflow.
async function ready($: EngineInterface, project: LoadedConfig | undefined): Promise<Workflow | undefined> {
  if (project?.config.workflow === false) {
    await note($, 'quiet: .neil-dev.json turns the workflow off')
    return undefined
  }
  const root = (await boundRoot($)) ?? project?.root
  const wf = root ? await loadWorkflow($, root) : undefined
  if (!isWatched(wf)) {
    await note($, `quiet: no workflow to watch at ${root ?? 'an unknown root'} (state ${wf?.state ?? 'none'})`)
    return undefined
  }
  const session = await $.session.id()
  if (wf.owner && wf.owner.session !== session) {
    await note($, `quiet: session ${wf.owner.session} owns this workflow, and this is ${session}`)
    return undefined
  }
  if ((await $.prompt.read()).text.trim() !== '') {
    await note($, 'quiet: the prompt box holds a draft')
    return undefined
  }
  const busy = (await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(a.status))
  if (busy.length) {
    await note($, `quiet: ${busy.length} agent(s) still work: ${busy.map(a => `${a.id} (${a.status})`).join(', ')}`)
    return undefined
  }
  return wf
}

// The host queues a prompt that comes while a turn runs, and the model reads it only when that turn
// ends, maybe long after the state moved on. A turn that started meanwhile (a queued prompt, such as a
// review's answer) gets its own turn-end check, with the state as it is then.
async function turnStarted($: EngineInterface, wf: Workflow): Promise<boolean> {
  if (!(await read($, activity)).isTurnRunning) return false
  await note($, `quiet: a turn started before the reminder for ${labelOf(wf)} (state "${wf.state}") went out, so it was not sent; the end of that turn checks again`)
  return true
}

async function nudge($: EngineInterface, wf: Workflow, project: LoadedConfig | undefined, why: 'turn' | 'idle' | 'checks', problems: string[] = [], sha = ''): Promise<void> {
  const print = await fingerprint($, wf, problems)
  if (await turnStarted($, wf)) return
  const count = wf.nudges.fingerprint === print ? wf.nudges.count : 0
  if (count >= (why === 'idle' ? IDLE_LIMIT : TURN_END_LIMIT)) {
    await blockWorkflow($, wf, `${labelOf(wf)} made no progress in the state "${wf.state}" after ${count} reminder(s).${problems.length ? ` ${problems.join(' ')}` : ''}`)
    return
  }
  wf.nudges = { count: count + 1, fingerprint: print }
  await saveWorkflow($, wf)
  const facts = await factsFor($, wf.root, project, wf)
  if (why === 'idle') {
    try {
      const { skip } = await $.session.compact({ instructions: `Keep what this session knows about ${labelOf(wf)}: its worktree ${wf.root}, the state "${wf.state}" and its open work.` })
      if (skip) $.ui.toast(`workflow: compaction skipped: ${skip}`)
    } catch (error) {
      // The prompt still goes: a failed compaction costs a cold cache, not the work.
      $.ui.toast(`workflow: compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The compaction took time: speak only if the state is still the same.
    if ((await loadWorkflow($, wf.root))?.state !== wf.state) return
  }
  if (why === 'checks') {
    if (await turnStarted($, wf)) return
    const tool = wf.state === 'ci' ? 'finishedChecks' : 'done'
    const text = problems.length
      ? `The workflow read the PR of ${labelOf(wf)}. ${problems.join(' ')} Do not run a wait helper after the push: the workflow goes on watching.`
      : `The checks of ${labelOf(wf)} have ended on ${sha.slice(0, 8)}, and none failed. Now call ${tool}.`
    void $.prompt.submit({ text }).catch((error: unknown) => {
      $.ui.toast(`workflow: the result of the checks for #${wf.issue} was not sent to the model: ${error instanceof Error ? error.message : String(error)}`)
    })
    return
  }
  if (await turnStarted($, wf)) return
  const lead = why === 'idle' ? 'This session was idle for a long time.' : 'The workflow is not finished, so the turn does not end here.'
  const found = problems.length ? ` Fix these first: ${problems.join(' ')}` : ''
  void $.prompt.submit({ text: `${lead}${found} ${labelOf(wf)} is in the state "${wf.state}". ${stepOf(wf, facts)} Wait for a long process in the foreground with one wait helper, because a turn that ends on a background wait gets this reminder again. Do not end the turn before you call done or blocked.` }).catch((error: unknown) => {
    $.ui.toast(`workflow: the next step for #${wf.issue} was not sent to the model: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export async function workflowTurn($: EngineInterface, e: { reason?: string; agentId?: string; answer?: string; turnId?: string }, project: LoadedConfig | undefined): Promise<void> {
  if (e.agentId) {
    // The agent may be on another issue by now, so the search covers each record in the worktree.
    const wf = project ? await recordOfReviewer($, (await boundRoot($)) ?? project.root, e.agentId) : undefined
    if (wf) await reviewerAnswered($, wf, e.agentId, e.answer ?? '', e.reason)
    return
  }
  const now = await $.clock.now()
  // The turn-end handlers before this one can take seconds, and a queued prompt can start the next turn
  // meanwhile. That turn is still running: a reminder now would reach the model one turn late.
  const running = await read($, activity)
  if (running.isTurnRunning && running.turnId && e.turnId && running.turnId !== e.turnId) {
    await note($, `quiet: the turn ${running.turnId} started before the end of the turn ${e.turnId} was checked, so no reminder went out; the end of ${running.turnId} checks again`)
    return
  }
  await update($, activity, () => ({ at: now, isTurnRunning: false }))
  // An aborted turn is the human stepping in, and an error is for the human to see.
  if (e.reason !== 'answer') return
  const wf = await ready($, project)
  // While the checks run, the prompt comes from the read of the checks.
  if (wf && wf.state !== 'done' && !(await watchesChecks($, wf))) await nudge($, wf, project, 'turn')
}

// A check reads the record, then reads GitHub and git, then saves. A turn that starts meanwhile, or another
// session or hook, can save the record first: the save exits 5 and changes nothing. That is no fault. The
// times that the check set go back, so the next tick reads the record again and the reminder is not lost.
async function tick($: EngineInterface, project: () => LoadedConfig | undefined, lost: { saves: number }): Promise<void> {
  const now = await $.clock.now()
  const idleFrom = (await read($, activity)).at
  const checkedAt = (await read($, checkRead)).at
  try {
    await check($, project, now)
    lost.saves = 0
  } catch (error) {
    if (!isStaleWrite(error)) throw error
    lost.saves += 1
    if (lost.saves >= LOST_SAVE_LIMIT) {
      const tries = lost.saves
      lost.saves = 0
      throw new Error(`${(error as Error).message} The idle check read the record again on ${tries} ticks in a row, and each time another writer saved it first. Repair: find the writer that saves this record without a stop; the check tries again after the next idle period.`)
    }
    await update($, activity, a => (a.at === now ? { ...a, at: idleFrom } : a))
    await update($, checkRead, c => (c.at === now ? { at: checkedAt } : c))
    await note($, `quiet: another writer saved the record during this check, so the check changed nothing and the next tick reads it again: ${(error as Error).message.slice(0, 240)}`)
  }
}

async function check($: EngineInterface, project: () => LoadedConfig | undefined, now: number): Promise<void> {
  const a = await read($, activity)
  if (a.isTurnRunning) return note($, 'quiet: a turn runs')
  const watched = await ready($, project())
  if (watched && (await watchesChecks($, watched))) return watchChecks($, watched, project(), a.at, now)
  const raw = await $.env.get('NDEV_WORKFLOW_IDLE_MS')
  const limit = raw && Number(raw) > 0 ? Number(raw) : IDLE_MS
  if (now - a.at < limit) return note($, `idle for ${Math.round((now - a.at) / 1000)} s of ${Math.round(limit / 1000)} s`)
  const wf = await ready($, project())
  if (!wf) return
  // The time goes first, so a failed read of GitHub waits for the next idle period and does not
  // spend a call every minute.
  await update($, activity, () => ({ at: now, isTurnRunning: false }))
  const health = await prHealth($, wf)
  // The read can end the work: a closed PR blocks, and a blocked session gets no reminder.
  if (wf.state === 'blocked' || wf.state === 'wait') return
  if (wf.state === 'done' && !health.problems.length) return
  if (wf.state === 'done') {
    moved(wf, 'heartbeat', { state: 'revising' }, now)
    await saveWorkflow($, wf)
  }
  await nudge($, wf, project(), 'idle', health.problems)
}

// One read of the PR and one of the checks, once in each check period. Pending checks make no
// prompt until they stick; a failed check or a conflict makes one at once, with the checks running.
async function watchChecks($: EngineInterface, wf: Workflow, project: LoadedConfig | undefined, activeAt: number, now: number): Promise<void> {
  const raw = await $.env.get('NDEV_WORKFLOW_CHECK_MS')
  const limit = raw && Number(raw) > 0 ? Number(raw) : CHECK_MS
  const last = await read($, checkRead)
  if (now - Math.max(last.at, activeAt) < limit) return note($, `watching: next read of the checks in ${Math.round((limit - (now - Math.max(last.at, activeAt))) / 1000)} s`)
  // The time goes first, so a failed read waits for the next period.
  await update($, checkRead, () => ({ at: now }))
  const health = await prHealth($, wf)
  // The read can end the work: a closed PR blocks.
  if (wf.state === 'blocked' || wf.state === 'wait') return
  const sha = (await git(wf.root, $, 'rev-parse', 'HEAD')).stdout.trim()
  const known = health.checks?.sha === sha ? health.checks.checks : undefined
  let checks: Checks
  try {
    checks = known ?? (await readChecks($, wf.root, wf.repo, sha, wf.prs[0]))
  } catch (error) {
    // Not a result: an unread check is not a green one.
    $.ui.toast(`workflow: the checks of ${sha.slice(0, 8)} were not read: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)
    return
  }
  const problems = [...health.problems]
  await writeLive($, wf.root, liveName(wf), l => ({ ...l, watch: { at: now, nextAt: now + limit, sha: sha.slice(0, 8), red: checks.red, pending: checks.pending, green: checks.green.length, problems: problems.map(p => shownValue('problem', p)), seen: health.seen } }))
  await note($, `watching: read ${sha.slice(0, 8)}: ${problems.length} problem(s), ${checks.red.length} red, ${checks.pending.length} pending`)
  if (checks.red.length && !problems.some(p => p.includes('failed checks'))) problems.push(`These checks failed on ${sha.slice(0, 8)}: ${checks.red.join(', ')}. Read their logs (the ndev:fix-ci skill), fix the cause, and call checkpoint.`)
  if (problems.length) return nudge($, wf, project, 'checks', problems, sha)
  if (!checks.pending.length) return nudge($, wf, project, 'checks', [], sha)
  if (now - activeAt < STUCK_MS) return
  await update($, activity, () => ({ at: now, isTurnRunning: false }))
  await nudge($, wf, project, 'idle', [`These checks on ${sha.slice(0, 8)} are still pending after ${STUCK_MS / 60_000} minutes: ${checks.pending.join(', ')}. Find out why, such as a stopped runner or a long queue.`])
}

async function prHealth($: EngineInterface, wf: Workflow): Promise<{ problems: string[]; checks?: { sha: string; checks: Checks }; seen?: Record<string, string> }> {
  if (wf.direct || !wf.prs.length) return { problems: [] }
  const all: PrHealth[] = []
  for (const n of wf.prs) {
    try {
      all.push(await readPrHealth($, wf.root, wf.repo, n))
    } catch (error) {
      // Not a finding about the PR: say so, and go on with the reminder.
      $.ui.toast(`workflow: the state of PR #${n} was not read: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)
      return { problems: [] }
    }
  }
  if (all.every(h => h.closed)) {
    wf.prsClosed = true
    if (wf.state === 'done' && all.every(h => h.merged)) wf.merged = true
    await saveWorkflow($, wf)
    if (wf.state !== 'done') {
      const unmerged = all.filter(h => !h.merged).map(h => `#${h.number}`)
      await blockWorkflow($, wf, unmerged.length ? `${labelOf(wf)} is in the state "${wf.state}", and its PR ${unmerged.join(', ')} was closed with no merge.` : `${labelOf(wf)} is in the state "${wf.state}", and its PR is already merged. Use /flow goto done if the work is finished.`)
    }
    return { problems: [] }
  }
  const read0 = all[0]?.checks
  return { problems: all.flatMap(h => h.problems), checks: read0 && { sha: all[0].sha, checks: read0 }, seen: all[0]?.seen }
}

// A turn runs, or ran, since this time: a prompt reached the session.
export async function promptSince($: EngineInterface, since: number): Promise<boolean> {
  const a = await read($, activity)
  return a.isTurnRunning || a.at > since
}

export async function startWatchdog($: EngineInterface, project: () => LoadedConfig | undefined): Promise<void> {
  const now = await $.clock.now()
  await update($, activity, a => ({ ...a, at: now }))
  const lost = { saves: 0 }
  void $.clock.every(TICK_MS, async () => {
    try {
      await tick($, project, lost)
    } catch (error) {
      // The timer can fire in a process with no session. The host says to carry on: the next tick tries again.
      if (NO_SESSION.test(String(error))) return note($, 'quiet: no session is bound in this process yet')
      $.ui.toast(`workflow: the idle check failed: ${String(error).slice(0, 240)}.${await reportFault($, 'workflow idle check', String(error), `the project ${project()?.root ?? 'unknown'}`)}`)
    }
  })
}

export const workflowWatchdog = (on: Parameters<Register>[0]) => {
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, activity, a => ({ ...a, isTurnRunning: true, turnId: e.turnId }))
    return next(e)
  })
}
