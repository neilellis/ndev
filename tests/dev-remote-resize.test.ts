import { expect, test } from './sdk-testing'

// /dev remote resize changes the Hetzner server type of the box that the project's Orca workers run on. It finds the
// box from the Orca server (its SSH host, then the Hetzner instance id), asks a person, pauses each live worker there
// (WIP commit and a handoff in ~/handoff), shuts the box down, changes the type with the disk kept, starts it, and
// starts each worker again in its own worktree. Only the command-line tools are faked: hcloud, ssh and orca.

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const HOME = '/home/user'
const ORCA_DATA = '/orca-data'
const RUNTIMES = `${ORCA_DATA}/orca-ephemeral-vm-runtimes.json`
const ENV = 'env-1'
const HOST = 'orca@198.51.100.86'
const out = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const ok = (result: unknown) => out(JSON.stringify({ ok: true, result }))

const price = (location: string, gross: string) => ({ location, price_monthly: { net: '0', gross } })
const type = (name: string, cores: number, memory: number, disk: number, architecture: string, gross: string, extra: Record<string, unknown> = {}) =>
  ({ name, cores, memory, disk, architecture, deprecated: false, deprecation: null, prices: [price('fsn1', gross)], ...extra })
const TYPES = [
  type('cx23', 2, 4, 40, 'x86', '5.3431'),
  type('cx33', 4, 8, 80, 'x86', '10.1880'),
  type('cx41', 8, 16, 160, 'x86', '15.0000', { deprecated: true, deprecation: { announced: '2025-01-01', unavailable_after: '2025-06-01' } }),
  type('cx43', 8, 16, 160, 'x86', '18.5640'),
  type('cx53', 16, 32, 320, 'x86', '35.3430'),
  type('cax31', 8, 16, 160, 'arm', '15.9000'),
  type('cpx42', 8, 16, 320, 'x86', '30.0000'),
  type('cx13', 2, 2, 20, 'x86', '4.0000'),
]

type Box = { id: number; name: string; status: string; primary_disk_size: number; server_type: (typeof TYPES)[number]; datacenter: { location: { name: string } } }
type Worker = { dispatchId: string; runId: string; taskId: string; dispatchStatus: string; server?: { environmentId: string; name: string }; worktree?: string; liveness?: string; agent?: string; model?: string; effort?: string }

