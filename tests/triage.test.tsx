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
function world(on: On, opts: { repo?: string; board?: { owner: string; number: number }; issues?: Issue[]; cards?: unknown[]; worktrees?: Worktree[]; startFails?: boolean; readyReversed?: boolean; taskCreateFails?: boolean; runCreateAnswers?: unknown; merged?: number[]; workflowOff?: boolean } = {}) {
  // Each open pull request's merge state and checks, as GitHub answers pr-read and commit-checks; the test changes them.
  const prs: Record<number, Pr> = {}
  // Each period of `$.clock.every`, by its length, waits here until the test fires it.
  const timers = new Map<number, (() => void)[]>()
  const fire = (ms: number) => { const due = timers.get(ms) ?? []; timers.set(ms, []); due.forEach(f => f()); return due.length }
  const ran: string[][] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const tasks: { id: string; deps: string[]; status: string; title: string }[] = []
  const worktrees: Worktree[] = [...(opts.worktrees ?? [])]
  // Each pull request's head branch, by number, as `gh pr view --json headRefName` answers it.
  const prHeads = new Map<number, number>()
  // Deliveries the fake inbox hands out, one per blocking check; a check waits until one is queued.
  const inbox: { deliveryId: string; messages: unknown[] }[] = []
  // The Run's workers as worker-list answers them, newest first, as Orca lists them.
  const workers: { dispatchId: string; taskId: string; workerState: string; agentTerminalHandle: string }[] = []
  let wake: (() => void) | undefined
  const deliver = (d: { deliveryId: string; messages: unknown[] }) => { inbox.push(d); wake?.() }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/neil/dev-wiki/wiki.md' || e.path === '/.neil-dev.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ github: { repo: opts.repo ?? 'acme/widgets', board: opts.board ?? null }, ...(opts.workflowOff ? { workflow: false } : {}) }) }))
  on('clock.every', (_, e) => new Promise(resolve => { timers.set(e.ms, [...(timers.get(e.ms) ?? []), () => resolve({ value: undefined })]) }))
  // The time the mod reads; a test moves it on.
  const clock = { now: 1_800_000_000_000 }
  on('clock.now', () => ({ value: clock.now }))
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
    if (args.includes('gh.sh issue-search')) return ok((opts.issues ?? []).map(i => `${JSON.stringify(i)}\n`).join(''))
    if (args.includes('gh.sh board items')) return ok((opts.cards ?? []).map(c => `${JSON.stringify(c)}\n`).join(''))
    if (args.includes('gh.sh pr-read')) {
      const pr = Number(a[a.length - 1])
      const p = prs[pr]
      return ok(JSON.stringify({ number: pr, title: `PR ${pr}`, draft: p?.draft ?? false, created_at: '2026-11-06T00:00:00Z', merge_commit_sha: null,
        mergeable: p ? p.mergeable : true, mergeable_state: p?.state ?? 'clean',
        state: opts.merged?.includes(pr) || p?.merged ? 'closed' : 'open', merged: !!opts.merged?.includes(pr) || !!p?.merged, head: { ref: `claude/issue-${prHeads.get(pr)}`, sha: `head-${pr}` } }))
    }
    if (args.includes('gh.sh commit-checks')) {
      const pr = Number(a[a.indexOf('--pr') + 1])
      return ok(JSON.stringify({ check_runs: (prs[pr]?.checks ?? []).map(([name, status, conclusion]) => ({ name, status, conclusion })), statuses: [] }))
    }
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
    // As Orca 1.4 does: with no --full, orchestration --json prints a concise view with other keys.
    const isFull = a.includes('--full')
    if (args.startsWith('orca orchestration run-create')) {
      if (opts.runCreateAnswers) return reply(opts.runCreateAnswers)
      return reply(isFull ? { run: { id: 'run_1', objective: a[a.indexOf('--objective') + 1]! } } : { runId: 'run_1', next: 'task-create' })
    }
    if (args.startsWith('orca orchestration task-create')) {
      if (opts.taskCreateFails && tasks.length === 1) return ok(JSON.stringify({ id: 'x', ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running' } }))
      const deps = a.includes('--deps') ? (JSON.parse(a[a.indexOf('--deps') + 1]!) as string[]) : []
      const t = { id: `task_${tasks.length + 1}`, deps, status: deps.length ? 'pending' : 'ready', title: a[a.indexOf('--task-title') + 1]! }
      tasks.push(t)
      return reply(isFull ? { task: { id: t.id, run_id: 'run_1', status: t.status, deps: JSON.stringify(deps), task_title: t.title } } : { taskId: t.id, status: t.status })
    }
    if (args.startsWith('orca orchestration task-list')) {
      const listed = args.includes('--ready') ? tasks.filter(t => t.status === 'ready') : tasks
      const ready = opts.readyReversed ? listed.slice().reverse() : listed
      return reply({ runId: 'run_1', tasks: ready.map(t => ({ id: t.id, status: t.status, deps: JSON.stringify(t.deps) })), count: ready.length })
    }
    if (args.startsWith('orca orchestration worker-start')) {
      const task = a[a.indexOf('--task') + 1]!
      const n = task.slice('task_'.length)
      const launch = { agent: 'claude', model: a[a.indexOf('--model') + 1]!, effort: a[a.indexOf('--effort') + 1]! }
      workers.unshift({ dispatchId: `ctx_${n}`, taskId: task, workerState: opts.startFails ? 'failed' : 'ready', agentTerminalHandle: `term_${n}` })
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
        runId: 'run_1', taskId: task, dispatchId: `ctx_${n}`, state: 'ready', stage: 'ready',
        ...(isFull ? { launch: { requested: launch, effective: launch }, effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: `term_${n}` }] } : { terminal: `term_${n}` }),
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
    if (args.startsWith('orca orchestration worker-list')) return reply({ workers, page: { hasMore: false, nextCursor: null } })
    return reply({})
  })
  const orcaRan = (verb: string) => ran.filter(a => a[0] === 'orca' && a.slice(1, 3).join(' ') === verb)
  // What the worker does after it opens its pull request: link it to the workspace and move the card to review.
  const linkPr = (path: string, pr: number) => { const wt = worktrees.find(x => x.path === path)!; wt.linkedPR = pr; wt.workspaceStatus = 'in-review'; prHeads.set(pr, Number(path.split('-').pop())) }
  // What a coordinator does by hand with `orca orchestration worker-start --retry-of <old ctx>`: a new Dispatch of the
  // same Task, which the mod did not start.
  const restart = (task: string, dispatchId: string) => {
    workers.unshift({ dispatchId, taskId: task, workerState: 'ready', agentTerminalHandle: `term_${dispatchId.slice('ctx_'.length)}` })
    tasks.find(t => t.id === task)!.status = 'dispatched'
  }
  return { ran, prompts, toasts, tasks, deliver, orcaRan, linkPr, bash, prs, fire, clock, restart }
}

