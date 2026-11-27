import type { EngineInterface } from 'claude-code'

import type { LoadedConfig } from './config'
import { makeRun, orca } from './remote-orca.ts'
import { triageRemote } from './remote-selection.ts'
import { confirm, contextOf, exec, hc, hcJson, type HostOptions, type Out, pause, said, type ServerType, shown, steps } from './remote-host.ts'
import { projectKey, type Server } from './remote-store.ts'

// /dev remote resize [<type>]: change the Hetzner server type of the box that the project's Orca server runs on.
// 1. Find the box: the Orca server's SSH host (Orca's runtimes file, or --ssh), its Hetzner instance id from the
//    metadata service, and that id in hcloud server list. The hcloud context is --context, else remote.hcloudContext
//    in .ndev.json; the active context is never used.
// 2. Show the current type and the target, and ask a person: the change is paid and restarts the box. With no type,
//    list the types it can take and recommend the next size up of its family, and change nothing.
// 3. Pause each live Orca worker on the box: a WIP commit, a handoff in ~/handoff/<issue>.md on the box, and a reply.
//    The wait reads the handoff over SSH for the line "paused <dispatch>", because only the box shows it for certain.
// 4. Shut the box down (poweroff only when that fails, with a warning), change the type with the disk kept, start it,
//    and wait for SSH and for Orca to answer for the server again.
// 5. Start each paused worker again on the same server, in the same worktree, with its task and the handoff.
// Every step fails fast: the message names the step, the command, its output and the repair.

const SHUTDOWN_WAIT = '180s'
const CHANGE_MS = 600_000 // the most that a process may run; a change with the disk kept takes some minutes
const PAUSE_TRIES = 60
const PAUSE_EVERY_SECS = 15
const SSH_TRIES = 40
const SSH_EVERY_SECS = 5
const ORCA_TRIES = 30
const ORCA_EVERY_SECS = 10
const METADATA = 'curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id'
const SAFE = /^[A-Za-z0-9._-]+$/

type Type = ServerType & { deprecated?: boolean; deprecation?: unknown }
type Box = { id: number; name: string; status: string; primary_disk_size?: number; server_type: Type; location?: { name: string }; datacenter?: { location?: { name: string } } }
type Ssh = { target: string; port: string }
type Live = { dispatchId: string; runId: string; taskId: string; worktree: string; key: string; agent: string; model?: string; effort?: string; spec: string; title: string }

// ---- Step 1: the box ----

