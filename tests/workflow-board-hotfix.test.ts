// Workflow tests: The board, the base check, the dead-code sweep and hotfixes. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { boardColumn } from '../hooks/workflow/machine'
import { ROOT, RECORD, CONFIG, REPO, SHA, pull, CHECKS, engine, settle, start, tool, command, finishing, RUNNING, CLAIMED, noChecks, toReview, BOARD, moves, finished, DONE } from './workflow-harness'

test('a change of column moves the card, and a change inside a column does not', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
  await tool($, 'unblocked', { message: 'Blue' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting', 'board.sh move I7 progress'])
  w.s.dirty = [' M a.ts']
  await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(moves(w).length).toBe(2)
})

test('finishedReview leaves the card in progress: automated development goes on through the checks', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'reviewing', board: 'progress' } })
  await start($, w)
  const r = await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual([])
})

test('done puts the card in In review, because no automated development is left', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: finishing({ board: 'progress' }), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual(['board.sh move I7 review'])
})

test('a done that merges puts the card in Done', async ($, on) => {
  const w = engine(on, { config: { ...BOARD.config, projectLevel: 'poc' }, wf: finishing({ board: 'progress' }), pr: pull(), checks: CHECKS({ name: 'ci', conclusion: 'success' }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual(['board.sh move I7 done'])
})

test('a board that fails shows a toast, does not stop the tool, and the next change tries again', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  w.s.boardFails = 'token expired'
  const r = await tool($, 'blocked', { message: 'Which colour?' })
  expect(r.isError).toBe(false)
  expect(w.toasts.join('\n')).toContain('#7')
  expect(w.toasts.join('\n')).toContain('token expired')
  expect(w.state()?.board).toBe('progress')
  w.s.boardFails = ''
  await tool($, 'unblocked', { message: 'Blue' })
  expect(w.state()?.board).toBe('progress')
  expect(moves(w)).toEqual([])
  await tool($, 'blocked', { message: 'Again' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
})

test('an issue with no card shows a toast once and does not read the board at each save', async ($, on) => {
  const w = engine(on, { ...BOARD, wf: { state: 'developing', board: 'progress' } })
  await start($, w)
  w.s.boardCards = []
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(w.toasts.join('\n')).toContain('Issue #7 has no card')
  expect(w.state()?.board).toBe('awaiting')
})

test('with no board or with the workflow off, nothing reads the board', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(w.steps.filter(l => l.startsWith('board.sh'))).toEqual([])
})

// ---- the base check, after the interview and before development ----
test('a new light issue names finishedInterview, and no commit goes in before it', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-thing', mode: 'light' })
  expect(r.text).toContain('finishedInterview')
  w.s.dirty = [' M a.ts']
  const early = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(early.isError).toBe(true)
  expect(early.text).toContain('finishedInterview')
  const also = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(also.isError).toBe(true)
  expect(also.text).toContain('finishedInterview')
  w.steps.length = 0
  const checked = await tool($, 'finishedInterview', { issue: 7 })
  expect(checked.isError).toBe(false)
  expect(w.steps).toEqual(['pre-commit-check.sh'])
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-commit-check.sh', exitCode: 0 })
  expect(checked.text).not.toContain('call finishedInterview')
  w.s.staged = true
  const late = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(late.isError).toBe(false)
})

test('a failed base check names the script, the exit code, the output and the log, and stops nothing', async ($, on) => {
  const w = engine(on, { wf: { baseCheck: undefined } })
  await start($, w)
  w.s.failCheck = 'pre-commit-check.sh'
  const r = await tool($, 'finishedInterview', { issue: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('pre-commit-check.sh')
  expect(r.text).toContain('exited 3')
  expect(r.text).toContain('lint: broken line')
  expect(r.text).toContain('ndev-pre-commit-check.sh.log')
  expect(r.text).toContain('followUp')
  expect(r.text).toContain('blocked')
  expect(r.text).not.toContain('Nothing was pushed')
  expect(w.state()?.baseCheck).toMatchObject({ exitCode: 3 })
  // After a repair the agent runs it again.
  w.s.failCheck = ''
  const again = await tool($, 'finishedInterview', { issue: 7 })
  expect(again.isError).toBe(false)
  expect(w.state()?.baseCheck).toMatchObject({ exitCode: 0 })
})

test('finishedInterview is valid only in development', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', baseCheck: undefined } })
  await start($, w)
  const r = await tool($, 'finishedInterview', { issue: 7 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('planning')
  expect(w.steps).toEqual([])
})

test('finishedInterview keeps its base check when another writer saves the record while the check runs', async ($, on) => {
  const w = engine(on, { wf: { baseCheck: undefined } })
  await start($, w)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'finishedInterview', { issue: 7 })
  await settle()
  // Another session or hook saves the record during the check, as set-workflow does: one revision more.
  const at = `${ROOT}/.neil-dev.issue-7.json`
  const file = JSON.parse(w.files.get(at) ?? 'null') as { workflow: Record<string, unknown> } | null
  if (file) w.files.set(at, JSON.stringify({ ...file, workflow: { ...file.workflow, rev: Number(file.workflow.rev ?? 0) + 1, otherWriter: 'kept' } }))
  else {
    const old = JSON.parse(w.files.get(RECORD)!) as { workflows: Record<string, Record<string, unknown>> }
    old.workflows[7] = { ...old.workflows[7], rev: Number(old.workflows[7]!.rev ?? 0) + 1, otherWriter: 'kept' }
    w.files.set(RECORD, JSON.stringify(old))
  }
  release()
  const r = await call
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-commit-check.sh', exitCode: 0 })
  expect(w.state()?.otherWriter).toBe('kept')
})

test('finishedInterview refuses to attach a base check to a commit that changed while it ran', async ($, on) => {
  const w = engine(on, { wf: { baseCheck: undefined } })
  await start($, w)
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const pending = tool($, 'finishedInterview', { issue: 7 })
  await settle()
  w.s.sha = 'changed-head'
  release()
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.text).toContain('no longer matches its commit or mode')
  expect(result.text).toContain('call finishedInterview again')
  expect(w.state()?.baseCheck).toBeUndefined()
})

test('finishedInterview names its bounded retries when every save loses to another writer', async ($, on) => {
  const w = engine(on, { wf: { baseCheck: undefined } })
  await start($, w)
  w.s.staleSaves = 99
  const result = await tool($, 'finishedInterview', { issue: 7 })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('set-workflow exited 5 for /proj')
  expect(result.text).toContain('finishedInterview read the record again 3 times')
  expect(result.text).toContain('call status, then finishedInterview again')
  expect(w.state()?.baseCheck).toBeUndefined()
})

test('heavy runs pre-push-check.sh in finishedPlan, before the sign-off reaches the human', async ($, on) => {
  const plan = `${ROOT}/plan.md`
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', steering: 'interactive', baseCheck: undefined }, files: { [plan]: 'Test entry point: the CLI\n' } })
  await start($, w)
  w.s.failCheck = 'pre-push-check.sh'
  const r = await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })
  expect(r.isError).toBe(false)
  expect(w.steps).toEqual(['pre-push-check.sh'])
  expect(w.state()?.baseCheck).toMatchObject({ script: 'pre-push-check.sh', exitCode: 3 })
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('pre-push-check.sh')
  expect(w.alerts.length).toBeGreaterThan(0)
})

test('heavy needs no finishedInterview after finishedPlan', async ($, on) => {
  const plan = `${ROOT}/plan.md`
  const w = engine(on, { wf: { state: 'planning', mode: 'heavy', baseCheck: undefined }, files: { [plan]: 'Test entry point: the CLI\n' } })
  await start($, w)
  const r = await tool($, 'finishedPlan', { issue: 7, markdown_file: plan })
  expect(r.text).not.toContain('finishedInterview')
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })).isError).toBe(false)
})

