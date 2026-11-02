#!/usr/bin/env node
// The per-worktree record: .neil-dev.worktree.json at the root of a linked git worktree,
// git-ignored, never in the main checkout. It lists the resources that the worktree started, so
// the plugin's session-end hook can stop them:
//   { "version": 2, "resources": { "docker": [<stack>...], "dev-servers": { "<name>": <server> } } }
//
//   worktree-env.sh add-stack --kind supabase --project-id <id> --cli-version <x.y.z>
//                             [--workdir <dir holding supabase/>] [--worktree <dir>]
//   worktree-env.sh remove-stack --kind supabase --project-id <id> [--worktree <dir>]
//   worktree-env.sh add-dev-server --name <name> --pid <pid> --port <port> [--cwd <dir>]
//                                  [--worktree <dir>]
//   worktree-env.sh remove-dev-server --name <name> [--worktree <dir>]
//   worktree-env.sh list [--json] [--worktree <dir>]
//   worktree-env.sh stop-all [--on-end stop-and-delete|stop-keep-data|keep-running]
//                            [--worktree <dir>] [--background [--log <file>]]
//   worktree-env.sh migrate [--worktree <dir>]
//
// add-dev-server names a running server by what it shows ("docs", "ui"); the same name again
// replaces the entry. It reads the command line and start time of the pid from ps. stop-all stops
// every dev server (whatever --on-end says) and each docker stack by --on-end. It kills a pid only
// while that pid still runs the recorded command from the recorded start time. migrate rewrites a
// version 1 file ({ version: 1, stacks: [...] }) as version 2; every other command refuses one.
//
// Exit codes: 0 done; 1 a stop failed (its entry stays); 2 bad usage, an unreadable file or a
// held lock; 3 refused (the main checkout, a file that is not git-ignored, or an id or pid that
// another worktree lists); 4 remove-stack or remove-dev-server: not listed.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const FILE = '.neil-dev.worktree.json'
const SELF = fileURLToPath(import.meta.url)
const WRAPPER = join(dirname(SELF), 'worktree-env.sh')
const KINDS = ['supabase']
const POLICIES = ['stop-and-delete', 'stop-keep-data', 'keep-running']
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/
const TAIL_LINES = 40
const VERSION_NOW = 2
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const STOP_TIMEOUT_S = Number(process.env.NDEV_STACK_STOP_TIMEOUT_S ?? 180)
const LOCK_WAIT_MS = Number(process.env.NDEV_WORKTREE_LOCK_WAIT_MS ?? 10000)

class Fail extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// The help is the header comment: from line 2 to the first line that is not a comment.
const HEADER = readFileSync(SELF, 'utf8').split('\n').slice(1)
const HELP = HEADER.slice(0, HEADER.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.error) throw new Fail(2, `git ${args.join(' ')} did not start in ${cwd}: ${r.error.message}`)
  return r
}

const isDir = p => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// The root of the git worktree that holds `dir`.
function worktreeRoot(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) throw new Fail(2, `${dir} is not in a git worktree (git rev-parse exited ${top.status}: ${top.stderr.trim()}). Run this inside the worktree, or pass --worktree <dir>.`)
  return realpathSync(top.stdout.trim())
}

