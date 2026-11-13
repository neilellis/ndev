// Workflow tests: The base branch, a merged or closed branch, skips and the evidence of a commit. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { ROOT, SHA, CHECKS, engine, start, tool, command, turnEnds, idle, finishing, noChecks, remark, MERGED_PR } from './workflow-harness'

test('started does not claim a branch whose PR has merged, and names the repair', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/lens-hybrid-copy'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }]
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('fix/lens-hybrid-copy')
  expect(r.text).toContain('#58')
  expect(r.text).toContain('git -C /')
  expect(r.text).toContain('origin/main')
  expect(w.state()).toBeUndefined()
  expect(w.pushes).toEqual([])
})

test('started keeps a branch that has an open PR beside a merged one', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/second-round'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }, { number: 70, state: 'open', merged: false }]
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.branch).toBe('fix/second-round')
})

test('started keeps a branch whose only PR was closed without a merge', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/reopened'
  w.s.branchPrs = [{ number: 59, state: 'closed', merged: false }]
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.branch).toBe('fix/reopened')
})

test('create names the filed issue when the branch of the worktree has merged', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.branch = 'fix/lens-hybrid-copy'
  w.s.branchPrs = [{ number: 58, state: 'closed', merged: true }]
  const r = await tool($, 'create', { shortName: 'deactivate-halloween', description: 'Deactivate halloween', mode: 'light' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Issue #31')
  expect(r.text).toContain('fix/lens-hybrid-copy')
  expect(r.text).toContain('Do not call create again')
  expect(w.pushes).toEqual([])
})

test('a failed PR step in started keeps the record, so a retry resumes and does not claim again', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.noOpenPr = true
  w.s.pushFails = 'network down'
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(true)
  expect(w.state()?.issue).toBe(7)
  w.s.noOpenPr = false
  w.s.pushFails = ''
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.prs).toEqual([12])
})

test('a docs commit after green keeps the evidence, also on a retry after a failed push', async ($, on) => {
  const smoked = finishing()
  const w = engine(on, { wf: { ...smoked, evidence: { ...smoked.evidence, smoke: { sha: SHA, text: 'smoked' } } }, names: ['README.md'] })
  await start($, w)
  w.s.pushFails = 'rejected'
  expect((await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })).isError).toBe(true)
  w.s.pushFails = ''
  w.s.staged = false
  const r = await tool($, 'checkpoint', { message: 'docs', files: [] })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('finishing')
  expect(w.state()?.evidence.checks?.sha).toBe(w.s.sha)
})

test('what the commit holds decides the evidence, not the names in the call', async ($, on) => {
  const w = engine(on, { wf: finishing(), names: ['README.md', 'a.ts'] })
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.evidence.checks?.sha).toBe(SHA)
})

test('a skip out of reviewing marks the PR ready and says the commit is held', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { draft: true } })
  await start($, w)
  w.s.sha = 'cccc1'
  await command($, 'skip reviewed by hand')
  expect(w.ready.length).toBe(1)
  expect(w.prompts.at(-1)).toContain('checkpoint with no files')
})

test('goto done refuses a held commit, and changes nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc1'
  expect(await command($, 'goto done')).toContain('not pushed')
  expect(w.state()?.state).toBe('reviewing')
})

test('a failed gates.sh says that the commit is held, not pushed', async ($, on) => {
  const w = engine(on, { config: { mode: 'heavy' }, wf: { state: 'developing' } })
  await start($, w)
  w.s.failCheck = 'gates'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('held')
  expect(r.text).not.toContain('is pushed')
})

test('done at a merging level with migrations says it is not merged', async ($, on) => {
  const path = 'supabase/migrations/20260101_add.sql'
  const w = engine(on, { config: { projectLevel: 'poc' }, wf: { ...finishing(), migrations: [{ name: 'add', path }] }, names: [path] })
  await start($, w)
  w.s.blobSize = '10'
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(w.merges.length).toBe(0)
  expect(r.text).toContain('ndev:merge')
  expect(r.text).not.toContain('finished and merged')
})

test('done at a merging level that merged says merged', async ($, on) => {
  const w = engine(on, { config: { projectLevel: 'poc' }, wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.merges.length).toBe(1)
  expect(r.text).toContain('finished and merged')
})

test('an idle read that finds the PR closed blocks, and sends no prompt', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: false } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.prompts.length).toBe(0)
  expect(w.compacts.length).toBe(0)
})

test('edits to a file that is already changed count as progress at a turn end', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  for (let i = 0; i < 6; i++) {
    w.s.diffText = `edit ${i}`
    await turnEnds($)
  }
  expect(w.state()?.state).toBe('developing')
})

test('a prompt that the host refuses is shown, not lost', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.promptFails = true
  await turnEnds($)
  expect(w.toasts.join(' ')).toContain('was not sent to the model')
})
test('no check on a new commit is pending; later, with no workflows, it is no checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: noChecks })
  await start($, w)
  w.s.commitAt = 0
  const early = await tool($, 'finishedChecks')
  expect(early.isError).toBe(true)
  expect(early.text).toContain('no check has started')
  w.s.now = 3 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(false)
})

