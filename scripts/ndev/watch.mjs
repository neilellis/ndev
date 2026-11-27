import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, isAlive, locked, readObject, releaseRoot, run } from './common.mjs'
import { newestRuns } from './checks.mjs'
import { currentWorkflow, hookSessionFile, watcherState, workflowRootFor } from './hooks.mjs'
import { readProject } from './project.mjs'
import { effectiveWorkflowRecords, recoverDeadWaits } from './waits.mjs'
import { activeEpic } from './epic.mjs'

const minute = 60_000
const repair = 'Run ndev watch --help.'
const string = { type: 'string' }
const tickTime = minute
const now = () => Date.now()
const orcaCommand = () => process.env.ORCA_CLI_COMMAND || 'orca'
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const green = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL'])
const pending = new Set(['', 'QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED', 'REQUESTED', 'WAITING'])

function duration(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new CliError(2, `${name} must be positive. Got ${JSON.stringify(raw)}.`, { repair: `Set ${name} in milliseconds or unset it.` })
  return value
}

function orca(args, root) {
  const argv = [...args, '--json']
  const result = run(orcaCommand(), argv, { cwd: root })
  let receipt
  try {
    receipt = JSON.parse(result.stdout)
  } catch {
    if (result.status === 0) throw new CliError(1, `Orca returned invalid JSON for ${args.slice(0, 2).join(' ')}.`, { details: result, repair: 'Run orca status --json.' })
  }
  if (result.status !== 0 || !receipt?.ok) {
    const detail = receipt?.error?.message || result.stderr.trim() || result.stdout.trim() || 'no output'
    throw new CliError(1, `Orca ${args.slice(0, 2).join(' ')} exited ${result.status}: ${detail}`, {
      details: { ...result, receipt },
      repair: receipt?.error?.data?.command || 'Run orca status --json.',
    })
  }
  return receipt.result
}

function changeState(file, update) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return locked(file, () => {
    const state = readObject(file, { missing: {} })
    const result = update(state)
    if (result !== state) atomicJson(file, result)
    return result
  })
}

export function ensureWatcher(root, session, terminal) {
  const file = watcherState(root, session)
  const requested = now()
  const request = randomUUID()
  const state = changeState(file, record => {
    if ((record.pid && isAlive(record.pid)) || (record.requested && requested - record.requested < minute)) return record
    return { ...record, root, session, terminal, requested, request, pid: null }
  })
  if (state.request !== request || state.pid) return state
  const command = [join(releaseRoot, 'bin/ndev'), 'watch', '--session', session, '--worktree', `path:${root}`].map(shellQuote).join(' ')
  try {
    const created = orca(['terminal', 'create', '--worktree', `path:${root}`, '--title', 'ndev-watch', '--command', command], root)
    return changeState(file, record => ({ ...record, created }))
  } catch (error) {
    changeState(file, record => ({ ...record, requested: null, startError: error.message }))
    throw error
  }
}

function rootFor(target) {
  if (!target || target === 'current') return gitWorkspace().root
  if (target.startsWith('path:')) return gitWorkspace(target.slice(5)).root
  const result = orca(['worktree', 'show', '--worktree', target], process.cwd())
  const path = result?.worktree?.path ?? result?.worktree?.repoPath ?? result?.path
  if (!path) throw new CliError(1, `Orca did not return a path for worktree ${target}.`, { details: result })
  return gitWorkspace(path).root
}

function isAddressed(root, address) {
  if (address.startsWith('dispatch:')) return true
  const listing = orca(['terminal', 'list', '--worktree', `path:${root}`], root)
  return listing.terminals?.some(terminal => terminal.handle === address && terminal.writable)
}