// A pull request as the fake GitHub answers it: REST's mergeable and mergeable_state, and its check runs as [name, status, conclusion].
type Pr = { mergeable: boolean | null; state: string; checks: [string, string, string | null][]; draft?: boolean; merged?: boolean }

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
  const list = w.ran.find(a => a.join(' ').includes('gh.sh issue-search'))!
  expect(list.join(' ')).toMatch(/issue-search -linked:pr/)
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
  expect(w.ran.some(a => a.join(' ').includes('gh.sh issue-search'))).toBe(false)
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
  // The worker goes through the ndev workflow, one PR for the group, and answers to the coordinator.
  const spec = created[0]![created[0]!.indexOf('--spec') + 1]!
  expect(spec).toMatch(/mcp__ndev__started with issue 3\b/)
  expect(spec).toMatch(/call mcp__ndev__started for #4\b.*same worktree and PR/)
  expect(spec).toMatch(/mcp__ndev__setSteering/)
  expect(spec).toMatch(/orca orchestration ask/)
  // The last workflow step comes before worker_done, so a follower starts from a finished pull request.
  expect(spec.indexOf('mcp__ndev__done')).toBeGreaterThan(-1)
  expect(spec.indexOf('mcp__ndev__done')).toBeLessThan(spec.indexOf('worker_done'))
  // The tools refuse or replace these by hand.
  expect(spec).not.toMatch(/gh pr create|orca worktree set|claude\/issue-/)
  // The turn stays open while a question waits, because the workflow counts an ended turn as no progress.
  expect(spec).toMatch(/orca orchestration ask --question .* --wait/)
  expect(spec).toMatch(/ask --resume <message_id> --wait/)
  // A block has a way out, so a worker never stays silent in it.
  expect(spec).toMatch(/mcp__ndev__unblocked/)
  expect(spec).toMatch(/--outcome failed/)
  expect(spec).toMatch(/PR #<number>/)
  // Each orchestration call asks for the full record: the concise view has other keys.
  for (const call of w.ran.filter(x => x[0] === 'orca' && x[1] === 'orchestration')) expect(call).toContain('--full')
  // A command outside orchestration does not know the flag.
  for (const call of w.ran.filter(x => x[0] === 'orca' && x[1] !== 'orchestration')) expect(call).not.toContain('--full')

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
  expect(follower).toMatch(/gh api -X PATCH repos\/\{owner\}\/\{repo\}\/pulls\/<number> -f base=<that branch>/)
  const alone = specs.find(x => x.includes('#12 ('))!
  expect(alone).not.toMatch(/--base|follows/)
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
  // Each issue number in the pane is a link to the issue.
  expect((await ui.find({ type: 'Link', text: '#3' }))?.props.href).toBe('https://github.com/acme/widgets/issues/3')
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
  expect((await after.find({ type: 'Link', text: '#41' }))?.props.href).toBe('https://github.com/acme/widgets/pull/41')
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
  await until(() => w.prompts.some(p => /the worker for #3 .*did not start/.test(p)), () => w.prompts)
  await ui.unmount()
  await $.command.run(command('start'))
  await until(() => w.ran.filter(a => a.join(' ').includes('gh.sh issue-search')).length === 2, () => w.toasts)
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

test('a follower of a merged pull request starts from the default branch: its branch may be gone', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)], merged: [41] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] })] } as never)
  await until(() => w.orcaRan('worktree create').length === 1, () => w.ran)
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'Merged #41.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('worktree create').length === 2, () => w.ran)
  expect(w.orcaRan('worktree create')[1]).not.toContain('--base-branch')
})