const WORKERS: Worker[] = [
  { dispatchId: 'd-a', runId: 'run-1', taskId: 't-a', dispatchStatus: 'dispatched', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/orca/workspaces/acme-app/772-api-docs', liveness: 'live', agent: 'claude', model: 'opus', effort: 'high' },
  { dispatchId: 'd-b', runId: 'run-1', taskId: 't-b', dispatchStatus: 'dispatched', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/orca/workspaces/acme-app/780-gone', liveness: 'exited', agent: 'claude' },
  { dispatchId: 'd-c', runId: 'run-2', taskId: 't-c', dispatchStatus: 'completed', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/orca/workspaces/acme-app/790-done', liveness: 'exited', agent: 'claude' },
  { dispatchId: 'd-d', runId: 'run-2', taskId: 't-d', dispatchStatus: 'dispatched', server: { environmentId: 'env-other', name: 'other' }, worktree: 'repo-1::/srv/x', liveness: 'live', agent: 'claude' },
  { dispatchId: 'd-e', runId: 'run-2', taskId: 't-e', dispatchStatus: 'dispatched', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/orca/workspaces/acme-app/fix-login', liveness: 'live', agent: 'codex' },
  { dispatchId: 'd-local', runId: 'run-2', taskId: 't-l', dispatchStatus: 'dispatched', liveness: 'live', agent: 'claude' },
]
const TASKS: Record<string, { id: string; task_title: string; spec: string }[]> = {
  'run-1': [{ id: 't-a', task_title: '#772 API docs', spec: 'Write the API docs for #772.' }, { id: 't-b', task_title: 'gone', spec: 'x' }],
  'run-2': [{ id: 't-e', task_title: 'Fix login', spec: 'Fix the login redirect.' }, { id: 't-c', task_title: 'done', spec: 'y' }],
}

// The brief of each live dispatch, to know which worker a worker-start is for.
const TASKS_BY_DISPATCH: Record<string, string> = { 'd-a': 'Write the API docs for #772.', 'd-e': 'Fix the login redirect.' }

const argOf = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)

type Opts = {
  config?: unknown
  runtimes?: unknown
  workers?: Worker[]
  // The dispatches that never write the paused line.
  silent?: string[]
  // shutdown does not end in time, so the server stays on.
  stuck?: boolean
  // How many Orca probes fail after the restart before one answers.
  orcaDownFor?: number
  answer?: (question: string, options: string[]) => string | undefined
  // The Runs of this machine; a worker of another Run is one this machine did not dispatch.
  localRuns?: string[]
  // The dispatch whose pause request Orca refuses to send.
  sendFails?: string
  // The dispatch whose restart fails: the receipt says so and worker-start exits 1.
  startFails?: string
  // change-type outruns its time; the change goes on at Hetzner and the box stays off and cx33 when it is read.
  changeTimeout?: boolean
}

function world(on: On, opts: Opts = {}) {
  const files = new Map<string, string>([
    [`${ROOT}/.ndev.json`, JSON.stringify(opts.config ?? { github: { repo: 'acme/widgets', board: null }, remote: { hcloudContext: 'proj' } })],
    [RUNTIMES, JSON.stringify(opts.runtimes ?? { version: 1, runtimes: [
      { runtimeEnvironmentId: 'env-old', status: 'cleaned', recipeResult: { connection: { type: 'ssh', target: { host: '10.9.9.9', port: 22, username: 'orca' } } } },
      { runtimeEnvironmentId: ENV, status: 'running', recipeResult: { connection: { type: 'ssh', target: { label: 'dev-host-2', host: '198.51.100.86', port: 22, username: 'orca' } } } },
    ] })],
  ])
  const workers = opts.workers ?? WORKERS
  const box: Box = { id: 901, name: 'dev-host-2', status: 'running', primary_disk_size: 80, server_type: TYPES[1]!, datacenter: { location: { name: 'fsn1' } } }
  const runs: { argv: string[] }[] = []
  const asked: { question: string; options: string[] }[] = []
  const sent = new Set<string>()
  let orcaDown = opts.orcaDownFor ?? 0
  let started = 0
  let restarted = false
  const localRuns = opts.localRuns ?? ['run-0', 'run-1', 'run-2']
  // The Orca server keeps its own Run for each Run that dispatched to it, with an id of its own.
  const serverRun = (w: Worker) => `srv-${w.runId}`

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'remote-resize-session' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'ORCA_USER_DATA_PATH' ? ORCA_DATA : HOME }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || e.path.startsWith(`${HOME}/dev-wiki`) }))
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    const options = q.options.map((o: { label: string }) => o.label)
    asked.push({ question: q.question, options })
    const answer = opts.answer ? opts.answer(q.question, options) : options[0]
    if (answer === undefined) throw new Error('dismissed')
    return { result: { answers: { [q.question]: answer } }, text: answer }
  })

  const hcloud = (a: string[]) => {
    const cmd = a.join(' ')
    if (cmd === 'hcloud context list -o noheader -o columns=name') return out('other\nproj\n')
    if (a[1] !== '--context') return out('', 1, `unexpected hcloud call with no --context: ${cmd}`)
    const r = a.slice(3).join(' ')
    if (r === 'server list -o json') return out(JSON.stringify([{ ...box, id: 77, name: 'other' }, box]))
    if (r === 'server-type list -o json') return out(JSON.stringify(TYPES))
    if (r === 'api /pricing') return out(JSON.stringify({ pricing: { currency: 'EUR' } }))
    if (r === `server describe ${box.id} -o json`) return out(JSON.stringify(box))
    if (r.startsWith(`server shutdown ${box.id}`)) {
      if (opts.stuck) return out('', 1, 'hcloud: timeout waiting for action')
      box.status = 'off'
      return out()
    }
    if (r === `server poweroff ${box.id}`) { box.status = 'off'; return out() }
    if (r.startsWith('server change-type ')) {
      if (box.status !== 'off') return out('', 1, 'hcloud: server must be stopped')
      if (opts.changeTimeout) return out('', -1, 'it did not run to its end: timed out after 600000 ms')
      box.server_type = TYPES.find(t => t.name === a.at(-1))!
      return out()
    }
    if (r === `server poweron ${box.id}`) { box.status = 'running'; restarted = true; return out() }
    return out('', 1, `unmocked hcloud: ${cmd}`)
  }

  const flag = (a: string[], name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined)
  const orca = (a: string[]) => {
    const sub = a.slice(1, 3).join(' ')
    if (sub === 'environment list') return ok({ environments: [{ id: ENV, name: 'dev-host-2' }] })
    // This machine's records. With no --run the list holds only the Run the terminal is bound to (run-0, empty).
    if (sub === 'orchestration worker-list' && a.includes('--include-remote')) {
      const run = flag(a, '--run') ?? 'run-0'
      return ok({ scope: { run, source: a.includes('--run') ? 'flag' : 'bound' }, workers: workers.filter(w => w.runId === run).map(w => ({ dispatchId: w.dispatchId, runId: w.runId, taskId: w.taskId, dispatchStatus: w.dispatchStatus, workerState: 'ready', ...(w.server ? { server: w.server } : {}) })), page: { hasMore: false } })
    }
    // The Orca server's own records, by its own Run ids.
    if (sub === 'orchestration worker-list' && flag(a, '--environment') === ENV) {
      const run = flag(a, '--run')
      return ok({ workers: workers.filter(w => serverRun(w) === run && w.server?.environmentId === ENV).map(w => ({ dispatchId: w.dispatchId, taskId: w.taskId, runId: run, dispatchStatus: w.dispatchStatus, resource: { worktreeId: w.worktree }, projection: { liveness: { verdict: w.liveness } } })), page: { hasMore: false } })
    }
    if (sub === 'orchestration worker-show') {
      const w = workers.find(x => x.dispatchId === flag(a, '--dispatch'))!
      return ok({ dispatch: { runId: w.runId, taskId: w.taskId }, worker: { startOptions: w.agent ? { agent: w.agent, launch: { requested: { agent: w.agent, ...(w.model ? { model: w.model } : {}), ...(w.effort ? { effort: w.effort } : {}) } } } : {} } })
    }
    if (sub === 'orchestration task-list') return ok({ runId: flag(a, '--run'), tasks: TASKS[flag(a, '--run')!] ?? [] })
    if (sub === 'orchestration send') {
      const to = flag(a, '--to')!.replace('dispatch:', '')
      if (to === opts.sendFails) return out(JSON.stringify({ ok: false, error: { code: 'send_failed', message: 'the mailbox of the dispatch is closed' } }), 1)
      sent.add(to)
      return ok({ id: 'msg-1' })
    }
    if (sub === 'orchestration run-list' && flag(a, '--environment') === ENV) {
      if (restarted && orcaDown > 0) { orcaDown--; return out(JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'server not reachable' } }), 1) }
      return ok({ runs: [...new Set(workers.filter(w => w.server?.environmentId === ENV).map(serverRun))].map(id => ({ id })) })
    }
    if (sub === 'orchestration run-list') return ok({ runs: localRuns.map(id => ({ id })) })
    if (sub === 'orchestration worker-start') {
      started++
      if (opts.startFails && argOf(a, '--spec')?.includes(TASKS_BY_DISPATCH[opts.startFails] ?? '?')) {
        return out(JSON.stringify({ ok: true, result: { state: 'failed', dispatchId: `new-${started}`, lastError: 'agent_launch_failed', failedStage: 'launch', recovery: 'Run orca orchestration worker-release --dispatch new-2, then start again.' } }), 1)
      }
      return ok({ state: 'ready', dispatchId: `new-${started}`, taskId: `nt-${started}` })
    }
    return out('', 1, `unmocked orca: ${a.join(' ')}`)
  }

  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push({ argv: a })
    if (a[0] === 'git') return out(`${ROOT}\n`)
    if (a[0] === 'sleep') return out()
    if (a[0] === 'orca') return orca(a)
    if (a.includes('hcloud')) {
      if (a.slice(0, 5).join(' ') !== 'env -u HCLOUD_TOKEN -u HCLOUD_CONTEXT') return out('', 1, `hcloud ran with HCLOUD_TOKEN in reach: ${a.join(' ')}`)
      return hcloud(a.slice(5))
    }
    if (a[0] === 'ssh') {
      if (!a.includes('BatchMode=yes') || !a.includes('StrictHostKeyChecking=yes')) return out('', 1, `ssh without BatchMode and StrictHostKeyChecking: ${a.join(' ')}`)
      if (a.at(-2) !== HOST) return out('', 255, `ssh: connect to host ${a.at(-2)}: no route`)
      const remote = a.at(-1)!
      if (box.status !== 'running') return out('', 255, 'ssh: connect to host: Connection refused')
      if (remote === 'curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id') return out(String(box.id))
      if (remote.includes('handoff')) return out([...sent].filter(id => !(opts.silent ?? []).includes(id) && remote.includes(`paused ${id}`)).map(id => `${id}\n`).join(''))
      if (remote === 'true') return out()
      return out('', 1, `unmocked ssh: ${remote}`)
    }
    return out('', 1, `unmocked: ${a.join(' ')}`)
  })

  const hcloudRuns = () => runs.filter(r => r.argv.includes('hcloud')).map(r => r.argv.slice(r.argv.indexOf('hcloud')))
  return {
    runs, asked, box, sent, hcloudRuns,
    // The hcloud calls that switch or change the server, without the context words.
    changes: () => hcloudRuns().map(a => a.slice(3).join(' ')).filter(r => /^server (shutdown|poweroff|poweron|change-type)\b/.test(r)),
    orcaRuns: (sub: string) => runs.filter(r => r.argv[0] === 'orca' && r.argv.slice(1, 3).join(' ') === sub).map(r => r.argv),
  }
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive })
const dev = async ($: Engine, args: string) => (await $.command.run({ command: 'dev', args: `remote ${args}`.trim() })).text ?? ''

