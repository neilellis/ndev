import { expect, test } from 'claude-code/testing'

import { EPIC_STATES, addedMigrations, epicLineOf, epicStep, frontier, implementerBrief, nextEpicState, reviewerBrief, shellQuote, sliceProblems, unlistedMigrations, workerStartCommand } from '../hooks/workflow/epic'
import type { Epic, SubIssue } from '../hooks/workflow/epic'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]

const ROOT = '/proj'
const REPO = 'acme/w'
const SHA = 'aaaaaaaa11111111'
const EPIC_FILE = (n: number) => `${ROOT}/.neil-dev.epic-${n}.json`
const ok = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

const sub = (issue: number, over: Partial<SubIssue> = {}): SubIssue => ({ issue, key: `k${issue}`, title: `Part ${issue}`, blockedBy: [], state: 'waiting', rounds: 0, ...over })
const epicOf = (over: Partial<Epic> = {}): Epic => ({
  epic: 40, repo: REPO, root: ROOT, title: 'Big change', state: 'framing', evidence: {}, parallel: 4,
  roles: { implementer: { agent: 'claude' }, reviewer: { agent: 'codex' } }, issues: {}, history: [], ...over,
})
const withIssues = (...subs: SubIssue[]) => Object.fromEntries(subs.map(s => [String(s.issue), s]))

// ---- pure logic ----

test('the epic phases go in one order, and done has no next phase', () => {
  expect(EPIC_STATES).toEqual(['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing', 'coordinating', 'closing', 'done'])
  expect(nextEpicState('framing')).toBe('researching')
  expect(nextEpicState('spec-review')).toBe('slicing')
  expect(nextEpicState('closing')).toBe('done')
  expect(nextEpicState('done')).toBeUndefined()
})

