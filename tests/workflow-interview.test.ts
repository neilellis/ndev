// Workflow tests: The interview pane, its rounds and setSteering. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { ROOT, RECORD, flow, held, engine, start, tool, command, idle, seven, INTERVIEW_FILE, INTERVIEW_PANE, ROUND, asking, human, round, answersIn, interviewFile, POSTED_ONCE } from './workflow-harness'

test('a hand-over gives the worker the answers of the parent and not its workflow', async ($, on) => {
  const parent = { version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }], workflow: { issue: 3, state: 'ci', rev: 4 }, prs: { 12: { issue: 3, pr: 12, rev: 2 } } }
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' }, files: { [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [{ name: '.neil-dev.issue-3.json', text: JSON.stringify(parent) }] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const child = JSON.parse(w.files.get(`${ROOT}/.neil-dev.issue-3.json`)!)
  expect(child.rounds).toEqual(parent.rounds)
  expect(child.workflow).toBeUndefined()
  expect(child.prs).toBeUndefined()
})

test('a hand-over into a file that holds only a workflow still marks the follow-up, and keeps the workflow', async ($, on) => {
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const record = flow(asking({ mode: 'heavy' }))
  const w = engine(on, { wf: null, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify({ version: 1, issue: 7, workflow: record }), [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7 })
  const held = JSON.parse(w.files.get(INTERVIEW_FILE)!)
  expect(held.startedByFollowUp).toEqual({ of: 3, at: 5 })
  expect(held.workflow.issue).toBe(7)
})

test('a worker passes on the answers that it was handed, though it has no workflow for them', async ($, on) => {
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [`${ROOT}/.neil-dev.issue-3.json`]: JSON.stringify({ version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }) } })
  await human($, w)
  w.s.orcaOn = true
  await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  const left = [...w.files.keys()].find(k => k.startsWith('/main/.git/ndev-interview-handover-'))
  expect(JSON.parse(w.files.get(left!)!).files.map((f: { name: string }) => f.name)).toContain('.neil-dev.issue-3.json')
})

test('a round shows rich text; Select and Input change the answers that the agent gets; the file and both comments hold them', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const { done, ui } = await round($, w)
  expect((await ui.find({ key: 'question' }))?.text).toContain('Where do **sessions** live?')
  expect((await ui.find({ key: 'context' }))?.text).toContain('They outlive a deploy.')
  expect((await ui.find({ key: 'options' }))?.text).toContain('`set-cookie: s=...`')
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.input({ key: 'notes-store', text: 'Only for now.', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.input({ key: 'other-name', text: 'session', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.select({ key: 'pick-browsers', value: 'Edge' })
  await ui.select({ key: 'pick-browsers', value: 'Safari' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /Session store/ }))?.text).toBe('Q1 Session store')
  expect((await ui.find({ type: 'Text', text: /Cookie/ }))?.text).toBe('✔ Cookie')
  expect((await ui.find({ type: 'Text', text: /Only for now/ }))?.text).toBe('Notes: Only for now.')
  await ui.press({ key: 'edit-name' })
  expect((await ui.find({ key: 'other-name' }))).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(r.isError).toBe(false)
  expect(answersIn(r).answers).toEqual([
    { id: 'store', selected: ['Cookie'], notes: 'Only for now.' },
    { id: 'name', selected: [], other: 'session' },
    { id: 'browsers', selected: ['Chrome', 'Edge'] },
  ])
  expect(w.state()?.state).toBe('interviewing')
  expect(w.state()?.asking).toBeUndefined()
  const file = interviewFile(w)
  expect(file.rounds[0]!.answers.length).toBe(3)
  expect(file.commentIds).toEqual({ issue: 1007, pr: 1012, prNumber: 12 })
  expect(file.posted).toBe(true)
  const posts = w.gh.filter(l => l.includes(' comment '))
  expect(posts.length).toBe(2)
  expect(posts[0]).toContain('ndev:interview issue=7')
})

test('the next round edits the two comments in place, and interview() goes on: planning when heavy', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const one = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await one.ui.press({ key: 'next' })
  await one.ui.press({ key: 'submit' })
  await one.done()
  await one.ui.unmount()
  w.gh.length = 0
  const two = await round($, w, { title: 'Two', questions: [{ id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'name', suggested: '1 day' }] })
  expect((await two.ui.find({ type: 'Text', text: /Follow-up/ }))?.text).toBe('Follow-up to Q1 · Q1 › Q2')
  const recap = (await two.ui.find({ key: 'recap' }))?.text
  expect(recap).toContain('What name?')
  expect(recap).toContain('sid')
  await two.ui.press({ key: 'next' })
  await two.ui.press({ key: 'submit' })
  await two.done()
  await two.ui.unmount()
  expect(w.gh.filter(l => l.includes(' comment ')).length).toBe(0)
  const edits = w.gh.filter(l => l.includes(' comment-edit '))
  expect(edits.map(l => l.split(' comment-edit ')[1]!.split(' ')[0])).toEqual(['1007', '1012'])
  const out = await tool($, 'interview')
  expect(out.isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
  expect(interviewFile(w).closed?.asked).toBe(true)
})

test('a pause that the host aborts after it ran over does not end the round, as when the computer slept', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.sleepAborts = 2
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(r.isError).toBe(false)
  expect(w.s.sleepAborts).toBe(0)
  expect(answersIn(r).answers.map(a => a.id)).toEqual(['name'])
})