test('an Orca reply with no Run id stops the launch with that reply and the repair, and the pane never says "Orca Run undefined"', async ($, on) => {
  const w = world(on, { issues: [issue(3)], runCreateAnswers: { objective: 'a new shape' } })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /run-create answered no Run id.*a new shape/ })) !== undefined, () => w.ran)
  expect((await ui.find({ type: 'Text', text: /\/orca-triage reset/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /undefined/ })).toBeUndefined()
  await ui.unmount()
})

test('/dev triage is the same command as /orca-triage', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  expect((await $.command.run({ ...command(''), command: 'dev', args: 'triage' })).text).toMatch(/No triage yet/)
  expect((await $.command.run({ ...command(''), command: 'dev', args: 'help' })).text).toMatch(/\/dev triage start/)
  await $.command.run({ ...command(''), command: 'dev', args: 'triage start' })
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  expect(w.prompts[0]).toMatch(/#3\b/)
})

test('the session is the coordinator: it is told so, and it hears of an escalation, a failed worker and the end', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  expect(w.prompts[0]).toMatch(/You are the coordinator/)
  expect(w.prompts[0]).toMatch(/never call mcp__ndev__started/i)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'escalation', 'term_1', 'The schema is locked.', { taskId: 'task_1', dispatchId: 'ctx_1' })] })
  await until(() => w.prompts.some(p => /The schema is locked/.test(p)), () => w.prompts)
  // Its Dispatch is still open: the escalation decides nothing, and the prompt says how to answer it or end it.
  const escalated = w.prompts.find(p => /The schema is locked/.test(p))!
  expect(escalated).toMatch(/orca orchestration send --to dispatch:ctx_1/)
  expect(escalated).toMatch(/orca orchestration task-update --id task_1 --status failed/)
  expect(w.prompts.some(p => /Report to the user/.test(p))).toBe(false)
  w.deliver({ deliveryId: 'delivery_3', messages: [message('msg_3', 'worker_done', 'term_1', 'Gave up.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'failed' })] })
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_2', 'worker_done', 'term_2', 'CI never passed.', { taskId: 'task_2', dispatchId: 'ctx_2', outcome: 'failed' })] })
  await until(() => w.prompts.some(p => /CI never passed/.test(p)), () => w.prompts)
  // Both groups are over, so the coordinator reports to the human, once.
  await until(() => w.prompts.some(p => /Report to the user/.test(p)), () => w.prompts)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.prompts.filter(p => /Report to the user/.test(p))).toHaveLength(1)
})

test('a worker that ends its turn is not a failure: it may wait for its checks, and its later worker_done still counts', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] })] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length === 1, () => w.ran)
  const prompts = w.prompts.length
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_stop', 'escalation', 'term_1', 'Worker stopped without reporting: the workflow is now watching the checks.', { taskId: 'task_1', dispatchId: 'ctx_1', stopReason: 'finished' })] })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(w.prompts.length).toBe(prompts)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /escalated|blocked, as/ })).toBeUndefined()
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_1', 'worker_done', 'term_1', 'PR #41 is done.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  await ui.unmount()
})

