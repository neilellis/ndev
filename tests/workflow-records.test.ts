import { expect, test } from './sdk-testing'
import { ROOT, REPO, CHECKS, engine, finishing, pull, start, tool } from './workflow-harness'

const DIR = `${ROOT}/docs/formal/requirements`
const record = (id: string, status: string, prs: string[] = []) => `---\nid: ${id}\ntitle: "One version"\nstatus: ${status}\n---\n\n## Statement\n\nRun one version at a time.\n\n## Trace\n\n${prs.map(u => `- PR: ${u}\n`).join('')}`
const issue = (body: string) => Array.from({ length: 4 }, () => ({ state: 'open', title: 'T', body }))

test('started shows the records that the issue cites', async ($, on) => {
  const w = engine(on, { wf: null, files: { [`${DIR}/0007-one-version.md`]: record('REQ-0007', 'Accepted') } })
  await start($, w)
  w.s.issueReadsFor = { 7: issue('Fulfils REQ-0007 and REQ-0008.') }
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('REQ-0007 (Accepted): Run one version at a time.')
  expect(r.text).toContain('REQ-0008 has no record in docs/formal/requirements')
  expect(r.text).not.toContain('cites no record in force')
})

test('started guides an issue that cites no record in force to find one or create it as Proposed', async ($, on) => {
  const w = engine(on, { wf: null, files: { [`${DIR}/0009-old.md`]: record('REQ-0009', 'Retired') } })
  await start($, w)
  w.s.issueReadsFor = { 7: issue('Was REQ-0009.') }
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.text).toContain('Issue #7 cites no record in force:\n- REQ-0009 (Retired)')
  expect(r.text).toMatch(/ndev requirements for <file> or ndev requirements search <words>[\s\S]*status Proposed/)
})

test('started says nothing of records in a project with none', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).text).not.toContain('cites no')
})

test('finishedPlan refuses a record on the Requirements line with no line that says how it is verified', async ($, on) => {
  const plan = `${ROOT}/plan.md`
  const files = { [plan]: 'Test entry point: the CLI\nRequirements: REQ-0007\nModel: none, no state\nREQ-0007: one version.\n', [`${DIR}/0007-one-version.md`]: record('REQ-0007', 'Accepted') }
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', baseCheck: undefined }, files })
  await start($, w)
  const refused = await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('REQ-0007 has no line that says how it is verified')
  w.files.set(plan, 'Test entry point: the CLI\nRequirements: REQ-0007\nModel: none, no state\n- REQ-0007: the test tests/one.test.ts\n')
  expect((await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })).isError).toBe(false)
})

const PLAN = 'Plan.\n\nRequirements: REQ-0007\n- REQ-0007: the test a.test.ts\n\nCloses #7\n'

test('finishedDevelopment refuses a record on the Requirements line whose Trace does not link the PR', async ($, on) => {
  const file = `${DIR}/0007-one-version.md`
  const w = engine(on, { wf: { state: 'developing' }, pr: pull({ body: PLAN }), files: { [file]: record('REQ-0007', 'Accepted') } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const refused = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain(`ndev requirements link REQ-0007 https://github.com/${REPO}/pull/12`)
  expect(w.state()?.state).toBe('developing')
  w.files.set(file, record('REQ-0007', 'Accepted', [`https://github.com/${REPO}/pull/12`]))
  expect((await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: [] })).isError).toBe(false)
})

test('done refuses a record in force on the Requirements line whose Trace does not link the PR', async ($, on) => {
  const file = `${DIR}/0007-one-version.md`
  const w = engine(on, { wf: finishing({ prs: [12] }), pr: pull({ body: PLAN }), checks: CHECKS({ name: 'ci', conclusion: 'success' }), files: { [file]: record('REQ-0007', 'Accepted') } })
  await start($, w)
  const refused = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('REQ-0007 does not link this PR in its Trace')
  w.files.set(file, record('REQ-0007', 'Accepted', [`https://github.com/${REPO}/pull/12`]))
  expect((await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })).isError).toBe(false)
})
