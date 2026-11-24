import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mayMerge } from '../../hooks/workflow/machine.ts'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, releaseRoot, stateRoot } from './common.mjs'
import { publishPanel, renderPanel } from './panes.mjs'
import { readProject } from './project.mjs'

const minute = 60_000
const checkInterval = 15 * minute
const fixInterval = 30 * minute
const success = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const waiting = new Set(['', 'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

const initial = () => ({ phase: 'idle', queue: [], outcomes: {}, log: [], revision: 0 })
const storage = root => join(stateRoot(), 'fix-prs', `${createHash('sha256').update(root).digest('hex')}.json`)
const readQueue = file => readObject(file, { missing: initial() })

function update(file, change) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return locked(file, () => {
    const current = readQueue(file)
    const next = change(current)
    if (next === current) return current
    const updated = { ...next, revision: current.revision + 1 }
    atomicJson(file, updated)
    return updated
  })
}

function json(program, args, root) {
  const output = checked(program, args, { cwd: root, repair: program === 'gh' ? 'Run gh auth status and retry.' : 'Run orca status --json and retry.', timeout: 120_000 })
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new CliError(1, `${program} ${args.slice(0, 2).join(' ')} returned invalid JSON: ${error.message}.`, { details: { output } })
  }
}

function orca(root, args) {
  const command = process.env.ORCA_CLI_COMMAND || 'orca'
  const value = json(command, [...args, '--json'], root)
  if (!value.ok || !value.result) {
    throw new CliError(1, `Orca ${args.slice(0, 2).join(' ')}: ${value.error?.message ?? 'missing receipt'}.`, {
      details: value,
      repair: value.error?.data?.command || 'Inspect the result with orca orchestration worker-list --json.',
    })
  }
  return value.result
}

function repository(root) {
  const project = readProject(root)
  const repo = project.github?.repo
  if (repo === null) throw new CliError(1, 'The project opted out of GitHub.', { repair: 'Run ndev project setup --repo <owner/name>.' })
  if (repo) return repo
  return json('gh', ['repo', 'view', '--json', 'nameWithOwner'], root).nameWithOwner
}

function loadPulls(root, repo) {
  const { login } = json('gh', ['api', 'user'], root)
  if (!login) throw new CliError(1, 'GitHub returned no login for the PR queue.', { repair: 'Run gh auth status.' })
  const queue = json('gh', ['pr', 'list', '-R', repo, '--author', login, '--state', 'open', '--limit', '1000', '--json', 'number,title,createdAt'], root)
  if (!Array.isArray(queue)) throw new CliError(1, `GitHub returned an invalid queue for ${repo}.`)
  if (queue.length === 1000) throw new CliError(1, `GitHub returned the 1000 PR limit for ${repo}.`, { repair: 'Reduce the open PR set and run ndev fix-prs start again.' })
  return queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
}

