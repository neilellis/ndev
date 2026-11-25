import { expect, test } from './sdk-testing'

import { EPIC_STATES, addedMigrations, coreIdeaProblem, epicHumanStep, epicLineOf, epicStep, frontier, implementerBrief, nextEpicState, reviewerBrief, shellQuote, sliceProblems, stackPlan, unlistedMigrations, workerStartCommand } from '../hooks/workflow/epic'
import type { Epic, SubIssue } from '../hooks/workflow/epic'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]

const ROOT = '/proj'
const REPO = 'acme/w'
const SHA = 'aaaaaaaa11111111'
const CLOSING_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
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

test('an acceptance example of the core idea is a line with its id and an arrow, in a list, a table or bold', () => {
  for (const page of [
    'A1: an order → a receipt\nA2: a refund → a credit\nA3: a cart -> a refusal',
    '1. A1: an order → a receipt\n2. A2: a refund → a credit\n3) A3: a cart → a refusal',
    '| Id | Input | Output |\n|---|---|---|\n| A1 | an order → | a receipt |\n| A2 | a refund → | a credit |\n| A3 | a cart → | a refusal |',
    '- **A1**: an order → a receipt\n- **A2:** a refund → a credit\n* A3: a cart → a refusal',
  ]) expect(coreIdeaProblem(page)).toBeUndefined()
  expect(coreIdeaProblem('A1: to do\nA2: to do\nA3: to do')).toContain('0 acceptance examples')
  expect(coreIdeaProblem('Assumptions\nA1: the store is up\nB2: x → y')).toContain('0 acceptance examples')
})

test('the next step names the plan skill up to slicing, and the coordinate skill after', () => {
  for (const state of ['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing'] as const) expect(epicStep(epicOf({ state }))).toContain('ndev:epic-plan')
  for (const state of ['coordinating', 'closing'] as const) expect(epicStep(epicOf({ state }))).toContain('ndev:epic-coordinate')
  expect(epicStep(epicOf({ state: 'framing' }))).toContain('mcp__ndev__epicPhase')
  expect(epicStep(epicOf({ state: 'spec-review' }))).toContain('Refs #40')
  expect(epicStep(epicOf({ state: 'spec-review' }))).toContain('specPr')
  expect(epicStep(epicOf({ state: 'closing' }))).toContain('retro skill')
})

test('every epic state tells the human what they can do next', () => {
  for (const state of EPIC_STATES) {
    const human = epicHumanStep(epicOf({ state }))
    expect(human.length).toBeGreaterThan(20)
    expect(epicStep(epicOf({ state }))).toContain(`Tell the human: ${human}`)
  }
  expect(epicHumanStep(epicOf({ state: 'slicing' }))).toContain('approve')
  expect(epicHumanStep(epicOf({ state: 'coordinating' }))).toContain('/flow epic status')
})

test('the system line names the epic, its root, its state, the role and the next step', () => {
  expect(epicLineOf(epicOf({ state: 'slicing' }))).toBe(`Epic: #40 "Big change" in ${ROOT} is in the state "slicing". You are the coordinator: you plan, decide, verify and merge; workers implement and review. Next: ${epicStep(epicOf({ state: 'slicing' }))}`)
})

const SECTIONED = (path: string) => `Closes #5\n\n<!-- ndev:migrations -->\n## Migrations to run after merge\n\n- \`${path}\`\n<!-- /ndev:migrations -->\n`

test('the migration check names each added migration that the PR body does not list, and passes a listed one', () => {
  const path = 'supabase/migrations/20261112000000_add_t.sql'
  const added = `added\t${path}\n`
  expect(addedMigrations(`${added}added\tsrc/a.ts\nmodified\tsupabase/migrations/1_old.sql\nremoved\tsupabase/migrations/2_gone.sql\n`)).toEqual([path])
  expect(unlistedMigrations(added, 'Closes #5')).toEqual([path])
  // A path named outside the section does not count.
  expect(unlistedMigrations(added, `Closes #5\n\n- \`${path}\``)).toEqual([path])
  expect(unlistedMigrations(added, SECTIONED(path))).toEqual([])
  expect(unlistedMigrations('added\tsrc/a.ts\n', '')).toEqual([])
})

test('the implementer brief carries the epic, the sub-issue, the spec and the rules', () => {
  const epic = epicOf({ state: 'coordinating', aim: 'Make the thing.', issues: withIssues(sub(5)) })
  const text = implementerBrief(epic, epic.issues['5']!, [`${ROOT}/docs/spec.md`])
  for (const part of ['#40', 'Make the thing.', '#5', 'Part 5', `https://github.com/${REPO}/issues/5`, `${ROOT}/docs/spec.md`, 'mcp__ndev__started', 'test first', 'mcp__ndev__addMigration', 'orca orchestration ask', 'worker_done', 'Do not merge', 'proposed D-entry', 'decisions log']) expect(text).toContain(part)
})

