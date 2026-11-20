import { expect, test } from 'claude-code/testing'

// /dev triage clean: code gathers a fact record for every open issue, in batches, before the model is asked anything,
// and mcp__ndev__clean_verdicts refuses an answer that leaves an issue without a verdict.
const TOOL = 'mcp__ndev__clean_verdicts'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

const result = (exitCode: number, stdout: string, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const ok = (stdout: string) => result(0, stdout)
const reply = (r: unknown) => ok(JSON.stringify({ id: 'x', ok: true, result: r }))

async function until(check: () => boolean, state?: () => unknown): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`the condition never held${state ? `: ${JSON.stringify(state())}` : ''}`)
}

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type Run$ = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
type Issue = { number: number; title: string; url: string }
const issue = (number: number, title = `Issue ${number} about area ${number}`): Issue => ({ number, title, url: `https://github.com/acme/widgets/issues/${number}` })
const pr = (number: number, state: string, mergedAt: string | null, changedFiles = 3) => ({ number, title: `PR ${number}`, state, mergedAt, changedFiles, headRefName: `b-${number}` })

// The GraphQL node of one issue, as GitHub answers it; extra overrides fields.
function node(i: Issue, extra: Record<string, unknown> = {}) {
  return {
    number: i.number, title: i.title, url: i.url, state: 'OPEN', body: `Body of #${i.number}`,
    labels: { nodes: [{ name: 'bug' }] }, comments: { nodes: [{ author: { login: 'neil' }, body: `A comment on #${i.number}`, createdAt: '2026-10-01T00:00:00Z' }] },
    subIssues: { nodes: [] }, parent: null, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] },
    ...extra,
  }
}

function world(on: On, issues: Issue[], nodes: Record<number, Record<string, unknown>> = {}) {
  const ran: string[][] = []
  // Set by a test to make the next GraphQL read fail as gh.sh does.
  const fail = { graphql: false, logCut: false }
  const prompts: string[] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/.neil-dev.json' }))
  on('fs.read', () => ({ value: JSON.stringify({ github: { repo: 'acme/widgets', board: null } }) }))
  on('clock.every', () => new Promise(() => {}))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'clean-session' }))
  on('session.cwd', () => ({ value: '/' }))
  const worktrees = [{ id: 'repo-1::/w/seven', projectId: 'github:acme/widgets', path: '/w/seven', branch: 'claude/issue-7', isArchived: false, isMainWorktree: false, linkedPR: null,
    linkedItems: [{ type: 'issue', number: 7, url: issue(7).url }] }]
  on('process.run', (_, e) => {
    const a = [...e.argv]
    const args = a.join(' ')
    ran.push(a)
    if (args.includes('gh.sh issue-search')) return ok(issues.map(i => `${JSON.stringify(i)}\n`).join(''))
    if (args.includes('gh.sh default-branch')) return ok(JSON.stringify({ default_branch: 'main' }))
    if (args.includes('gh.sh api graphql')) {
      if (fail.graphql) return result(1, '', 'GraphQL: Field \'closedByPullRequestsReferences\' doesn\'t exist on type \'Issue\'')
      const query = a.find(x => x.startsWith('query='))!
      const asked = [...query.matchAll(/i(\d+): issue\(number: (\d+)\)/g)].map(m => Number(m[2]))
      const repository = Object.fromEntries(asked.map(n => [`i${n}`, node(issues.find(i => i.number === n)!, nodes[n])]))
      return ok(JSON.stringify({ data: { repository } }))
    }
    // Every pull request of the repository, as gh.sh pr-search prints them: #60 merged and names #5 in its body, but closes nothing.
    if (args.includes('gh.sh pr-search')) {
      return ok([
        { number: 60, title: 'Tidy area five', state: 'closed', merged: true, merged_at: '2026-09-01T00:00:00Z', url: 'https://github.com/acme/widgets/pull/60', body: 'Touches #5 a little' },
        { number: 61, title: 'Unrelated', state: 'open', merged: false, merged_at: null, url: 'https://github.com/acme/widgets/pull/61', body: 'Mentions #50 only' },
      ].map(p => `${JSON.stringify(p)}\n`).join(''))
    }
    // The default branch's log: one commit names #6.
    if (a[0] === 'git' && a.includes('fetch')) return ok('')
    if (a[0] === 'git' && a.includes('log') && fail.logCut) return { value: { exitCode: 0, stdout: 'abc1234\x1fFix', stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }
    if (a[0] === 'git' && a.includes('log')) return ok(`abc1234\x1fFix the widget, closes #6\x1f\x1e\ndef5678\x1fOther work on #60\x1f\x1e\n`)
    if (a[0] === 'git' && a.includes('rev-list')) return ok('0\n')
    if (args.startsWith('orca worktree list')) return reply({ worktrees, totalCount: worktrees.length, truncated: false })
    return result(1, '', `unmocked: ${args}`)
  })
  return { ran, prompts, toasts, fail }
}

