import { expect, test } from 'claude-code/testing'

import { ATTEMPT_LIMIT, afterSkip, afterStarted, afterTool, flowPicture, hooksFiredBy, orcaView, mayCommitToBase, mayMerge, maySkipReview, needsPlanSignOff, needsSmoke, nextStep } from '../hooks/workflow/machine'
import type { Facts, State, Tool } from '../hooks/workflow/machine'
import { inferChangeTypes, isDocsOnly, pagesOf, reviewerBrief } from '../hooks/workflow/change-types'

const facts = (extra: Partial<Facts> = {}): Facts => ({ mode: 'heavy', steering: 'auto', ...extra })
const ACTIVE: State[] = ['setup', 'planning', 'developing', 'reviewing', 'ci', 'smoke', 'finishing', 'revising']

// Each legal move, written out so that the table in the code is not its own expected value.
const MOVES: [State, Tool, State, Partial<Facts>?][] = [
  ['planning', 'finishedPlan', 'developing'],
  ['developing', 'finishedDevelopment', 'reviewing'],
  ['reviewing', 'finishedReview', 'ci'],
  ['ci', 'finishedChecks', 'finishing'],
  ['ci', 'finishedChecks', 'smoke', { smoke: true }],
  ['smoke', 'finishedSmoke', 'finishing'],
  ['finishing', 'done', 'done'],
  ['finishing', 'done', 'revising', { feedback: true }],
  ['revising', 'finishedRevision', 'ci'],
  ['developing', 'checkpoint', 'developing'],
  ['reviewing', 'checkpoint', 'reviewing'],
  ['revising', 'checkpoint', 'revising'],
  ['ci', 'checkpoint', 'ci'],
  ['smoke', 'checkpoint', 'ci'],
  ['finishing', 'checkpoint', 'ci'],
  ['smoke', 'checkpoint', 'smoke', { docsOnly: true }],
  ['finishing', 'checkpoint', 'finishing', { docsOnly: true }],
]

test('each legal move goes to the state the flow chart shows', () => {
  for (const [from, tool, to, extra] of MOVES) {
    expect(afterTool({ state: from }, tool, facts(extra))).toEqual({ state: to })
  }
})

test('a tool called in the wrong state changes nothing, and the message names the state and the valid tool', () => {
  const r = afterTool({ state: 'developing' }, 'done', facts())
  expect(r).toEqual({ refused: expect.stringContaining('developing') })
  expect((r as { refused: string }).refused).toContain('finishedDevelopment')
})

test('only the moves in the table are legal', () => {
  const tools: Tool[] = ['finishedPlan', 'finishedDevelopment', 'finishedReview', 'finishedChecks', 'finishedSmoke', 'finishedRevision', 'done', 'checkpoint']
  const legal = new Set(MOVES.map(([from, tool]) => `${from}/${tool}`))
  for (const from of ACTIVE) {
    for (const tool of tools) {
      const r = afterTool({ state: from }, tool, facts())
      expect(['state' in r, `${from}/${tool}`]).toEqual([legal.has(`${from}/${tool}`), `${from}/${tool}`])
    }
  }
})

test('the interactive plan waits for sign-off in blocked, and resumes in developing', () => {
  expect(afterTool({ state: 'planning' }, 'finishedPlan', facts({ steering: 'interactive' }))).toEqual({ state: 'blocked', previous: 'developing' })
})

test('blocked keeps the previous state, and unblocked restores it', () => {
  for (const from of ACTIVE) {
    expect(afterTool({ state: from }, 'blocked', facts())).toEqual({ state: 'blocked', previous: from })
    expect(afterTool({ state: 'blocked', previous: from }, 'unblocked', facts())).toEqual({ state: from })
  }
})

test('blocked refuses when already blocked or done, and unblocked refuses when not blocked', () => {
  expect('refused' in afterTool({ state: 'blocked', previous: 'ci' }, 'blocked', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'done' }, 'blocked', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'ci' }, 'unblocked', facts())).toBe(true)
})

test('no phase tool moves a blocked workflow', () => {
  for (const tool of ['finishedDevelopment', 'checkpoint', 'done'] as Tool[]) {
    const r = afterTool({ state: 'blocked', previous: 'developing' }, tool, facts())
    expect((r as { refused: string }).refused).toContain('unblocked')
  }
})

test("followUp('this_agent') sends a state past development back to developing", () => {
  for (const from of ['reviewing', 'ci', 'smoke', 'finishing'] as State[]) {
    expect(afterTool({ state: from }, 'followUpThisAgent', facts())).toEqual({ state: 'developing' })
  }
  for (const from of ['planning', 'developing', 'revising'] as State[]) {
    expect(afterTool({ state: from }, 'followUpThisAgent', facts())).toEqual({ state: from })
  }
  expect('refused' in afterTool({ state: 'done' }, 'followUpThisAgent', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'setup' }, 'followUpThisAgent', facts())).toBe(true)
})