test('a pause that cannot start still fails the round, and names the command and the cause', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.sleepFails = 'spawn sleep ENOENT'
  const answer = tool($, 'interview', { interviewJson: { title: 'One', questions: [ROUND.questions[1]] } })
  const r = await answer
  expect(r.isError).toBe(true)
  expect(r.text).toContain('sleep 2 exited 127 after 0ms in /proj')
  expect(r.text).toContain('sleep did not run')
})

test('a follow-up inside the round recaps the answer as it stands', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[0], { id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'store', suggested: '1 day' }] })
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ key: 'recap' }))?.text).toContain('Cookie')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('the review is a list of questions and answers, with the follow-up, the earlier rounds and real buttons', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const one = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await one.ui.press({ key: 'next' })
  await one.ui.press({ key: 'submit' })
  await one.done()
  await one.ui.unmount()
  const { done, ui } = await round($, w, { title: 'Two', questions: [ROUND.questions[0], { id: 'ttl', header: 'Lifetime', question: 'How long?', followUpTo: 'name', suggested: '1 day' }] })
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.input({ key: 'notes-store', text: 'Only for now.', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /earlier round/ }))?.text).toBe('Q1 was answered in an earlier round.')
  expect((await ui.find({ type: 'Text', text: /Session store/ }))?.text).toBe('Q2 Session store')
  expect((await ui.find({ key: 'question-store' }))?.text).toContain('Where do **sessions** live?')
  const answer = await ui.find({ type: 'Text', text: /Cookie/ })
  expect(answer?.text).toBe('✔ Cookie')
  expect(answer?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /Only for now/ }))?.text).toBe('Notes: Only for now.')
  expect(await ui.find({ key: 'recap-store' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Follow-up/ }))?.text).toBe('Follow-up to Q1 · Q1 › Q3')
  const recap = (await ui.find({ key: 'recap-ttl' }))?.text
  expect(recap).toContain('What name?')
  expect(recap).toContain('sid')
  expect((await ui.find({ key: 'edit-store' }))?.props.plain).toBeUndefined()
  const send = await ui.find({ key: 'submit' })
  expect(send?.props.variant).toBe('primary')
  expect(send?.props.autoFocus).toBe(true)
  await ui.press({ key: 'edit-ttl' })
  expect((await ui.find({ type: 'Text', text: /question 2 of 2/ }))?.text).toContain('question 2 of 2')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a question with no answer does not go on, and says why', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.input({ key: 'other-name', text: '', kind: 'change' })
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: /needs an answer/ }))?.text).toContain('Cookie name')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('Trust Me Bro keeps the answers given, fills in the recommendations, and stops the questions', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const { done, ui } = await round($, w)
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'trust' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).trustMeBro).toBe(true)
  expect(answersIn(r).answers.map(a => [a.id, a.selected[0] ?? a.other, a.source])).toEqual([['store', 'Cookie', undefined], ['name', 'sid', 'recommended'], ['browsers', 'Safari', 'recommended']])
  expect(r.text).toContain('assumption')
  const again = await tool($, 'interview', { interviewJson: { title: 'More', questions: [{ id: 'x', header: 'X', question: 'X?', suggested: 's' }] } })
  expect(again.isError).toBe(true)
  expect(again.text).toContain('Trust Me Bro')
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
})