test('a record that is past development needs no base check for its commits', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', baseCheck: undefined } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })).isError).toBe(false)
})

// ---- the dead-code sweep ----
test('the review stage runs the Python sweep over every tracked root, and gives the result', async ($, on) => {
  const w = engine(on, { names: ['src/a.py', 'scripts/b.py', 'c.md'] })
  w.s.sweepExit = 1
  w.s.sweepOutput = 'src/a.py:3: DC02 unused name'
  const r = await toReview($, w)
  expect(w.steps).toContain('sweep.sh --base origin/main scripts src')
  expect(w.steps.some(l => l.startsWith('sweep-ts.sh'))).toBe(false)
  expect(r.text).toContain('src/a.py:3: DC02 unused name')
  expect(w.prRecord(12)?.deadcode).toMatchObject({ sha: expect.any(String), results: [{ language: 'Python', exitCode: 1 }] })
})

test('the review stage runs the TypeScript sweep for a TypeScript change', async ($, on) => {
  const w = engine(on, { names: ['a.tsx'] })
  const r = await toReview($, w)
  expect(w.steps).toContain('sweep-ts.sh origin/main')
  expect(r.text).toContain('base 2, head 2')
})

test('a sweep that could not measure is reported as that, never as a pass', async ($, on) => {
  const w = engine(on, { names: ['a.ts'] })
  w.s.sweepExit = 2
  w.s.sweepOutput = 'no knip.json'
  const r = await toReview($, w)
  expect(r.text).toContain('did not measure')
  expect(r.text).toContain('no knip.json')
  expect(r.text).toContain('exited 2')
  expect(r.text).not.toContain('found nothing new')
})

