import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type Env = Record<string, string | undefined>
type Payload = { session_id?: string; sessionID?: string }

const HARNESS_VARIABLES = ['CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']

const harnessIds = (env: Env) => [...new Set(HARNESS_VARIABLES.map(name => env[name]).filter((id): id is string => Boolean(id)))]

function innerSessionFile(env: Env, ids: string[]) {
  const key = createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')
  return join(resolve(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state')), 'ndev', 'inner-sessions', `${key}.json`)
}

function recordedSession(file: string): string {
  try {
    const { session } = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof session === 'string' && session) return session
    throw new Error('it names no session')
  } catch (error) {
    throw Object.assign(new Error(`The inner session record ${file} cannot be read: ${(error as Error).message}.`), { code: 1, repair: `Delete ${file} and let the inner harness run a hook again.` })
  }
}

export function recordInnerSession(env: Env, payload: Payload = {}) {
  const hooked = payload.session_id || payload.sessionID
  const ids = harnessIds(env)
  if (env.ORCA_AGENT_SESSION_ID || !hooked || ids.length < 2 || !ids.includes(hooked)) return
  const file = innerSessionFile(env, ids)
  if (existsSync(file) && recordedSession(file) === hooked) return
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.${process.pid}`, JSON.stringify({ session: hooked, ids }))
  renameSync(`${file}.${process.pid}`, file)
}

export function harnessSession(env: Env, payload: Payload = {}): string | undefined {
  const hooked = env.ORCA_AGENT_SESSION_ID || payload.session_id || payload.sessionID
  if (hooked) return hooked
  const ids = harnessIds(env)
  if (ids.length < 2) return ids[0]
  const file = innerSessionFile(env, ids)
  if (existsSync(file)) return recordedSession(file)
  const named = HARNESS_VARIABLES.filter(name => env[name]).map(name => `${name}=${env[name]}`).join(', ')
  throw Object.assign(new Error(`The harness variables ${named} name different sessions, so one harness runs inside another, and no ndev hook has recorded which one runs this command.`), {
    code: 1,
    repair: 'Let the inner harness run a hook (submit a prompt or start a new session with the ndev hooks installed), or set ORCA_AGENT_SESSION_ID.',
  })
}