test('Close for now returns what was answered as dismissed, and the state stays', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w)
  await ui.select({ key: 'pick-store', value: 'Cookie' })
  await ui.press({ key: 'close' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).dismissed).toBe(true)
  expect(answersIn(r).answers.map(a => a.id)).toEqual(['store'])
  expect(answersIn(r).notAnswered).toEqual(['name', 'browsers'])
  expect(w.state()?.state).toBe('interviewing')
})

test('the pane says when no round is open, and on a phone it sends the human to the terminal', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const empty = await $.ui.mount({ ...INTERVIEW_PANE, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /No interview/ })).toBeDefined()
  await empty.unmount()
  const { done, ui } = await round($, w, ROUND, 'mobile')
  expect(await ui.find({ type: 'Text', text: /Answer it in the terminal/ })).toBeDefined()
  await ui.unmount()
  const desk = await $.ui.mount({ ...INTERVIEW_PANE, surface: 'terminal' })
  await desk.press({ key: 'close' })
  await done()
  await desk.unmount()
})

test('a draft saved by an earlier call comes back, and the draft is saved while the round is open', async ($, on) => {
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify({ version: 1, issue: 7, rounds: [], draft: { store: { selected: ['Cookie'], other: '', notes: 'kept', touched: true } } }) } })
  await human($, w)
  const { done, tick, ui } = await round($, w)
  await ui.press({ key: 'next' })
  await ui.input({ key: 'notes-name', text: 'typed', kind: 'change' })
  await tick()
  expect(JSON.parse(w.files.get(INTERVIEW_FILE)!).draft.name.notes).toBe('typed')
  await ui.press({ key: 'trust' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).answers[0]).toEqual({ id: 'store', selected: ['Cookie'], notes: 'kept' })
  expect(interviewFile(w).draft).toBeUndefined()
})

test('the watchdog stays quiet while a round is open, and Orca shows that the human is needed', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w)
  expect(w.state()?.asking).toBeDefined()
  expect(w.alerts.length).toBe(1)
  const before = w.prompts.length
  await idle(w)
  await idle(w)
  expect(w.prompts.length).toBe(before)
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
  expect(w.state()?.asking).toBeUndefined()
})

test('no question goes to a human who is not there: auto and a session with no human refuse, and name the way on', async ($, on) => {
  const w = engine(on, { wf: asking({ steering: 'auto' }) })
  await human($, w)
  const auto = await tool($, 'interview', { interviewJson: ROUND })
  expect(auto.isError).toBe(true)
  expect(auto.text).toContain('auto steering')
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('in a session with no human the round refuses and names setSteering', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await start($, w)
  const r = await tool($, 'interview', { interviewJson: ROUND })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('setSteering')
  expect(w.state()?.state).toBe('interviewing')
})

test('a bad round refuses with each problem and opens no pane', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const r = await tool($, 'interview', { interviewJson: { title: 'T', questions: [{ id: 'a', header: 'A', question: 'A?' }] } })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('suggested')
  expect(w.state()?.asking).toBeUndefined()
})

test('interview() with no questions goes on when light, and a heavy issue refuses it, naming /flow skip', async ($, on) => {
  const light = engine(on, { wf: asking({ mode: 'light' }) })
  await human($, light)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(r.text).toContain('No questions asked')
  expect(light.state()?.state).toBe('developing')
})

