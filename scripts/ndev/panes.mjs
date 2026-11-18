import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { copyFromMain, createFile, inspectWorkspace, mainCheckout, NDEV_FILES, WORKTREE_FILE } from '../../orca-plugin/ndev/worker/files.mjs'
import { forgetEntry, readResources, stopAllResources, stopDevServer, stopDocker } from '../../orca-plugin/ndev/worker/resources.mjs'
import { run } from './common.mjs'

const exec = promisify(execFile)
const SCHEMA_VERSION = 1
const PANEL_NAMES = {
  files: 'ndev Files',
  interview: 'Interview',
  view: 'Worktree view',
  'walk-doc': 'Walk-doc',
  triage: 'Triage',
  'fix-all-prs': 'Fix all PRs',
  'responsive-matrix': 'Responsive matrix',
}
const MODES = ['light', 'heavy', 'hack']
const STEERING = ['interactive', 'auto']
const SCHEMES = ['light', 'dark']
const VIEWPORTS = ['390x844', '820x1180', '1440x900']
const LOGIN = /^https?:\/\/(?:[^/?#]*\.)?(?:login|signin|accounts|auth|sso)\.|\/(?:login|log-in|signin|sign-in|sso|auth)(?=[/?#]|$)/i

function paneError(message, { code = 1, kind = 'panel_error', repair, details } = {}) {
  return Object.assign(new Error(message), { code, kind, errorCode: kind, repair, details })
}

const usage = line => paneError(`Usage: ndev pane ${line}`, { code: 2, kind: 'invalid_input' })
const invalid = message => paneError(message, { code: 2, kind: 'invalid_input' })
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const row = (label, value) => ({ label, value: String(value) })
const section = (title, rows) => ({ title, rows })
const remoteEnvironment = env => Boolean(env.SSH_CONNECTION || env.ORCA_REMOTE_PAIRING || env.ORCA_PAIRING_CODE ||
  (env.ORCA_ENVIRONMENT && env.ORCA_ENVIRONMENT !== 'local'))
const belongsTo = (root, file) => {
  const rel = relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function panelName(panelId) {
  if (!Object.hasOwn(PANEL_NAMES, panelId)) throw invalid(`Unknown panel "${panelId}".`)
  return PANEL_NAMES[panelId]
}

async function command(binary, args, options = {}) {
  try {
    return await exec(binary, args, { cwd: options.cwd, env: options.env, timeout: options.timeout ?? 30_000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const label = [binary, ...args.slice(0, 3)].join(' ')
    throw paneError(`${label} failed (exit ${error.code ?? error.signal ?? 'unknown'}): ${(error.stderr || error.stdout || error.message).trim()}`, { details: { exit: error.code, stdout: error.stdout, stderr: error.stderr } })
  }
}

async function scopeFor({ cwd = process.cwd(), env = process.env } = {}) {
  const { stdout } = await command('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd, env })
  const [folder, gitFolder] = stdout.trimEnd().split('\n')
  const [root, gitDir] = await Promise.all([realpath(folder), realpath(gitFolder)])
  const home = env.HOME || homedir()
  const worktreeId = createHash('sha256').update(root).update('\0').update(gitDir).digest('hex')
  const state = remoteEnvironment(env)
    ? join(gitDir, 'ndev-state', 'panels')
    : join(resolve(env.XDG_STATE_HOME || join(home, '.local', 'state')), 'ndev', 'panels', worktreeId)
  return { root, gitDir, worktreeId, home, state, env }
}

async function jsonFile(file, optional = false) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined
    throw paneError(`Could not read ${file}: ${error.message}`, { details: { path: file } })
  }
}

async function readSnapshot(scope, panelId) {
  const file = join(scope.state, `${panelId}.json`)
  const result = await jsonFile(file, true)
  if (result === undefined) return undefined
  if (result?.schemaVersion !== SCHEMA_VERSION || result.worktreeId !== scope.worktreeId ||
    result.panelId !== panelId || !Number.isSafeInteger(result.revision) || result.revision < 1 || !record(result.data)) {
    throw paneError(`Invalid panel snapshot in ${file} for ${panelId}.`, { repair: `Move the invalid snapshot out of ${scope.state} and refresh the panel.` })
  }
  return result
}

async function withLock(scope, name, callback) {
  await mkdir(scope.state, { recursive: true, mode: 0o700 })
  const lock = join(scope.state, `${name}.lock`)
  for (let attempt = 0;; attempt += 1) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (attempt === 100) {
        const owner = await readFile(lock, 'utf8').catch(error => error.message)
        throw paneError(`Panel ${name} is locked by ${owner.trim()} (${lock}).`, {
          repair: `Check the recorded process and remove ${lock} if the process has exited.`,
        })
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try {
    return await callback()
  } finally {
    await rm(lock)
  }
}

async function saveSnapshot(scope, panelId, data, { force = false } = {}) {
  panelName(panelId)
  if (!record(data)) throw invalid(`Snapshot data for ${panelId} must be an object.`)
  const serialized = JSON.stringify(data)
  const normalized = JSON.parse(serialized)
  return await withLock(scope, panelId, async () => {
    const previous = await readSnapshot(scope, panelId)
    if (panelId === 'triage' && previous?.data.triage?.revision > normalized.triage?.revision) return previous
    if (!force && previous && isDeepStrictEqual(previous.data, normalized)) return previous
    const snapshot = {
      ...previous,
      schemaVersion: SCHEMA_VERSION,
      worktreeId: scope.worktreeId,
      panelId,
      revision: (previous?.revision ?? 0) + 1,
      data: normalized,
    }
    const target = join(scope.state, `${panelId}.json`)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true })
    }
    return snapshot
  })
}

export async function publishPanel(panelId, data, options = {}) {
  return await saveSnapshot(await scopeFor(options), panelId, data)
}

export function renderPanel(data) {
  const lines = [data.title, data.status]
  for (const group of data.sections ?? []) {
    lines.push(group.title, ...(group.rows ?? []).map(item => `${item.label}: ${item.value}`))
  }
  for (const question of data.questions ?? []) {
    lines.push([question.id, question.question ?? question.prompt ?? question.label ?? question.text].filter(Boolean).join(' '))
    for (const option of question.options ?? question.choices ?? []) {
      lines.push(`  ${typeof option === 'string' ? option : [option.id, option.label, option.description].filter(Boolean).join(' ')}`)
    }
  }
  for (const action of data.actions ?? []) lines.push(`Action: ${action.label ?? action.id}`)
  return lines.filter(Boolean).join('\n')
}

function orcaBinary(env) {
  return env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' && !env.ORCA_TERMINAL_HANDLE ? 'orca-ide' : 'orca')
}

async function orcaCommand(scope, args, options) {
  if (options.orca) return await options.orca(args, { cwd: scope.root })
  const binary = orcaBinary(scope.env)
  let stdout
  let failed
  try {
    ;({ stdout } = await command(binary, [...args, '--json'], { cwd: scope.root, env: scope.env, timeout: 75_000 }))
  } catch (error) {
    failed = error
    stdout = error.details?.stdout
  }
  let reply
  try {
    reply = stdout ? JSON.parse(stdout) : undefined
  } catch (error) {
    if (!failed) throw paneError(`${binary} ${args[0]} returned invalid JSON: ${error.message}`, { details: { stdout } })
  }
  if (failed || reply?.ok !== true) {
    if (!reply?.error && failed) throw failed
    const failure = reply?.error ?? {}
    throw paneError(`${binary} ${args.join(' ')} failed (exit ${failed?.details?.exit ?? 0}, ${failure.code ?? 'invalid_reply'}): ${failure.message ?? stdout ?? 'No response'}`, {
      kind: failure.code ?? 'orca_failed',
      repair: failure.data?.command,
      details: failure.data,
    })
  }
  return reply.result
}

async function openSnapshot(scope, snapshot, options) {
  const fallback = renderPanel(snapshot.data)
  let status
  try {
    status = await orcaCommand(scope, ['status'], options)
    const desktop = status?.app?.desktopWindowStatus
    if ((desktop && desktop !== 'available') || (status?.target?.kind && status.target.kind !== 'local') || status?.app?.running === false) {
      return { text: fallback, snapshot, opened: false }
    }
    const active = (await orcaCommand(scope, ['worktree', 'show', '--worktree', 'active'], options))?.worktree
    const local = active && (!active.hostId || active.hostId === 'local')
    const activeRoot = local && active.path ? await realpath(active.path).catch(error => { if (error.code !== 'ENOENT') throw error }) : null
    if (activeRoot !== scope.root) {
      return { text: `Select ${basename(scope.root)} (${scope.root}) in Orca to open ${panelName(snapshot.panelId)}.\n${fallback}`, snapshot, opened: false }
    }
    await orcaCommand(scope, ['plugin', 'open', 'neilellis.ndev', '--panel', snapshot.panelId], options)
    return { text: fallback, snapshot, opened: true }
  } catch (error) {
    if (error.kind === 'no_workspace' || error.kind === 'worktree_not_found') {
      return { text: `Select ${basename(scope.root)} (${scope.root}) in Orca to open ${panelName(snapshot.panelId)}.\n${fallback}`, snapshot, opened: false }
    }
    error.details = { ...error.details, text: fallback }
    throw error
  }
}

export async function showPanel(panelId, data, options = {}) {
  const scope = await scopeFor(options)
  const snapshot = await saveSnapshot(scope, panelId, data)
  return options.open ? await openSnapshot(scope, snapshot, options) : { text: renderPanel(snapshot.data), snapshot, opened: false }
}

async function localFile(root, file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw invalid(`Path "${file}" is outside ${root}.`)
  let actual
  try {
    actual = await realpath(file)
  } catch (error) {
    throw paneError(`Could not resolve ${file}: ${error.message}`)
  }
  if (!belongsTo(root, actual)) throw invalid(`Path "${file}" resolves outside ${root} to ${actual}.`)
  return actual
}

async function workspaceFile(root, name) {
  const file = join(root, name)
  try {
    if (!(await lstat(file)).isFile()) throw invalid(`Use a regular file for ${file}.`)
    return file
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function workspaceData(scope) {
  await Promise.all(NDEV_FILES.map(name => workspaceFile(scope.root, name)))
  const [inspected, rawResources] = await Promise.all([inspectWorkspace(scope.root), readResources(scope.root)])
  const resources = {
    ...rawResources,
    docker: rawResources.docker.map(({ kind, projectId, status, problem, workdir, addedAt, cliVersion }) => ({ kind, projectId, status, problem, workdir, addedAt, cliVersion })),
    devServers: rawResources.devServers.map(({ name, port, pid, status, started }) => ({ name, port, pid, status, started })),
  }
  return { ...inspected, resources }
}

function resourceSections({ docker, devServers, problem }) {
  return [
    section('Dev servers', devServers.map(server => row(server.name, `port ${server.port} · pid ${server.pid} · ${server.status}`))),
    section('Docker stacks', docker.map(stack => row(stack.projectId, [stack.kind, stack.status, stack.problem].filter(Boolean).join(' · ')))),
    ...(problem ? [section('Resource error', [row(WORKTREE_FILE, problem)])] : []),
  ]
}

async function filesData(scope) {
  const workspace = await workspaceData(scope)
  const files = workspace.files.map(file => row(file.name, file.exists ? [file.summary, file.problem, `mode ${file.mode}`].filter(Boolean).join(' · ') : 'Missing'))
  return {
    title: PANEL_NAMES.files,
    status: scope.root,
    sections: [section('Files', files), ...resourceSections(workspace.resources)],
    workspace,
  }
}

async function viewData(scope) {
  const data = await filesData(scope)
  const files = await readdir(scope.root)
  const workflow = files.filter(file => /^\.neil-dev\.(issue|pr)-[1-9][0-9]*\.json$/.test(file)).sort()
  const [branch, main, worktree, workflows] = await Promise.all([
    command('git', ['branch', '--show-current'], { cwd: scope.root, env: scope.env }),
    realpath(await mainCheckout(scope.root)),
    workspaceFile(scope.root, WORKTREE_FILE).then(file => file && jsonFile(file)),
    Promise.all(workflow.map(async file => {
      const saved = await jsonFile(await workspaceFile(scope.root, file))
      if (!record(saved)) throw paneError(`Invalid workflow record ${join(scope.root, file)}.`)
      const [, kind, number] = file.match(/\.(issue|pr)-([0-9]+)\.json$/)
      const flow = saved.workflow ?? saved
      const review = flow.hooks?.review ?? flow.reviewSpec
      const state = flow.state ?? (saved.chatRound ? 'interview pending' : Array.isArray(saved.rounds) ? 'interview record' : 'workflow state not set')
      const details = [state, Number.isSafeInteger(flow.pr) && `PR #${flow.pr}`, review && (review.answer === undefined ? 'review pending' : 'review answered')]
      return row(`${kind === 'issue' ? 'Issue' : 'PR'} #${number}`, details.filter(Boolean).join(' · '))
    })),
  ])
  const [project, checkout] = await Promise.all([...new Set([main, scope.root])].map(async root => {
    const file = await workspaceFile(root, '.neil-dev.json')
    return file ? await jsonFile(file) : {}
  }))
  const settings = { ...project, ...checkout, ...worktree?.settings }
  return {
    title: PANEL_NAMES.view,
    status: scope.root,
    sections: [
      section('Settings', [
        row('Branch', branch.stdout.trim() || '(detached)'),
        row('Mode', MODES.includes(settings.mode) ? settings.mode : 'light'),
        row('Steering', STEERING.includes(settings.steering) ? settings.steering : 'interactive'),
      ]),
      section('Workflow and review', workflows),
      ...data.sections,
    ],
  }
}

async function responsiveData(scope) {
  const cache = scope.env.RESPONSIVE_CHECK_STATE_DIR || join(scope.home, '.cache', 'ndev', 'responsive-check')
  const pointerFile = join(cache, 'latest.json')
  const pointer = await jsonFile(pointerFile, true)
  const title = PANEL_NAMES['responsive-matrix']
  const empty = { title, status: 'No responsive check is recorded for this worktree.', sections: [] }
  if (!pointer) return empty
  if (!record(pointer) || typeof pointer.cwd !== 'string' || typeof pointer.progress !== 'string') {
    throw paneError(`Invalid responsive run pointer at ${pointerFile}.`, { repair: 'Run the responsive-check skill again.' })
  }
  const owner = await realpath(pointer.cwd).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!owner || !belongsTo(scope.root, owner)) return (await readSnapshot(scope, 'responsive-matrix'))?.data ?? empty
  const progressPath = await localFile(scope.root, pointer.progress)
  const progress = await jsonFile(progressPath)
  if (!record(progress) || !Array.isArray(progress.cells) || typeof progress.state !== 'string') {
    throw paneError(`Invalid responsive progress at ${progressPath}.`, { repair: 'Run the responsive-check skill again.' })
  }
  const evidencePath = async file => {
    if (!file) return undefined
    return await localFile(scope.root, file)
  }
  const report = await evidencePath(progress.report)
  const results = report ? (await jsonFile(report))?.cells : []
  if (!Array.isArray(results)) throw paneError(`Invalid responsive report at ${report}.`)
  const cellKey = cell => JSON.stringify([cell?.route, cell?.viewport, cell?.scheme])
  const resultByCell = new Map(results.map(cell => [cellKey(cell), cell]))
  const cells = await Promise.all(progress.cells.map(async cell => {
    if (typeof cell?.route !== 'string' || typeof cell.viewport !== 'string' || !SCHEMES.includes(cell.scheme) || typeof cell.status !== 'string') {
      throw paneError(`Invalid responsive cell in ${progressPath}.`)
    }
    return {
      route: cell.route,
      viewport: cell.viewport,
      scheme: cell.scheme,
      status: cell.status,
      errors: cell.errors,
      warnings: cell.warnings,
      screenshot: await evidencePath(cell.screenshot ?? resultByCell.get(cellKey(cell))?.screenshot),
    }
  }))
  const findings = new Map()
  for (const cell of results) {
    for (const finding of cell?.findings ?? []) {
      if (typeof finding?.check !== 'string' || typeof finding.selector !== 'string' || typeof finding.detail !== 'string') {
        throw paneError(`Invalid finding in responsive report ${report}.`)
      }
      const key = JSON.stringify([finding.check, finding.selector])
      const previous = findings.get(key)
      findings.set(key, { ...finding, count: (previous?.count ?? 0) + 1 })
    }
  }
  const top = [...findings.values()]
    .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || b.count - a.count)
    .slice(0, 6)
  const rows = cells.map(cell => row(`${cell.route} · ${cell.viewport} · ${cell.scheme}`, [cell.status, cell.errors ? `${cell.errors} errors` : '', cell.warnings ? `${cell.warnings} warnings` : '', cell.screenshot].filter(Boolean).join(' · ')))
  return {
    title,
    status: [progress.state, progress.base, progress.error].filter(Boolean).join(' · '),
    sections: [
      section('Run', [row('Progress', progressPath), ...(report ? [row('Report', report)] : [])]),
      section('Viewport results', rows),
      ...(top.length ? [section('Findings', top.map(finding => row(`${finding.check} · ${finding.selector}`, `${finding.detail} (${finding.count} cells)`)))] : []),
    ],
    cells,
  }
}

const LIVE_DATA = { files: filesData, view: viewData, 'responsive-matrix': responsiveData }

async function refresh(scope, panelId) {
  const title = panelName(panelId)
  const source = Object.hasOwn(LIVE_DATA, panelId) && LIVE_DATA[panelId]
  if (source) return await saveSnapshot(scope, panelId, await source(scope))
  const previous = await readSnapshot(scope, panelId)
  if (panelId === 'triage') {
    const { readTriagePanel } = await import('./triage.mjs')
    const data = readTriagePanel(scope.root, scope.env)
    if (previous?.data.triage?.revision === data.triage.revision) return previous
    return await saveSnapshot(scope, panelId, data)
  }
  return previous ?? await saveSnapshot(scope, panelId, { title, status: 'No run is recorded for this worktree.', sections: [] })
}

export async function refreshPanel(panelId, options = {}) {
  return await refresh(await scopeFor(options), panelId)
}

const LOGICAL_POLICY = ['stop-keep-data', 'stop-and-delete']
const FILE_ACTIONS = {
  'file.create': (scope, { name }) => createFile(scope.root, name),
  'file.copyFromMain': async (scope, { name }) => {
    await workspaceFile(await realpath(await mainCheckout(scope.root)), name)
    return await copyFromMain(scope.root, name)
  },
  'resources.stopServer': (scope, { name }, { devServers }) =>
    stopDevServer(scope.root, name, { expectedServer: devServers.find(server => server.name === name) }),
  'resources.stopStack': (scope, { projectId, policy }, { docker }) =>
    stopDocker(scope.root, projectId, policy, { expectedStack: docker.find(stack => stack.projectId === projectId), worktreeOnly: true }),
  'resources.stopAll': (scope, { policy }, expectedResources) =>
    stopAllResources(scope.root, policy, { expectedResources, worktreeOnly: true }),
  'resources.forget': (scope, { type, id }) => forgetEntry(scope.root, type === 'docker' ? { type, projectId: id } : { type, name: id }),
}

function typed(input, fields) {
  if (!record(input)) throw invalid('Panel action input must be an object.')
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) throw invalid(`Unexpected panel action input "${key}".`)
  }
  for (const [key, check] of Object.entries(fields)) {
    if (!check(input[key])) throw invalid(`Invalid panel action input "${key}": ${JSON.stringify(input[key])}.`)
  }
  return input
}

