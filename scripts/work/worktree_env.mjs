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
// Exit codes: 0 done; 1 a stop failed (its entry stays); 2 bad usage or an unreadable file;
// 3 refused (the main checkout, or the file is not git-ignored); 4 remove-stack: not listed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

class Fail extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const HELP = readFileSync(SELF, 'utf8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n')

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

// Re-reads the file before each change, so an entry added meanwhile is kept.
function change(file, edit) {
  const record = readRecord(file)
  writeRecord(file, { ...record, stacks: edit(record.stacks) })
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
  const file = join(root, FILE)
  change(file, stacks => [...stacks.filter(s => !same(s, kind, id)), { ...stack, addedAt: new Date().toISOString() }])
  console.log(`worktree-env: recorded ${kind} stack ${id} in ${file}. When a Claude session in this worktree ends, the ndev hook stops it (worktreeStacks.onSessionEnd in .neil-dev.json; default stop-and-delete).`)
}

function removeStack(values) {
  const { kind, id } = checkStackOptions(values)
  const root = worktreeRoot(resolve(values.worktree ?? process.cwd()))
  const file = join(root, FILE)
  const { stacks } = readRecord(file)
  if (!stacks.some(s => same(s, kind, id))) throw new Fail(4, `worktree-env: ${kind} stack ${id} is not listed in ${file}. Listed: ${stacks.map(s => `${s.kind} ${s.projectId}`).join(', ') || 'none'}.`)
  change(file, all => all.filter(s => !same(s, kind, id)))
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

function stopAll(values) {
  const policy = values['on-end'] ?? 'stop-and-delete'
  if (!POLICIES.includes(policy)) throw new Fail(2, `worktree-env: --on-end "${policy}" is not known. Use one of: ${POLICIES.join(', ')}.`)
  const root = values.worktree ? resolve(values.worktree) : worktreeRoot(process.cwd())
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
      if (keepRecord) change(file, all => all.filter(x => !same(x, s.kind, s.projectId)))
      continue
    }
    failed++
    const repair = r.command || `stop the ${s.kind} stack ${s.projectId} by hand`
    if (keepRecord) {
      change(file, all => all.map(x => (same(x, s.kind, s.projectId) ? { ...x, lastStop: { at, command: r.command, exitCode: r.exitCode, output: r.output, repair } } : x)))
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
  if (!log) {
    const dir = git(root, ['rev-parse', '--absolute-git-dir'])
    if (dir.status !== 0) throw new Fail(2, `worktree-env: no --log given, and git rev-parse --absolute-git-dir exited ${dir.status} in ${root}: ${dir.stderr.trim()}`)
    log = join(dir.stdout.trim(), 'ndev-worktree-stop.log')
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