test('a change with no Python or TypeScript runs no sweep, and says so', async ($, on) => {
  const w = engine(on, { names: ['README.md'] })
  const r = await toReview($, w)
  expect(w.steps.some(l => l.startsWith('sweep'))).toBe(false)
  expect(r.text).toContain('no Python or TypeScript')
})

test('a resume in review runs a sweep that a crash lost, and not one that ran', async ($, on) => {
  const w = engine(on, { names: ['a.ts'], wf: { state: 'reviewing', hooks: { review: { firedAt: 0, answer: 'clean' } } } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
  await tool($, 'started', { issue: 7 })
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
})

test('finishedReview keeps the result of the plugin sweep in the evidence', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', deadcode: { sha: SHA, results: [{ language: 'TypeScript', exitCode: 1, output: 'a.ts: unused' }] } } })
  await start($, w)
  await tool($, 'finishedReview', { review: 'clean', deadcode: 'a.ts is live', remembered: 'nothing: small' })
  const text = w.state()?.evidence.review?.text ?? ''
  expect(text).toContain('a.ts is live')
  expect(text).toContain('TypeScript')
})

// ---- the body of a light PR ----
test('finishedDevelopment puts body_file in the PR body and keeps the Closes line', async ($, on) => {
  const note = `${ROOT}/note.md`
  const w = engine(on, { files: { [note]: 'Problem and evidence.\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'note.md' })
  expect(r.isError).toBe(false)
  expect(w.gh.some(l => l.includes('pr-edit 12'))).toBe(true)
  const body = [...w.files.values()].find(v => v.includes('Problem and evidence.') && v.includes('Closes #7'))
  expect(body).toBeDefined()
})

test('a body_file that is missing refuses before anything is committed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'gone.md' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/gone.md`)
  expect(w.commits.length).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

// ---- the copy editor ----
test('the answer of a copy editor says that Vale not run is not a pass', async ($, on) => {
  const w = engine(on, { names: ['README.md', 'a.ts'] })
  const r = await toReview($, w)
  const prompt = w.spawns.find(s => s.subagentType === 'ndev:copy-editor')!.prompt
  expect(prompt).toContain('/scripts/docs/readability.sh')
  expect(r.isError).toBe(false)
})

// ---- hotfix ----
test('hotfix files the issue, gives it its own worktree and PR, and turns the workflow off there', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'hotfix', { shortName: 'fix-login-redirect' })
  expect(r.isError).toBe(false)
  expect(w.gh.find(l => l.includes('issue-new'))).toContain('Hotfix: fix login redirect')
  expect(r.text).toContain('Issue #31')
  expect(r.text).toContain(CLAIMED)
  expect(r.text).toContain(`https://github.com/${REPO}/pull/`)
  expect(r.text).toContain('--no-verify')
  const record = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow
  expect(record.off.reason).toContain('hotfix')
  expect(record.prs.length).toBe(1)
  // The session's own issue goes on: it did not join, and its record did not move.
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.prs).toEqual([12])
  expect((await tool($, 'status')).text).toContain('#7')
})

test('a commit that names the worktree of a hotfix passes the git guard, and the own issue keeps its guard', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const commit = { tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix` } as never
  await tool($, 'hotfix', { shortName: 'fix-login' })
  expect((await $.tool.call(commit) as { deny?: string }).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push` } as never) as { deny?: string }).deny).toBeUndefined()
  // The session's own issue keeps its guard.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as { deny?: string }).deny).toContain('checkpoint')
  expect((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix && git push` } as never) as { deny?: string }).deny).toContain('checkpoint')
})

test('a wait for the PR of a hotfix passes while the workflow watches the checks of its own PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  const wait = (n: string) => $.tool.call({ tool: 'Bash', command: `/x/scripts/github/wait-for-pr-change.sh ${n} --skip-success --json` } as never) as Promise<{ deny?: string }>
  expect((await wait('12')).deny).toContain('The workflow watches the checks')
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  const pr = /\/pull\/(\d+)/.exec(r.text)![1]!
  expect((await wait(pr)).deny).toBeUndefined()
  expect((await wait('99')).deny).toContain('The workflow watches the checks')
})

test('the sweep ends before a reviewer starts, so a reviewer that ends finds its record on disk', async ($, on) => {
  const w = engine(on, { names: ['a.ts'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(w.s.spawnedAtSweep).toBe(0)
  expect(w.state()?.deadcode).toBeDefined()
})

test('/flow goto reviewing runs the sweep, and replaces a result from an earlier commit', async ($, on) => {
  const old = { sha: 'old', results: [{ language: 'TypeScript', exitCode: 0, output: 'stale result' }] }
  const w = engine(on, { names: ['a.ts'], wf: { state: 'developing', deadcode: old } })
  await start($, w)
  await command($, 'goto reviewing because the review was lost')
  expect(w.steps.filter(l => l.startsWith('sweep-ts.sh')).length).toBe(1)
  expect(JSON.stringify(w.state()?.deadcode)).not.toContain('stale result')
})

test('body_file does not replace the plan in the PR body', async ($, on) => {
  const note = `${ROOT}/note.md`
  const w = engine(on, { files: { [note]: 'Problem and evidence.\n' } })
  await start($, w)
  w.s.pr = { ...w.s.pr, body: '<!-- ndev:plan:7 -->\nThe signed plan.\nTest entry point: x\nCloses #7\n<!-- /ndev:plan:7 -->\n' }
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], body_file: 'note.md' })).isError).toBe(false)
  const body = [...w.files.values()].find(v => v.includes('ndev:body'))!
  expect(body).toContain('The signed plan.')
  expect(body).toContain('Test entry point: x')
  expect(body.match(/Closes #7/g)?.length).toBe(1)
})

test('an issue that followUp this_agent adds has no interview, so its commits are not refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'finishedInterview')
  const made = await tool($, 'followUp', { mode: 'this_agent', message: 'Sub work' })
  const child = Number(/issues\/(\d+)/.exec(made.text)![1])
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { issues: [7, child], prs: w.state()!.prs, message: 'm', files: ['a.ts'] })
  expect(r.isError, r.text).toBe(false)
  expect(r.text).not.toContain('no base check')
})

test('a base check with no script does not say passed', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', noChecks: true, baseCheck: undefined } })
  await start($, w)
  const r = await tool($, 'finishedInterview')
  expect(r.text).toContain('did not run')
  expect(r.text).not.toContain('passed on')
})

test('a base check on a branch that holds commits does not say that the work changed nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  w.s.ahead = '3'
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'finishedInterview')
  expect(r.text).toContain('exited 3')
  expect(r.text).not.toContain('before this work changed anything')
  w.s.ahead = '0'
  expect((await tool($, 'finishedInterview')).text).toContain('before this work changed anything')
})

test('done with an error in the settings stops nothing, and names the repair', async ($, on) => {
  const w = engine(on, finished({ files: { [CONFIG]: '{ not json' } }))
  await start($, w)
  const r = await tool($, 'done', DONE)
  expect(w.steps.filter(l => l.includes('stop-all'))).toEqual([])
  expect(r.text).toContain('did not stop')
  expect(r.text).toContain(`stop-all --worktree ${ROOT}`)
})

test('a straw_man hotfix opens no pass on the checkout of the session', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, config: { projectLevel: 'straw_man' } })
  await start($, w)
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(r.text).toContain('checkpoint')
  const main = (await $.tool.call({ tool: 'Bash', command: `git -C ${ROOT} commit -m fix` } as never)) as { deny?: string }
  expect(main.deny).toContain('checkpoint')
})

test('a push from a hotfix worktree goes only to its own branch', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login' })
  const branch = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.branch as string
  const push = async (rest: string) => ((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push ${rest}` } as never)) as { deny?: string }).deny
  expect(await push('')).toBeUndefined()
  expect(await push(`-u origin ${branch}`)).toBeUndefined()
  expect(await push('origin HEAD')).toBeUndefined()
  expect(await push('origin claude/issue-7')).toContain('hotfix')
  expect(await push('origin HEAD:main')).toContain('hotfix')
  expect(await push('--all')).toContain('hotfix')
  expect(await push(`--force origin ${branch}`)).toContain('hotfix')
})