const nonempty = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
const identifier = value => nonempty(value) && /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const writableFile = value => NDEV_FILES.includes(value) && value !== WORKTREE_FILE
const optional = check => value => value === undefined || check(value)
const choice = (...values) => value => values.includes(value)

const FILE_INPUT = {
  'file.create': { name: writableFile },
  'file.copyFromMain': { name: writableFile },
  'resources.stopServer': { name: identifier },
  'resources.stopStack': { projectId: identifier, policy: choice(...LOGICAL_POLICY) },
  'resources.stopAll': { policy: choice(...LOGICAL_POLICY, 'keep-running') },
  'resources.forget': { type: choice('docker', 'dev-server'), id: identifier },
}

const CLI_ACTIONS = {
  'interview.answer': {
    panel: 'interview',
    fields: { issue: positive, roundId: nonempty, answers: record },
    args: input => ['flow', 'interview', '--issue', String(input.issue), '--answers-file', '-'],
    stdin: input => JSON.stringify(input.answers),
  },
  'walk.ask': { panel: 'walk-doc', fields: { question: nonempty }, args: input => ['walk-doc', 'ask', input.question] },
  'walk.answer': { panel: 'walk-doc', fields: { number: positive, text: nonempty }, args: input => ['walk-doc', 'answer', String(input.number), input.text] },
  'walk.restart': { panel: 'walk-doc', fields: { note: optional(nonempty) }, args: input => ['walk-doc', 'restart', ...(input.note ? [input.note] : [])] },
  'walk.tip': { panel: 'walk-doc', fields: { text: nonempty }, args: input => ['walk-doc', 'tip', input.text] },
  'walk.stop': { panel: 'walk-doc', fields: {}, args: () => ['walk-doc', 'stop'] },
  'triage.launch': { panel: 'triage', fields: {}, args: () => ['triage', 'launch'] },
  'triage.refresh': { panel: 'triage', fields: {}, args: () => ['triage', 'refresh'] },
  'triage.workspace': { panel: 'triage', fields: { lead: positive } },
  'triage.confirm': {
    panel: 'triage',
    fields: { issue: positive, revision: positive, decision: choice('close', 'keep') },
    args: input => ['triage', 'confirm', '--issue', String(input.issue), '--revision', String(input.revision), input.decision],
  },
  'fix-prs.pause': { panel: 'fix-all-prs', fields: {}, args: () => ['fix-prs', 'pause'] },
  'fix-prs.resume': { panel: 'fix-all-prs', fields: {}, args: () => ['fix-prs', 'resume'] },
  'fix-prs.skip': { panel: 'fix-all-prs', fields: { pr: positive }, args: input => ['fix-prs', 'skip', String(input.pr)] },
  'fix-prs.retry': { panel: 'fix-all-prs', fields: { pr: positive }, args: input => ['fix-prs', 'retry', String(input.pr)] },
}

