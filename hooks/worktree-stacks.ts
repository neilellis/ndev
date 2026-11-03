import type { EngineInterface } from 'claude-code'

import type { LoadedConfig, StackPolicy } from './config'
import { CONFIG_FILE } from './config'

// Each git worktree lists the resources it started in .neil-dev.worktree.json at its root: local
// service stacks (a Supabase stack, say) under resources.docker, and dev servers under
// resources.dev-servers, keyed by a name for what each shows. scripts/work/worktree_env.mjs owns
// that file: agents record a stack with `worktree-env.sh add-stack` and a dev server with
// `add-dev-server`, and `stop-all` stops what is listed. This hook runs `stop-all --background`
// when a session ends, so a worktree's resources do not run on after the work, and at the next
// session start it reports a stop that failed and the resources that are still listed.
export const RECORD = '.neil-dev.worktree.json'
const SECTION = 'ndev:worktree-stacks'
const VERSION = 2
// session.end shares one short bound (about 1.5 s) across the chain: the script only starts the
// detached stop and returns, so this is enough.
const LAUNCH_TIMEOUT_MS = 1200

type LastStop = { at?: string; command?: string; exitCode?: number; output?: string; repair?: string }
type Stack = { kind: string; projectId: string; workdir?: string; cliVersion?: string; lastStop?: LastStop }
type DevServer = { pid: number; port: number; command: string; cwd: string; started: string; lastStop?: LastStop }
type Resources = { stacks: Stack[]; servers: [string, DevServer][] }

let root: string | undefined
let script = ''
let text: string | undefined

const ids = (stacks: Stack[]) => stacks.map(s => `${s.kind} ${s.projectId}`).join(', ')
const names = (servers: [string, DevServer][]) => servers.map(([n, d]) => `dev server ${n} (pid ${d.pid}, port ${d.port})`).join(', ')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const outside = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).filter(k => !allowed.includes(k)).map(k => `"${k}"`)

// Reads the worktree's record. A missing file is no resources. A file that does not parse, a
// version 1 file and a shape this hook does not know throw, with the repair in the message.
// worktree_env.mjs checks each entry in full; this checks the layout.
async function readResources($: EngineInterface, dir: string): Promise<Resources> {
  const path = `${dir}/${RECORD}`
  if (!(await $.fs.exists(path))) return { stacks: [], servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String(error).slice(0, 160)})`)
  }
  if (isObject(parsed) && parsed.version === 1) {
    throw new Error(`${path} uses the version 1 layout (the stacks at the top level). Repair: bash ${script} migrate --worktree ${dir}`)
  }
  if (!isObject(parsed)) throw new Error(`${path} does not hold a JSON object`)
  const top = outside(parsed, ['version', 'settings', 'resources', 'workflow', 'workflows', 'prs'])
  if (top.length > 0) throw new Error(`${path} has the unknown top-level key ${top.join(', ')}`)
  if (parsed.version !== VERSION) throw new Error(`${path} has "version" ${JSON.stringify(parsed.version)}; ndev reads version ${VERSION}`)
  const resources = parsed.resources
  if (!isObject(resources)) throw new Error(`${path} has no "resources" object`)
  const kinds = outside(resources, ['docker', 'dev-servers'])
  if (kinds.length > 0) throw new Error(`${path} has the unknown resource ${kinds.join(', ')}; the resources are docker, dev-servers`)
  const docker = resources.docker ?? []
  const servers = resources['dev-servers'] ?? {}
  if (!Array.isArray(docker)) throw new Error(`${path} has resources.docker that is not a list`)
  if (!isObject(servers)) throw new Error(`${path} has resources.dev-servers that is not an object keyed by server name`)
  return { stacks: docker as Stack[], servers: Object.entries(servers) as [string, DevServer][] }
}

const tail = (output: string | undefined) => (output ?? '').trim().split('\n').slice(-8).join('\n    ') || '(none)'

const describeFailure = (dir: string, s: Stack) => {
  const l = s.lastStop ?? {}
  return [
    `- ${s.kind} stack ${s.projectId} (workdir ${s.workdir ?? 'unknown'}) did not stop at ${l.at ?? 'an earlier session end'}.`,
    `  command: ${l.command ?? 'unknown'}; exit code ${l.exitCode ?? 'unknown'}`,
    `  output: ${tail(l.output)}`,
    `  repair: ${l.repair ?? l.command ?? 'unknown'}`,
    `  then: bash ${script} remove-stack --kind ${s.kind} --project-id ${s.projectId} --worktree ${dir}`,
  ].join('\n')
}

const describeServerFailure = (dir: string, [name, d]: [string, DevServer]) => {
  const l = d.lastStop ?? {}
  return [
    `- dev server ${name} (pid ${d.pid}, port ${d.port}, ${d.command} in ${d.cwd}) did not stop at ${l.at ?? 'an earlier session end'}.`,
    `  output: ${tail(l.output)}`,
    `  repair: ${l.repair ?? `lsof -nP -iTCP:${d.port} -sTCP:LISTEN, then stop that process`}`,
    `  then: bash ${script} remove-dev-server --name ${name} --worktree ${dir}`,
  ].join('\n')
}

// Called from register.ts's session.start: finds the worktree root and reports earlier failed stops,
// and the resources still listed. A toast at the last session end can go unseen, and a stop that
// never started leaves no lastStop, so the listing itself is the evidence.
export async function startWorktreeStacks($: EngineInterface, cwd: string, project: LoadedConfig | undefined) {
  root = undefined
  text = undefined
  script = `${$.plugin.root}/scripts/work/worktree-env.sh`
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10000 })
  // Outside a git repository there is no worktree to hold the record.
  if (top.exitCode !== 0 || top.stdout.trim() === '') return
  root = top.stdout.trim()
  let found: Resources
  try {
    found = await readResources($, root)
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error)
    const repair = detail.includes(' migrate ') ? '' : ` Repair the file, then check it with \`bash ${script} list --worktree ${root}\`.`
    text = `Worktree resources: ${detail}. The resources listed there are not stopped at session end until it is fixed.${repair}`
    $.ui.toast(`ndev: ${detail.slice(0, 240)}${repair ? `. Repair it, then run bash ${script} list --worktree ${root}` : ''}`)
    return
  }
  const { stacks, servers } = found
  const failed = stacks.filter(s => s.lastStop !== undefined)
  const failedServers = servers.filter(([, d]) => d.lastStop !== undefined)
  // With keep-running the stacks are meant to outlive a session, so a listing is no news. Dev
  // servers stop at every session end, so a listed one is always news.
  const keep = project?.config.worktreeStacks?.onSessionEnd === 'keep-running'
  const listed = keep ? [] : stacks.filter(s => s.lastStop === undefined)
  const listedServers = servers.filter(([, d]) => d.lastStop === undefined)
  const parts: string[] = []
  if (failed.length > 0) {
    parts.push(
      `Worktree stacks: a stop at an earlier session end failed, so these stacks may still run and hold Docker resources. Run each repair, then the remove-stack command. Tell the person if a repair fails.`,
      ...failed.map(s => describeFailure(root!, s)),
    )
    $.ui.toast(`ndev: the stop of ${ids(failed)} failed at an earlier session end. Repair: ${failed[0]!.lastStop?.repair ?? `bash ${script} stop-all --worktree ${root}`}`)
  }
  if (failedServers.length > 0) {
    parts.push(
      `Worktree dev servers: a stop at an earlier session end failed, so these servers may still run and hold their ports. Run each repair, then the remove-dev-server command. Tell the person if a repair fails.`,
      ...failedServers.map(s => describeServerFailure(root!, s)),
    )
    $.ui.toast(`ndev: the stop of ${names(failedServers)} failed at an earlier session end. Repair: ${failedServers[0]![1].lastStop?.repair ?? `bash ${script} stop-all --worktree ${root}`}`)
  }
  if (listed.length > 0) {
    parts.push(
      `Worktree stacks: ${root}/${RECORD} still lists ${ids(listed)}, which may run from an earlier session. If this task uses a stack, leave it listed: it is stopped when this session ends. If not, stop them now with \`bash ${script} stop-all --worktree ${root}\`.`,
    )
  }
  if (listedServers.length > 0) {
    parts.push(
      `Worktree dev servers: ${root}/${RECORD} still lists ${names(listedServers)}, which may run from an earlier session. If this task uses a server, leave it listed: it is stopped when this session ends. If not, stop the dev servers now with \`bash ${script} stop-all --worktree ${root} --on-end keep-running\` (keep-running leaves the stacks).`,
    )
  }
  if (parts.length > 0) text = parts.join('\n')
}