test('with no hcloud context in .ndev.json and no --context, resize stops before any call to Hetzner and names the key to set', async ($, on) => {
  const w = world(on, { config: { github: { repo: 'acme/widgets', board: null } } })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/no hcloud context/)
  expect(text).toMatch(/"remote": \{ "hcloudContext": "<context>" \}/)
  expect(text).toMatch(/\/proj\/\.ndev\.json/)
  expect(text).toMatch(/--context <context>/)
  expect(w.hcloudRuns().filter(a => a[1] === '--context')).toEqual([])
  expect(w.sent.size).toBe(0)
})

test('.ndev.json refuses a remote key that is not { "hcloudContext": "<name>" }', async ($, on) => {
  world(on, { config: { github: { repo: 'acme/widgets', board: null }, remote: { hcloudContext: '' } } })
  await start($)
  expect(await dev($, 'resize cx43')).toMatch(/"remote\.hcloudContext" must be a non-empty string/)
})

test('with no type, resize lists the server types and recommends the next size up of the same family and architecture, and changes nothing', async ($, on) => {
  const w = world(on)
  await start($)

  const text = await dev($, 'resize')
  expect(text).toMatch(/dev-host-2 \(901\) is cx33: 4 vCPU, 8 GB memory, 80 GB disk/)
  expect(text).toMatch(/Recommended: cx43 \(8 vCPU, 16 GB memory, 160 GB disk\), EUR 18\.56 a month/)
  expect(text).toMatch(/\/dev remote resize cx43/)
  expect(text).toMatch(/cpx42/)
  expect(text).not.toMatch(/cx41/) // deprecated
  expect(text).not.toMatch(/cax31/) // another architecture
  expect(w.hcloudRuns().filter(a => a[1] === '--context').every(a => a[2] === 'proj')).toBe(true)
  expect(w.asked).toEqual([])
  expect(w.changes()).toEqual([])
  expect(w.sent.size).toBe(0)
})