test('other follow-ups keep the state; only an issue is allowed once done', () => {
  expect(afterTool({ state: 'ci' }, 'followUpOther', facts())).toEqual({ state: 'ci' })
  expect('refused' in afterTool({ state: 'done' }, 'followUpOther', facts())).toBe(true)
  expect(afterTool({ state: 'done' }, 'followUpIssue', facts())).toEqual({ state: 'done' })
  expect(afterTool({ state: 'blocked', previous: 'ci' }, 'followUpIssue', facts())).toEqual({ state: 'blocked', previous: 'ci' })
})

test('started: the first state follows the mode, and the gates come first', () => {
  expect(afterStarted(undefined, { mode: 'heavy' })).toEqual({ state: 'planning' })
  expect(afterStarted(undefined, { mode: 'light' })).toEqual({ state: 'developing' })
  expect(afterStarted(undefined, { mode: 'heavy', scriptsMissing: true })).toEqual({ state: 'setup' })
  expect(afterStarted(undefined, { mode: 'heavy', blockerOpen: true })).toEqual({ state: 'blocked', previous: 'planning' })
})

test('started: setup goes on once the scripts exist; a resume keeps the state', () => {
  expect(afterStarted({ state: 'setup' }, { mode: 'light' })).toEqual({ state: 'developing' })
  expect(afterStarted({ state: 'setup' }, { mode: 'light', scriptsMissing: true })).toEqual({ state: 'setup' })
  expect(afterStarted({ state: 'ci' }, { mode: 'heavy' })).toEqual({ state: 'ci' })
  expect(afterStarted({ state: 'blocked', previous: 'ci' }, { mode: 'heavy' })).toEqual({ state: 'blocked', previous: 'ci' })
})

test('started: done stays done, unless new feedback has arrived', () => {
  expect(afterStarted({ state: 'done' }, { mode: 'heavy' })).toEqual({ state: 'done' })
  expect(afterStarted({ state: 'done' }, { mode: 'heavy', feedback: true })).toEqual({ state: 'revising' })
})

test('smoke: a web change always needs it; a preview needs it only in heavy mode', () => {
  expect(needsSmoke('light', ['src/app/page.tsx'], [])).toBe(true)
  expect(needsSmoke('heavy', ['src/app/page.css'], [])).toBe(true)
  expect(needsSmoke('light', ['scripts/a.sh'], ['Vercel Preview'])).toBe(false)
  expect(needsSmoke('heavy', ['scripts/a.sh'], ['Vercel Preview'])).toBe(true)
  expect(needsSmoke('heavy', ['scripts/a.sh'], ['test'])).toBe(false)
})

test('the next step names the tool to call, and it follows the settings', () => {
  const tools: [State, string][] = [['setup', 'started'], ['planning', 'finishedPlan'], ['developing', 'finishedDevelopment'], ['reviewing', 'finishedReview'], ['ci', 'finishedChecks'], ['smoke', 'finishedSmoke'], ['finishing', 'done'], ['revising', 'finishedRevision'], ['blocked', 'unblocked']]
  for (const [state, tool] of tools) expect(nextStep(state, facts())).toContain(tool)
  expect(nextStep('reviewing', facts({ mode: 'heavy' }))).toContain('two-axis')
  expect(nextStep('reviewing', facts({ mode: 'light' }))).toContain('independent review')
  expect(nextStep('developing', facts({ steering: 'interactive' }))).toContain('Report')
  expect(nextStep('developing', facts({ steering: 'auto' }))).not.toContain('Report')
  expect(nextStep('done', facts())).toContain('human')
})

test('the attempt limit is three, as the flow chart says', () => {
  expect(ATTEMPT_LIMIT).toBe(3)
})

test('the project level sets who merges', () => {
  expect(mayMerge('straw_man')).toBe(true)
  expect(mayMerge('poc')).toBe(true)
  expect(mayMerge('small_project')).toBe(false)
  expect(mayMerge('formal_project')).toBe(false)
  expect(mayMerge(undefined)).toBe(false)
  expect(mayCommitToBase('straw_man')).toBe(true)
  expect(mayCommitToBase('poc')).toBe(false)
  expect(mayCommitToBase(undefined)).toBe(false)
})