test('slicing refuses an empty list, an unknown blocker, a duplicate and a cycle', () => {
  expect(sliceProblems([])).toContain('empty')
  expect(sliceProblems([{ issue: 1, key: 'a', title: 'A', blockedBy: [9] }])).toContain('#9')
  expect(sliceProblems([{ issue: 1, key: 'a', title: 'A', blockedBy: [] }, { issue: 1, key: 'b', title: 'B', blockedBy: [] }])).toContain('#1 twice')
  const cycle = sliceProblems([{ issue: 1, key: 'a', title: 'A', blockedBy: [2] }, { issue: 2, key: 'b', title: 'B', blockedBy: [3] }, { issue: 3, key: 'c', title: 'C', blockedBy: [1] }])
  expect(cycle).toContain('cycle')
  expect(cycle).toMatch(/#1.*#2.*#3/)
  expect(sliceProblems([{ issue: 1, key: 'a', title: 'A', blockedBy: [1] }])).toContain('cycle')
  expect(sliceProblems([{ issue: 1, key: 'a', title: 'A', blockedBy: [] }, { issue: 2, key: 'b', title: 'B', blockedBy: [1] }])).toBeUndefined()
})

test('the frontier is the waiting issues with every blocker merged, in number order, cut to the free places', () => {
  const epic = epicOf({
    state: 'coordinating', parallel: 2,
    issues: withIssues(sub(5), sub(3), sub(4, { blockedBy: [3] }), sub(6, { state: 'implementing' }), sub(8, { blockedBy: [7] }), sub(7, { state: 'merged' }), sub(9, { state: 'blocked', note: 'needs a key' })),
  })
  const f = frontier(epic)
  expect(f.ready.map(s => s.issue)).toEqual([3])
  expect(f.held.map(s => s.issue)).toEqual([5, 8])
  expect(f.inFlight.map(s => s.issue)).toEqual([6])
  expect(f.waitingOn).toEqual([{ issue: 4, open: [3] }])
  expect(f.blocked.map(s => s.issue)).toEqual([9])
  // With no place free, nothing is ready.
  expect(frontier({ ...epic, parallel: 1 }).ready).toEqual([])
})

test('a verified issue holds its place, and a merged one frees it', () => {
  const epic = epicOf({ state: 'coordinating', parallel: 1, issues: withIssues(sub(1, { state: 'verified' }), sub(2)) })
  expect(frontier(epic).ready).toEqual([])
  epic.issues['1']!.state = 'merged'
  expect(frontier(epic).ready.map(s => s.issue)).toEqual([2])
})

test('the next step names the plan skill up to slicing, and the coordinate skill after', () => {
  for (const state of ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing'] as const) expect(epicStep(epicOf({ state }))).toContain('ndev:epic-plan')
  for (const state of ['coordinating', 'closing'] as const) expect(epicStep(epicOf({ state }))).toContain('ndev:epic-coordinate')
  expect(epicStep(epicOf({ state: 'framing' }))).toContain('mcp__ndev__epicPhase')
})

test('the system line names the epic, its root, its state, the role and the next step', () => {
  expect(epicLineOf(epicOf({ state: 'slicing' }))).toBe(`Epic: #40 "Big change" in ${ROOT} is in the state "slicing". You are the coordinator: you plan, decide, verify and merge; workers implement and review. Next: ${epicStep(epicOf({ state: 'slicing' }))}`)
})

const DIFF = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+create table t ();\n`
const CHANGED = 'diff --git a/supabase/migrations/1_old.sql b/supabase/migrations/1_old.sql\nindex 1..2 100644\n--- a/supabase/migrations/1_old.sql\n+++ b/supabase/migrations/1_old.sql\n@@ -1 +1 @@\n-a\n+b\n'
const SECTIONED = (path: string) => `Closes #5\n\n<!-- ndev:migrations -->\n## Migrations to run after merge\n\n- \`${path}\`\n<!-- /ndev:migrations -->\n`

test('the migration check names each added migration that the PR body does not list, and passes a listed one', () => {
  const path = 'supabase/migrations/20261112000000_add_t.sql'
  expect(addedMigrations(DIFF(path) + DIFF('src/a.ts') + CHANGED)).toEqual([path])
  expect(unlistedMigrations(DIFF(path), 'Closes #5')).toEqual([path])
  // A path named outside the section does not count.
  expect(unlistedMigrations(DIFF(path), `Closes #5\n\n- \`${path}\``)).toEqual([path])
  expect(unlistedMigrations(DIFF(path), SECTIONED(path))).toEqual([])
  expect(unlistedMigrations(DIFF('src/a.ts'), '')).toEqual([])
})

test('the implementer brief carries the epic, the sub-issue, the spec and the rules', () => {
  const epic = epicOf({ state: 'coordinating', aim: 'Make the thing.', issues: withIssues(sub(5)) })
  const text = implementerBrief(epic, epic.issues['5']!, [`${ROOT}/docs/spec.md`])
  for (const part of ['#40', 'Make the thing.', '#5', 'Part 5', `https://github.com/${REPO}/issues/5`, `${ROOT}/docs/spec.md`, 'mcp__ndev__started', 'test first', 'mcp__ndev__addMigration', 'orca orchestration ask', 'worker_done', 'Do not merge']) expect(text).toContain(part)
})

test('the reviewer brief is read-only, names the PR, the severities and the verdicts', () => {
  const epic = epicOf({ state: 'coordinating', issues: withIssues(sub(5, { state: 'reviewing', pr: 12 })) })
  const text = reviewerBrief(epic, epic.issues['5']!, [`${ROOT}/docs/spec.md`])
  for (const part of ['read-only', 'PR #12', 'Critical', 'Important', 'Minor', 'APPROVE', 'CHANGES NEEDED', 'worker_done', 'file:line', `${ROOT}/docs/spec.md`]) expect(text).toContain(part)
})

// ---- the tools and /flow epic, through a fake engine ----
// Each tool test starts a session, which takes seconds on a busy machine, so each has a 30 s limit.

type Opts = { workflowOpen?: boolean }
// A fake engine: a linked worktree at /proj, a simulated git and a simulated GitHub. Only the process
// and file boundaries are fake: the plugin's tools and commands really run.
const engine = (on: On, opts: Opts = {}) => {
  const usual = { rev: 1, issue: 7, root: ROOT, repo: REPO, base: 'main', branch: 'issue-7', prs: [12], state: 'developing', evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], owner: { session: 's1', at: 0 }, baseCheck: { sha: SHA, script: 'pre-commit-check.sh', exitCode: 0, at: 0 } }
  const files = new Map<string, string>(Object.entries({
    [`${ROOT}/.ndev-inited`]: '',
    [`${ROOT}/.neil-dev.json`]: JSON.stringify({ github: { repo: REPO, board: null }, mode: 'light', steering: 'auto' }),
    ...(opts.workflowOpen ? { [`${ROOT}/.neil-dev.worktree.json`]: JSON.stringify({ version: 2, resources: {}, workflows: { 7: usual }, prs: {} }) } : {}),
    [`${ROOT}/docs/research.md`]: 'notes',
    [`${ROOT}/docs/spec.md`]: 'spec',
    [`${ROOT}/docs/review.md`]: 'review',
  }))
  const s = {
    now: 1_000, issues: {} as Record<number, { state: string; title: string } | string>,
    prs: {} as Record<number, Record<string, unknown>>, checks: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [] } as unknown,
    diff: '', ignored: true, exclude: [] as string[],
    servers: [{ id: 'aa11-x', name: 'vm-a' }, { id: 'bb22-y', name: 'dev-build VM 5e6f' }] as { id: string; name: string }[], orcaFails: '',
  }
  const gh: string[] = []
  const prompts: string[] = []
  const pendingAfters: (() => void)[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__ndev__${e.name}` } }))
  on('clock.now', () => ({ value: s.now }))
  on('clock.every', () => new Promise(() => undefined))
  on('clock.after', () => new Promise(resolve => { pendingAfters.push(() => resolve({ value: undefined })) }))
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: ROOT }) as never)
  on('session.usage', () => ({ value: { startedAt: s.now } }) as never)
  on('turn.complete', () => ({ text: 'text' }) as never)
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('agent.list', () => ({ value: [] }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/neil' : undefined }) as never)
  const isFolder = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') || files.has(e.path) || isFolder(e.path) }))
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 0, isLink: false })) }) as never)
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.log', () => ({ value: undefined }) as never)
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } as never })
  on('process.run', (_, e) => {
    const a = e.argv.map(String)
    const line = a.join(' ')
    if (a[0] === 'git') {
      if (line.includes('--path-format=absolute')) return ok(`${ROOT}/.git/worktrees/x\n/main/.git\n`)
      if (line.includes('--show-toplevel')) return ok(`${ROOT}\n`)
      if (a[1] === 'check-ignore') return ok('', s.ignored ? 0 : 1)
      if (a[1] === 'ls-files') return ok('')
      if (a[1] === 'worktree') return ok(`worktree ${ROOT}\n`)
      if (a[1] === 'remote') return ok(`git@github.com:${REPO}.git\n`)
      if (line.includes('--abbrev-ref')) return ok('issue-7\n')
      if (a[1] === 'rev-parse') return ok(`${SHA}\n`)
      return ok('', 1, `git not faked: ${line}`)
    }
    if (a[0] === 'bash' && a[1]?.endsWith('gh.sh')) {
      gh.push(a.slice(2).join(' '))
      const n = Number(a[3])
      if (a[2] === 'issue-new') return ok('{"number":40}\n')
      if (a[2] === 'issue-read') {
        const answer = s.issues[n] ?? { state: 'open', title: `Issue ${n}` }
        return typeof answer === 'string' ? ok('', 1, answer) : ok(JSON.stringify({ number: n, body: '', url: '', ...answer }))
      }
      if (a[2] === 'pr-read') return ok(JSON.stringify({ number: n, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', body: 'Closes #5', created_at: '2026-11-01T00:00:00Z', head: { sha: SHA, ref: 'issue-5' }, ...s.prs[n] }))
      if (a[2] === 'commit-checks') return ok(JSON.stringify(s.checks))
      if (a[2] === 'pr-diff') return s.diff === '__fail__' ? ok('', 1, 'HTTP 502: Bad Gateway') : ok(s.diff)
      if (a[2] === 'default-branch') return ok('{"default_branch":"main"}')
      return ok('', 1, `gh.sh not faked: ${line}`)
    }
    if (a[0] === 'mkdir') return ok()
    if (a.slice(0, 3).join(' ') === 'orca environment list') return s.orcaFails ? ok('', 1, s.orcaFails) : ok(JSON.stringify({ id: 'x', ok: true, result: { environments: s.servers } }))
    if (a[0] === 'node') return ok(JSON.stringify({ file: null, copiedFrom: null, root: ROOT, main: ROOT, ignored: true, keys: [], missing: [] }))
    return ok('', 1, `not faked: ${line}`)
  })
  const epic = (n = 40) => (files.has(EPIC_FILE(n)) ? (JSON.parse(files.get(EPIC_FILE(n))!) as Epic) : undefined)
  const fire = () => pendingAfters.splice(0).forEach(go => go())
  return { s, files, gh, prompts, epic, fire }
}
type W = ReturnType<typeof engine>

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const start = async ($: Dollar) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  await settle()
}
const tool = async ($: Dollar, name: string, args: Record<string, unknown> = {}) => {
  const r = await $.tool.call({ tool: `mcp__ndev__${name}`, ...args } as never) as { result: string; isError?: boolean }
  return { text: String(r.result), isError: !!r.isError }
}
const command = async ($: Dollar, w: W, args: string) => {
  const out = String(((await $.command.run({ command: 'flow', args } as never)) as { text: string }).text)
  w.fire()
  await settle()
  return out
}
const sections = async ($: Dollar) => {
  const { sections: all } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  const find = (id: string) => all.find((x: { id: string }) => x.id === id)?.text as string | undefined
  return { epic: find('ndev:epic'), workflow: find('ndev:workflow') }
}

const SLICES = [
  { issue: 41, key: 'schema', title: 'Schema', blockedBy: [] },
  { issue: 42, key: 'api', title: 'API', blockedBy: [41] },
  { issue: 43, key: 'docs', title: 'Docs', blockedBy: [] },
]

// Runs the planning phases with good arguments, up to coordinating.
const planned = async ($: Dollar) => {
  expect((await tool($, 'epicStarted', { issue: 40 })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'Make the thing.', evidence: 'framed with the human' })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'read the code', files: ['docs/research.md'] })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'specifying', evidence: 'wrote it', files: [`${ROOT}/docs/spec.md`] })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'deciding', evidence: 'all settled, none open' })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'each finding ruled', files: ['docs/review.md'] })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'three parts', issues: SLICES })).isError).toBe(false)
}

test('epicStarted files the epic issue from a title, binds the session and turns the usual workflow off', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await tool($, 'epicStarted', { title: 'Big change', shortName: 'big-change' })
  expect(r.isError).toBe(false)
  expect(w.gh.some(c => c.startsWith('issue-new --title Big change'))).toBe(true)
  expect(r.text).toContain('#40')
  expect(r.text).toContain('"framing"')
  expect(r.text).toContain('ndev:epic-plan')
  expect(w.epic()?.state).toBe('framing')
  expect(w.epic()?.parallel).toBe(4)
  expect(w.epic()?.roles).toEqual({ implementer: { agent: 'claude' }, reviewer: { agent: 'codex' } })
  const refused = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('without the workflow')
  const line = await sections($)
  expect(line.epic).toContain('Epic: #40 "Big change"')
  expect(line.epic).toContain('You are the coordinator')
  expect(line.workflow).toBeUndefined()
})

test('epicStarted with an issue reads its title from GitHub and keeps the roles and cap it is given', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  w.s.issues[40] = { state: 'open', title: 'From GitHub' }
  await start($)
  const r = await tool($, 'epicStarted', { issue: 40, parallel: 2, implementer: { agent: 'codex', model: 'gpt-5' }, reviewer: 'claude' })
  expect(r.isError).toBe(false)
  expect(w.epic()?.title).toBe('From GitHub')
  expect(w.epic()?.parallel).toBe(2)
  expect(w.epic()?.roles).toEqual({ implementer: { agent: 'codex', model: 'gpt-5' }, reviewer: { agent: 'claude' } })
})

test('epicStarted refuses with no issue and no title, and a closed epic issue', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  w.s.issues[40] = { state: 'closed', title: 'Done before' }
  await start($)
  const bare = await tool($, 'epicStarted', {})
  expect(bare.isError).toBe(true)
  expect(bare.text).toContain('title')
  const closed = await tool($, 'epicStarted', { issue: 40 })
  expect(closed.isError).toBe(true)
  expect(closed.text).toContain('closed')
  expect(w.epic()).toBeUndefined()
})

test('epicStarted refuses while a usual workflow of this session is open, and changes nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on, { workflowOpen: true })
  await start($)
  const r = await tool($, 'epicStarted', { issue: 40 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#7')
  expect(r.text).toContain('/flow off')
  expect(w.epic()).toBeUndefined()
  expect((await sections($)).workflow).toContain('Workflow:')
})

test('a resume by another live session needs takeOver', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  w.files.set(EPIC_FILE(40), JSON.stringify(epicOf({ owner: { session: 'other', at: 900 } })))
  const r = await tool($, 'epicStarted', { issue: 40 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('takeOver')
  expect(w.epic()?.owner?.session).toBe('other')
  const taken = await tool($, 'epicStarted', { issue: 40, takeOver: true })
  expect(taken.isError).toBe(false)
  expect(w.epic()?.owner?.session).toBe('s1')
})

test('a helper agent cannot call the epic tools', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  for (const name of ['epicStarted', 'epicPhase', 'epicNext', 'epicBrief', 'epicIssue', 'epicStatus']) {
    const r = await tool($, name, { issue: 40, agentId: 'helper-1' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('only the main agent')
  }
  expect(w.epic()).toBeUndefined()
})

test('epicPhase moves only from the current phase, and each phase refuses what it lacks', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const wrong = await tool($, 'epicPhase', { issue: 40, finished: 'specifying', evidence: 'x', files: ['docs/spec.md'] })
  expect(wrong.isError).toBe(true)
  expect(wrong.text).toContain('"framing"')
  const noAim = await tool($, 'epicPhase', { issue: 40, finished: 'framing', evidence: 'x' })
  expect(noAim.isError).toBe(true)
  expect(noAim.text).toContain('aim')
  const noEvidence = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.' })
  expect(noEvidence.isError).toBe(true)
  expect(noEvidence.text).toContain('evidence')
  expect(w.epic()?.state).toBe('framing')
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x' })).text).toContain('"researching"')
  const missing = await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'x', files: ['docs/nowhere.md'] })
  expect(missing.isError).toBe(true)
  expect(missing.text).toContain(`${ROOT}/docs/nowhere.md`)
  const none = await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'x' })
  expect(none.isError).toBe(true)
  expect(none.text).toContain('files')
  await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'x', files: ['docs/research.md'] })
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'specifying', evidence: 'x' })).isError).toBe(true)
  await tool($, 'epicPhase', { issue: 40, finished: 'specifying', evidence: 'x', files: ['docs/spec.md'] })
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'deciding', evidence: '' })).isError).toBe(true)
  await tool($, 'epicPhase', { issue: 40, finished: 'deciding', evidence: 'settled' })
  const noReview = await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled' })
  expect(noReview.isError).toBe(true)
  expect(noReview.text).toContain('review')
  await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'] })
  expect(w.epic()?.state).toBe('slicing')
  expect(w.epic()?.evidence.specifying?.files).toEqual([`${ROOT}/docs/spec.md`])
  expect(w.epic()?.history.map(h => h.to)).toEqual(['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing'])
})

test('slicing refuses a cycle, an unknown blocker, and a closed or unreadable issue by number', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'slicing' }))
  const empty = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', issues: [] })
  expect(empty.isError).toBe(true)
  const cycle = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', issues: [{ issue: 41, key: 'a', title: 'A', blockedBy: [42] }, { issue: 42, key: 'b', title: 'B', blockedBy: [41] }] })
  expect(cycle.isError).toBe(true)
  expect(cycle.text).toContain('cycle')
  const unknown = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', issues: [{ issue: 41, key: 'a', title: 'A', blockedBy: [99] }] })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('#99')
  // The shape checks come before any read of a sub-issue on GitHub.
  expect(w.gh.filter(c => /^issue-read (41|42|99)\b/.test(c))).toEqual([])
  w.s.issues[42] = { state: 'closed', title: 'B' }
  w.s.issues[43] = 'HTTP 404: Not Found'
  const closed = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', issues: SLICES })
  expect(closed.isError).toBe(true)
  expect(closed.text).toContain('#42 is closed')
  expect(closed.text).toContain('#43')
  expect(closed.text).toContain('404')
  expect(w.epic()?.state).toBe('slicing')
  expect(w.epic()?.issues).toEqual({})
})

test('the planning phases end in coordinating, with each sub-issue waiting', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  expect(w.epic()?.state).toBe('coordinating')
  expect(Object.values(w.epic()!.issues).map(i => [i.issue, i.state, i.blockedBy])).toEqual([[41, 'waiting', []], [42, 'waiting', [41]], [43, 'waiting', []]])
  expect((await sections($)).epic).toContain('ndev:epic-coordinate')
})

test('epicNext lists the frontier, what is in flight and what waits, and changes nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const before = w.files.get(EPIC_FILE(40))
  const r = await tool($, 'epicNext', { issue: 40 })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/Ready[^\n]*#41[^\n]*#43/)
  expect(r.text).toMatch(/#42[^\n]*#41/)
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
})

test('each sub-issue move is checked, and each refusal changes nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const offFrontier = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'implementing', worker: 'd1' })
  expect(offFrontier.isError).toBe(true)
  expect(offFrontier.text).toContain('#41')
  const noWorker = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing' })
  expect(noWorker.isError).toBe(true)
  expect(noWorker.text).toContain('worker')
  const skip = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified' })
  expect(skip.isError).toBe(true)
  expect(skip.text).toContain('"waiting"')
  const unknown = await tool($, 'epicIssue', { issue: 40, sub: 99, state: 'implementing', worker: 'd1' })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('#99')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })).isError).toBe(false)
  expect(w.epic()?.issues['41']).toMatchObject({ state: 'implementing', implementer: 'd1' })
  const noPr = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', worker: 'r1' })
  expect(noPr.isError).toBe(true)
  expect(noPr.text).toContain('pr')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })).isError).toBe(false)
  expect(w.epic()?.issues['41']).toMatchObject({ state: 'reviewing', pr: 12, reviewer: 'r1' })
  const noNote = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'fixing', verdict: 'changes' })
  expect(noNote.isError).toBe(true)
  expect(noNote.text).toContain('note')
  const approve = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'fixing', verdict: 'approve', note: 'x' })
  expect(approve.isError).toBe(true)
  for (let round = 1; round <= 3; round++) {
    const fix = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'fixing', verdict: 'changes', note: `round ${round}: fix the test` })
    expect(fix.isError).toBe(false)
    expect(w.epic()?.issues['41']?.rounds).toBe(round)
    if (round < 3) expect(fix.text).not.toContain('Stop and decide')
    else expect(fix.text).toContain('Stop and decide')
    expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', worker: `r${round + 1}` })).isError).toBe(false)
  }
  expect(w.epic()?.issues['41']?.reviewer).toBe('r4')
  const noBlockNote = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'blocked' })
  expect(noBlockNote.isError).toBe(true)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'blocked', note: 'needs a key from the human' })).isError).toBe(false)
  const wrongBack = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing', worker: 'd3' })
  expect(wrongBack.isError).toBe(true)
  expect(wrongBack.text).toContain('"waiting"')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'waiting' })).isError).toBe(false)
  expect(w.epic()?.issues['43']?.state).toBe('waiting')
})

test('the parallel cap refuses a start when every place is taken', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40, parallel: 1 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'coordinating', issues: withIssues(sub(41, { state: 'implementing', implementer: 'd1' }), sub(43)) }))
  const r = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing', worker: 'd3' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('parallel')
  expect(r.text).toContain('#41')
})

const reviewing = async ($: Dollar, w: W) => {
  await planned($)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
}

test('verify refuses an added migration that the PR body does not list, and passes one it lists', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  const path = 'supabase/migrations/20261112000000_add_t.sql'
  w.s.diff = DIFF(path)
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(path)
  expect(r.text).toContain('mcp__ndev__addMigration')
  expect(r.text).toMatch(/Passed:[^\n]*checks/)
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
  w.s.prs[12] = { body: SECTIONED(path) }
  const passed = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(passed.isError).toBe(false)
  expect(passed.text).toMatch(/Passed:[^\n]*migrations/)
  expect(w.epic()?.issues['41']?.state).toBe('verified')
})

test('verify refuses a draft, a pending or red check and a PR that is not mergeable, and names each', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  w.s.prs[12] = { draft: true, mergeable: false }
  w.s.checks = { check_runs: [{ name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'e2e', status: 'in_progress', conclusion: null }], statuses: [] }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  for (const part of ['draft', 'lint (failure)', 'e2e', 'mergeable']) expect(r.text).toContain(part)
  const unread = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'changes' })
  expect(unread.isError).toBe(true)
  expect(unread.text).toContain('note')
})

test('verify reports a diff it cannot read as not run, and refuses', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  w.s.diff = '__fail__'
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/Not run:[^\n]*migrations/)
})

test('merged needs GitHub to say so, and answers with the new frontier', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  const early = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('PR #12')
  w.s.prs[12] = { state: 'closed', merged: true }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/Ready[^\n]*#42/)
})

test('coordinating refuses to close with an issue not merged, and closing turns the usual workflow back on', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const early = await tool($, 'epicPhase', { issue: 40, finished: 'coordinating', evidence: 'x' })
  expect(early.isError).toBe(true)
  expect(early.text).toMatch(/#41.*#42.*#43/)
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), issues: withIssues(sub(41, { state: 'merged' }), sub(42, { state: 'merged' }), sub(43, { state: 'merged' })) }))
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'coordinating', evidence: 'all merged' })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'closing', evidence: '' })).isError).toBe(true)
  const done = await tool($, 'epicPhase', { issue: 40, finished: 'closing', evidence: 'ran it end to end; nothing remains' })
  expect(done.isError).toBe(false)
  expect(w.epic()?.state).toBe('done')
  const line = await sections($)
  expect(line.epic).toBeUndefined()
  expect(line.workflow).toContain('Workflow:')
})

test('epicBrief writes the brief in the git dir, out of the worktree, and a reviewer brief needs the PR', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const r = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(r.isError).toBe(false)
  const path = /(\/\S+\.md)/.exec(r.text)?.[1]
  expect(path).toBe(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-implementer.md`)
  expect(w.files.get(path!)).toContain('Make the thing.')
  expect(w.files.get(path!)).toContain(`${ROOT}/docs/spec.md`)
  const reviewer = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer' })
  expect(reviewer.isError).toBe(true)
  expect(reviewer.text).toContain('pr')
  const role = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'boss' })
  expect(role.isError).toBe(true)
})