test('with workflows that a commit does not trigger, the wait ends after the longer limit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: noChecks })
  await start($, w)
  w.s.commitAt = 0
  w.s.workflowsDir = true
  w.s.now = 3 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(true)
  w.s.now = 11 * 60_000
  expect((await tool($, 'finishedChecks')).isError).toBe(false)
})
test('a comment before the last commit is still feedback at done, until finishedRevision', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [remark]
  w.s.commitIso = '2026-11-03T00:00:00Z'
  w.s.now = Date.parse('2026-11-03T00:00:00Z')
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).toContain('please change this')
  expect(w.state()?.state).toBe('revising')
  expect((await tool($, 'finishedRevision')).isError).toBe(false)
  const again = await tool($, 'status')
  expect(again.isError).toBe(false)
  expect(w.state()?.feedbackAt).toBe(w.s.now)
})

test('a generated report that opens with a machine marker is not feedback at done', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [{ id: 6633384837, body: '<!-- visual-diff -->\n## Visual diff', user: { login: 'human', type: 'User' }, created_at: '2026-11-02T00:00:00Z' }]
  w.s.commitIso = '2026-11-01T00:00:00Z'
  w.s.now = Date.parse('2026-11-03T00:00:00Z')
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('has no answer')
  expect(w.state()?.state).not.toBe('revising')
})
test('done on a PR that a human merged marks the work done and merged, and asks for no more checks', async ($, on) => {
  const w = engine(on, { wf: { ...finishing(), evidence: {} }, pr: MERGED_PR, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.upstream = ''
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('Call done again')
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.merged).toBe(true)
  expect(w.merges).toEqual([])
})

test('done on a merged PR reads no comment as feedback', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: MERGED_PR })
  await start($, w)
  w.s.comments = [remark]
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('has no answer')
  expect(w.state()?.state).toBe('done')
})

test('done on a merged PR names each listed migration, and how to record one that was applied by hand', async ($, on) => {
  const path = 'supabase/migrations/20261104192428_prompt_store_tools.sql'
  const w = engine(on, { wf: { ...finishing(), migrations: [{ name: 'prompt_store_tools', path }] }, names: [path], pr: MERGED_PR })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain(path)
  expect(r.text).toContain('/ndev:merge 12')
  expect(r.text).toContain('supabase migration repair 20261104192428 --status applied')
})

test('done on a merged PR says when this worktree holds work that did not merge', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: { ...MERGED_PR, head: { sha: 'f'.repeat(40), ref: 'issue-7' } } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('not the merged head')
})

test('done on a PR closed with no merge still refuses, names the repair, and does not say to call again for mergeability', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: { state: 'closed', merged: false, mergeable: null } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('closed with no merge')
  expect(r.text).toContain('gh pr reopen 12')
  expect(r.text).not.toContain('has not finished computing')
  expect(w.state()?.state).toBe('finishing')
})

test('feedback at done names how to answer a comment that asks for no change', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  w.s.comments = [remark]
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(w.state()?.state).toBe('revising')
  expect(r.text).toContain('ack:<its id>')
})

test('a PR head that this worktree lacks: finishedRevision names git pull', async ($, on) => {
  const w = engine(on, { wf: { state: 'revising' } })
  await start($, w)
  w.s.commitUnknown = true
  const r = await tool($, 'finishedRevision')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('git pull')
})

test('a raw git commit or push is refused while a workflow runs, and names the tool', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const command of ['git commit -m x', 'git -C /proj push origin HEAD', 'cd /proj && git push']) {
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  }
  const fine = await $.tool.call({ tool: 'Bash', command: 'git log --grep commit' } as never) as { deny?: string }
  expect(fine.deny).toBeUndefined()
})

for (const command of [
  'git -C ~/dev-wiki add -A && git -C ~/dev-wiki commit -qm "learn: x"',
  'git -C ~/dev-wiki commit -m "learn: never git push by hand"',
  'git -C "$HOME/dev-wiki" commit -m x',
  'git -C /home/neil/dev-wiki push',
]) {
  test(`a commit or push in another repository passes while a workflow runs: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

for (const command of [
  'git -C ~/dev-wiki commit -m x && git push',
  'git -C ~/dev-wiki add -A && git commit -m x',
  'git -C /proj/sub commit -m x',
  'git -C "/proj/a dir" commit -m x',
  'git -C ../other commit -m x',
  'git -C /nowhere commit -m x',
  'git -C ~/dev-wiki -C /proj commit -m x',
]) {
  test(`a commit or push that may reach the workflow's repository is refused: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'reviewing' } })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command } as never) as { deny?: string }
    expect(r.deny).toContain('checkpoint')
  })
}

for (const [name, wf] of [['done', { state: 'done' }], ['off', { off: { reason: 'x', at: 0 } }], ['with checks skipped', { noChecks: true }]] as const) {
  test(`a raw git commit passes when the workflow is ${name}`, async ($, on) => {
    const w = engine(on, { wf })
    await start($, w)
    const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as { deny?: string }
    expect(r.deny).toBeUndefined()
  })
}

test('a UI edit after development still gets the component check', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/Late.tsx` } as never) as { context?: string[] }
  expect((r.context ?? []).join(' ')).toContain('ui-components.md')
})