test('a worker stopped at a prompt reaches the coordinator, and does not fail its group', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] })] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length === 1, () => w.ran)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_stop', 'escalation', 'term_1', 'Worker is waiting on a prompt.', { taskId: 'task_1', dispatchId: 'ctx_1', stopReason: 'needs-input' })] })
  await until(() => w.prompts.some(p => /waiting on a prompt/.test(p)), () => w.prompts)
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_1', 'worker_done', 'term_1', 'PR #41 is done.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
})

test('the coordinator hears of a launch that fails, so it never waits for nothing', async ($, on) => {
  const stopped = world(on, { issues: [issue(3)], runCreateAnswers: { objective: 'a new shape' } })
  await started($)
  await $.command.run(command('start'))
  await until(() => stopped.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average')] } as never)
  await until(() => stopped.prompts.some(p => /the launch stopped part way/.test(p)), () => stopped.prompts)
})

test('a Task that Orca reports failed reaches the coordinator once', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  w.tasks.find(t => t.id === 'task_1')!.status = 'failed'
  await $.command.run(command('refresh'))
  await until(() => w.prompts.some(p => /Task of #3 .*failed/.test(p)), () => w.prompts)
  await $.command.run(command('refresh'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.prompts.filter(p => /Task of #3 .*failed/.test(p))).toHaveLength(1)
})

test('with the workflow off in the project, the triage stops at the start and names the setting', async ($, on) => {
  const w = world(on, { issues: [issue(3)], workflowOff: true })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.toasts.some(t => /sets .*workflow.*false.*Repair: remove that setting/.test(t)), () => w.toasts)
  expect(w.prompts).toHaveLength(0)
})

test('a follower is told its base branch in Orca mail, and the worker_done names the pull request when the workspace does not', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'simple', { after: [3] })] } as never)
  await until(() => w.orcaRan('worktree create').length === 1, () => w.ran)
  // The workspace never got its link, so only the worker's own report names the pull request.
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'PR #41 is done.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration send').length === 1, () => w.ran)
  const sent = w.orcaRan('orchestration send')[0]!
  expect(sent[sent.indexOf('--to') + 1]).toBe('dispatch:ctx_2')
  expect(sent[sent.indexOf('--body') + 1]).toMatch(/claude\/issue-/)
  expect(sent).toContain('--full')
  expect(w.orcaRan('worktree create')[1]).toContain('--base-branch')
})

