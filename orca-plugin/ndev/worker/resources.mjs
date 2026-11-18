// The resources a worktree started, as recorded by ndev in .neil-dev.worktree.json (version 2):
//   { "version": 2, "resources": { "docker": [<stack>...], "dev-servers": { "<name>": <server> } } }
// Reading, and stopping one resource at a time. The record format, the lock and the "only kill the
// process we recorded" rule follow ndev's scripts/work/worktree_env.mjs.
import { execFile } from 'node:child_process'
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { NdevError, WORKTREE_FILE } from './files.mjs'

const run = promisify(execFile)
const START_TOLERANCE_MS = 2000 // ps reports the start time to the second
const TAIL_LINES = 40
const STOP_TIMEOUT_MS = Number(process.env.NDEV_STACK_STOP_TIMEOUT_S ?? 180) * 1000
const POLICIES = ['stop-and-delete', 'stop-keep-data', 'keep-running']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v !== ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (text) => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')

async function gitDir(dir) {
  try {
    return (await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir'])).stdout.trim()
  } catch (error) {
    throw new NdevError('git', `git rev-parse --git-dir failed in ${dir} (exit ${error.code}): ${error.stderr || error.message}`.trim())
  }
}

/** The problem with the shape of a parsed record, or undefined. */
function shapeProblem(raw, file) {
  if (!isObject(raw)) return `${file} must hold a JSON object.`
  if (raw.version === 1) {
    return `${file} uses the version 1 layout. Repair: run "worktree-env.sh migrate --worktree ${path.dirname(file)}" from the ndev plugin's scripts/work folder.`
  }
  if (raw.version !== 2) return `${file} has "version" ${JSON.stringify(raw.version)}; this plugin reads version 2.`
  if (!isObject(raw.resources)) return `${file} must hold a "resources" object.`
  const { docker = [], 'dev-servers': servers = {} } = raw.resources
  if (!Array.isArray(docker)) return `${file}: resources.docker must be a list.`
  if (!isObject(servers)) return `${file}: resources.dev-servers must be an object keyed by name.`
  for (const [i, s] of docker.entries()) if (!isObject(s) || !isText(s.kind) || !isText(s.projectId)) return `${file}: resources.docker[${i}] needs "kind" and "projectId".`
  for (const [name, d] of Object.entries(servers)) {
    if (!isObject(d) || !Number.isInteger(d.pid) || !Number.isInteger(d.port) || !isText(d.command) || !isText(d.started)) return `${file}: resources.dev-servers.${name} needs pid, port, command and started.`
  }
  return undefined
}

/** The parsed record, or throws a NdevError that names the file and the repair. */
async function loadWorktreeRecord(dir) {
  const file = path.join(dir, WORKTREE_FILE)
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, resources: { docker: [], 'dev-servers': {} } }
    throw error
  }
  if (!info.isFile()) throw new NdevError('record', `Use a regular file for ${file}.`)
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new NdevError('record', `${file} is not valid JSON (${error.message}). Repair: fix or delete the file; it lists what this worktree started.`)
  }
  const problem = shapeProblem(raw, file)
  if (problem) throw new NdevError('record', problem)
  return { ...raw, resources: { ...raw.resources, docker: raw.resources.docker ?? [], 'dev-servers': raw.resources['dev-servers'] ?? {} } }
}

async function loadRecord(dir) {
  return (await loadWorktreeRecord(dir)).resources
}

/** Command line and start time of a pid, or undefined when no process has it. */
async function processInfo(pid) {
  let stdout
  try {
    ;({ stdout } = await run('ps', ['-ww', '-o', 'etime=', '-o', 'command=', '-p', String(pid)]))
  } catch (error) {
    if (error.code === 1) return undefined // ps exits 1 when no process matches
    throw new NdevError('ps', `ps -p ${pid} failed (exit ${error.code}): ${error.stderr || error.message}`.trim())
  }
  const line = stdout.trim()
  if (line === '') return undefined
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line)
  if (!m) throw new NdevError('ps', `ps -p ${pid} printed "${line}", which is not "<etime> <command>".`)
  const [, d = '0', h = '0', min, s, command] = m
  const seconds = ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)
  return { command, started: new Date(Math.floor(Date.now() / 1000 - seconds) * 1000).toISOString() }
}

/** 'running' | 'dead' | 'mismatch' (the pid now runs something else, so it is never killed). */
async function serverStatus(server) {
  const info = await processInfo(server.pid)
  if (!info) return { status: 'dead' }
  const sameCommand = info.command === server.command
  const sameStart = Math.abs(Date.parse(info.started) - Date.parse(server.started)) <= START_TOLERANCE_MS
  return sameCommand && sameStart ? { status: 'running' } : { status: 'mismatch', now: info.command }
}

async function runningContainers(docker) {
  try {
    const { stdout } = await run(docker, ['ps', '--format', '{{.Names}}'], { timeout: 10000 })
    return { names: stdout.split('\n').filter(Boolean) }
  } catch (error) {
    return { problem: `${docker} ps failed (exit ${error.code}): ${(error.stderr || error.message).trim()}` }
  }
}