const command = (args: string) => ({ command: 'dev', args: `triage ${args}`.trim(), origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const)

async function started($: Run$) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
}

const call = ($: Run$, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result: string; isError?: boolean }>
const verdict = (n: number, v = 'needs_work', more: Record<string, unknown> = {}) => ({ issue: n, verdict: v, confidence: 'high', evidence: v === 'needs_work' ? 'nothing in the code does it yet' : '', ...more })

test('/dev triage clean gathers a fact record for every issue in batches, flags what code can tell, and sends the model the first chunk of records', async ($, on) => {
  const list = Array.from({ length: 25 }, (_, k) => issue(k + 1))
  // #1 and #2 have nearly the same title.
  list[0] = issue(1, 'Login button does nothing on the settings page')
  list[1] = issue(2, 'Login button does nothing on settings page')
  const w = world(on, list, {
    3: { closedByPullRequestsReferences: { nodes: [pr(50, 'MERGED', '2026-08-01T00:00:00Z')] } },
    4: { subIssues: { nodes: [{ number: 20, title: 'Sub 20', state: 'CLOSED' }, { number: 21, title: 'Sub 21', state: 'CLOSED' }] } },
    8: { closedByPullRequestsReferences: { nodes: [pr(70, 'OPEN', null, 0)] } },
  })
  await started($)
  await $.command.run(command('clean'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-2), w.toasts])
  // One GraphQL query per 20 issues, one pull request list and one git log for the whole repository.
  const graphql = w.ran.filter(a => a.join(' ').includes('gh.sh api graphql'))
  expect(graphql.length).toBe(2)
  expect(w.ran.filter(a => a.join(' ').includes('gh.sh pr-search')).length).toBe(1)
  expect(w.ran.filter(a => a[0] === 'git' && a.includes('log')).length).toBe(1)
  // The log is of the default branch as GitHub has it now: fetched first, so a commit merged since the last fetch counts.
  const at = (word: string) => w.ran.findIndex(a => a[0] === 'git' && a.includes(word))
  expect(w.ran[at('fetch')]!.join(' ')).toMatch(/fetch origin main/)
  expect(at('fetch')).toBeLessThan(at('log'))
  expect(w.ran.filter(a => a.join(' ').includes('gh issue view')).length).toBe(0)
  const p = w.prompts[0]!
  // The first chunk carries the full record of each of its issues, and no issue of a later chunk.
  expect(p).toMatch(/chunk 1 of 3/i)
  for (let n = 1; n <= 10; n++) expect(p).toMatch(new RegExp(`### #${n} `))
  expect(p).not.toMatch(/### #11 /)
  expect(p).toMatch(/Body of #1\b/)
  expect(p).toMatch(/A comment on #2\b/)
  expect(p).toMatch(/labels: bug/)
  // What code can tell, it flags.
  expect(p).toMatch(/#3 [^]*closed by merged PR #50/)
  expect(p).toMatch(/every sub-issue is closed: #20, #21/)
  expect(p).toMatch(/merged PR #60 names #5 but does not close it/)
  expect(p).toMatch(/commits naming #6: abc1234 Fix the widget, closes #6/)
  expect(p).toMatch(/open PR #70 has no changed files/)
  expect(p).toMatch(/workspace \/w\/seven \(branch claude\/issue-7\): 0 commits ahead of main, no PR/)
  expect(p).toMatch(/the workspace has no commits and no PR/)
  expect(p).toMatch(/title near #2 "Login button does nothing on settings page": a possible duplicate/)
  expect(p).not.toMatch(/title near #4/)
  expect(p).toMatch(new RegExp(TOOL))
  // The asking and the closing come only after the tool accepts every verdict.
  expect(p).not.toMatch(/gh issue close/)
})

test('clean_verdicts refuses a chunk with a missing issue, an issue not in the chunk and a close verdict with no evidence, then hands the next chunk, and the end report comes from the recorded verdicts', async ($, on) => {
  const list = Array.from({ length: 12 }, (_, k) => issue(k + 1))
  const w = world(on, list)
  await started($)
  await $.command.run(command('clean'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-2), w.toasts])
  const first = Array.from({ length: 10 }, (_, k) => k + 1)
  // #10 has no verdict, #11 is in the next chunk, #2 is done with no evidence, #3 is a duplicate of nothing, and #4 has a verdict that does not exist.
  const bad = await call($, { verdicts: [
    ...first.filter(n => n !== 10 && n > 4).map(n => verdict(n)), verdict(1), verdict(11),
    verdict(2, 'done', { evidence: 'looks finished' }), verdict(3, 'duplicate', { evidence: 'same as #9' }), verdict(4, 'maybe'),
  ] })
  expect(bad.isError).toBe(true)
  expect(bad.result).toMatch(/#10 has no verdict/)
  expect(bad.result).toMatch(/#11 is not in chunk 1/)
  expect(bad.result).toMatch(/#2 is done but its evidence names no PR number, commit sha or file:line/)
  expect(bad.result).toMatch(/#3 is duplicate but gives no by/)
  expect(bad.result).toMatch(/#4: "maybe" is not a verdict/)
  // The first chunk is accepted, and the answer carries the next chunk's records.
  const one = await call($, { verdicts: [
    ...first.filter(n => n > 3).map(n => verdict(n)), verdict(1),
    verdict(2, 'done', { evidence: 'fixed by PR #50' }), verdict(3, 'duplicate', { evidence: 'same ask as #9', by: 9 }),
  ] })
  expect(one.isError).toBeUndefined()
  expect(one.result).toMatch(/chunk 2 of 2/i)
  expect(one.result).toMatch(/### #11 /)
  expect(one.result).toMatch(/### #12 /)
  // Closing before every issue has a verdict is refused.
  const early = await call($, { closed: [2] })
  expect(early.isError).toBe(true)
  expect(early.result).toMatch(/#11, #12 have no verdict yet/)
  const two = await call($, { verdicts: [verdict(11, 'outdated', { evidence: 'hooks/old.ts:12 is gone', confidence: 'medium' }), verdict(12)] })
  expect(two.isError).toBeUndefined()
  // Every issue has a verdict: only now does the answer ask for the human's pick and the closes, and it lists only the close verdicts.
  expect(two.result).toMatch(/AskUserQuestion/)
  expect(two.result).toMatch(/#2 done: fixed by PR #50/)
  expect(two.result).toMatch(/#3 duplicate of #9/)
  expect(two.result).toMatch(/#11 outdated/)
  expect(two.result).toMatch(/gh issue close <n> --repo acme\/widgets/)
  expect(two.result).not.toMatch(/#12 needs_work/)
  // The end report: an issue named twice, or a number that is not an issue, is refused.
  const wrong = await call($, { closed: [2, 2, 'x'], failed: [{ issue: 2, error: 'HTTP 500' }] })
  expect(wrong.isError).toBe(true)
  expect(wrong.result).toMatch(/#2 is named twice/)
  expect(wrong.result).toMatch(/closed names "x", which is not an issue number/)
  // A close that should not have happened (#12 needs work, #99 is not in this clean) is still reported, with the repair, never hidden.
  const end = await call($, { closed: [2, 11, 12, 99], failed: [{ issue: 3, error: 'HTTP 403' }] })
  expect(end.isError).toBeUndefined()
  expect(end.result).toMatch(/Closed 4 of 12 issues: #2 \(done\), #11 \(outdated\), #12 \(needs_work\), #99 \(not in this clean\)/)
  expect(end.result).toMatch(/Closed with no close verdict, so check them: #12 \(needs_work\), #99 \(not in this clean\)\. To undo: `gh issue reopen <n> --repo acme\/widgets`/)
  expect(end.result).toMatch(/Failed to close 1: #3: HTTP 403/)
  expect(end.result).toMatch(/8 judged needs work and left open: #1, #4, #5, #6, #7, #8, #9, #10\./)
})

test('a clean that fails ends the clean before it: the tool takes no more verdicts, and the failure names the GraphQL batch', async ($, on) => {
  const list = Array.from({ length: 3 }, (_, k) => issue(k + 1))
  const w = world(on, list)
  await started($)
  await $.command.run(command('clean'))
  await until(() => w.prompts.length > 0, () => [w.ran.slice(-2), w.toasts])
  w.fail.graphql = true
  await $.command.run(command('clean'))
  await until(() => w.toasts.some(t => /GraphQL/.test(t)), () => [w.ran.slice(-2), w.toasts])
  expect(w.toasts.join('\n')).toMatch(/the GraphQL read of #1–#3 of acme\/widgets failed: gh.sh api graphql exited 1: GraphQL: Field/)
  const late = await call($, { verdicts: [verdict(1), verdict(2), verdict(3)] })
  expect(late.isError).toBe(true)
  expect(late.result).toMatch(/no \/dev triage clean is waiting/)
  // A git log the engine cut short would drop commits, so the clean stops and says so rather than judge from it.
  w.fail.graphql = false
  w.fail.logCut = true
  await $.command.run(command('clean'))
  await until(() => w.toasts.some(t => /more than the engine keeps/.test(t)), () => [w.ran.slice(-2), w.toasts])
  const requests = w.prompts.filter(text => text.startsWith('Clean: judge'))
  const notices = w.prompts.filter(text => text.startsWith('Triage notice:'))
  expect(requests).toHaveLength(1)
  expect(notices).toHaveLength(3)
  expect(notices[0]).toContain('a fact record for each of 3 issues sent to the model')
  expect(notices[1]).toContain('the GraphQL read of #1–#3 of acme/widgets failed')
  expect(notices[2]).toContain('printed more than the engine keeps')
  expect(w.prompts).toHaveLength(requests.length + notices.length)
})
