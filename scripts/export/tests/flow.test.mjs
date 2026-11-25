import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '../../..')
const CHECKS = ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh']
const fresh = () => mkdtempSync(join(tmpdir(), 'ndev-flow-'))

function exportHome() {
  const out = fresh()
  const ran = spawnSync('node', [join(PLUGIN, 'scripts/export/export.mjs'), 'codex', '--out', out], { encoding: 'utf8' })
  assert.equal(ran.status, 0, ran.stderr)
  const home = join(out, 'home')
  const profileFile = join(home, 'flow/profile.json')
  const profile = JSON.parse(readFileSync(profileFile, 'utf8'))
  writeFileSync(profileFile, JSON.stringify({ ...profile, reviewCommand: 'cat {brief} > {out}' }))
  return home
}
const HOME = exportHome()

const FAKE_GH = `#!/bin/bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1" in
  repo) echo '{"repo":"o/r"}' ;;
  default-branch) echo '{"default_branch":"main"}' ;;
  issue-read) if [ -n "$FAKE_ISSUE" ]; then cat "$FAKE_ISSUE"; else echo '{"number":12,"title":"Add a thing","state":"open","body":"Make the thing.","url":"https://github.com/o/r/issues/12"}'; fi ;;
  pr-list) ;;
  pr-new) [ -z "$FAIL_PR_NEW" ] || { echo 'PR creation unavailable' >&2; exit 19; }; cp "$5" "$FAKE_PR_BODY"; echo '{"url":"https://github.com/o/r/pull/7"}' ;;
  pr-edit) echo '{"number":7,"url":"https://github.com/o/r/pull/7"}' ;;
  pr-read) cat "$FAKE_PR" ;;
  feedback) cat "$FAKE_FEEDBACK" ;;
  pr-ready) echo "ready" ;;
  commit-checks) cat "$FAKE_CHECKS" ;;
  comment) echo "https://github.com/o/r/issues/7#issuecomment-1" ;;
  issue-new) echo '{"number":30,"url":"https://github.com/o/r/issues/30"}' ;;
  *) echo "fake gh.sh: no answer for $1" >&2; exit 9 ;;
esac
`
const CHECK = `#!/bin/sh
echo "$(basename "$0") $*" >> "$CHECK_LOG"
case "$0" in *"$FAIL_CHECK") [ -n "$FAIL_CHECK" ] && { echo "lint failed in $*" >&2; exit 1; } ;; esac
exit 0
`

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function project({ scripts = true, config = { steering: 'auto' } } = {}) {
  const dir = fresh()
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, work)
  git(work, 'config', 'user.email', 'flow@example.com')
  git(work, 'config', 'user.name', 'Flow Test')
  writeFileSync(join(work, 'README.md'), 'project\n')
  writeFileSync(join(work, '.gitignore'), '.neil-dev.*\n')
  if (config) writeFileSync(join(work, '.neil-dev.json'), JSON.stringify(config))
  if (scripts) {
    mkdirSync(join(work, 'scripts/ndev/workflow'), { recursive: true })
    for (const name of CHECKS) {
      writeFileSync(join(work, 'scripts/ndev/workflow', name), CHECK)
      chmodSync(join(work, 'scripts/ndev/workflow', name), 0o755)
    }
  }
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base', '--no-verify')
  git(work, 'push', '-q', 'origin', 'HEAD:main')
  git(work, 'switch', '-q', '-c', '12-add-thing')
  const fakeGh = join(dir, 'gh.sh')
  writeFileSync(fakeGh, FAKE_GH)
  const fakeMerge = join(dir, 'merge.sh')
  writeFileSync(fakeMerge, '#!/bin/bash\necho "$*" >> "$FAKE_GH_LOG"\necho \'{"merged":true}\'\n')
  const env = { NDEV_FLOW_GH: fakeGh, NDEV_FLOW_MERGE: fakeMerge, FAKE_PR_BODY: join(dir, 'created-pr-body.md'), FAKE_GH_LOG: join(dir, 'gh.log'), FAKE_CHECKS: join(dir, 'checks.json'), FAKE_PR: join(dir, 'pr.json'), FAKE_FEEDBACK: join(dir, 'feedback.jsonl'), CHECK_LOG: join(dir, 'checks.log'), FAIL_CHECK: '' }
  writeFileSync(env.FAKE_GH_LOG, '')
  writeFileSync(env.CHECK_LOG, '')
  writeFileSync(env.FAKE_FEEDBACK, '')
  const flow = (args, extra = {}) => {
    const r = spawnSync(join(HOME, 'bin/ndev-flow'), args, { cwd: work, encoding: 'utf8', env: { ...process.env, ...env, ...extra } })
    return { ...r, all: `${r.stdout}\n${r.stderr}` }
  }
  const record = () => JSON.parse(readFileSync(join(work, '.neil-dev.issue-12.json'), 'utf8')).workflow
  const read = name => readFileSync(env[name], 'utf8')
  const setChecks = runs => writeFileSync(env.FAKE_CHECKS, JSON.stringify({ check_runs: runs, statuses: [] }))
  const setPr = (fields = {}) => writeFileSync(env.FAKE_PR, JSON.stringify({ number: 7, state: 'open', merged: false, draft: false, mergeable: true, body: 'Plan.\n\nCloses #12\n', created_at: '2026-01-01T00:00:00Z', head: { sha: git(work, 'rev-parse', 'HEAD'), ref: '12-add-thing' }, ...fields }))
  const setFeedback = comments => writeFileSync(env.FAKE_FEEDBACK, comments.map(c => JSON.stringify(c)).join('\n'))
  const writeRecord = change => {
    const file = join(work, '.neil-dev.issue-12.json')
    const all = JSON.parse(readFileSync(file, 'utf8'))
    all.workflow = change(all.workflow)
    writeFileSync(file, JSON.stringify(all))
  }
  setPr()
  return { work, origin, env, flow, record, read, setChecks, setPr, setFeedback, writeRecord }
}

