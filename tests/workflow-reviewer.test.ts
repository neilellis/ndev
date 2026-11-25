// Workflow tests: The reviewer, the remember hook and the change types. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, engine, settle, start, tool, command, toReview, TWO_AXES, orcaVerbs, SHOTS, MERGED_PR } from './workflow-harness'

test('finishedDevelopment starts the reviewer before it answers, on the worktree and the base branch', async ($, on) => {
  const w = engine(on)
  const r = await toReview($, w)
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.subagentType).toBe('ndev:diff-reviewer')
  expect(w.spawns[0]!.cwd).toBe(ROOT)
  expect(w.spawns[0]!.prompt).toContain('origin/main')
  expect(w.spawns[0]!.prompt).toContain('#7')
  expect(w.spawns[0]!.prompt).toContain('Read the issue with ndev github issue-read 7.')
  expect(w.spawns[0]!.prompt).not.toContain('gh.sh')
  expect(r.text).toContain('Do not start another')
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('in heavy mode the reviewer is told to check the work-heavy requirements too', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' } })
  await toReview($, w)
  expect(w.spawns[0]!.prompt).toContain('work-heavy')
})

test('in heavy mode two reviewers start, one for each axis, and in light mode one', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' } })
  await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer', 'ndev:diff-reviewer'])
  expect(w.spawns[0]!.prompt).toContain('axis: standards')
  expect(w.spawns[1]!.prompt).toContain('axis: specification')
  expect(w.spawns[1]!.prompt).not.toContain('axis: standards')
})

test('a reviewer that is refused leaves a clear instruction, and the commit stays', async ($, on) => {
  const w = engine(on)
  w.s.spawnDeny = 'a limit of the host'
  const r = await toReview($, w)
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('reviewing')
  expect(r.text).toContain('a limit of the host')
  expect(r.text).toContain('ndev:diff-reviewer')
})

test('the answer of the reviewer is recorded and reaches the agent', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'reviewer-1' } } } })
  await start($, w)
  await $.turn.complete({ agentId: 'reviewer-1', answer: 'Critical: a.ts:3 loses the error' } as never)
  await settle()
  expect(w.state()?.hooks?.review?.answer).toContain('a.ts:3')
  expect(w.prompts.join('\n')).toContain('a.ts:3')
  expect(w.prompts.join('\n')).toContain('finishedReview')
})

test('the second reviewer has its own answer, and it reaches the agent too', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2' } } as never })
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: 'Critical: the issue asks for b.ts:9' } as never)
  await settle()
  expect((w.state() as unknown as { reviewSpec: { answer?: string } }).reviewSpec.answer).toContain('b.ts:9')
  expect(w.state()?.hooks?.review?.answer).toBe('standards are fine')
  expect(w.prompts.join('\n')).toContain('b.ts:9')
})

test('the report of each axis names that axis and what it is for', async ($, on) => {
  const w = engine(on, TWO_AXES)
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: 'Critical: the issue asks for b.ts:9' } as never)
  await settle()
  await $.turn.complete({ agentId: 'r-1', answer: 'Important: a.ts:3 breaks a written rule' } as never)
  await settle()
  const [spec, standards] = w.prompts.filter(p => p.includes('b.ts:9') || p.includes('a.ts:3'))
  expect(spec).toContain('The specification review of')
  expect(spec).toContain('whether the diff does all that the issue, the plan and the interview answers ask')
  expect(spec).toContain('The standards review gives its own report')
  expect(spec).toContain('when both reports have come')
  expect(standards).toContain('The standards review of')
  expect(standards).toContain('the rules that the repository wrote down')
  expect(standards).toContain('The specification review gives its own report')
})

test('the one reviewer of a light change says that it covers both questions', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1' } } } })
  await start($, w)
  await $.turn.complete({ agentId: 'r-1', answer: 'Critical: a.ts:3 loses the error' } as never)
  await settle()
  const said = w.prompts.join('\n')
  expect(said).toContain('The code review of')
  expect(said).toContain('the written rules of the repository and the issue')
  expect(said).not.toContain('gives its own report')
})

