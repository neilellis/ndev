#!/usr/bin/env node
// The per-worktree record: .neil-dev.worktree.json at the root of a linked git worktree,
// git-ignored, never in the main checkout. Today it lists the local service stacks that the
// worktree started, so the plugin's session-end hook can stop them. Other per-worktree facts can
// go in it later, as more top-level keys.
//
//   worktree-env.sh add-stack --kind supabase --project-id <id> --cli-version <x.y.z>
//                             [--workdir <dir holding supabase/>] [--worktree <dir>]
//   worktree-env.sh remove-stack --kind supabase --project-id <id> [--worktree <dir>]
//   worktree-env.sh list [--json] [--worktree <dir>]
//   worktree-env.sh stop-all [--on-end stop-and-delete|stop-keep-data|keep-running]
//                            [--worktree <dir>] [--background [--log <file>]]
//
// Exit codes: 0 done; 1 a stop failed (its entry stays); 2 bad usage, an unreadable file or a
// held lock; 3 refused (the main checkout, a file that is not git-ignored, or an id that another
// worktree lists); 4 remove-stack: not listed.
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

function readRecord(file) {
  if (!existsSync(file)) return { version: 1, stacks: [] }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Fail(2, `worktree-env: ${file} is not valid JSON (${error.message}). Nothing was stopped. Repair: fix or delete the file; it lists the stacks this worktree started.`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw.stacks !== undefined && !Array.isArray(raw.stacks))) {
    throw new Fail(2, `worktree-env: ${file} must hold a JSON object whose "stacks" is a list. Nothing was stopped. Repair: fix or delete the file.`)
  }
  return { version: 1, ...raw, stacks: raw.stacks ?? [] }
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
function change(root, edit) {
  const file = join(root, FILE)
  withLock(root, () => {
    const record = readRecord(file)
    writeRecord(file, { ...record, stacks: edit(record.stacks) })
  })
}

// The other worktrees of the repository that list the same stack. Two worktrees that record one
// project id share its containers, so a stop from one would stop (and delete) the other's stack.
function listedElsewhere(root, kind, id) {
  const r = git(root, ['worktree', 'list', '--porcelain'])
  if (r.status !== 0) throw new Fail(2, `worktree-env: git worktree list exited ${r.status} in ${root}: ${r.stderr.trim()}`)
  const others = r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    .filter(dir => isDir(dir) && realpathSync(dir) !== root)
  const found = []
  for (const dir of others) {
    const file = join(dir, FILE)
    if (!existsSync(file)) continue
    let stacks
    try {
      stacks = readRecord(file).stacks
    } catch (error) {
      console.error(`worktree-env: warning: could not check ${file} for ${kind} ${id}: ${error.message}`)
      continue
    }
    if (stacks.some(s => same(s, kind, id))) found.push(realpathSync(dir))
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
  const elsewhere = listedElsewhere(root, kind, id)
  if (elsewhere.length > 0) {
    throw new Fail(3, [
      `worktree-env: ${kind} stack ${id} is already listed by the worktree ${elsewhere.join(', ')}. Both would share its containers, and a session end there would stop this stack and delete its data. Nothing was recorded.`,
      `Repair: give this worktree its own project id (project_id in supabase/config.toml), or, if that worktree no longer uses the stack: ${WRAPPER} remove-stack --kind ${kind} --project-id ${id} --worktree ${elsewhere[0]}`,
    ].join('\n'))
  }
  const file = join(root, FILE)
  change(root, stacks => [...stacks.filter(s => !same(s, kind, id)), { ...stack, addedAt: new Date().toISOString() }])
  console.log(`worktree-env: recorded ${kind} stack ${id} in ${file}. When a Claude session in this worktree ends, the ndev hook stops it (worktreeStacks.onSessionEnd in .neil-dev.json; default stop-and-delete).`)
}

function removeStack(values) {
  const { kind, id } = checkStackOptions(values)
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const { stacks } = readRecord(file)
  if (!stacks.some(s => same(s, kind, id))) throw new Fail(4, `worktree-env: ${kind} stack ${id} is not listed in ${file}. Listed: ${stacks.map(s => `${s.kind} ${s.projectId}`).join(', ') || 'none'}.`)
  change(root, all => all.filter(s => !same(s, kind, id)))
  console.log(`worktree-env: removed ${kind} stack ${id} from ${file}. It was not stopped.`)
}

function list(values) {
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const record = readRecord(file)
  if (values.json) {
    console.log(JSON.stringify(record, null, 2))
    return
  }
  if (record.stacks.length === 0) console.log(`worktree-env: ${file} lists no stacks.`)
  for (const s of record.stacks) {
    console.log(`${s.kind} ${s.projectId} (CLI ${s.cliVersion}, ${s.workdir})${s.lastStop ? ` - last stop failed, exit code ${s.lastStop.exitCode}` : ''}`)
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
  const { stacks } = readRecord(file)
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
      if (keepRecord) change(root, all => all.filter(x => !sameEntry(x, s)))
      continue
    }
    failed++
    const repair = r.command || `stop the ${s.kind} stack ${s.projectId} by hand`
    if (keepRecord) {
      change(root, all => all.map(x => (sameEntry(x, s) ? { ...x, lastStop: { at, command: r.command, exitCode: r.exitCode, output: r.output, repair } } : x)))
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
    case 'list':
      list(values)
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