function loadPull(root, repo, number) {
  const pr = json('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'number,title,state,isDraft,headRefName,headRefOid,mergeStateStatus,statusCheckRollup'], root)
  if (pr.number !== number || !pr.headRefOid || (pr.state === 'OPEN' && !Array.isArray(pr.statusCheckRollup))) {
    throw new CliError(1, `GitHub returned incomplete head or check data for PR #${number}.`, { details: pr })
  }
  return pr
}

function checks(pr) {
  const red = []
  const pending = []
  for (const check of pr.statusCheckRollup) {
    const state = check.conclusion || check.state || check.status || ''
    if (success.has(state)) continue
    const name = check.name || check.context
    if (!name) throw new CliError(1, `PR #${pr.number} has an unnamed check on ${pr.headRefOid}.`)
    if (waiting.has(state)) pending.push(name)
    else red.push(name)
  }
  return { red, pending }
}

function logEntry(state, entry) {
  return [...state.log.slice(-49), { at: Date.now(), entry }]
}

function settled(state, pr, kind, detail, head) {
  return {
    ...state,
    current: null,
    step: null,
    worker: null,
    operation: null,
    outcomes: { ...state.outcomes, [pr]: { kind, detail, head } },
    log: logEntry(state, `PR #${pr}: ${detail}`),
  }
}

function boundUpdate(file, before, updateState) {
  return update(file, current => {
    if (current.revision !== before.revision) {
      throw new CliError(5, 'The PR queue changed during the operation.', { repair: 'Use ndev fix-prs status before retrying.' })
    }
    return updateState(current)
  })
}

function openOperation(file, state, pr, kind) {
  const operation = { id: randomUUID(), pr: pr.number, head: pr.headRefOid, kind, startedAt: Date.now() }
  return boundUpdate(file, state, current => ({ ...current, current: pr.number, step: kind, operation }))
}

function recordOperation(file, pending, transform) {
  return update(file, current => {
    if (current.operation?.id !== pending.operation.id) throw new CliError(5, `PR #${pending.operation.pr} has a different active operation.`, { repair: 'Inspect ndev fix-prs status.' })
    return transform(current)
  })
}

function mergeMethod(root, repo) {
  const preferences = json('gh', ['repo', 'view', repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], root)
  if (preferences.squashMergeAllowed) return '--squash'
  if (preferences.mergeCommitAllowed) return '--merge'
  if (preferences.rebaseMergeAllowed) return '--rebase'
  throw new CliError(1, `No merge method is enabled for ${repo}.`, { repair: 'Use ndev fix-prs start --no-merge.' })
}

function performMerge(root, file, state, pr) {
  const method = mergeMethod(root, state.repo)
  const started = openOperation(file, state, pr, 'merging')
  const args = ['pr', 'merge', String(pr.number), '-R', state.repo, method, '--match-head-commit', pr.headRefOid]
  checked('gh', args, { cwd: root, repair: `Check PR #${pr.number} on GitHub before using ndev fix-prs retry ${pr.number}.` })
  const merged = loadPull(root, state.repo, pr.number)
  if (merged.state !== 'MERGED') throw new CliError(1, `GitHub accepted the merge for PR #${pr.number}, but its state is ${merged.state}.`, { repair: 'Run ndev fix-prs status before another merge attempt.' })
  return recordOperation(file, started, current => settled(current, pr.number, 'merged', 'merged after its head checks passed', pr.headRefOid))
}

function workerStatus(root, dispatch) {
  const worker = orca(root, ['orchestration', 'worker-show', '--dispatch', dispatch, '--full'])
  const liveness = worker.projection?.liveness?.verdict
  return { liveness, ended: liveness === 'exited' && worker.terminalState === 'released', terminal: worker.terminalState }
}

function dispatch(root, file, state, pr, summary) {
  const listed = orca(root, ['worktree', 'list'])
  let workspace = listed.worktrees?.find(tree => tree.projectId === `github:${state.repo.toLowerCase()}` && (tree.branch?.replace(/^refs\/heads\//, '') === pr.headRefName || tree.linkedPR === pr.number))
  if (!workspace?.id && !pr.headRefName) throw new CliError(1, `PR #${pr.number} has no branch for an Orca worker.`)
  const spec = [
    `Repair PR #${pr.number} in ${state.repo} at head ${pr.headRefOid}. Its branch is ${pr.headRefName}.`,
    summary,
    `Use light mode and auto steering. When resuming an enabled workflow, read the PR body for its linked issue, then use ndev flow repair --issue <issue> --pr ${pr.number} and ndev flow steering auto --reason "Fix PRs runs unattended". Keep disabled workflows off.`,
    'Use the existing pull request branch. Keep tests and checks tied to the new commit. Do not merge the pull request.',
    `Report with ndev fix-prs report ${pr.number} pushed --worktree ${JSON.stringify(root)}, or blocked --reason <text> with the same worktree.`,
  ].join('\n')
  const started = openOperation(file, state, pr, 'dispatching')
  try {
    if (!workspace?.id) workspace = orca(root, ['worktree', 'create', '--name', `pr-${pr.number}-repair`, '--base-branch', `origin/${pr.headRefName}`, '--pr', String(pr.number), '--parent-worktree', `path:${root}`]).worktree
    if (!workspace?.id || !workspace.path) throw new CliError(1, `PR #${pr.number}: Orca returned no repair worktree ID or path.`, { repair: 'Run orca worktree list --json and inspect the repair worktree before retrying.' })
    for (const [key, value] of [['mode', 'light'], ['steering', 'auto']]) {
      checked(process.execPath, [join(releaseRoot, 'scripts/cli.mjs'), 'project', key, value], {
        cwd: workspace.path,
        repair: `Run ndev project ${key} ${value} in ${workspace.path}, then retry PR #${pr.number}.`,
      })
    }
  } catch (error) {
    recordOperation(file, started, current => ({ ...current, operation: null, phase: 'paused' }))
    throw error
  }
  const result = orca(root, ['orchestration', 'worker-start', '--spec', spec, '--task-title', `Fix PR #${pr.number}`, '--worktree', `id:${workspace.id}`, '--agent', 'codex'])
  if (!result.dispatchId) throw new CliError(1, `Orca did not return a dispatch ID for PR #${pr.number}.`, { details: result })
  return recordOperation(file, started, current => ({
    ...current, operation: null, step: 'fixing', worker: result.dispatchId, workerHead: pr.headRefOid, workerAt: Date.now(),
    log: logEntry(current, `PR #${pr.number}: dispatched ${result.dispatchId}`),
  }))
}

function runTick(root, file, state) {
  if (state.phase !== 'running' || (state.nextAt && state.nextAt > Date.now())) return state
  const next = state.queue.find(pr => !state.outcomes[pr.number])
  if (!next) return boundUpdate(file, state, current => ({ ...current, phase: 'done', current: null, step: null }))
  const pr = loadPull(root, state.repo, next.number)
  if (pr.state !== 'OPEN') {
    return boundUpdate(file, state, current => settled(current, pr.number, pr.state.toLowerCase(), `already ${pr.state.toLowerCase()}`, pr.headRefOid))
  }
  if (state.operation) {
    return boundUpdate(file, state, current => ({
      ...current, phase: 'paused', error: `PR #${pr.number}: ${current.operation.kind} outcome is unknown. Check GitHub and Orca before retrying.`,
    }))
  }
  if (state.worker) {
    const worker = workerStatus(root, state.worker)
    if (worker.liveness === 'live') return state
    if (!worker.ended && Date.now() - state.workerAt < fixInterval) return state
    if (!worker.ended) {
      return boundUpdate(file, state, current => ({ ...current, phase: 'paused', error: `PR #${pr.number}: Orca cannot prove worker ${state.worker} exited and released (liveness ${worker.liveness || 'unverifiable'}, terminal ${worker.terminal || 'unobserved'}). Run orca orchestration worker-show --dispatch ${state.worker} --json before retrying.` }))
    }
    if (state.workerHead === pr.headRefOid && state.step !== 'awaiting-head') {
      return boundUpdate(file, state, current => settled(current, pr.number, 'blocked', `worker ${state.worker} ended before a new head was available`, pr.headRefOid))
    }
    state = boundUpdate(file, state, current => ({ ...current, worker: null, step: state.step === 'awaiting-head' ? 'awaiting-head' : 'checks' }))
  }
  if (state.step === 'awaiting-head' && state.workerHead === pr.headRefOid) {
    const elapsed = Date.now() - (state.reportedAt ?? 0)
    if (elapsed < fixInterval) return boundUpdate(file, state, current => ({ ...current, nextAt: Date.now() + checkInterval }))
    return boundUpdate(file, state, current => settled(current, pr.number, 'blocked', 'reported push did not change the PR head', pr.headRefOid))
  }
  const ci = checks(pr)
  if (!pr.isDraft && !ci.red.length && !ci.pending.length && pr.mergeStateStatus === 'CLEAN') {
    if (state.noMerge || !mayMerge(readProject(root).projectLevel)) {
      return boundUpdate(file, state, current => settled(current, pr.number, 'awaiting-human', 'checks are green, waiting for a human merge', pr.headRefOid))
    }
    return performMerge(root, file, state, pr)
  }
  if ((ci.pending.length && !ci.red.length) || pr.mergeStateStatus === 'UNKNOWN') {
    return boundUpdate(file, state, current => ({
      ...current, current: pr.number, step: 'checks', nextAt: Date.now() + checkInterval,
      log: logEntry(current, `PR #${pr.number}: waiting for ${ci.pending.join(', ') || 'GitHub merge state'} on ${pr.headRefOid}`),
    }))
  }
  const summary = ci.red.length ? `Failing checks: ${ci.red.join(', ')}.` : `PR status: ${pr.isDraft ? 'draft' : pr.mergeStateStatus}.`
  return dispatch(root, file, state, pr, summary)
}

async function view(root, state) {
  const title = `Pull request queue${state.repo ? ` for ${state.repo}` : ''}`
  const actions = [
    ...(state.phase === 'running' ? [{ id: 'fix-prs.pause', label: 'Pause' }] : []),
    ...(state.phase === 'paused' ? [{ id: 'fix-prs.resume', label: 'Resume' }] : []),
    ...state.queue.map(pr => ({
      id: state.outcomes[pr.number] ? 'fix-prs.retry' : 'fix-prs.skip',
      label: `${state.outcomes[pr.number] ? 'Retry' : 'Skip'} #${pr.number}`,
      input: { pr: pr.number },
    })),
  ]
  const data = {
    title,
    status: [state.phase, state.current && `PR #${state.current}`, state.step, state.error].filter(Boolean).join(' · '),
    sections: [
      { title: 'Pull requests', rows: state.queue.map(pr => ({ label: `#${pr.number} ${pr.title}`, value: state.outcomes[pr.number]?.detail || (state.current === pr.number ? state.step : 'queued') })) },
      { title: 'Recent activity', rows: state.log.slice(-10).map(item => ({ label: new Date(item.at).toISOString(), value: item.entry })) },
    ],
    actions,
  }
  await publishPanel('fix-all-prs', data, { cwd: root })
  return { ...state, text: renderPanel(data) }
}

export async function tickFixPrs(root, { render = true } = {}) {
  const file = storage(root)
  if (!existsSync(file)) return null
  const current = readQueue(file)
  try {
    const result = runTick(root, file, current)
    if (result === current) return null
    if (result.failures && !result.operation && result.phase === 'running') {
      const reset = boundUpdate(file, result, state => ({ ...state, failures: 0, error: null }))
      return render ? view(root, reset) : reset
    }
    return render ? view(root, result) : result
  } catch (error) {
    if (error.code === 5) throw error
    const state = update(file, value => {
      const failures = (value.failures ?? 0) + 1
      return {
        ...value, failures, error: error.message,
        phase: value.operation ? 'paused' : value.phase,
        nextAt: Date.now() + Math.min(30 * minute, minute * 2 ** Math.min(failures - 1, 10)),
        log: logEntry(value, error.message),
      }
    })
    if (render) await view(root, state)
    throw error
  }
}

function prNumber(input, repair) {
  if (!/^[1-9]\d*$/.test(input ?? '') || !Number.isSafeInteger(Number(input))) {
    throw new CliError(2, `Invalid pull request number ${JSON.stringify(input)}.`, { repair })
  }
  return Number(input)
}

function inspectCurrent(root, state, pr) {
  if (pr !== state.current) return
  if (state.operation) {
    throw new CliError(1, `PR #${pr} has ${state.operation.kind} operation ${state.operation.id} in progress or with an unknown outcome.`, {
      repair: 'Check the GitHub pull request and Orca dispatch receipts before changing the queue.',
    })
  }
  if (!state.worker) return
  const worker = workerStatus(root, state.worker)
  if (!worker.ended) {
    throw new CliError(1, `PR #${pr} worker ${state.worker} is not proven exited and released (liveness ${worker.liveness || 'unverifiable'}, terminal ${worker.terminal || 'unobserved'}).`, {
      repair: `Wait for it or stop it with orca orchestration worker-stop --dispatch ${state.worker}, confirm with orca orchestration worker-show --dispatch ${state.worker} --json, then retry.`,
    })
  }
}

export async function runFixPrs([verb, ...argv]) {
  const repair = `ndev fix-prs ${verb} --help`
  const options = verb === 'start' ? { 'no-merge': { type: 'boolean' } } : verb === 'report' ? { reason: { type: 'string' }, worktree: { type: 'string' } } : {}
  const max = verb === 'report' ? 2 : ['skip', 'retry'].includes(verb) ? 1 : 0
  const { values, positionals } = argsFor(argv, options, repair, { positionals: max })
  const currentWorktree = gitWorkspace()
  const target = values.worktree ? gitWorkspace(values.worktree) : currentWorktree
  if (target.commonDir !== currentWorktree.commonDir) {
    throw new CliError(1, `The queue worktree ${target.root} is in a different clone.`, { repair })
  }
  const { root } = target
  const file = storage(root)
  if (verb === 'status') return view(root, readQueue(file))
  if (verb === 'start') {
    const repo = repository(root)
    const queue = loadPulls(root, repo)
    update(file, current => {
      if (current.operation || current.worker) throw new CliError(1, `PR #${current.current} still has work in progress.`, { repair: 'Use ndev fix-prs status to inspect the current operation.' })
      return { ...initial(), phase: 'running', repo, queue, noMerge: !!values['no-merge'], log: logEntry(initial(), 'Started the queue') }
    })
    return (await tickFixPrs(root)) ?? view(root, readQueue(file))
  }
  const before = readQueue(file)
  if (verb === 'retry' || verb === 'skip') inspectCurrent(root, before, prNumber(positionals[0], repair))
  const state = boundUpdate(file, before, current => {
    if (current.phase === 'idle') throw new CliError(1, 'The PR queue has not started.', { repair: 'Run ndev fix-prs start.' })
    if (verb === 'pause') return { ...current, phase: 'paused', log: logEntry(current, 'Paused') }
    if (verb === 'resume') return { ...current, phase: 'running', nextAt: 0, log: logEntry(current, 'Resumed') }
    const pr = prNumber(positionals[0], repair)
    if (verb === 'report' && pr !== current.current) {
      throw new CliError(1, `PR #${pr} is not the current PR${current.current ? ` #${current.current}` : ''}.`, { repair: 'Run ndev fix-prs status.' })
    }
    if (!current.queue.some(entry => entry.number === pr)) throw new CliError(1, `PR #${pr} is not in the queue.`, { repair: 'Run ndev fix-prs status.' })
    if (verb === 'retry') {
      const outcomes = { ...current.outcomes }
      delete outcomes[pr]
      return {
        ...current, outcomes, phase: 'running', failures: 0, nextAt: 0, error: null,
        ...(current.current === pr ? { current: null, operation: null, worker: null, step: null } : {}),
        log: logEntry(current, `PR #${pr}: retry requested`),
      }
    }
    if (verb === 'skip') {
      if (pr === current.current) return settled({ ...current, nextAt: 0 }, pr, 'skipped', 'skipped by the operator')
      return { ...current, outcomes: { ...current.outcomes, [pr]: { kind: 'skipped', detail: 'skipped by the operator' } } }
    }
    const outcome = positionals[1]
    if (!['pushed', 'blocked'].includes(outcome) || (outcome === 'blocked' && !values.reason)) {
      throw new CliError(2, 'Report pushed, or blocked with --reason <text>.', { repair })
    }
    if (outcome === 'blocked') return settled(current, pr, 'blocked', values.reason)
    return { ...current, step: 'awaiting-head', nextAt: 0, reportedAt: Date.now(), log: logEntry(current, `PR #${pr}: worker reported push`) }
  })
  if (verb === 'resume' || verb === 'retry' || verb === 'report' && positionals[1] === 'pushed') {
    return (await tickFixPrs(root)) ?? view(root, state)
  }
  return view(root, state)
}