// The main checkout shares its git dir with the repository; a linked worktree has its own.
function refuseMainCheckout(root, stopCommand) {
  const dirs = git(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  if (dirs.status !== 0) throw new Fail(2, `git rev-parse --git-dir exited ${dirs.status} in ${root}: ${dirs.stderr.trim()}`)
  const [gitDir, common] = dirs.stdout.trim().split('\n')
  if (gitDir === common) {
    throw new Fail(3, [
      `worktree-env: ${root} is the main checkout of its repository. ${FILE} is kept only in linked worktrees, so a session end in the main checkout never stops a stack. Nothing was recorded.`,
      `Start the stack from a linked worktree, or stop it yourself when you finish: ${stopCommand}`,
    ].join('\n'))
  }
  return common
}

function refuseNotIgnored(root, common) {
  const r = git(root, ['check-ignore', '-q', FILE])
  if (r.status === 0) return
  if (r.status === 1) {
    throw new Fail(3, [
      `worktree-env: ${FILE} is not git-ignored in ${root}, so it could be committed. Nothing was recorded.`,
      `Repair: add the line \`${FILE}\` to the project's .gitignore and commit it (or add it to ${common}/info/exclude), then run this command again.`,
    ].join('\n'))
  }
  throw new Fail(2, `git check-ignore exited ${r.status} in ${root}: ${r.stderr.trim()}`)
}

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = v => typeof v === 'string' && v !== ''
const keysOutside = (value, allowed) => Object.keys(value).filter(k => !allowed.includes(k))
const quoted = keys => keys.map(k => `"${k}"`).join(', ')
const STACK_KEYS = ['kind', 'projectId', 'workdir', 'cliVersion', 'addedAt', 'lastStop']
const SERVER_KEYS = ['pid', 'port', 'command', 'cwd', 'started', 'lastStop']
const empty = () => ({ version: VERSION_NOW, resources: { docker: [], 'dev-servers': {} } })

// The problem with one docker entry, or undefined.
function stackProblem(s, i) {
  const at = `resources.docker[${i}]`
  if (!isObject(s)) return `${at} must be an object`
  const extra = keysOutside(s, STACK_KEYS)
  if (extra.length > 0) return `${at} has the unknown key ${quoted(extra)}; the keys are ${STACK_KEYS.join(', ')}`
  for (const k of ['kind', 'projectId']) if (!isText(s[k])) return `${at}.${k} must be a non-empty string`
  return undefined
}

// The problem with one dev-server entry, or undefined.
function serverProblem(name, d) {
  const at = `resources.dev-servers.${name}`
  if (!NAME.test(name)) return `${at}: the name must be letters, digits, '.', '_' or '-'`
  if (!isObject(d)) return `${at} must be an object`
  const extra = keysOutside(d, SERVER_KEYS)
  if (extra.length > 0) return `${at} has the unknown key ${quoted(extra)}; the keys are ${SERVER_KEYS.join(', ')}`
  if (!Number.isInteger(d.pid) || d.pid < 1) return `${at}.pid must be a positive whole number; got ${JSON.stringify(d.pid)}`
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) return `${at}.port must be a port number from 1 to 65535; got ${JSON.stringify(d.port)}`
  for (const k of ['command', 'cwd']) if (!isText(d[k])) return `${at}.${k} must be a non-empty string`
  if (!isText(d.started) || Number.isNaN(Date.parse(d.started))) return `${at}.started must be an ISO date and time; got ${JSON.stringify(d.started)}`
  return undefined
}

// The problem with a parsed record, or undefined.
function shapeProblem(raw) {
  if (!isObject(raw)) return 'must hold a JSON object'
  const extra = keysOutside(raw, ['version', 'resources'])
  if (extra.length > 0) return `has the unknown top-level key ${quoted(extra)}; the keys are version, resources`
  if (raw.version !== VERSION_NOW) return `has "version" ${JSON.stringify(raw.version)}; this script reads version ${VERSION_NOW}`
  if (!isObject(raw.resources)) return 'must hold a "resources" object'
  const kinds = keysOutside(raw.resources, ['docker', 'dev-servers'])
  if (kinds.length > 0) return `has the unknown resource ${quoted(kinds)}; the resources are docker, dev-servers`
  const { docker = [], 'dev-servers': servers = {} } = raw.resources
  if (!Array.isArray(docker)) return 'must hold resources.docker as a list'
  if (!isObject(servers)) return 'must hold resources.dev-servers as an object keyed by server name'
  for (const [i, s] of docker.entries()) {
    const problem = stackProblem(s, i)
    if (problem) return problem
  }
  for (const [name, d] of Object.entries(servers)) {
    const problem = serverProblem(name, d)
    if (problem) return problem
  }
  return undefined
}

const isVersion1 = raw => isObject(raw) && raw.version === 1

function parseRecord(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Fail(2, `worktree-env: ${file} is not valid JSON (${error.message}). Nothing was changed or stopped. Repair: fix or delete the file; it lists the resources this worktree started.`)
  }
}

