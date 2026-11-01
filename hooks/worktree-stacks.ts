import type { EngineInterface } from 'claude-code'

import type { LoadedConfig, StackPolicy } from './config'
import { CONFIG_FILE } from './config'

// Each git worktree lists the local service stacks it started (a Supabase stack, say) in
// .neil-dev.worktree.json at its root. scripts/work/worktree_env.mjs owns that file: agents record
// a stack with `worktree-env.sh add-stack`, and `stop-all` stops the listed stacks. This hook runs
// `stop-all --background` when a session ends, so a worktree's stacks do not run on after the work,
// and at the next session start it reports a stop that failed and the stacks that are still listed.
export const RECORD = '.neil-dev.worktree.json'
const SECTION = 'ndev:worktree-stacks'
// session.end shares one short bound (about 1.5 s) across the chain: the script only starts the
// detached stop and returns, so this is enough.
const LAUNCH_TIMEOUT_MS = 1200

type LastStop = { at?: string; command?: string; exitCode?: number; output?: string; repair?: string }
type Stack = { kind: string; projectId: string; workdir?: string; cliVersion?: string; lastStop?: LastStop }

let root: string | undefined
let script = ''
let text: string | undefined

const ids = (stacks: Stack[]) => stacks.map(s => `${s.kind} ${s.projectId}`).join(', ')

// Reads the worktree's record. A missing file is no stacks; a file that does not parse throws.
async function readStacks($: EngineInterface, dir: string): Promise<Stack[]> {
  const path = `${dir}/${RECORD}`
  if (!(await $.fs.exists(path))) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)})`)
  }
  const stacks = (parsed as { stacks?: unknown })?.stacks
  if (!Array.isArray(stacks)) throw new Error(`${path} has no "stacks" list`)
  return stacks as Stack[]
}

const describeFailure = (dir: string, s: Stack) => {
  const l = s.lastStop ?? {}
  return [
    `- ${s.kind} stack ${s.projectId} (workdir ${s.workdir ?? 'unknown'}) did not stop at ${l.at ?? 'an earlier session end'}.`,
    `  command: ${l.command ?? 'unknown'}; exit code ${l.exitCode ?? 'unknown'}`,
    `  output: ${(l.output ?? '').trim().split('\n').slice(-8).join('\n    ') || '(none)'}`,
    `  repair: ${l.repair ?? l.command ?? 'unknown'}`,
    `  then: bash ${script} remove-stack --kind ${s.kind} --project-id ${s.projectId} --worktree ${dir}`,
  ].join('\n')
}

// Called from register.ts's session.start: finds the worktree root and reports earlier failed stops,
// and the stacks still listed. A toast at the last session end can go unseen, and a stop that never
// started leaves no lastStop, so the listing itself is the evidence.
export async function startWorktreeStacks($: EngineInterface, cwd: string, project: LoadedConfig | undefined) {
  root = undefined
  text = undefined
  script = `${$.plugin.root}/scripts/work/worktree-env.sh`
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  // Outside a git repository there is no worktree to hold the record.
  if (top.exitCode !== 0 || top.stdout.trim() === '') return
  root = top.stdout.trim()
  let stacks: Stack[]
  try {
    stacks = await readStacks($, root)
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error)
    text = `Worktree stacks: ${detail}. Stacks listed there are not stopped at session end until it is fixed. Repair the file, then check it with \`bash ${script} list --worktree ${root}\`.`
    $.ui.toast(`ndev: ${detail.slice(0, 200)}. Repair it, then run bash ${script} list --worktree ${root}`)
    return
  }
  const failed = stacks.filter(s => s.lastStop !== undefined)
  // With keep-running the stacks are meant to outlive a session, so a listing is no news.
  const keep = project?.config.worktreeStacks?.onSessionEnd === 'keep-running'
  const listed = keep ? [] : stacks.filter(s => s.lastStop === undefined)
  const parts: string[] = []
  if (failed.length > 0) {
    parts.push(
      `Worktree stacks: a stop at an earlier session end failed, so these stacks may still run and hold Docker resources. Run each repair, then the remove-stack command. Tell the person if a repair fails.`,
      ...failed.map(s => describeFailure(root!, s)),
    )
    $.ui.toast(`ndev: the stop of ${ids(failed)} failed at an earlier session end. Repair: ${failed[0]!.lastStop?.repair ?? `bash ${script} stop-all --worktree ${root}`}`)
  }
  if (listed.length > 0) {
    parts.push(
      `Worktree stacks: ${root}/${RECORD} still lists ${ids(listed)}, which may run from an earlier session. If this task uses a stack, leave it listed: it is stopped when this session ends. If not, stop them now with \`bash ${script} stop-all --worktree ${root}\`.`,
    )
  }
  if (parts.length > 0) text = parts.join('\n')
}

export const worktreeStacksSection = () => (text === undefined ? undefined : { id: SECTION, text, scope: 'session' as const })

// Called from register.ts's session.end. It never throws: a failure is a toast with the repair, and
// the session still ends. /clear and resume go on in the same process and worktree, so they stop nothing.
export async function stopWorktreeStacks($: EngineInterface, reason: string, project: LoadedConfig | undefined) {
  if (root === undefined || reason === 'clear' || reason === 'resume') return
  const dir = root
  try {
    const stacks = await readStacks($, dir)
    if (stacks.length === 0) return
    if (project?.error) {
      $.ui.toast(`ndev: did not stop ${ids(stacks)}: ${project.path} has an error (${project.error}). Fix ${CONFIG_FILE}, then run bash ${script} stop-all --worktree ${dir}`)
      return
    }
    const policy: StackPolicy = project?.config.worktreeStacks?.onSessionEnd ?? 'stop-and-delete'
    if (policy === 'keep-running') {
      $.ui.toast(`ndev: left ${ids(stacks)} running (${CONFIG_FILE} worktreeStacks.onSessionEnd is keep-running). Stop them with bash ${script} stop-all --worktree ${dir} --on-end stop-and-delete`)
      return
    }
    const ran = await $.process.run(
      ['bash', script, 'stop-all', '--background', '--on-end', policy, '--worktree', dir],
      { cwd: dir, timeoutMs: LAUNCH_TIMEOUT_MS },
    )
    if (ran.exitCode !== 0) {
      const output = (ran.stderr || ran.stdout).trim().slice(0, 300)
      $.ui.toast(`ndev: the stop of ${ids(stacks)} did not start: worktree-env.sh exited ${ran.exitCode}: ${output}. Repair: bash ${script} stop-all --worktree ${dir} --on-end ${policy}`)
    }
  } catch (error) {
    $.ui.toast(`ndev: the stacks of ${dir} were not stopped: ${String(error instanceof Error ? error.message : error).slice(0, 300)}. Repair: bash ${script} stop-all --worktree ${dir}`)
  }
}