test('a push from a hotfix worktree passes with its output redirected or piped, and a refusal names the hotfix branch', async ($, on) => {
  const w = engine(on, { wf: { state: 'blocked' } })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login' })
  const branch = JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.branch as string
  const push = async (rest: string) => ((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} push ${rest}` } as never)) as { deny?: string }).deny
  expect(await push('2>&1')).toBeUndefined()
  expect(await push('2>&1 | tail -5')).toBeUndefined()
  expect(await push('origin HEAD 2>&1')).toBeUndefined()
  expect(await push(`-u origin ${branch} 2>/dev/null; echo done`)).toBeUndefined()
  expect(await push('origin HEAD:main 2>&1')).toContain(branch)
  // checkpoint does not commit in a hotfix worktree, and its refusal names the plain git push.
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: [], worktree: CLAIMED })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`git -C ${CLAIMED} push origin ${branch}`)
})

test('a retry with the issue files nothing more, and its worktree and PR pass the guards', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  w.s.claimFails = 'no free slot'
  const failed = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(failed.text).toContain('issue: 31')
  const filed = w.gh.filter(l => l.includes('issue-new')).length
  w.s.claimFails = ''
  const r = await tool($, 'hotfix', { shortName: 'fix-login', issue: 31 })
  expect(r.isError).toBe(false)
  expect(w.gh.filter(l => l.includes('issue-new')).length).toBe(filed)
  expect(((await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m fix` } as never)) as { deny?: string }).deny).toBeUndefined()
  // A second retry after the PR opened uses the same record.
  expect((await tool($, 'hotfix', { shortName: 'fix-login', issue: 31 })).isError).toBe(false)
})

