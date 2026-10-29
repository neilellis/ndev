import type { EngineInterface } from 'claude-code'

// The project's private credentials for ndev skills live in .neil-dev.env at the repository root,
// git-ignored. scripts/env/neil-dev-env.mjs owns the file: it finds it, copies the main checkout's
// file into a new worktree, creates it from ~/.zshrc and runs commands with its keys. This hook
// asks it at session start and tells the agent where the file is and which key names it sets.
export const FILE = '.neil-dev.env'
const SECTION = 'ndev:credentials'
const CREATE = 'Create from ~/.zshrc'
const LATER = 'Not now'

type Status = { file: string | null; copiedFrom: string | null; root: string; main: string | null; ignored: boolean; keys: string[]; missing: string[] }

let root: string | undefined
let script = ''
let current: Status | undefined
let text: string | undefined

async function env($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['node', script, ...args], { cwd: root, timeoutMs: 30_000 })
  if (ran.exitCode !== 0) throw new Error(`node ${script} ${args.join(' ')} exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(0, 400)}`)
  return ran.stdout.trim()
}

const describe = (s: Status) => {
  if (s.file !== null && !s.ignored) {
    return `Private credentials: ${s.file} exists but is not git-ignored, so it can be committed. Before any other work, add \`${FILE}\` to .gitignore (or to the git common dir's info/exclude) and check that git status does not list it.`
  }
  if (s.file !== null) {
    return [
      `Private credentials: ${s.file} (git-ignored, mode 600) holds the private keys for ndev skills and this project. Keys set: ${s.keys.join(', ') || 'none'}.${s.missing.length ? ` ndev keys not set: ${s.missing.join(', ')}.` : ''}`,
      `Run a command that needs a key through \`node ${script} run --need KEY[,KEY] -- <command>\`, or give this file to a project helper that takes a credentials file. Never print, cat, grep or source the file, and never ask for a value in chat. When a key is missing, the person adds it to the file, or exports it in ~/.zshrc and runs \`node ${script} init\`.`,
    ].join('\n')
  }
  if (!s.ignored) {
    return `Private credentials: this project has no ${FILE}, and ${FILE} is not git-ignored in ${s.root}, so ndev does not create or copy it. Before a skill uses a private key, add \`${FILE}\` to .gitignore (or to the git common dir's info/exclude), then run \`node ${script} init\`.`
  }
  return `Private credentials: this project has no ${FILE} (looked in ${s.root}${s.main && s.main !== s.root ? ` and the main project checkout ${s.main}` : ''}). When a skill needs a private key, ask the person whether to create it with \`node ${script} init\`: it takes the ndev keys from the exports in ~/.zshrc and lists the ones that are missing. Never search other files for keys.`
}

async function refresh($: EngineInterface): Promise<Status> {
  const s = JSON.parse(await env($, ['status', '--json'])) as Status
  current = s
  text = describe(s)
  return s
}

function fail($: EngineInterface, error: unknown) {
  const detail = String(error instanceof Error ? error.message : error).slice(0, 500)
  text = `Private credentials: the ${FILE} check failed, so no skill knows where its keys are. ${detail}\nFix the cause, then run \`node ${script} status\`.`
  $.ui.toast(`ndev: ${FILE} check failed: ${detail.slice(0, 200)}`)
}

// Called from register.ts's session.start: finds the file, and copies it into a new worktree.
export async function startCredentials($: EngineInterface, cwd: string) {
  root = undefined
  current = undefined
  text = undefined
  script = `${$.plugin.root}/scripts/env/neil-dev-env.mjs`
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  // Outside a git repository there is no project root to hold the file.
  if (top.exitCode !== 0 || top.stdout.trim() === '') return
  root = top.stdout.trim()
  let s: Status
  try {
    s = await refresh($)
  } catch (error) {
    fail($, error)
    return
  }
  if (s.copiedFrom) $.ui.toast(`ndev: copied ${FILE} from the main project checkout ${s.copiedFrom}.`)
  if (!s.ignored) $.ui.toast(`ndev: ${FILE} is not git-ignored in ${s.root}. Repair: echo ${FILE} >> .gitignore`)
}

// Asks once per session when the project has no file and git ignores the name.
export async function askCredentials($: EngineInterface, isInteractive: boolean) {
  if (!isInteractive || current === undefined || current.file !== null || !current.ignored) return
  let answer: string | undefined
  try {
    answer = (await $.ui.ask(
      `This project has no ${FILE}, the git-ignored file that holds private keys for ndev skills (narration voice and timings, photographs, protected previews). Create it now from the exports in ~/.zshrc? Only the ndev key names are copied; no value is shown.`,
      { header: 'Credentials', options: [CREATE, LATER] },
    )).trim()
  } catch {
    // The dialog was closed: the agent asks before a skill needs a key.
    return
  }
  if (answer !== CREATE) return
  try {
    const report = await env($, ['init'])
    $.ui.toast(`ndev: ${report.split('\n').filter(l => /^(Created|Updated|missing)/.test(l)).join(' ')}`.slice(0, 300))
    await refresh($)
  } catch (error) {
    fail($, error)
  }
}

// The system prompt section; undefined outside a git repository.
export const credentialsSection = () => (text === undefined ? undefined : { id: SECTION, text, scope: 'session' as const })