/** Docker stacks and dev servers of one worktree, with live status. Never throws for a bad record: returns `problem`. */
export async function readResources(dir, { docker = 'docker' } = {}) {
  let record
  try {
    record = await loadRecord(dir)
  } catch (error) {
    if (error instanceof NdevError && error.code === 'record') return { docker: [], devServers: [], problem: error.message }
    throw error
  }
  const containers = record.docker.length ? await runningContainers(docker) : { names: [] }
  const stacks = record.docker.map((s) => {
    if (containers.problem) return { ...s, status: 'unknown', problem: containers.problem }
    const running = containers.names.some((n) => n.startsWith('supabase_') && n.endsWith(`_${s.projectId}`))
    return { ...s, status: running ? 'running' : 'stopped' }
  })
  const devServers = await Promise.all(Object.entries(record['dev-servers']).map(async ([name, d]) => ({ name, ...d, ...(await serverStatus(d)) })))
  return { docker: stacks, devServers }
}

// One writer at a time, using ndev's lock: ndev-worktree.lock in the worktree's git dir holds the writer's pid.
async function withLock(dir, lockWaitMs, fn) {
  const lock = path.join(await gitDir(dir), 'ndev-worktree.lock')
  const deadline = Date.now() + lockWaitMs
  for (;;) {
    try {
      const handle = await open(lock, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw new NdevError('lock', `Cannot create the lock ${lock}: ${error.message}`)
    }
    let holder = 0
    try {
      holder = Number((await readFile(lock, 'utf8')).trim()) || 0
    } catch {
      continue
    }
    if (holder > 0 && holder !== process.pid && !(await isAlive(holder))) {
      await rm(lock, { force: true })
      continue
    }
    if (Date.now() > deadline) throw new NdevError('locked', `${lock} is held by pid ${holder || 'unknown'}, so the record was not changed. If no ndev command runs, repair: rm ${lock}, then try again.`)
    await sleep(50)
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

const isAlive = async (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Re-read the record under the lock and write back what `edit` returns, atomically. */
async function changeRecord(dir, edit, { lockWaitMs = 10000 } = {}) {
  await withLock(dir, lockWaitMs, async () => {
    const workspace = await loadWorktreeRecord(dir)
    const updated = { ...workspace, resources: edit(workspace.resources) }
    const file = path.join(dir, WORKTREE_FILE)
    const problem = shapeProblem(updated, file)
    if (problem) throw new NdevError('record', problem)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true })
    }
  })
}

const sameServer = (a, b) => a.pid === b.pid && a.started === b.started
const sameStack = (a, b) => a.kind === b.kind && a.projectId === b.projectId && a.addedAt === b.addedAt
const sameStopStack = (a, b) => sameStack(a, b) && a.workdir === b.workdir && a.cliVersion === b.cliVersion

function changed(id) {
  return new NdevError('stale_revision', `${id} changed. Refresh resources and try again.`)
}

/** Remove an entry from the record. Never stops anything. */
export async function forgetEntry(dir, target, options) {
  if (target.type === 'dev-server') {
    const entry = (await loadRecord(dir))['dev-servers'][target.name]
    if (!entry) throw new NdevError('not_listed', `Dev server ${target.name} is not listed in ${path.join(dir, WORKTREE_FILE)}.`)
    await changeRecord(dir, (r) => ({ ...r, 'dev-servers': Object.fromEntries(Object.entries(r['dev-servers']).filter(([n, d]) => !(n === target.name && sameServer(d, entry)))) }), options)
  } else if (target.type === 'docker') {
    const entry = (await loadRecord(dir)).docker.find((s) => s.projectId === target.projectId)
    if (!entry) throw new NdevError('not_listed', `Stack ${target.projectId} is not listed in ${path.join(dir, WORKTREE_FILE)}.`)
    await changeRecord(dir, (r) => ({ ...r, docker: r.docker.filter((s) => !sameStack(s, entry)) }), options)
  } else {
    throw new NdevError('invalid_params', `Unknown resource type "${target.type}".`)
  }
}

/** SIGTERM the recorded process, but only while it still runs the recorded command from the recorded start time. */
export async function stopDevServer(dir, name, options) {
  const entry = (await loadRecord(dir))['dev-servers'][name]
  if (!entry) throw new NdevError('not_listed', `Dev server ${name} is not listed in ${path.join(dir, WORKTREE_FILE)}.`)
  if (options?.expectedServer && !sameServer(entry, options.expectedServer)) throw changed(`Dev server ${name}`)
  if (entry.pid === process.pid) throw new NdevError('refused', `Dev server ${name} has this plugin's own pid ${entry.pid}. Nothing was stopped.`)
  const state = await serverStatus(entry)
  if (state.status === 'mismatch') {
    throw new NdevError('pid_mismatch', `Pid ${entry.pid} (dev server ${name}) now runs "${state.now}", not the recorded "${entry.command}", so it was not stopped. If the server is gone, use Forget to remove the entry.`)
  }
  if (state.status === 'running') {
    process.kill(entry.pid, 'SIGTERM')
    for (let i = 0; i < 50 && (await isAlive(entry.pid)); i++) await sleep(100)
    if (await isAlive(entry.pid)) throw new NdevError('still_running', `Dev server ${name} (pid ${entry.pid}) did not exit within 5 s of SIGTERM. Repair: kill -9 ${entry.pid}`)
  }
  await changeRecord(dir, (r) => ({ ...r, 'dev-servers': Object.fromEntries(Object.entries(r['dev-servers']).filter(([n, d]) => !(n === name && sameServer(d, entry)))) }), options)
}

const stopArgv = (stack, policy) => ['-y', `supabase@${stack.cliVersion}`, 'stop', '--project-id', stack.projectId, ...(policy === 'stop-and-delete' ? ['--no-backup'] : [])]

/** `supabase stop` for one recorded stack. The entry goes only when the stop succeeded. */
export async function stopDocker(dir, projectId, policy, { npx = 'npx', expectedStack, worktreeOnly, ...options } = {}) {
  if (policy !== 'stop-and-delete' && policy !== 'stop-keep-data') throw new NdevError('invalid_params', `Policy "${policy}" is not "stop-and-delete" or "stop-keep-data".`)
  const stack = (await loadRecord(dir)).docker.find((s) => s.projectId === projectId)
  if (!stack) throw new NdevError('not_listed', `Stack ${projectId} is not listed in ${path.join(dir, WORKTREE_FILE)}.`)
  if (expectedStack && !sameStopStack(stack, expectedStack)) throw changed(`Stack ${projectId}`)
  if (stack.kind !== 'supabase') throw new NdevError('invalid_params', `Stack ${projectId} has kind "${stack.kind}", which has no stop command here (known: supabase).`)
  const args = stopArgv(stack, policy)
  const command = `npx ${args.join(' ')}`
  let cwd = dir
  if (worktreeOnly && stack.workdir) {
    cwd = await realpath(stack.workdir)
    const relative = path.relative(dir, cwd)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new NdevError('invalid_params', `Stack ${projectId} workdir ${cwd} is outside ${dir}.`)
    }
  } else if (stack.workdir) {
    cwd = await stat(stack.workdir).then((s) => (s.isDirectory() ? stack.workdir : dir), () => dir)
  }
  try {
    await run(npx, args, { cwd, timeout: STOP_TIMEOUT_MS, killSignal: 'SIGTERM' })
  } catch (error) {
    const output = tail([error.stdout, error.stderr].filter((t) => t && t.trim()).join('\n'))
    const reason = error.killed ? `timed out after ${STOP_TIMEOUT_MS / 1000} s (NDEV_STACK_STOP_TIMEOUT_S sets the limit)` : `exit code ${error.code}`
    throw new NdevError('stop_failed', `Stack ${projectId} did not stop: ${reason}.\ncommand: ${command} (in ${cwd})\n${output}\nRepair: run that command yourself. The entry stays in ${path.join(dir, WORKTREE_FILE)} until the stack stops.`)
  }
  await changeRecord(dir, (r) => ({ ...r, docker: r.docker.filter((s) => !sameStack(s, stack)) }), options)
}