test('resize pauses each live worker on the box, shuts it down, changes the type with the disk kept, starts it, and starts each worker again in its worktree', async ($, on) => {
  const w = world(on)
  await start($)

  const text = await dev($, 'resize cx43')

  // The person sees the box, both types, the cost and the workers before anything changes.
  expect(w.asked).toHaveLength(1)
  const plan = w.asked[0]!.question
  expect(plan).toMatch(/hcloud context "proj"/)
  expect(plan).toMatch(/dev-host-2 \(901\)/)
  expect(plan).toMatch(/from cx33 \(4 vCPU, 8 GB memory, 80 GB disk, EUR 10\.19 a month\)/)
  expect(plan).toMatch(/to cx43 \(8 vCPU, 16 GB memory, 160 GB disk, EUR 18\.56 a month\)/)
  expect(plan).toMatch(/restarts/)
  expect(plan).toMatch(/d-a/)
  expect(plan).toMatch(/d-e/)
  expect(w.asked[0]!.options).toEqual(['Resize dev-host-2 to cx43', 'Cancel'])

  // Only the live dispatches on this server are paused, each asked for a WIP commit, a short handoff and a reply.
  expect([...w.sent].sort()).toEqual(['d-a', 'd-e'])
  const pauseA = w.orcaRuns('orchestration send').find(a => argOf(a, '--to') === 'dispatch:d-a')!
  expect(argOf(pauseA, '--run')).toBe('run-1')
  const body = argOf(pauseA, '--body')!
  expect(body).toMatch(/commit/i)
  expect(body).toMatch(/~\/handoff\/772\.md/)
  expect(body).toMatch(/15 lines or fewer/)
  expect(body).toMatch(/branch, HEAD, PR/)
  expect(body).toMatch(/paused d-a/)
  expect(argOf(w.orcaRuns('orchestration send').find(a => argOf(a, '--to') === 'dispatch:d-e')!, '--body')).toMatch(/~\/handoff\/d-e\.md/)

  // The Hetzner steps run in order, each with the context named.
  expect(w.changes()).toEqual(['server shutdown 901 --wait --wait-timeout 180s', 'server change-type --keep-disk 901 cx43', 'server poweron 901'])
  expect(w.hcloudRuns().filter(a => a[1] === '--context').every(a => a[2] === 'proj')).toBe(true)
  expect(w.box.server_type.name).toBe('cx43')

  // Each paused worker starts again on the same server, in the same worktree, with its own agent and the handoff.
  const starts = w.orcaRuns('orchestration worker-start')
  expect(starts).toHaveLength(2)
  const a = starts.find(s => argOf(s, '--run') === 'run-1')!
  expect(argOf(a, '--on')).toBe(ENV)
  expect(argOf(a, '--worktree')).toBe('id:repo-1::/home/orca/orca/workspaces/acme-app/772-api-docs')
  expect(argOf(a, '--agent')).toBe('claude')
  expect(argOf(a, '--model')).toBe('opus')
  expect(argOf(a, '--effort')).toBe('high')
  expect(argOf(a, '--spec')).toMatch(/^Write the KG docs for #772\.[\s\S]*Resume from ~\/handoff\/772\.md/)
  const e = starts.find(s => argOf(s, '--run') === 'run-2')!
  expect(argOf(e, '--agent')).toBe('codex')
  expect(e).not.toContain('--model')
  expect(argOf(e, '--spec')).toMatch(/Resume from ~\/handoff\/d-e\.md/)

  // A worker-list with no --run shows only the bound Run, so each listing of this machine's records names its Run.
  expect(w.orcaRuns('orchestration worker-list').filter(x => x.includes('--include-remote')).every(x => x.includes('--run'))).toBe(true)
  expect(text).toMatch(/task t-a -> nt-\d in run run-1/)
  expect(text).toMatch(/\/dev triage/)

  // Orca is checked again before any worker starts.
  const order = w.runs.map(r => r.argv.slice(0, 3).join(' '))
  expect(order.lastIndexOf('orca orchestration run-list')).toBeLessThan(order.indexOf('orca orchestration worker-start'))
  expect(text).toMatch(/dev-host-2 \(901\) is now cx43/)
  expect(text).toMatch(/new-1/)
  expect(text).not.toMatch(/WARNING/)
})

test('resize changes nothing and pauses no worker when the person cancels', async ($, on) => {
  const w = world(on, { answer: () => 'Cancel' })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/cancelled/)
  expect(w.sent.size).toBe(0)
  expect(w.changes()).toEqual([])
})