const ok = (r, what) => assert.equal(r.status, 0, `${what} exited ${r.status}:\n${r.all}`)
const CLAUDE_ONLY = [/\/flow /, /\/unblock/, /\bndev:[a-z]/, /The plugin started/, /mcp__ndev__/]
const noClaude = r => {
  for (const re of CLAUDE_ONLY) assert.doesNotMatch(r.stdout, re, `Claude-only text in:\n${r.stdout}`)
}
const until = (check, what) => {
  const end = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    spawnSync('sleep', ['0.1'])
  }
}

test('a light issue goes from started to done through the plugin state machine', () => {
  const p = project()
  const started = p.flow(['started', '--issue', '12', '--short-name', 'add-thing'])
  ok(started, 'started')
  noClaude(started)
  assert.match(started.stdout, /State: developing/)
  assert.match(started.stdout, /The first push opens the draft PR/)
  assert.match(started.stdout, /finishedInterview/)
  const first = p.record()
  assert.equal(first.state, 'developing')
  assert.deepEqual(first.prs, [])
  assert.equal(first.repo, 'o/r')
  assert.equal(first.base, 'main')
  assert.equal(first.branch, '12-add-thing')
  for (const key of ['root', 'evidence', 'attempts', 'nudges', 'followUps', 'migrations', 'history']) assert.ok(key in first, `the record has ${key}`)
  assert.doesNotMatch(p.read('FAKE_GH_LOG'), /^pr-new /m)

  const interviewed = p.flow(['finishedInterview'])
  ok(interviewed, 'finishedInterview')
  assert.match(p.read('CHECK_LOG'), /pre-commit-check\.sh/)
  assert.equal(p.record().baseCheck.exitCode, 0)

  mkdirSync(join(p.work, 'src'))
  writeFileSync(join(p.work, 'src/a.py'), 'a = 1\n')
  const saved = p.flow(['checkpoint', '--message', 'Add a', '--files', 'src/a.py'])
  ok(saved, 'checkpoint')
  noClaude(saved)
  assert.match(p.read('CHECK_LOG'), /fast-checks\.sh src\/a\.py\n.*pre-commit-check\.sh.*\n.*pre-push-check\.sh/)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), git(p.work, 'rev-parse', 'origin/12-add-thing'), 'checkpoint pushed')
  assert.deepEqual(p.record().changeTypes, ['backend'])

  writeFileSync(join(p.work, 'src/b.py'), 'b = 2\n')
  const developed = p.flow(['finishedDevelopment', '--message', 'Add b', '--files', 'src/b.py'])
  ok(developed, 'finishedDevelopment')
  noClaude(developed)
  assert.match(developed.stdout, /State: reviewing/)
  assert.notEqual(git(p.work, 'rev-parse', 'HEAD'), git(p.work, 'rev-parse', 'origin/12-add-thing'), 'the reviewed commit waits for the review')
  const review = p.record().exportReview
  assert.equal(review.runs.length, 1)
  until(() => existsSync(review.runs[0].out) && readFileSync(review.runs[0].out, 'utf8').length > 0, 'the review output')
  const brief = readFileSync(review.runs[0].out, 'utf8')
  assert.match(brief, /Add a thing/)
  assert.match(brief, /git diff origin\/main\.\.\.HEAD/)
  assert.match(developed.stdout, new RegExp(`wait_for_process_end\\.sh ${review.runs[0].pid}`))

  const wrong = p.flow(['finishedChecks'])
  assert.equal(wrong.status, 1)
  assert.match(wrong.all, /Refused: finishedChecks is not valid in the state "reviewing"/)

  const reviewed = p.flow(['finishedReview', '--review', 'No findings.', '--deadcode', 'none', '--remembered', 'nothing: a test'])
  ok(reviewed, 'finishedReview')
  noClaude(reviewed)
  assert.match(reviewed.stdout, /State: ci/)
  assert.match(reviewed.stdout, /gh pr checks 7 --watch --interval 60/)
  assert.match(reviewed.stdout, /It can return before the first check starts\. ndev-flow finishedChecks reads the newest run of each check and says when to wait again\./)
  assert.match(p.read('CHECK_LOG'), /pre-ready-check\.sh/)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), git(p.work, 'rev-parse', 'origin/12-add-thing'), 'finishedReview pushed')
  assert.match(p.read('FAKE_GH_LOG'), /^pr-ready 7$/m)

  p.setChecks([{ name: 'test', status: 'in_progress', conclusion: null, started_at: '2026-11-17T12:00:00Z' }])
  const pending = p.flow(['finishedChecks'])
  assert.equal(pending.status, 1)
  assert.match(pending.all, /test/)
  assert.match(pending.all, /gh pr checks 7 --watch --interval 60/)
  p.setChecks([{ name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-11-17T12:00:00Z' }])
  const red = p.flow(['finishedChecks'])
  assert.equal(red.status, 1)
  assert.match(red.all, /test \(failure\)/)
  p.setChecks([{ name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-17T12:00:00Z' }])
  const green = p.flow(['finishedChecks'])
  ok(green, 'finishedChecks')
  assert.match(green.stdout, /State: finishing/)

  p.setPr()
  const done = p.flow(['done', '--message', 'Added the thing.'])
  ok(done, 'done')
  noClaude(done)
  assert.match(done.stdout, /State: done/)
  assert.match(p.read('FAKE_GH_LOG'), /^comment 7 --body <!-- ndev-flow -->\nndev-flow done: Added the thing\./m)
  assert.equal(p.record().state, 'done')
  assert.ok(p.record().history.length >= 5)
})

test('started goes to setup and names the missing check scripts and the template', () => {
  const p = project({ scripts: false })
  const r = p.flow(['started', '--issue', '12', '--short-name', 'add-thing'])
  ok(r, 'started')
  assert.match(r.stdout, /State: setup/)
  for (const name of CHECKS) assert.match(r.stdout, new RegExp(name.replace('.', '\\.')))
  assert.match(r.stdout, new RegExp(`${HOME}/scripts/workflow/fast-checks-template\\.sh`))
  assert.ok(!/pr-new/.test(p.read('FAKE_GH_LOG')), 'no PR before the scripts exist')
})

test('an interactive light issue starts with the interview and asks in the chat', () => {
  const p = project({ config: null })
  const r = p.flow(['started', '--issue', '12', '--short-name', 'add-thing'])
  ok(r, 'started')
  noClaude(r)
  assert.match(r.stdout, /State: interviewing/)
  assert.match(r.stdout, /ndev-interview/)
  const on = p.flow(['interview'])
  ok(on, 'interview')
  assert.match(on.stdout, /State: developing/)
  assert.match(p.read('CHECK_LOG'), /pre-commit-check\.sh/, 'leaving the interview runs the base check')
})

test('a failed check stops checkpoint, names the script, its exit code and its log, and commits nothing', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const before = git(p.work, 'rev-parse', 'HEAD')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  const r = p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py'], { FAIL_CHECK: 'pre-commit-check.sh' })
  assert.equal(r.status, 1, r.all)
  assert.match(r.all, /scripts\/ndev\/workflow\/pre-commit-check\.sh exited 1/)
  assert.match(r.all, /lint failed/)
  assert.match(r.all, /ndev-pre-commit-check\.sh\.log/)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), before)
})

test('a tool that only the Claude plugin has is refused with what to do instead', () => {
  const p = project()
  for (const tool of ['screenshot', 'epicStarted', 'waitForPR', 'hotfix', 'reportWorkflowBug']) {
    const r = p.flow([tool])
    assert.equal(r.status, 2, `${tool}: ${r.all}`)
    assert.match(r.stderr, /Instead|instead/, tool)
  }
  const create = p.flow(['create'])
  assert.equal(create.status, 2, create.all)
  assert.match(create.stderr, /followUp --mode issue_only/)
  assert.doesNotMatch(create.stderr, /gh\.sh/)
  const unknown = p.flow(['nonsense'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /ndev-flow help/)
})

test('followUp issue_only files an issue and leaves the state as it was', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const r = p.flow(['followUp', '--mode', 'issue_only', '--message', 'Fix the other thing\nIt breaks.'])
  ok(r, 'followUp')
  assert.match(r.stdout, /#30/)
  assert.match(p.read('FAKE_GH_LOG'), /^issue-new --title Fix the other thing --body-file /m)
  assert.equal(p.record().state, 'developing')
  const worktree = p.flow(['followUp', '--mode', 'worktree', '--message', 'x'])
  assert.equal(worktree.status, 2)
})

test('the human skips a phase and the steps say how the human acts', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const blocked = p.flow(['blocked', '--message', 'Which colour?'])
  ok(blocked, 'blocked')
  noClaude(blocked)
  assert.match(blocked.stdout, /ndev-flow unblocked/)
  ok(p.flow(['unblocked', '--message', 'Blue.']), 'unblocked')
  const skipped = p.flow(['skip', '--reason', 'no review needed'])
  ok(skipped, 'skip')
  assert.match(skipped.stdout, /State: reviewing/)
  const status = p.flow(['status'])
  ok(status, 'status')
  assert.match(status.stdout, /State: reviewing/)
})

const green = p => p.setChecks([{ name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-17T12:00:00Z' }])
function toFinishing(p, config) {
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['finishedDevelopment', '--message', 'Add a', '--files', 'a.py']), 'finishedDevelopment')
  ok(p.flow(['finishedReview', '--review', 'No findings.', '--deadcode', 'none', '--remembered', 'nothing: a test']), 'finishedReview')
  green(p)
  p.setPr()
  ok(p.flow(['finishedChecks']), 'finishedChecks')
}

test('the record has the shapes that the Claude plugin reads, so either one can resume the issue', () => {
  const p = project()
  toFinishing(p)
  const wf = p.record()
  for (const h of wf.history) assert.equal(typeof h.at, 'number', `history at ${JSON.stringify(h)}`)
  assert.equal(typeof wf.owner.at, 'number')
  assert.ok(Array.isArray(wf.deadcode.results), `deadcode ${JSON.stringify(wf.deadcode)}`)
  assert.equal(wf.hooks.remember.result, 'nothing: a test')
  assert.equal(typeof wf.hooks.remember.firedAt, 'number')
  assert.equal(wf.hooks.review.result, 'No findings.')
  const head = git(p.work, 'rev-parse', 'HEAD')
  assert.equal(wf.evidence.review.sha, head)
  assert.equal(typeof wf.evidence.review.text, 'string')
  assert.deepEqual(Object.keys(wf.evidence.checks).sort(), ['sha', 'text'])
  assert.equal(wf.evidence.checks.sha, head)
})

test('started refuses a workflow that a live Claude session owns, and --take-over takes it', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  p.writeRecord(wf => ({ ...wf, owner: { session: 'claude-session-1', at: Date.now() } }))
  const refused = p.flow(['started', '--issue', '12'])
  assert.equal(refused.status, 1, refused.all)
  assert.match(refused.all, /claude-session-1/)
  assert.match(refused.all, /--take-over true/)
  const saved = p.flow(['checkpoint', '--message', 'x', '--files', 'README.md'])
  assert.equal(saved.status, 1, saved.all)
  assert.match(saved.all, /claude-session-1/)
  ok(p.flow(['started', '--issue', '12', '--take-over', 'true']), 'take over')
  assert.match(p.record().owner.session, /^ndev-flow:/)
})

test('started on a resumed empty workflow still defers the PR', () => {
  const p = project({ scripts: false })
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  ok(p.flow(['skip', '--reason', 'no checks here']), 'skip setup')
  assert.deepEqual(p.record().prs, [])
  const resumed = p.flow(['started', '--issue', '12'])
  ok(resumed, 'resume')
  assert.deepEqual(p.record().prs, [])
  assert.doesNotMatch(p.read('FAKE_GH_LOG'), /^pr-new /m)
})

test('done refuses each problem at once: a dirty tree, a draft PR at another commit, and a lost Closes line', () => {
  const p = project()
  toFinishing(p)
  p.writeRecord(wf => ({ ...wf, followUps: [{ hash: '1', mode: 'this_agent', issue: 30, title: 'x' }] }))
  writeFileSync(join(p.work, 'stray.txt'), 'x\n')
  p.setPr({ draft: true, head: { sha: 'abcdef1234', ref: '12-add-thing' } })
  const r = p.flow(['done', '--message', 'Done.'])
  assert.equal(r.status, 1, r.all)
  assert.match(r.all, /stray\.txt/)
  assert.match(r.all, /draft/)
  assert.match(r.all, /abcdef12/)
  assert.match(r.all, /Closes #30/)
  assert.equal(p.record().state, 'finishing')
})

test('done with new human feedback goes to revising, and ndev-flow comments and acks are not feedback', () => {
  const p = project()
  toFinishing(p)
  p.setFeedback([
    { id: 1, body: '<!-- ndev-flow -->\nReview of abc', user: { login: 'me' }, created_at: '2026-11-17T12:00:00Z' },
    { id: 2, body: 'Please rename b.', user: { login: 'me' }, created_at: '2026-11-17T12:00:01Z' },
    { id: 3, body: 'lgtm', user: { login: 'ci[bot]', type: 'Bot' }, created_at: '2026-11-17T12:00:02Z' },
    { id: 4, body: 'Old note.', user: { login: 'me' }, created_at: '2025-11-17T12:00:02Z' },
  ])
  const r = p.flow(['done', '--message', 'Done.'])
  ok(r, 'done')
  assert.match(r.stdout, /State: revising/)
  assert.match(r.stdout, /#2 from me: Please rename b\./)
  assert.doesNotMatch(r.stdout, /#1 |#3 |#4 /)
  p.setFeedback([
    { id: 2, body: 'Please rename b.', user: { login: 'me' }, created_at: '2026-11-17T12:00:01Z' },
    { id: 5, body: '<!-- ndev-flow -->\nack:2', user: { login: 'me' }, created_at: '2026-11-17T12:00:03Z' },
  ])
  ok(p.flow(['finishedRevision']), 'finishedRevision')
  assert.equal(typeof p.record().feedbackAt, 'number')
  assert.match(p.read('FAKE_GH_LOG'), /^comment 7 --body <!-- ndev-flow -->/m)
})

test('done merges the PR when the project level lets the agent merge', () => {
  const p = project({ config: { steering: 'auto', projectLevel: 'poc' } })
  toFinishing(p)
  const r = p.flow(['done', '--message', 'Done.'])
  ok(r, 'done')
  assert.match(p.read('FAKE_GH_LOG'), /^7 --repo o\/r$/m)
  assert.equal(p.record().merged, true)
  assert.match(r.stdout, /PR #7 is merged/)
})

test('a human skip of ci lets done pass on red checks, and goto uses the plugin list of states', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['finishedDevelopment', '--message', 'Add a', '--files', 'a.py']), 'finishedDevelopment')
  ok(p.flow(['finishedReview', '--review', 'No findings.', '--deadcode', 'none', '--remembered', 'nothing: a test']), 'finishedReview')
  p.setChecks([{ name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-11-17T12:00:00Z' }])
  ok(p.flow(['skip', '--reason', 'flaky runner']), 'skip ci')
  const checks = p.record().evidence.checks
  assert.equal(checks.byHuman, true)
  assert.equal(checks.text, 'skipped by the human: flaky runner')
  p.setPr()
  const finished = p.flow(['done', '--message', 'Done.'])
  ok(finished, 'done')
  for (const state of ['blocked', 'wait', 'developed']) {
    const r = p.flow(['goto', '--state', state])
    assert.equal(r.status, 2, `${state}: ${r.all}`)
  }
})

test('followUp this_agent files the issue and adds its Closes line to the PR body', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py']), 'checkpoint')
  const r = p.flow(['followUp', '--mode', 'this_agent', '--message', 'Fix the other thing\nIt breaks.'])
  ok(r, 'followUp')
  const edit = /^pr-edit 7 --body-file (\S+)$/m.exec(p.read('FAKE_GH_LOG'))
  assert.ok(edit, p.read('FAKE_GH_LOG'))
  const body = readFileSync(edit[1], 'utf8')
  assert.match(body, /Closes #12/)
  assert.match(body, /Closes #30/)
})

test('pushDraft checks the exact reviewed commit and leaves the PR draft and the readiness gate intact', () => {
  const p = project({ config: { steering: 'auto', checkEnv: ['FAIL_CHECK'] } })
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  ok(p.flow(['finishedInterview']), 'finishedInterview')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py']), 'checkpoint')
  const remote = git(p.work, 'rev-parse', 'origin/12-add-thing')
  writeFileSync(join(p.work, 'README.md'), 'reviewable change\n')
  ok(p.flow(['finishedDevelopment', '--message', 'Update README', '--files', 'README.md']), 'finishedDevelopment')
  const sha = git(p.work, 'rev-parse', 'HEAD')
  const record = p.record()
  const args = ['pushDraft', '--sha', sha, '--review', 'Independent review found no blocking issues.']
  const bin = join(dirname(p.origin), 'git-url-bin')
  mkdirSync(bin)
  const nativeGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const shim = join(bin, 'git')
  writeFileSync(shim, `#!/bin/sh
if [ "\$1 \$2" = "remote get-url" ]; then
  printf '%s\n' https://github.com/o/r.git
  exit 0
fi
exec "${nativeGit}" "\$@"
`, { mode: 0o755 })
  const draft = (args, extra = {}) => p.flow(args, { PATH: bin + ':' + process.env.PATH, ...extra })
  const setDraft = fields => p.setPr({ draft: true, head: { ref: '12-add-thing', sha: remote, crossRepository: false }, ...fields })
  setDraft({ draft: false })
  assert.match(draft(args).all, /open draft PR #7/)
  setDraft({ head: { ref: '12-add-thing', sha: remote, crossRepository: true } })
  assert.match(draft(args).all, /open draft PR #7/)
  setDraft()
  assert.match(draft(['pushDraft', '--sha', remote, '--review', 'Reviewed the prior commit.']).all, /reviewed commit/)
  writeFileSync(join(p.work, 'untracked.txt'), 'local work\n')
  assert.match(draft(args).all, /clean worktree/)
  git(p.work, 'clean', '-f', '--', 'untracked.txt')
  assert.match(draft(args, { FAIL_CHECK: 'pre-push-check.sh' }).all, /pre-push-check\.sh exited 1/)
  assert.equal(git(p.work, 'rev-parse', 'origin/12-add-thing'), remote)
  const ready = p.flow(['finishedReview', '--review', 'Reviewed.', '--deadcode', 'none', '--remembered', 'nothing: a test'], { FAIL_CHECK: 'pre-ready-check.sh' })
  assert.equal(ready.status, 1)
  assert.match(ready.all, /pre-ready-check\.sh exited 1/)
  const ran = draft(args, { FAIL_CHECK: 'pre-ready-check.sh' })
  ok(ran, 'pushDraft')
  assert.match(ran.stdout, /State: reviewing/)
  assert.equal(git(p.work, 'rev-parse', 'origin/12-add-thing'), sha)
  assert.deepEqual(p.record(), record)
  assert.doesNotMatch(p.read('FAKE_GH_LOG'), /^pr-ready/m)
})


test('a fresh start waits for a real push before creating its draft PR', () => {
  const p = project()
  const base = git(p.work, 'rev-parse', 'HEAD')
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  assert.deepEqual(p.record().prs, [])
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), base)
  assert.doesNotMatch(p.read('FAKE_GH_LOG'), /^pr-new /m)
  const remote = spawnSync('git', ['show-ref', '--verify', 'refs/heads/12-add-thing'], { cwd: p.origin, encoding: 'utf8' })
  assert.equal(remote.status, 128)
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py']), 'checkpoint')
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), git(p.origin, 'rev-parse', 'refs/heads/12-add-thing'))
  assert.deepEqual(p.record().prs, [7])
  assert.equal(p.read('FAKE_GH_LOG').match(/^pr-new /gm).length, 1)
})


test('in a project with requirement records, a heavy plan names the records it touches and its model', () => {
  const p = project({ config: { mode: 'heavy', steering: 'auto' } })
  mkdirSync(join(p.work, 'docs/formal/requirements'), { recursive: true })
  mkdirSync(join(p.work, 'docs/formal/models'), { recursive: true })
  writeFileSync(join(p.work, 'docs/formal/requirements/0007-one-version.md'), '---\nid: REQ-0007\n---\n')
  writeFileSync(join(p.work, 'docs/formal/models/migrations.qnt'), 'module migrations {}\n')
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const plan = join(dirname(p.work), 'plan.md')
  const refused = body => {
    writeFileSync(plan, `Implement the thing.\n\nTest entry point: the public command.\n${body}`)
    const r = p.flow(['finishedPlan', '--file', plan])
    assert.equal(r.status, 2, r.all)
    assert.equal(p.record().state, 'planning')
    return r.all
  }
  assert.match(refused(''), /no "Requirements:" line[\s\S]*no "Model:" line/)
  assert.match(refused('Requirements: REQ-0007\n'), /no "Model:" line/)
  assert.match(refused('Requirements: REQ-0008\nModel: none, no state changes\n'), /REQ-0008 has no record in docs\/formal\/requirements/)
  assert.match(refused('Requirements: REQ-0007\nModel: docs/formal/models/missing.qnt#neverTwo\n'), /docs\/formal\/models\/missing\.qnt does not exist/)
  assert.match(refused('Requirements: REQ-0007\nModel: none\n'), /"Model: none" needs a reason/)
  assert.match(refused('Requirements:\nModel: none, the change is a label\n'), /"Requirements:" line is empty/)
  assert.match(refused('Requirements: REQ-0007\nModel: none, no state changes\nREQ-0007: one version at a time.\n'), /REQ-0007 has no line that says how it is verified/)
  writeFileSync(plan, 'Implement the thing.\n\nTest entry point: the public command.\nRequirements: REQ-0007, and a new record for the lock\nModel: docs/formal/models/migrations.qnt#neverTwo\n- REQ-0007: the test tests/lock.test.mjs and the model migrations.qnt#neverTwo\n')
  ok(p.flow(['finishedPlan', '--file', plan]), 'finishedPlan')
  assert.equal(p.record().state, 'developing')
})

const RECORD = (id, status, prs = []) => `---\nid: ${id}\ntitle: "One version"\nstatus: ${status}\n---\n\n## Statement\n\nRun one version at a time.\n\n## Trace\n\n${prs.map(u => `- PR: ${u}\n`).join('')}`

test('started shows the records that the issue cites, and guides an issue that cites none in force', () => {
  const p = project()
  mkdirSync(join(p.work, 'docs/formal/requirements'), { recursive: true })
  writeFileSync(join(p.work, 'docs/formal/requirements/0007-one-version.md'), RECORD('REQ-0007', 'Accepted'))
  writeFileSync(join(p.work, 'docs/formal/requirements/0009-old.md'), RECORD('REQ-0009', 'Retired'))
  const issue = join(dirname(p.work), 'issue.json')
  const cites = body => writeFileSync(issue, JSON.stringify({ number: 12, title: 'Add a thing', state: 'open', body, url: 'https://github.com/o/r/issues/12' }))
  cites('Fulfils REQ-0007 and REQ-0008.')
  const started = p.flow(['started', '--issue', '12', '--short-name', 'add-thing'], { FAKE_ISSUE: issue })
  ok(started, 'started')
  assert.match(started.stdout, /REQ-0007 \(Accepted\): Run one version at a time\./)
  assert.match(started.stdout, /REQ-0008 has no record in docs\/formal\/requirements/)
  assert.doesNotMatch(started.stdout, /cites no record in force/)
  const q = project()
  mkdirSync(join(q.work, 'docs/formal/requirements'), { recursive: true })
  writeFileSync(join(q.work, 'docs/formal/requirements/0009-old.md'), RECORD('REQ-0009', 'Retired'))
  cites('Was REQ-0009.')
  const guided = q.flow(['started', '--issue', '12', '--short-name', 'add-thing'], { FAKE_ISSUE: issue })
  ok(guided, 'started')
  assert.match(guided.stdout, /Issue #12 cites no record in force:\n- REQ-0009 \(Retired\)/)
  assert.match(guided.stdout, /ndev requirements for <file> or ndev requirements search <words>[\s\S]*status Proposed/)
  const r = project()
  assert.doesNotMatch(r.flow(['started', '--issue', '12', '--short-name', 'add-thing']).stdout, /cites no/)
})

test('finishedDevelopment and done refuse a record on the Requirements line whose Trace does not link the PR', () => {
  const p = project()
  mkdirSync(join(p.work, 'docs/formal/requirements'), { recursive: true })
  const file = join(p.work, 'docs/formal/requirements/0007-one-version.md')
  writeFileSync(file, RECORD('REQ-0007', 'Accepted'))
  git(p.work, 'add', '-A')
  git(p.work, 'commit', '-q', '-m', 'record', '--no-verify')
  const body = 'Plan.\n\nRequirements: REQ-0007\n- REQ-0007: the test a.test.py\n\nCloses #12\n'
  p.setPr({ body })
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  ok(p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py']), 'checkpoint')
  writeFileSync(join(p.work, 'b.py'), 'b = 1\n')
  const refused = p.flow(['finishedDevelopment', '--message', 'Add b', '--files', 'b.py'])
  assert.equal(refused.status, 1, refused.all)
  assert.match(refused.all, /REQ-0007 does not link this PR in its Trace[\s\S]*ndev requirements link REQ-0007 https:\/\/github\.com\/o\/r\/pull\/7/)
  assert.equal(p.record().state, 'developing')
  writeFileSync(file, RECORD('REQ-0007', 'Accepted', ['https://github.com/o/r/pull/7']))
  ok(p.flow(['finishedDevelopment', '--message', 'Link the PR', '--files', 'docs/formal/requirements/0007-one-version.md']), 'finishedDevelopment')
  ok(p.flow(['finishedReview', '--review', 'No findings.', '--deadcode', 'none', '--remembered', 'nothing: a test']), 'finishedReview')
  green(p)
  p.setPr({ body })
  ok(p.flow(['finishedChecks']), 'finishedChecks')
  writeFileSync(file, RECORD('REQ-0007', 'Accepted'))
  git(p.work, 'commit', '-q', '-am', 'drop the link', '--no-verify')
  git(p.work, 'push', '-q', 'origin', 'HEAD:12-add-thing')
  green(p)
  p.setPr({ body })
  p.writeRecord(wf => ({ ...wf, state: 'finishing', evidence: { ...wf.evidence, checks: { ...wf.evidence.checks, sha: git(p.work, 'rev-parse', 'HEAD') } } }))
  const notDone = p.flow(['done', '--message', 'finished'])
  assert.equal(notDone.status, 1, notDone.all)
  assert.match(notDone.all, /REQ-0007 does not link this PR in its Trace/)
})

test('the plan lines may be bold, and a model path may sit in brackets or end a sentence', () => {
  const planned = body => {
    const p = project({ config: { mode: 'heavy', steering: 'auto' } })
    mkdirSync(join(p.work, 'docs/formal/requirements'), { recursive: true })
    mkdirSync(join(p.work, 'docs/formal/models'), { recursive: true })
    writeFileSync(join(p.work, 'docs/formal/requirements/0007-one-version.md'), '---\nid: REQ-0007\n---\n')
    writeFileSync(join(p.work, 'docs/formal/models/migrations.qnt'), 'module migrations {}\n')
    writeFileSync(join(dirname(p.work), 'outside.qnt'), 'module outside {}\n')
    ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
    const plan = join(dirname(p.work), 'plan.md')
    writeFileSync(plan, `Implement the thing.\n\nTest entry point: the public command.\n${body}`)
    const r = p.flow(['finishedPlan', '--file', plan])
    return { r, state: p.record().state }
  }
  const refused = body => {
    const { r, state } = planned(body)
    assert.equal(r.status, 2, r.all)
    assert.equal(state, 'planning')
    return r.all
  }
  const accepted = body => {
    const { r, state } = planned(body)
    assert.equal(r.status, 0, r.all)
    assert.equal(state, 'developing')
  }
  accepted('**Requirements:** REQ-0007\n**Model:** none, no state changes\nREQ-0007: the test tests/lock.test.mjs\n')
  accepted('- Requirements: REQ-0007\n- Model: none, the lock is in docs/formal/models/later.qnt\nREQ-0007: the test tests/lock.test.mjs\n')
  accepted('Requirements: REQ-0007\nModel: the lock (docs/formal/models/migrations.qnt).\nREQ-0007: the test tests/lock.test.mjs\n')
  assert.match(refused('**Requirements:**\n**Model:** none, no state changes\n'), /"Requirements:" line is empty; write the value on the same line/)
  assert.match(refused('Requirements: REQ-0007\nModel: ../outside.qnt\n'), /the model \.\.\/outside\.qnt is outside the worktree/)
})

test('the first push keeps the saved plan and can retry PR creation without another commit', () => {
  const p = project({ config: { mode: 'heavy', steering: 'auto' } })
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const plan = join(dirname(p.work), 'plan.md')
  writeFileSync(plan, 'Implement the thing.\n\nTest entry point: the public command.\n')
  ok(p.flow(['finishedPlan', '--file', plan]), 'finishedPlan')
  assert.doesNotMatch(p.read('FAKE_GH_LOG'), /^pr-edit /m)
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  const failed = p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py'], { FAIL_PR_NEW: '1' })
  assert.equal(failed.status, 1, failed.all)
  assert.match(failed.all, /PR creation unavailable/)
  const sha = git(p.work, 'rev-parse', 'HEAD')
  assert.equal(sha, git(p.origin, 'rev-parse', 'refs/heads/12-add-thing'))
  assert.deepEqual(p.record().prs, [])
  ok(p.flow(['checkpoint', '--message', 'Add a', '--files', 'a.py']), 'retry checkpoint')
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), sha)
  assert.deepEqual(p.record().prs, [7])
  assert.match(p.read('FAKE_PR_BODY'), /Implement the thing/)
  assert.match(p.read('FAKE_PR_BODY'), /Closes #12/)
})

test('finishedDevelopment lists the lines that lower the bar, gives them to the reviewer, and goes on', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  mkdirSync(join(p.work, 'src'))
  writeFileSync(join(p.work, 'src/a.test.js'), "test.skip('a', () => {})\ntry { run() } catch (error) {}\n")
  const developed = p.flow(['finishedDevelopment', '--message', 'Add a', '--files', 'src/a.test.js'])
  ok(developed, 'finishedDevelopment')
  assert.match(developed.stdout, /State: reviewing/)
  assert.match(developed.stdout, /Lowered-bar scan:\n/)
  assert.match(developed.stdout, /src\/a\.test\.js:1: skipped or focused test: test\.skip/)
  assert.match(developed.stdout, /src\/a\.test\.js:2: empty catch:/)
  assert.match(developed.stdout, /a line without one is a review finding/)
  const review = p.record().exportReview
  until(() => existsSync(review.runs[0].out) && readFileSync(review.runs[0].out, 'utf8').length > 0, 'the review output')
  assert.match(readFileSync(review.runs[0].out, 'utf8'), /src\/a\.test\.js:1: skipped or focused test/)
})

test('finishedDevelopment says that a clean diff lowers no bar', () => {
  const p = project()
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  writeFileSync(join(p.work, 'a.py'), 'a = 1\n')
  const developed = p.flow(['finishedDevelopment', '--message', 'Add a', '--files', 'a.py'])
  ok(developed, 'finishedDevelopment')
  assert.match(developed.stdout, /Lowered-bar scan: found nothing against origin\/main\./)
})

test('a human goto out of the interview drops the open chat round, and refuses while answers are not on GitHub', () => {
  const p = project({ config: null })
  ok(p.flow(['started', '--issue', '12', '--short-name', 'add-thing']), 'started')
  const file = join(p.work, '.neil-dev.issue-12.json')
  const put = fields => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...fields }))
  put({ rounds: [{ title: 'R', questions: [], answers: [{ id: 'a', selected: ['x'], other: '', notes: '' }], at: 1 }], posted: false })
  const refused = p.flow(['goto', '--state', 'planning'])
  assert.equal(refused.status, 1, refused.all)
  assert.match(refused.stderr, /not on GitHub/)
  assert.match(refused.stderr, /Nothing changed/)
  assert.equal(p.record().state, 'interviewing')
  put({ posted: true, interviewRev: 3, chatRound: { title: 'The login page', questions: [{ id: 'name', header: 'Name', question: 'What name?' }] } })
  const same = p.flow(['goto', '--state', 'interviewing'])
  assert.equal(same.status, 1, same.all)
  assert.match(same.stderr, /already in the state "interviewing"/)
  const moved = p.flow(['goto', '--state', 'planning'])
  ok(moved, 'goto planning')
  assert.match(moved.stdout, /"The login page" had no answers/)
  assert.equal(p.record().state, 'planning')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.chatRound, undefined)
  assert.equal(after.rounds.length, 1)
  assert.equal(after.interviewRev, 4)
})