test('the reviewer brief is read-only, names the PR, the severities and the verdicts', () => {
  const epic = epicOf({ state: 'coordinating', issues: withIssues(sub(5, { state: 'reviewing', pr: 12 })) })
  const text = reviewerBrief(epic, epic.issues['5']!, [`${ROOT}/docs/spec.md`])
  for (const part of ['read-only', 'PR #12', 'Critical', 'Important', 'Minor', 'APPROVE', 'CHANGES NEEDED', 'worker_done', 'file:line', 'no numbered D-entry', `${ROOT}/docs/spec.md`]) expect(text).toContain(part)
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
    [`${ROOT}/docs/prompt.md`]: 'the customer prompt',
    [`${ROOT}/docs/core-idea.md`]: '# Core idea\n\nAim: make the thing.\n\nA1: an order → a receipt\nA2: a refund → a credit note\nA3: an empty cart → a refusal\n',
    [`${ROOT}/docs/two-examples.md`]: '# Core idea\n\nA1: an order → a receipt\nA2: a refund → a credit note\n',
    [`${ROOT}/docs/research.md`]: 'notes',
    [`${ROOT}/docs/spec.md`]: 'spec',
    [`${ROOT}/docs/review.md`]: 'review',
  }))
  const s = {
    closing: false, now: 1_000, issues: {} as Record<number, { state: string; title: string } | string>,
    prs: { 30: { body: 'The spec of the epic.\n\nRefs #40' } } as Record<number, Record<string, unknown>>, links: {} as Record<number, unknown>, checks: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [] } as unknown,
    files: [] as { status: string; filename: string }[] | '__fail__', ignored: true, exclude: [] as string[],
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
      if (a[1] === 'rev-parse') return ok(`${s.closing ? CLOSING_SHA : SHA}\n`)
      if (s.closing && a[1] === 'branch') return ok('main')
      if (s.closing && (a[1] === 'status' || a[1] === 'merge-base')) return ok()
      if (s.closing && a[1] === 'show') return ok('R1: Works\nD1: Keep one store.\nD2: Ship weekly.')
      if (s.closing && a[1] === 'cat-file') return a[3] === `${CLOSING_SHA}:docs/adr/0001-keep-one-store.md` ? ok() : ok('', 128, `fatal: path '${a[3]}' does not exist`)
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
      if (a[2] === 'pr-read') return ok(JSON.stringify({ number: n, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', body: 'Closes #5', created_at: '2026-11-01T00:00:00Z', head: { sha: SHA, ref: 'issue-5' }, base: { ref: 'main' }, ...s.prs[n] }))
      if (a[2] === 'view-json' && a[3] === 'pr' && a.slice(5).join(' ') === '--fields closingIssuesReferences') return ok(JSON.stringify({ closingIssuesReferences: s.links[Number(a[4])] ?? [] }))
      if (a[2] === 'commit-checks') return ok(JSON.stringify(s.checks))
      // GitHub refuses the diff of a PR over 300 files (HTTP 406), and lists up to 3000 files a page at a time.
      if (a[2] === 'pr-diff') return ok('', 1, 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).')
      if (a[2] === 'api' && line.includes(`repos/${REPO}/pulls/`) && line.includes('/files')) {
        return s.files === '__fail__' ? ok('', 1, 'HTTP 502: Bad Gateway') : ok(s.files.map(f => `${f.status}\t${f.filename}\n`).join(''))
      }
      if (a[2] === 'api' && line.includes('/commits/main')) return ok(JSON.stringify({ sha: CLOSING_SHA }))
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
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'Make the thing.', sources: ['docs/prompt.md'], files: ['docs/core-idea.md'], evidence: 'framed with the human' })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'read the code', files: ['docs/research.md'] })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'specifying', evidence: 'wrote it', files: [`${ROOT}/docs/spec.md`] })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'deciding', evidence: 'all settled, none open' })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'each finding ruled', files: ['docs/review.md'], specPr: 30 })).isError).toBe(false)
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'three parts', approval: 'the human approved the breakdown table', issues: SLICES })).isError).toBe(false)
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
  const noSource = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x' })
  expect(noSource.isError).toBe(true)
  expect(noSource.text).toContain('no source: <reason>')
  const bareNoSource = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['no source:'] })
  expect(bareNoSource.isError).toBe(true)
  const mixed = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['no source: none', 'docs/prompt.md'] })
  expect(mixed.isError).toBe(true)
  expect(mixed.text).toContain('stand alone')
  const text = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: 'docs/prompt.md' })
  expect(text.isError).toBe(true)
  expect(text.text).toContain('must be a list')
  const absent = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/nowhere.md'] })
  expect(absent.isError).toBe(true)
  expect(absent.text).toContain(`${ROOT}/docs/nowhere.md`)
  const noCore = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/prompt.md'] })
  expect(noCore.isError).toBe(true)
  expect(noCore.text).toContain('core idea')
  const twoCores = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/prompt.md'], files: ['docs/core-idea.md', 'docs/research.md'] })
  expect(twoCores.isError).toBe(true)
  expect(twoCores.text).toContain('one file')
  const thin = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/prompt.md'], files: ['docs/two-examples.md'] })
  expect(thin.isError).toBe(true)
  expect(thin.text).toContain(`${ROOT}/docs/two-examples.md`)
  expect(thin.text).toContain('2 acceptance examples')
  expect(thin.text).toContain('3 to 5')
  expect(w.epic()?.state).toBe('framing')
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/prompt.md', 'https://example.test/brief'], files: ['docs/core-idea.md'] })).text).toContain('"researching"')
  expect(w.epic()?.sources).toEqual([`${ROOT}/docs/prompt.md`, 'https://example.test/brief'])
  expect(w.epic()?.coreIdea).toBe(`${ROOT}/docs/core-idea.md`)
  expect(w.epic()?.evidence.framing?.files).toEqual([`${ROOT}/docs/core-idea.md`])
  const missing = await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'x', files: ['docs/nowhere.md'] })
  expect(missing.isError).toBe(true)
  expect(missing.text).toContain(`${ROOT}/docs/nowhere.md`)
  const late = await tool($, 'epicPhase', { issue: 40, finished: 'researching', evidence: 'x', files: ['docs/research.md'], sources: ['docs/prompt.md'] })
  expect(late.isError).toBe(true)
  expect(late.text).toContain('only for "framing"')
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
  const noPr = await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'] })
  expect(noPr.isError).toBe(true)
  expect(noPr.text).toContain('specPr')
  w.s.prs[31] = { body: 'The spec.\n\nCloses #40' }
  w.s.prs[32] = { body: `The spec.\n\nRefs #40\nResolves ${REPO}#40` }
  w.s.prs[33] = { body: 'The spec, with no link to the epic.' }
  w.s.prs[34] = { body: 'The spec.\n\nRefs #40\nCloses #400' }
  for (const [pr, words] of [[31, '"Closes #40"'], [32, `"Resolves ${REPO}#40"`], [33, 'does not say "Refs #40"']] as const) {
    const refused = await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'], specPr: pr })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(`PR #${pr}`)
    expect(refused.text).toContain(words)
    expect(refused.text).toContain('Refs #40')
    expect(refused.text).toContain(`gh pr edit ${pr} --repo ${REPO}`)
  }
  expect(w.epic()?.state).toBe('spec-review')
  await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'], specPr: 34 })
  expect(w.epic()?.state).toBe('slicing')
  expect(w.epic()?.specPr).toBe(34)
  expect(w.epic()?.evidence.specifying?.files).toEqual([`${ROOT}/docs/spec.md`])
  expect(w.epic()?.history.map(h => h.to)).toEqual(['framing', 'researching', 'specifying', 'deciding', 'spec-review', 'slicing'])
})

test('spec-review refuses a spec PR that GitHub links as closing the epic, though its body only says Refs', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'spec-review' }))
  w.s.prs[35] = { body: 'The spec.\n\nRefs #40' }
  w.s.links[35] = [{ number: 40, url: `https://github.com/${REPO.toUpperCase()}/issues/40` }]
  w.s.links[30] = [{ number: 40, url: 'https://github.com/other/repo/issues/40' }, { number: 7, url: `https://github.com/${REPO}/issues/7` }]
  const refused = await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'], specPr: 35 })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('spec PR #35: GitHub links it as closing the epic #40')
  expect(refused.text).toContain(`gh pr view 35 --repo ${REPO} --json closingIssuesReferences`)
  expect(w.epic()?.state).toBe('spec-review')
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'spec-review', evidence: 'ruled', files: ['docs/review.md'], specPr: 30 })).isError).toBe(false)
  expect(w.epic()?.state).toBe('slicing')
})