// The record of the worktree at `root`. A missing file is an empty record. A version 1 file, or
// any shape this script does not know, is refused: nothing reads it as something else.
function readRecord(root) {
  const file = join(root, FILE)
  if (!existsSync(file)) return empty()
  const raw = parseRecord(file)
  if (isVersion1(raw)) {
    throw new Fail(2, [
      `worktree-env: ${file} uses the version 1 layout (the stacks at the top level). Nothing was changed or stopped.`,
      `Repair: ${WRAPPER} migrate --worktree ${root}`,
    ].join('\n'))
  }
  const problem = shapeProblem(raw)
  if (problem) throw new Fail(2, `worktree-env: ${file} ${problem}. Nothing was changed or stopped. Repair: fix the file (see the plugin README, "Worktree resources"), or delete it if nothing it lists still runs.`)
  return { version: VERSION_NOW, resources: { docker: raw.resources.docker ?? [], 'dev-servers': raw.resources['dev-servers'] ?? {} } }
}

// Write a temporary file, then rename it, so a reader never sees half a file.
function writeRecord(file, record) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, file)
}

const same = (a, kind, id) => a.kind === kind && a.projectId === id

// The absolute git dir of the worktree and the repository's common git dir.
function gitDirs(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  if (r.status !== 0) throw new Fail(2, `worktree-env: git rev-parse --git-dir exited ${r.status} in ${root}: ${r.stderr.trim()}`)
  const [gitDir, common] = r.stdout.trim().split('\n')
  return { gitDir, common }
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// One writer at a time: an exclusive lock file in the worktree's git dir (not in the worktree, so
// it needs no .gitignore line). A lock whose holder is gone is taken over.
function withLock(root, fn) {
  const lock = join(gitDirs(root).gitDir, 'ndev-worktree.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Fail(2, `worktree-env: cannot create the lock ${lock}: ${error.message}`)
    }
    let holder = 0
    try {
      holder = Number(readFileSync(lock, 'utf8').trim()) || 0
    } catch {
      continue
    }
    if (holder > 0 && !alive(holder)) {
      rmSync(lock, { force: true })
      continue
    }
    if (Date.now() > deadline) {
      throw new Fail(2, `worktree-env: ${lock} is held by pid ${holder || 'unknown'} for over ${LOCK_WAIT_MS} ms, so the record was not changed. If no worktree-env command runs, repair: rm ${lock}, then run this command again.`)
    }
    pause(50)
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

// Reads the file again under the lock before each change, so an entry added meanwhile is kept.
// `edit` gets the resources and returns them changed.
function change(root, edit) {
  withLock(root, () => {
    const record = readRecord(root)
    writeRecord(join(root, FILE), { version: VERSION_NOW, resources: edit(record.resources) })
  })
}

const changeDocker = (root, edit) => change(root, r => ({ ...r, docker: edit(r.docker) }))

// Rewrites a version 1 file ({ version: 1, stacks: [...] }) as version 2, with the stacks under
// resources.docker. A version 2 file is left as it is; any other shape is refused.
function migrate(values) {
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  withLock(root, () => {
    if (!existsSync(file)) {
      console.log(`worktree-env: ${file} does not exist; nothing to migrate.`)
      return
    }
    const raw = parseRecord(file)
    if (!isVersion1(raw)) {
      readRecord(root)
      console.log(`worktree-env: ${file} is already version ${VERSION_NOW}; nothing changed.`)
      return
    }
    const extra = keysOutside(raw, ['version', 'stacks'])
    if (extra.length > 0) throw new Fail(2, `worktree-env: ${file} is version 1 but has the unknown key ${quoted(extra)}, so it was not migrated. Repair: fix the file by hand; version 1 holds only version and stacks.`)
    const next = { version: VERSION_NOW, resources: { docker: raw.stacks ?? [], 'dev-servers': {} } }
    const problem = shapeProblem(next)
    if (problem) throw new Fail(2, `worktree-env: ${file} was not migrated: as version ${VERSION_NOW} it ${problem.startsWith('resources') ? `would fail: ${problem}` : problem}. Repair: fix its "stacks" by hand.`)
    writeRecord(file, next)
    console.log(`worktree-env: migrated ${file} to version ${VERSION_NOW}: ${next.resources.docker.length} stack(s) moved to resources.docker.`)
  })
}

// The other worktrees of the repository that list the same stack. Two worktrees that record one
// project id share its containers, so a stop from one would stop (and delete) the other's stack.
// The same holds for a dev-server pid: a session end there would kill this worktree's server.
// `match` gets another worktree's resources and returns the names of its matching entries.
function listedElsewhere(root, what, match) {
  const r = git(root, ['worktree', 'list', '--porcelain'])
  if (r.status !== 0) throw new Fail(2, `worktree-env: git worktree list exited ${r.status} in ${root}: ${r.stderr.trim()}`)
  const others = r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    .filter(dir => isDir(dir) && realpathSync(dir) !== root)
  const found = []
  for (const dir of others) {
    const file = join(dir, FILE)
    if (!existsSync(file)) continue
    let resources
    try {
      resources = readRecord(dir).resources
    } catch (error) {
      console.error(`worktree-env: warning: could not check ${file} for ${what}: ${error.message}`)
      continue
    }
    const names = match(resources)
    if (names.length > 0) found.push({ dir: realpathSync(dir), names })
  }
  return found
}

const stopArgv = (stack, policy) => [
  'npx', '-y', `supabase@${stack.cliVersion}`, 'stop', '--project-id', stack.projectId,
  ...(policy === 'stop-and-delete' ? ['--no-backup'] : []),
]
const shellText = argv => argv.join(' ')

function need(values, name) {
  const v = values[name]
  if (v === undefined || v === '') throw new Fail(2, `worktree-env: --${name} is required. ${HELP.split('\n').find(l => l.includes('add-stack')) ?? ''}`)
  return v
}

function checkStackOptions(values) {
  const kind = need(values, 'kind')
  if (!KINDS.includes(kind)) throw new Fail(2, `worktree-env: --kind ${kind} has no stop command. Known kinds: ${KINDS.join(', ')}.`)
  const id = need(values, 'project-id')
  if (!ID.test(id)) throw new Fail(2, `worktree-env: --project-id "${id}" is not a Supabase project id (letters, digits, '.', '_', '-').`)
  return { kind, id }
}

function addStack(values) {
  const { kind, id } = checkStackOptions(values)
  const version = need(values, 'cli-version')
  if (!VERSION.test(version)) throw new Fail(2, `worktree-env: --cli-version "${version}" is not an exact version such as 2.122.0.`)
  const workdir = resolve(values.workdir ?? process.cwd())
  if (!isDir(workdir)) throw new Fail(2, `worktree-env: --workdir ${workdir} is not a folder. Pass the folder that holds supabase/.`)
  const root = worktreeRoot(values.worktree ? resolve(values.worktree) : workdir)
  const stack = { kind, projectId: id, workdir: realpathSync(workdir), cliVersion: version }
  const common = refuseMainCheckout(root, shellText(stopArgv(stack, 'stop-and-delete')))
  refuseNotIgnored(root, common)
  const elsewhere = listedElsewhere(root, `${kind} ${id}`, r => (r.docker.some(s => same(s, kind, id)) ? [id] : []))
  if (elsewhere.length > 0) {
    throw new Fail(3, [
      `worktree-env: ${kind} stack ${id} is already listed by the worktree ${elsewhere.map(e => e.dir).join(', ')}. Both would share its containers, and a session end there would stop this stack and delete its data. Nothing was recorded.`,
      `Repair: give this worktree its own project id (project_id in supabase/config.toml), or, if that worktree no longer uses the stack: ${WRAPPER} remove-stack --kind ${kind} --project-id ${id} --worktree ${elsewhere[0].dir}`,
    ].join('\n'))
  }
  const file = join(root, FILE)
  changeDocker(root, stacks => [...stacks.filter(s => !same(s, kind, id)), { ...stack, addedAt: new Date().toISOString() }])
  console.log(`worktree-env: recorded ${kind} stack ${id} in ${file}. When a Claude session in this worktree ends, the ndev hook stops it (worktreeStacks.onSessionEnd in .neil-dev.json; default stop-and-delete).`)
}

function removeStack(values) {
  const { kind, id } = checkStackOptions(values)
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const stacks = readRecord(root).resources.docker
  if (!stacks.some(s => same(s, kind, id))) throw new Fail(4, `worktree-env: ${kind} stack ${id} is not listed in ${file}. Listed: ${stacks.map(s => `${s.kind} ${s.projectId}`).join(', ') || 'none'}.`)
  changeDocker(root, all => all.filter(s => !same(s, kind, id)))
  console.log(`worktree-env: removed ${kind} stack ${id} from ${file}. It was not stopped.`)
}

// ps's elapsed time, [[dd-]hh:]mm:ss, in seconds.
function elapsedSeconds(etime, pid) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!m) throw new Fail(2, `worktree-env: ps gave the elapsed time "${etime}" for pid ${pid}, which is not [[dd-]hh:]mm:ss.`)
  const [, d = '0', h = '0', min, s] = m
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)
}