test('epicStatus shows the state, the next step and the sub-issues by state', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })
  const r = await tool($, 'epicStatus', {})
  expect(r.isError).toBe(false)
  expect(r.text).toContain('"coordinating"')
  expect(r.text).toContain('Next:')
  expect(r.text).toMatch(/#41[^\n]*implementing/)
  expect(r.text).toMatch(/#42[^\n]*waiting/)
  expect(w.epic()?.state).toBe('coordinating')
})

test('/flow epic tells the agent to start the epic, and shows the status once there is one', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  const out = await command($, w, 'epic 40')
  expect(out).toContain('#40')
  expect(w.prompts.at(-1)).toContain('mcp__ndev__epicStarted')
  expect(w.prompts.at(-1)).toContain('issue 40')
  await command($, w, 'epic Rework the billing')
  expect(w.prompts.at(-1)).toContain('title "Rework the billing"')
  await tool($, 'epicStarted', { issue: 40 })
  const told = w.prompts.length
  const status = await command($, w, 'epic')
  expect(status).toContain('"framing"')
  expect(w.prompts.length).toBe(told)
  expect(await command($, w, 'epic status')).toContain('"framing"')
})

test('/flow epic skip and goto move the epic as the human decided, and tell the agent', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const out = await command($, w, 'epic skip research is done already')
  expect(out).toContain('"framing"')
  expect(out).toContain('"researching"')
  expect(w.epic()?.state).toBe('researching')
  expect(w.epic()?.evidence.framing?.text).toContain('The human ran /flow epic skip')
  expect(w.epic()?.evidence.framing?.text).toContain('research is done already')
  expect(w.prompts.at(-1)).toContain('"researching"')
  expect(await command($, w, 'epic goto nowhere')).toContain('slicing')
  expect(w.epic()?.state).toBe('researching')
  await command($, w, 'epic goto slicing the spec exists')
  expect(w.epic()?.state).toBe('slicing')
  expect(w.epic()?.history.at(-1)).toMatchObject({ tool: 'human:goto', from: 'researching', to: 'slicing' })
})