test('slicing refuses while the epic issue is closed on GitHub', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'slicing', specPr: 30 }))
  w.s.issues[40] = { state: 'closed', title: 'Epic' }
  const refused = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'three parts', approval: 'approved', issues: SLICES })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('epic #40 is closed on GitHub')
  expect(refused.text).toContain(`gh issue reopen 40 --repo ${REPO}`)
  expect(refused.text).toContain('spec PR #30')
  expect(w.epic()?.state).toBe('slicing')
  w.s.issues[40] = { state: 'open', title: 'Epic' }
  expect((await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'three parts', approval: 'approved', issues: SLICES })).isError).toBe(false)
  expect(w.epic()?.state).toBe('coordinating')
})

const IN_FLIGHT = { issue: 41, key: 'schema', title: 'Schema', blockedBy: [], state: 'implementing', pr: 51, implementer: 'w-schema', rounds: 2 }

test('finishing a reslice keeps each sub-issue that has a record, and starts only the new ones as waiting', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'slicing', issues: { 41: IN_FLIGHT } }))
  const r = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'resliced', approval: 'approved', issues: [{ ...SLICES[0], title: 'Schema v2' }, SLICES[1], SLICES[2]] })
  expect(r.isError).toBe(false)
  expect(w.epic()?.issues['41']).toEqual({ ...IN_FLIGHT, title: 'Schema v2' })
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'waiting', rounds: 0 })
  expect(w.epic()?.state).toBe('coordinating')
})

test('a reslice refuses to drop, rename or re-block a sub-issue that is in flight', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const before = JSON.stringify({ ...w.epic(), state: 'slicing', issues: { 41: IN_FLIGHT } })
  w.files.set(EPIC_FILE(40), before)
  const cases: [Record<string, unknown>[], RegExp][] = [
    [[SLICES[2]], /drops #41, which is "implementing" with PR #51.*Keep #41/],
    [[{ ...SLICES[0], key: 'tables' }, SLICES[1], SLICES[2]], /#41 is "implementing".*key "schema".*"tables"/],
    [[{ ...SLICES[0], blockedBy: [43] }, SLICES[1], SLICES[2]], /#41 is "implementing".*blocked by \[\].*\[43\]/],
  ]
  for (const [issues, message] of cases) {
    const refused = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'resliced', approval: 'approved', issues })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(message)
    expect(w.files.get(EPIC_FILE(40))).toBe(before)
  }
})

test('a reslice after a sub-issue merged is refused, and names the import that keeps it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const before = JSON.stringify({ ...w.epic(), state: 'slicing', issues: { 41: { ...IN_FLIGHT, state: 'merged' }, 42: { ...IN_FLIGHT, issue: 42, key: 'api', title: 'API', blockedBy: [41], pr: 52, implementer: 'w-api' } } })
  w.files.set(EPIC_FILE(40), before)
  for (const issues of [SLICES, [SLICES[1], SLICES[2]], [{ ...SLICES[1], blockedBy: [] }, SLICES[2]]]) {
    const refused = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'resliced', approval: 'approved', issues })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/#41 is merged.*ndev epic import 40 --issues-file/)
    expect(w.files.get(EPIC_FILE(40))).toBe(before)
  }
})

test('slicing refuses a cycle, an unknown blocker, and a closed or unreadable issue by number', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'slicing' }))
  const empty = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: [] })
  expect(empty.isError).toBe(true)
  const cycle = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: [{ issue: 41, key: 'a', title: 'A', blockedBy: [42] }, { issue: 42, key: 'b', title: 'B', blockedBy: [41] }] })
  expect(cycle.isError).toBe(true)
  expect(cycle.text).toContain('cycle')
  const unknown = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: [{ issue: 41, key: 'a', title: 'A', blockedBy: [99] }] })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('#99')
  // The shape checks come before any read of a sub-issue on GitHub.
  expect(w.gh.filter(c => /^issue-read (41|42|99)\b/.test(c))).toEqual([])
  w.s.issues[42] = { state: 'closed', title: 'B' }
  w.s.issues[43] = 'HTTP 404: Not Found'
  const closed = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: SLICES })
  expect(closed.isError).toBe(true)
  expect(closed.text).toContain('#42 is closed')
  expect(closed.text).toContain('#43')
  expect(closed.text).toContain('404')
  expect(w.epic()?.state).toBe('slicing')
  expect(w.epic()?.issues).toEqual({})
})

test('slicing needs the human approval of the breakdown, and refuses above the cap of 30 sub-issues without an override', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const early = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['docs/prompt.md'], files: ['docs/core-idea.md'], approval: 'yes' })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('only for "slicing"')
  const slicing = JSON.stringify({ ...w.epic(), state: 'slicing' })
  w.files.set(EPIC_FILE(40), slicing)
  const parts = (count: number) => Array.from({ length: count }, (_, i) => ({ issue: 101 + i, key: `part-${i + 1}`, title: `Part ${i + 1}`, blockedBy: [] }))
  const unapproved = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', issues: SLICES })
  expect(unapproved.isError).toBe(true)
  expect(unapproved.text).toContain('approval')
  const over = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: parts(31) })
  expect(over.isError).toBe(true)
  expect(over.text).toContain('31 sub-issues')
  expect(over.text).toContain('cap of 30')
  expect(over.text).toContain('child epics')
  expect(over.text).toContain('capOverride')
  expect(w.epic()?.state).toBe('slicing')
  expect(w.gh.filter(c => /^issue-read 1[0-3][0-9]\b/.test(c))).toEqual([])
  const capped = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'approved', issues: parts(30) })
  expect(capped.isError).toBe(false)
  expect(Object.keys(w.epic()?.issues ?? {})).toHaveLength(30)
  expect(w.epic()?.debts ?? []).toEqual([])
  w.files.set(EPIC_FILE(40), slicing)
  const overridden = await tool($, 'epicPhase', { issue: 40, finished: 'slicing', evidence: 'x', approval: 'Neil approved the 31 rows', capOverride: 'the human keeps one epic for the migration', issues: parts(31) })
  expect(overridden.isError).toBe(false)
  expect(w.epic()?.state).toBe('coordinating')
  expect(w.epic()?.evidence.slicing?.approval).toBe('Neil approved the 31 rows')
  expect(w.epic()?.debts?.map(d => [d.kind, d.note])).toEqual([['gate-override', 'Sliced 31 sub-issues, above the cap of 30: the human keeps one epic for the migration']])
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

test('the parallel cap refuses an unblock back to work when every place is taken', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40, parallel: 1 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'coordinating', issues: withIssues(sub(41, { state: 'implementing', implementer: 'd1' }), sub(43, { state: 'blocked', previous: 'implementing', implementer: 'd3', note: 'needs a key' })) }))
  const r = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('parallel')
  expect(r.text).toContain('#41')
  expect(w.epic()?.issues['43']?.state).toBe('blocked')
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
  w.s.files = [{ status: 'added', filename: path }, { status: 'modified', filename: 'supabase/migrations/1_old.sql' }]
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

