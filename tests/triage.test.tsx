import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ndev',
  component: 'Pane',
  requestId: 'triage',
  props: {
    title: 'Triage',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TOOL = 'mcp__ndev__triage_groups'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

const result = (exitCode: number, stdout: string, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const ok = (stdout: string) => result(0, stdout)
const reply = (r: unknown) => ok(JSON.stringify({ id: 'x', ok: true, result: r }))

// Waits for work the mod runs detached from the hook that started it.
async function until(check: () => boolean | Promise<boolean>, state?: () => unknown): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`the condition never held${state ? `: ${JSON.stringify(await state())}` : ''}`)
}

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type Issue = { number: number; title: string; url: string }
const issue = (number: number): Issue => ({ number, title: `Issue ${number}`, url: `https://github.com/acme/widgets/issues/${number}` })

// A message in the Run's inbox, as `orca orchestration check --json` prints it.
const message = (id: string, type: string, from: string, body: string, payload?: unknown) => ({
  id, run_id: 'run_1', from_handle: from, to_handle: 'run:run_1', subject: `${type} subject`, body, type,
  priority: 'normal', thread_id: null, payload: payload === undefined ? null : JSON.stringify(payload), created_at: '2026-10-29T16:29:35Z',
})

// A fake GitHub and Orca. Orca keeps its Tasks and workspaces: a Task with deps is pending until every dep's worker
// reported success, and a workspace keeps the links and board status set on it.
type Worktree = { id: string; projectId: string; path: string; isArchived: boolean; isMainWorktree: boolean; workspaceStatus: string; linkedPR: number | null; linkedItems: { type: string; number: number; url: string }[] }
function world(on: On, opts: { repo?: string; board?: { owner: string; number: number }; issues?: Issue[]; cards?: unknown[]; worktrees?: Worktree[]; startFails?: boolean; taskCreateFails?: boolean } = {}) {
  const ran: string[][] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const tasks: { id: string; deps: string[]; status: string; title: string }[] = []
  const worktrees: Worktree[] = [...(opts.worktrees ?? [])]
  // Each pull request's head branch, by number, as `gh pr view --json headRefName` answers it.
  const prHeads = new Map<number, number>()
  // Deliveries the fake inbox hands out, one per blocking check; a check waits until one is queued.
  const inbox: { deliveryId: string; messages: unknown[] }[] = []
  let wake: (() => void) | undefined
  const deliver = (d: { deliveryId: string; messages: unknown[] }) => { inbox.push(d); wake?.() }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/neil/dev-wiki/wiki.md' || e.path === '/.neil-dev.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ github: { repo: opts.repo ?? 'acme/widgets', board: opts.board ?? null } }) }))
  on('clock.every', () => new Promise(() => {}))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'triage-session' }))
  on('session.cwd', () => ({ value: '/' }))
  // The model's Bash calls: `orca orchestration reply` fails until the test says Orca takes it.
  const bash = { isReplyOk: false }
  on('tool.call', { tool: 'Bash' }, () => (bash.isReplyOk
    ? { result: { stdout: '{"id":"x","ok":true,"result":{}}', stderr: '', interrupted: false } }
    : { result: 'Error: Exit code 1\n{"id":"x","ok":false,"error":{"code":"not_found"}}', isError: true as const }))
  on('process.run', async (_, e) => {
    const a = [...e.argv]
    const args = a.join(' ')
    ran.push(a)
    if (a[0] === 'gh' && a[1] === 'issue' && a[2] === 'list') return ok(JSON.stringify(opts.issues ?? []))
    if (args.includes('gh.sh board items')) return ok((opts.cards ?? []).map(c => `${JSON.stringify(c)}\n`).join(''))
    if (a[0] === 'gh' && a[1] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(a[2] ?? '')) return ok(JSON.stringify({ headRefName: `claude/issue-${prHeads.get(Number(a[2]!.split('/').pop()))}` }))
    if (a[0] !== 'orca') return result(1, '', `unmocked: ${args}`)
    if (args.startsWith('orca worktree list')) return reply({ worktrees, totalCount: worktrees.length, truncated: false })
    if (args.startsWith('orca worktree create')) {
      const name = a[a.indexOf('--name') + 1]!
      const refs = a.flatMap((x, i) => (x === '--reference' ? [a[i + 1]!] : []))
      const wt: Worktree = { id: `repo-1::/w/${name}`, projectId: 'github:acme/widgets', path: `/w/${name}`, isArchived: false, isMainWorktree: false, workspaceStatus: 'in-progress', linkedPR: null,
        linkedItems: refs.map(url => ({ type: 'issue', number: Number(url.split('/').pop()), url })) }
      worktrees.push(wt)
      return reply({ worktree: wt })
    }
    if (args.startsWith('orca orchestration run-create')) return reply({ run: { id: 'run_1', objective: a[a.indexOf('--objective') + 1]! } })
    if (args.startsWith('orca orchestration task-create')) {
      if (opts.taskCreateFails && tasks.length === 1) return ok(JSON.stringify({ id: 'x', ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running' } }))
      const deps = a.includes('--deps') ? (JSON.parse(a[a.indexOf('--deps') + 1]!) as string[]) : []
      const t = { id: `task_${tasks.length + 1}`, deps, status: deps.length ? 'pending' : 'ready', title: a[a.indexOf('--task-title') + 1]! }
      tasks.push(t)
      return reply({ task: { id: t.id, run_id: 'run_1', status: t.status, deps: JSON.stringify(deps), task_title: t.title } })
    }
    if (args.startsWith('orca orchestration task-list')) {
      const ready = tasks.filter(t => t.status === 'ready')
      return reply({ runId: 'run_1', tasks: ready.map(t => ({ id: t.id, status: t.status, deps: JSON.stringify(t.deps) })), count: ready.length })
    }
    if (args.startsWith('orca orchestration worker-start')) {
      const task = a[a.indexOf('--task') + 1]!
      const n = task.slice('task_'.length)
      const launch = { agent: 'claude', model: a[a.indexOf('--model') + 1]!, effort: a[a.indexOf('--effort') + 1]! }
      if (opts.startFails) {
        return result(1, JSON.stringify({ id: 'x', ok: true, result: {
          runId: 'run_1', taskId: task, dispatchId: `ctx_${n}`, state: 'failed', stage: 'dispatch_input', failedStage: 'dispatch_input',
          lastError: 'agent_prompt_blocked', launch: { requested: launch, effective: launch },
          effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: `term_${n}` }],
          recovery: `This start created a terminal that never ran the Task. Close it with: orca orchestration worker-release --dispatch ctx_${n}`,
        } }))
      }
      tasks.find(t => t.id === task)!.status = 'dispatched'
      return reply({
        runId: 'run_1', taskId: task, dispatchId: `ctx_${n}`, state: 'ready', stage: 'ready', launch: { requested: launch, effective: launch },
        effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: `term_${n}` }],
      })
    }
    if (args.startsWith('orca orchestration check') && a.includes('--ack')) return reply({ runId: 'run_1', acknowledged: a[a.indexOf('--ack') + 1]! })
    if (args.startsWith('orca orchestration check')) {
      while (inbox.length === 0) await new Promise<void>(resolve => { wake = resolve })
      const d = inbox.shift()!
      // A succeeded worker_done completes its Task, which readies the Tasks waiting on it.
      for (const m of d.messages as { type: string; payload: string | null }[]) {
        let p: { taskId?: string; outcome?: string } = {}
        try { p = m.payload ? (JSON.parse(m.payload) as typeof p) : {} } catch { /* a garbled payload completes nothing */ }
        if (m.type === 'worker_done' && p.outcome === 'succeeded') {
          tasks.find(t => t.id === p.taskId)!.status = 'completed'
          for (const t of tasks) if (t.status === 'pending' && t.deps.every(id => tasks.find(x => x.id === id)?.status === 'completed')) t.status = 'ready'
        }
      }
      return reply({ runId: 'run_1', deliveryId: d.deliveryId, messages: d.messages, count: d.messages.length, timedOut: false })
    }
    if (args.startsWith('orca orchestration worker-show')) {
      const d = a[a.indexOf('--dispatch') + 1]!
      return reply({ worker: { dispatchId: d, agentTerminalHandle: `term_${d.slice('ctx_'.length)}` }, observation: { status: 'live', agentWait: null } })
    }
    if (args.startsWith('orca orchestration worker-list')) return reply({ workers: [], page: { hasMore: false, nextCursor: null } })
    return reply({})
  })
  const orcaRan = (verb: string) => ran.filter(a => a[0] === 'orca' && a.slice(1, 3).join(' ') === verb)
  // What the worker does after it opens its pull request: link it to the workspace and move the card to review.
  const linkPr = (path: string, pr: number) => { const wt = worktrees.find(x => x.path === path)!; wt.linkedPR = pr; wt.workspaceStatus = 'in-review'; prHeads.set(pr, Number(path.split('-').pop())) }
  return { ran, prompts, toasts, tasks, deliver, orcaRan, linkPr, bash }
}

