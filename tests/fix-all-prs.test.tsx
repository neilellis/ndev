import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ndev',
  component: 'Pane',
  requestId: 'fix-all-prs',
  props: {
    title: 'PR queue',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPO = {
  nameWithOwner: 'acme/widgets',
  defaultBranchRef: { name: 'main' },
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
}

type Pr = ReturnType<typeof pr>
const pr = (number: number, createdAt: string, conclusion: string, branch = `branch-${number}`) => ({
  number,
  title: `Change ${number}`,
  headRefName: branch,
  headRefOid: `head-${number}-1`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: conclusion === 'SUCCESS' ? 'CLEAN' : 'BLOCKED',
  mergeCommit: null as { oid: string } | null,
  createdAt,
  statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion }],
})

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// Waits for work the mod runs detached from the hook that started it.
async function until(check: () => boolean | Promise<boolean>, state?: () => unknown): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`the condition never held${state ? `: ${JSON.stringify(state())}` : ''}`)
}

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

// A fake GitHub and agent roster. `merged` records each `gh pr merge` call.
function world(on: On, prs: Pr[], agents: { name: string; status: string }[], isGhBroken = false) {
  const sent: { to: string; text: string }[] = []
  const prompts: string[] = []
  const merged: string[] = []
  const clock = { now: 0 }
  const reruns: string[] = []
  const toasts: string[] = []
  // The commit messages of each pull request, oldest first, and the lines of Claude Code's session registry.
  const signed: Record<number, string[]> = {}
  const registry: string[] = []
  // Each transcript's newest title, by its path under the Claude Code folder.
  const titles: Record<string, string> = {}
  // gh calls that reached GitHub, `gh api rate_limit` aside.
  const calls = { count: 0 }
  // `outage` fails that many gh calls with a server error; `mergeError` makes GitHub refuse each merge;
  // `rateLimitUntil` fails every gh call before that time with GitHub's rate-limit refusal;
  // `storage` fails the checks of those pull requests on the Actions storage quota until a rerun.
  const fault = { outage: 0, mergeError: {} as Record<number, string>, rateLimitUntil: 0, storage: {} as Record<number, boolean> }
  // Each period of `$.clock.every` waits here until the test fires the timer.
  const timers: (() => void)[] = []
  const timer = () => timers.splice(0).forEach(fire => fire())
  on('command.register', () => ({ value: { command: 'fix-prs' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  // The plugin's session start also reads ~/dev-wiki and the project file: both are in place,
  // so it runs no set-up and no wiki script, and every process call below is the loop's.
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/neil/dev-wiki/wiki.md' || e.path === '/.neil-dev.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ github: { repo: 'acme/widgets', board: null } }) }))
  on('clock.every', () => new Promise(resolve => { timers.push(() => resolve({ value: undefined })) }))
  on('clock.now', () => ({ value: clock.now }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.send', (_, e) => { sent.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  on('session.receive', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { listing: '', sections: [{ kind: 'peers', total: agents.length, rows: agents }] } }))
  on('process.run', (_, e) => {
    if (isGhBroken) return { value: { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    const args = e.argv.join(' ')
    if (e.argv[0] === 'sh' && args.includes('/sessions/')) return ok(registry.map(line => `${line}\n`).join(''))
    if (e.argv[0] === 'sh' && args.includes('aiTitle')) {
      const files = e.argv.slice(4)
      return ok(files.map(f => `${f}\t${titles[f] ? `"aiTitle":${JSON.stringify(titles[f])}` : ''}\n`).join(''))
    }
    // The plugin's session start finds the project root; it is no GitHub call.
    if (args === 'git rev-parse --show-toplevel') return ok('/\n')
    if (args === 'gh api rate_limit') {
      const reset = Math.ceil(fault.rateLimitUntil / 1000)
      return ok(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4800, reset: 60 }, graphql: { limit: 5000, remaining: 0, reset } } }))
    }
    calls.count++
    if (clock.now < fault.rateLimitUntil) {
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user ID 1.', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const checkRuns = /^gh api repos\/acme\/widgets\/commits\/head-(\d+)-\d+\/check-runs/.exec(args)
    if (checkRuns) return ok(fault.storage[Number(checkRuns[1])] ? '901 https://github.com/acme/widgets/actions/runs/77/job/901\n' : '')
    if (/^gh api repos\/acme\/widgets\/check-runs\/901\/annotations/.test(args)) {
      return ok('Failed to CreateArtifact: Artifact storage quota has been hit. Unable to upload any new artifacts. Usage is recalculated every 6-12 hours.\n')
    }
    if (args.startsWith('gh run rerun')) {
      reruns.push(args)
      // The rerun passes now that the quota is back.
      for (const p of prs.filter(x => fault.storage[x.number])) {
        Object.assign(p, { mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
      }
      fault.storage = {}
      return ok('')
    }
    if (fault.outage > 0) {
      fault.outage--
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const refused = /^gh pr merge (\d+)/.exec(args)
    if (refused && fault.mergeError[Number(refused[1])]) {
      merged.push(args)
      return { value: { exitCode: 1, stdout: '', stderr: fault.mergeError[Number(refused[1])]!, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args.startsWith('gh repo view')) return ok(JSON.stringify(REPO))
    if (args.startsWith('gh api repos/acme/widgets/compare/')) return ok('behind')
    const merge = /^gh pr merge (\d+)/.exec(args)
    if (merge) {
      merged.push(args)
      const p = prs.find(x => x.number === Number(merge[1]))!
      Object.assign(p, { state: 'MERGED', mergeCommit: { oid: `abcdef${p.number}` } })
      return ok('')
    }
    const commits = /^gh pr view (\d+) --json commits/.exec(args)
    if (commits) return ok((signed[Number(commits[1])] ?? []).join('\n'))
    const view = /^gh pr view (\d+)/.exec(args)
    if (view) return ok(JSON.stringify(prs.find(p => p.number === Number(view[1]))))
    return ok(JSON.stringify(prs))
  })
  return { sent, prompts, merged, clock, fault, reruns, calls, timer, toasts, signed, registry, titles }
}

const command = (args: string) => ({
  command: 'fix-prs', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
}) as const

test('status lists the open pull requests oldest first', async ($, on) => {
  world(on, [pr(9, '2026-10-26T12:00:00Z', 'SUCCESS'), pr(4, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('status'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#9/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /acme\/widgets/ }))?.text).toBe('acme/widgets')
  expect((await ui.find({ type: 'Text', text: /Not started/ }))?.text).toBe('Not started')
  expect((await ui.find({ type: 'Text', text: /#4/ }))?.text).toMatch(/^ {2}failing\s+#4 Change 4/)
  expect((await ui.find({ type: 'Text', text: /#9/ }))?.text).toMatch(/^ {2}green\s+#9 Change 9/)
  await ui.unmount()
})

test('a gh failure shows its exit code, its output and the repair', async ($, on) => {
  world(on, [], [], true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('status'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /exited 1/ })) !== undefined)
  const error = (await ui.find({ type: 'Text', text: /exited 1/ }))?.text ?? ''
  expect(error).toMatch(/not a git repository/)
  expect(error).toMatch(/gh auth login/)
  await ui.unmount()
})

test('the loop asks the owning agent, merges once the checks pass and thanks the agent', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, [{ name: 'issue-176', status: 'waiting' }, { name: 'someone-else', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.to).toBe('issue-176')
  expect(w.sent[0]!.text).toMatch(/PR #182 .* round 1 of 3/)
  expect(w.sent[0]!.text).toMatch(/failing checks: tests/)

  w.clock.now = 5 * 60_000
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /issue-176 \(/ }))?.text).toMatch(/issue-176 \(waiting\) · asked 5m ago, no reply yet/)
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toMatch(/#182 waiting on issue-176 since 5m ago · round 1\/3/)
  await ui.unmount()

  // The agent pushes a fix that passes, and says so.
  Object.assign(prs[0]!, { headRefOid: 'head-182-2', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  w.clock.now = 7 * 60_000
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="issue-176" from-mode="prompting">PR #182 is pushed at head-182-2.</cross-session-message>' })

  await until(() => w.sent.length === 2)
  expect(w.merged).toEqual(['gh pr merge 182 --merge'])
  expect(w.sent[1]).toEqual({ to: 'issue-176', text: expect.stringMatching(/PR #182 is merged \(abcdef1\)/) })
  expect(w.prompts).toEqual([])

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Finished/ }))?.text).toBe('Finished')
  expect((await ui.find({ type: 'Text', text: /abcdef1/ }))?.text).toMatch(/abcdef1 on main · by issue-176/)
  await ui.unmount()
})

test('start --no-merge fixes each pull request until it is green, then leaves the merge to a human', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176'), pr(185, '2026-10-26T12:00:00Z', 'SUCCESS'), pr(190, '2026-10-26T13:00:00Z', 'FAILURE')]
  const w = world(on, prs, [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run(command('start --no-merge')))).toMatch(/without merging/)

  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.text).toMatch(/Do not merge it: a human merges it/)
  expect(w.sent[0]!.text).not.toMatch(/I merge it/)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toMatch(/^Running · no merge · #182/)
  await ui.unmount()

  Object.assign(prs[0]!, { headRefOid: 'head-182-2', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="issue-176" from-mode="prompting">PR #182 is pushed.</cross-session-message>' })
  await until(() => w.sent.length === 2)
  expect(w.sent[1]!.text).toMatch(/PR #182 passes its checks and is ready for a human to merge/)

  // #185 is already green; #190 has no owner, so the model gets it, told not to merge.
  await until(() => w.prompts.length === 1)
  expect(w.prompts[0]).toMatch(/A human merges it/)
  expect(w.prompts[0]).not.toMatch(/the mod does both/)
  Object.assign(prs[2]!, { headRefOid: 'head-190-2', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  await $.tool.call({ tool: 'mcp__ndev__report', pr: 190, outcome: 'pushed' } as never)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^Finished/ })) !== undefined)
  for (const n of [182, 185, 190]) expect((await ui.find({ type: 'Text', text: new RegExp(`#${n}`) }))?.text).toMatch(new RegExp(`ready\\s+#${n}`))
  expect((await ui.find({ type: 'Text', text: /head-182-2/ }))?.text).toMatch(/green at head-182-2, left for a human to merge · by issue-176/)
  expect((await ui.find({ type: 'Text', text: /Queue finished/ }))?.text).toMatch(/0 merged, 3 ready/)
  await ui.unmount()
  expect(w.merged).toEqual([])
})

test('a plain start after a --no-merge run merges again', async ($, on) => {
  const w = world(on, [pr(185, '2026-10-26T12:00:00Z', 'SUCCESS')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start --no-merge'))
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('ready'))
  await $.command.run(command('start'))
  await until(() => w.merged.length === 1, () => w.merged)
  expect(w.merged).toEqual(['gh pr merge 185 --merge'])
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('Finished'))
})

test('the Start No Merge button starts the loop without merging', async ($, on) => {
  const w = world(on, [pr(185, '2026-10-26T12:00:00Z', 'SUCCESS')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'start-no-merge' }))?.props.label).toBe('Start No Merge')
  await ui.press({ key: 'start-no-merge' })
  await until(async () => (await ui.find({ type: 'Text', text: /^Finished/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /#185/ }))?.text).toMatch(/ready\s+#185/)
  await ui.unmount()
  expect(w.merged).toEqual([])
})

test('an unknown option is refused with the ones that exist', async ($, on) => {
  world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = (await $.command.run(command('start --no-merg'))) as { text: string }
  expect(out.text).toMatch(/does not know "--no-merg".*--no-merge/)
  // The loop did not start: the session's first tick only reads the list.
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('#182'))
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/Not started/)
})

test('Refresh adds a pull request opened since the queue was read, and says it refreshed', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE')]
  const { toasts } = world(on, prs, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('status'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#182/ })) !== undefined)

  prs.push(pr(200, '2026-10-27T09:00:00Z', 'SUCCESS'))
  await ui.press({ key: 'refresh' })
  await until(async () => (await ui.find({ type: 'Text', text: /#200/ })) !== undefined)
  expect(toasts).toContainEqual(expect.stringMatching(/refreshed: 2 pull requests/))
  await ui.unmount()
})

test('with no agent named after it, the owner is the listed session that signed its commits', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const w = world(on, prs, [{ name: 'lens-7d', status: 'idle' }, { name: 'lens-02', status: 'idle' }])
  w.signed[200] = [
    'Add lens start\n\nClaude-Session: https://claude.ai/code/session_0162XPizdiouspPu3kTt3cpW',
    'List lens start\n\nClaude-Session: https://claude.ai/code/session_0162XPizdiouspPu3kTt3cpW',
  ]
  w.registry.push(
    JSON.stringify({ pid: 1, name: 'lens-02', bridgeSessionId: 'session_01OTHER' }),
    '{"pid":2,"name":"half-writ',
    JSON.stringify({ pid: 3, name: 'lens-7d', sessionId: '11fdb9f1', cwd: '/Users/neil/dev/lens', bridgeSessionId: 'session_0162XPizdiouspPu3kTt3cpW' }),
  )
  w.titles['projects/-Users-neil-dev-lens/11fdb9f1.jsonl'] = 'Restarting "lens" after stop'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1, () => w.prompts)
  expect(w.sent[0]!.to).toBe('lens-7d')
  expect(w.prompts).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /signed its commits/ }))?.text).toMatch(/#200: owner lens-7d, the listed session that signed its commits/)
  // The owning session's title, beside its name.
  await until(async () => (await ui.find({ type: 'Text', text: /Restarting "lens" after stop/ })) !== undefined)
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('an owner found after the hand-over to the model takes the pull request over', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const agents: { name: string; status: string }[] = []
  const w = world(on, prs, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.prompts.length === 1)

  // The owning session signs in later, and the next tick finds it.
  agents.push({ name: 'lens-7d', status: 'idle' })
  w.signed[200] = ['Add lens start\n\nClaude-Session: https://claude.ai/code/session_0162X']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_0162X' }))
  w.clock.now = 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => w.sent)
  expect(w.sent[0]).toEqual({ to: 'lens-7d', text: expect.stringMatching(/PR #200 .* round 1 of 3/) })
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#200 waiting on its owner/)
  expect(w.prompts.length).toBe(1)
  await $.command.run(command('pause'))
})

test('with no owning agent the loop hands the pull request to the model, which can report it blocked', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.prompts.length === 1)
  expect(w.prompts[0]).toMatch(/# Fix pull request #190/)
  expect(w.prompts[0]).toMatch(/no agent is named after it and no listed session signed its commits/)
  expect(w.prompts[0]).toMatch(/mcp__ndev__report/)

  const out = await $.tool.call({ tool: 'mcp__ndev__report', pr: 190, outcome: 'blocked', reason: 'needs a product decision' } as never)
  expect(JSON.stringify(out)).toMatch(/Recorded #190 as blocked/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^Finished/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /#190/ }))?.text).toMatch(/blocked\s+#190/)
  expect((await ui.find({ type: 'Text', text: /product decision/ }))?.text).toMatch(/needs a product decision · by this session/)
  expect(await ui.find({ type: 'Button', key: 'retry-190' })).toBeDefined()
  await ui.unmount()
  expect(w.merged).toEqual([])
})

test('a GitHub outage never pauses the loop: it backs off, retries and carries on', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Let the start-up fetch of the idle loop finish first, so both failures meet the running loop.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#182/ })) !== undefined)
  w.fault.outage = 2
  await $.command.run(command('start'))
  await until(async () => (await ui.find({ type: 'Text', text: /GitHub error \(1 in a row\), retrying in 1 min/ })) !== undefined)
  await ui.unmount()

  // The second failure doubles the wait.
  w.clock.now = 60_000
  await $.command.run(command('resume'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /\(2 in a row\), retrying in 2 min/ })) !== undefined)
  await ui.unmount()

  w.clock.now = 3 * 60_000
  await $.command.run(command('resume'))
  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.text).toMatch(/PR #182/)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).not.toMatch(/GitHub error/)
  await ui.unmount()
})

test('a sign-in failure does not pause either: the loop keeps retrying and names the repair', async ($, on) => {
  world(on, [], [], true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /not a git repository/ })) !== undefined)
  expect(await ui.find({ type: 'Text', text: /^Paused/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toMatch(/GitHub error \(1 in a row\), retrying in 1 min/)
  await ui.unmount()
})

test('a merge GitHub keeps refusing is retried a minute apart, then recorded as blocked', async ($, on) => {
  const w = world(on, [pr(185, '2026-10-26T11:00:00Z', 'SUCCESS'), pr(190, '2026-10-26T12:00:00Z', 'SUCCESS')], [])
  w.fault.mergeError = { 185: 'GraphQL: Base branch was modified. Review and try the merge again.', 190: 'GraphQL: Repository rule violations found' }
  const tries = (n: number) => w.merged.filter(m => m.includes(` ${n} `)).length
  // Each minute stands for the next tick; a tick within the minute does not try again.
  const minute = async (check: () => boolean) => {
    w.clock.now += 60_000
    await $.command.run(command('resume'))
    await until(check, () => w.merged)
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => tries(185) === 1, () => w.merged)
  await $.command.run(command('resume'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(tries(185)).toBe(1)

  await minute(() => tries(185) === 2)
  delete w.fault.mergeError[185] // the base settles
  await minute(() => tries(185) === 3)
  await minute(() => tries(190) === 1)
  await minute(() => tries(190) === 2)
  await minute(() => tries(190) === 3)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^Finished/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /#185/ }))?.text).toMatch(/merged\s+#185/)
  expect((await ui.find({ type: 'Text', text: /#190/ }))?.text).toMatch(/blocked\s+#190/)
  expect((await ui.find({ type: 'Text', text: /refused the merge/ }))?.text).toMatch(/refused the merge 3 times: gh pr merge 190 exited 1/)
  await ui.unmount()
})

// The time of day the pane shows for `at`, in this machine's time zone.
const hhmm = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('a used-up API quota: the loop notes when it is back, waits without calling GitHub, and resumes then', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  w.fault.rateLimitUntil = 40 * 60_000
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const back = hhmm(40 * 60_000)
  await until(async () => (await ui.find({ type: 'Text', text: /quota used up/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toMatch(new RegExp(`GitHub API quota used up \\(graphql\\), resumes at ${back}`))
  expect((await ui.find({ type: 'Text', text: /is back at/ }))?.text).toMatch(new RegExp(`GitHub API quota used up \\(graphql\\); it is back at ${back}`))
  expect(await ui.find({ type: 'Text', text: /GitHub error/ })).toBeUndefined()
  await ui.unmount()

  // Before the reset the timer's ticks leave GitHub alone.
  const before = w.calls.count
  w.clock.now = 20 * 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.calls.count).toBe(before)
  expect(w.sent).toEqual([])

  // At the reset the next tick resumes by itself.
  w.clock.now = 41 * 60_000
  w.timer()
  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.text).toMatch(/PR #182/)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).not.toMatch(/quota/)
  await ui.unmount()
})

test('a used-up storage quota: the loop waits for GitHub to recount, then reruns the failed jobs instead of asking for a fix', async ($, on) => {
  const prs = [pr(193, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-171')]
  const w = world(on, prs, [{ name: 'issue-171', status: 'idle' }])
  w.fault.storage = { 193: true }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const back = hhmm(6 * 60 * 60_000)
  await until(async () => (await ui.find({ type: 'Text', text: /quota used up/ })) !== undefined)
  // The pane cuts the line to its width; the status reply carries it whole.
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(new RegExp(`#193 checking · round 0/3 · Actions storage quota used up, resumes at ${back}`))
  expect((await ui.find({ type: 'Text', text: /reruns the failed jobs/ }))?.text).toMatch(new RegExp(`#193: Actions storage full; reruns the failed jobs at ${back}`))
  await ui.unmount()
  expect(w.sent).toEqual([])
  expect(w.prompts).toEqual([])

  w.clock.now = 6 * 60 * 60_000 - 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.reruns).toEqual([])

  w.clock.now = 6 * 60 * 60_000
  w.timer()
  await until(() => w.reruns.length === 1, () => w.reruns)
  expect(w.reruns).toEqual(['gh run rerun 77 --failed'])
  // The rerun passes; the next tick merges.
  w.clock.now += 60_000
  w.timer()
  await until(() => w.merged.length === 1, () => w.merged)
  expect(w.sent.map(m => m.text)).toEqual([expect.stringMatching(/PR #193 is merged/)])
})

test('resuming during a storage quota wait reruns at once, for when the budget was raised', async ($, on) => {
  const w = world(on, [pr(193, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-171')], [])
  w.fault.storage = { 193: true }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('storage quota used up'))
  expect(w.reruns).toEqual([])

  w.clock.now = 10 * 60_000
  await $.command.run(command('resume'))
  await until(() => w.reruns.length === 1, () => w.reruns)
  expect(w.prompts).toEqual([])
})

test('a message from the loop compacts its owning session first when the session has been idle over 50 minutes', async ($, on) => {
  const w = world(on, [], [])
  const compacts: (string | undefined)[] = []
  on('session.compact', (_$, e) => { compacts.push(e.instructions); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const fromLoop = { origin: { kind: 'peer', plugin: 'ndev' }, text: 'PR #200 needs work: the checks fail.' } as const

  w.clock.now = 49 * 60_000
  expect(await $.session.receive(fromLoop)).toEqual({ text: fromLoop.text })
  expect(compacts).toEqual([])

  // Idle for 51 minutes since that message: a message from another sender leaves it, the loop's compacts first.
  w.clock.now += 51 * 60_000
  await $.session.receive({ origin: { kind: 'peer' }, text: 'hello' })
  expect(compacts).toEqual([])
  w.clock.now += 51 * 60_000
  expect(await $.session.receive(fromLoop)).toEqual({ text: fromLoop.text })
  expect(compacts).toEqual([expect.stringMatching(/PR #200/)])
  expect(w.toasts).toContainEqual(expect.stringMatching(/compacted after 51 minutes idle, before PR #200/))
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('acme/widgets'))
})

test('retry starts a pull request afresh: round 1, the owner asked again, its blocked reply forgotten', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-200')]
  const w = world(on, prs, [{ name: 'issue-200', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  // The owner is blocked on something the person fixes (Docker hung); the loop hands it to the model.
  w.clock.now = 60_000
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from-name="issue-200">blocked: PR #200 cannot push, Docker is not responding.</cross-session-message>' })
  await until(() => w.prompts.length === 1, () => w.prompts)

  w.clock.now = 2 * 60_000
  await $.command.run(command('retry 200'))
  await until(() => w.sent.length === 2, () => w.sent)
  expect(w.sent[1]).toEqual({ to: 'issue-200', text: expect.stringMatching(/PR #200 .* round 1 of 3/) })
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#200 waiting on its owner since just now · round 1\/3/)
  expect(w.prompts.length).toBe(1)
  await $.command.run(command('pause'))
})