test('verify reports changed files it cannot read as not run, and refuses', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  w.s.files = '__fail__'
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/Not run:[^\n]*migrations/)
})

test('verify reads the migrations of a PR over 300 files, whose diff GitHub refuses', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  const path = 'supabase/migrations/20261112000000_add_t.sql'
  w.s.files = [...Array.from({ length: 331 }, (_, i) => ({ status: 'modified', filename: `src/f${i}.ts` })), { status: 'added', filename: path }]
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.text).not.toMatch(/Not run:[^\n]*migrations/)
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(new RegExp(`Failed:[^\\n]*migrations not listed in the PR body: ${path}`))
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
  w.s.prs[12] = { body: SECTIONED(path) }
  const passed = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(passed.isError).toBe(false)
  expect(passed.text).toMatch(/Passed:[^\n]*migrations \(1 added, each listed\)/)
  expect(w.epic()?.issues['41']?.state).toBe('verified')
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

test('a push after verify is named at merge: the moved head owes verification debt, and only a merge counts as merged', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  w.s.prs[12] = { head: { sha: 'dddddddd44444444', ref: 'issue-41' } }
  const early = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('PR #12 is not merged')
  expect(early.text).toContain('dddddddd')
  expect(early.text).not.toContain('Move #41 to "verified" first')
  expect(w.epic()?.issues['41']?.state).toBe('verified')
  w.s.prs[12] = { state: 'closed', merged: true, merge_commit_sha: 'eeeeeeee55555555', head: { sha: 'dddddddd44444444', ref: 'issue-41' } }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('dddddddd')
  expect(r.text).not.toContain('verify checks did not run')
  expect(w.epic()?.issues['41']).toMatchObject({ state: 'merged', mergedUnverified: true })
  expect(w.epic()?.debts?.map(d => d.kind)).toEqual(['skipped-check'])
})

test('a PR that a human merged in reviewing or fixing is recorded as merged, with its merge commit and the new frontier', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  // Not merged on GitHub: the short cut is refused, and the refusal names the usual route.
  const early = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('PR #12 is not merged')
  expect(early.text).toContain('"verified"')
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
  // The human merged it with red checks: verify cannot pass, and its refusal names the repair.
  w.s.prs[12] = { state: 'closed', merged: true, merge_commit_sha: 'bbbbbbbb22222222' }
  w.s.checks = { check_runs: [{ name: 'smoke', status: 'completed', conclusion: 'failure' }], statuses: [] }
  const verify = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(verify.isError).toBe(true)
  expect(verify.text).toContain('already merged')
  expect(verify.text).toContain('state "merged"')
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('bbbbbbbb22222222')
  expect(r.text).toContain('verify checks did not run')
  expect(r.text).toMatch(/Ready[^\n]*#42/)
  expect(w.epic()?.issues['41']).toMatchObject({ state: 'merged', mergeSha: 'bbbbbbbb22222222', mergedUnverified: true })
  // The same from fixing.
  await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'implementing', worker: 'd3' })
  await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'reviewing', pr: 13, worker: 'r3' })
  await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'fixing', verdict: 'changes', note: 'fix the test' })
  w.s.prs[13] = { state: 'closed', merged: true, merge_commit_sha: 'cccccccc33333333' }
  const fixed = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'merged' })
  expect(fixed.isError).toBe(false)
  expect(w.epic()?.issues['43']).toMatchObject({ state: 'merged', mergeSha: 'cccccccc33333333', mergedUnverified: true })
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
  expect(done.isError).toBe(true)
  expect(done.text).toContain('closingFile')
  w.s.closing = true
  const saved = w.epic()!
  saved.baseSha = BASE_SHA
  saved.coordinatorModel = 'author'
  saved.fullSuites = [['npm', 'test']]
  for (const sub of Object.values(saved.issues)) { sub.reviewer = 'reviewer'; sub.verdict = 'approve' }
  w.files.set(EPIC_FILE(40), JSON.stringify(saved))
  w.files.set('/logs/suite.log', 'all passed')
  const receipt = { sha: CLOSING_SHA, branch: 'main', suites: [{ command: ['npm', 'test'], exitCode: 0, sha: CLOSING_SHA, log: '/logs/suite.log', skippedChecks: [] }], review: { baseSha: BASE_SHA, sha: CLOSING_SHA, model: 'other', reviewer: 'independent', requirements: [{ id: 'R1', status: 'done', evidence: 'test' }], findings: [] } }
  w.files.set('/logs/closing.json', JSON.stringify(receipt))
  const noAdrs = await tool($, 'epicPhase', { issue: 40, finished: 'closing', evidence: 'suite and review', closingFile: '/logs/closing.json' })
  expect(noAdrs.isError).toBe(true)
  expect(noAdrs.text).toContain('adrs')
  w.files.set('/logs/closing.json', JSON.stringify({ ...receipt, adrs: [{ decision: 'D2', path: 'docs/adr/0002-not-written.md' }] }))
  const unwritten = await tool($, 'epicPhase', { issue: 40, finished: 'closing', evidence: 'suite and review', closingFile: '/logs/closing.json' })
  expect(unwritten.isError).toBe(true)
  expect(unwritten.text).toContain('docs/adr/0002-not-written.md')
  expect(w.epic()?.state).toBe('closing')
  w.files.set('/logs/closing.json', JSON.stringify({ ...receipt, adrs: [{ decision: 'D1', path: 'docs/adr/0001-keep-one-store.md' }] }))
  const closed = await tool($, 'epicPhase', { issue: 40, finished: 'closing', evidence: 'suite and review', closingFile: '/logs/closing.json' })
  expect(closed.isError).toBe(false)
  expect(w.epic()?.state).toBe('done')
  expect(w.epic()?.closing?.adrs).toEqual([{ decision: 'D1', path: 'docs/adr/0001-keep-one-store.md' }])
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