test('a failed axis is named, and its repair carries the question of that axis', async ($, on) => {
  const w = engine(on, TWO_AXES)
  await start($, w)
  await $.turn.complete({ agentId: 'r-2', answer: '', reason: 'error' } as never)
  await settle()
  const said = w.prompts.join('\n')
  expect(said).toContain('The specification review of')
  expect(said).toContain('failed')
  expect(said).toContain('Review axis: specification.')
})

test('a resume names the axis of each answer', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2', answer: 'the spec is met' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(said).toContain('The standards review answered:\nstandards are fine')
  expect(said).toContain('The specification review answered:\nthe spec is met')
})

test('a resume in heavy mode gives both answers, and does not start the reviewers again', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'standards are fine' } }, reviewSpec: { agentId: 'r-2', answer: 'the spec is met' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(said).toContain('standards are fine')
  expect(said).toContain('the spec is met')
  expect(w.spawns).toHaveLength(0)
})

test('the turn of another agent is not taken for the review', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  await $.turn.complete({ agentId: 'other', answer: 'nothing to see' } as never)
  await settle()
  expect(w.state()?.hooks?.review?.answer).toBeUndefined()
})

test('a /flow goto reviewing starts the reviewer too', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12] } })
  await start($, w)
  await command($, 'goto reviewing go back')
  expect(w.spawns).toHaveLength(1)
})

test('a resume in reviewing starts the review again when its answer was lost in a restart', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'gone' } } } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(w.spawns).toHaveLength(1)
  expect(r.text).toContain('started the code review')
})

test('a resume does not start a review that has answered', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'gone', answer: 'clean' } } } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(w.spawns).toHaveLength(0)
  expect(r.text).toContain('clean')
})

// ---- The remember hook comes before the push ----

test('finishedDevelopment fires the remember hook with the review, and names the docs and the wiki', async ($, on) => {
  const w = engine(on)
  const r = await toReview($, w)
  expect(w.state()?.hooks?.remember?.firedAt).toBeDefined()
  expect(r.text).toContain('ndev:remember')
  expect(r.text).toContain('ndev:docs-sync')
  expect(r.text).toContain('ndev:dev-wiki')
})

test('finishedReview with no remember result pushes nothing; with one it pushes and records it', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  w.s.dirty = []
  const refused = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('remembered')
  expect(w.pushes).toHaveLength(0)
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'wiki page updated' })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBeGreaterThan(0)
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

test('a formal_project cannot skip the remember hook at the push', async ($, on) => {
  const w = engine(on, { config: { projectLevel: 'formal_project' } })
  await toReview($, w)
  w.s.dirty = []
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'skipped: no time' })
  expect(r.isError).toBe(true)
  expect(w.pushes).toHaveLength(0)
})

test('done takes the earlier remember result, and asks for it only after a skipped review', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', prs: [12], hooks: { remember: { firedAt: 1, result: 'wiki page updated' } } } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('call done')
  await tool($, 'done', { message: 'finished' })
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

// ---- Change types ----

test('checkpoint records the declared types and those of the changed paths, and they accumulate', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['lib/a.ts'], changeTypes: ['web'] })).isError).toBe(false)
  expect(w.state()?.changeTypes).toEqual(['web', 'backend'])
  w.s.names = ['README.md']
  w.s.dirty = [' M README.md']
  await tool($, 'checkpoint', { message: 'n', files: ['README.md'] })
  expect(w.state()?.changeTypes).toEqual(['web', 'backend', 'docs'])
})

test('with no types given, the paths decide, and the read costs no GitHub call', async ($, on) => {
  const w = engine(on, { names: ['src/Card.tsx', 'src/Card.test.tsx'] })
  await start($, w)
  w.s.dirty = [' M src/Card.tsx']
  const before = w.gh.length
  await tool($, 'checkpoint', { message: 'm', files: ['src/Card.tsx'] })
  expect(w.state()?.changeTypes).toEqual(['web', 'tests'])
  expect(w.state()?.webFiles).toEqual(['src/Card.tsx'])
  // Only the note for the human about the check scripts, which each commit in this fake sends, and the change map of the push.
  expect(w.gh.slice(before).filter(call => !call.includes('gh.sh comment') && !call.includes('gh.sh pr-read 12') && !call.includes('gh.sh pr-edit 12'))).toEqual([])
})