/** Stop everything listed for a worktree. One failure does not skip the rest; each outcome is returned. */
export async function stopAllResources(dir, policy, options = {}) {
  if (!POLICIES.includes(policy)) throw new NdevError('invalid_params', `Policy "${policy}" is not one of ${POLICIES.join(', ')}.`)
  const record = await loadRecord(dir)
  if (options.expectedResources) {
    const { docker, devServers } = options.expectedResources
    const servers = Object.entries(record['dev-servers'])
    if ((policy !== 'keep-running' && (docker.length !== record.docker.length ||
      record.docker.some(stack => !docker.some(known => sameStopStack(stack, known))))) ||
      devServers.length !== servers.length || servers.some(([name, entry]) => !devServers.some(known => known.name === name && sameServer(entry, known)))) {
      throw changed('The worktree resources')
    }
  }
  const results = []
  const attempt = async (id, fn) => {
    try {
      await fn()
      results.push({ id, ok: true })
    } catch (error) {
      results.push({ id, ok: false, error: `[${error.code ?? 'error'}] ${error.message}` })
    }
  }
  for (const [name, expectedServer] of Object.entries(record['dev-servers'])) {
    await attempt(`dev-server:${name}`, () => stopDevServer(dir, name, { ...options, expectedServer }))
  }
  for (const stack of record.docker) {
    if (policy === 'keep-running') results.push({ id: `docker:${stack.projectId}`, ok: true, skipped: true })
    else await attempt(`docker:${stack.projectId}`, () => stopDocker(dir, stack.projectId, policy, { ...options, expectedStack: stack }))
  }
  return results
}