test('epicBrief refuses an implementer for a sub-issue that has started, and any brief outside coordinating, and names the state', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: '/w/41' })).isError).toBe(false)
  const started = await tool($, 'epicBrief', { issue: 40, sub: 41, role: 'implementer' })
  expect(started.isError).toBe(true)
  expect(started.text).toContain('#41 is in the state "implementing"')
  expect(started.text).toContain('dispatch:d1')
  expect(w.files.has(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-41-implementer.md`)).toBe(false)
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'closing' }))
  for (const [n, role] of [[43, 'implementer'], [41, 'reviewer']] as const) {
    const closing = await tool($, 'epicBrief', { issue: 40, sub: n, role, pr: 12 })
    expect(closing.isError).toBe(true)
    expect(closing.text).toContain('epic #40 is in "closing"')
  }
})

test('epicIssue reviewing reads the PR on GitHub and refuses unless it is open and ready', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1', workspace: '/w/41' })).isError).toBe(false)
  for (const [pr, shown] of [[{ draft: true }, 'draft true'], [{ state: 'closed' }, 'state "closed"'], [{ state: 'closed', merged: true }, 'merged true']] as const) {
    w.s.prs[12] = pr
    const refused = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('PR #12 of #41 must be open and ready')
    expect(refused.text).toContain(shown)
    expect(w.epic()?.issues['41']?.state).toBe('implementing')
    expect(w.epic()?.issues['41']?.pr).toBeUndefined()
  }
  w.s.prs[12] = {}
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })).isError).toBe(false)
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
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

test('/flow epic goto and skip refuse a done epic, name the new-epic path, and change nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'done' }))
  const before = w.files.get(EPIC_FILE(40))
  for (const words of ['epic goto coordinating reopen it', 'epic skip']) {
    const out = await command($, w, words)
    expect(out).toContain('Epic #40 is done')
    expect(out).toContain('/flow epic <title>')
    expect(w.files.get(EPIC_FILE(40))).toBe(before)
  }
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
  const refused = await tool($, 'epicPhase', { issue: 40, finished: 'framing', aim: 'A.', evidence: 'x', sources: ['no source: a test'], files: ['docs/core-idea.md'] })
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

// ---- stacked pull requests ----

const head = (ref: string) => ({ head: { sha: SHA, ref } })
// Puts sub-issues in the record as they are after some moves, so a test starts at the state it is about.
const setIssues = (w: W, ...subs: SubIssue[]) => w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'coordinating', issues: withIssues(...subs) }))
const commandOf = (text: string) => text.split('\n').find(l => l.startsWith('orca orchestration worker-start')) ?? ''

test('a waiting issue can stack on one unmerged blocker whose PR is pushed, and on several only when one branch holds the others', () => {
  const issues = () => withIssues(sub(1, { state: 'reviewing', pr: 11 }), sub(2, { blockedBy: [1] }), sub(3, { state: 'fixing', pr: 13 }), sub(4, { blockedBy: [1, 3] }), sub(5, { state: 'implementing' }), sub(6, { blockedBy: [5] }), sub(7, { state: 'merged' }), sub(8, { blockedBy: [7] }))
  const epic = epicOf({ state: 'coordinating', parallel: 9, issues: issues() })
  expect(stackPlan(epic, epic.issues['8']!)).toBeUndefined()
  expect(stackPlan(epic, epic.issues['2']!)).toMatchObject({ on: { issue: 1 } })
  const split = stackPlan(epic, epic.issues['4']!)
  expect(split && 'why' in split && split.why).toMatch(/#1, #3[\s\S]*different branches/)
  const early = stackPlan(epic, epic.issues['6']!)
  expect(early && 'why' in early && early.why).toMatch(/#5[\s\S]*implementing/)
  const f = frontier(epic)
  expect(f.ready.map(s => s.issue)).toEqual([8])
  expect(f.stacked.map(s => [s.sub.issue, s.on.issue])).toEqual([[2, 1]])
  expect(f.waitingOn).toEqual([{ issue: 4, open: [1, 3] }, { issue: 6, open: [5] }])
  expect(f.notStackable.map(n => n.issue)).toEqual([4])
  // Once the branch of #3 holds the branch of #1, #4 stacks on #3.
  epic.issues['3']!.stackedOn = 1
  expect(stackPlan(epic, epic.issues['4']!)).toMatchObject({ on: { issue: 3 } })
  expect(frontier(epic).notStackable).toEqual([])
  // The stacked issues come after the ready ones, and the two together are cut to the free places: 3 are in flight.
  const tight = frontier({ ...epic, parallel: 4 })
  expect(tight.ready.map(s => s.issue)).toEqual([8])
  expect(tight.stacked).toEqual([])
  expect(tight.stackedHeld.map(s => s.issue)).toEqual([2, 4])
})

test('the stacked implementer brief names the blocker, its PR and its branch, and a plain brief does not', () => {
  const epic = epicOf({ state: 'coordinating', issues: withIssues(sub(5, { state: 'reviewing', pr: 12 }), sub(6, { blockedBy: [5] })) })
  const text = implementerBrief(epic, epic.issues['6']!, [], { on: epic.issues['5']!, branch: 'issue-5', base: 'main' })
  for (const part of ['Stacked on #5', 'PR #12', 'origin/issue-5', '--base issue-5', 'mcp__ndev__unblocked', 'git merge origin/main', '--base main', 'Do not merge']) expect(text).toContain(part)
  expect(implementerBrief(epic, epic.issues['5']!, [])).not.toContain('Stacked')
})

test('epicNext lists an issue as able to start stacked only once its blocker has a pushed PR, and within the parallel limit', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })
  const early = await tool($, 'epicNext', { issue: 40 })
  expect(early.text).not.toContain('Can start stacked')
  expect(early.text).toMatch(/#42 waits for #41/)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })
  const before = w.files.get(EPIC_FILE(40))
  const r = await tool($, 'epicNext', { issue: 40 })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/Ready to start[^\n]*#43/)
  expect(r.text).toMatch(/Can start stacked[^\n]*#42 "API" on #41 \(PR #12\)/)
  expect(r.text).not.toMatch(/#42 waits/)
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
  await tool($, 'epicStarted', { issue: 40, parallel: 1 })
  const full = await tool($, 'epicNext', { issue: 40 })
  expect(full.text).not.toContain('Can start stacked')
  expect(full.text).toMatch(/no place is free[^\n]*#42/)
})

test('an issue with two unmerged blockers on different branches is not stackable, and says why; it is once one branch holds the other', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const subs = (over: Partial<SubIssue> = {}) => [sub(41, { state: 'reviewing', pr: 12 }), sub(43, { state: 'reviewing', pr: 14, ...over }), sub(44, { key: 'ui', title: 'UI', blockedBy: [41, 43] })]
  setIssues(w, ...subs())
  w.s.prs[14] = head('issue-43')
  const next = await tool($, 'epicNext', { issue: 40 })
  expect(next.text).not.toContain('Can start stacked')
  expect(next.text).toMatch(/#44 waits for #41, #43/)
  expect(next.text).toMatch(/Not stackable: #44[^\n]*different branches/)
  const brief = await tool($, 'epicBrief', { issue: 40, sub: 44, role: 'implementer' })
  expect(brief.isError).toBe(true)
  expect(brief.text).toContain('different branches')
  expect(brief.text).toContain('Nothing was written')
  const move = await tool($, 'epicIssue', { issue: 40, sub: 44, state: 'implementing', worker: 'd4' })
  expect(move.isError).toBe(true)
  expect(move.text).toContain('different branches')
  expect(w.epic()?.issues['44']).toMatchObject({ state: 'waiting' })
  expect(w.epic()?.issues['44']?.stackedOn).toBeUndefined()
  setIssues(w, ...subs({ stackedOn: 41 }))
  expect((await tool($, 'epicNext', { issue: 40 })).text).toMatch(/Can start stacked[^\n]*#44 "UI" on #43 \(PR #14\)/)
  const stacked = await tool($, 'epicBrief', { issue: 40, sub: 44, role: 'implementer' })
  expect(stacked.isError).toBe(false)
  expect(commandOf(stacked.text)).toContain('--base-branch origin/issue-43')
  expect(w.epic()?.issues['44']?.stackedOn).toBe(43)
})

test('epicBrief for a stackable issue branches from the head of the blocker PR and records stackedOn, and only then can it start', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  // Before the blocker has a PR: no brief and no start.
  const tooEarly = await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })
  expect(tooEarly.isError).toBe(true)
  expect(tooEarly.text).toMatch(/#41[\s\S]*waiting/)
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'implementing', worker: 'd1' })
  await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'reviewing', pr: 12, worker: 'r1' })
  w.s.prs[12] = head('issue-41')
  // A start with no stacked brief is refused and names the brief.
  const noBrief = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'implementing', worker: 'd2' })
  expect(noBrief.isError).toBe(true)
  expect(noBrief.text).toContain('#41')
  expect(noBrief.text).toContain('mcp__ndev__epicBrief')
  expect(w.epic()?.issues['42']?.state).toBe('waiting')
  const r = await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })
  expect(r.isError).toBe(false)
  expect(w.gh).toContain('pr-read 12')
  expect(commandOf(r.text)).toContain('--name 42-api --base-branch origin/issue-41 ')
  expect(r.text).toMatch(/stacked on #41[^\n]*PR #12/i)
  const brief = w.files.get(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-42-implementer.md`)!
  for (const part of ['Stacked on #41', 'PR #12', 'origin/issue-41', '--base issue-41']) expect(brief).toContain(part)
  expect(w.epic()?.issues['42']?.stackedOn).toBe(41)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'implementing', worker: 'd2', workspace: '/w/42-api' })).isError).toBe(false)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'implementing', stackedOn: 41 })
  expect((await tool($, 'epicStatus', {})).text).toMatch(/#42[^\n]*stacked on #41/)
  // An issue with no unmerged blocker keeps the default branch and no stack.
  const plain = await tool($, 'epicBrief', { issue: 40, sub: 43, role: 'implementer' })
  expect(commandOf(plain.text)).toContain('--base-branch origin/main ')
  expect(w.epic()?.issues['43']?.stackedOn).toBeUndefined()
  expect(w.files.get(`${ROOT}/.git/worktrees/x/ndev-epic/epic-40-43-implementer.md`)).not.toContain('Stacked')
})