export const worktreeStacksSection = () => (text === undefined ? undefined : { id: SECTION, text, scope: 'session' as const })

// Called from register.ts's session.end. It never throws: a failure is a toast with the repair, and
// the session still ends. /clear and resume go on in the same process and worktree, so they stop
// nothing. Dev servers stop at every session end. The stacks follow worktreeStacks.onSessionEnd;
// with keep-running, or a project file with an error, the stop runs with --on-end keep-running,
// which stops the dev servers only.
export async function stopWorktreeStacks($: EngineInterface, reason: string, project: LoadedConfig | undefined) {
  if (root === undefined || reason === 'clear' || reason === 'resume') return
  const dir = root
  try {
    const { stacks, servers } = await readResources($, dir)
    if (stacks.length === 0 && servers.length === 0) return
    let policy: StackPolicy = project?.config.worktreeStacks?.onSessionEnd ?? 'stop-and-delete'
    if (project?.error) {
      policy = 'keep-running'
      if (stacks.length > 0) $.ui.toast(`ndev: did not stop ${ids(stacks)}: ${project.path} has an error (${project.error}). Fix ${CONFIG_FILE}, then run bash ${script} stop-all --worktree ${dir}`)
    } else if (policy === 'keep-running' && stacks.length > 0) {
      $.ui.toast(`ndev: left ${ids(stacks)} running (${CONFIG_FILE} worktreeStacks.onSessionEnd is keep-running). Stop them with bash ${script} stop-all --worktree ${dir} --on-end stop-and-delete`)
    }
    if (policy === 'keep-running' && servers.length === 0) return
    const ran = await $.process.run(
      ['bash', script, 'stop-all', '--background', '--on-end', policy, '--worktree', dir],
      { cwd: dir, timeoutMs: LAUNCH_TIMEOUT_MS },
    )
    if (ran.exitCode !== 0) {
      const output = (ran.stderr || ran.stdout).trim().slice(0, 300)
      const what = [ids(policy === 'keep-running' ? [] : stacks), names(servers)].filter(Boolean).join(', ')
      $.ui.toast(`ndev: the stop of ${what} did not start: worktree-env.sh exited ${ran.exitCode}: ${output}. Repair: bash ${script} stop-all --worktree ${dir} --on-end ${policy}`)
    }
  } catch (error) {
    // An error that names its own repair (a version 1 record names migrate) gets no second one:
    // stop-all would refuse the same record.
    const detail = String(error instanceof Error ? error.message : error).slice(0, 300)
    const repair = detail.includes('Repair:') ? '' : `. Repair: bash ${script} stop-all --worktree ${dir}`
    $.ui.toast(`ndev: the resources of ${dir} were not stopped: ${detail}${repair}`)
  }
}
