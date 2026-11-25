// Workflow tests: requestSecret, the check scripts and their env, finishedReview and the push hook. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, CONFIG, engine, settle, start, tool, command, finishing, QUALITY, hookCall, OLD_BASE, NEW_BASE, noChecks } from './workflow-harness'

// ---- requestSecret and addMigration ----
test('requestSecret gives the first file in order and the line, never the value', async ($, on) => {
  engine(on, { files: { [`${ROOT}/.env`]: '# c\nAPI_KEY=hunter2\n', '/home/neil/.zshrc': 'export API_KEY=other\n' } })
  await start($)
  const r = await tool($, 'requestSecret', { name: 'API_KEY' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain(`${ROOT}/.env`)
  expect(r.text).toContain('2')
  expect(r.text).not.toContain('hunter2')
})

test('requestSecret says where it looked when it finds nothing', async ($, on) => {
  engine(on)
  await start($)
  const r = await tool($, 'requestSecret', { name: 'NOPE' })
  expect(r.text).toContain('.neil-dev.env')
  expect(r.text).toContain('.bashrc')
})

test('a commit runs fast-checks.sh on the files, then pre-commit-check.sh, then commits', async ($, on) => {
  const w = engine(on, { names: ['a.py', 'b.ts'] })
  await start($, w)
  w.s.dirty = [' M a.py', ' M b.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.py', 'b.ts'] })
  const order = w.steps.filter(x => x.startsWith('ndev-') || x.includes('-check') || x.includes('fast-checks') || x === 'commit')
  expect(order.slice(0, 3)).toEqual(['fast-checks.sh a.py b.ts', 'pre-commit-check.sh', 'commit'])
})

test('a commit that ends a merge of the base gives the checks the new merge base, not the old one', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = ['M  a.ts']
  w.s.merging = NEW_BASE
  await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(NEW_BASE)
})

test('a commit that ends a merge of the base runs fast-checks.sh only on the files that differ from the base, and says so', async ($, on) => {
  const w = engine(on, { names: ['mine.ts', 'PublishView.tsx', 'TrackedClaims.tsx'] })
  await start($, w)
  w.s.dirty = ['M  mine.ts', 'M  PublishView.tsx', 'M  TrackedClaims.tsx']
  w.s.merging = NEW_BASE
  w.s.fromBase = ['PublishView.tsx', 'TrackedClaims.tsx']
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['mine.ts', 'PublishView.tsx', 'TrackedClaims.tsx'] })
  expect(w.steps).toContain('fast-checks.sh mine.ts')
  expect(r.text).toContain('2 staged files came from the base unchanged')
})

