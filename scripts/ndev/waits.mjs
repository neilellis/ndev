import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { STATES } from '../../hooks/workflow/machine.ts'
import { settleChecks } from './checks.mjs'
import { argsFor, checked, CliError, gitWorkspace, readObject, worktreeScript } from './common.mjs'
import { readProject } from './project.mjs'

const child = promisify(execFile)
const string = { type: 'string' }
const targets = { issue: string, pr: string }
const options = { ...targets, period: string, attempts: string, timeout: string }
const maxTime = 1_200_000
const maxChecksTime = 21_600
const mainLine = ['setup', 'interviewing', 'planning', 'developing', 'hardening', 'developed', 'reviewing', 'ci', 'smoke', 'finishing', 'done']
const prStates = ['open', 'closed', 'merged', 'draft', 'ready', 'mergeable']
const issueStates = ['open', 'closed']
const namedRecord = /^\.neil-dev\.issue-([1-9]\d*)\.json$/
const issuePath = (root, number) => join(root, `.neil-dev.issue-${number}.json`)
const repairFor = kind => `ndev wait ${kind} --help`

function decimal(value, label, repair, { min = 0.001, max = Infinity, integer = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) {
    throw new CliError(2, `Invalid ${label} ${JSON.stringify(value)}. Expected ${integer ? 'an integer' : 'a number'} from ${min}${Number.isFinite(max) ? ` to ${max}` : ' upward'}.`, { repair })
  }
  return n
}

function identifier(value, label, repair) {
  return decimal(value, label, repair, { min: 1, integer: true })
}

function choices(input, allowed, repair) {
  if (!allowed.includes(input)) throw new CliError(2, `Invalid state ${JSON.stringify(input)}. Use ${allowed.join(', ')}.`, { repair })
  return input
}

export function readWorkflowRecords(root) {
  return readdirSync(root).flatMap(file => {
    if (!namedRecord.test(file)) return []
    const held = readObject(join(root, file))
    return [held.workflow, ...Object.values(held.prs ?? {})].filter(record => record && typeof record === 'object')
  })
}

export function effectiveWorkflowRecords(root) {
  const records = readWorkflowRecords(root)
  return [...new Set(records.map(record => (record.state === 'developed' && !record.pr
    ? records.find(pr => pr.pr === record.prs?.[0] && pr.state !== 'developing')
    : undefined) ?? record))]
}

function findRecord(all, { issue, pr }) {
  if (pr !== undefined) return all.find(record => record.pr === pr) ?? all.find(record => record.prs?.includes(pr))
  if (issue !== undefined) {
    const snapshot = all.find(record => !record.pr && record.issue === issue)
    const carriers = all.filter(record => record.pr && (record.issue === issue || record.issues?.includes(issue)))
    if (snapshot) return carriers.find(record => record.pr === snapshot.prs?.[0]) ?? snapshot
    return carriers.length === 1 ? carriers[0] : undefined
  }
  const snapshots = all.filter(record => !record.pr)
  const selected = snapshots.map(record => {
    if (!Number.isSafeInteger(record.issue) || record.issue <= 0) throw new CliError(1, `Workflow record has invalid issue ${JSON.stringify(record.issue)}.`, { repair: 'Inspect the .neil-dev.issue-*.json records in this worktree.' })
    return findRecord(all, { issue: record.issue })
  })
  const unbound = all.filter(record => record.pr && !snapshots.some(snapshot => snapshot.issue === record.issue || record.issues?.includes(snapshot.issue)))
  const current = [...new Set([...selected, ...unbound].filter(Boolean))]
  return current.length === 1 ? current[0] : undefined
}

function callerRecord(root, values, { optional = false } = {}) {
  const repair = 'Run ndev flow status or specify --issue <n> or --pr <n>.'
  if (values.issue !== undefined && values.pr !== undefined) throw new CliError(2, 'Choose one caller, --issue or --pr.', { repair })
  const caller = {
    issue: values.issue === undefined ? undefined : identifier(values.issue, 'caller issue', repair),
    pr: values.pr === undefined ? undefined : identifier(values.pr, 'caller PR', repair),
  }
  const all = readWorkflowRecords(root)
  const record = findRecord(all, caller)
  if (record || (optional && caller.pr)) return record
  if (caller.issue) throw new CliError(2, `No workflow record for issue #${caller.issue} in ${root}.`, { repair: `Run ndev flow start ${caller.issue} to start its workflow, or give --pr <n> to wait on a pull request that no workflow holds.` })
  if (!optional || all.length > 1) throw new CliError(2, `No single workflow in ${root}.`, { repair })
  return record
}