// The SSH host of the Orca server: --ssh, else the ssh connection that Orca recorded for the server's runtime.
async function sshOf($: EngineInterface, env: Server, wanted: string | undefined): Promise<Ssh> {
  if (wanted !== undefined) {
    if (!/^[^\s@-][^\s@]*@[^\s@:-][^\s@:]*$/.test(wanted)) throw new Error(`--ssh needs <user>@<host>, such as orca@203.0.113.7; got "${wanted}". Nothing changed.`)
    return { target: wanted, port: '22' }
  }
  const data = (await $.env.get('ORCA_USER_DATA_PATH')) || `${await $.env.get('HOME')}/Library/Application Support/orca`
  const path = `${data}/orca-ephemeral-vm-runtimes.json`
  const none = `no SSH host is known for the Orca server ${env.name} (${env.id}): ${path} has no ssh connection for it. Nothing changed.\nRepair: name the box with --ssh <user@host>, as in /dev remote resize <type> --ssh orca@<address>.`
  if (!(await $.fs.exists(path))) throw new Error(none)
  type Runtime = { runtimeEnvironmentId?: string; status?: string; recipeResult?: { connection?: { type?: string; target?: { host?: string; port?: number; username?: string } } } }
  let runtimes: Runtime[]
  try {
    runtimes = (JSON.parse(await $.fs.read(path)) as { runtimes?: Runtime[] }).runtimes ?? []
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Nothing changed.\nRepair: name the box with --ssh <user@host>.`)
  }
  // Only a running runtime is the box now: an older record can name an address that another server has since.
  const ours = runtimes.filter(r => r.runtimeEnvironmentId === env.id && r.recipeResult?.connection?.type === 'ssh' && r.recipeResult.connection.target?.host)
  const r = ours.find(x => x.status === 'running')
  if (!r) throw new Error(ours.length ? `${path} has no running runtime for the Orca server ${env.name} (${env.id}), only ${ours.map(x => `"${x.status ?? 'no status'}"`).join(', ')}, so its SSH host is not known for certain. Nothing changed.\nRepair: name the box with --ssh <user@host>, as in /dev remote resize <type> --ssh orca@<address>.` : none)
  const t = r.recipeResult!.connection!.target!
  const target = `${t.username ?? 'orca'}@${t.host}`
  if (target.includes(' ') || t.host!.startsWith('-')) throw new Error(`${path} gives the SSH host "${target}" for ${env.name}, which is not a host. Nothing changed.\nRepair: name the box with --ssh <user@host>.`)
  return { target, port: String(t.port ?? 22) }
}

// The host key must already be known: BatchMode and StrictHostKeyChecking stop any prompt and any trust on first use.
// "--" ends the options, so a target can never be read as one.
const sshArgv = (s: Ssh, command: string) => ['ssh', '-p', s.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '--', s.target, command]
const sshShown = (s: Ssh, command: string) => `ssh -p ${s.port} ${s.target} ${command}`
async function sshRun($: EngineInterface, s: Ssh, command: string, timeoutMs = 60_000): Promise<Out> {
  return exec($, sshArgv(s, command), { timeoutMs })
}

async function findBox($: EngineInterface, ctx: string, s: Ssh): Promise<Box> {
  const o = await sshRun($, s, METADATA)
  const id = o.stdout.trim()
  if (o.exitCode !== 0 || !/^\d+$/.test(id)) {
    throw new Error(`${sshShown(s, METADATA)} exited ${o.exitCode}: ${o.exitCode === 0 ? `it printed "${id.slice(0, 80)}", not a Hetzner instance id` : said(o)}. Nothing changed.\nRepair: check that ssh -p ${s.port} ${s.target} true works with no prompt (the host key must be in ~/.ssh/known_hosts), or name the box with --ssh <user@host>.`)
  }
  const box = (await hcJson<Box[]>($, ctx, ['server', 'list', '-o', 'json'])).find(b => String(b.id) === id)
  if (!box) throw new Error(`the box ${s.target} is the Hetzner server ${id}, and the hcloud context ${ctx} has no server ${id} (${shown(ctx, ['server', 'list', '-o', 'json'])}). Nothing changed.\nRepair: name the context of the Hetzner project that holds it, with --context <context> or "remote": { "hcloudContext": "<context>" } in .ndev.json.`)
  return box
}

// ---- Step 2: the types ----

const specs = (t: Type) => `${t.cores} vCPU, ${t.memory} GB memory, ${t.disk} GB disk`
const arch = (t: Type) => t.architecture ?? 'x86'
const family = (t: Type) => /^[a-z]+/.exec(t.name)?.[0] ?? t.name
const isSold = (t: Type, location: string) => !t.deprecated && !t.deprecation && t.prices.some(p => p.location === location)

function plans(box: Box, types: Type[], currency: string) {
  const location = box.location?.name ?? box.datacenter?.location?.name ?? '?'
  const now = types.find(t => t.name === box.server_type.name) ?? box.server_type
  const disk = box.primary_disk_size ?? now.disk
  const money = (t: Type) => {
    const gross = t.prices.find(p => p.location === location)?.price_monthly.gross
    return gross === undefined ? `no price listed in ${location}` : `${currency} ${Number(gross).toFixed(2)} a month`
  }
  const full = (t: Type) => `${t.name} (${specs(t)}, ${money(t)})`
  const choices = types
    .filter(t => t.name !== now.name && isSold(t, location) && arch(t) === arch(now) && t.disk >= disk)
    .sort((a, b) => a.memory - b.memory || a.cores - b.cores || a.disk - b.disk || a.name.localeCompare(b.name))
  const next = choices.find(t => family(t) === family(now) && (t.memory > now.memory || (t.memory === now.memory && t.cores > now.cores)))
  return { location, now, disk, money, full, choices, next }
}

type Plans = ReturnType<typeof plans>

function listing(box: Box, ctx: string, p: Plans): string {
  const rows = p.choices.map(t => `  ${p.full(t)}${t === p.next ? '   <- recommended' : ''}`)
  return [
    `${box.name} (${box.id}) is ${p.now.name}: ${specs(p.now)}, ${p.money(p.now)}. It is in the hcloud context ${ctx}, location ${p.location}, and its disk is ${p.disk} GB.`,
    p.choices.length ? `The types it can change to (${arch(p.now)}, sold in ${p.location}, a disk of ${p.disk} GB or more; prices with VAT):` : `No other type is sold in ${p.location} for ${arch(p.now)} with a disk of ${p.disk} GB or more.`,
    ...rows,
    p.next ? `Recommended: ${p.next.name} (${specs(p.next)}), ${p.money(p.next)}, the next size up of the ${family(p.now)} family. To resize to it, run /dev remote resize ${p.next.name}.` : `No larger ${family(p.now)} type is sold in ${p.location}. Pick one of the list, with /dev remote resize <type>.`,
    'Nothing changed.',
  ].join('\n')
}

function target(box: Box, ctx: string, types: Type[], p: Plans, name: string): Type {
  const t = types.find(x => x.name === name)
  const which = (p.next ? ` Recommended: ${p.next.name}.` : '') + ` The types it can take: ${p.choices.map(c => c.name).join(', ') || 'none'}. Nothing changed.`
  if (!t) throw new Error(`there is no server type "${name}" in the hcloud context ${ctx}.${which}`)
  if (t.name === p.now.name) throw new Error(`${box.name} (${box.id}) is already ${t.name}.${which}`)
  if (arch(t) !== arch(p.now)) throw new Error(`${t.name} is ${arch(t)} and ${box.name} (${box.id}) is ${arch(p.now)}: Hetzner changes a server only to a type of its own architecture.${which}`)
  if (t.disk < p.disk) throw new Error(`${t.name} has a ${t.disk} GB disk, and the disk of ${box.name} (${box.id}) is ${p.disk} GB: a disk cannot get smaller.${which}`)
  if (!isSold(t, p.location)) throw new Error(`${t.name} is not sold in ${p.location}, where ${box.name} (${box.id}) is${t.deprecated || t.deprecation ? ' (Hetzner has deprecated it)' : ''}.${which}`)
  return t
}

// ---- Step 3: the workers ----

type Page = { workers?: unknown[]; page?: { hasMore?: boolean; nextCursor?: string } }

// Every worker of a worker-list, page by page. A list that does not end in 20 pages is refused.
async function allWorkers<T>(run: ReturnType<typeof makeRun>, args: string[]): Promise<T[]> {
  const all: T[] = []
  let cursor: string | undefined
  for (let n = 0; n < 20; n++) {
    const r = (await orca(run, [...args, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])) as Page
    all.push(...((r.workers ?? []) as T[]))
    cursor = r.page?.hasMore ? r.page.nextCursor : undefined
    if (!cursor) return all
  }
  throw new Error(`orca ${args.join(' ')} has more than 20 pages of workers; the list was not read to its end. Nothing changed.`)
}

// Every Run of a run-list, page by page. A list that does not end is refused, so no Run is missed.
async function allRuns(run: ReturnType<typeof makeRun>, where: string[]): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let n = 0; n < 20; n++) {
    const r = (await orca(run, ['orchestration', 'run-list', ...where, '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])) as { runs?: { id: string }[]; page?: { hasMore?: boolean; nextCursor?: string } }
    const runs = r.runs ?? []
    ids.push(...runs.map(x => x.id))
    cursor = r.page?.hasMore ? r.page.nextCursor : undefined
    if (!cursor) {
      if (!r.page && runs.length >= 100) break // a full page with no cursor: the end is not proven
      return ids
    }
  }
  throw new Error(`orca orchestration run-list ${where.join(' ')} did not show its end (a full page with no cursor, or more than 20 pages of 100), so a Run with a worker on the box could be missed. Nothing changed.`)
}

type ServerRecord = { dispatchId: string; taskId?: string; runId?: string; dispatchStatus?: string; resource?: { worktreeId?: string }; projection?: { liveness?: { verdict?: string }; workspace?: { id?: string } } }
type Owner = { dispatchId: string; runId?: string; taskId: string; server?: { environmentId?: string } }

// The workers that run now on the box, with what each needs to start again. Every worker is checked before anything
// changes: one that cannot start again stops the command here.
// Two lists, because neither is whole alone. A worker-list with no --run shows only the Run that this terminal is
// bound to, so each Run is listed by name:
// - the box: the Orca server's own records of each Run it holds. They show every worker that runs there.
// - the owner: the Runs of this machine. The messages and the restart go through the Run that dispatched the worker.
async function liveWorkers($: EngineInterface, env: Server, agentGiven: string | undefined): Promise<Live[]> {
  const run = makeRun($, 120_000)
  type Requested = { agent?: string; model?: string; effort?: string }
  type Shown = { worker?: { startOptions?: { agent?: string; launch?: { requested?: Requested } } } }
  type Task = { id: string; task_title?: string; display_name?: string; spec?: string }

  const onBox: ServerRecord[] = []
  for (const serverRun of await allRuns(run, ['--environment', env.id])) {
    const records = await allWorkers<ServerRecord>(run, ['orchestration', 'worker-list', '--environment', env.id, '--run', serverRun])
    onBox.push(...records.filter(w => (w.dispatchStatus === 'dispatched' || w.dispatchStatus === 'pending') && w.projection?.liveness?.verdict !== 'exited'))
  }
  if (!onBox.length) return []

  // The Run on this machine that dispatched each one. The search stops when every worker on the box has its Run.
  const owners = new Map<string, Owner & { runId: string }>()
  for (const runId of await allRuns(run, [])) {
    for (const w of await allWorkers<Owner>(run, ['orchestration', 'worker-list', '--run', runId, '--include-remote'])) {
      if (w.server?.environmentId === env.id) owners.set(w.dispatchId, { ...w, runId })
    }
    if (onBox.every(w => owners.has(w.dispatchId))) break
  }

  const live: Live[] = []
  const problems: string[] = []
  const tasksOf = new Map<string, Task[]>()
  for (const b of onBox) {
    const w = owners.get(b.dispatchId)
    if (!SAFE.test(b.dispatchId)) { problems.push(`${b.dispatchId}: the dispatch id has characters that a shell command on the box cannot carry safely`); continue }
    if (b.dispatchStatus === 'pending') { problems.push(`${b.dispatchId}: it is still starting (pending), so it cannot take the request to pause. Repair: wait until it runs, then run the command again`); continue }
    if (!w) { problems.push(`${b.dispatchId} (task ${b.taskId ?? 'unknown'}): it runs on the box, but no Run of this machine dispatched it, so this machine cannot pause it or start it again. Repair: resize from the machine that started it, or end that worker first`); continue }
    if (!tasksOf.has(w.runId)) tasksOf.set(w.runId, ((await orca(run, ['orchestration', 'task-list', '--run', w.runId])) as { tasks?: Task[] }).tasks ?? [])
    const worktree = b.resource?.worktreeId ?? b.projection?.workspace?.id
    const shownW = (await orca(run, ['orchestration', 'worker-show', '--dispatch', b.dispatchId, '--environment', env.id])) as Shown
    const so = shownW.worker?.startOptions
    const requested = so?.launch?.requested ?? {}
    const agent = requested.agent ?? so?.agent ?? agentGiven
    const task = tasksOf.get(w.runId)!.find(t => t.id === w.taskId)
    const folder = (worktree ?? '').split('::').at(-1)!.split('/').at(-1) ?? ''
    const key = /^(\d+)/.exec(folder)?.[1] ?? b.dispatchId
    if (!worktree) problems.push(`${b.dispatchId} (run ${w.runId}): Orca names no worktree for it, so it cannot start again in the same place`)
    else if (!agent) problems.push(`${b.dispatchId} (run ${w.runId}): Orca does not record its agent. Repair: name it with --agent <agent>, such as --agent claude`)
    else if (!task?.spec) problems.push(`${b.dispatchId} (run ${w.runId}): its task ${w.taskId} has no spec in orca orchestration task-list --run ${w.runId}, so its brief cannot be given again`)
    else live.push({ dispatchId: b.dispatchId, runId: w.runId, taskId: w.taskId, worktree, key, agent, ...(requested.model ? { model: requested.model } : {}), ...(requested.effort ? { effort: requested.effort } : {}), spec: task.spec, title: task.task_title ?? task.display_name ?? key })
  }
  if (problems.length) throw new Error(`these workers on ${env.name} cannot be paused and started again:\n- ${problems.join('\n- ')}\nNothing changed and no worker was paused.`)
  // Two workers in one issue folder get their dispatch id as the handoff name, so no handoff overwrites another.
  const counts = new Map<string, number>()
  for (const w of live) counts.set(w.key, (counts.get(w.key) ?? 0) + 1)
  return live.map(w => (counts.get(w.key)! > 1 || !SAFE.test(w.key) ? { ...w, key: w.dispatchId } : w))
}

const handoff = (w: Live) => `~/handoff/${w.key}.md`

const pauseBody = (w: Live, box: Box) => [
  `Stop for a server resize. The server ${box.name} shuts down in a few minutes and starts again as a new server type. A new worker then continues your task in this worktree.`,
  'Do these steps now, in this sequence:',
  '1. Commit your work in progress on your branch (git add -A, then git commit -m "WIP: pause for server resize").',
  `2. Write a handoff of 15 lines or fewer to ${handoff(w)} (make the folder ~/handoff if it is not there). Give: branch, HEAD, PR, what is done, next steps, open questions and tests (passed, failed, not run).`,
  `3. Make this the last line of that file, exactly: paused ${w.dispatchId}`,
  '4. Reply "paused" to this message. Then stop: start no new work and run no more commands.',
].join('\n')

// One SSH call reads every handoff, and prints the dispatch id of each one that has its paused line.
const pausedCheck = (all: Live[]) => all.map(w => `if grep -qx 'paused ${w.dispatchId}' ${handoff(w)} 2>/dev/null; then echo ${w.dispatchId}; fi`).join('; ')

// ---- Step 5: the restart ----

const resumeSpec = (w: Live) => `${w.spec}\n\nResume from ${handoff(w)}. The server was resized, and the worker before you stopped for it. Read that file first: it gives the branch, HEAD, PR, what is done and the next steps. Your worktree is as that worker left it.`
const startArgs = (w: Live, env: Server) => ['orchestration', 'worker-start', '--spec', resumeSpec(w), '--task-title', `${w.title} (resumed after the resize)`, '--run', w.runId, '--on', env.id,
  '--worktree', `id:${w.worktree}`, '--agent', w.agent, ...(w.model ? ['--model', w.model] : []), ...(w.effort ? ['--effort', w.effort] : []), '--timeout-ms', '120000']
const startByHand = (w: Live, env: Server) => `orca orchestration worker-start --spec "<the task of ${w.dispatchId}>, then: Resume from ${handoff(w)}" --run ${w.runId} --on ${env.id} --worktree id:${w.worktree} --agent ${w.agent}${w.model ? ` --model ${w.model}` : ''}${w.effort ? ` --effort ${w.effort}` : ''} --json`

// The restart is a new Task with the old brief and the handoff, and not --task <old> --retry-of <old dispatch>:
// Orca takes --retry-of only for a failed or stopped attempt, and the old Dispatch is neither. Its worker stopped its
// own turn, and Orca only sees the box go away. The old Task stays as it was; the result names it and the new one.
// worker-start can print its receipt and exit 1 when the start failed, so the receipt decides, as in /dev triage.
async function startAgain($: EngineInterface, w: Live, env: Server): Promise<{ dispatchId: string; taskId?: string }> {
  const o = await exec($, ['orca', ...startArgs(w, env), '--full', '--json'], { timeoutMs: 180_000 })
  type Receipt = { dispatchId?: string; taskId?: string; state?: string; failedStage?: string; lastError?: string; recovery?: string }
  let reply: { ok?: boolean; result?: Receipt; error?: { code?: string; message?: string } } | undefined
  try {
    reply = JSON.parse(o.stdout) as typeof reply
  } catch {
    throw new Error(`orca orchestration worker-start exited ${o.exitCode} and printed no JSON: ${said(o)}`)
  }
  if (!reply?.ok || !reply.result) throw new Error(`orca orchestration worker-start refused it (exit ${o.exitCode}): ${reply?.error?.code ?? 'no code'}: ${reply?.error?.message ?? JSON.stringify(reply).slice(0, 300)}`)
  const r = reply.result
  if (r.state !== 'ready' || !r.dispatchId) {
    throw new Error(`orca orchestration worker-start exited ${o.exitCode}: the worker did not start: ${r.lastError ?? r.state ?? 'no state'} at ${r.failedStage ?? 'an unknown stage'}${r.dispatchId ? ` (dispatch ${r.dispatchId})` : ''}. ${r.recovery ?? 'Orca gave no recovery.'}`)
  }
  return { dispatchId: r.dispatchId, ...(r.taskId ? { taskId: r.taskId } : {}) }
}

// ---- The command ----

async function describeBox($: EngineInterface, ctx: string, id: string): Promise<Box> {
  return hcJson<Box>($, ctx, ['server', 'describe', id, '-o', 'json'])
}

const failedAt = (step: string, error: unknown) => new Error(`step ${step} failed: ${error instanceof Error ? error.message : String(error)}`)
async function at<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw failedAt(step, error)
  }
}

export async function resizeHost($: EngineInterface, project: LoadedConfig | undefined, typeName: string | undefined, o: HostOptions): Promise<string> {
  if (project) projectKey(project) // refuses a .ndev.json with an error
  const kept = project?.config.remote?.hcloudContext
  if (!o.context && !kept) {
    throw new Error(`no hcloud context is named for the box. The context is the Hetzner project that pays, so it must be named: the active context and HCLOUD_CONTEXT are never used. Nothing changed.\nRepair: add "remote": { "hcloudContext": "<context>" } to ${project?.path ?? '.ndev.json at the project root'}, or run /dev remote resize --context <context>.`)
  }
  const env = await triageRemote($, project, o.server ?? '', '/dev remote resize', '/dev remote resize --server')
  const ctx = await contextOf($, `the box of ${env.name}`, o.context, kept, '/dev remote resize')

  const { box, s } = await at('1 (find the box)', async () => {
    const s = await sshOf($, env, o.ssh)
    return { box: await findBox($, ctx, s), s }
  })
  const { types, p } = await at('2 (read the server types)', async () => {
    const types = await hcJson<Type[]>($, ctx, ['server-type', 'list', '-o', 'json'])
    const currency = (await hcJson<{ pricing?: { currency?: string } }>($, ctx, ['api', '/pricing'])).pricing?.currency ?? ''
    return { types, p: plans(box, types, currency) }
  })
  if (!typeName) return listing(box, ctx, p)
  const to = target(box, ctx, types, p, typeName)
  const live = await at('3 (find the workers)', () => liveWorkers($, env, o.agent))

  const who = live.length
    ? `These ${live.length} workers on ${env.name} are paused first (a WIP commit and a handoff in ~/handoff on the box) and started again after, in the same worktrees: ${live.map(w => `${w.dispatchId} (${w.title}, ${w.agent})`).join(', ')}.`
    : `No worker runs on it, so none is paused.`
  await confirm($, o, [
    `Resize the Hetzner server ${box.name} (${box.id}) in the hcloud context "${ctx}", location ${p.location},`,
    `from ${p.full(p.now)}`,
    `to ${p.full(to)}. Prices with VAT; Hetzner bills by the hour at the new price from now on.`,
    `The server shuts down, changes type and restarts: it is off for some minutes. The disk stays at ${p.disk} GB (--keep-disk), so a smaller type is still possible later.`,
    who,
  ].join('\n'), `Resize ${box.name} to ${to.name}`, 'Nothing changed and no worker was paused.')

  const id = String(box.id)
  return steps($, async did => {
    // Step 3: pause.
    if (live.length) {
      await at('3 (pause the workers)', async () => {
        const run = makeRun($, 60_000)
        const asked: Live[] = []
        for (const w of live) {
          await orca(run, ['orchestration', 'send', '--to', `dispatch:${w.dispatchId}`, '--run', w.runId, '--subject', 'Pause for a server resize', '--body', pauseBody(w, box)]).catch((e: unknown) => {
            const back = asked.length
              ? `\nThese workers were asked to pause already and can stop: ${asked.map(x => x.dispatchId).join(', ')}.\nRepair: to give up the resize, send each "Continue your task" (${asked.map(x => `orca orchestration send --to dispatch:${x.dispatchId} --run ${x.runId} --subject Continue --body "Continue your task"`).join('; ')}). Or fix the send, then run /dev remote resize ${to.name} again.`
              : `\nNo worker was asked to pause.\nRepair: fix the send, then run /dev remote resize ${to.name} again.`
            throw new Error(`the request to pause ${w.dispatchId} (${w.title}, run ${w.runId}) was not sent: ${e instanceof Error ? e.message : String(e)}\nThe server was not touched.${back}`)
          })
          asked.push(w)
          did(`asked ${w.dispatchId} to pause`)
        }
      })
      const paused = new Set<string>()
      for (let n = 0; n < PAUSE_TRIES && paused.size < live.length; n++) {
        if (n > 0) await pause($, PAUSE_EVERY_SECS)
        const check = pausedCheck(live.filter(w => !paused.has(w.dispatchId)))
        const r = await sshRun($, s, check)
        if (r.exitCode !== 0) throw failedAt('3 (pause the workers)', new Error(`${sshShown(s, '<read the handoffs>')} exited ${r.exitCode}: ${said(r)}. The server was not touched.\nRepair: check that ssh -p ${s.port} ${s.target} true works, then run /dev remote resize ${to.name} again.`))
        for (const line of r.stdout.split('\n')) if (line.trim()) paused.add(line.trim())
      }
      const missing = live.filter(w => !paused.has(w.dispatchId))
      if (missing.length) {
        const mins = Math.round((PAUSE_TRIES * PAUSE_EVERY_SECS) / 60)
        throw failedAt('3 (pause the workers)', new Error([
          `${missing.map(w => `${w.dispatchId} (${w.title}, run ${w.runId})`).join(', ')} did not pause in ${mins} minutes: ${missing.map(handoff).join(', ')} on ${box.name} has no line "paused <dispatch id>". The server was not touched.`,
          paused.size ? `These workers paused and are stopped now: ${[...paused].join(', ')}.` : '',
          `Repair: look at each worker that did not pause (orca orchestration worker-show --dispatch <dispatch id> --environment ${env.id} --json). When it has paused, run /dev remote resize ${to.name} again; each worker gets the request again. To give up the resize, send each paused worker "Continue your task" with orca orchestration send --to dispatch:<dispatch id> --run <run id>.`,
        ].filter(Boolean).join('\n')))
      }
      did(`all ${live.length} workers paused`)
    }

    // Step 4: resize.
    const byHand = live.length ? `\nThe workers are paused. When the server is up, start each again by hand:\n${live.map(w => `  ${startByHand(w, env)}`).join('\n')}` : ''
    let warning = ''
    await at('4 (shut the server down)', async () => {
      try {
        await hc($, ctx, ['server', 'shutdown', id, '--wait', '--wait-timeout', SHUTDOWN_WAIT], { timeoutMs: 240_000 })
        const now = await describeBox($, ctx, id)
        if (now.status !== 'off') throw new Error(`${shown(ctx, ['server', 'describe', id, '-o', 'json'])} gives the status "${now.status}", not "off"`)
        did(`shut ${box.name} down`)
      } catch (error) {
        warning = `WARNING: ${box.name} (${id}) did not shut down in ${SHUTDOWN_WAIT}, so it was powered off, as if its power cable was pulled. Data that its programs had not written to disk can be lost. The shutdown: ${error instanceof Error ? error.message : String(error)}`
        $.ui.toast(warning)
        await hc($, ctx, ['server', 'poweroff', id], { timeoutMs: 180_000 }).catch((e: unknown) => {
          throw new Error(`${warning}\nThen ${e instanceof Error ? e.message : String(e)}.\nRepair: switch it off in the Hetzner Cloud Console, then run /dev remote resize ${to.name} --yes.${byHand}`)
        })
        did(`POWERED OFF ${box.name} after a failed shutdown`)
      }
      const now = await describeBox($, ctx, id)
      if (now.status !== 'off') throw new Error(`${box.name} (${id}) is "${now.status}" and not off after ${warning ? 'the poweroff' : 'the shutdown'}.\nRepair: switch it off with hcloud --context ${ctx} server poweroff ${id}, then run /dev remote resize ${to.name} --yes.${byHand}`)
    })
    await at('4 (change the type)', async () => {
      await hc($, ctx, ['server', 'change-type', '--keep-disk', id, to.name], { timeoutMs: CHANGE_MS }).catch(async (e: unknown) => {
        // A change that outran its time can still go on at Hetzner, so the box is read again before anything is said of it.
        const now = await describeBox($, ctx, id).then(b => `Hetzner gives ${box.name} the status "${b.status}" and the type ${b.server_type.name} now.`, (d: unknown) => `Its state now is not known: ${d instanceof Error ? d.message : String(d)}.`)
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${now}\nRepair: when the status is "off" and the type is ${p.now.name}, run hcloud --context ${ctx} server change-type --keep-disk ${id} ${to.name}, then hcloud --context ${ctx} server poweron ${id}; or start it as it was with the poweron alone. When Hetzner still shows an action on it, wait for that to end first (hcloud --context ${ctx} server describe ${id}).${byHand}`)
      })
      did(`changed ${box.name} to ${to.name}`)
    })
    await at('4 (start the server)', async () => {
      if ((await describeBox($, ctx, id)).status !== 'running') await hc($, ctx, ['server', 'poweron', id], { timeoutMs: 180_000 }).catch((e: unknown) => {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\nRepair: run hcloud --context ${ctx} server poweron ${id}.${byHand}`)
      })
      did(`started ${box.name}`)
      let last: Out = { exitCode: -1, stdout: '', stderr: 'not tried' }
      for (let n = 0; n < SSH_TRIES; n++) {
        if (n > 0) await pause($, SSH_EVERY_SECS)
        last = await sshRun($, s, 'true', 30_000)
        if (last.exitCode === 0) break
        if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(last.stderr)) {
          throw new Error(`${sshShown(s, 'true')} refused the host key: ${said(last)}\nThe disk was kept, so the key should not change.\nRepair: check the server's key in its Hetzner console before you trust a new one.${byHand}`)
        }
      }
      if (last.exitCode !== 0) throw new Error(`${sshShown(s, 'true')} did not answer after ${SSH_TRIES} tries (exit ${last.exitCode}): ${said(last)}\nRepair: open the server's console in the Hetzner Cloud Console and see why it does not boot.${byHand}`)
      const run = makeRun($, 60_000)
      let lastOrca = ''
      for (let n = 0; n < ORCA_TRIES; n++) {
        if (n > 0) await pause($, ORCA_EVERY_SECS)
        try {
          await orca(run, ['orchestration', 'run-list', '--environment', env.id, '--limit', '1'])
          lastOrca = ''
          break
        } catch (error) {
          lastOrca = error instanceof Error ? error.message : String(error)
        }
      }
      if (lastOrca) throw new Error(`Orca does not answer for the server ${env.name} (${env.id}) after ${ORCA_TRIES} tries: ${lastOrca}\nRepair: check that Orca runs on the box (ssh -p ${s.port} ${s.target}) and that Orca on this machine shows the server as connected.${byHand}`)
      did(`Orca answers for ${env.name} again`)
    })

    // Step 5: restart.
    const startedLines: string[] = []
    const failures: string[] = []
    for (const w of live) {
      try {
        const r = await startAgain($, w, env)
        startedLines.push(`  ${w.dispatchId} -> ${r.dispatchId} (${w.title}, ${w.agent}), resumes from ${handoff(w)}; task ${w.taskId} -> ${r.taskId ?? 'a new task'} in run ${w.runId}`)
        did(`started ${w.dispatchId} again as ${r.dispatchId}`)
      } catch (error) {
        failures.push(`  ${w.dispatchId} (${w.title}): ${error instanceof Error ? error.message : String(error)}\n    Repair: ${startByHand(w, env)}`)
      }
    }
    if (failures.length) throw failedAt('5 (start the workers again)', new Error(`${box.name} is now ${to.name}, but ${failures.length} of ${live.length} workers did not start again; their handoffs are on the box:\n${failures.join('\n')}${startedLines.length ? `\nStarted again:\n${startedLines.join('\n')}` : ''}${warning ? `\n${warning}` : ''}`))
    return [
      ...(warning ? [warning] : []),
      `${box.name} (${id}) is now ${p.full(to)}, in the hcloud context ${ctx}. It was ${p.now.name}. The disk stays at ${p.disk} GB.`,
      live.length ? `Workers started again in their worktrees, each as a new task:\n${startedLines.join('\n')}\nThe old tasks stay as they were. A coordinator that follows task ids, such as /dev triage, does not see the new ones.` : 'No worker ran on it, so none was started.',
    ].join('\n')
  })
}