test('a heavy issue with no answers cannot leave by itself, and a human can skip it', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow skip')
  expect(w.state()?.state).toBe('interviewing')
  await command($, 'skip no decisions are open')
  expect(w.state()?.state).toBe('planning')
})

test('when GitHub fails the agent still gets the answers and the failure, and the exit waits for the comments', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.ghFails = ' comment 7'
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const r = await done()
  await ui.unmount()
  expect(answersIn(r).answers[0]!.other).toBe('sid')
  expect(r.text).toContain('gh.sh comment 7')
  expect(interviewFile(w).posted).toBe(false)
  const refused = await tool($, 'interview')
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('gh.sh comment 7')
  expect(w.state()?.state).toBe('interviewing')
  w.s.ghFails = ''
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(interviewFile(w).commentIds?.issue).toBe(1007)
})

test('setSteering sets auto with a reason on the issue and the PR, leaves the interview, and takes nothing else', async ($, on) => {
  const w = engine(on, { wf: asking({ mode: 'heavy' }) })
  await human($, w)
  expect((await tool($, 'setSteering', { steering: 'interactive', reason: 'x' })).text).toContain('/flow steering interactive')
  expect((await tool($, 'setSteering', { steering: 'auto' })).text).toContain('needs a reason')
  expect(w.state()?.steering).toBe('interactive')
  const r = await tool($, 'setSteering', { steering: 'auto', reason: 'this run uses claude -p' })
  expect(r.isError).toBe(false)
  expect(w.state()?.steering).toBe('auto')
  expect(w.state()?.state).toBe('planning')
  const said = w.gh.filter(l => l.includes('this run uses claude -p'))
  expect(said.map(l => l.split(' comment ')[1]!.split(' ')[0])).toEqual(['7', '12'])
})

test('a followUp worker gets the interview files: the parent leaves them, and the child takes them at started', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(false)
  const left = [...w.files.keys()].find(k => k.startsWith('/main/.git/ndev-interview-handover-'))
  expect(left).toBeDefined()
  expect(JSON.parse(w.files.get(left!)!).files[0].name).toBe('.neil-dev.issue-7.json')
  expect(w.orcaCalls.some(c => c.join(' ').includes('.neil-dev.issue-7.json'))).toBe(true)
})

test('the child of a followUp takes the answers at started, and a heavy child can leave with no questions', async ($, on) => {
  const parentFile = JSON.stringify({ version: 1, issue: 3, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] })
  const handOver = '/main/.git/ndev-interview-handover-7.json'
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' }, files: { [handOver]: JSON.stringify({ followUpOf: 3, at: 5, files: [{ name: '.neil-dev.issue-3.json', text: parentFile }] }) } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  expect(JSON.parse(w.files.get(`${ROOT}/.neil-dev.issue-3.json`)!)).toEqual(JSON.parse(parentFile))
  expect(JSON.parse(w.files.get(INTERVIEW_FILE)!).startedByFollowUp).toEqual({ of: 3, at: 5 })
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('planning')
})

// ---- the interview: what the review found ----
test('an Other answer replaces the recommendation, and a picked option replaces the Other answer', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[0]] })
  await ui.input({ key: 'other-store', text: 'Memcached', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  const typed = answersIn(await done()).answers[0]!
  expect(typed.selected).toEqual([])
  expect(typed.other).toBe('Memcached')
  await ui.unmount()

  const again = await round($, w, { title: 'Two', questions: [{ ...ROUND.questions[0], id: 'store2' }] })
  await again.ui.input({ key: 'other-store2', text: 'Memcached', kind: 'change' })
  await again.ui.select({ key: 'pick-store2', value: 'Cookie' })
  await again.ui.press({ key: 'next' })
  await again.ui.press({ key: 'submit' })
  const picked = answersIn(await again.done()).answers[0]!
  expect(picked.selected).toEqual(['Cookie'])
  expect(picked.other).toBeUndefined()
  await again.ui.unmount()
})