const command = (args: string) => ({ command: 'orca-triage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const)

const group = (issues: number[], complexity: string, more: Record<string, unknown> = {}) =>
  ({ issues, title: `Fix ${issues.map(n => `#${n}`).join(' ')}`, complexity, hint: `Look at area ${issues[0]}`, ...more })

async function started($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
}

test('with no board, /orca-triage start asks the model to group the open issues with no PR that no Orca workspace links', async ($, on) => {
  const w = world(on, {
    issues: [issue(3), issue(7), issue(9)],
    worktrees: [{ id: 'repo-1::/w/seven', projectId: 'github:acme/widgets', path: '/w/seven', isArchived: false, isMainWorktree: false, workspaceStatus: 'in-progress', linkedPR: null,
      linkedItems: [{ type: 'issue', number: 7, url: issue(7).url }] }],
  })
  await started($)
  const r = await $.command.run(command('start'))
  expect(r.text).toMatch(/triage/i)
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  const list = w.ran.find(a => a[0] === 'gh' && a[1] === 'issue')!
  expect(list.join(' ')).toMatch(/--search -linked:pr/)
  expect(w.prompts[0]).toMatch(/#3\b/)
  expect(w.prompts[0]).toMatch(/#9\b/)
  expect(w.prompts[0]).not.toMatch(/#7\b/)
  expect(w.prompts[0]).toMatch(new RegExp(TOOL))
})

test('with a board, /orca-triage start takes the issues in Ready and In progress', async ($, on) => {
  const card = (n: number, status: string, kind = 'issues') =>
    ({ number: n, title: `Card ${n}`, status, itemId: `PVTI_${n}`, url: `https://github.com/acme/widgets/${kind}/${n}` })
  const w = world(on, { board: { owner: 'acme', number: 4 }, cards: [card(3, 'Ready'), card(4, 'Done'), card(6, 'In progress'), card(8, 'Ready', 'pull'),
    { ...card(5, 'Ready'), url: 'https://github.com/acme/other/issues/5' }, { number: null, title: 'A draft', status: 'Ready', itemId: 'PVTI_d', url: null }] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  expect(w.ran.some(a => a[0] === 'gh' && a[1] === 'issue')).toBe(false)
  expect(w.prompts[0]).toMatch(/#3\b/)
  expect(w.prompts[0]).toMatch(/#6\b/)
  expect(w.prompts[0]).not.toMatch(/#4\b/)
  expect(w.prompts[0]).not.toMatch(/#8\b/)
  // A card of another repository on a shared board, and a draft card, are not this repository's issues.
  expect(w.prompts[0]).not.toMatch(/#5\b/)
  expect(w.prompts[0]).not.toMatch(/A draft/)
})

test('the groups report is refused unless it covers each issue once, with known sizes and a real order', async ($, on) => {
  world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  const call = (groups: unknown[]) => $.tool.call({ tool: TOOL, groups } as never) as Promise<{ result?: unknown; isError?: boolean }>
  await until(async () => !(await call([])).result?.toString().includes('not waiting'))

  const missing = await call([group([3], 'simple')])
  expect(missing.isError).toBe(true)
  expect(String(missing.result)).toMatch(/#9 is in no group/)
  const twice = await call([group([3, 9], 'simple'), group([9], 'average')])
  expect(String(twice.result)).toMatch(/#9 is in 2 groups/)
  const size = await call([group([3, 9], 'huge')])
  expect(String(size.result)).toMatch(/"huge" is not a complexity/)
  const order = await call([group([3], 'simple', { after: [5] }), group([9], 'simple')])
  expect(String(order.result)).toMatch(/after #5, which leads no group/)
  const cycle = await call([group([3], 'simple', { after: [9] }), group([9], 'simple', { after: [3] })])
  expect(String(cycle.result)).toMatch(/cycle/)
  const proof = await call([group([3, 9], 'simple', { implemented: true })])
  expect(String(proof.result)).toMatch(/evidence/)
})

test('accepted groups become one Orca Run with a Task each; Orca makes the workspace and starts the worker for each ready Task', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(4), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  const accepted = await $.tool.call({ tool: TOOL, groups: [group([4, 3], 'simple'), group([9], 'complex', { after: [3] })] } as never) as { result?: unknown; isError?: boolean }
  expect(accepted.isError).toBeFalsy()
  await until(() => w.orcaRan('orchestration worker-start').length > 0, () => w.ran)

  expect(w.orcaRan('orchestration run-create')).toHaveLength(1)
  const created = w.orcaRan('orchestration task-create')
  expect(created).toHaveLength(2)
  expect(created[0]).not.toContain('--deps')
  expect(created[0]).toEqual(expect.arrayContaining(['--run', 'run_1', '--display-name', 'issue-3']))
  expect(created[1]).toEqual(expect.arrayContaining(['--deps', '["task_1"]', '--run', 'run_1']))
  // The spec names the branch, the draft PR and the worker contract.
  const spec = created[0]![created[0]!.indexOf('--spec') + 1]
  expect(spec).toMatch(/claude\/issue-3/)
  expect(spec).toMatch(/Closes #3/)
  expect(spec).toMatch(/Closes #4/)
  expect(spec).toMatch(/draft/i)
  expect(spec).toMatch(/orca orchestration ask/)
  expect(spec).toMatch(/worker_done/)
  expect(spec).toMatch(/orca worktree set --worktree active --pr <number> --workspace-status in-review/)

  // Orca makes the workspace, linked to the group's issues, then starts the worker in it.
  const made = w.ran.filter(a => a.slice(0, 3).join(' ') === 'orca worktree create')
  expect(made).toHaveLength(1)
  expect(made[0]).toEqual(expect.arrayContaining(['--project', 'github:acme/widgets', '--name', 'issue-3', '--no-parent', '--setup', 'run']))
  expect(made[0]!.filter((x, i) => made[0]![i - 1] === '--reference')).toEqual([issue(3).url, issue(4).url])

  const starts = w.orcaRan('orchestration worker-start')
  expect(starts).toHaveLength(1)
  expect(starts[0]).toEqual(expect.arrayContaining([
    '--task', 'task_1', '--run', 'run_1', '--worktree', 'id:repo-1::/w/issue-3',
    '--agent', 'claude', '--model', 'claude-haiku-5-5', '--effort', 'xhigh',
  ]))
  expect(starts[0]).not.toContain('--name')
})

// Orca keeps project ids in lower case and matches them exactly, so a repository saved as Owner/Name must not miss its setup.
test('a repository saved in mixed case makes its Orca workspace under the lower-case project id', async ($, on) => {
  const w = world(on, { repo: 'Acme/Widgets', issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  const accepted = await $.tool.call({ tool: TOOL, groups: [group([3], 'simple')] } as never) as { result?: unknown; isError?: boolean }
  expect(accepted.isError).toBeFalsy()
  await until(() => w.orcaRan('orchestration worker-start').length > 0, () => w.ran)

  const made = w.ran.filter(a => a.slice(0, 3).join(' ') === 'orca worktree create')
  expect(made).toHaveLength(1)
  expect(made[0]).toEqual(expect.arrayContaining(['--project', 'github:acme/widgets']))
})

// A group that follows another starts from that group's branch, so its pull request carries the change it needs and the
// two never edit the same lines from different bases.
test('a group that follows another branches from that group\'s branch and targets its pull request', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9), issue(12)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  expect(w.prompts[0]).toMatch(/same files/)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] }), group([12], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration task-create').length === 3, () => w.ran)
  const specs = w.orcaRan('orchestration task-create').map(a => a[a.indexOf('--spec') + 1]!)
  const follower = specs.find(x => x.includes('#9 ('))!
  expect(follower).toMatch(/follows #3/)
  expect(follower).toMatch(/--base <that branch>/)
  const alone = specs.find(x => x.includes('#12 ('))!
  expect(alone).toMatch(/from the default branch/)
  expect(alone).not.toMatch(/--base/)
  // The first workspaces start from the default branch; the follower's waits for #3 and starts from its branch.
  const creates = () => w.orcaRan('worktree create')
  await until(() => creates().length === 2, () => w.ran)
  for (const c of creates()) expect(c).not.toContain('--base-branch')
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'Opened #41.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => creates().length === 3, () => w.ran)
  expect(creates()[2]).toEqual(expect.arrayContaining(['--name', 'issue-9', '--base-branch', 'origin/claude/issue-3']))
})

test('a group whose predecessor opened no pull request starts from the default branch', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] })] } as never)
  await until(() => w.orcaRan('worktree create').length === 1, () => w.ran)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'Already done; no change.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('worktree create').length === 2, () => w.ran)
  expect(w.orcaRan('worktree create')[1]).not.toContain('--base-branch')
})

test('a question goes to the model with the reply command; worker_done retains the worker and starts the Task it unblocked', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'complex', { after: [3] })] } as never)
  await until(() => w.orcaRan('orchestration check').length > 0, () => w.ran)

  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'question', 'term_1', 'Keep the old API?')] })
  await until(() => w.prompts.length > 1, () => w.ran)
  expect(w.prompts[1]).toMatch(/Keep the old API\?/)
  expect(w.prompts[1]).toMatch(/orca orchestration reply --id msg_1/)
  expect(w.prompts[1]).toMatch(/#3\b/)
  await until(() => w.ran.some(a => a.includes('--ack') && a.includes('delivery_1')))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Keep the old API/ }))?.text).toBeDefined()
  // A reply Orca refused leaves the question open on the group's row; the reply it took closes it.
  const asks = { type: 'Text', text: /^\s+asks: Keep the old API/ } as const
  const reply = () => $.tool.call({ tool: 'Bash', command: 'orca orchestration reply --id msg_1 --run run_1 --body "Yes" --json' } as never)
  await reply()
  expect((await ui.find(asks))?.text).toBeDefined()
  w.bash.isReplyOk = true
  await reply()
  await until(async () => (await ui.find(asks)) === undefined)
  await ui.unmount()

  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_2', 'worker_done', 'term_1', 'Opened #41.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  expect(w.orcaRan('orchestration worker-retain')[0]).toEqual(expect.arrayContaining(['--dispatch', 'ctx_1']))
  expect(w.orcaRan('orchestration worker-start')[1]).toEqual(expect.arrayContaining(['--task', 'task_2', '--worktree', 'id:repo-1::/w/issue-9', '--model', 'claude-opus-5-5', '--effort', 'high']))

  // The pane reads the pull request and the board status from the Orca workspace.
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await after.find({ type: 'Text', text: /PR #41/ })) !== undefined)
  expect((await after.find({ type: 'Text', text: /in-review/ }))?.text).toBeDefined()
  await after.unmount()
})