test('the project level sets what may be skipped', () => {
  expect(maySkipReview('formal_project')).toBe(false)
  expect(maySkipReview('small_project')).toBe(true)
  expect(maySkipReview(undefined)).toBe(true)
  expect(maySkipReview('straw_man')).toBe(true)
  expect(needsPlanSignOff('interactive', 'straw_man')).toBe(false)
  expect(needsPlanSignOff('interactive', 'poc')).toBe(false)
  expect(needsPlanSignOff('interactive', 'small_project')).toBe(true)
  expect(needsPlanSignOff('auto', 'formal_project')).toBe(false)
})

test('a level that may merge has an interactive plan go straight on', () => {
  expect(afterTool({ state: 'planning' }, 'finishedPlan', facts({ steering: 'interactive', level: 'poc' }))).toEqual({ state: 'developing' })
})

test('the last step says who merges', () => {
  expect(nextStep('finishing', facts({ level: 'poc' }))).toContain('merges')
  expect(nextStep('done', facts({ level: 'formal_project' }))).toContain('human')
  expect(nextStep('done', facts({ level: 'straw_man' }))).not.toContain('human')
})

// ---- /ndev-workflow skip ----
test('skip moves on from each phase that has a next one', () => {
  const moves: [State, State][] = [
    ['planning', 'developing'], ['developing', 'reviewing'], ['reviewing', 'ci'], ['ci', 'finishing'], ['smoke', 'finishing'], ['revising', 'ci'],
  ]
  for (const [from, to] of moves) expect(afterSkip({ state: from }, 'heavy')).toEqual({ state: to })
})

test('skip of setup goes to the first phase of the mode', () => {
  expect(afterSkip({ state: 'setup' }, 'heavy')).toEqual({ state: 'planning' })
  expect(afterSkip({ state: 'setup' }, 'light')).toEqual({ state: 'developing' })
})

test('skip has no way past finishing, done or a block, and names what to do', () => {
  expect(afterSkip({ state: 'finishing' }, 'heavy')).toEqual({ refused: expect.stringContaining('goto done') })
  expect(afterSkip({ state: 'blocked', previous: 'ci' }, 'heavy')).toEqual({ refused: expect.stringContaining('unblock') })
  expect('refused' in afterSkip({ state: 'done' }, 'heavy')).toBe(true)
})

// ---- change types ----

test('the changed paths give the change types', () => {
  const cases: [string, string][] = [
    ['src/Card.tsx', 'web'], ['src/app/page.css', 'web'], ['public/index.html', 'web'],
    ['server/api.py', 'backend'], ['lib/a.ts', 'backend'], ['scripts/a.sh', 'backend'],
    ['supabase/migrations/1_a.sql', 'database'], ['prisma/schema.prisma', 'database'], ['db/migrations/2_b.py', 'database'],
    ['README.md', 'docs'], ['kb/guide.mdx', 'docs'],
    ['src/Card.test.tsx', 'tests'], ['tests/a.py', 'tests'], ['pkg/a_test.go', 'tests'], ['src/Card.stories.tsx', 'tests'],
    ['.github/workflows/ci.yml', 'config'], ['package.json', 'config'], ['pnpm-lock.yaml', 'config'], ['Dockerfile', 'config'], ['.gitignore', 'config'],
  ]
  for (const [path, type] of cases) expect([path, inferChangeTypes([path])]).toEqual([path, [type]])
  expect(inferChangeTypes(['README.md', 'lib/a.ts', 'README.md'])).toEqual(['backend', 'docs'])
  expect(inferChangeTypes([])).toEqual([])
})

test('a change is documents only when each type is docs, and never when no type is known', () => {
  expect(isDocsOnly(['docs'])).toBe(true)
  expect(isDocsOnly(['docs', 'backend'])).toBe(false)
  expect(isDocsOnly([])).toBe(false)
})

test('the smoke decision and the web type are one notion: a test file is neither', () => {
  expect(needsSmoke('light', ['src/Card.test.tsx'], [])).toBe(false)
  expect(inferChangeTypes(['src/Card.tsx'])).toContain('web')
  expect(needsSmoke('light', ['src/Card.tsx'], [])).toBe(true)
})

test('the agent can declare a web change that the paths do not show, and the smoke stage follows', () => {
  expect(needsSmoke('light', ['server/render.py'], [], ['backend'])).toBe(false)
  expect(needsSmoke('light', ['server/render.py'], [], ['web', 'backend'])).toBe(true)
})

test('the page files give their routes', () => {
  expect(pagesOf(['src/app/page.tsx', 'app/(shop)/cart/page.tsx', 'pages/about.tsx', 'pages/blog/index.tsx', 'pages/_app.tsx', 'pages/api/x.tsx', 'src/Card.tsx'])).toEqual(['/', '/cart', '/about', '/blog'])
})

