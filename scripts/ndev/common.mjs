import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const releaseRoot = fileURLToPath(new URL('../../', import.meta.url))
export const worktreeScript = join(releaseRoot, 'scripts/work/worktree-env.sh')

export class CliError extends Error {
  constructor(code, message, { repair, details, errorCode } = {}) {
    super(message)
    this.code = code
    this.repair = repair
    this.details = details
    this.errorCode = errorCode
  }
}

export function argsFor(argv, options, repair, { positionals = 0 } = {}) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: positionals !== 0 })
  } catch (error) {
    throw new CliError(2, error.message, { repair })
  }
  if (parsed.positionals.length > positionals) {
    throw new CliError(2, `Unexpected argument ${JSON.stringify(parsed.positionals[positionals])}.`, { repair })
  }
  return parsed
}

export function run(executable, argv, { cwd, input, timeout = 30_000, env } = {}) {
  const result = spawnSync(executable, argv, {
    cwd, input, timeout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  return {
    ...(result.error ? { error: { code: result.error.code, message: result.error.message, ...(result.error.syscall ? { syscall: result.error.syscall } : {}) }, pid: result.pid } : {}),
    status: result.error ? (result.error.code === 'ETIMEDOUT' ? 124 : 127) : result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: [result.stderr, result.error?.message, result.signal && `Signal ${result.signal}`].filter(Boolean).join('\n'),
  }
}

export function checked(executable, argv, { repair, ...options } = {}) {
  const result = run(executable, argv, options)
  if (result.status !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim()
    const command = [executable, ...argv].join(' ')
    throw new CliError(result.status === 5 ? 5 : 1, `${command} exited ${result.status}: ${output || 'no output'}`, {
      repair,
      details: { command, exitCode: result.status, output },
    })
  }
  return result.stdout.trim()
}

export function gitWorkspace(cwd = process.cwd()) {
  const output = checked('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], {
    cwd,
    repair: 'Run ndev inside the Git worktree.',
  })
  const [root, gitDir, commonDir] = output.split('\n')
  if (!root || !gitDir || !commonDir) {
    throw new CliError(1, `Git did not identify the worktree at ${cwd}: ${output}`, { repair: 'Run git rev-parse --show-toplevel.' })
  }
  return { root, gitDir, commonDir, linked: gitDir !== commonDir }
}

export function readObject(file, { missing } = {}) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
    return value
  } catch (error) {
    if (error.code === 'ENOENT' && missing !== undefined) return missing
    throw new CliError(1, `${file}: ${error.message}`, { repair: `Check ${file} and retry.` })
  }
}

export function locked(file, update) {
  const lock = `${file}.ndev-lock`
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new CliError(5, `Another write holds ${lock}.`, { repair: `Retry after the writer completes. If it stopped, remove its empty lock with rmdir ${lock}.` })
  }
  try {
    return update()
  } finally {
    rmSync(lock, { recursive: true })
  }
}

export function atomicJson(file, data) {
  const dir = dirname(file)
  const temp = join(dir, `.ndev-${randomUUID()}.tmp`)
  try {
    let mode = 0o600
    try {
      mode = statSync(file).mode & 0o777
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode, flag: 'wx' })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function stateRoot(env = process.env) {
  return join(resolve(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state')), 'ndev')
}