test('resize is refused in a session with no person and no --yes', async ($, on) => {
  const w = world(on)
  await start($, false)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/no one confirmed it/)
  expect(text).toMatch(/--yes/)
  expect(w.sent.size).toBe(0)
  expect(w.changes()).toEqual([])
})

test('a worker that does not reply stops the resize before the shutdown, and is named', async ($, on) => {
  const w = world(on, { silent: ['d-e'] })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/did not pause/)
  expect(text).toMatch(/d-e/)
  expect(text).not.toMatch(/d-a[^\n]*did not pause/)
  expect(text).toMatch(/Repair:/)
  expect(w.changes()).toEqual([])
  expect(w.orcaRuns('orchestration worker-start')).toEqual([])
})

test('a shutdown that does not end in time falls back to poweroff and says so loudly', async ($, on) => {
  const w = world(on, { stuck: true })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(w.changes()).toEqual(['server shutdown 901 --wait --wait-timeout 180s', 'server poweroff 901', 'server change-type --keep-disk 901 cx43', 'server poweron 901'])
  expect(text).toMatch(/WARNING: dev-host-2 \(901\) did not shut down/)
  expect(text).toMatch(/powered off/)
  expect(text).toMatch(/hcloud --context proj server shutdown 901 --wait --wait-timeout 180s exited 1: hcloud: timeout waiting for action/)
})