test('leaving the interview runs the base check when light, so finishedInterview is not a second step', async ($, on) => {
  const w = engine(on, { wf: asking({ baseCheck: undefined }) })
  await human($, w)
  w.steps.length = 0
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.steps).toContain('pre-commit-check.sh')
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-commit-check.sh', exitCode: 0 })
  expect(r.text).not.toContain('call finishedInterview')
})

test('a base that fails names the failure when the interview ends, and the state still goes on', async ($, on) => {
  const w = engine(on, { wf: asking({ baseCheck: undefined }) })
  await human($, w)
  w.s.failCheck = 'pre-commit-check.sh'
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toContain('pre-commit-check.sh exited')
})

test('a heavy interview leaves the base check to finishedPlan', async ($, on) => {
  const answered = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], posted: true }
  const w = engine(on, { wf: asking({ mode: 'heavy', baseCheck: undefined }), files: { [INTERVIEW_FILE]: JSON.stringify(answered) } })
  await human($, w)
  w.steps.length = 0
  await tool($, 'interview')
  expect(w.state()?.state).toBe('planning')
  expect(w.steps).not.toContain('pre-push-check.sh')
})

test('the pane shows one round: a second issue is refused and the first round goes on', async ($, on) => {
  const seven = flow(asking())
  const eight = flow(asking({ issue: 8, prs: [13] }))
  const w = engine(on, { files: { [RECORD]: held(seven, eight) } })
  await human($, w)
  await tool($, 'started', { issue: 7 })
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await tool($, 'started', { issue: 8 })
  const second = await tool($, 'interview', { interviewJson: { title: 'Two', questions: [ROUND.questions[1]] } })
  expect(second.isError).toBe(true)
  expect(second.text).toContain('for #7 is already open')
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  expect((await done()).isError).toBe(false)
  await ui.unmount()
})

test('a stale write while a finished round lets go is a warning: the answers still reach the agent', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  w.s.staleSaves = 1
  const r = await done()
  expect(r.isError).toBe(false)
  expect(answersIn(r).answers[0]!.id).toBe('name')
  expect(interviewFile(w).rounds.length).toBe(1)
  await ui.unmount()
})

test('a write that fails while the round ends keeps the answers in the draft', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.input({ key: 'other-name', text: 'mine', kind: 'change' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  let writes = 0
  w.s.failWrite = (path: string) => path === INTERVIEW_FILE && ++writes > 1
  const r = await done()
  expect(r.isError).toBe(true)
  expect(interviewFile(w).draft?.name).toMatchObject({ other: 'mine' })
  await ui.unmount()
})

test('with no PR yet, the interview does not count as posted, and the exit names started', async ($, on) => {
  const w = engine(on, { wf: asking({ prs: [] }) })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  await done()
  await ui.unmount()
  expect(interviewFile(w).posted).toBe(false)
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('call started')
  expect(w.state()?.state).toBe('interviewing')
})

test('a comment that was deleted is posted again', async ($, on) => {
  const file = POSTED_ONCE
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(file) } })
  await human($, w)
  w.s.editFails = 'gh: Not Found (HTTP 404)'
  expect((await tool($, 'interview')).isError).toBe(false)
  expect(interviewFile(w).commentIds).toEqual({ issue: 1007, pr: 1012, prNumber: 12 })
})

test('another failure of a comment edit names the command, and the issue stays', async ($, on) => {
  const down = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(POSTED_ONCE) } })
  await human($, down)
  down.s.editFails = 'gh: HTTP 502'
  const r = await tool($, 'interview')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('comment-edit 55')
  expect(r.text).toContain('HTTP 502')
  expect(down.state()?.state).toBe('interviewing')
})

test('setSteering out of the interview posts what is not posted, closes the file, and withdraws a left alert', async ($, on) => {
  const file = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], posted: false }
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'g' } }), files: { [INTERVIEW_FILE]: JSON.stringify(file) } })
  await human($, w)
  const r = await tool($, 'setSteering', { steering: 'auto', reason: 'no human' })
  expect(r.isError).toBe(false)
  expect(interviewFile(w).posted).toBe(true)
  expect(interviewFile(w).closed).toBeDefined()
  expect(w.alerts).toContain('withdraw')
  expect(w.state()?.asking).toBeUndefined()
})