test('a worker that fails to start shows Orca\'s reason and recovery and is never started again', async ($, on) => {
  const w = world(on, { issues: [issue(3)], startFails: true })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length > 0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /agent_prompt_blocked/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /worker-release --dispatch ctx_1/ }))?.text).toBeDefined()
  await $.command.run(command('refresh'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.orcaRan('orchestration worker-start')).toHaveLength(1)
  await ui.unmount()
})

test('the pane lists each group, and Jump switches Orca to the worker\'s terminal', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length > 0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /claude-sonnet-5-5 · medium/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /Fix #3/ }))?.text).toBeDefined()
  await ui.press({ key: 'jump-3' })
  await until(() => w.orcaRan('terminal switch').length > 0, () => w.ran)
  expect(w.orcaRan('orchestration worker-show')[0]).toEqual(expect.arrayContaining(['--dispatch', 'ctx_1']))
  expect(w.orcaRan('terminal switch')[0]).toEqual(expect.arrayContaining(['--terminal', 'term_1']))
  await ui.unmount()
})

test('the pane draws each group in its own box, listing each of its issues by number and title', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(4), issue(9)] })
  await started($)
  await $.command.run(command('start --dry-run'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([4, 3], 'simple'), group([9], 'average')] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const box = async (lead: number) => {
    const found = await ui.find({ type: 'Box', key: `group-${lead}` })
    expect(found?.props.borderStyle).toBeDefined()
    return JSON.stringify(found?.children)
  }
  const first = await box(3)
  expect(first).toContain('Issue 3')
  expect(first).toContain('Issue 4')
  expect(first).not.toContain('Issue 9')
  expect(first.indexOf('Issue 3')).toBeLessThan(first.indexOf('Issue 4'))
  const second = await box(9)
  expect(second).toContain('Issue 9')
  expect(second).not.toContain('Issue 3')
  await ui.unmount()
})