// What a pid runs now: its command line, its start time (ISO, to the second) and its process
// group. undefined when no process has the pid.
function processInfo(pid) {
  const r = spawnSync('ps', ['-ww', '-o', 'etime=', '-o', 'pgid=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  if (r.error) throw new Fail(2, `worktree-env: ps did not start: ${r.error.message}. Dev servers need ps to check a pid.`)
  const line = r.stdout.trim()
  if (line === '') {
    if (r.status === 1 || r.status === 0) return undefined
    throw new Fail(2, `worktree-env: ps -p ${pid} exited ${r.status}: ${r.stderr.trim()}`)
  }
  const m = /^(\S+)\s+(\d+)\s+(.*)$/.exec(line)
  if (!m) throw new Fail(2, `worktree-env: ps -p ${pid} printed "${line}", which is not "<etime> <pgid> <command>".`)
  const seconds = elapsedSeconds(m[1], pid)
  const started = new Date(Math.floor(Date.now() / 1000 - seconds) * 1000).toISOString()
  return { command: m[3], started, pgid: Number(m[2]) }
}

function checkName(values) {
  const name = need(values, 'name')
  if (!NAME.test(name)) throw new Fail(2, `worktree-env: --name "${name}" must be letters, digits, '.', '_' or '-', such as docs or ui.`)
  return name
}

function addDevServer(values) {
  const name = checkName(values)
  const pidText = need(values, 'pid')
  if (!/^[1-9][0-9]*$/.test(pidText)) throw new Fail(2, `worktree-env: --pid "${pidText}" is not a process id.`)
  const pid = Number(pidText)
  const portText = need(values, 'port')
  const port = Number(portText)
  if (!/^[0-9]+$/.test(portText) || port < 1 || port > 65535) throw new Fail(2, `worktree-env: --port "${portText}" is not a port number from 1 to 65535.`)
  const cwd = resolve(values.cwd ?? process.cwd())
  if (!isDir(cwd)) throw new Fail(2, `worktree-env: --cwd ${cwd} is not a folder. Pass the folder the server runs in.`)
  const info = processInfo(pid)
  if (info === undefined) throw new Fail(2, `worktree-env: pid ${pid} does not run, so dev server ${name} was not recorded. Pass the pid of the running server (for a job you started in the background: $!).`)
  const root = worktreeRoot(values.worktree ? resolve(values.worktree) : cwd)
  const common = refuseMainCheckout(root, `kill ${pid}`)
  refuseNotIgnored(root, common)
  const elsewhere = listedElsewhere(root, `pid ${pid}`, r => Object.entries(r['dev-servers']).filter(([, d]) => d.pid === pid).map(([n]) => n))
  if (elsewhere.length > 0) {
    const [{ dir, names }] = elsewhere
    throw new Fail(3, [
      `worktree-env: pid ${pid} is already listed by the worktree ${dir} as dev server ${names.join(', ')}. A session end there would kill it. Nothing was recorded.`,
      `Repair: if that worktree no longer owns the server: ${WRAPPER} remove-dev-server --name ${names[0]} --worktree ${dir}`,
    ].join('\n'))
  }
  const entry = { pid, port, command: info.command, cwd: realpathSync(cwd), started: info.started }
  change(root, r => ({ ...r, 'dev-servers': { ...r['dev-servers'], [name]: entry } }))
  console.log(`worktree-env: recorded dev server ${name} (pid ${pid}, port ${port}, ${info.command}) in ${join(root, FILE)}. When a Claude session in this worktree ends, the ndev hook stops it.`)
}

function removeDevServer(values) {
  const name = checkName(values)
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const servers = readRecord(root).resources['dev-servers']
  if (!Object.hasOwn(servers, name)) throw new Fail(4, `worktree-env: dev server ${name} is not listed in ${file}. Listed: ${Object.keys(servers).join(', ') || 'none'}.`)
  change(root, r => {
    const { [name]: _gone, ...rest } = r['dev-servers']
    return { ...r, 'dev-servers': rest }
  })
  console.log(`worktree-env: removed dev server ${name} from ${file}. It was not stopped.`)
}

function list(values) {
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const record = readRecord(root)
  if (values.json) {
    console.log(JSON.stringify(record, null, 2))
    return
  }
  const { docker, 'dev-servers': servers } = record.resources
  if (docker.length === 0) console.log(`worktree-env: ${file} lists no stacks.`)
  for (const s of docker) {
    console.log(`${s.kind} ${s.projectId} (CLI ${s.cliVersion}, ${s.workdir})${s.lastStop ? ` - last stop failed, exit code ${s.lastStop.exitCode}` : ''}`)
  }
  if (Object.keys(servers).length === 0) console.log(`worktree-env: ${file} lists no dev servers.`)
  for (const [name, d] of Object.entries(servers)) {
    console.log(`${name}: pid ${d.pid}, port ${d.port}, ${d.command} (in ${d.cwd}, started ${d.started})${d.lastStop ? ` - last stop failed: ${d.lastStop.output}` : ''}`)
  }
}

const tail = text => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')

function stopOne(stack, policy, root) {
  if (!KINDS.includes(stack.kind)) {
    return { ok: false, command: '', exitCode: 2, output: `kind ${stack.kind} has no stop command (known: ${KINDS.join(', ')})`, cwd: root }
  }
  const argv = stopArgv(stack, policy)
  const cwd = isDir(stack.workdir) ? stack.workdir : isDir(root) ? root : homedir()
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: STOP_TIMEOUT_S * 1000, killSignal: 'SIGTERM' })
  const output = tail([r.stdout, r.stderr].filter(t => t && t.trim() !== '').join('\n'))
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, command: shellText(argv), exitCode: 124, output: `${output}\n(timed out after ${STOP_TIMEOUT_S} s; NDEV_STACK_STOP_TIMEOUT_S sets the limit)`.trim(), cwd }
  if (r.error) return { ok: false, command: shellText(argv), exitCode: 127, output: `${argv[0]} did not start: ${r.error.message}`, cwd }
  return { ok: r.status === 0, command: shellText(argv), exitCode: r.status ?? 128, output, cwd }
}