test('/orca-triage start --codex sizes the groups for Codex and starts Codex workers, which follow the workflow by hand', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(5), issue(9)] })
  await started($)
  await $.command.run(command('start --codex'))
  await until(() => w.prompts.length > 0)
  // The model sizes the groups on Codex's models: sol, terra and luna, as Claude's are opus, sonnet and haiku.
  expect(w.prompts[0]).toMatch(/gpt-6\.1-sol/)
  expect(w.prompts[0]).toMatch(/gpt-6\.1-terra/)
  expect(w.prompts[0]).toMatch(/gpt-6-luna/)
  expect(w.prompts[0]).not.toMatch(/claude-/)
  const accepted = await $.tool.call({ tool: TOOL, groups: [group([3], 'average'), group([5], 'complex'), group([9], 'very-simple')] } as never) as { isError?: boolean }
  expect(accepted.isError).toBeFalsy()
  await until(() => w.orcaRan('orchestration worker-start').length === 3, () => w.ran)
  const starts = w.orcaRan('orchestration worker-start')
  expect(starts[0]).toEqual(expect.arrayContaining(['--agent', 'codex', '--model', 'gpt-6.1-terra', '--effort', 'medium']))
  expect(starts[1]).toEqual(expect.arrayContaining(['--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high']))
  expect(starts[2]).toEqual(expect.arrayContaining(['--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'medium']))
  // Codex has no mcp__ndev__ tools, so its Task names none and gives the steps by hand.
  const spec = w.orcaRan('orchestration task-create')[0]!
  const text = spec[spec.indexOf('--spec') + 1]!
  expect(text).not.toMatch(/mcp__ndev__/)
  expect(text).toMatch(/kb\/workflow\.md/)
  expect(text).toMatch(/pre-commit-check\.sh/)
  expect(text).toMatch(/gh pr create --draft/)
  expect(text).toMatch(/Closes #3/)
  expect(text).toMatch(/orca orchestration ask --question .* --wait/)
  expect(text).toMatch(/PR #<number>/)
  expect(text.indexOf('gh pr ready')).toBeLessThan(text.indexOf('worker_done'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Codex/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('--codex is an option of start only', async ($, on) => {
  world(on, { issues: [issue(3)] })
  await started($)
  expect((await $.command.run(command('launch --codex'))).text).toMatch(/does not know "--codex"/)
  expect((await $.command.run(command('start --codex --dry-run'))).text).toMatch(/Triage started/)
})

test('/orca-triage start --open takes every open issue, not only the board\'s, and leaves out the ones being worked on', async ($, on) => {
  const w = world(on, {
    board: { owner: 'acme', number: 4 },
    cards: [{ number: 3, title: 'Card 3', status: 'Ready', itemId: 'PVTI_3', url: issue(3).url }],
    issues: [issue(3), issue(7), issue(11)],
    worktrees: [{ id: 'repo-1::/w/seven', projectId: 'github:acme/widgets', path: '/w/seven', isArchived: false, isMainWorktree: false, workspaceStatus: 'in-progress', linkedPR: null,
      linkedItems: [{ type: 'issue', number: 7, url: issue(7).url }] }],
  })
  await started($)
  await $.command.run(command('start --open'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  expect(w.ran.some(a => a.join(' ').includes('gh.sh board items'))).toBe(false)
  // An issue with a pull request, or one an Orca workspace links, is being worked on.
  expect(w.ran.find(a => a.join(' ').includes('gh.sh issue-search'))!.join(' ')).toMatch(/-linked:pr/)
  expect(w.prompts[0]).toMatch(/#3\b/)
  expect(w.prompts[0]).toMatch(/#11\b/)
  expect(w.prompts[0]).not.toMatch(/#7\b/)
  // Claude stays the worker unless --codex is given.
  expect(w.prompts[0]).toMatch(/claude-sonnet-5-5/)
})

test('/orca-triage start --sequential runs one worker at a time: the next ready group starts only when the last one is done', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  await $.command.run(command('start --sequential'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'average')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length > 0, () => w.ran)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(w.orcaRan('orchestration worker-start')).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /one at a time/ }))?.text).toBeDefined()
  await ui.unmount()

  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'PR #41.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  expect(w.orcaRan('orchestration worker-start')[1]).toEqual(expect.arrayContaining(['--task', 'task_2']))
})

test('/orca-triage start --batch 2 runs the groups in batches of two: the next batch starts only when every worker of the last one is done', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9), issue(12)] })
  await started($)
  await $.command.run(command('start --batch 2'))
  await until(() => w.prompts.length > 0)
  expect(w.prompts[0]).toMatch(/at most 2 workers at a time, in batches, in the order you list the groups/)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple'), group([9], 'average'), group([12], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(w.orcaRan('orchestration worker-start')).toHaveLength(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /batches of 2/ }))?.text).toBeDefined()
  await ui.unmount()

  // One worker of the batch is done: the batch still runs, so nothing starts.
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1', 'PR #41.', { taskId: 'task_1', dispatchId: 'ctx_1', outcome: 'succeeded' })] })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(w.orcaRan('orchestration worker-start')).toHaveLength(2)

  // The last worker of the batch is done, failed here: the next batch starts.
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_2', 'worker_done', 'term_2', 'Tests fail.', { taskId: 'task_2', dispatchId: 'ctx_2', outcome: 'failed' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 3, () => w.ran)
  expect(w.orcaRan('orchestration worker-start')[2]).toEqual(expect.arrayContaining(['--task', 'task_3']))
})

test('/orca-triage start --batch refuses a size that is not a whole number above 0, and --sequential with another size', async ($, on) => {
  world(on, { issues: [issue(3)] })
  await started($)
  for (const args of ['start --batch', 'start --batch 0', 'start --batch two', 'start --batch 1.5', 'start --sequential --batch 2']) {
    const r = await $.command.run(command(args)) as { text: string }
    expect(r.text, args).toMatch(/--batch <size>/)
    expect(r.text, args).not.toMatch(/Triage started/)
  }
  expect(((await $.command.run(command('start --sequential --batch 1'))) as { text: string }).text).toMatch(/Triage started/)
})

test('/orca-triage start --sequential asks the coordinator for the order and starts the groups in that order, whatever order Orca lists them', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)], readyReversed: true })
  await started($)
  await $.command.run(command('start --sequential'))
  await until(() => w.prompts.length > 0)
  expect(w.prompts[0]).toMatch(/one worker at a time, in the order you list the groups/)
  await $.tool.call({ tool: TOOL, groups: [group([9], 'average'), group([3], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration worker-start').length > 0, () => w.ran)
  const first = w.orcaRan('orchestration worker-start')[0]!
  const created = w.orcaRan('orchestration task-create')
  const taskOf9 = `task_${created.findIndex(a => a.includes('issue-9')) + 1}`
  expect(first[first.indexOf('--task') + 1]).toBe(taskOf9)
})

test('every 10 minutes the triage reads each open pull request, and prods its worker when it is not mergeable and green', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration check').length > 0, () => w.ran)
  // The worker opens #41; the refresh after its next message reads it from the workspace.
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'question', 'term_1', 'Which test?')] })
  await until(() => w.ran.some(a => a.includes('--ack') && a.includes('delivery_1')))
  const prods = () => w.orcaRan('orchestration send').filter(a => a.includes('dispatch:ctx_1'))
  const calls = (verb: string) => w.ran.filter(a => a.join(' ').includes(`gh.sh ${verb} `)).length
  // Fires the 10-minute timer, and waits for the pass to read the pull request and, when it is open, its checks.
  const tick = async (isOpen = true) => {
    const [reads, checks] = [calls('pr-read'), calls('commit-checks')]
    expect(w.fire(10 * 60_000)).toBe(1)
    await until(() => calls('pr-read') > reads && (!isOpen || calls('commit-checks') > checks), () => w.ran)
  }
  // A pass that sends nothing: the send would follow the read at once, so give it the time it would take.
  const settled = () => new Promise(resolve => setTimeout(resolve, 200))

  // Conflicting, with a failing check: the worker hears both, with the pull request's link and head.
  w.prs[41] = { mergeable: false, state: 'dirty', checks: [['test', 'completed', 'failure'], ['lint', 'completed', 'success']] }
  await tick()
  await until(() => prods().length === 1, () => w.ran)
  const body = prods()[0]![prods()[0]!.indexOf('--body') + 1]!
  expect(body).toMatch(/https:\/\/github\.com\/acme\/widgets\/pull\/41/)
  expect(body).toMatch(/head-41/)
  expect(body).toMatch(/conflicts/)
  expect(body).toMatch(/failing checks: test\b/)
  expect(body).not.toMatch(/lint/)

  // The same fault on the same head 10 minutes later: no second prod yet, as a fix and its checks take a while.
  await tick()
  await settled()
  expect(prods()).toHaveLength(1)
  // 30 minutes after the first prod, still the same: it is sent again.
  w.clock.now += 30 * 60_000
  await tick()
  await until(() => prods().length === 2, () => w.ran)

  // A new fault is sent at once: behind its base, with no conflict.
  w.prs[41] = { mergeable: true, state: 'behind', checks: [['test', 'completed', 'success']] }
  await tick()
  await until(() => prods().length === 3, () => w.ran)
  expect(prods()[2]![prods()[2]!.indexOf('--body') + 1]).toMatch(/behind its base branch/)

  // Not faults: checks still running, a review the base needs, a draft with a failing check, and mergeable and green.
  for (const pr of [
    { mergeable: true, state: 'unstable', checks: [['test', 'in_progress', null]] },
    { mergeable: true, state: 'blocked', checks: [['test', 'completed', 'success']] },
    { mergeable: true, state: 'unstable', checks: [['test', 'completed', 'failure']], draft: true },
    { mergeable: true, state: 'clean', checks: [['test', 'completed', 'success']] },
  ] as Pr[]) {
    w.prs[41] = pr
    await tick()
    await settled()
    expect(prods()).toHaveLength(3)
  }

  // Merged: read once, with no checks, and never again.
  w.prs[41] = { mergeable: null, state: 'unknown', checks: [], merged: true }
  const checks = calls('commit-checks')
  await tick(false)
  await settled()
  const reads = calls('pr-read')
  expect(w.fire(10 * 60_000)).toBe(1)
  await settled()
  expect([calls('pr-read'), calls('commit-checks'), prods().length]).toEqual([reads, checks, 3])
})