test('epicBrief refuses to stack on a PR that GitHub says is merged or closed, and names the repair', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'verified', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41] }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41') }
  const merged = await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })
  expect(merged.isError).toBe(true)
  expect(merged.text).toMatch(/PR #12[\s\S]*merged[\s\S]*state "merged"/)
  expect(merged.text).toContain('Nothing was written')
  expect(w.epic()?.issues['42']?.stackedOn).toBeUndefined()
  w.s.prs[12] = { state: 'closed', merged: false, ...head('issue-41') }
  const closed = await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })
  expect(closed.isError).toBe(true)
  expect(closed.text).toMatch(/PR #12[\s\S]*closed/)
  w.s.prs[12] = head('issue-41')
  expect((await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })).isError).toBe(false)
})

test('the merge of a blocker names each issue stacked on it and the instruction for its worker, and keeps stackedOn', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'verified', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', stackedOn: 41 }), sub(43, { state: 'verified', pr: 14 }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41') }
  w.s.prs[14] = { state: 'closed', merged: true }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/Stacked on #41: #42/)
  for (const part of ['orca orchestration send --to dispatch:d2', 'git fetch origin', 'git merge origin/main', 'mcp__ndev__checkpoint', 'gh pr edit 13 --repo acme/w --base main', 'origin/issue-41']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['42']?.stackedOn).toBe(41)
  // A merge with nothing stacked on it says nothing of a stack.
  const plain = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'merged' })
  expect(plain.isError).toBe(false)
  expect(plain.text).not.toContain('Stacked on')
})

test('the merge of a blocker names a stacked sub-issue with no implementer and tells the coordinator to brief it again', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'verified', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], stackedOn: 41 }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41') }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('#42 (waiting, no PR recorded) has no implementer to tell')
  expect(r.text).toContain('mcp__ndev__epicBrief with issue 40, sub 42 and role "implementer"')
  expect(r.text).not.toContain('send its implementer')
  const fresh = await tool($, 'epicBrief', { issue: 40, sub: 42, role: 'implementer' })
  expect(fresh.isError).toBe(false)
  expect(fresh.text).toContain('--base-branch origin/main')
  expect(w.epic()?.issues['42']?.stackedOn).toBeUndefined()
})

test('the merge of a blocker tells the coordinator to unblock a blocked stacked sub-issue with no implementer before its new brief', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'verified', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], stackedOn: 41, state: 'blocked', previous: 'waiting', note: 'waits for a key' }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41') }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('#42 (blocked, no PR recorded) has no implementer to tell')
  expect(r.text).toContain('call mcp__ndev__epicIssue with issue 40, sub 42 and state "waiting", then call mcp__ndev__epicBrief with issue 40, sub 42')
})

test('merged refuses a stacked PR that a human merged into the branch of its open blocker, because main does not have it yet', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'reviewing', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', reviewer: 'r2', stackedOn: 41 }))
  w.s.prs[12] = head('issue-41')
  w.s.prs[13] = { state: 'closed', merged: true, base: { ref: 'issue-41' }, merged_at: '2026-11-02T00:00:00Z' }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged' })
  expect(r.isError).toBe(true)
  for (const part of ['PR #13', 'issue-41', 'PR #12 of #41', 'not merged', 'Nothing changed', 'merge PR #12']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['42']?.state).toBe('reviewing')
})

test('merged records a stacked PR when its blocker merged after it, because that merge carried it to main', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'merged', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', reviewer: 'r2', stackedOn: 41 }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41'), merged_at: '2026-11-03T00:00:00Z' }
  w.s.prs[13] = { state: 'closed', merged: true, base: { ref: 'issue-41' }, merged_at: '2026-11-02T00:00:00Z' }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged' })
  expect(r.isError).toBe(false)
  expect(w.epic()?.issues['42']?.state).toBe('merged')
})