export async function confirmPanelAction(binding, options = {}) {
  if (!record(binding) || !nonempty(binding.worktreeId) || !nonempty(binding.action) || !positive(binding.revision) || binding.target === undefined) {
    throw invalid('Confirmation requires a worktree, action, target and revision.')
  }
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  if (options.confirm) return await options.confirm(binding)
  const message = `Confirm ${binding.action} for ${JSON.stringify(binding.target)} in ${cwd}.\nWorktree ${binding.worktreeId}, revision ${binding.revision}.`
  if (process.platform === 'darwin' && !remoteEnvironment(env)) {
    const dialog = [
      'on run argv',
      'try',
      'set answer to display dialog (item 1 of argv) with title "Confirm ndev action" buttons {"Cancel", "Confirm"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 120',
      'if gave up of answer then return "cancelled"',
      'return button returned of answer',
      'on error number -128',
      'return "cancelled"',
      'end try',
      'end run',
    ].join('\n')
    const result = await command('/usr/bin/osascript', ['-e', dialog, message], { cwd, env, timeout: 125_000 })
    return result.stdout.trim() === 'Confirm'
  }
  if (process.platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    const result = run('/usr/bin/zenity', ['--question', '--title=Confirm ndev action', '--text', message, '--timeout=120', '--default-cancel'], { cwd, env, timeout: 125_000 })
    if (result.status === 0) return true
    if ([1, 5].includes(result.status)) return false
    throw paneError(`Could not display the ndev confirmation (exit ${result.status}): ${result.stderr.trim()}`, { repair: 'Install zenity and retry from the desktop.' })
  }
  throw paneError('This action requires a native desktop confirmation.', { kind: 'confirmation_required', repair: 'Run the command from a supported desktop.' })
}