// A coordinator restarts a failed Task by hand with worker-start --retry-of; Orca then holds a new Dispatch of the Task.
test('a refresh follows a worker restarted by hand: the group runs again, Jump goes to the new terminal, and its follower starts', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)], startFails: true })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'average'), group([9], 'simple', { after: [3] })] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^done · Orca Run run_1/ })) !== undefined, () => w.ran)

  w.restart('task_1', 'ctx_1b')
  await $.command.run(command('refresh'))
  await until(async () => (await ui.find({ type: 'Text', text: /^working/ })) !== undefined, () => w.ran)
  // The old failure and the follower's block are gone, and the triage runs again.
  expect(await ui.find({ type: 'Text', text: /worker-start failed/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^blocked/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Orca Run run_1/ }))?.text).toBeDefined()
  await ui.press({ key: 'jump-3' })
  await until(() => w.orcaRan('terminal switch').length > 0, () => w.ran)
  expect(w.orcaRan('orchestration worker-show')[0]).toEqual(expect.arrayContaining(['--dispatch', 'ctx_1b']))
  expect(w.orcaRan('terminal switch')[0]).toEqual(expect.arrayContaining(['--terminal', 'term_1b']))

  // The restarted worker succeeds, so the group that follows it starts.
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'worker_done', 'term_1b', 'PR #41 is done.', { taskId: 'task_1', dispatchId: 'ctx_1b', outcome: 'succeeded' })] })
  await until(() => w.orcaRan('orchestration worker-start').length === 2, () => w.ran)
  expect(w.orcaRan('orchestration worker-start')[1]).toEqual(expect.arrayContaining(['--task', 'task_2']))
  await ui.unmount()
})