test('a review of a web change names the pages, the widths, the schemes and the tool', () => {
  const step = nextStep('reviewing', facts({ changeTypes: ['web'], webFiles: ['app/cart/page.tsx', 'src/Card.tsx'] }))
  expect(step).toContain('screenshot tool')
  expect(step).toContain('/cart')
  expect(step).toContain('src/Card.tsx')
  for (const word of ['390x844', '820x1180', '1440x900', 'light', 'dark']) expect(step).toContain(word)
  expect(step).toContain('not pushed')
  expect(step).toContain('ndev:responsive-check')
  expect(step).toContain('finishedReview')
})

test('a review with no web change asks for no screenshot', () => {
  for (const changeTypes of [undefined, ['backend'], ['docs']] as Facts['changeTypes'][]) expect(nextStep('reviewing', facts({ changeTypes }))).not.toContain('screenshot')
})

test('a review of documents only is shorter, has no dead-code sweep and keeps the remember hook', () => {
  const docs = nextStep('reviewing', facts({ changeTypes: ['docs'] }))
  const full = nextStep('reviewing', facts({ changeTypes: ['backend'] }))
  expect(docs.length).toBeLessThan(full.length)
  expect(full).toContain('dead-code sweep')
  expect(docs).not.toContain('dead-code sweep')
  expect(docs).toContain('deadcode as "none: documents only"')
  expect(docs).toContain('ndev:remember')
})

test('a review of a database change asks for the migration to run', () => {
  expect(nextStep('reviewing', facts({ changeTypes: ['database'] }))).toContain('local database')
  expect(nextStep('reviewing', facts({ changeTypes: ['backend'] }))).not.toContain('local database')
})

test('the smoke step asks for the screenshots only of a web change', () => {
  expect(nextStep('smoke', facts({ changeTypes: ['web'], webFiles: ['app/cart/page.tsx'] }))).toContain('screenshot tool')
  expect(nextStep('smoke', facts({ changeTypes: ['web'], webFiles: ['app/cart/page.tsx'] }))).toContain('/cart')
  expect(nextStep('smoke', facts({ changeTypes: ['backend'] }))).not.toContain('screenshot')
})

test('the reviewer gets one brief for each type, and a short one for documents only', () => {
  const both = reviewerBrief(['web', 'backend', 'database', 'tests', 'config']).join('\n')
  for (const word of ['Web:', 'Backend:', 'Database:', 'Tests:', 'Config:']) expect(both).toContain(word)
  const docs = reviewerBrief(['docs']).join('\n')
  expect(docs).toContain('documents only')
  expect(docs).not.toContain('Backend:')
  expect(reviewerBrief([])).toEqual([])
})

test('wait holds the previous state and returns to it, and only from an active state', () => {
  for (const from of ACTIVE) {
    expect(afterTool({ state: from }, 'wait', facts())).toEqual({ state: 'wait', previous: from })
    expect(afterTool({ state: 'wait', previous: from }, 'waitEnded', facts())).toEqual({ state: from })
  }
  expect('refused' in afterTool({ state: 'blocked', previous: 'ci' }, 'wait', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'done' }, 'wait', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'wait', previous: 'ci' }, 'wait', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'wait', previous: 'ci' }, 'blocked', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'wait', previous: 'ci' }, 'unblocked', facts())).toBe(true)
  expect('refused' in afterTool({ state: 'developing' }, 'waitEnded', facts())).toBe(true)
})

test('a return from wait fires no stage hook; a skip names /unblock; started leaves a dead wait', () => {
  expect(hooksFiredBy('wait', 'reviewing')).toEqual([])
  const skip = afterSkip({ state: 'wait', previous: 'ci' }, 'light')
  expect('refused' in skip && skip.refused).toContain('/unblock')
  expect(afterStarted({ state: 'wait', previous: 'ci' }, { mode: 'light' })).toEqual({ state: 'ci' })
})

test('the flow shows a wait at the state it holds; Orca shows what it waits for and asks no human', () => {
  const picture = flowPicture({ state: 'wait', previous: 'ci' }, ['developing', 'reviewing', 'ci'])
  expect(picture.steps.find(s => s.state === 'ci')?.mark).toBe('waiting')
  const view = orcaView({ issue: 7, prs: [1], state: 'wait', previous: 'ci', waiting: { what: 'the deploy' } })
  expect(view.comment).toContain('the deploy')
  expect(view.attention).toBe(false)
  expect(view.status).toBe('in-progress')
})

test('the notice sets the Orca flag while the wait is past half', async () => {
  const view = orcaView({ issue: 7, prs: [], state: 'wait', waiting: { what: 'PR #44 to be merged', alert: { group: 'g' } } })
  expect(view.attention).toBe(true)
  expect(view.comment).toContain('PR #44')
  expect(orcaView({ issue: 7, prs: [], state: 'wait', waiting: { what: 'x' } }).attention).toBe(false)
})