test('the checks get NDEV_CHANGE_TYPES: the declared types, those recorded, and those of each path that differs from the merge base', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts', 'README.md'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts', ' M README.md']
  await tool($, 'checkpoint', { message: 'm', files: ['lib/a.ts', 'README.md'], changeTypes: ['web'] })
  for (const check of ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh']) expect(w.s.checkEnv[check]?.NDEV_CHANGE_TYPES).toBe('web,backend,docs')
  // The checks run before the commit: a staged path is the branch's change already, and a recorded type stays.
  w.s.names = ['lib/a.ts', 'README.md', 'supabase/migrations/1_a.sql']
  w.s.dirty = ['A  supabase/migrations/1_a.sql']
  await tool($, 'checkpoint', { message: 'n', files: ['supabase/migrations/1_a.sql'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_CHANGE_TYPES).toBe('web,backend,database,docs')
})

test('when the branch paths cannot be read, the checks get no NDEV_CHANGE_TYPES and the answer says the scripts read their own diff', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.diffFails = 'fatal: bad revision'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes: ['web'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_CHANGE_TYPES).toBeUndefined()
  expect(r.text).toContain('NDEV_CHANGE_TYPES was not set')
  expect(r.text).toContain('fatal: bad revision')
})

test('a type that is not in the list is refused, and nothing is committed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  for (const changeTypes of [['frontend'], 'web']) {
    const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('web, backend, database, docs, tests, config')
  }
  const d = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], changeTypes: ['frontend'] })
  expect(d.isError).toBe(true)
  expect(w.commits).toHaveLength(0)
  expect(w.state()?.state).toBe('developing')
})

for (const mode of ['light', 'heavy'] as const) {
  test(`finishedDevelopment in ${mode} mode gives the reviewer and the next step the change types`, async ($, on) => {
    const w = engine(on, { config: { mode }, names: ['app/cart/page.tsx', 'server/api.py'] })
    await start($, w)
    w.s.dirty = [' M app/cart/page.tsx']
    const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['app/cart/page.tsx'], changeTypes: ['database'] })
    expect(r.isError).toBe(false)
    expect(w.state()?.changeTypes).toEqual(['database', 'web', 'backend'])
    expect(w.spawns[0]!.prompt).toContain('Web:')
    expect(w.spawns[0]!.prompt).toContain('Backend:')
    expect(w.spawns[0]!.prompt).toContain('Database:')
    if (mode === 'heavy') {
      expect(r.text).toContain('screenshot tool')
      expect(r.text).toContain('/cart')
    } else {
      expect(r.text).not.toContain('screenshot tool')
      expect(r.text).not.toContain('mcp__ndev__screenshot')
    }
    expect(r.text).toContain('local database')
  })
}

test('a documents-only change gets the short review, and a code change that declares docs does not', async ($, on) => {
  const w = engine(on, { names: ['README.md'] })
  await start($, w)
  w.s.dirty = [' M README.md']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['README.md'], changeTypes: ['docs'] })
  expect(w.spawns[0]!.prompt).toContain('documents only')
  expect(r.text).toContain('deadcode as "none: documents only"')
  expect(r.text).not.toContain('dead-code sweep')
})

test('a declaration can add a type and cannot take the code out of the review', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  w.s.dirty = [' M lib/a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['lib/a.ts'], changeTypes: ['docs'] })
  expect(w.spawns[0]!.prompt).not.toContain('documents only')
  expect(r.text).toContain('dead-code sweep')
})