test('a commit with no merge gives the checks the merge base of HEAD', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

test('the checks get the keys of the worktree .neil-dev.env that checkEnv in .neil-dev.json names, and no other', async ($, on) => {
  const w = engine(on, { files: { [CONFIG]: JSON.stringify({ checkEnv: ['TEST_DB_URL', 'QUOTED'] }), [`${ROOT}/.neil-dev.env`]: '# graph\nFALKORDB_URL=rediss://graph.example.com:6380\nTEST_DB_URL=redis://localhost:6379\nexport QUOTED="a b"\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.TEST_DB_URL).toBe('redis://localhost:6379')
  expect(w.s.checkEnv['pre-commit-check.sh']?.QUOTED).toBe('a b')
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_URL).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

// fcc-proto PR #828: .neil-dev.env held FALKORDB_URL and FALKORDB_CA of the hosted graph server, for kb:publish. The
// test scripts start a local server only when FALKORDB_URL is unset, so with that key the tests wrote to the hosted one.
test('with no checkEnv in .neil-dev.json the checks get no key of .neil-dev.env, so the tests do not reach hosted services', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\nFALKORDB_CA=/keys/ca.pem\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_URL).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.FALKORDB_CA).toBeUndefined()
  expect(w.s.checkEnv['pre-commit-check.sh']?.NDEV_MERGE_BASE).toBe(OLD_BASE)
})

test('a check that fails names the .neil-dev.env keys it did not get and how to give one', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\nFALKORDB_CA=/keys/ca.pem\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('did not get FALKORDB_URL, FALKORDB_CA')
  expect(r.text).toContain('checkEnv')
  expect(r.text).not.toContain('graph.example.com')
})

test('a key that checkEnv names but .neil-dev.env does not set stops the check and names the key and the repair', async ($, on) => {
  const w = engine(on, { files: { [CONFIG]: JSON.stringify({ checkEnv: ['TEST_DB_URL'] }), [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=rediss://graph.example.com:6380\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('TEST_DB_URL')
  expect(r.text).toContain('neil-dev-env.mjs init --key TEST_DB_URL')
  expect(w.steps).not.toContain('pre-commit-check.sh')
})

test('a .neil-dev.env line that is not KEY=VALUE stops the check and names the file and the line, not the value', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.env`]: 'FALKORDB_URL=redis://localhost:6379\nsecret-without-key\n' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/.neil-dev.env line 2 is not KEY=VALUE`)
  expect(r.text).not.toContain('secret-without-key')
  expect(w.steps).not.toContain('pre-commit-check.sh')
})

test('a failed check during a merge says that HEAD is the commit before the merge, and names NDEV_MERGE_BASE', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = ['M  a.ts']
  w.s.merging = NEW_BASE
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('A merge is in progress')
  expect(r.text).toContain(`NDEV_MERGE_BASE=${NEW_BASE}`)
})

test('a merge that changes no file is still committed as the merge, and pushed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.merging = NEW_BASE
  w.s.unchanged = ['a.ts']
  const r = await tool($, 'checkpoint', { message: 'Merge origin/main', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.commits[0]).toContain('Merge origin/main')
  expect(w.pushes).toHaveLength(1)
})

test('a failed fast check stops the commit and the slower checks, and names the script', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'fast-checks.sh'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh exited 3')
  expect(w.commits).toEqual([])
  expect(w.steps.some(x => x.includes('pre-commit-check'))).toBe(false)
})

test('started asks for fast-checks.sh, and says it holds the fast tools only', async ($, on) => {
  const w = engine(on, { wf: null, scripts: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh')
  expect(r.text).toContain('ruff')
})

test('started initialises the submodules of the worktree it claims', async ($, on) => {
  const w = engine(on, { wf: null, main: true, config: QUALITY })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.steps).toContain('init-worktree-submodules.sh')
  expect(w.submodules).toEqual([{ command: 'git worktree add /claimed/issue-7', paths: '.claude/agents' }])
})

test('started claims no submodules with no setting for them', async ($, on) => {
  const w = engine(on, { wf: null, main: true })
  await start($, w)
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.steps).not.toContain('init-worktree-submodules.sh')
})

test('finishedDevelopment hands the changed UI files to the review, and only those', async ($, on) => {
  const w = engine(on, { names: ['src/Card.tsx', 'src/Card.test.tsx', 'lib/a.ts'] })
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { prs: [12] })
  expect(r.text).toContain('Component map')
  expect(r.text).toContain('src/Card.tsx')
  expect(r.text).not.toContain('Card.test.tsx')
})

test('finishedDevelopment says nothing of components with no UI file', async ($, on) => {
  const w = engine(on, { names: ['lib/a.ts'] })
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { prs: [12] })
  expect(r.text).not.toContain('Component map')
})

test('the finishing step asks for the dev-wiki ingest', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('ndev:dev-wiki')
})

test('while a workflow runs, the edit, commit, push and component hooks stand aside', async ($, on) => {
  const w = engine(on, { config: QUALITY })
  await start($, w)
  const edit = await hookCall($, 'Edit', { file_path: `${ROOT}/src/Card.tsx`, old_string: 'a', new_string: 'b' })
  const commit = await hookCall($, 'Bash', { command: 'git commit -m x' })
  const push = await hookCall($, 'Bash', { command: 'git push' })
  expect(w.steps.filter(x => x.includes('edited-file-guards') || x.includes('precheck-reminder'))).toEqual([])
  expect([...(edit.context ?? []), ...(commit.context ?? []), ...(push.context ?? [])]).toEqual([])
})

for (const [name, opts] of [
  ['no workflow', { wf: null }],
  ['a workflow in setup', { wf: { state: 'setup' } }],
  ['a skipped setup', { wf: { noChecks: true } }],
  ['a workflow turned off', { wf: { off: { at: 1, reason: 'r' } } }],
  ['a finished workflow', { wf: { state: 'done' } }],
] as const) {
  test(`with ${name}, the hooks still run`, async ($, on) => {
    const w = engine(on, { ...opts, config: QUALITY } as never)
    await start($, w)
    const edit = await hookCall($, 'Edit', { file_path: `${ROOT}/src/Card.tsx`, old_string: 'a', new_string: 'b' })
    const commit = await hookCall($, 'Bash', { command: 'git commit -m x' })
    const push = await hookCall($, 'Bash', { command: 'git push' })
    expect(w.steps.some(x => x.includes('edited-file-guards'))).toBe(true)
    expect(w.steps.some(x => x.includes('precheck-reminder'))).toBe(true)
    expect(edit.context?.join('\n')).toContain('Component map')
    expect(push.context?.join('\n')).toContain('ndev:dev-wiki')
    expect(commit).toBeDefined()
  })
}