test('/flow epic off unbinds the session and turns the usual workflow back on, and the record stays', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const out = await command($, w, 'epic off')
  expect(out).toContain('#40')
  expect(w.epic()?.state).toBe('framing')
  const line = await sections($)
  expect(line.epic).toBeUndefined()
  expect(line.workflow).toContain('Workflow:')
  const refused = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('epicStarted')
})

test('/flow help lists the epic verbs', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  const help = await command($, w, 'help')
  for (const verb of ['/flow epic [issue|title]', '/flow epic status', '/flow epic skip', '/flow epic goto', '/flow epic off']) expect(help).toContain(verb)
})

// ---- the worker-start command (amendment) ----

test('a value with quotes, a dollar or a space is shell-quoted, and a plain one is not', () => {
  expect(shellQuote('origin/main')).toBe('origin/main')
  expect(shellQuote('id:abc-1')).toBe('id:abc-1')
  expect(shellQuote('#5 Say "hi" $HOME it\'s')).toBe(`'#5 Say "hi" $HOME it'\\''s'`)
  expect(shellQuote('')).toBe(`''`)
})

test('the implementer command names every value, and leaves out the flags whose value the record lacks', () => {
  const epic = epicOf({ state: 'coordinating', run: 'run-7', repoId: 'repo-1', roles: { implementer: { agent: 'codex', model: 'gpt-5' }, reviewer: { agent: 'claude' } }, issues: withIssues(sub(5, { key: 'schema', title: 'Say "hi" $HOME' })) })
  const full = workerStartCommand({ role: 'implementer', briefPath: '/g/b.md', epic, sub: epic.issues['5']!, base: 'main' })
  expect(full).toEqual({ command: `orca orchestration worker-start --spec-file /g/b.md --task-title '#5 Say "hi" $HOME (implementer)' --run run-7 --worktree new-top-level --repo id:repo-1 --name 5-schema --base-branch origin/main --agent codex --model gpt-5 --json`, missing: [] })
  const bare = workerStartCommand({ role: 'implementer', briefPath: '/g/b.md', epic: { ...epic, run: undefined, repoId: undefined, roles: { implementer: { agent: 'claude' }, reviewer: { agent: 'codex' } } }, sub: epic.issues['5']!, base: 'main' })
  expect('command' in bare && bare.command).toBe(`orca orchestration worker-start --spec-file /g/b.md --task-title '#5 Say "hi" $HOME (implementer)' --worktree new-top-level --name 5-schema --base-branch origin/main --agent claude --json`)
  expect('missing' in bare && bare.missing.join('\n')).toMatch(/run[\s\S]*repoId/)
  expect('missing' in bare && bare.missing.join('\n')).toContain('mcp__ndev__epicStarted')
})