function assertCurrent(snapshot, scope, expected) {
  if (expected.worktreeId !== scope.worktreeId) throw invalid('This action belongs to a different worktree.')
  if (expected.expectedRevision !== snapshot.revision) {
    throw paneError(`Expected revision ${expected.expectedRevision}; the current revision is ${snapshot.revision}. Refresh the panel and try again.`, { code: 5, kind: 'stale_revision' })
  }
}

async function cliAction(scope, actionId, action, input, options) {
  const args = action.args(input)
  if (options.ndev) return options.ndev(args, { cwd: scope.root, input: action.stdin?.(input) })
  if (actionId === 'triage.confirm') {
    const { runTriage } = await import('./triage.mjs')
    return await runTriage(args.slice(1), { cwd: scope.root, json: false })
  }
  const cli = process.argv[1]
  if (!cli) throw paneError(`No ndev executable is available to run ${actionId}.`, { repair: 'Run the installed ndev CLI.' })
  const result = run(process.execPath, [cli, '--json', ...args], {
    cwd: scope.root,
    env: scope.env,
    input: action.stdin?.(input),
    timeout: 120_000,
  })
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    if (!result.status) throw paneError(`ndev ${args.slice(0, 2).join(' ')} returned invalid JSON for ${actionId}: ${error.message}`, { details: result })
  }
  if (result.status || parsed?.ok === false) {
    throw paneError(`ndev ${args.slice(0, 2).join(' ')} failed for ${actionId} (exit ${result.status}): ${parsed?.error?.message || result.stderr.trim() || result.stdout.trim()}`, {
      repair: parsed?.error?.repair,
      details: parsed?.error?.details,
    })
  }
  return parsed?.result ?? parsed
}