test('/flow skip out of the interview withdraws a left alert', async ($, on) => {
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'g' } }) })
  await human($, w)
  await command($, 'skip the human decides')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toContain('withdraw')
  expect(w.state()?.asking).toBeUndefined()
})

test('a new round withdraws the alert that a reload left', async ($, on) => {
  const w = engine(on, { wf: asking({ asking: { at: 1, group: 'old' } }) })
  await human($, w)
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  expect(w.alerts[0]).toBe('withdraw')
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a pane that cannot show lets go of the notification and of the round', async ($, on) => {
  const w = engine(on, { wf: asking() })
  await human($, w)
  w.s.staleSaves = 1
  const r = await tool($, 'interview', { interviewJson: { title: 'One', questions: [ROUND.questions[1]] } })
  expect(r.isError).toBe(true)
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.state()?.asking).toBeUndefined()
  w.s.sleepYields = true
  const again = await round($, w, { title: 'Two', questions: [ROUND.questions[1]] })
  await again.ui.press({ key: 'close' })
  expect((await again.done()).isError).toBe(false)
  await again.ui.unmount()
})

test('a human who thinks for a long time keeps the workflow: the hold refreshes the owner', async ($, on) => {
  const w = engine(on, { wf: asking({ owner: { session: 's1', at: 0 } }) })
  await human($, w)
  const { done, tick, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  w.s.now += 6 * 60_000
  await tick()
  await tick()
  expect(w.state()?.owner?.at).toBeGreaterThan(5 * 60_000)
  await ui.press({ key: 'close' })
  await done()
  await ui.unmount()
})

test('a worker that does not start takes back its hand-over, so a later issue is not relaxed by it', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  w.s.workerReceipt = { state: 'failed', lastError: 'no room', failedStage: 'spawn' }
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect([...w.files.keys()].some(k => k.startsWith('/main/.git/ndev-interview-handover-'))).toBe(false)
  expect(r.text).toContain('no room')
})

test('a hand-over that cannot be taken back names its file and the repair', async ($, on) => {
  const parent = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [], at: 1 }] }
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' }, files: { [INTERVIEW_FILE]: JSON.stringify(parent) } })
  await human($, w)
  w.s.orcaOn = true
  w.s.workerReceipt = { state: 'failed', lastError: 'no room', failedStage: 'spawn' }
  w.s.rmFails = 'rm: read-only file system'
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('read-only file system')
  expect(r.text).toContain('Repair: delete it')
  expect(r.text).toContain('ndev-interview-handover-')
})

test('the record says a new round is not posted before the post starts, so a crash cannot lose the post', async ($, on) => {
  const earlier = { version: 1, issue: 7, rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], commentIds: { issue: 55, pr: 66 }, posted: true }
  const w = engine(on, { wf: asking(), files: { [INTERVIEW_FILE]: JSON.stringify(earlier) } })
  await human($, w)
  const seen: unknown[] = []
  w.s.failWrite = (path: string) => {
    if (path === INTERVIEW_FILE) seen.push(JSON.parse(w.files.get(path)!).posted)
    return false
  }
  const { done, ui } = await round($, w, { title: 'One', questions: [ROUND.questions[1]] })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'submit' })
  expect((await done()).isError).toBe(false)
  await ui.unmount()
  expect(seen).toContain(false)
  expect(interviewFile(w).posted).toBe(true)
})

test('a parent interview file that cannot be read names the file and the cause', async ($, on) => {
  const w = engine(on, { wf: { mode: 'heavy' }, config: { steering: 'interactive' } })
  await human($, w)
  w.s.orcaOn = true
  w.s.failRead = (path: string) => path === INTERVIEW_FILE
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Add the child\nThe body' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(INTERVIEW_FILE)
  expect(w.orcaCalls.some(c => c.join(' ').includes('worktree create'))).toBe(false)
  expect(r.text).toContain('Repair: fix the file')
})
