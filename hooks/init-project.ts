import type { EngineInterface } from 'claude-code'

// Each new worktree builds itself from source once. scripts/init-project.sh holds the project's own
// build; .ndev-inited (git-ignored, so every worktree starts without it) records that it passed.
export const MARKER = '.ndev-inited'
export const SCRIPT = 'scripts/init-project.sh'

const SECTION = 'neil-development:init-project'
const RERUN = `bash ${SCRIPT} && touch ${MARKER}`
// $.process.run kills a child after ten minutes at most; a longer build is finished by the agent.
const TIMEOUT_MS = 10 * 60_000
const TAIL_LINES = 40

type State =
  | { kind: 'done' }
  | { kind: 'running' }
  | { kind: 'no-script' }
  | { kind: 'not-ignored'; detail: string }
  | { kind: 'failed'; detail: string }

let root: string | undefined
let state: State = { kind: 'done' }

const tail = (text: string) => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')

const text = (s: State): string | undefined => {
  switch (s.kind) {
    case 'done':
      return undefined
    case 'running':
      return `Project init: ${SCRIPT} is building this worktree in the background. Build outputs may be missing until it finishes; a toast reports the result.`
    case 'no-script':
      return [
        `Project init: this worktree is not initialised (${MARKER} is absent) and ${SCRIPT} does not exist.`,
        `Before other work, write ${SCRIPT}: a bash script with \`set -euo pipefail\` that runs from the project root and does everything needed to build the project from source in a fresh worktree (install dependencies, generate code, compile, build). It must be safe to run again. Read the project's README, manifests and CI config to find the steps; do not guess a step you cannot find, ask instead.`,
        `Make sure \`${MARKER}\` is in .gitignore, run \`${RERUN}\`, and commit the script (not the marker). If it fails, fix the script and run it again.`,
      ].join('\n')
    case 'not-ignored':
      return `Project init: ${MARKER} is not git-ignored (${s.detail}), so ${SCRIPT} was not run. Add \`${MARKER}\` to .gitignore, commit it, then run \`${RERUN}\`.`
    case 'failed':
      return `Project init: ${s.detail}\nThis worktree is not built. Fix the cause (or the script), then run \`${RERUN}\`.`
  }
}

async function build($: EngineInterface, at: string) {
  let ran
  try {
    ran = await $.process.run(['bash', `${at}/${SCRIPT}`], { cwd: at, timeoutMs: TIMEOUT_MS })
  } catch (error) {
    state = { kind: 'failed', detail: `${SCRIPT} did not finish: ${String(error).slice(0, 300)}` }
    $.ui.toast(`neil-development: ${SCRIPT} did not finish: ${String(error).slice(0, 160)}`)
    return
  }
  if (ran.exitCode !== 0) {
    const output = tail([ran.stdout, ran.stderr].filter(t => t.trim() !== '').join('\n'))
    state = { kind: 'failed', detail: `${SCRIPT} exited ${ran.exitCode}. Last ${TAIL_LINES} lines of its output:\n${output}` }
    $.ui.toast(`neil-development: ${SCRIPT} exited ${ran.exitCode}: ${tail(ran.stderr || ran.stdout).split('\n').at(-1)?.slice(0, 160) ?? ''}`)
    return
  }
  await $.fs.write(`${at}/${MARKER}`, `${new Date().toISOString()}\n`)
  state = { kind: 'done' }
  $.ui.toast(`neil-development: ${SCRIPT} passed; this worktree is built.`)
}

// Decides what this worktree needs, and starts the build when the script and the ignore rule are in place.
async function check($: EngineInterface, cwd: string) {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  // Outside a git repository there is no worktree to build.
  if (top.exitCode !== 0 || top.stdout.trim() === '') return
  const at = top.stdout.trim()
  root = at
  if (await $.fs.exists(`${at}/${MARKER}`)) return
  const ignore = await $.process.run(['git', 'check-ignore', '-q', MARKER], { cwd: at, timeoutMs: 10000 })
  if (ignore.exitCode !== 0) {
    const detail = ignore.exitCode === 1 ? 'git check-ignore exited 1' : `git check-ignore exited ${ignore.exitCode}: ${ignore.stderr.trim().slice(0, 160)}`
    state = { kind: 'not-ignored', detail }
    $.ui.toast(`neil-development: ${MARKER} is not git-ignored, so ${SCRIPT} did not run. Repair: echo ${MARKER} >> .gitignore`)
    return
  }
  if (!(await $.fs.exists(`${at}/${SCRIPT}`))) {
    state = { kind: 'no-script' }
    return
  }
  state = { kind: 'running' }
  void build($, at)
}

// Called from register.ts's session.start: one plugin hooks each event without a matcher once.
export async function startInitProject($: EngineInterface, cwd: string) {
  root = undefined
  state = { kind: 'done' }
  try {
    await check($, cwd)
  } catch (error) {
    $.ui.toast(`neil-development: project init check failed: ${String(error).slice(0, 200)}`)
  }
}

// Called on each prompt: the agent may finish the init itself, and once the marker exists the instruction goes away.
export async function refreshInitProject($: EngineInterface) {
  if (state.kind !== 'done' && state.kind !== 'running' && root !== undefined && (await $.fs.exists(`${root}/${MARKER}`))) {
    state = { kind: 'done' }
  }
}

// The system prompt section while this worktree is not built; undefined once it is.
export const initProjectSection = () => {
  const t = text(state)
  return t === undefined ? undefined : { id: SECTION, text: t, scope: 'session' as const }
}