test('/orca-triage start --dry-run shows the groups and starts nothing in Orca', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start --dry-run'))
  await until(() => w.prompts.length > 0)
  const r = await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never) as { result?: unknown }
  expect(String(r.result)).toMatch(/dry run/i)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Fix #3/ }))?.text).toBeDefined()
  await ui.unmount()
  expect(w.orcaRan('orchestration run-create')).toHaveLength(0)
})

test('a failed group blocks the groups after it; the triage then ends, and /orca-triage start begins a new one', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)], startFails: true })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average'), group([9], 'simple', { after: [3] })] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^blocked/ })) !== undefined, () => w.ran)
  await until(async () => (await ui.find({ type: 'Text', text: /^done · Orca Run run_1/ })) !== undefined)
  await ui.unmount()
  await $.command.run(command('start'))
  await until(() => w.ran.filter(a => a[0] === 'gh' && a[1] === 'issue').length === 2, () => w.toasts)
})

test('a bad inbox message is logged, the rest of the delivery is still handled, and the delivery is acked once', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never)
  await until(() => w.orcaRan('orchestration check').length > 0)
  const bad = { ...message('msg_0', 'worker_done', 'term_1', 'garbled'), payload: '{not json' }
  w.deliver({ deliveryId: 'delivery_1', messages: [bad, message('msg_1', 'question', 'term_1', 'Which file?')] })
  await until(() => w.prompts.length > 1, () => w.ran)
  expect(w.prompts[1]).toMatch(/Which file\?/)
  await until(() => w.ran.some(a => a.includes('--ack')))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /msg_0/ })) !== undefined)
  await ui.unmount()
  expect(w.ran.filter(a => a.includes('--ack') && a.includes('delivery_1'))).toHaveLength(1)
})

test('a launch that fails part way names /orca-triage reset, which clears the triage', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)], taskCreateFails: true })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average'), group([9], 'simple')] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /runtime_unavailable/ })) !== undefined, () => w.ran)
  expect((await ui.find({ type: 'Text', text: /\/orca-triage reset/ }))?.text).toBeDefined()
  await ui.unmount()
  await $.command.run(command('reset'))
  expect((await $.command.run(command(''))).text).toMatch(/No triage yet/)
})