test('the reviewer command works in the implementer workspace, and refuses with no workspace', () => {
  const epic = epicOf({ state: 'coordinating', run: 'run-7', repoId: 'repo-1', issues: withIssues(sub(5, { key: 'schema', pr: 12, workspace: '/w/5 schema' })) })
  const r = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic, sub: epic.issues['5']!, pr: 12 })
  expect(r).toEqual({ command: `orca orchestration worker-start --spec-file /g/r.md --task-title '#5 Part 5 (reviewer, PR #12)' --run run-7 --worktree 'path:/w/5 schema' --agent codex --json`, missing: [] })
  const none = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic, sub: { ...epic.issues['5']!, workspace: undefined }, pr: 12 })
  expect('refused' in none && none.refused).toContain('workspace')
  expect('refused' in none && none.refused).toContain('mcp__ndev__epicIssue')
})

test('epicBrief answers with the filled command and the next step, and the record keeps the Orca ids and the workspace', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const bare = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(bare.text).toContain('--base-branch origin/main')
  const bareCommand = bare.text.split('\n').find(l => l.startsWith('orca orchestration worker-start')) ?? ''
  expect(bareCommand).not.toContain('--run')
  expect(bareCommand).not.toContain('--repo')
  expect(bare.text).toContain('repoId')
  expect((await tool($, 'epicStarted', { issue: 40, run: 'run-7', repoId: 'repo-1' })).isError).toBe(false)
  expect(w.epic()?.state).toBe('coordinating')
  const r = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(r.text).toContain(`orca orchestration worker-start --spec-file ${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-implementer.md --task-title '#41 Schema (implementer)' --run run-7 --worktree new-top-level --repo id:repo-1 --name 41-schema --base-branch origin/main --agent claude --json`)
  expect(r.text).toContain('mcp__ndev__epicIssue')
  expect(r.text).toContain('worker')
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: '/w/41-schema' })
  expect(w.epic()?.issues['41']?.workspace).toBe('/w/41-schema')
  const reviewer = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 })
  expect(reviewer.isError).toBe(false)
  expect(reviewer.text).toContain(`--task-title '#41 Schema (reviewer, PR #12)' --run run-7 --worktree path:/w/41-schema --agent codex --json`)
  expect(w.files.get(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-reviewer.md`)).toContain('PR #12')
})

test('a relative workspace is refused, and the workspace can be set later with no move', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const rel = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: 'w/41' })
  expect(rel.isError).toBe(true)
  expect(rel.text).toContain('absolute')
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })
  const noWs = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 })
  expect(noWs.isError).toBe(true)
  expect(noWs.text).toContain('workspace')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', workspace: '/w/41' })).isError).toBe(false)
  expect(w.epic()?.issues['41']).toMatchObject({ state: 'implementing', implementer: 'd1', workspace: '/w/41' })
  expect((await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 })).isError).toBe(false)
})

// ---- workers on the saved remote Orca server ----

const REMOTE = { id: 'bb22-y', name: 'dev-build VM 5e6f' }
const REMOTE_STORE = '/home/neil/.config/ndev/remote.json'

test('with a remote on the epic, the implementer command names the server and a repository on it, and refuses without that repository', () => {
  const epic = epicOf({ state: 'coordinating', run: 'run-7', repoId: 'repo-1', remote: REMOTE, remoteRepo: 'name:w', issues: withIssues(sub(5, { key: 'schema' })) })
  const r = workerStartCommand({ role: 'implementer', briefPath: '/g/b.md', epic, sub: epic.issues['5']!, base: 'main' })
  expect(r).toEqual({ command: `orca orchestration worker-start --spec-file /g/b.md --task-title '#5 Part 5 (implementer)' --run run-7 --on bb22-y --worktree new-top-level --repo name:w --name 5-schema --base-branch origin/main --agent claude --json`, missing: [] })
  // The repository id of this machine's Orca is never sent to the server.
  const none = workerStartCommand({ role: 'implementer', briefPath: '/g/b.md', epic: { ...epic, remoteRepo: undefined }, sub: epic.issues['5']!, base: 'main' })
  const refused = 'refused' in none ? none.refused : ''
  expect(refused).toContain('remoteRepo')
  expect(refused).toContain('dev-build VM 5e6f (bb22-y)')
  expect(refused).toContain('orca repo list --environment bb22-y --json')
  expect(refused).toContain('mcp__ndev__epicStarted with issue 40 and remoteRepo')
  expect(refused).toContain('remote false')
})

test('the reviewer of a sub-issue on the server gets the server and the worktree id there, and a path alone is refused', () => {
  const epic = epicOf({ state: 'coordinating', run: 'run-7', remote: REMOTE, remoteRepo: 'name:w', issues: withIssues(sub(5, { key: 'schema', state: 'implementing', pr: 12, remote: REMOTE, workspace: 'r9::/srv/w/5-schema' })) })
  const r = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic, sub: epic.issues['5']!, pr: 12 })
  expect(r).toEqual({ command: `orca orchestration worker-start --spec-file /g/r.md --task-title '#5 Part 5 (reviewer, PR #12)' --run run-7 --on bb22-y --worktree id:r9::/srv/w/5-schema --agent codex --json`, missing: [] })
  const path = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic, sub: { ...epic.issues['5']!, workspace: '/srv/w/5-schema' }, pr: 12 })
  const refused = 'refused' in path ? path.refused : ''
  expect(refused).toContain('#5')
  expect(refused).toContain('/srv/w/5-schema')
  expect(refused).toContain('<repoId>::<path>')
  expect(refused).toContain('orca worktree list --environment bb22-y --json')
  expect(refused).toContain('mcp__ndev__epicIssue')
})

test('a sub-issue in flight on this machine keeps its place when the epic gets a remote, and one on the server keeps its server when the epic loses it', () => {
  const local = sub(5, { key: 'schema', state: 'implementing', pr: 12, workspace: '/w/5-schema' })
  const epic = epicOf({ state: 'coordinating', run: 'run-7', repoId: 'repo-1', remote: REMOTE, remoteRepo: 'name:w', issues: withIssues(local) })
  const reviewer = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic, sub: local, pr: 12 })
  expect('command' in reviewer && reviewer.command).toBe(`orca orchestration worker-start --spec-file /g/r.md --task-title '#5 Part 5 (reviewer, PR #12)' --run run-7 --worktree path:/w/5-schema --agent codex --json`)
  const again = workerStartCommand({ role: 'implementer', briefPath: '/g/b.md', epic, sub: local, base: 'main' })
  expect('command' in again && again.command).toContain('--run run-7 --worktree new-top-level --repo id:repo-1 --name 5-schema')
  expect('command' in again && again.command).not.toContain('--on')
  const there = sub(6, { key: 'api', state: 'reviewing', pr: 13, remote: REMOTE, workspace: 'r9::/srv/w/6-api' })
  const off = workerStartCommand({ role: 'reviewer', briefPath: '/g/r.md', epic: { ...epic, remote: undefined }, sub: there, pr: 13 })
  expect('command' in off && off.command).toContain('--on bb22-y --worktree id:r9::/srv/w/6-api')
})

test('epicStarted takes a remote only when asked: the saved server alone changes nothing, and remote false turns it off', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  w.files.set(REMOTE_STORE, JSON.stringify({ projects: { [REPO]: { id: 'aa11-x', name: 'vm-a' } } }))
  await start($)
  await planned($)
  expect((await tool($, 'epicStarted', { issue: 40, run: 'run-7', repoId: 'repo-1' })).isError).toBe(false)
  expect(w.epic()?.remote).toBeUndefined()
  const local = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(local.text).toContain(`--run run-7 --worktree new-top-level --repo id:repo-1 --name 41-schema --base-branch origin/main --agent claude --json`)
  expect(local.text).not.toContain('--on')
  expect(w.epic()?.issues['41']?.remote).toBeUndefined()

  // true: the server that /dev remote saved for the project.
  const saved = await tool($, 'epicStarted', { issue: 40, remote: true })
  expect(saved.isError).toBe(false)
  expect(saved.text).toContain('vm-a (aa11-x)')
  expect(w.epic()?.remote).toEqual({ id: 'aa11-x', name: 'vm-a' })
  // A name: the recipe id that begins a saved server's name.
  const named = await tool($, 'epicStarted', { issue: 40, remote: 'dev-build', remoteRepo: 'name:w' })
  expect(named.isError).toBe(false)
  expect(w.epic()).toMatchObject({ remote: REMOTE, remoteRepo: 'name:w' })
  // A resume with no remote keeps it, and reads no server.
  w.s.orcaFails = 'orca is not running'
  expect((await tool($, 'epicStarted', { issue: 40 })).isError).toBe(false)
  expect(w.epic()?.remote).toEqual(REMOTE)
  expect((await tool($, 'epicStatus', { issue: 40 })).text).toContain('dev-build VM 5e6f (bb22-y)')

  const off = await tool($, 'epicStarted', { issue: 40, remote: false })
  expect(off.isError).toBe(false)
  expect(off.text).toContain('this machine')
  expect(w.epic()?.remote).toBeUndefined()
})

test('a remote that cannot be resolved is refused with the saved servers and the repair, and nothing changes or is filed', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  const fresh = await tool($, 'epicStarted', { title: 'Big change', shortName: 'big-change', remote: 'nope' })
  expect(fresh.isError).toBe(true)
  expect(fresh.text).toContain('Orca has no saved server "nope"')
  expect(fresh.text).toContain('vm-a (aa11-x), dev-build VM 5e6f (bb22-y)')
  expect(fresh.text).toContain('mcp__ndev__epicStarted')
  expect(fresh.text).toContain('Nothing changed')
  expect(w.gh.some(g => g.startsWith('issue-new'))).toBe(false)
  expect(w.epic()).toBeUndefined()

  await planned($)
  // Several servers, none saved for the project and none named: no guess.
  const several = await tool($, 'epicStarted', { issue: 40, remote: true })
  expect(several.isError).toBe(true)
  expect(several.text).toContain('Orca has 2 saved servers')
  expect(w.epic()?.remote).toBeUndefined()
  // The saved server is gone from Orca: no switch to another.
  w.files.set(REMOTE_STORE, JSON.stringify({ projects: { [REPO]: { id: 'zz99-q', name: 'old-vm' } } }))
  const stale = await tool($, 'epicStarted', { issue: 40, remote: true })
  expect(stale.isError).toBe(true)
  expect(stale.text).toContain('old-vm (zz99-q), is no longer in Orca')
  expect(stale.text).toContain('/dev remote off')
  // Orca itself fails: the command and its own output are named.
  w.s.orcaFails = 'orca is not running'
  const down = await tool($, 'epicStarted', { issue: 40, remote: 'vm-a' })
  expect(down.isError).toBe(true)
  expect(down.text).toContain('orca environment')
  expect(down.text).toContain('orca is not running')
  w.s.orcaFails = ''
  for (const bad of [42, '', ' ']) {
    const r = await tool($, 'epicStarted', { issue: 40, remote: bad })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('remote must be')
  }
  const repo = await tool($, 'epicStarted', { issue: 40, remoteRepo: 'w' })
  expect(repo.isError).toBe(true)
  expect(repo.text).toContain('name:<name>')
  expect(w.epic()?.remote).toBeUndefined()
  expect(w.epic()?.remoteRepo).toBeUndefined()
})

test('with a remote, epicBrief records where each sub-issue starts, takes the worktree id on the server as its workspace, and leaves a sub-issue in flight on this machine', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  expect((await tool($, 'epicStarted', { issue: 40, run: 'run-7', repoId: 'repo-1' })).isError).toBe(false)
  // #43 starts on this machine, before the remote is set.
  await tool($, 'epicBrief', { issue: 40, sub: 43, role: 'implementer' })
  await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing', worker: 'd0', workspace: '/w/43-docs' })
  expect((await tool($, 'epicStarted', { issue: 40, remote: 'vm-a' })).isError).toBe(false)

  const noRepo = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(noRepo.isError).toBe(true)
  expect(noRepo.text).toContain('remoteRepo')
  expect(w.files.has(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-implementer.md`)).toBe(false)
  expect(w.epic()?.issues['41']?.remote).toBeUndefined()
  expect((await tool($, 'epicStarted', { issue: 40, remoteRepo: 'name:w' })).isError).toBe(false)

  const r = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain(`--task-title '#41 Schema (implementer)' --run run-7 --on aa11-x --worktree new-top-level --repo name:w --name 41-schema --base-branch origin/main --agent claude --json`)
  expect(r.text).toContain('vm-a (aa11-x)')
  expect(r.text).toContain('<repoId>::<path>')
  expect(w.epic()?.issues['41']?.remote).toEqual({ id: 'aa11-x', name: 'vm-a' })
  // The server has no file of this machine: a spec file is named by its path in the repository.
  const brief = w.files.get(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-implementer.md`) ?? ''
  expect(brief).toContain('- docs/spec.md')
  expect(brief).not.toContain(`${ROOT}/docs/spec.md`)
  expect(r.text).toContain('origin/main')

  const path = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: '/srv/w/41-schema' })
  expect(path.isError).toBe(true)
  expect(path.text).toContain('<repoId>::<path>')
  expect(path.text).toContain('orca worktree list --environment aa11-x --json')
  expect(w.epic()?.issues['41']?.state).toBe('waiting')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: 'r9::/srv/w/41-schema' })).isError).toBe(false)
  const reviewer = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 })
  expect(reviewer.text).toContain(`--run run-7 --on aa11-x --worktree id:r9::/srv/w/41-schema --agent codex --json`)

  // #43 is on this machine: its reviewer is too, and a worktree id of the server is refused for it.
  const local = await tool($, 'epicBrief', { issue: 40, sub: 43, role: 'reviewer', pr: 13 })
  expect(local.text).toContain(`--run run-7 --worktree path:/w/43-docs --agent codex --json`)
  expect(local.text).not.toContain('--on')
  expect((await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing', workspace: 'r9::/srv/w/43' })).isError).toBe(true)

  // Turned off again, the sub-issue on the server keeps its server.
  expect((await tool($, 'epicStarted', { issue: 40, remote: false })).isError).toBe(false)
  const reviewerStill = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 })
  expect(reviewerStill.text).toContain('--on aa11-x --worktree id:r9::/srv/w/41-schema')
})