async function executeFileAction(scope, snapshot, actionId, input, options) {
  if (input.policy && input.policy !== 'keep-running') {
    const { docker } = snapshot.data.workspace.resources
    const targets = actionId === 'resources.stopStack' ? docker.filter(stack => stack.projectId === input.projectId) : docker
    for (const stack of targets) {
      if (stack.workdir) await localFile(scope.root, stack.workdir)
      if (!identifier(stack.projectId) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(stack.cliVersion)) {
        throw invalid(`Docker stack "${stack.projectId}" has an invalid project ID or CLI version.`)
      }
    }
  }
  if (input.policy === 'stop-and-delete') {
    const binding = { worktreeId: scope.worktreeId, action: actionId, target: input, revision: snapshot.revision }
    if (!await confirmPanelAction(binding, { ...options, cwd: scope.root })) throw paneError(`Confirmation declined for ${actionId}.`, { kind: 'confirmation_declined' })
    const current = await refresh(scope, 'files')
    assertCurrent(current, scope, { worktreeId: binding.worktreeId, expectedRevision: binding.revision })
  }
  const result = await FILE_ACTIONS[actionId](scope, input, snapshot.data.workspace.resources)
  const current = await refresh(scope, 'files')
  const failed = Array.isArray(result) && result.filter(outcome => !outcome.ok)
  if (failed?.length) {
    throw paneError(`Resources could not be stopped:\n${failed.map(failure => `${failure.id}: ${failure.error}`).join('\n')}`, {
      details: { outcomes: result, snapshot: current },
    })
  }
  return { result, snapshot: current }
}