test('a diff that cannot be read gives the full review and says so, until a read succeeds', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12], changeTypes: ['docs'] }, names: ['README.md'] })
  await start($, w)
  w.s.diffFails = 'fatal: bad revision'
  await command($, 'goto reviewing go back')
  expect(w.spawns[0]!.prompt).not.toContain('documents only')
  expect(w.state()?.typesUnread).toContain('fatal: bad revision')
  expect((await tool($, 'status')).text).toContain('dead-code sweep')
  w.s.dirty = [' M README.md']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['README.md'] })
  expect(r.text).toContain('fatal: bad revision')
  expect(r.text).toContain('git fetch origin')
  w.s.diffFails = ''
  w.s.dirty = [' M README.md']
  const good = await tool($, 'checkpoint', { message: 'n', files: ['README.md'] })
  expect(w.state()?.typesUnread).toBeUndefined()
  expect(good.text).toContain('deadcode as "none: documents only"')
})

test('a /flow goto reviewing gives the reviewer the types of the diff', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12] }, names: ['supabase/migrations/1_a.sql'] })
  await start($, w)
  await command($, 'goto reviewing go back')
  expect(w.spawns[0]!.prompt).toContain('Database:')
  expect(w.state()?.changeTypes).toEqual(['database'])
})

test('a declared web change goes to the smoke stage although the paths show none', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', prs: [12], changeTypes: ['web', 'backend'] }, names: ['server/render.py'] })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(w.state()?.state).toBe('smoke')
  expect(r.text).toContain('screenshot tool')
})

test('status names the change types', async ($, on) => {
  const w = engine(on, { wf: { changeTypes: ['web', 'docs'] } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('Change types: web, docs')
})

test('screenshot reads a login page from the host and path of the address, not from its query', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12] } })
  await start($, w)
  w.s.pageUrl = 'https://app.test/login'
  const went = await tool($, 'screenshot', { url: 'https://app.test/go?to=https://app.test/login', viewports: ['390x844'], schemes: ['light'] })
  expect(went.isError).toBe(true)
  expect(went.text).toContain('went to the login page')
  w.s.pageUrl = 'https://app.test/help?from=/login'
  const help = await tool($, 'screenshot', { url: 'https://app.test/help?from=/login', viewports: ['390x844'], schemes: ['light'] })
  expect(help.text).toContain('Saved 1 image of')
  expect(help.isError).toBe(false)
})

test('screenshot takes each viewport in each scheme, saves under the git folder and closes its tab', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const before = w.gh.length
  const r = await tool($, 'screenshot', { url: 'http://localhost:3000/cart' })
  expect(r.text).toContain('Saved 6 images')
  expect(r.isError).toBe(false)
  expect(w.copies).toHaveLength(6)
  for (const view of ['390x844', '820x1180', '1440x900']) {
    for (const scheme of ['light', 'dark']) {
      const file = `${SHOTS}/localhost-3000-cart-${view}-${scheme}.png`
      expect(w.copies).toContain(file)
      expect(r.text).toContain(file)
    }
  }
  expect(w.orcaCalls.at(-1)!.slice(0, 2)).toEqual(['tab', 'close'])
  expect(w.orcaCalls.at(-1)).toContain('page-1')
  expect(orcaVerbs(w).filter(v => v === 'tab create')).toHaveLength(1)
  expect(w.gh.slice(before)).toEqual([])
  expect(r.text).toContain('Read')
  // It changes no state and needs no save.
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.rev).toBe(1)
})

test('finishedReview on a PR that a human merged pushes nothing and names done', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  w.s.dirty = [' M b.ts']
  w.s.pr = { ...(w.s.pr as object), ...MERGED_PR }
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('call done')
  expect(w.pushes).toHaveLength(0)
  expect(w.state()?.state).toBe('reviewing')
})

test('finishedReview on a PR closed with no merge pushes nothing and names the reopen', async ($, on) => {
  const w = engine(on)
  await toReview($, w)
  w.s.dirty = []
  w.s.pr = { ...(w.s.pr as object), state: 'closed', merged: false }
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is closed with no merge')
  expect(r.text).toContain('gh pr reopen 12')
  expect(w.pushes).toHaveLength(0)
  expect(w.state()?.state).toBe('reviewing')
})