test('a message from an unknown Dispatch of a known Task moves the group to it, and the PR watch prods the new worker afresh', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration check').length > 0, () => w.ran)
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'question', 'term_1', 'Which test?')] })
  await until(() => w.ran.some(a => a.includes('--ack') && a.includes('delivery_1')))
  const prods = (ctx: string) => w.orcaRan('orchestration send').filter(a => a.includes(`dispatch:${ctx}`))
  w.prs[41] = { mergeable: false, state: 'dirty', checks: [] }
  expect(w.fire(10 * 60_000)).toBe(1)
  await until(() => prods('ctx_1').length === 1, () => w.ran)

  // The coordinator restarts the Task by hand; the new worker's first message names its Dispatch and Task.
  w.restart('task_1', 'ctx_1b')
  w.deliver({ deliveryId: 'delivery_2', messages: [message('msg_2', 'question', 'term_1b', 'Where was I?', { taskId: 'task_1', dispatchId: 'ctx_1b' })] })
  await until(() => w.prompts.some(p => /Where was I\?/.test(p)), () => w.prompts)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'jump-3' })
  await until(() => w.orcaRan('terminal switch').length > 0, () => w.ran)
  expect(w.orcaRan('orchestration worker-show').at(-1)).toEqual(expect.arrayContaining(['--dispatch', 'ctx_1b']))
  await ui.unmount()

  // The same fault on the same head, within 30 minutes: the new worker has not heard it, so it is sent to it at once.
  expect(w.fire(10 * 60_000)).toBe(1)
  await until(() => prods('ctx_1b').length === 1, () => w.ran)
  expect(prods('ctx_1')).toHaveLength(1)
})

test('the PR watch sends its prod to a worker restarted since the last refresh, never to the old Dispatch', async ($, on) => {
  const w = world(on, { issues: [issue(3)] })
  await started($)
  await $.command.run(command('start'))
  await until(() => w.prompts.length > 0)
  await $.tool.call({ tool: TOOL, groups: [group([3], 'simple')] } as never)
  await until(() => w.orcaRan('orchestration check').length > 0, () => w.ran)
  w.linkPr('/w/issue-3', 41)
  w.deliver({ deliveryId: 'delivery_1', messages: [message('msg_1', 'question', 'term_1', 'Which test?')] })
  await until(() => w.ran.some(a => a.includes('--ack') && a.includes('delivery_1')))
  w.restart('task_1', 'ctx_1b')
  w.prs[41] = { mergeable: false, state: 'dirty', checks: [] }
  expect(w.fire(10 * 60_000)).toBe(1)
  const sends = () => w.orcaRan('orchestration send')
  await until(() => sends().length === 1, () => w.ran)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(sends().map(a => a[a.indexOf('--to') + 1])).toEqual(['dispatch:ctx_1b'])
})