// The entry this run read, not a newer one for the same stack that was added while it stopped.
const sameEntry = (a, b) => same(a, b.kind, b.projectId) && a.addedAt === b.addedAt

function stopAll(values) {
  const policy = values['on-end'] ?? 'stop-and-delete'
  if (!POLICIES.includes(policy)) throw new Fail(2, `worktree-env: --on-end "${policy}" is not known. Use one of: ${POLICIES.join(', ')}.`)
  // A folder that is gone (a worktree removed after the session) is used as given.
  const given = values.worktree ? resolve(values.worktree) : process.cwd()
  const root = isDir(given) ? worktreeRoot(given) : given
  if (values.background) return background(values, policy, root)
  const file = join(root, FILE)
  const at = new Date().toISOString()
  const stacks = readRecord(root).resources.docker
  if (stacks.length === 0) {
    console.log(`worktree-env: ${at} ${file} lists no stacks; nothing to stop.`)
    return 0
  }
  if (policy === 'keep-running') {
    for (const s of stacks) console.log(`worktree-env: ${at} ${s.kind} stack ${s.projectId} left running (keep-running). Stop it with: ${shellText(stopArgv(s, 'stop-and-delete'))}`)
    return 0
  }
  let failed = 0
  for (const s of stacks) {
    const r = stopOne(s, policy, root)
    const keepRecord = existsSync(root)
    if (r.ok) {
      console.log(`worktree-env: ${at} stopped ${s.kind} stack ${s.projectId}: ${r.command} (in ${r.cwd})`)
      if (keepRecord) changeDocker(root, all => all.filter(x => !sameEntry(x, s)))
      continue
    }
    failed++
    const repair = r.command || `stop the ${s.kind} stack ${s.projectId} by hand`
    if (keepRecord) {
      changeDocker(root, all => all.map(x => (sameEntry(x, s) ? { ...x, lastStop: { at, command: r.command, exitCode: r.exitCode, output: r.output, repair } } : x)))
    }
    console.error([
      `worktree-env: ${at} ${s.kind} stack ${s.projectId} did not stop.`,
      `  command: ${r.command} (in ${r.cwd})`,
      `  exit code ${r.exitCode}; last ${TAIL_LINES} lines of its output:`,
      r.output.split('\n').map(l => `    ${l}`).join('\n'),
      `  Repair: ${repair}`,
      `  then:   ${WRAPPER} remove-stack --kind ${s.kind} --project-id ${s.projectId} --worktree ${root}`,
      keepRecord ? `  The entry stays in ${file} until the stack stops.` : `  ${root} no longer exists, so no record was kept.`,
    ].join('\n'))
  }
  return failed > 0 ? 1 : 0
}