test('a stacked PR merged into its blocker branch after the blocker merged is blocked, not merged, and the note names the repair', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'merged', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', reviewer: 'r2', stackedOn: 41 }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41'), merged_at: '2026-11-02T00:00:00Z' }
  w.s.prs[13] = { state: 'closed', merged: true, ...head('issue-42'), base: { ref: 'issue-41' }, merged_at: '2026-11-03T00:00:00Z' }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged' })
  expect(r.isError).toBe(true)
  for (const part of ['PR #13', 'issue-41', 'after PR #12', 'not on main', 'gh pr create --repo acme/w --base main --head issue-42', 'override']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'blocked', previous: 'reviewing' })
  expect(w.epic()?.issues['42']?.note).toContain('gh pr create --repo acme/w --base main --head issue-42')
  w.s.prs[15] = { state: 'closed', merged: true, base: { ref: 'main' } }
  const fixed = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged', pr: 15, override: 'the lost change of PR #13 merged again through PR #15' })
  expect(fixed.isError).toBe(false)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'merged', pr: 15 })
})

test('a stacked PR whose blocker PR closed without merging is blocked, and a second lost PR from blocked keeps the state it goes back to', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'reviewing', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', reviewer: 'r2', stackedOn: 41 }))
  w.s.prs[12] = { state: 'closed', merged: false, ...head('issue-41') }
  w.s.prs[13] = { state: 'closed', merged: true, ...head('issue-42'), base: { ref: 'issue-41' }, merged_at: '2026-11-02T00:00:00Z' }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged' })
  expect(r.isError).toBe(true)
  for (const part of ['PR #13', 'closed', 'not on main', 'gh pr create --repo acme/w --base main --head issue-42']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'blocked', previous: 'reviewing' })
  const history = w.epic()?.history.length
  w.s.prs[14] = { state: 'closed', merged: true, ...head('issue-42b'), base: { ref: 'issue-41' }, merged_at: '2026-11-04T00:00:00Z' }
  const again = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged', pr: 14, override: 'merged again' })
  expect(again.isError).toBe(true)
  for (const part of ['PR #14', 'Nothing changed', '--base main --head issue-42b']) expect(again.text).toContain(part)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'blocked', previous: 'reviewing', pr: 13 })
  expect(w.epic()?.history.length).toBe(history)
})

test('a blocked sub-issue takes a new PR only while its PR is lost: an unblock and a new block end that', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'merged', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', reviewer: 'r2', stackedOn: 41 }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41'), merged_at: '2026-11-02T00:00:00Z' }
  w.s.prs[13] = { state: 'closed', merged: true, ...head('issue-42'), base: { ref: 'issue-41' }, merged_at: '2026-11-03T00:00:00Z' }
  expect((await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged' })).isError).toBe(true)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'reviewing' })).isError).toBe(false)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'blocked', note: 'waiting for a human' })).isError).toBe(false)
  w.s.prs[15] = { state: 'closed', merged: true, base: { ref: 'main' } }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'merged', pr: 15, override: 'swap' })
  expect(r.isError).toBe(true)
  for (const part of ['PR #13', 'PR #15', 'Nothing changed']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'blocked', pr: 13 })
})

test('merged refuses a PR merged into a branch that is not the default branch and not the branch of its blocker', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'reviewing', pr: 12, reviewer: 'r1' }))
  w.s.prs[12] = { state: 'closed', merged: true, ...head('issue-41'), base: { ref: 'release' } }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged' })
  expect(r.isError).toBe(true)
  for (const part of ['PR #12', '"release"', '"main"', 'Nothing changed', 'gh pr create --repo acme/w --base main --head issue-41']) expect(r.text).toContain(part)
  expect(w.epic()?.issues['41']?.state).toBe('reviewing')
})

test('verified refuses a PR whose base is not the default branch, and a pass clears stackedOn', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  setIssues(w, sub(41, { state: 'merged', pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, implementer: 'd2', stackedOn: 41 }), sub(43, { state: 'reviewing', pr: 14 }))
  w.s.prs[13] = { base: { ref: 'issue-41' } }
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/Failed:[^\n]*base[^\n]*"issue-41"[^\n]*"main"/)
  expect(r.text).toContain('gh pr edit 13 --repo acme/w --base main')
  expect(r.text).toContain('git merge origin/main')
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'reviewing', stackedOn: 41 })
  w.s.prs[13] = { base: { ref: 'main' } }
  const passed = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'verified', verdict: 'approve' })
  expect(passed.isError).toBe(false)
  expect(passed.text).toMatch(/Passed:[^\n]*base is main/)
  expect(w.epic()?.issues['42']?.state).toBe('verified')
  expect(w.epic()?.issues['42']?.stackedOn).toBeUndefined()
  // The rule holds for a PR that was never stacked, and a base that GitHub did not give is not a pass.
  w.s.prs[14] = { base: { ref: 'release' } }
  const other = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'verified', verdict: 'approve' })
  expect(other.isError).toBe(true)
  expect(other.text).toMatch(/Failed:[^\n]*"release"/)
  w.s.prs[14] = { base: undefined }
  const unread = await tool($, 'epicIssue', { issue: 40, sub: 43, state: 'verified', verdict: 'approve' })
  expect(unread.isError).toBe(true)
  expect(unread.text).toMatch(/Not run:[^\n]*base/)
})

test('verified refuses a stacked PR while its blocker is not merged in the record, also when its base is the default branch', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const subs = (state: SubIssue['state']) => [sub(41, { state, pr: 12 }), sub(42, { key: 'api', title: 'API', blockedBy: [41], state: 'reviewing', pr: 13, stackedOn: 41 })]
  setIssues(w, ...subs('verified'))
  const r = await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/Failed:[^\n]*stacked on #41[^\n]*"verified"/)
  expect(r.text).toContain('state "merged"')
  expect(w.epic()?.issues['42']).toMatchObject({ state: 'reviewing', stackedOn: 41 })
  setIssues(w, ...subs('merged'))
  expect((await tool($, 'epicIssue', { issue: 40, sub: 42, state: 'verified', verdict: 'approve' })).isError).toBe(false)
})


for (const name of ['epicStarted', 'epicPhase']) {
  test(`${name} reports its epic and repair when the workflow body fails`, async ($, on) => {
    const w = engine(on)
    await start($)
    await tool($, 'epicStarted', { issue: 40 })
    Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
    const args = name === 'epicPhase' ? { issue: 40, finished: 'framing', evidence: 'Notes', aim: 'Finish the epic', sources: ['no source: a test'], files: ['docs/core-idea.md'] } : { issue: 40 }
    const result = await tool($, name, args)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('issue #40')
    expect(result.text).toContain('kind=throw')
    expect(result.text).toContain('clock.now')
    expect(result.text).toContain('Repair: call epicStatus')
    const entry = [...w.files.entries()].find(([path]) => path.endsWith('/ndev-live-issue-40.json'))
    const calls = JSON.parse(entry?.[1] ?? '{}').calls ?? []
    expect(calls.some((call: { tool: string; outcome: string }) => call.tool === name && call.outcome === 'failed')).toBe(true)
  })
}