export function saveWorkflowRecord(root, record) {
  checked('bash', [worktreeScript, 'set-workflow', '--expect-rev', String(record.rev ?? 0), '--worktree', root], {
    cwd: root,
    input: JSON.stringify(record),
    repair: 'Run ndev flow status, then retry the operation.',
  })
}

function waitRecord(root, original) {
  if (!original.pr) return readObject(issuePath(root, original.issue)).workflow
  return findRecord(readWorkflowRecords(root), { pr: original.pr })
}

function markWait(root, record, wait) {
  if (!record) return
  if (['wait', 'blocked', 'done'].includes(record.state) || record.off) {
    throw new CliError(1, `Issue #${record.issue} cannot wait in state ${record.state}.`, { repair: 'Run ndev flow status.' })
  }
  saveWorkflowRecord(root, { ...record, state: 'wait', previous: record.state, wait })
}

function restore(root, record, result) {
  if (!record.previous) throw new CliError(1, `Wait ${record.wait.id} for issue #${record.issue} has no saved phase.`, { repair: 'Inspect the issue record and run ndev flow goto.' })
  const { wait, previous, ...rest } = record
  saveWorkflowRecord(root, { ...rest, state: previous, lastWait: { id: wait.id, ...result } })
  return previous
}

export function cancelActiveWait(argv) {
  const repair = 'ndev flow unblock --help'
  const { values, positionals: [answer = ''] } = argsFor(argv, targets, repair, { positionals: 1 })
  const { root } = gitWorkspace()
  const record = callerRecord(root, values, { optional: true })
  if (record?.state !== 'wait' || !record.wait?.id) return null
  const state = restore(root, record, { outcome: 'cancelled', answer, endedAt: Date.now() })
  return { issue: record.issue, waitId: record.wait.id, state, answer, text: `Ended wait ${record.wait.id} for issue #${record.issue}. Restored ${state}.` }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

export function recoverDeadWaits(root) {
  const recovered = []
  for (const record of readWorkflowRecords(root)) {
    if (record.state !== 'wait' || !record.wait?.id || !Number.isSafeInteger(record.wait.pid) || pidAlive(record.wait.pid)) continue
    const state = restore(root, record, { outcome: 'owner_exited', endedAt: Date.now() })
    recovered.push({ issue: record.issue, waitId: record.wait.id, state })
  }
  return recovered
}

async function attempt(executable, argv, { cwd, signal, timeout }) {
  try {
    const { stdout, stderr } = await child(executable, argv, { cwd, signal, timeout, maxBuffer: 1024 * 1024 })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { exitCode: Number.isInteger(error.code) ? error.code : error.killed ? 124 : 127, stdout: error.stdout ?? '', stderr: error.stderr || error.message }
  }
}

async function remoteJson(executable, argv, settings) {
  const result = await attempt(executable, argv, settings)
  if (result.exitCode !== 0) {
    throw new CliError(1, `${[executable, ...argv].join(' ')} exited ${result.exitCode}: ${result.stderr || result.stdout || 'no output'}`, {
      repair: executable === 'gh' ? 'Run gh auth status and retry.' : 'Run orca status --json and retry.',
      details: result,
    })
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new CliError(1, `${executable} did not return JSON: ${error.message}`, { details: result })
  }
}

const readPr = (number, repoArgs, fields, settings) => remoteJson('gh', ['pr', 'view', String(number), ...repoArgs, '--json', fields], settings)

function reached(record, wanted, startedAt) {
  if (record.state === wanted || record.history?.some(entry => entry.at >= startedAt && entry.to === wanted)) return true
  const held = ['wait', 'blocked'].includes(record.state)
  const phase = held ? record.previous : record.state
  if (held && phase === wanted && record.history?.some(entry => entry.to === wanted)) return true
  const position = mainLine.indexOf(phase === 'revising' ? 'ci' : phase)
  const target = mainLine.indexOf(wanted)
  return target >= 0 && position > target
}

function detectState(root, issue, wanted, startedAt) {
  const output = checked('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root })
  const state = output.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
    .map(directory => findRecord(readWorkflowRecords(directory), { issue })).filter(Boolean)
    .sort((a, b) => (b.history?.at(-1)?.at ?? 0) - (a.history?.at(-1)?.at ?? 0))[0]
  if (!state) return { satisfied: false, issue, state: 'no record' }
  const satisfied = reached(state, wanted, startedAt)
  if (!satisfied && (state.state === 'done' || state.off)) {
    throw new CliError(1, `Issue #${issue} will not reach ${wanted}: state is ${state.state}${state.off ? ' and its workflow is off' : ''}.`)
  }
  return { satisfied, issue, state: state.state }
}

function makeCheck(kind, positional, shell, repair, context) {
  const [name, state] = positional
  if (kind === 'command') {
    if (!shell.length || positional.length) throw new CliError(2, 'Give the executable after --.', { repair })
    return async settings => {
      const result = await attempt(shell[0], shell.slice(1), settings)
      return { satisfied: result.exitCode === 0, ...result }
    }
  }
  if (shell.length || !name) throw new CliError(2, `Give the target for wait ${kind}.`, { repair })
  if (kind === 'seconds') {
    const delay = decimal(name, 'seconds', repair, { max: 1200 }) * 1000
    return { delay }
  }
  if (kind === 'process') {
    const pid = identifier(name, 'process ID', repair)
    return () => ({ satisfied: !pidAlive(pid), pid, detail: 'Use the process log or result file for its exit code.' })
  }
  if (kind === 'url') {
    let url
    try {
      url = new URL(name)
    } catch {
      throw new CliError(2, `Invalid URL ${JSON.stringify(name)}.`, { repair })
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CliError(2, 'Use an HTTP or HTTPS URL without user information.', { repair })
    return async ({ signal, timeout }) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })
        await response.body?.cancel()
        return { satisfied: response.ok, status: response.status }
      } catch (error) {
        if (signal.aborted) throw signal.reason
        return { satisfied: false, detail: error.cause?.message ?? error.message }
      }
    }
  }
  if (kind === 'state') {
    const issue = identifier(name, 'target issue', repair)
    if (context.record?.issue === issue) throw new CliError(2, `Wait state cannot target its own issue #${issue}.`, { repair })
    const wanted = choices(state, STATES, repair)
    return () => detectState(context.root, issue, wanted, context.startedAt)
  }
  if (kind === 'agent') {
    return async settings => {
      if (name.startsWith('ctx_') || name.startsWith('dispatch:')) {
        const { ok, result, error } = await remoteJson('orca', ['orchestration', 'worker-show', '--dispatch', name.replace(/^dispatch:/, ''), '--json'], settings)
        if (!ok || !result) throw new CliError(1, `Orca dispatch ${name}: ${error?.message || 'missing receipt'}.`)
        const status = result.state
        if (['lost', 'abandoned', 'failed'].includes(status)) throw new CliError(1, `Orca dispatch ${name} is ${status}.`, { details: result })
        return { satisfied: ['completed', 'done', 'settled', 'succeeded', 'finished'].includes(status) || result.terminalState === 'released', status }
      }
      const result = await attempt('orca', ['terminal', 'wait', '--terminal', name, '--for', 'exit', '--timeout-ms', String(settings.timeout), '--json'], settings)
      return { satisfied: result.exitCode === 0, ...result }
    }
  }
  const repoArgs = context.repo ? ['-R', context.repo] : []
  if (kind === 'checks') {
    const number = identifier(name, 'target PR', repair)
    return async settings => settleChecks(number, await readPr(number, repoArgs, 'headRefOid,statusCheckRollup', settings))
  }
  if (kind === 'pr') {
    const number = identifier(name, 'target PR', repair)
    if (context.record?.pr === number || context.record?.prs?.includes(number)) throw new CliError(2, `Wait PR cannot target its own PR #${number}.`, { repair: 'Use ndev watch for the current PR checks.' })
    const wanted = choices(state, prStates, repair)
    return async settings => {
      const pr = await readPr(number, repoArgs, 'state,isDraft,mergeable', settings)
      const states = [pr.state?.toLowerCase()]
      if (pr.state === 'OPEN') states.push(pr.isDraft ? 'draft' : 'ready')
      if (pr.state === 'OPEN' && pr.mergeable === 'MERGEABLE' && !pr.isDraft) states.push('mergeable')
      return { satisfied: states.includes(wanted), pr: number, states }
    }
  }
  const wanted = choices(name, issueStates, repair)
  if (positional.length < 2) throw new CliError(2, 'Give at least one target issue.', { repair })
  const issues = positional.slice(1).map(entry => identifier(entry, 'target issue', repair))
  return async settings => {
    const states = []
    for (const issue of issues) {
      const result = await remoteJson('gh', ['issue', 'view', String(issue), ...repoArgs, '--json', 'state'], settings)
      states.push({ issue, state: result.state?.toLowerCase() })
    }
    return { satisfied: states.every(entry => entry.state === wanted), issues: states }
  }
}