test('resize waits for Orca to answer for the server again before it starts the workers', async ($, on) => {
  const w = world(on, { orcaDownFor: 3 })
  await start($)

  await dev($, 'resize cx43')
  expect(w.orcaRuns('orchestration run-list').length).toBeGreaterThanOrEqual(4)
  expect(w.orcaRuns('orchestration worker-start')).toHaveLength(2)
})

test('resize refuses a type with a smaller disk, another architecture, the same type or an unknown one, before any change', async ($, on) => {
  const w = world(on)
  await start($)

  expect(await dev($, 'resize cx13')).toMatch(/cx13 has a 20 GB disk[\s\S]*80 GB/)
  expect(await dev($, 'resize cax31')).toMatch(/cax31 is arm[\s\S]*x86/)
  expect(await dev($, 'resize cx33')).toMatch(/already cx33/)
  expect(await dev($, 'resize zz99')).toMatch(/no server type "zz99"[\s\S]*cx43/)
  expect(w.asked).toEqual([])
  expect(w.sent.size).toBe(0)
  expect(w.changes()).toEqual([])
})

test('with no SSH host in Orca\'s runtimes and no --ssh, resize stops and names --ssh', async ($, on) => {
  const w = world(on, { runtimes: { version: 1, runtimes: [] } })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/no SSH host/)
  expect(text).toMatch(/--ssh <user@host>/)
  expect(w.changes()).toEqual([])
})

test('--ssh and --context override the runtimes file and the project setting', async ($, on) => {
  const w = world(on, { runtimes: { version: 1, runtimes: [] }, config: { github: { repo: 'acme/widgets', board: null }, remote: { hcloudContext: 'other' } } })
  await start($)

  await dev($, `resize --ssh ${HOST} --context proj --yes cx43`)
  expect(w.hcloudRuns().filter(a => a[1] === '--context').every(a => a[2] === 'proj')).toBe(true)
  expect(w.box.server_type.name).toBe('cx43')
})

test('resize with no live worker on the box resizes it and starts none', async ($, on) => {
  const w = world(on, { workers: [WORKERS[2]!, WORKERS[3]!] })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(w.asked[0]!.question).toMatch(/No worker runs on it/)
  expect(w.sent.size).toBe(0)
  expect(w.box.server_type.name).toBe('cx43')
  expect(w.orcaRuns('orchestration worker-start')).toEqual([])
  expect(text).toMatch(/is now cx43/)
})

test('resize takes no option of create, remove or import', async ($, on) => {
  world(on)
  await start($)
  expect(await dev($, 'resize cx43 --location fsn1')).toMatch(/--location is not an option of \/dev remote resize/)
})

