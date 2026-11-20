// Workflow tests: New-issue questions, reportWorkflowBug and iNeedA. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, RECORD, engine, settle, start, tool, command, workflowSection, noIssue, talk, launches, promptOf } from './workflow-harness'

test('use an existing issue puts the start of the request in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Use an existing issue'
  await talk($)
  expect(w.fills).toEqual(['Work on issue #'])
  expect(w.prompts).toEqual([])
})

test('create a new issue puts the issue skill in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Create a new issue'
  await talk($)
  expect(w.fills).toEqual(['/ndev:issue '])
})

test('a typed issue number starts the work, and typed words file a new issue', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = '#42'
  await talk($)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('#42')
  expect(w.prompts[0]).toContain('mcp__ndev__started')
})

test('typed words become the text of a new issue', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'the login page loses the redirect'
  await talk($)
  expect(w.prompts[0]).toContain('the login page loses the redirect')
  expect(w.prompts[0]).toContain('ndev:issue')
})

test('work without the workflow: started refuses, no reminder comes, and /flow on undoes it', async ($, on) => {
  const w = noIssue(on)
  w.s.issueAnswer = 'Work without the workflow'
  await talk($)
  expect(await workflowSection($)).toBeUndefined()
  const refused = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(refused.text).toContain('/flow on')
  expect(w.files.has(RECORD)).toBe(false)

  await $.command.run({ command: 'flow', args: 'on' } as never)
  expect(await workflowSection($)).toContain('mcp__ndev__started')
  expect(await workflowSection($)).toContain('names no issue')
})

test('the question comes once in a session, also after a reload', async ($, on) => {
  const w = noIssue(on)
  await talk($)
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

for (const [name, setUp] of [
  ['a project with the workflow off', { config: { workflow: false } }],
] as const) {
  test(`no question in ${name}`, async ($, on) => {
    const w = engine(on, { wf: null, ...setUp })
    w.s.branch = 'main'
    await talk($)
    expect(w.issueAsks).toEqual([])
  })
}

test('no question when no person is at the prompt', async ($, on) => {
  const w = noIssue(on)
  await start($)
  expect(w.issueAsks).toEqual([])
})

test('no question when the record names an issue', async ($, on) => {
  const w = engine(on)
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('a question when the record is done: the next work has no issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  w.s.branch = 'main'
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

test('no question in a resumed session', async ($, on) => {
  const w = noIssue(on)
  w.s.resumed = true
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('no question when the branch names an issue', async ($, on) => {
  const w = noIssue(on)
  w.s.branch = 'claude/issue-9'
  await talk($)
  expect(w.issueAsks).toEqual([])
})

test('no question when Orca links the workspace to an issue', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  w.s.orcaLinked = 12
  await talk($)
  expect(w.issueAsks).toEqual([])
  expect(w.orcaCalls.some(c => c[1] === 'show' && c.includes(`path:${ROOT}`))).toBe(true)
})

test('a question when Orca links the workspace to no issue', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
})

test('no question when a first prompt reached the session, as with an Orca worker or claude "prompt"', async ($, on) => {
  const w = noIssue(on)
  let wake = () => {}
  w.s.sleepHold = new Promise<void>(resolve => { wake = resolve })
  await talk($)
  await $.turn.start({ prompt: 'a task' } as never).catch(() => undefined)
  wake()
  await settle()
  expect(w.issueAsks).toEqual([])
})

test('no question while the person is typing in the prompt box', async ($, on) => {
  const w = noIssue(on)
  w.s.draft = 'half a thou'
  await talk($)
  expect(w.issueAsks).toEqual([])
  expect(w.fills).toEqual([])
})

test('a failed Orca read still asks, and shows the failure', async ($, on) => {
  const w = noIssue(on)
  w.s.orcaOn = true
  w.s.orcaFails = 'no server'
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
  expect(w.toasts.join()).toContain('no server')
})

test('reportWorkflowBug starts an Orca agent on main in the plugin checkout, with the report as data', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  const r = await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'status said nothing, done said dirty' })
  expect(r.isError).toBe(false)
  const [call] = launches(w)
  expect(call).toBeDefined()
  expect(call!.join(' ')).toContain('--agent claude')
  expect(call![call!.indexOf('--worktree') + 1]).toStartWith('path:')
  const prompt = promptOf(call!)
  expect(prompt).toContain('done refuses a clean tree')
  expect(prompt).toContain('status said nothing, done said dirty')
  expect(prompt).toContain('on main')
  expect(prompt).toContain('failing test')
  expect(prompt).toContain('by name')
  expect(r.text).toContain('agent')
})

test('reportWorkflowBug works with no workflow, and from a helper', async ($, on) => {
  const w = engine(on, { wf: null })
  w.s.branch = 'main'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'x', agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(launches(w)).toHaveLength(1)
})

test('the same bug again starts no second agent', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'a' })
  const again = await tool($, 'reportWorkflowBug', { title: 'Done refuses  a clean tree', details: 'b' })
  expect(launches(w)).toHaveLength(1)
  expect(again.text).toContain('already')
})

test('a loop of new bugs stops at the hourly limit and says so', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  for (let i = 0; i < 5; i++) await tool($, 'reportWorkflowBug', { title: `bug ${i}`, details: 'a' })
  const over = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(launches(w)).toHaveLength(5)
  expect(over.isError).toBe(true)
  expect(over.text).toContain('bug six')
  expect(over.text).toContain('limit')
})