function currentRoot(required) {
  const result = gitWorkspaceForOptional(required)
  return result?.root
}

function gitWorkspaceForOptional(required) {
  try {
    return gitWorkspace()
  } catch (error) {
    if (required || !/not a git repository/i.test(error.details?.output ?? '')) throw error
    return null
  }
}

export async function runWait([kind, ...args]) {
  const repair = repairFor(kind)
  const split = args.indexOf('--')
  const front = split < 0 ? args : args.slice(0, split)
  const tail = split < 0 ? [] : args.slice(split + 1)
  const maxPositional = kind === 'issue' ? Infinity : ['state', 'pr'].includes(kind) ? 2 : 1
  const { values, positionals } = argsFor(front, options, repair, { positionals: maxPositional })
  const ownsCheckWait = kind === 'checks'
  if (ownsCheckWait && (values.issue !== undefined || values.pr !== undefined)) throw new CliError(2, 'Wait checks takes the PR as its argument and holds no workflow record, so it takes no --issue or --pr.', { repair })
  const gitHub = ['issue', 'pr', 'checks'].includes(kind)
  const root = currentRoot(values.issue !== undefined || values.pr !== undefined || gitHub || kind === 'state')
  const record = root && !ownsCheckWait ? callerRecord(root, values, { optional: true }) : null
  const startedAt = Date.now()
  const timeout = decimal(values.timeout ?? (ownsCheckWait ? 3600 : 1200), 'timeout', repair, { max: ownsCheckWait ? maxChecksTime : 1200 }) * 1000
  const period = decimal(values.period ?? (ownsCheckWait ? 60 : gitHub ? 300 : kind === 'command' ? 30 : 5), 'period', repair, { min: ownsCheckWait ? 1 : gitHub ? 60 : 0.001 }) * 1000
  const limit = values.attempts === undefined ? Infinity : identifier(values.attempts, 'attempts', repair)
  const check = makeCheck(kind, positionals, tail, repair, { root, record, startedAt, repo: gitHub ? (ownsCheckWait ? findRecord(readWorkflowRecords(root), { pr: identifier(positionals[0], 'target PR', repair) })?.repo : record?.repo) ?? readProject(root).github?.repo : undefined })
  const wait = { id: randomUUID(), pid: process.pid, kind, startedAt, until: startedAt + timeout }
  markWait(root, record, wait)
  const controller = new AbortController()
  const onSignal = () => controller.abort(new CliError(4, `Wait ${wait.id} was cancelled.`))
  const monitor = record ? setInterval(() => {
    try {
      const current = waitRecord(root, record)
      if (current?.wait?.id !== wait.id) {
        const answer = current?.lastWait?.id === wait.id ? current.lastWait.answer : undefined
        controller.abort(new CliError(4, `Wait ${wait.id} for issue #${record.issue} ended.`, { details: { answer } }))
      }
    } catch (error) {
      controller.abort(error)
    }
  }, 150) : null
  const deadline = check.delay !== undefined && check.delay <= timeout ? undefined : setTimeout(() => controller.abort(new CliError(3, `Wait ${wait.id} for ${kind} timed out.`, { repair })), timeout)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const signal = controller.signal
  let attempts = 0
  let last
  let outcome = 'failed'
  try {
    if (check.delay !== undefined) {
      await pause(check.delay, undefined, { signal })
      last = { satisfied: true }
    } else {
      while (attempts < limit) {
        signal.throwIfAborted()
        attempts += 1
        last = await check({ cwd: root ?? process.cwd(), signal, timeout: Math.max(1, Math.min(60_000, wait.until - Date.now())) })
        if (last.satisfied || attempts === limit) break
        await pause(period, undefined, { signal })
      }
      if (!last?.satisfied) throw new CliError(3, `Wait ${wait.id} for ${kind} did not succeed after ${attempts} attempts.`, { repair })
    }
    signal.throwIfAborted()
    outcome = 'satisfied'
    return { outcome, waitId: wait.id, attempts, last, text: `Wait for ${kind} completed.${last.detail ? ` ${last.detail}` : ''}` }
  } catch (failure) {
    const error = signal.aborted ? signal.reason : failure
    outcome = error.code === 4 ? 'cancelled' : error.code === 3 ? 'timeout' : 'failed'
    error.details = { ...error.details, waitId: wait.id, attempts, last }
    throw error
  } finally {
    clearTimeout(deadline)
    if (monitor) clearInterval(monitor)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (record) {
      const current = waitRecord(root, record)
      if (current?.wait?.id === wait.id) restore(root, current, { outcome, endedAt: Date.now(), attempts, last })
    }
  }
}