// ---- stage hooks: fired by a change of state in the machine ----
test('entering reviewing fires the review hook, and the last commit waits for the review', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(r.text).toContain('Review')
  expect(r.text).toContain('not pushed')
  expect(w.state()?.hooks?.review?.result).toBeUndefined()
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('a fix during the review is committed and held, and the hook does not fire twice', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', hooks: { review: { firedAt: 111 } } } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'fix', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.hooks?.review?.firedAt).toBe(111)
})

test('finishedReview answers the review hook, then pushes, then marks the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', hooks: { review: { firedAt: 111 } } }, pr: { draft: true } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
  expect(w.ready.length).toBe(1)
  expect(w.state()?.hooks?.review?.result).toBe('clean')
  expect(w.state()?.state).toBe('ci')
})

test('with no review result nothing is pushed', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: '', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
})

test('a failed pre-ready check stops the push', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.failCheck = 'pre-ready-check.sh'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
})

test('a push that a pre-push hook refuses stops finishedReview before it marks the PR ready, and names the branch, the git output and the repair', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { draft: true } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.pushFails = 'pre-push: refusing to push HEAD: docs map\nerror: failed to push some refs'
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('git push of issue-7 exited 1: pre-push: refusing to push HEAD: docs map')
  expect(r.text).toContain('The commit is local. Fix the cause and call the tool again.')
  expect(w.pushes.length).toBe(0)
  expect(w.ready.length).toBe(0)
  expect(w.state()?.state).toBe('reviewing')
})

test('a pre-ready check that runs for 19 minutes runs to the end, and the push goes on', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.checkMs = { 'pre-ready-check.sh': 19 * 60_000 }
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.text).not.toContain('exited 127')
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
})

test('a check that outruns the whole limit is stopped, and the refusal names the limit, the time and the log', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  w.s.checkMs = { 'pre-ready-check.sh': 5 * 60 * 60_000 }
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(r.text).toContain('pre-ready-check.sh was still running after 60 minutes')
  expect(r.text).toContain('ndev-pre-ready-check.sh.log')
  expect(r.text).not.toContain('exited 127')
  expect(w.s.checkStops).toEqual(['4242'])
})

test('a held commit can be pushed with an empty checkpoint after a human skips the review', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  w.s.sha = 'cccc'
  const r = await tool($, 'checkpoint', { message: 'push the held commit', files: [] })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
})

// In fcc-proto PR #779 (state "reviewing", one held commit) the push hook named "checkpoint with no files"
// as the way to push it, and checkpoint then refused for a missing file list. In review the commit is
// held for finishedReview, so neither answer may name the empty checkpoint, and both name the real routes.
test('in review the push hook does not offer an empty checkpoint, and names finishedReview', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).not.toContain('With no files it pushes a held commit')
  expect(r.deny).toContain('finishedReview')
  expect(r.deny).toContain('/flow skip')
})

test('while an issue waits for the others on its PR the push hook names finishedDevelopment, not a skip alone', async ($, on) => {
  const w = engine(on, { wf: { state: 'developed' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).not.toContain('With no files it pushes a held commit')
  expect(r.deny).toContain('finishedDevelopment')
})

test('after review the push hook still offers an empty checkpoint for a held commit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' } as never) as { deny?: string }
  expect(r.deny).toContain('With no files it pushes a held commit')
})

test('an empty checkpoint in review names the held commit and finishedReview, not a missing file list', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc1234'
  const r = await tool($, 'checkpoint', { message: 'push the held commit', files: [] })
  expect(r.isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(r.text).not.toContain('needs the files to commit')
  expect(r.text).toContain('cccc1234')
  expect(r.text).toContain('"reviewing"')
  expect(r.text).toContain('finishedReview')
  expect(r.text).toContain('/flow skip')
})

test('an empty checkpoint with nothing to push is still refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'm', files: [] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('files')
})

test('checkpoint commits once and saves when another writer saves the record while its checks run', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'checkpoint', { issue: 7, message: 'm', files: ['a.ts'] })
  await settle()
  // Another session or hook saves the record during the checks, as set-workflow does: one revision more.
  const at = `${ROOT}/.neil-dev.issue-7.json`
  const file = JSON.parse(w.files.get(at)!) as { workflow: Record<string, unknown> }
  w.files.set(at, JSON.stringify({ ...file, workflow: { ...file.workflow, rev: Number(file.workflow.rev ?? 0) + 1, otherWriter: 'kept' } }))
  release()
  const r = await call
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.pushes).toHaveLength(1)
  expect(w.state()?.otherWriter).toBe('kept')
  expect(w.state()?.op).toBeUndefined()
})

test('checkpoint names its retries when another writer changes the record each time', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staleSaves = 99
  const r = await tool($, 'checkpoint', { issue: 7, message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 5')
  expect(r.text).toContain('read the record again 3 times')
  expect(r.text).toContain('Ndev-Op')
})

test('done refuses with no remember result and changes nothing', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('remembered')
  expect(w.state()?.state).toBe('finishing')
})
