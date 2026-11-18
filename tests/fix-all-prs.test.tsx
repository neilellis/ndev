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

// An Orca worktree of acme/widgets, as `orca worktree list --json` prints it.
const orcaWorktree = (name: string, path: string, branch: string, more: Record<string, unknown> = {}) => ({
  id: `repo-1::${path}`, repoId: 'repo-1', projectId: 'github:acme/widgets', path, branch: `refs/heads/${branch}`,
  displayName: name, isMainWorktree: false, isArchived: false, linkedPR: null as number | null, linkedItems: [] as unknown[], ...more,
})

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
  // The loop's own session is in the registry under its name, which an agent started in Orca replies to.
  const registry: string[] = [JSON.stringify({ pid: 0, name: 'queue-1e', sessionId: 'loop-session' })]
  // Orca's worktrees; `created` and `launched` keep the argv of each `orca worktree create` and `orca agent launch`;
  // `error` fails every orca call with that output; `refusal` makes Orca refuse each create with that message;
  // `isCut` cuts the worktree list short; `isHung` leaves each create unanswered until its timeout, kept in `createTimeouts`;
  // `isListSlow` times out each worktree list given less than 120 s.
  const orca = {
    worktrees: [orcaWorktree('main', '/src/widgets', 'main', { isMainWorktree: true })],
    created: [] as string[][], launched: [] as string[][], error: '', refusal: '', isCut: false, isHung: false, isListSlow: false,
    createTimeouts: [] as (number | undefined)[],
  }
  // Each transcript's newest title, by its path under the Claude Code folder.
  const titles: Record<string, string> = {}
  // gh calls that reached GitHub, `gh api rate_limit` aside, and the reads of a pull request's commits among them.
  const calls = { count: 0 }
  const commitReads = { count: 0 }
  // `outage` fails that many gh calls with a server error; `mergeError` makes GitHub refuse each merge;
  // `rateLimitUntil` fails every gh call before that time with GitHub's rate-limit refusal;
  // `storage` fails the checks of those pull requests on the Actions storage quota until a rerun;
  // `registry` fails each read of the session registry with that output; `prompt` drops each prompt with that reason, as a refusing hook does.
  const fault = { checkEvery: '0', ghCalls: [] as string[], rowsError: '', outage: 0, mergeError: {} as Record<number, string>, rateLimitUntil: 0, storage: {} as Record<number, boolean>, registry: '', prompt: '' }
  // Each period of `$.clock.every` waits here until the test fires the timer. A fire before the next period waits
  // is kept for it: the engine arms that period only after it has handled the last one.
  const timers: (() => void)[] = []
  let isFireDue = false
  const timer = () => {
    isFireDue = timers.length === 0
    timers.splice(0).forEach(fire => fire())
  }
  on('command.register', () => ({ value: { command: 'fix-prs' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  // The plugin's session start also reads ~/dev-wiki and the project file: both are in place,
  // so it runs no set-up and no wiki script, and every process call below is the loop's.
  // The loop's time between GitHub reads: none here, so each tick reads. A test of the budget clears it.
  on('env.get', (_, e) => ({ value: e.name === 'NDEV_PR_CHECK_MS' ? fault.checkEvery : '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/neil/dev-wiki/wiki.md' || e.path === '/.neil-dev.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ github: { repo: 'acme/widgets', board: null } }) }))
  on('clock.every', () => new Promise(resolve => {
    if (isFireDue) {
      isFireDue = false
      resolve({ value: undefined })
    } else {
      timers.push(() => resolve({ value: undefined }))
    }
  }))
  on('clock.now', () => ({ value: clock.now }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => {
    if (fault.prompt) return { drop: fault.prompt }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'loop-session' }))
  on('session.send', (_, e) => { sent.push({ to: e.to, text: e.text }); return { isDelivered: true } })
  on('session.receive', (_, e) => ({ text: e.text }))
  const listing = { deny: '' }
  on('tool.call', () => listing.deny ? { deny: listing.deny } : { result: { listing: '', sections: [{ kind: 'peers', total: agents.length, rows: agents }] } })
  on('process.run', (_, e) => {
    if (isGhBroken) return { value: { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    // A call through scripts/github/gh.sh reads as `gh.sh <command>`.
    const args = e.argv.join(' ').replace(/^bash \S*\/scripts\/github\/gh\.sh/, 'gh.sh')
    if (e.argv[0] === 'sh' && args.includes('/sessions/')) {
      if (fault.registry) return { value: { exitCode: 1, stdout: '', stderr: fault.registry, isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(registry.map(line => `${line}\n`).join(''))
    }
    if (e.argv[0] === 'sh' && args.includes('aiTitle')) {
      const files = e.argv.slice(4)
      return ok(files.map(f => `${f}\t${titles[f] ? `"aiTitle":${JSON.stringify(titles[f])}` : ''}\n`).join(''))
    }
    if (e.argv[0] === 'orca') {
      if (orca.error) return { value: { exitCode: 1, stdout: '', stderr: orca.error, isStdoutTruncated: false, isStderrTruncated: false } }
      const flag = (name: string) => e.argv[e.argv.indexOf(name) + 1]!
      if (args.startsWith('orca worktree list')) {
        if (orca.isListSlow && (e.init?.timeoutMs ?? 0) < 120_000) return { deny: `timed out after ${e.init?.timeoutMs} ms` }
        return ok(JSON.stringify({ id: 'o1', ok: true, result: { worktrees: orca.worktrees, totalCount: orca.isCut ? 999 : orca.worktrees.length, truncated: orca.isCut } }))
      }
      if (args.startsWith('orca worktree create')) {
        orca.created.push([...e.argv])
        orca.createTimeouts.push(e.init?.timeoutMs)
        if (orca.isHung) return { deny: `timed out after ${e.init?.timeoutMs} ms` }
        if (orca.refusal) {
          const refusal = JSON.stringify({ id: 'o4', ok: false, error: { code: 'name_taken', message: orca.refusal } })
          return { value: { exitCode: 1, stdout: refusal, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        const name = flag('--name')
        const wt = orcaWorktree(name, `/orca/${name}`, `neil/${name}`, { linkedPR: Number(/\/pull\/(\d+)$/.exec(flag('--reference'))?.[1]) })
        orca.worktrees.push(wt)
        return ok(JSON.stringify({ id: 'o2', ok: true, result: { worktree: wt } }))
      }
      if (args.startsWith('orca agent launch')) {
        orca.launched.push([...e.argv])
        return ok(JSON.stringify({ id: 'o3', ok: true, result: { outcome: { kind: 'terminal' } } }))
      }
    }
    // The plugin's session start finds the project root; it is no GitHub call.
    if (args === 'git rev-parse --show-toplevel') return ok('/\n')
    // The credentials check finds .neil-dev.env at session start; it is no GitHub call.
    if (args.includes('/scripts/env/neil-dev-env.mjs status')) return ok(JSON.stringify({ file: '/.neil-dev.env', copiedFrom: null, root: '/', main: '/', ignored: true, keys: [], missing: [] }))
    if (args === 'gh.sh api rate_limit') {
      const reset = Math.ceil(fault.rateLimitUntil / 1000)
      return ok(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4800, reset: 60 }, graphql: { limit: 5000, remaining: 0, reset } } }))
    }
    calls.count++
    if (args.startsWith('gh')) fault.ghCalls.push(args)
    if (args.startsWith('gh.sh pr-rows') && fault.rowsError) return { value: { exitCode: 1, stdout: '', stderr: fault.rowsError, isStdoutTruncated: false, isStderrTruncated: false } }
    if (clock.now < fault.rateLimitUntil) {
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user ID 1.', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const checkRuns = /^gh\.sh api repos\/acme\/widgets\/commits\/head-(\d+)-\d+\/check-runs.* --jq /.exec(args)
    if (checkRuns) return ok(fault.storage[Number(checkRuns[1])] ? '901 https://github.com/acme/widgets/actions/runs/77/job/901\n' : '')
    if (/^gh\.sh api repos\/acme\/widgets\/check-runs\/901\/annotations/.test(args)) {
      return ok('Failed to CreateArtifact: Artifact storage quota has been hit. Unable to upload any new artifacts. Usage is recalculated every 6-12 hours.\n')
    }
    if (args.startsWith('gh.sh rerun-failed')) {
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
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway (https://api.github.com/repos/acme/widgets/pulls)', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // Every GitHub read and write goes through gh.sh. `gh pr view --web` only opens a browser.
    if (/^gh /.test(args) && !args.endsWith('--web')) throw new Error(`raw gh call: ${args}`)
    if (args === 'gh.sh repo-read') {
      return ok(JSON.stringify({ full_name: REPO.nameWithOwner, default_branch: REPO.defaultBranchRef.name, allow_merge_commit: REPO.mergeCommitAllowed, allow_squash_merge: REPO.squashMergeAllowed, allow_rebase_merge: REPO.rebaseMergeAllowed }))
    }
    if (args === 'gh.sh me') return ok('{"login":"me"}')
    if (args.startsWith('gh.sh api repos/acme/widgets/compare/')) return ok('behind')
    const rest = (p: Pr) => ({
      number: p.number,
      title: p.title,
      state: p.state === 'OPEN' ? 'open' : 'closed',
      draft: p.isDraft,
      merged: p.state === 'MERGED',
      mergeable: p.mergeable === 'UNKNOWN' ? null : p.mergeable === 'MERGEABLE',
      mergeable_state: p.mergeStateStatus.toLowerCase(),
      merge_commit_sha: p.mergeCommit?.oid ?? null,
      created_at: p.createdAt,
      user: { login: 'me' },
      head: { ref: p.headRefName, sha: p.headRefOid },
    })
    const merge = /^gh\.sh pr-merge (\d+) --method (\w+)$/.exec(args)
    if (merge) {
      merged.push(`gh pr merge ${merge[1]} --${merge[2]}`)
      if (fault.mergeError[Number(merge[1])]) return { value: { exitCode: 1, stdout: '', stderr: fault.mergeError[Number(merge[1])]!, isStdoutTruncated: false, isStderrTruncated: false } }
      const p = prs.find(x => x.number === Number(merge[1]))!
      Object.assign(p, { state: 'MERGED', mergeCommit: { oid: `abcdef${p.number}` } })
      return ok('{}')
    }
    const commits = /^gh\.sh pr-commit-messages (\d+)/.exec(args)
    if (commits) {
      commitReads.count++
      return ok((signed[Number(commits[1])] ?? []).join('\n'))
    }
    const checksOf = /^gh\.sh commit-checks (head-\d+-\d+)/.exec(args)
    if (checksOf) {
      const p = prs.find(x => x.headRefOid === checksOf[1])
      return ok(JSON.stringify({ statuses: [], check_runs: (p?.statusCheckRollup ?? []).map((c: { name: string; status: string; conclusion: string; startedAt?: string }) => ({ name: c.name, started_at: c.startedAt ?? null, status: c.status.toLowerCase(), conclusion: c.conclusion ? c.conclusion.toLowerCase() : null })) }))
    }
    const one = /^gh\.sh pr-read (\d+)$/.exec(args)
    if (one) {
      const p = prs.find(x => x.number === Number(one[1]))
      return p ? ok(JSON.stringify(rest(p))) : { value: { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (args.startsWith('gh.sh pr-rows')) return ok(prs.filter(p => p.state === 'OPEN').map(p => `${JSON.stringify(p)}\n`).join(''))
    if (args.startsWith('gh.sh pr-list')) return ok(prs.map(p => `${JSON.stringify(rest(p))}\n`).join(''))
    return ok('')
  })
  return { sent, prompts, merged, clock, fault, reruns, calls, commitReads, timer, toasts, signed, registry, titles, orca, listing }
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
  // The number is a link to the pull request, and a failing check a link to its checks page.
  expect((await ui.find({ type: 'Link', text: '#4' }))?.props.href).toBe('https://github.com/acme/widgets/pull/4')
  expect((await ui.find({ type: 'Link', text: 'tests' }))?.props.href).toBe('https://github.com/acme/widgets/pull/4/checks')
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

test('the loop finds the agent of a workspace named <issue>-<short name>, and not the agent of an issue with other digits', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, [{ name: '1176-other-work', status: 'idle' }, { name: '176-add-sub', status: 'waiting' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.to).toBe('176-add-sub')
})

test('the loop finds the agent of a workspace renamed <pr>-<short name> once its PR was added', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, [{ name: '1182-other-work', status: 'idle' }, { name: '182-add-sub', status: 'waiting' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.to).toBe('182-add-sub')
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

for (const via of ['the one-call list', 'the REST read of each pull request']) test(`a cancelled run of a check that ran again and passed on the same head is no failure, read through ${via}: the pull request merges with no agent asked`, async ($, on) => {
  const green = pr(1179, '2026-10-26T11:00:00Z', 'SUCCESS', 'claude/issue-34')
  // A concurrency group cancelled the first run of "checks"; the second run on the same commit passed.
  green.statusCheckRollup = [
    { name: 'checks', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-26T11:05:00Z' },
    { name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-26T11:10:00Z' },
  ] as never
  const w = world(on, [green], [{ name: 'issue-34', status: 'idle' }])
  if (via.startsWith('the REST')) w.fault.rowsError = 'GraphQL: API rate limit exceeded'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.merged.length > 0 || w.sent.some(m => /needs:/i.test(m.text)))
  expect(w.sent.map(m => m.text).filter(t => /needs:/i.test(t))).toEqual([])
  expect(w.merged).toEqual(['gh pr merge 1179 --merge'])
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

  // #185 is already green; #190 has no owner, so an agent in Orca gets it, told not to merge.
  await until(() => w.orca.created.length === 1)
  const brief = w.orca.created[0]![w.orca.created[0]!.indexOf('--prompt') + 1]
  expect(brief).toMatch(/A human merges it/)
  expect(brief).not.toMatch(/the mod does both/)
  Object.assign(prs[2]!, { headRefOid: 'head-190-2', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  w.clock.now = 60_000
  w.timer()

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

test('start --prs works only the named pull requests; a second --prs adds to the running loop', async ($, on) => {
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176'), pr(185, '2026-10-26T12:00:00Z', 'SUCCESS'), pr(190, '2026-10-26T13:00:00Z', 'FAILURE')]
  const w = world(on, prs, [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run(command('start --prs 182')))).toMatch(/#182/)
  await until(() => w.sent.length === 1)
  expect(w.sent[0]!.text).toMatch(/PR #182 /)

  // While the loop waits on #182, a second --prs adds #185 and does not start afresh.
  await $.command.run(command('start --prs 185'))
  Object.assign(prs[0]!, { headRefOid: 'head-182-2', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="issue-176" from-mode="prompting">PR #182 is pushed.</cross-session-message>' })
  await until(async () => JSON.stringify(await $.command.run(command('status'))).includes('Finished'), () => w.merged)
  expect(w.merged).toEqual(['gh pr merge 182 --merge', 'gh pr merge 185 --merge'])
  // #190 is not named, so no agent starts for it and the pane does not list it.
  expect(w.orca.created).toEqual([])
  expect(JSON.stringify(await $.command.run(command('status')))).not.toMatch(/#190/)
})

test('start --prs refuses a list that is not pull request numbers', async ($, on) => {
  world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = (await $.command.run(command('start --prs 18x'))) as { text: string }
  expect(out.text).toMatch(/--prs needs pull request numbers, for example --prs 182,190/)
  const extra = (await $.command.run(command('start --prs 182 190'))) as { text: string }
  expect(extra.text).toMatch(/--prs takes one list with commas, for example --prs 182,190, not "190"/)
})

test('start --prs refuses a pull request that GitHub does not give, or one that is not open, and starts nothing', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE'), { ...pr(185, '2026-10-26T12:00:00Z', 'SUCCESS'), state: 'MERGED' }], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start --prs 182,999,185'))
  await until(() => w.toasts.some(t => t.includes('/fix-prs start failed')), () => w.toasts)
  const toast = w.toasts.find(t => t.includes('/fix-prs start failed'))!
  expect(toast).toMatch(/PR #999: .*HTTP 404/)
  expect(toast).toMatch(/PR #185 is merged, not open/)
  expect(JSON.stringify(await $.command.run(command('status')))).not.toMatch(/Running/)
  expect(w.sent).toEqual([])
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

test('an owner found by a refresh before the start is noted again when the queue starts', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const w = world(on, prs, [{ name: 'lens-7d', status: 'idle' }])
  w.signed[200] = ['Add lens start\n\nClaude-Session: https://claude.ai/code/session_7d']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_7d' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Asking for the status finds the owner before /fix-prs start.
  await $.command.run(command('status'))
  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await before.find({ type: 'Text', text: /lens-7d/ })) !== undefined, () => 'the status refresh named no owner')
  await before.unmount()
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1, () => w.prompts)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#200: owner lens-7d, the listed session that signed its commits/ })) !== undefined, () => 'the activity log does not say how the owner was found')
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('a message to the owner by its socket address keeps the owner by name, so it is not taken as gone', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const w = world(on, prs, [{ name: 'lens-7d', status: 'idle' }])
  w.signed[200] = ['Add lens start\n\nClaude-Session: https://claude.ai/code/session_7d']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', messagingSocketPath: '/tmp/cc-socks/3.sock', bridgeSessionId: 'session_7d' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1, () => w.prompts)

  // The model writes to the owner at the address its reply came from.
  w.clock.now = 60_000
  await $.session.send({ origin: { kind: 'model' }, to: 'uds:/tmp/cc-socks/3.sock', text: 'PR #200 failed again on the fresh run.' })
  w.clock.now = 31 * 60_000
  w.timer()
  await until(() => w.prompts.length === 1, () => ({ prompts: w.prompts, created: w.orca.created }))
  expect(w.prompts[0]).toMatch(/lens-7d has not pushed or answered for 30 minutes/)
  expect(w.orca.created).toEqual([])
  await $.command.run(command('pause'))
})

test('a socket address whose session cannot be named is recorded as given, and the log says why', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  w.fault.registry = 'cat: /home/neil/.claude/sessions/9.json: Permission denied'
  await $.session.send({ origin: { kind: 'model' }, to: 'uds:/tmp/cc-socks/9.sock', text: 'PR #182 failed again on the fresh run.' })
  w.fault.registry = ''
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 300 }, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /could not be named/ }))?.text).toMatch(
    /uds:\/tmp\/cc-socks\/9\.sock: its session could not be named, so the message is recorded under the address: reading the Claude Code session registry exited 1: cat: .*Permission denied/)
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('a socket address with no named session in the registry is recorded as given, and the log says why', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  // No session in the registry has the socket.
  await $.session.send({ origin: { kind: 'model' }, to: 'uds:/tmp/cc-socks/8.sock', text: 'PR #182 failed again on the fresh run.' })
  // A session is writing its registry file at that moment, so the file does not parse.
  w.registry.push('{"pid": 9, "name": "issue-1')
  await $.session.send({ origin: { kind: 'model' }, to: 'uds:/tmp/cc-socks/9.sock', text: 'PR #182 failed again on the fresh run.' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 300 }, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /8\.sock: no named/ }))?.text).toMatch(
    /uds:\/tmp\/cc-socks\/8\.sock: no named session in the Claude Code session registry has this socket, so the message is recorded under the address/)
  expect((await ui.find({ type: 'Text', text: /9\.sock: no named/ }))?.text).toMatch(
    /uds:\/tmp\/cc-socks\/9\.sock: no named session in the Claude Code session registry has this socket, and a registry file did not parse \(a session may have been writing it\), so the message is recorded under the address/)
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('an owner found while the agent started in Orca is awaited is not asked: the started agent keeps the pull request', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const agents: { name: string; status: string }[] = []
  const w = world(on, prs, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.orca.created.length === 1, () => w.prompts)

  // The session that signed the commits signs in before the started agent is listed: two agents would fix one branch.
  agents.push({ name: 'lens-7d', status: 'idle' })
  w.signed[200] = ['Add lens start\n\nClaude-Session: https://claude.ai/code/session_0162X']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_0162X' }))
  w.clock.now = 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.sent).toEqual([])
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#200 waiting on the agent in Orca workspace pr-200/)

  // The started agent is listed, in its workspace: it is asked.
  agents.push({ name: 'pr-200-d4', status: 'busy' })
  w.registry.push(JSON.stringify({ pid: 6, name: 'pr-200-d4', cwd: '/orca/pr-200' }))
  w.clock.now = 2 * 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => w.sent)
  expect(w.sent[0]).toEqual({ to: 'pr-200-d4', text: expect.stringMatching(/PR #200 .* round 1 of 3/) })
  expect(w.orca.created.length).toBe(1)
  expect(w.prompts).toEqual([])
  await $.command.run(command('pause'))
})

test('once the agent started in Orca has pushed, the next round asks a listed owner, not a second agent', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const agents: { name: string; status: string }[] = []
  const w = world(on, prs, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.orca.created.length === 1, () => w.prompts)

  // The session that signed the commits signs in while the started agent is awaited.
  agents.push({ name: 'lens-7d', status: 'idle' })
  w.signed[200] = ['Add lens start\n\nClaude-Session: https://claude.ai/code/session_0162X']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_0162X' }))

  // The started agent pushes and leaves before it is listed; the checks of the new head then fail.
  Object.assign(prs[0]!, { headRefOid: 'head-200-2', statusCheckRollup: [{ name: 'tests', status: 'IN_PROGRESS', conclusion: '' }] })
  w.clock.now = 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  Object.assign(prs[0]!, { statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  w.clock.now = 2 * 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => ({ sent: w.sent, launched: w.orca.launched, prompts: w.prompts }))
  expect(w.sent[0]).toEqual({ to: 'lens-7d', text: expect.stringMatching(/PR #200 .* round 2 of 3/) })
  expect(w.orca.launched).toEqual([])
  expect(w.orca.created.length).toBe(1)
  await $.command.run(command('pause'))
})

test('an agent started in Orca that is never listed leaves the next round blocked, not with a second agent', async ($, on) => {
  const prs = [pr(200, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-lens-start')]
  const w = world(on, prs, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.orca.created.length === 1, () => w.prompts)

  // The started agent pushes without ever being listed, and the checks of the new head fail: it may still be at work.
  Object.assign(prs[0]!, { headRefOid: 'head-200-2', statusCheckRollup: [{ name: 'tests', status: 'IN_PROGRESS', conclusion: '' }] })
  w.clock.now = 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  Object.assign(prs[0]!, { statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  w.clock.now = 2 * 60_000
  w.timer()
  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => /#200 Change 200: blocked/.test(await status()), () => ({ launched: w.orca.launched, prompts: w.prompts }))
  expect(await status()).toMatch(
    /blocked, the agent started in Orca workspace pr-200 was never listed, so round 2 has no agent to ask, and no second agent starts beside it\. Repair: look at Orca workspace pr-200; when no agent runs in it, retry #200/)
  expect(w.orca.launched).toEqual([])
  expect(w.orca.created.length).toBe(1)
  expect(w.prompts).toEqual([])
})

test('with no owning agent the loop starts a Claude agent in a new Orca workspace, and asks it once it is listed', async ($, on) => {
  const agents: { name: string; status: string }[] = []
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.orca.created.length === 1, () => w.prompts)
  const argv = w.orca.created[0]!
  const flag = (name: string) => argv[argv.indexOf(name) + 1]
  expect(flag('--name')).toBe('pr-190')
  expect(flag('--repo')).toBe('id:repo-1')
  expect(flag('--base-branch')).toBe('origin/branch-190')
  expect(flag('--reference')).toBe('https://github.com/acme/widgets/pull/190')
  expect(flag('--agent')).toBe('claude')
  const brief = flag('--prompt') ?? ''
  expect(brief).toMatch(/# Fix pull request #190/)
  expect(brief).toMatch(/no agent is named after it, no listed session signed its commits and no listed session works in an Orca workspace for it/)
  expect(brief).toMatch(/HEAD:branch-190/)
  expect(brief).toMatch(/send `queue-1e` a message/)
  expect(brief).toMatch(/starts with "blocked:"/)
  expect(brief).not.toMatch(/mcp__ndev__report/)
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#190 waiting on the agent in Orca workspace pr-190/)

  // The agent's session runs in its workspace: the next tick finds it and asks it.
  agents.push({ name: 'pr-190-a1', status: 'busy' })
  w.registry.push(JSON.stringify({ pid: 6, name: 'pr-190-a1', cwd: '/orca/pr-190' }))
  w.clock.now = 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => w.sent)
  expect(w.sent[0]).toEqual({ to: 'pr-190-a1', text: expect.stringMatching(/PR #190 .* round 1 of 3/) })
  expect(w.orca.created.length).toBe(1)
  expect(w.prompts).toEqual([])
  await $.command.run(command('pause'))
})

test('a listed session in an Orca workspace of the pull request is its owner, by link or by branch', async ($, on) => {
  const prs = [pr(207, '2026-10-26T11:00:00Z', 'FAILURE', 'neil/walk-through'), pr(208, '2026-10-26T12:00:00Z', 'FAILURE', 'neil/docs')]
  const w = world(on, prs, [{ name: 'walk-through-3f', status: 'idle' }, { name: 'docs-9c', status: 'idle' }])
  w.orca.worktrees.push(
    orcaWorktree('walk-through', '/orca/walk-through', 'neil/walk-through-local', { linkedItems: [{ provider: 'github', type: 'pr', number: 207 }] }),
    orcaWorktree('docs', '/orca/docs', 'neil/docs'),
  )
  w.registry.push(
    JSON.stringify({ pid: 4, name: 'walk-through-3f', cwd: '/orca/walk-through/apps/ui' }),
    JSON.stringify({ pid: 5, name: 'docs-9c', cwd: '/orca/docs' }),
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1, () => w.prompts)
  expect(w.sent[0]).toEqual({ to: 'walk-through-3f', text: expect.stringMatching(/PR #207 .* round 1 of 3/) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /#207: owner/ }))?.text).toMatch(/#207: owner walk-through-3f, in Orca workspace walk-through/)
  expect((await ui.find({ type: 'Text', text: /#208: owner/ }))?.text).toMatch(/#208: owner docs-9c, in Orca workspace docs/)
  await ui.unmount()
  expect(w.orca.created).toEqual([])
  expect(w.prompts).toEqual([])
  await $.command.run(command('pause'))
})

test('an Orca workspace that holds the pull request but runs no listed agent gets an agent, not a second workspace', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.orca.worktrees.push(orcaWorktree('fix-190', '/orca/fix-190', 'neil/fix-190', { linkedPR: 190 }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.orca.launched.length === 1, () => w.prompts)
  const argv = w.orca.launched[0]!
  expect(argv.slice(0, 7)).toEqual(['orca', 'agent', 'launch', '--agent', 'claude', '--worktree', 'id:repo-1::/orca/fix-190'])
  expect(argv[argv.indexOf('--prompt') + 1]).toMatch(/# Fix pull request #190/)
  expect(w.orca.created).toEqual([])
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#190 waiting on the agent in Orca workspace fix-190/)
  await $.command.run(command('pause'))
})

test('an owner that is no longer listed passes the pull request to Orca, and the new agent takes it over', async ($, on) => {
  const agents = [{ name: 'issue-176', status: 'idle' }]
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  agents.splice(0)
  w.clock.now = 60_000
  w.timer()
  await until(() => w.orca.created.length === 1, () => w.prompts)
  const argv = w.orca.created[0]!
  expect(argv[argv.indexOf('--prompt') + 1]).toMatch(/its owning agent issue-176 is no longer listed/)
  expect(w.prompts).toEqual([])

  agents.push({ name: 'pr-182-b2', status: 'busy' })
  w.registry.push(JSON.stringify({ pid: 6, name: 'pr-182-b2', cwd: '/orca/pr-182' }))
  w.clock.now = 2 * 60_000
  w.timer()
  await until(() => w.sent.length === 2, () => w.sent)
  expect(w.sent[1]).toEqual({ to: 'pr-182-b2', text: expect.stringMatching(/PR #182 .* round 1 of 3/) })
  expect(w.prompts).toEqual([])
  await $.command.run(command('pause'))
})

test('when Orca fails, a pull request with no owner is blocked with Orca\'s output and the repair, and owners are still asked', async ($, on) => {
  const prs = [pr(190, '2026-10-26T11:00:00Z', 'FAILURE'), pr(182, '2026-10-26T12:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, [{ name: 'issue-176', status: 'idle' }])
  w.orca.error = 'Error: Orca is not running'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.sent.length === 1, () => w.prompts)
  expect(w.sent[0]!.to).toBe('issue-176')
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(
    /#190 Change 190: blocked, Orca could not start an agent \(no agent is named after it.*\): orca worktree list exited 1: Error: Orca is not running\. Repair: .*orca status/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Orca workspaces not read/ }))?.text).toMatch(/Orca is not running/)
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('when the agents cannot be listed, a pull request with no known owner goes to the model, not to Orca', async ($, on) => {
  const agents: { name: string; status: string }[] = []
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], agents)
  w.listing.deny = 'peer listing is off'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.prompts.length === 1, () => w.orca.created)
  expect(w.prompts[0]).toMatch(/the agents could not be listed to find its owner \(ListAgents refused: peer listing is off\)/)
  expect(w.orca.created).toEqual([])
  expect(w.orca.launched).toEqual([])

  // The list works again and shows an agent named after the pull request: it takes the pull request over.
  w.listing.deny = ''
  agents.push({ name: 'pr-190-c3', status: 'idle' })
  w.clock.now = 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => w.sent)
  expect(w.sent[0]).toEqual({ to: 'pr-190-c3', text: expect.stringMatching(/PR #190 .* round 1 of 3/) })
  expect(w.orca.created).toEqual([])
  // The model is told to stop, and a late report from it is refused.
  await until(() => w.prompts.length === 2, () => w.prompts)
  expect(w.prompts[1]).toMatch(/Stop work on pull request #190: its owning agent pr-190-c3 has it now\. Do not push to it or call `mcp__ndev__report` for it/)
  const out = await $.tool.call({ tool: 'mcp__ndev__report', pr: 190, outcome: 'pushed' } as never)
  expect(JSON.stringify(out)).toMatch(/Refused: #190 is not with this session's model now \(pr-190-c3 has it\)/)
  expect(JSON.stringify(await $.command.run(command('status')))).toMatch(/#190 waiting on its owner/)
  await $.command.run(command('pause'))
})

test('an owner replaced while the loop waits on its answer is asked in turn, not blamed for the silence', async ($, on) => {
  const agents = [{ name: 'issue-176', status: 'idle' }]
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  // The asked owner leaves, and by the same tick the session that signed the commits is listed.
  agents.splice(0, 1, { name: 'lens-7d', status: 'idle' })
  w.signed[182] = ['Fix it\n\nClaude-Session: https://claude.ai/code/session_0162X']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_0162X' }))
  w.clock.now = 60_000
  w.timer()
  await until(() => w.sent.length === 2, () => w.sent)
  expect(w.sent[1]).toEqual({ to: 'lens-7d', text: expect.stringMatching(/PR #182 .* round 1 of 3/) })
  expect(w.orca.created).toEqual([])
  expect(w.prompts).toEqual([])
  await $.command.run(command('pause'))
})

test('a pull request handed to the model after its owner went silent stays with the model when another owner turns up', async ($, on) => {
  const agents = [{ name: 'issue-176', status: 'idle' }]
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)
  w.clock.now = 31 * 60_000
  w.timer()
  await until(() => w.prompts.length === 1, () => w.sent)
  expect(w.prompts[0]).toMatch(/issue-176 has not pushed or answered for 30 minutes/)

  // The model is working on it when the owner leaves and the session that signed the commits is listed.
  agents.splice(0, 1, { name: 'lens-7d', status: 'idle' })
  w.signed[182] = ['Fix it\n\nClaude-Session: https://claude.ai/code/session_0162X']
  w.registry.push(JSON.stringify({ pid: 3, name: 'lens-7d', bridgeSessionId: 'session_0162X' }))
  w.clock.now = 32 * 60_000
  w.timer()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#182: owner lens-7d/ })) !== undefined)
  await ui.unmount()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.sent.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  await $.command.run(command('pause'))
})

test('an agent started in Orca that is not listed within 30 minutes leaves the pull request blocked, not with the model', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.orca.created.length === 1, () => w.prompts)

  // Orca stops answering, so the agent cannot be found in its workspace either: the record says so.
  w.orca.error = 'Error: Orca is not running'
  w.clock.now = 31 * 60_000
  w.timer()
  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => /#190 Change 190: blocked/.test(await status()), () => w.prompts)
  expect(await status()).toMatch(
    /blocked, the agent started in Orca workspace pr-190 was not listed within 30 minutes \(the Orca workspaces could not be read: orca worktree list exited 1: Error: Orca is not running\)\. Repair: look at Orca workspace pr-190; when no agent runs in it, retry #190/)
  expect(w.prompts).toEqual([])
  expect(w.orca.created.length).toBe(1)
})

test('an owner that left while the checks reran goes to the model, not to Orca, when the agents then cannot be listed', async ($, on) => {
  const agents = [{ name: 'issue-176', status: 'idle' }]
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  // The checks rerun on the same head, and the owner leaves meanwhile.
  Object.assign(prs[0]!, { statusCheckRollup: [{ name: 'tests', status: 'IN_PROGRESS', conclusion: '' }] })
  agents.splice(0)
  w.clock.now = 60_000
  w.timer()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /issue-176 \(gone\)/ })) !== undefined)
  await ui.unmount()

  // The rerun fails while the agents cannot be listed: the owner last seen gone may be back, so no agent starts in Orca.
  w.listing.deny = 'peer listing is off'
  Object.assign(prs[0]!, { statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  w.clock.now = 2 * 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  w.clock.now = 31 * 60_000
  w.timer()
  await until(() => w.prompts.length === 1, () => w.orca.created)
  expect(w.prompts[0]).toMatch(/issue-176 has not pushed or answered for 30 minutes/)
  expect(w.orca.created).toEqual([])
  expect(w.orca.launched).toEqual([])
  await $.command.run(command('pause'))
})

test('an owner listed again after the hand-over to the model takes the pull request over, though it was asked in an earlier round', async ($, on) => {
  const agents = [{ name: 'issue-176', status: 'idle' }]
  const prs = [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  // The owner pushes and leaves while the checks run.
  Object.assign(prs[0]!, { headRefOid: 'head-182-2', statusCheckRollup: [{ name: 'tests', status: 'IN_PROGRESS', conclusion: '' }] })
  agents.splice(0)
  w.clock.now = 60_000
  w.timer()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /issue-176 \(gone\)/ })) !== undefined)
  await ui.unmount()

  // The checks fail while the agents cannot be listed: round 2 goes to the model.
  w.listing.deny = 'peer listing is off'
  Object.assign(prs[0]!, { statusCheckRollup: [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  w.clock.now = 2 * 60_000
  w.timer()
  await until(() => w.prompts.length === 1, () => w.sent)
  expect(w.prompts[0]).toMatch(/the agents could not be listed to find its owner/)

  // The list works again and shows the owner: it is asked for round 2.
  w.listing.deny = ''
  agents.push({ name: 'issue-176', status: 'idle' })
  w.clock.now = 3 * 60_000
  w.timer()
  await until(() => w.sent.length === 2, () => w.sent)
  expect(w.sent[1]).toEqual({ to: 'issue-176', text: expect.stringMatching(/PR #182 .* round 2 of 3/) })
  expect(w.orca.created).toEqual([])
  await $.command.run(command('pause'))
})

test('a message the model sends the owner after the hand-over does not stop the owner taking the pull request over', async ($, on) => {
  const agents: { name: string; status: string }[] = []
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], agents)
  w.listing.deny = 'peer listing is off'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.prompts.length === 1, () => w.sent)
  expect(w.prompts[0]).toMatch(/the agents could not be listed to find its owner/)

  // The model writes to the owner it expects.
  w.clock.now = 60_000
  await $.session.send({ origin: { kind: 'model' }, to: 'issue-176', text: 'PR #182: are you still working on it?' })

  // The list works again and shows the owner: it takes the pull request over, and the model is told to stop.
  w.listing.deny = ''
  agents.push({ name: 'issue-176', status: 'idle' })
  w.clock.now = 2 * 60_000
  w.timer()
  await until(() => w.sent.length === 2, () => ({ sent: w.sent, prompts: w.prompts }))
  expect(w.sent[1]).toEqual({ to: 'issue-176', text: expect.stringMatching(/PR #182 .* round 1 of 3/) })
  await until(() => w.prompts.length === 2, () => w.prompts)
  expect(w.prompts[1]).toMatch(/Stop work on pull request #182: its owning agent issue-176 has it now/)
  await $.command.run(command('pause'))
})

test('an agent the model writes to while the agents still cannot be listed does not take the pull request from the model', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [])
  w.listing.deny = 'peer listing is off'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.prompts.length === 1, () => w.sent)

  // The model asks another agent for help; no search found it, and the list still fails.
  w.clock.now = 60_000
  await $.session.send({ origin: { kind: 'model' }, to: 'helper', text: 'PR #182: can you look at the failing test?' })
  w.clock.now = 2 * 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.sent).toEqual([{ to: 'helper', text: 'PR #182: can you look at the failing test?' }])
  expect(w.prompts.length).toBe(1)
  await $.command.run(command('pause'))
})

test('when the model cannot be told to stop after a takeover, the log says so and names the repair', async ($, on) => {
  const agents: { name: string; status: string }[] = []
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], agents)
  w.listing.deny = 'peer listing is off'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.prompts.length === 1, () => w.sent)

  w.listing.deny = ''
  agents.push({ name: 'issue-176', status: 'idle' })
  w.fault.prompt = 'the prompt queue is closed'
  w.clock.now = 60_000
  w.timer()
  await until(() => w.sent.length === 1, () => w.sent)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 300 }, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /could not be told to stop/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /could not be told to stop/ }))?.text).toMatch(
    /#182: the model could not be told to stop: .*the prompt queue is closed.*Repair: tell this session's model to stop work on #182; issue-176 has it/)
  await ui.unmount()
  await $.command.run(command('pause'))
})

test('no agent starts in an Orca workspace the refresh could not read: a session at work in it could own the pull request', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [{ name: 'helper-9', status: 'busy' }])
  w.orca.worktrees.push(orcaWorktree('fix-190', '/orca/fix-190', 'neil/fix-190', { linkedPR: 190 }))
  w.registry.push(JSON.stringify({ pid: 4, name: 'helper-9', cwd: '/orca/fix-190' }))
  // The refresh's list times out at 60 s; a list given longer answers.
  w.orca.isListSlow = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => w.orca.launched.length > 0 || /#190 Change 190: blocked/.test(await status()))
  expect(w.orca.launched).toEqual([])
  expect(await status()).toMatch(
    /Orca could not start an agent \(no agent is named.*\): orca worktree list gave no answer: .*timed out after 60000 ms\..*No agent starts while a session in an Orca workspace could own it\. When Orca lists its workspaces again, retry #190/)
  expect(w.sent).toEqual([])
})

test('a session in a worktree nested inside the main checkout or inside a workspace of the pull request is not its owner', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [{ name: 'helper-1', status: 'idle' }, { name: 'nested-2', status: 'idle' }])
  // The main checkout is on the pull request's branch; worktrees of other work sit in it and in the workspace that holds the pull request.
  w.orca.worktrees.splice(0, 1, orcaWorktree('main', '/src/widgets', 'branch-190', { isMainWorktree: true }))
  w.orca.worktrees.push(
    orcaWorktree('fix-190', '/orca/fix-190', 'neil/fix-190', { linkedPR: 190 }),
    orcaWorktree('x', '/orca/fix-190/.codex/worktrees/x', 'neil/x'),
  )
  w.registry.push(
    JSON.stringify({ pid: 4, name: 'helper-1', cwd: '/src/widgets/.claude/worktrees/other' }),
    JSON.stringify({ pid: 5, name: 'nested-2', cwd: '/orca/fix-190/.codex/worktrees/x/apps' }),
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  await until(() => w.orca.launched.length === 1, () => w.sent)
  expect(w.orca.launched[0]).toContain('id:repo-1::/orca/fix-190')
  expect(w.sent).toEqual([])
  await $.command.run(command('pause'))
})

test('an Orca refusal blocks the pull request with Orca\'s own error, not the advice to start Orca', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.orca.refusal = 'A worktree named pr-190 already exists'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => /#190 Change 190: blocked/.test(await status()))
  expect(await status()).toMatch(/Orca could not start an agent \(no agent is named.*\): orca worktree create refused: name_taken: A worktree named pr-190 already exists/)
  expect(await status()).not.toMatch(/orca status/)
})

test('an Orca worktree list cut short is refused, so a workspace that holds the pull request is never missed', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.orca.isCut = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => /#190 Change 190: blocked/.test(await status()))
  expect(await status()).toMatch(
    /orca worktree list answered 1 of 999 worktrees, so one that holds the pull request could be missing\. Repair: archive the Orca workspaces you no longer need\. No agent starts while a session in an Orca workspace could own it\. When Orca lists its workspaces again, retry #190/)
  expect(w.orca.created).toEqual([])
})

test('a worktree create that gives no answer blocks the pull request and says where to look before a retry', async ($, on) => {
  const w = world(on, [pr(190, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.orca.isHung = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  const status = async () => JSON.stringify(await $.command.run(command('status')))
  await until(async () => /#190 Change 190: blocked/.test(await status()))
  // Setup hooks can run for minutes, so the create gets the longest wait a command can have.
  expect(w.orca.createTimeouts).toEqual([600_000])
  expect(await status()).toMatch(
    /orca worktree create gave no answer: .*timed out.*\. Orca may still start the agent in workspace pr-190\. Repair: look at Orca workspace pr-190; when no agent runs in it, retry #190/)
})

test('when Orca cannot be read, the commits of a pull request are searched once per head, not on every refresh', async ($, on) => {
  const prs = [pr(190, '2026-10-26T11:00:00Z', 'FAILURE'), pr(182, '2026-10-26T12:00:00Z', 'FAILURE', 'claude/issue-176')]
  const w = world(on, prs, [{ name: 'issue-176', status: 'idle' }])
  w.orca.error = 'Error: Orca is not running'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))

  // #190 is blocked and #182 asked: each step refreshed the queue, and #190's commits were read once.
  await until(() => w.sent.length === 1, () => w.prompts)
  expect(w.commitReads.count).toBe(1)
  await $.command.run(command('pause'))
})

test('an owner that replies blocked passes the pull request to the model, which can report it blocked', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1)

  w.clock.now = 60_000
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from-name="issue-176">blocked: PR #182 needs a product decision.</cross-session-message>' })
  await until(() => w.prompts.length === 1, () => w.prompts)
  expect(w.prompts[0]).toMatch(/# Fix pull request #182/)
  expect(w.prompts[0]).toMatch(/its owning agent issue-176 is blocked/)
  expect(w.prompts[0]).toMatch(/mcp__ndev__report/)

  const out = await $.tool.call({ tool: 'mcp__ndev__report', pr: 182, outcome: 'blocked', reason: 'needs a product decision' } as never)
  expect(JSON.stringify(out)).toMatch(/Recorded #182 as blocked/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /^Finished/ })) !== undefined)
  expect((await ui.find({ type: 'Text', text: /#182/ }))?.text).toMatch(/blocked\s+#182/)
  expect((await ui.find({ type: 'Text', text: /product decision · by/ }))?.text).toMatch(/needs a product decision · by this session/)
  expect(await ui.find({ type: 'Button', key: 'retry-182' })).toBeDefined()
  await ui.unmount()
  expect(w.merged).toEqual([])
  expect(w.orca.created).toEqual([])
})

test('a GitHub outage never pauses the loop: it backs off, retries and carries on', async ($, on) => {
  const w = world(on, [pr(182, '2026-10-26T11:00:00Z', 'FAILURE', 'claude/issue-176')], [{ name: 'issue-176', status: 'idle' }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  expect((await ui.find({ type: 'Text', text: /refused the merge/ }))?.text).toMatch(/refused the merge 3 times: gh\.sh pr-merge 190/)
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
  expect(w.reruns).toEqual(['gh.sh rerun-failed 77'])
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

test('budget: a session that did not start the loop makes no GitHub call, at its start or on the timer', async ($, on) => {
  const w = world(on, [pr(4, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.fault.checkEvery = ''
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  w.clock.now = 60 * 60_000
  w.timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(w.fault.ghCalls).toEqual([])
})

test('budget: a running loop reads GitHub every 15 minutes, and then only its current pull request', async ($, on) => {
  const prs = [pr(4, '2026-10-26T11:00:00Z', 'FAILURE'), pr(5, '2026-10-26T12:00:00Z', 'FAILURE'), pr(6, '2026-10-26T13:00:00Z', 'FAILURE')]
  const w = world(on, prs, [{ name: 'pr-4', status: 'idle' }])
  w.fault.checkEvery = ''
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('start'))
  await until(() => w.sent.length === 1, () => w.fault.ghCalls)
  await new Promise(resolve => setTimeout(resolve, 50))
  // The first read is one call for the whole queue, not one for each pull request.
  expect(w.fault.ghCalls.filter(c => c.startsWith('gh.sh pr-rows')).length).toBe(1)
  expect(w.fault.ghCalls.filter(c => c.startsWith('gh.sh pr-read') || c.startsWith('gh.sh commit-checks'))).toEqual([])

  w.fault.ghCalls.length = 0
  for (const minute of [1, 5, 14]) {
    w.clock.now = minute * 60_000
    w.timer()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(w.fault.ghCalls).toEqual([])

  w.clock.now = 16 * 60_000
  w.timer()
  await until(() => w.fault.ghCalls.length >= 2, () => w.fault.ghCalls)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(w.fault.ghCalls.map(c => c.split(' ').slice(1, 3).join(' '))).toEqual(['pr-read 4', 'commit-checks head-4-1'])
  await $.command.run(command('pause'))
})

test('budget: a person asking for the status reads at once, and a failed whole-queue read falls back to one read per pull request', async ($, on) => {
  const w = world(on, [pr(4, '2026-10-26T11:00:00Z', 'FAILURE')], [])
  w.fault.checkEvery = ''
  w.fault.rowsError = 'GraphQL: API rate limit exceeded'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('status'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await until(async () => (await ui.find({ type: 'Text', text: /#4/ })) !== undefined, () => w.fault.ghCalls)
  expect(w.fault.ghCalls.some(c => c.startsWith('gh.sh pr-read 4'))).toBe(true)
  await ui.unmount()
})