async function bridgeAction(scope, panelId, payload, options) {
  panelName(panelId)
  const request = typed(payload, { worktreeId: nonempty, expectedRevision: positive, actionId: nonempty, input: record })
  const { actionId } = request
  const fileAction = panelId === 'files' && Object.hasOwn(FILE_ACTIONS, actionId)
  const cli = Object.hasOwn(CLI_ACTIONS, actionId) && CLI_ACTIONS[actionId]
  if (!fileAction && (!cli || cli.panel !== panelId)) throw invalid(`Unknown action "${actionId}" for ${panelId}.`)
  const input = typed(request.input, fileAction ? FILE_INPUT[actionId] : cli.fields)
  return await withLock(scope, `${panelId}.action`, async () => {
    const current = await refresh(scope, panelId)
    assertCurrent(current, scope, request)
    if (fileAction) return await executeFileAction(scope, current, actionId, input, options)
    const advertised = current.data.actions?.find(action => action.id === actionId &&
      Object.entries(action.input ?? {}).every(([name, value]) => isDeepStrictEqual(input[name], value)))
    if (!advertised) throw invalid(`Action "${actionId}" is not available for this target. Refresh the panel.`)
    if (actionId === 'triage.workspace') {
      const workspace = current.data.triage?.groups.find(group => group.lead === input.lead)?.workspace
      if (!workspace) throw invalid(`Group #${input.lead} has no workspace. Refresh the panel.`)
      const selector = workspace.id.startsWith('identity:') || workspace.id.startsWith('id:') ? workspace.id : 'id:' + workspace.id
      const args = ['worktree', 'activate', '--worktree', selector]
      if (workspace.host) args.push('--environment', workspace.host)
      return { result: await orcaCommand(scope, args, options), snapshot: current }
    }
    const result = await cliAction(scope, actionId, cli, input, options)
    let snapshot = await refresh(scope, panelId)
    if (snapshot.revision === current.revision) snapshot = await saveSnapshot(scope, panelId, snapshot.data, { force: true })
    return { result, snapshot }
  })
}