for (const [name, args, damage] of [
  ['epicStatus', {}, { issues: { '41': null } }],
  ['epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 }, { roles: null }],
] as const) {
  test(`${name} failure records the owning epic rather than a missing or subordinate target`, async ($, on) => {
    const w = engine(on)
    await start($)
    if (name === 'epicBrief') await planned($)
    else await tool($, 'epicStarted', { issue: 40 })
    const stored = JSON.parse(w.files.get(EPIC_FILE(40))!)
    w.files.set(EPIC_FILE(40), JSON.stringify({ ...stored, ...damage }))
    const result = await tool($, name, args)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('issue #40')
    expect(result.text).toContain('kind=throw')
    expect(result.text).toContain('Repair: call epicStatus')
    const entry = [...w.files.entries()].find(([path]) => path.endsWith('/ndev-live-issue-40.json'))
    expect(JSON.parse(entry?.[1] ?? '{}').calls?.some((call: { tool: string; outcome: string }) => call.tool === name && call.outcome === 'failed')).toBe(true)
  })
}

for (const [name, args] of [
  ['epicStatus', {}],
  ['epicBrief', { issue: 40, sub: 41, role: 'reviewer', pr: 12 }],
] as const) {
  test(`issue 151: ${name} refuses an epic record whose issues field is null at the load, naming the record, the field and the repair`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = engine(on)
    await start($)
    if (name === 'epicBrief') await planned($)
    else await tool($, 'epicStarted', { issue: 40 })
    const stored = JSON.parse(w.files.get(EPIC_FILE(40))!)
    w.files.set(EPIC_FILE(40), JSON.stringify({ ...stored, issues: null }))
    const result = await tool($, name, args)
    expect(result.isError).toBe(true)
    expect(result.text).toContain(EPIC_FILE(40))
    expect(result.text).toContain('"issues"')
    expect(result.text).toContain('null')
    expect(result.text).toContain('Repair:')
    expect(result.text).not.toContain('TypeError')
    expect(result.text).not.toContain('kind=throw')
  })
}

test('deadline debt tools preserve retries and require a reasoned ruling', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40, posture: 'deadline' })
  const event = { issue: 40, key: 'deadline-ci', kind: 'skipped-check', check: 'ci', note: 'Owner deferred CI' }
  expect((await tool($, 'epicDebt', event)).isError).toBe(false)
  expect((await tool($, 'epicDebt', event)).isError).toBe(false)
  expect(w.epic()?.debts?.length).toBe(1)
  expect((await tool($, 'epicDebtRuling', { issue: 40, key: 'deadline-ci', ruling: { verdict: 'accepted' } })).isError).toBe(true)
  expect((await tool($, 'epicDebtRuling', { issue: 40, key: 'deadline-ci', ruling: { verdict: 'accepted', reason: 'Owner accepts risk' } })).isError).toBe(false)
  expect((await tool($, 'epicStatus', { issue: 40 })).text).toContain('Owner accepts risk')
})

test('an unreviewed SDK merge needs an override and records all omitted gates', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), issues: withIssues(sub(41, { state: 'implementing' })) }))
  w.s.prs[12] = { state: 'closed', merged: true }
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged', pr: 12 })).isError).toBe(true)
  expect((await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged', pr: 12, override: 'Owner requested emergency merge' })).isError).toBe(false)
  expect(w.epic()?.debts?.map(debt => debt.kind)).toEqual(['merge-without-review', 'skipped-check', 'gate-override'])
})

test('issue 256: epicDebt refuses a done epic, names the epic and changes nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), state: 'done' }))
  const before = w.files.get(EPIC_FILE(40))
  const r = await tool($, 'epicDebt', { issue: 40, key: 'late', kind: 'gate-override', note: 'Recorded after done' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/late.*#40 is done/)
  expect(r.text).toContain('Repair:')
  expect(r.text).not.toContain('kind=throw')
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
})

test('issue 248: epicDebt caps open debt at 4, names the debts to rule on, and a ruling frees a place', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const owe = (key: string) => tool($, 'epicDebt', { issue: 40, key, kind: 'gate-override', note: `Override ${key}` })
  for (const key of ['d1', 'd2', 'd3', 'd4']) expect((await owe(key)).isError).toBe(false)
  const before = w.files.get(EPIC_FILE(40))
  const refused = await owe('d5')
  expect(refused.isError).toBe(true)
  expect(refused.text).toMatch(/d5.*4 open debts.*cap is 4/)
  expect(refused.text).toMatch(/Repair: .*d1, d2, d3, d4/)
  expect(refused.text).not.toContain('kind=throw')
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
  expect((await owe('d4')).isError).toBe(false)
  expect((await tool($, 'epicDebtRuling', { issue: 40, key: 'd1', ruling: { verdict: 'accepted', reason: 'The owner accepts it' } })).isError).toBe(false)
  expect((await owe('d5')).isError).toBe(false)
})

test('issue 248: an SDK merge that would pass the debt cap records nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await planned($)
  const debts = ['d1', 'd2'].map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), debts, issues: withIssues(sub(41, { state: 'implementing' })) }))
  w.s.prs[12] = { state: 'closed', merged: true }
  const before = w.files.get(EPIC_FILE(40))
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'merged', pr: 12, override: 'Owner merged it' })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/merge:41:pr:12:review, merge:41:pr:12:verification, merge:41:override.*2 open debts.*cap is 4/)
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
})

test('issue 248: /flow epic skip at the debt cap is refused and the epic stays in its phase', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await tool($, 'epicStarted', { issue: 40 })
  const debts = ['d1', 'd2', 'd3', 'd4'].map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), debts }))
  const before = w.files.get(EPIC_FILE(40))
  const out = await command($, w, 'epic skip research is done already')
  expect(out).toMatch(/^\/flow epic skip: Refused: .*cap is 4.*Repair: /s)
  expect(w.files.get(EPIC_FILE(40))).toBe(before)
})

test('issue 248: verify with skipped checks needs one place under the debt cap, as the model counts it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on)
  await start($)
  await reviewing($, w)
  const open = (keys: string[]) => keys.map(key => ({ key, kind: 'gate-override', note: `Override ${key}`, at: 1 }))
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), debts: open(['d1', 'd2', 'd3', 'd4']) }))
  w.s.checks = { check_runs: [...['a', 'b', 'c', 'd', 'e'].map(name => ({ name, status: 'completed', conclusion: 'skipped' })), { name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [] }
  const refused = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toMatch(/4 open debts.*cap is 4/)
  w.files.set(EPIC_FILE(40), JSON.stringify({ ...w.epic(), debts: open(['d1', 'd2', 'd3']) }))
  const r = await tool($, 'epicIssue', { issue: 40, sub: 41, state: 'verified', verdict: 'approve' })
  expect(r.isError).toBe(false)
  expect(w.epic()?.debts?.filter(debt => debt.key.startsWith('verify:41:')).length).toBe(5)
})