test('the board comes from the main checkout when the worktree has no board setting', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', board: 'progress' }, files: { '/main/.neil-dev.json': JSON.stringify(BOARD.config) } })
  await start($, w)
  await tool($, 'blocked', { message: 'Which colour?' })
  expect(moves(w)).toEqual(['board.sh move I7 awaiting'])
})

test('a settings file with an error shows a toast and moves no card', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', board: 'progress' }, files: { [CONFIG]: '{ not json' } })
  await start($, w)
  const r = await tool($, 'blocked', { message: 'Which colour?' })
  expect(r.isError).toBe(false)
  expect(moves(w)).toEqual([])
  expect(w.toasts.join('\n')).toContain(`the board does not show awaiting for issue #7: ${CONFIG} has an error`)
})

test('a straw_man issue that is done goes to Done: the commit is on the base branch', () => {
  expect(boardColumn({ state: 'done', direct: true })).toBe('done')
  expect(boardColumn({ state: 'done' })).toBe('review')
})

test('hotfix takes the title from the description when there is one', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'hotfix', { shortName: 'fix-login', description: 'Login loops\n\nThe body.' })
  expect(w.gh.find(l => l.includes('issue-new'))).toContain('Login loops')
})

test('hotfix refuses a bad shortName, and a project with no workflow, before it files anything', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  expect((await tool($, 'hotfix', { shortName: 'Fix Login' })).isError).toBe(true)
  expect((await tool($, 'hotfix', { shortName: 'fix-login' })).isError).toBe(true)
  expect(w.gh.filter(l => l.includes('issue-new'))).toEqual([])
})

test('a hotfix that fails after the issue names the issue, so that a retry does not file it twice', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.claimFails = 'no free slot'
  const r = await tool($, 'hotfix', { shortName: 'fix-login' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#31')
  expect(r.text).toContain('no free slot')
  expect(r.text).toContain('worktree_claim.sh')
})