function send(root, address, message, previous) {
  const args = address.startsWith('dispatch:')
    ? ['orchestration', 'send', '--to', address, '--subject', 'ndev watch', '--body', message]
    : ['terminal', 'send', '--terminal', address, '--text', message, '--enter', '--wait-submit', '5']
  if (previous) args.push('--retry-request', previous)
  const receipt = orca(args, root)
  const sent = receipt?.send ?? receipt
  if (!sent || sent.accepted === false || sent.delivered === false) {
    throw new CliError(1, `Orca did not accept the watcher message for ${address}.`, { details: receipt })
  }
  return { ...receipt, requestId: receipt.mutation?.requestId ?? sent.prompt?.requestId ?? receipt.requestId }
}

const COMPACT_REFUSALS = {
  codex: 'Codex 0.172 takes /compact through Orca, but no completed compaction and PostCompact hook has been seen in a live Codex terminal yet (#227)',
  opencode: 'Orca cannot see when an OpenCode turn ends, so the watcher cannot tell when its compaction is over',
}

function compact(root, session, address, binding) {
  if (address.startsWith('dispatch:')) return { skipped: `Orca dispatch ${address} takes messages through orchestration, which has no compact command` }
  if (!binding.harness) return { skipped: `the session-start hook recorded no harness for session ${session}` }
  if (binding.harness !== 'claude') return { skipped: COMPACT_REFUSALS[binding.harness] ?? `harness ${binding.harness} has no compact command that the watcher can type` }
  let requestId = null
  try {
    requestId = send(root, address, '/compact').requestId ?? null
    orca(['terminal', 'wait', '--terminal', address, '--for', 'tui-idle', '--timeout-ms', String(duration('NDEV_WATCH_COMPACT_MS', 5 * minute))], root)
  } catch (error) {
    return { failed: error.message, requestId: requestId ?? receiptId(error) ?? null }
  }
  const limit = duration('NDEV_WATCH_COMPACT_HOOK_MS', 15_000)
  const deadline = now() + limit
  while ((readObject(hookSessionFile(root, session), { missing: {} }).compactedAt ?? 0) <= (binding.compactedAt ?? 0)) {
    if (now() >= deadline) return { failed: `/compact went into ${address} and the agent went idle, but no compact hook of session ${session} recorded a compaction within ${limit} ms`, requestId }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return { compacted: true, requestId }
}

function compactionNote({ skipped, failed, requestId }) {
  if (skipped) return ` Compaction skipped: ${skipped}.`
  if (failed) return ` Compaction failed${requestId ? ` (Orca request ${requestId})` : ''}: ${failed.replace(/\.$/, '')}.`
  return ''
}

function readPr(workflow, pr, root, fields = 'headRefOid,state,mergeable,statusCheckRollup') {
  const args = ['pr', 'view', String(pr)]
  if (workflow.repo) args.push('-R', workflow.repo)
  args.push('--json', fields)
  const result = checked('gh', args, { cwd: root, repair: 'Run gh auth status and retry ndev watch.' })
  try {
    return JSON.parse(result)
  } catch (error) {
    throw new CliError(1, `PR #${pr} has invalid JSON from gh: ${error.message}`, { details: { output: result } })
  }
}

function checkResult(pr, workflow, root) {
  const current = readPr(workflow, pr, root)
  if (!current.headRefOid || !Array.isArray(current.statusCheckRollup)) {
    throw new CliError(1, `PR #${pr} has no head SHA or checks from gh.`, { details: current })
  }
  const head = checked('git', ['rev-parse', 'HEAD'], { cwd: root })
  if (head !== current.headRefOid) return { head, prHead: current.headRefOid, stale: true }
  const failed = []
  const running = []
  for (const { item } of newestRuns(current.statusCheckRollup)) {
    const state = item.conclusion || item.state || item.status || ''
    const name = item.name || item.context
    if (pending.has(state)) running.push(name)
    else if (!green.has(state)) failed.push(name)
  }
  if (current.mergeable === 'CONFLICTING') failed.push('merge conflict')
  if (current.state === 'CLOSED') failed.push('PR closed')
  return { head, failed: failed.sort(), running: running.sort(), landed: current.state === 'MERGED' }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function turnIsActive(root, session) {
  const value = readObject(hookSessionFile(root, session), { missing: {} })
  return value.running && !value.endedAt
}

const NOTICES_KEPT = 20

function receiptId(error) {
  return error.details?.receipt?.error?.data?.requestId
}

function deliver(root, session, address, file, state, reason, message, hash, about) {
  if (state.sent?.[reason] === hash) return { state }
  if (state.pending?.hash !== hash) {
    state = { ...state, pending: { hash, reason, message } }
    atomicJson(file, state)
  }
  if (turnIsActive(root, session)) return { state }
  if (state.pending.unknown) {
    throw new CliError(1, `Orca has not confirmed delivery of the ${reason} notice for ${session}.`, { repair: 'Inspect the target session before restarting ndev watch.' })
  }
  try {
    const receipt = send(root, address, message, state.pending?.requestId)
    const lastNotice = { message, issue: about.issue, state: about.state, requestId: receipt.requestId ?? null, at: now(), ...(about.compaction ? { compaction: about.compaction } : {}) }
    return { state: { ...state, sent: { ...state.sent, [reason]: hash }, pending: null, lastNotice, notices: [...(state.notices ?? []), lastNotice].slice(-NOTICES_KEPT) }, notice: { reason, message, receipt } }
  } catch (error) {
    const requestId = receiptId(error)
    const knownRefusal = ['agent_prompt_blocked', 'agent_not_running', 'terminal_not_found'].includes(error.details?.receipt?.error?.code)
    atomicJson(file, { ...state, pending: { ...state.pending, requestId, unknown: !requestId && !knownRefusal } })
    throw error
  }
}

function checkRunsFor(root, issue) {
  const { gitDir } = gitWorkspace(root)
  return readdirSync(gitDir).filter(name => /^ndev-.+\.run$/.test(name)).some(name => {
    const progress = readObject(join(gitDir, name, 'progress.json'), { missing: {} })
    return progress.issue === issue && Number.isInteger(progress.pid) && Number.isInteger(progress.flowPid) && now() < progress.startedAt + progress.limitMs
      && !existsSync(join(gitDir, name, 'exit')) && isAlive(progress.pid) && isAlive(progress.flowPid)
  })
}

function cycle(root, session, address, file, state) {
  const binding = readObject(hookSessionFile(root, session), { missing: {} })
  if (binding.endedAt || !isAddressed(root, address)) return { state, ended: true, notices: [] }
  root = workflowRootFor(root, session)
  const recovered = recoverDeadWaits(root)
  const config = readProject(root)
  if (config.workflow === false || binding.running || activeEpic(root, session)) return { state, notices: [], recovered }
  const wf = currentWorkflow(root, [session])
  if (!wf) return revisitDone(root, session, address, file, state, binding, recovered)
  if ((wf.owner && wf.owner.session !== session) || ['wait', 'blocked'].includes(wf.state) || checkRunsFor(root, wf.issue)) return { state, notices: [], recovered }
  const pr = wf.pr ?? wf.prs?.at(-1)
  const stamp = now()
  const notices = []
  if (pr && (wf.state === 'ci' || (wf.state === 'finishing' && wf.doneWaitsFor))) {
    if (stamp - (state.checkedAt ?? 0) < duration('NDEV_WORKFLOW_CHECK_MS', 3 * minute)) return { state, notices, recovered }
    const checks = checkResult(pr, wf, root)
    state = { ...state, checkedAt: stamp, checks }
    if (checks.stale) return { state, notices, recovered, checks }
    let message
    if (checks.failed.length) message = `Issue #${wf.issue}, PR #${pr}: checks failed on ${checks.head.slice(0, 8)}: ${checks.failed.join(', ')}. Fix and use ndev flow checkpoint.`
    else if (!checks.running.length) message = `Issue #${wf.issue}, PR #${pr}: checks completed on ${checks.head.slice(0, 8)}. Run ndev flow ${wf.state === 'ci' ? 'finished-checks' : 'done'}.`
    else {
      const waitingSince = state.waiting?.head === checks.head ? state.waiting.at : stamp
      state = { ...state, waiting: { head: checks.head, at: waitingSince } }
      if (stamp - waitingSince >= 60 * minute) message = `PR #${pr}: checks are still pending on ${checks.head.slice(0, 8)}: ${checks.running.join(', ')}.`
    }
    if (message && currentWorkflow(root, [session])?.state === wf.state) {
      const displayedHead = checked('git', ['rev-parse', 'HEAD'], { cwd: root })
      const liveHead = readPr(wf, pr, root, 'headRefOid').headRefOid
      if (!liveHead) throw new CliError(1, `PR #${pr} has no current head SHA from gh.`)
      if (displayedHead === checks.head && liveHead === checks.head) {
        const delivered = deliver(root, session, address, file, state, 'checks', message, fingerprint([wf.state, checks, message]), wf)
        state = delivered.state
        if (delivered.notice) notices.push(delivered.notice)
      }
    }
    return { state, notices, recovered, checks }
  }
  const last = binding.activityAt ?? binding.startedAt
  const early = binding.turnEndedAt && binding.turnEndedAt !== state.turnEndedAt
  const idle = last !== undefined && stamp - last >= duration('NDEV_WORKFLOW_IDLE_MS', 20 * minute)
  if (!early && !idle) return { state, notices, recovered }
  const reason = early ? 'turn' : 'idle'
  const newHistory = fingerprint([wf.issue, wf.state, wf.history?.at(-1), wf.pr, wf.evidence])
  const count = state.nudge?.fingerprint === newHistory ? state.nudge.count : 0
  const limit = reason === 'idle' ? 1 : 3
  if (count >= limit) {
    const message = `Issue #${wf.issue} did not progress after ${count} notices. Run ndev flow status, then ndev flow unblock when it can continue.`
    checked(join(releaseRoot, 'bin/ndev'), ['flow', 'blocked', '--issue', String(wf.issue), '--message', message], {
      cwd: root, env: { ...process.env, ORCA_AGENT_SESSION_ID: session },
      repair: 'Inspect the workflow and record the blocker with ndev flow blocked.',
    })
    return { state, notices: [{ reason: 'stalled', message }], recovered }
  }
  let message = `Issue #${wf.issue} is in ${wf.state}. Run ndev flow status for the next action and keep working or record the blocker.`
  const hash = fingerprint([newHistory, early ? binding.turnEndedAt : last, reason])
  let compaction
  if (state.pending?.hash === hash) message = state.pending.message
  else if (reason === 'idle' && state.sent?.idle !== hash && !turnIsActive(root, session)) {
    compaction = compact(root, session, address, binding)
    message += compactionNote(compaction)
  }
  const delivered = deliver(root, session, address, file, state, reason, message, hash, { ...wf, compaction })
  state = delivered.state
  if (delivered.notice) {
    notices.push(delivered.notice)
    state = { ...state, nudge: { fingerprint: newHistory, count: count + 1 }, turnEndedAt: binding.turnEndedAt }
  }
  return { state, notices, recovered }
}

function revisitDone(root, session, address, file, state, binding, recovered) {
  const done = effectiveWorkflowRecords(root).find(wf => wf.state === 'done' && !wf.off && !wf.direct && !wf.prsClosed && wf.prs?.length && (!wf.owner || wf.owner.session === session))
  const last = binding.activityAt ?? binding.startedAt
  const stamp = now()
  if (!done || last === undefined || stamp - Math.max(last, state.revisitedAt ?? 0) < duration('NDEV_WORKFLOW_IDLE_MS', 20 * minute)) return { state, notices: [], recovered }
  state = { ...state, revisitedAt: stamp }
  const target = done.pr ? ['--pr', String(done.pr)] : ['--issue', String(done.issue)]
  const output = checked(join(releaseRoot, 'bin/ndev'), ['flow', 'revisit', ...target, '--json'], {
    cwd: root, env: { ...process.env, ORCA_AGENT_SESSION_ID: session },
    repair: `Run ndev flow revisit ${target.join(' ')} in ${root} and fix the failure it names.`,
  })
  let result
  try {
    ({ result } = JSON.parse(output))
  } catch (error) {
    throw new CliError(1, `ndev flow revisit ${target.join(' ')} returned invalid JSON in ${root}: ${error.message}`, { details: { output }, repair: `Run ndev flow revisit ${target.join(' ')} --json in ${root} and fix the output it names.` })
  }
  const { pr, feedback, problems } = result.revisit
  if (!feedback.length && !problems.length) return { state, notices: [], recovered }
  const message = [
    feedback.length ? `Issue #${done.issue}, PR #${pr} has new feedback with no answer:` : `Issue #${done.issue}, PR #${pr} needs work after done:`,
    ...feedback, ...problems,
    `Issue #${done.issue} is in ${result.state}. Run ndev flow status for the next step.`,
  ].join('\n')
  const delivered = deliver(root, session, address, file, state, 'revisit', message, fingerprint([done.issue, result.state, feedback, problems]), { issue: done.issue, state: result.state })
  return { state: delivered.state, notices: delivered.notice ? [delivered.notice] : [], recovered }
}

export async function tickQueues(root, session, terminal) {
  const { tickFixPrs } = await import('./fix-prs.mjs')
  const { tickTriage } = await import('./triage.mjs')
  const { tickWalkCopy } = await import('./walk-doc.mjs')
  const activeRoot = workflowRootFor(root, session)
  const data = await Promise.allSettled([tickFixPrs(activeRoot), tickTriage(activeRoot), tickWalkCopy(root, { session, terminal })])
  const failures = data.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new CliError(1, failures.map(error => error.message).join('\n'), { details: failures.map(error => error.details) })
  return { fixPrs: data[0].value, triage: data[1].value, walk: data[2].value }
}

export async function runWatch(argv) {
  const { values } = argsFor(argv, { session: string, worktree: string, once: { type: 'boolean' } }, repair)
  const root = rootFor(values.worktree)
  const session = values.session ?? process.env.ORCA_AGENT_SESSION_ID
  if (!session) throw new CliError(2, 'Watch needs an Orca session ID.', { repair: 'Start ndev watch in Orca or pass --session <id>.' })
  const file = watcherState(root, session)
  const address = readObject(file, { missing: {} }).terminal ?? process.env.ORCA_TERMINAL_HANDLE ?? (session.startsWith('dispatch:') || session.startsWith('term_') ? session : undefined)
  if (!address) throw new CliError(2, `No Orca delivery address for session ${session}.`, { repair: 'Start the watcher from a session-start hook or pass a terminal or dispatch handle as --session.' })
  if (values.once) {
    let output
    changeState(file, state => {
      if (state.pid && state.pid !== process.pid && isAlive(state.pid)) throw new CliError(5, `Watcher already runs for ${session} as PID ${state.pid}.`)
      const result = cycle(root, session, address, file, state)
      const { state: saved, ...data } = result
      output = data
      return saved
    })
    const queues = output.ended ? undefined : await tickQueues(root, session, address)
    return { root, session, ...output, queues, text: output.notices.map(notice => notice.message).join('\n') || `No watcher notice for ${session}.` }
  }
  changeState(file, state => {
    if (state.pid && isAlive(state.pid)) throw new CliError(5, `Watcher already runs for ${session} as PID ${state.pid}.`)
    return { ...state, pid: process.pid, root, session, terminal: address }
  })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    while (!controller.signal.aborted) {
      let ended
      changeState(file, state => {
        const result = cycle(root, session, address, file, state)
        ended = result.ended
        for (const notice of result.notices) console.error(notice.message)
        return result.state
      })
      if (ended) break
      try {
        await tickQueues(root, session, address)
      } catch (error) {
        console.error(`ndev watch could not advance the queues in ${root}: ${error.message}`)
      }
      await pause(tickTime, undefined, { signal: controller.signal })
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    changeState(file, state => ({ ...state, pid: null, requested: null, endedAt: now() }))
  }
  return { root, session, text: `Watcher ended for ${session}.` }
}