function filesCommand(args) {
  const [verb, name] = args
  if (args.length !== 2 || !['create', 'copy-from-main'].includes(verb)) throw usage('files create|copy-from-main <name>')
  return [verb === 'create' ? 'file.create' : 'file.copyFromMain', { name }]
}

function resourcesCommand(args) {
  const [verb, first, second] = args
  if (verb === 'stop-server' && args.length === 2) return ['resources.stopServer', { name: first }]
  if (verb === 'stop-stack' && args.length === 3 && LOGICAL_POLICY.includes(second)) return ['resources.stopStack', { projectId: first, policy: second }]
  if (verb === 'stop-all' && args.length === 2 && [...LOGICAL_POLICY, 'keep-running'].includes(first)) return ['resources.stopAll', { policy: first }]
  if (verb === 'forget' && args.length === 3) return ['resources.forget', { type: first, id: second }]
  throw usage('resources stop-server <name> | stop-stack <id> <stop-keep-data|stop-and-delete> | stop-all <stop-keep-data|stop-and-delete|keep-running> | forget <type> <id>')
}

function screenshotOptions(args) {
  const [input, ...flags] = args
  const repair = 'screenshot <url> [--viewport <width>x<height>]... [--scheme <light|dark>]... [--full-page] [--wait-seconds <n>]'
  let url
  try {
    url = new URL(input)
  } catch {
    throw usage(repair)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw usage(repair)
  const result = { url: url.href, viewports: [], schemes: [], wait: 0, fullPage: false }
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]
    if (flag === '--full-page') { result.fullPage = true; continue }
    const value = flags[++i]
    if (flag === '--viewport' && /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/.test(value)) result.viewports.push(value)
    else if (flag === '--scheme' && SCHEMES.includes(value)) result.schemes.push(value)
    else if (flag === '--wait-seconds' && /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 60) result.wait = Math.round(Number(value) * 1_000)
    else throw usage(repair)
  }
  result.viewports = result.viewports.length ? [...new Set(result.viewports)] : VIEWPORTS
  result.schemes = result.schemes.length ? [...new Set(result.schemes)] : SCHEMES
  return result
}