// Starts this command again in its own session (setsid), so it outlives the caller: the
// session-end hook has about 1.5 s, and a Supabase stop takes longer.
function background(values, policy, root) {
  let log = values.log
  // The default log is in the common git dir, which outlives a removed worktree's own git dir.
  if (!log) {
    const { gitDir, common } = gitDirs(root)
    log = join(common, 'ndev-worktree-stop', `${gitDir === common ? 'main' : basename(gitDir)}.log`)
  }
  log = resolve(log)
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, `--- ${new Date().toISOString()} stop-all --on-end ${policy} --worktree ${root}\n`)
  const fd = openSync(log, 'a')
  const child = spawn(process.execPath, [SELF, 'stop-all', '--on-end', policy, '--worktree', root], {
    cwd: isDir(root) ? root : homedir(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  })
  child.unref()
  console.log(`worktree-env: stopping the stacks of ${root} in the background, pid ${child.pid}; log ${log}`)
  return 0
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(HELP)
    return command === undefined ? 2 : 0
  }
  let values
  try {
    ;({ values } = parseArgs({
      args: rest,
      options: {
        kind: { type: 'string' },
        'project-id': { type: 'string' },
        'cli-version': { type: 'string' },
        workdir: { type: 'string' },
        worktree: { type: 'string' },
        'on-end': { type: 'string' },
        background: { type: 'boolean' },
        log: { type: 'string' },
        json: { type: 'boolean' },
        name: { type: 'string' },
        pid: { type: 'string' },
        port: { type: 'string' },
        cwd: { type: 'string' },
      },
      strict: true,
    }))
  } catch (error) {
    throw new Fail(2, `worktree-env ${command}: ${error.message}\n${HELP}`)
  }
  switch (command) {
    case 'add-stack':
      addStack(values)
      return 0
    case 'remove-stack':
      removeStack(values)
      return 0
    case 'add-dev-server':
      addDevServer(values)
      return 0
    case 'remove-dev-server':
      removeDevServer(values)
      return 0
    case 'list':
      list(values)
      return 0
    case 'migrate':
      migrate(values)
      return 0
    case 'stop-all':
      return stopAll(values)
    default:
      throw new Fail(2, `worktree-env: unknown command "${command}".\n${HELP}`)
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof Fail)) throw error
  console.error(error.message)
  process.exitCode = error.code
}