test('the limit of bug agents frees up after an hour, and only then', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  for (let i = 0; i < 5; i++) await tool($, 'reportWorkflowBug', { title: `bug ${i}`, details: 'a' })
  w.s.now += 3_599_000
  const inside = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(inside.isError).toBe(true)
  expect(inside.text).toContain('5 bug agents in an hour')
  w.s.now += 2_000
  const after = await tool($, 'reportWorkflowBug', { title: 'bug six', details: 'a' })
  expect(after.isError).toBe(false)
  expect(launches(w)).toHaveLength(6)
})

test('the same bug starts no second agent for 24 hours, past the hourly limit', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'a' })
  w.s.now += 2 * 3_600_000
  const again = await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'b' })
  expect(launches(w)).toHaveLength(1)
  expect(again.text).toContain('already')
  w.s.now += 22 * 3_600_000 + 1_000
  await tool($, 'reportWorkflowBug', { title: 'done refuses a clean tree', details: 'c' })
  expect(launches(w)).toHaveLength(2)
})

test('a plugin checkout that is not on main starts no agent, and the refusal names the branch and the report', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'feature-x'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })
  expect(launches(w)).toHaveLength(0)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('feature-x')
  expect(r.text).toContain('the detail')
})

test('a failed Orca launch names the command output, the repair, and keeps the report; a retry can start it', async ($, on) => {
  const w = engine(on)
  w.s.branch = 'main'
  w.s.orcaFails = 'orca is not running'
  const r = await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('orca is not running')
  expect(r.text).toContain('orca repo add')
  expect(r.text).toContain('the detail')
  w.s.orcaFails = ''
  expect((await tool($, 'reportWorkflowBug', { title: 'status crashed', details: 'the detail' })).isError).toBe(false)
  expect(launches(w).length).toBeGreaterThan(0)
})

test('an unexpected fault in a tool is reported by the plugin, and a refusal is not', async ($, on) => {
  const w = engine(on, { files: { [RECORD]: '{ not json' } })
  await start($, w)
  w.s.branch = 'main'
  const r = await tool($, 'status')
  expect(r.isError).toBe(true)
  expect(launches(w)).toHaveLength(1)
  expect(promptOf(launches(w)[0]!)).toContain('not valid JSON')
  expect(r.text).toContain('reported')
})

test('a refusal starts no agent', async ($, on) => {
  const w = engine(on)
  await tool($, 'finishedSmoke', {})
  expect(launches(w)).toHaveLength(0)
})

// ---- iNeedA: guidance from the fixed lists ----

test('iNeedA react-component asks haiku with the component list and answers with its suggestions', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'react-component', description: 'a hold to confirm button' })
  expect(r.isError).toBe(false)
  expect(w.modelCalls).toHaveLength(1)
  expect(w.modelCalls[0]!.model).toBe('haiku')
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE kb/ui-components.md')
  expect(sent).toContain('a hold to confirm button')
  expect(r.text).toContain('Use Kokonut UI hold-button.')
  expect(r.text).toContain('kb/ui-components.md')
})

test('iNeedA library reads the library list and the dependencies the project has', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { zod: '4.0.0' } }) } })
  await start($, w)
  await tool($, 'iNeedA', { kind: 'library', description: 'validate a form' })
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE kb/libraries.md')
  expect(sent).toContain('zod')
})

test('iNeedA animation reads the motion guidance', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'iNeedA', { kind: 'animation', description: 'a micro-interaction when a card is saved' })
  const sent = JSON.stringify(w.modelCalls[0])
  expect(sent).toContain('SOURCE skills/motion/SKILL.md')
  expect(sent).toContain('SOURCE skills/motion/references/delight.md')
})

test('iNeedA brand-style reads the tokens of the local brand site', async ($, on) => {
  const w = engine(on, { config: { branding: { site: 'https://b.example', path: 'apps/brand' } }, files: { [`${ROOT}/apps/brand/public/ds/colour.css`]: '--ink: #111' } })
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'brand-style', description: 'the colour of an error message' })
  expect(JSON.stringify(w.modelCalls[0])).toContain('--ink: #111')
  expect(r.isError).toBe(false)
})

test('iNeedA brand-style with only a site reads the site', async ($, on) => {
  const w = engine(on, { config: { branding: { site: 'https://b.example' } } })
  await start($, w)
  await tool($, 'iNeedA', { kind: 'brand-style', description: 'the heading font' })
  expect(JSON.stringify(w.modelCalls[0])).toContain('Brand guide: Inter')
})

test('iNeedA brand-style with no brand calls no model and names /brand create', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'brand-style', description: 'the heading font' })
  expect(w.modelCalls).toHaveLength(0)
  expect(r.text).toContain('/brand create')
})

test('iNeedA refuses an unknown kind and names the kinds', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'pony', description: 'x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('react-component')
  expect(w.modelCalls).toHaveLength(0)
})

test('a failed model call names the reason and the file to read, and reports no workflow bug', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.modelFails = true
  const r = await tool($, 'iNeedA', { kind: 'react-component', description: 'a date picker' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('529')
  expect(r.text).toContain('kb/ui-components.md')
  expect(launches(w)).toHaveLength(0)
})

test('iNeedA works from a helper and with no workflow', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'iNeedA', { kind: 'library', description: 'x', agentId: 'helper-1' })
  expect(r.isError).toBe(false)
  expect(w.modelCalls).toHaveLength(1)
})