test('/orca-triage start --hint "<text>" gives the coordinator the human\'s hint; a --hint with no text is refused', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(9)] })
  await started($)
  const bare = await $.command.run(command('start --hint'))
  expect(bare.text).toMatch(/--hint takes a text/)
  expect(w.prompts).toEqual([])
  await $.command.run(command('start --hint "close outdated/superseded issues" --dry-run'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  expect(w.prompts[0]).toMatch(/The human's hint for this triage: close outdated\/superseded issues/)
  expect(w.prompts[0]).toMatch(new RegExp(TOOL))
  // An unquoted hint runs to the next option.
  await $.command.run(command('reset'))
  await $.command.run(command('start --hint group by area --open'))
  await until(() => w.prompts.length > 1, () => [w.ran.slice(-1), w.toasts])
  expect(w.prompts[1]).toMatch(/The human's hint for this triage: group by area\n/)
})

test('/orca-triage clean asks the model to check each issue against the code and later pull requests, and to close one only after the human confirms', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(7), issue(9)],
    worktrees: [{ id: 'repo-1::/w/seven', projectId: 'github:acme/widgets', path: '/w/seven', isArchived: false, isMainWorktree: false, workspaceStatus: 'in-progress', linkedPR: null,
      linkedItems: [{ type: 'issue', number: 7, url: issue(7).url }] }] })
  await started($)
  const r = await $.command.run(command('clean --hint "older than June"'))
  expect(r.text).toMatch(/clean/i)
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-1), w.toasts])
  const p = w.prompts[0]!
  expect(p).toMatch(/#3\b/)
  expect(p).toMatch(/#9\b/)
  // An issue an Orca workspace links is checked too, marked so the model weighs the work in that workspace.
  expect(p).toMatch(/#7 .*\(linked to an Orca workspace\)/)
  expect(p).toMatch(/linked to an Orca workspace.*branch/)
  expect(p.indexOf('#3 ')).toBeLessThan(p.indexOf('#7 '))
  expect(p.indexOf('#7 ')).toBeLessThan(p.indexOf('#9 '))
  expect(p).toMatch(/outdated or superseded/)
  expect(p).toMatch(/later pull requests/)
  // An issue a merged pull request fixed but never closed is the commonest leftover, so a clean reads the issues with a linked PR too.
  expect(w.ran.find(a => a.join(' ').includes('gh.sh issue-search'))!.join(' ')).not.toMatch(/-linked:pr/)
  expect(p).toMatch(/merged pull request that fixed or closes it/)
  expect(p).toMatch(/AskUserQuestion/)
  expect(p).toMatch(/gh issue close <n> --repo acme\/widgets --reason "not planned" --comment/)
  expect(p).toMatch(/The human's hint for this clean: older than June/)
  // A clean groups nothing and starts no worker.
  expect(p).not.toMatch(new RegExp(TOOL))
  const status = await $.command.run(command(''))
  expect(status.text).toMatch(/No triage yet/)
  expect(w.orcaRan('orchestration run-create')).toEqual([])
  const bad = await $.command.run(command('clean --codex'))
  expect(bad.text).toMatch(/does not know "--codex"/)
})

test('with a --hint, the groups report may list closed issues, which are then in no group; a closed issue it does not know is refused', async ($, on) => {
  const w = world(on, { issues: [issue(3), issue(4), issue(9)] })
  await started($)
  await $.command.run(command('start --dry-run --hint "close outdated issues"'))
  await until(() => w.prompts.length > 0)
  expect(w.prompts[0]).toMatch(/list them in closed instead of in a group/)
  expect(w.prompts[0]).toMatch(/gh issue close <n> --repo acme\/widgets --comment/)
  const bad = await $.tool.call({ tool: TOOL, groups: [group([3, 4, 9], 'simple')], closed: [12] } as never) as { result: string; isError?: boolean }
  expect(bad.isError).toBe(true)
  expect(bad.result).toMatch(/closed names 12/)
  const r = await $.tool.call({ tool: TOOL, groups: [group([3, 9], 'simple')], closed: [4] } as never) as { result: string; isError?: boolean }
  expect(r.isError).toBeUndefined()
  expect(r.result).toMatch(/Recorded 1 groups/)
})