test('a worker on the box that no Run of this machine dispatched stops the resize before anything changes, and is named', async ($, on) => {
  const w = world(on, { workers: [...WORKERS, { dispatchId: 'd-x', runId: 'run-9', taskId: 't-x', dispatchStatus: 'dispatched', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/x', liveness: 'live', agent: 'claude' }] })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/d-x \(task t-x\): it runs on the box, but no Run of this machine dispatched it/)
  expect(text).toMatch(/Repair: resize from the machine that started it/)
  expect(w.asked).toEqual([])
  expect(w.sent.size).toBe(0)
  expect(w.changes()).toEqual([])
})

test('a worker that is still starting on the box stops the resize, and is named', async ($, on) => {
  const w = world(on, { workers: [...WORKERS, { dispatchId: 'd-p', runId: 'run-2', taskId: 't-e', dispatchStatus: 'pending', server: { environmentId: ENV, name: 'dev-host-2' }, worktree: 'repo-1::/home/orca/p', liveness: 'unverifiable', agent: 'claude' }] })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/d-p: it is still starting \(pending\)/)
  expect(w.sent.size).toBe(0)
  expect(w.changes()).toEqual([])
})

test('a pause request that Orca does not send stops the resize, and names the workers asked already and how to let them go on', async ($, on) => {
  const w = world(on, { sendFails: 'd-e' })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/step 3 \(pause the workers\) failed: the request to pause d-e \(Fix login, run run-2\) was not sent/)
  expect(text).toMatch(/send_failed: the mailbox of the dispatch is closed/)
  expect(text).toMatch(/asked to pause already and can stop: d-a/)
  expect(text).toMatch(/orca orchestration send --to dispatch:d-a --run run-1 [^\n]*"Continue your task"/)
  expect(text).toMatch(/asked d-a to pause/)
  expect(w.changes()).toEqual([])
})

test('a restart whose receipt says it failed, with exit 1, is named with the receipt and the repair, and the other worker still starts', async ($, on) => {
  const w = world(on, { startFails: 'd-e' })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(w.box.server_type.name).toBe('cx43')
  expect(w.orcaRuns('orchestration worker-start')).toHaveLength(2)
  expect(text).toMatch(/step 5 \(start the workers again\) failed: dev-host-2 is now cx43, but 1 of 2 workers did not start again/)
  expect(text).toMatch(/d-e \(Fix login\): orca orchestration worker-start exited 1: the worker did not start: agent_launch_failed at launch \(dispatch new-\d\)\. Run orca orchestration worker-release/)
  expect(text).toMatch(/Repair: orca orchestration worker-start --spec/)
  expect(text).toMatch(/Started again:\n {2}d-a -> new-\d/)
})

test('a change of type that outruns its time reads the box again and says its real status and type', async ($, on) => {
  const w = world(on, { changeTimeout: true })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/step 4 \(change the type\) failed: hcloud --context proj server change-type --keep-disk 901 cx43 exited -1: it did not run to its end/)
  expect(text).toMatch(/Hetzner gives dev-host-2 the status "off" and the type cx33 now/)
  expect(text).toMatch(/Repair: when the status is "off" and the type is cx33/)
  expect(text).toMatch(/start each again by hand/)
  expect(w.changes()).not.toContain('server poweron 901')
  expect(w.orcaRuns('orchestration worker-start')).toEqual([])
})

test('only a running runtime gives the SSH host; with none, resize stops and names --ssh', async ($, on) => {
  const w = world(on, { runtimes: { version: 1, runtimes: [{ runtimeEnvironmentId: ENV, status: 'stopped', recipeResult: { connection: { type: 'ssh', target: { host: '10.1.1.1', port: 22, username: 'orca' } } } }] } })
  await start($)

  const text = await dev($, 'resize cx43')
  expect(text).toMatch(/no running runtime for the Orca server dev-host-2 \(env-1\), only "stopped"/)
  expect(text).toMatch(/--ssh <user@host>/)
  expect(w.runs.filter(r => r.argv[0] === 'ssh')).toEqual([])
  expect(w.changes()).toEqual([])
})

test('--ssh refuses a target that ssh could read as an option, and every ssh call ends its options before the target', async ($, on) => {
  const w = world(on)
  await start($)

  expect(await dev($, 'resize cx43 --ssh -oProxyCommand=x@host')).toMatch(/--ssh needs <user>@<host>/)
  expect(w.runs.filter(r => r.argv[0] === 'ssh')).toEqual([])
  await dev($, 'resize')
  const ssh = w.runs.filter(r => r.argv[0] === 'ssh').map(r => r.argv)
  expect(ssh.length).toBeGreaterThan(0)
  expect(ssh.every(a => a.at(-3) === '--' && a.at(-2) === HOST)).toBe(true)
})