async function screenshot(scope, args, options) {
  const settings = screenshotOptions(args)
  const call = (args, page) => orcaCommand(scope, page ? [...args, '--page', page] : args, options)
  const sha = (await command('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: scope.root, env: scope.env })).stdout.trim()
  const folder = join(scope.gitDir, 'ndev-screenshots', sha, randomUUID())
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const result = await call(['tab', 'create', '--url', settings.url])
  const page = result?.browserPageId
  if (!nonempty(page)) throw paneError(`orca tab create did not return a browserPageId for ${settings.url}.`, { details: result })
  let preserveTab = false
  let failure
  const files = []
  const warnings = []
  const evaluate = async expression => (await call(['eval', '--expression', expression], page))?.result
  try {
    await call(['wait', '--load', 'load'], page)
    if (settings.wait) await call(['wait', '--timeout', String(settings.wait)], page)
    const landed = await evaluate('location.href')
    if (!nonempty(landed)) throw paneError(`Orca could not read the URL of browser page ${page}.`)
    if (LOGIN.test(landed.split(/[?#]/)[0]) && !LOGIN.test(settings.url.split(/[?#]/)[0])) {
      preserveTab = true
      throw paneError(`${settings.url} redirected to ${landed}. Page ${page} is open for sign-in.`, {
        kind: 'browser_sign_in_required',
        repair: `Sign in through Orca, retry ndev pane screenshot, then run orca tab close --page ${page}.`,
      })
    }
    for (const scheme of settings.schemes) {
      await call(['exec', '--command', `set media ${scheme}`], page)
      if (String(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches")) !== String(scheme === 'dark')) {
        throw paneError(`Orca did not apply ${scheme} to page ${page}.`)
      }
      for (const view of settings.viewports) {
        const [width, height] = view.split('x')
        await call(['viewport', '--width', width, '--height', height], page)
        if (String(await evaluate('window.innerWidth')) !== width) throw paneError(`Orca did not apply viewport ${view} to page ${page}.`)
        const image = async suffix => {
          const response = await call(['screenshot', '--format', 'png'], page)
          if (!nonempty(response?.path)) throw paneError(`Orca screenshot did not return a file for ${page}, ${view} ${scheme}.`, { details: response })
          const file = join(folder, `${view}-${scheme}${suffix}.png`)
          await copyFile(response.path, file)
          files.push({ view, scheme, file })
        }
        if (!settings.fullPage) {
          await image('')
          continue
        }
        let top = 0
        let previous = -1
        for (let index = 1; index <= 40; index += 1) {
          const dimensions = JSON.parse(await evaluate(`(() => { scrollTo({ top: ${top}, behavior: 'instant' }); return JSON.stringify([scrollY, innerHeight, document.documentElement.scrollHeight]) })()`))
          if (!Array.isArray(dimensions) || dimensions.length !== 3 || !dimensions.every(Number.isFinite)) {
            throw paneError(`Page ${page} did not return valid scroll measurements for ${view}.`)
          }
          const [y, visible, total] = dimensions
          const end = y + visible >= total - 1
          if (y <= previous && !end) {
            warnings.push(`${view} ${scheme} stopped scrolling at ${y + visible} of ${total} pixels.`)
            break
          }
          await image(index === 1 && end ? '' : `-part${index}`)
          if (end) break
          if (index === 40) warnings.push(`${view} ${scheme} reached the 40-image limit at ${y + visible} of ${total} pixels.`)
          previous = y
          top = y + Math.floor(visible * 0.8)
        }
      }
    }
    for (const view of settings.viewports) {
      const light = files.filter(file => file.view === view && file.scheme === 'light')
      const dark = files.filter(file => file.view === view && file.scheme === 'dark')
      if (light.length && light.length === dark.length) {
        const equal = await Promise.all(light.map(async ({ file }, index) => {
          const [a, b] = await Promise.all([readFile(file), readFile(dark[index].file)])
          return a.equals(b)
        }))
        if (equal.every(Boolean)) warnings.push(`${view} has identical light and dark screenshots.`)
      }
    }
  } catch (error) {
    failure = error
  }
  if (!preserveTab) {
    try {
      await call(['tab', 'close'], page)
    } catch (error) {
      throw paneError([failure?.message, `Orca page ${page} did not close: ${error.message}`].filter(Boolean).join('\n'), {
        repair: `orca tab close --page ${page}`,
        details: { files, failure: failure?.details },
      })
    }
  }
  if (failure) throw failure
  return { text: [`Saved ${files.length} screenshot(s) of ${settings.url} at commit ${sha}.`, ...warnings, ...files.map(shot => shot.file)].join('\n'), files, warnings }
}

export async function runPane([verb, ...args], options = {}) {
  try {
    if (verb === 'bridge') {
      const [method, panelId, encoded] = args
      if (method === 'snapshot' && args.length === 2) return await refreshPanel(panelId, options)
      if (method === 'action' && args.length === 3) {
        let payload
        try {
          payload = JSON.parse(encoded)
        } catch (error) {
          throw invalid(`Invalid panel action JSON: ${error.message}`)
        }
        return await bridgeAction(await scopeFor(options), panelId, payload, options)
      }
      throw usage('bridge snapshot <panel> | bridge action <panel> <input-json>')
    }
    if (verb === 'view' || verb === 'responsive-matrix') {
      if (args.length && (args.length !== 1 || args[0] !== '--open')) throw usage(`${verb} [--open]`)
      const scope = await scopeFor(options)
      const snapshot = await refresh(scope, verb)
      return args[0] ? await openSnapshot(scope, snapshot, options) : { text: renderPanel(snapshot.data), snapshot, opened: false }
    }
    if (verb === 'screenshot') return await screenshot(await scopeFor(options), args, options)
    if (verb === 'files' || verb === 'resources') {
      const [actionId, supplied] = verb === 'files' ? filesCommand(args) : resourcesCommand(args)
      const input = typed(supplied, FILE_INPUT[actionId])
      const scope = await scopeFor(options)
      return await withLock(scope, 'files.action', async () => {
        const { result, snapshot } = await executeFileAction(scope, await refresh(scope, 'files'), actionId, input, options)
        return { text: renderPanel(snapshot.data), result, snapshot }
      })
    }
    throw usage('view | responsive-matrix | screenshot | files | resources')
  } catch (error) {
    if (typeof error.code === 'number') {
      error.errorCode ??= error.kind
      throw error
    }
    throw paneError(error.message, { kind: error.code ?? 'panel_error', repair: error.repair, details: error.details })
  }
}
