import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-checkpoint-')))
after(() => rmSync(tmp, { recursive: true, force: true }))
const home = join(tmp, 'home')
mkdirSync(home)
const env = { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Flow', GIT_AUTHOR_EMAIL: 'flow@example.test', GIT_COMMITTER_NAME: 'Flow', GIT_COMMITTER_EMAIL: 'flow@example.test', CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), GH_CONFIG_DIR: join(home, 'gh'), ORCA_AGENT_SESSION_ID: 'session-A' }
function run(cwd, cmd, args, extra = {}) {
  return spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
}
function output(result) {
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const git = (cwd, ...args) => output(run(cwd, 'git', args))
const source = join(repo, 'scripts/export/flow/cli.ts')
function project() {
  const dir = mkdtempSync(join(tmp, 'project-'))
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, work)
  writeFileSync(join(work, 'base'), 'start\n')
  git(work, 'add', 'base')
  git(work, 'commit', '-qm', 'Base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-qc', 'feature')
  writeFileSync(join(work, 'feature.txt'), 'feature\n')
  git(work, 'add', 'feature.txt')
  git(work, 'commit', '-qm', 'First feature change')
  git(work, 'push', '-qu', 'origin', 'feature')
  const workflow = { issue: 7, repo: 'test/project', root: work, branch: 'feature', base: 'main', prs: [9], mode: 'light', steering: 'auto', state: 'developing', baseCheck: { exitCode: 0 }, noChecks: true, evidence: {}, history: [], followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, rev: 1 }
  const file = join(work, '.neil-dev.issue-7.json')
  writeFileSync(file, JSON.stringify({ version: 1, issue: 7, workflow }))
  const checkpoint = (extra = {}) => run(work, process.execPath, [source, 'checkpoint', '--issue', '7', '--message', 'Second feature change', '--files', 'next.txt'], extra)
  writeFileSync(join(work, 'next.txt'), 'next\n')
  return { dir, origin, work, checkpoint, file }
}
function rebase(work) {
  git(work, 'switch', '-q', 'main')
  writeFileSync(join(work, 'base'), 'updated\n')
  git(work, 'commit', '-qam', 'Advance base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'switch', '-q', 'feature')
  git(work, 'rebase', 'main')
}
test('checkpoint replaces a patch-equivalent remote commit after rebase with an observed lease', () => {
  const p = project()
  const old = git(p.origin, 'rev-parse', 'feature')
  rebase(p.work)
  const result = p.checkpoint()
  assert.match(output(result), /lease/i)
  assert.notEqual(old, git(p.origin, 'rev-parse', 'feature'))
  assert.equal(git(p.origin, 'rev-parse', 'feature'), git(p.work, 'rev-parse', 'HEAD'))
})
test('checkpoint identifies unpublished remote work, then retries its held commit after a rebase', () => {
  const p = project()
  const peer = join(p.dir, 'peer')
  git(p.dir, 'clone', '-qb', 'feature', p.origin, peer)
  writeFileSync(join(peer, 'peer'), 'peer work\n')
  git(peer, 'add', 'peer')
  git(peer, 'commit', '-qm', 'Keep peer work')
  git(peer, 'push', '-q')
  const before = git(peer, 'rev-parse', 'HEAD')
  const stopped = p.checkpoint()
  assert.equal(stopped.status, 1)
  assert.match(stopped.stderr, /Keep peer work/)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), before)
  git(p.work, 'rebase', 'origin/feature')
  const held = git(p.work, 'rev-parse', 'HEAD')
  output(p.checkpoint())
  assert.equal(git(p.origin, 'rev-parse', 'feature'), held)
})
test('a remote write between fetch and lease push keeps both writers commits', () => {
  const p = project()
  rebase(p.work)
  const peer = join(p.dir, 'peer')
  git(p.dir, 'clone', '-qb', 'feature', p.origin, peer)
  git(peer, 'commit', '--allow-empty', '-qm', 'Racing writer')
  const raced = git(peer, 'rev-parse', 'HEAD')
  const bin = join(p.dir, 'bin')
  mkdirSync(bin)
  const nativeGit = output(run(p.work, 'sh', ['-c', 'command -v git']))
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor arg do\n case "$arg" in --force-with-lease=*) "$NATIVE_GIT" -C "$PEER" push -q origin feature || exit 1 ;; esac\ndone\nexec "$NATIVE_GIT" "$@"\n')
  chmodSync(join(bin, 'git'), 0o755)
  const result = p.checkpoint({ PATH: bin + ':' + env.PATH, PEER: peer, NATIVE_GIT: nativeGit })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /force-with-lease.*expected/i)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), raced)
  assert.equal(git(p.work, 'log', '-1', '--format=%s'), 'Second feature change')
})
test('a checkpoint refuses an unrelated staged path before committing', () => {
  const p = project()
  writeFileSync(join(p.work, 'unrelated'), 'other change\n')
  git(p.work, 'add', 'unrelated')
  const before = git(p.work, 'rev-parse', 'HEAD')
  const result = p.checkpoint()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unrelated/)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), before)
})

function flow(project, args, extra = {}) {
  const script = `import * as flow from ${JSON.stringify(new URL('../flow/cli.ts', import.meta.url))}; try { console.log(JSON.stringify(flow.runFlow(process.argv.slice(1)))) } catch (error) { console.error(error.message); process.exitCode = error.code || 1 }`
  return run(project.work, process.execPath, ['--input-type=module', '-e', script, '--', ...args], extra)
}
test('status resolves the selected PR and refuses an unrelated PR without touching the record', () => {
  const p = project()
  const original = readFileSync(p.file, 'utf8')
  assert.equal(JSON.parse(output(flow(p, ['status', '--pr', '9']))).issue, 7)
  const missing = flow(p, ['status', '--pr', '5'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /PR #5/)
  assert.equal(readFileSync(p.file, 'utf8'), original)
})
test('public checkpoint uses repeated literal paths, including commas, and records the Orca owner', () => {
  const p = project()
  writeFileSync(join(p.work, 'a,b.txt'), 'comma\n')
  const result = JSON.parse(output(flow(p, ['checkpoint', '--message', 'Save both', '--file', 'next.txt', '--file', 'a,b.txt'])))
  assert.equal(result.workflow.owner.session, 'session-A')
  assert.equal(git(p.work, 'show', 'HEAD:a,b.txt'), 'comma')
  assert.equal(git(p.origin, 'show', 'feature:next.txt'), 'next')
  const refused = flow(p, ['blocked', '--message', 'Need input'], { ORCA_AGENT_SESSION_ID: 'session-B' })
  assert.match(refused.stderr, /session-A/)
  assert.equal(refused.status, 1)
})
test('confirmation and incompatible hack/auto settings leave the revision untouched', () => {
  const p = project()
  const original = readFileSync(p.file, 'utf8')
  const mode = flow(p, ['mode', 'hack'])
  assert.equal(mode.status, 2)
  assert.match(mode.stderr, /hack.*auto/i)
  const skip = JSON.parse(output(flow(p, ['skip', 'No review'])))
  assert.ok(skip.nextAction)
  assert.equal(readFileSync(p.file, 'utf8'), original)
})

function services(p) {
  const fakeGh = join(p.dir, 'gh.sh')
  const bin = join(p.dir, 'fake-bin')
  mkdirSync(bin)
  const ghLog = join(p.dir, 'gh.log')
  const orcaLog = join(p.dir, 'orca.log')
  writeFileSync(orcaLog, '')
  const prBody = join(p.dir, 'body')
  writeFileSync(prBody, 'Closes #7\n')
  writeFileSync(fakeGh, `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1" in
repo) echo '{"repo":"test/project"}' ;;
default-branch) echo '{"default_branch":"main"}' ;;
issue-read) echo '{"title":"Fix the thing","state":"open"}' ;;
issue-new) if [ -n "$ACCEPTED_BODY" ]; then cp "$5" "$ACCEPTED_BODY"; echo 'lost create response' >&2; exit 33; fi; echo '{"number":40,"url":"https://github.com/test/project/issues/40"}' ;;
api) if [ -z "$SEARCH_DELAY" ]; then jq -n --rawfile body "$ACCEPTED_BODY" '[{number:40,body:$body},{number:55,body:"unrelated"},{number:67,body:$body,pull_request:{}}]' | jq -r "$5"; fi ;;
pr-list) [ -z "$EXISTING_PR" ] || echo '{"number":9}' ;;
pr-new) echo '{"url":"https://github.com/test/project/pull/9"}' ;;
pr-read) if [ -n "$PR_READ_FAIL" ]; then echo "$PR_READ_FAIL" >&2; exit 37; fi; node -e 'console.log(JSON.stringify({number:9,state:"open",...(process.env.PR_MERGEABLE === undefined ? {} : {mergeable:JSON.parse(process.env.PR_MERGEABLE)}),draft:process.env.PR_DRAFT==="1",head:{crossRepository:false,sha:process.env.PR_SHA || require("node:child_process").execSync("git rev-parse HEAD").toString().trim(),ref:require("node:child_process").execSync("git branch --show-current").toString().trim()},body:require("node:fs").readFileSync(process.env.PR_BODY,"utf8")}))' ;;
pr-edit) cp "$4" "$PR_BODY" ;;
comment|subissues|pr-ready) echo '{"ok":true}' ;;
commit-checks) if [ -n "$MOVE_DURING_CHECKS" ]; then git commit --allow-empty -qm 'New head while reading checks'; git push -q origin HEAD:feature; fi; echo '{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}],"statuses":[]}' ;;
*) echo "Unsupported gh command $*" >&2; exit 22 ;;
esac
`)
  writeFileSync(join(bin, 'orca'), `#!/bin/sh
echo "$*" >> "$ORCA_LOG"
case "$1 $2" in
'worktree create')
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in --branch) branch="$2"; shift 2 ;; --name) name="$2"; shift 2 ;; *) shift ;; esac
  done
  git worktree add -qb "$branch" "$FAKE_BASE_DIR/$name" origin/main || exit 1
  echo "{\\"ok\\":true,\\"result\\":{\\"worktree\\":{\\"path\\":\\"$FAKE_BASE_DIR/$name\\"}}}" ;;
'worktree set') echo '{"ok":true,"result":{"updated":true}}' ;;
'orchestration worker-start') echo '{"ok":true,"result":{"state":"ready","runId":"run-1","dispatchId":"dispatch-1"}}' ;;
*) echo "Unsupported Orca command $*" >&2; exit 23 ;;
esac
`)
  chmodSync(join(bin, 'orca'), 0o755)
  const osascript = join(bin, 'osascript')
  writeFileSync(osascript, '#!/bin/sh\necho "$*" >> "$ORCA_LOG"\n')
  chmodSync(osascript, 0o755)
  return { NDEV_FLOW_GH: fakeGh, GH_LOG: ghLog, ORCA_LOG: orcaLog, FAKE_BASE_DIR: p.dir, PR_BODY: prBody, PATH: bin + ':' + env.PATH, ORCA_ENVIRONMENT: 'local', NDEV_OSASCRIPT: osascript }
}
test('blocked flags the Orca workspace and unblock clears it and restores the phase', () => {
  const p = project()
  const fake = services(p)
  const blocked = JSON.parse(output(flow(p, ['blocked', '--message', 'Need a key'], fake)))
  assert.equal(blocked.state, 'blocked')
  assert.match(readFileSync(fake.ORCA_LOG, 'utf8'), /worktree set.*--unread/)
  const result = JSON.parse(output(flow(p, ['unblock', 'Key added'], fake)))
  assert.equal(result.state, 'developing')
  assert.match(readFileSync(fake.ORCA_LOG, 'utf8'), /worktree set.*--read\b/)
})
test('existing follow-up issues launch one Orca worker and retry reuses its receipt', () => {
  const p = project()
  const fake = services(p)
  const message = join(p.dir, 'description')
  writeFileSync(message, 'Finish both\nOne PR for both issues.\n')
  const args = ['follow-up', '--mode', 'worktree', '--message-file', message, '--existing-issue', '15', '--existing-issue', '20']
  const first = JSON.parse(output(flow(p, args, fake)))
  assert.equal(first.workflow.followUps[0].dispatchId, 'dispatch-1')
  assert.deepEqual(first.workflow.followUps[0].issues, [15, 20])
  output(flow(p, args, fake))
  assert.equal(readFileSync(fake.ORCA_LOG, 'utf8').match(/worker-start/g).length, 1)
  assert.doesNotMatch(readFileSync(fake.GH_LOG, 'utf8'), /issue-new/)
})
test('migration retries keep the file and a new version retains its SQL in the PR list', () => {
  const p = project()
  const fake = services(p)
  mkdirSync(join(p.work, 'supabase'))
  writeFileSync(join(p.work, 'supabase/config.toml'), '')
  const args = ['add-migration', 'new_table']
  const create = JSON.parse(output(flow(p, args, fake)))
  const old = create.workflow.migrations[0].path
  writeFileSync(join(p.work, old), 'create table example(id int);')
  const again = JSON.parse(output(flow(p, args, fake)))
  assert.deepEqual(again.workflow.migrations, create.workflow.migrations)
  const replaced = JSON.parse(output(flow(p, [...args, '--new-version'], fake)))
  const path = replaced.workflow.migrations[0].path
  assert.notEqual(path, old)
  assert.equal(readFileSync(join(p.work, path), 'utf8'), 'create table example(id int);')
  assert.ok(readFileSync(fake.PR_BODY, 'utf8').includes(path))
})
test('a pending interview survives a bad answer and accepts an answer by question ID', () => {
  const p = project()
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  raw.workflow.state = 'interviewing'
  writeFileSync(p.file, JSON.stringify(raw))
  const input = join(p.dir, 'round')
  writeFileSync(input, JSON.stringify({ title: 'Scope', questions: [{ id: 'goal', header: 'Goal', question: 'What should ship?', suggested: 'CLI' }] }))
  const view = JSON.parse(output(flow(p, ['interview', '--round-file', input])))
  assert.equal(view.actions[0].id, 'interview.answer')
  writeFileSync(input, JSON.stringify({ wrong: { other: 'CLI' } }))
  const bad = flow(p, ['interview', '--answers-file', input])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /wrong/)
  writeFileSync(input, JSON.stringify({ goal: { other: 'CLI and tests' } }))
  const result = JSON.parse(output(flow(p, ['interview', '--answers-file', input])))
  assert.equal(result.rounds[0].answers[0].other, 'CLI and tests')
  assert.equal(result.state, 'interviewing')
})

test('two issues on one PR wait for the last developer and share one PR review record', () => {
  const p = project()
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  writeFileSync(join(p.work, '.neil-dev.issue-8.json'), JSON.stringify({ ...raw, issue: 8, workflow: { ...raw.workflow, issue: 8 } }))
  const fake = services(p)
  const first = JSON.parse(output(flow(p, ['finished-development', '--issue', '7'], fake)))
  assert.equal(first.state, 'developed')
  const final = JSON.parse(output(flow(p, ['finished-development', '--issue', '7', '--issue', '8'], fake)))
  assert.equal(final.state, 'reviewing')
  assert.deepEqual(final.workflow.issues, [7, 8])
  assert.equal(final.workflow.exportReview.runs[0].dispatchId, 'dispatch-1')
  const status = JSON.parse(output(flow(p, ['status', '--pr', '9'])))
  assert.equal(status.workflow.pr, 9)
  assert.equal(status.state, 'reviewing')
})

test('the code review checks the base North Star without copying it into reviewer briefs', () => {
  for (const mode of ['light', 'heavy']) {
    const p = project()
    const record = JSON.parse(readFileSync(p.file, 'utf8'))
    record.workflow.mode = mode
    writeFileSync(p.file, JSON.stringify(record))
    git(p.work, 'switch', '-q', 'main')
    writeFileSync(join(p.work, 'NORTH_STAR.md'), '# North Star\n\nFixture statement kept out of the brief.\n')
    git(p.work, 'add', 'NORTH_STAR.md')
    git(p.work, 'commit', '-qm', 'Record the project North Star')
    git(p.work, 'push', '-q', 'origin', 'main')
    git(p.work, 'switch', '-q', 'feature')
    const fake = { ...services(p), NDEV_REVIEW_AGENT: mode === 'heavy' ? 'claude' : 'codex' }
    if (mode === 'heavy') {
      const gh = join(p.dir, 'fake-bin/gh')
      writeFileSync(gh, '#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 22\njq -n --rawfile body "$PR_BODY" \'{body: $body, state: "OPEN", mergeStateStatus: "CLEAN"}\'\n', { mode: 0o755 })
      writeFileSync(fake.PR_BODY, 'Test entry point: CLI review brief.\n\nCloses #7\n')
      mkdirSync(join(p.work, 'e2e'))
      writeFileSync(join(p.work, 'issue_7_unit.txt'), 'Unit test evidence\n')
      writeFileSync(join(p.work, 'e2e/issue_7_cli.txt'), 'CLI test evidence\n')
      git(p.work, 'add', 'issue_7_unit.txt', 'e2e/issue_7_cli.txt')
      git(p.work, 'commit', '-qm', 'Record the gate fixture files')
    }
    const result = JSON.parse(output(flow(p, ['finished-development', '--issue', '7'], fake)))
    assert.equal(result.state, 'reviewing')
    const briefs = new Map(result.workflow.exportReview.runs.map(run => [run.axis, readFileSync(run.brief, 'utf8')]))
    const standard = briefs.get(mode === 'heavy' ? 'standards' : 'review')
    assert.match(standard, /origin\/main:NORTH_STAR\.md/)
    assert.match(standard, /read only the sections that apply/i)
    assert.match(standard, /cite the section and the changed file and line/i)
    assert.match(standard, /owner approval/i)
    assert.match(standard, /follow any sources the file gives priority/i)
    assert.match(standard, /use the base rules for the rest of the diff/i)
    assert.match(standard, /no applicable sections.*file absent/i)
    assert.match(standard, /when the file is absent, use the remaining project guidance/i)
    if (mode === 'heavy') assert.doesNotMatch(briefs.get('specification'), /NORTH_STAR\.md/)
    const dispatched = readFileSync(fake.ORCA_LOG, 'utf8')
    assert.ok(dispatched.includes(mode === 'heavy' ? '--model sonnet' : '--model gpt-6.1-terra'), dispatched)
    assert.match(dispatched, /origin\/main:NORTH_STAR\.md/)
    assert.doesNotMatch(dispatched, /Fixture statement kept out/)
  }
})
test('starting from the base uses the Orca worktree receipt and defers the draft PR', () => {
  const p = project()
  const fake = services(p)
  rmSync(p.file)
  git(p.work, 'switch', '-q', 'main')
  const checks = join(p.work, 'scripts/ndev/workflow')
  mkdirSync(checks, { recursive: true })
  for (const name of ['fast-checks', 'pre-commit-check', 'pre-push-check', 'pre-ready-check']) writeFileSync(join(checks, name + '.sh'), 'exit 0\n')
  git(p.work, 'add', 'scripts')
  git(p.work, 'commit', '-qm', 'Install workflow checks')
  git(p.work, 'push', '-q', 'origin', 'main')
  const args = ['start', '7', '--short-name', 'test-claim']
  const start = JSON.parse(output(flow(p, args, fake)))
  assert.match(start.root, /7-test-claim$/)
  assert.equal(start.workflow.owner.session, 'session-A')
  assert.deepEqual(start.workflow.prs, [])
  const status = output(run(p.work, join(repo, 'bin/ndev'), ['flow', 'status', '--json'], fake))
  assert.equal(JSON.parse(status).result.root, start.root)
  const resumed = JSON.parse(output(flow(p, args, fake)))
  assert.equal(resumed.root, start.root)
  assert.doesNotMatch(readFileSync(fake.GH_LOG, 'utf8'), /^pr-new /m)
  assert.equal(readFileSync(fake.ORCA_LOG, 'utf8').match(/worktree create/g).length, 1)
  const denied = flow(p, args, { ...fake, ORCA_AGENT_SESSION_ID: 'another-owner' })
  assert.equal(denied.status, 1)
  assert.match(denied.stderr, /session-A/)
})
test('green checks cannot advance a PR whose GitHub head differs from local HEAD', () => {
  const p = project()
  const fake = services(p)
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  raw.workflow.state = 'ci'
  writeFileSync(p.file, JSON.stringify(raw))
  const stale = flow(p, ['finished-checks'], { ...fake, PR_SHA: 'f'.repeat(40) })
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /PR #9.*ffff/)
  assert.equal(JSON.parse(readFileSync(p.file, 'utf8')).workflow.rev, 1)
  const race = flow(p, ['finished-checks'], { ...fake, MOVE_DURING_CHECKS: '1' })
  assert.equal(race.status, 1)
  assert.equal(JSON.parse(readFileSync(p.file, 'utf8')).workflow.rev, 1)
  const live = JSON.parse(output(flow(p, ['finished-checks'], fake)))
  assert.equal(live.workflow.evidence.checks.sha, git(p.work, 'rev-parse', 'HEAD'))
})
test('flow start joins an owned open PR with the new closing line and refuses a live foreign carrier', () => {
  const p = project()
  const fake = services(p)
  const owner = JSON.parse(readFileSync(p.file, 'utf8'))
  owner.workflow.owner = { session: 'session-A', at: Date.now() }
  writeFileSync(p.file, JSON.stringify(owner))
  const checks = join(p.work, 'scripts/ndev/workflow')
  mkdirSync(checks, { recursive: true })
  for (const name of ['fast-checks', 'pre-commit-check', 'pre-push-check', 'pre-ready-check']) writeFileSync(join(checks, name + '.sh'), 'exit 0\n')
  const refused = flow(p, ['start', '19', '--short-name', 'other-issue'], { ...fake, EXISTING_PR: '1', ORCA_AGENT_SESSION_ID: 'session-B' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /session-A/)
  const joined = JSON.parse(output(flow(p, ['start', '19', '--short-name', 'other-issue'], { ...fake, EXISTING_PR: '1' })))
  assert.deepEqual(joined.workflow.prs, [9])
  assert.match(readFileSync(fake.PR_BODY, 'utf8'), /Closes #19/)
})

for (const command of ['create', 'hotfix', 'follow-up']) {
  test(command + ' recovers an accepted issue when GitHub lost the create response', () => {
    const p = project()
    const fake = { ...services(p), ACCEPTED_BODY: join(p.dir, 'accepted-body') }
    const description = join(p.dir, 'description')
    writeFileSync(description, 'Recover my issue\nEvidence and steps.\n')
    const args = command === 'follow-up' ? [command, '--mode', 'issue_only', '--message-file', description] : [command, 'recover-issue', '--description-file', description]
    const first = flow(p, args, fake)
    assert.equal(first.status, 1, first.stderr)
    assert.match(first.stderr, /lost create response/)
    const uncertain = flow(p, args, { ...fake, SEARCH_DELAY: '1' })
    assert.match(uncertain.stderr, /uncertain|no matching issue/i)
    const second = flow(p, args, fake)
    assert.match(output(second), /(?:#40|"issue":40)/)
    assert.equal(readFileSync(fake.GH_LOG, 'utf8').split('\n').filter(line => line.startsWith('issue-new ')).length, 1)
    assert.match(readFileSync(fake.ACCEPTED_BODY, 'utf8'), /<!-- ndev-issue-request-/)
  })
}

test('review checkpoints hold a fourth head without launching a fourth review round', () => {
  const p = project()
  const fake = services(p)
  const base = git(p.origin, 'rev-parse', 'feature')
  output(flow(p, ['finished-development', '--issue', '7'], fake))
  for (const round of [2, 3, 4]) {
    writeFileSync(join(p.work, 'next.txt'), `round ${round}\n`)
    output(flow(p, ['checkpoint', '--file', 'next.txt', '--message', `Fix for round ${round}`], fake))
  }
  assert.equal(readFileSync(fake.ORCA_LOG, 'utf8').match(/worker-start/g).length, 3)
  const status = JSON.parse(output(flow(p, ['status', '--issue', '7'], fake)))
  assert.match(status.next, /3 review rounds.*--waive-review/)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), base)
  const refused = flow(p, ['finished-review', '--review', 'Third review', '--deadcode', 'None', '--remembered', 'None'], fake)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /3 review rounds.*--waive-review/)
  const closed = JSON.parse(output(flow(p, ['finished-review', '--waive-review', 'Fourth commit only corrects a spelling nit', '--deadcode', 'None', '--remembered', 'None'], fake)))
  assert.equal(closed.state, 'ci')
  assert.match(closed.workflow.evidence.review.text, /waived.*Fourth commit only corrects a spelling nit/i)
  assert.equal(closed.workflow.evidence.review.sha, git(p.origin, 'rev-parse', 'feature'))
})

test('the review limit also applies to workflows opened before the counter existed', () => {
  const p = project()
  const fake = services(p)
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  raw.workflow.state = 'reviewing'
  raw.workflow.exportReview = { sha: git(p.work, 'rev-parse', 'HEAD'), runs: [{ axis: 'review', dispatchId: 'old-review' }] }
  raw.workflow.history = [
    { tool: 'finishedDevelopment', from: 'developing', to: 'reviewing' },
    { tool: 'checkpoint', from: 'reviewing', to: 'reviewing' },
    { tool: 'checkpoint', from: 'reviewing', to: 'reviewing' },
  ]
  writeFileSync(p.file, JSON.stringify(raw))
  const held = JSON.parse(output(flow(p, ['checkpoint', '--file', 'next.txt', '--message', 'Fix the last finding'], fake)))
  assert.equal(held.workflow.reviewRounds, 3)
  assert.match(held.next, /No more reviews will start/)
  assert.doesNotMatch(readFileSync(fake.ORCA_LOG, 'utf8'), /worker-start/)
})

test('an early nitpick waiver keeps the pre-ready gate and records the reason on the pushed head', () => {
  const p = project()
  const fake = services(p)
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  raw.workflow.noChecks = false
  writeFileSync(p.file, JSON.stringify(raw))
  const checks = join(p.work, 'scripts/ndev/workflow')
  mkdirSync(checks, { recursive: true })
  const check = join(checks, 'pre-ready-check.sh')
  writeFileSync(check, '#!/bin/sh\n[ "$FAIL_READY" != 1 ] || exit 19\necho pre-ready-passed\n')
  output(flow(p, ['finished-development', '--issue', '7'], fake))
  const base = git(p.origin, 'rev-parse', 'feature')
  git(p.work, 'commit', '--allow-empty', '-qm', 'Tidy punctuation')
  const cmd = ['finished-review', '--waive-review', 'Only punctuation remains', '--deadcode', 'None', '--remembered', 'None']
  const failed = flow(p, cmd, { ...fake, FAIL_READY: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /pre-ready-check\.sh exited 19/)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), base)
  assert.doesNotMatch(readFileSync(fake.GH_LOG, 'utf8'), /pr-ready/)
  const finished = JSON.parse(output(flow(p, cmd, fake)))
  assert.equal(finished.workflow.evidence.review.sha, git(p.origin, 'rev-parse', 'feature'))
  assert.match(readFileSync(fake.GH_LOG, 'utf8'), /waived.*Only punctuation remains/i)
  assert.doesNotMatch(readFileSync(fake.ORCA_LOG, 'utf8'), /worker-show/)
})


test('public push-draft keeps Git hooks and pushes only the stated reviewing SHA', () => {
  const p = project()
  const fake = services(p)
  mkdirSync(join(p.work, 'scripts/ndev/workflow'), { recursive: true })
  writeFileSync(join(p.work, 'scripts/ndev/workflow/pre-push-check.sh'), 'exit 0\n')
  output(flow(p, ['checkpoint', '--file', 'next.txt', '--file', 'scripts/ndev/workflow/pre-push-check.sh', '--message', 'Install the check'], fake))
  writeFileSync(join(p.work, 'next.txt'), 'review me\n')
  output(flow(p, ['finished-development', '--issue', '7', '--file', 'next.txt', '--message', 'Reviewable change'], fake))
  const remote = git(p.origin, 'rev-parse', 'feature')
  const sha = git(p.work, 'rev-parse', 'HEAD')
  const hook = join(p.work, '.git/hooks/pre-push')
  writeFileSync(hook, '#!/bin/sh\necho "the pre-push hook refused" >&2\nexit 1\n', { mode: 0o755 })
  const gitIgnore = join(p.work, '.git/info/exclude')
  writeFileSync(gitIgnore, '.neil-dev.*\n')
  const args = ['push-draft', '--pr', '9', '--sha', sha, '--review', 'Independent review recorded.']
  const before = readFileSync(p.file, 'utf8')
  const fakeGit = git(p.work, 'config', '--get', 'remote.origin.url')
  const bin = join(p.dir, 'git-url-bin')
  mkdirSync(bin)
  const gitShim = join(bin, 'git')
  writeFileSync(gitShim, `#!/bin/sh
if [ "\$1 \$2" = "remote get-url" ]; then
  urls=\$(command_git "\$@") || exit \$?
  if [ "\$urls" = "\$DRAFT_TEST_ORIGIN" ]; then
    printf '%s\n' git@github.com:test/project.git
    exit 0
  fi
fi
exec command_git "\$@"
`.replaceAll('command_git', output(run(p.work, 'sh', ['-c', 'command -v git']))), { mode: 0o755 })
  const settings = { ...fake, PR_DRAFT: '1', PR_SHA: remote, DRAFT_TEST_ORIGIN: fakeGit, PATH: bin + ':' + env.PATH }
  const other = join(p.dir, 'other.git')
  git(p.dir, 'clone', '--bare', p.origin, other)
  git(p.work, 'remote', 'set-url', '--push', 'origin', other)
  assert.match(flow(p, args, settings).stderr, /one matching fetch and push URL/)
  assert.equal(git(other, 'rev-parse', 'feature'), remote)
  git(p.work, 'config', '--unset', 'remote.origin.pushurl')
  git(p.work, 'remote', 'set-url', 'origin', other)
  assert.match(flow(p, args, settings).stderr, /Origin must point to GitHub repository test\/project/)
  assert.equal(git(other, 'rev-parse', 'feature'), remote)
  git(p.work, 'remote', 'set-url', 'origin', fakeGit)
  assert.match(flow(p, args, settings).stderr, /the pre-push hook refused/)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), remote)
  writeFileSync(hook, '#!/bin/sh\nexit 0\n')
  git(p.work, 'tag', '-a', 'local-only', '-m', 'Keep local')
  git(p.work, 'config', 'push.followTags', 'true')
  const result = JSON.parse(output(flow(p, args, settings)))
  assert.equal(result.state, 'reviewing')
  assert.equal(readFileSync(p.file, 'utf8'), before)
  assert.equal(git(p.origin, 'rev-parse', 'feature'), sha)
  assert.equal(git(p.origin, 'tag', '--list'), '')
  assert.doesNotMatch(readFileSync(fake.GH_LOG, 'utf8'), /^pr-ready/m)
})


test('interactive development waits for human confirmation before checks, staging or review', () => {
  const p = project()
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  raw.workflow.steering = 'interactive'
  writeFileSync(p.file, JSON.stringify(raw))
  const checks = join(p.work, 'scripts/ndev/workflow')
  mkdirSync(checks, { recursive: true })
  writeFileSync(join(checks, 'fast-checks.sh'), '#!/bin/sh\necho ran > "$CHECK_LOG"\n')
  const fake = { ...services(p), CHECK_LOG: join(p.dir, 'check.log') }
  const before = git(p.work, 'rev-parse', 'HEAD')
  const record = readFileSync(p.file, 'utf8')
  const result = flow(p, ['finished-development', '--issue', '7', '--file', 'next.txt'], fake)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#7.*human confirmation/i)
  assert.match(result.stderr, /preview/i)
  assert.match(result.stderr, /--human-confirmation/)
  assert.equal(existsSync(fake.CHECK_LOG), false)
  assert.doesNotMatch(existsSync(fake.ORCA_LOG) ? readFileSync(fake.ORCA_LOG, 'utf8') : '', /worker-start/)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), before)
  assert.equal(git(p.work, 'diff', '--cached', '--name-only'), '')
  assert.equal(readFileSync(p.file, 'utf8'), record)
})

test('confirmed interactive development and auto development can enter review', () => {
  for (const steering of ['interactive', 'auto']) {
    const p = project()
    const raw = JSON.parse(readFileSync(p.file, 'utf8'))
    raw.workflow.steering = steering
    writeFileSync(p.file, JSON.stringify(raw))
    const fake = services(p)
    const args = ['finished-development', '--issue', '7', '--file', 'next.txt']
    if (steering === 'interactive') args.push('--human-confirmation', 'Yes, this is done; start the checks.')
    const result = JSON.parse(output(flow(p, args, fake)))
    assert.equal(result.state, 'reviewing')
    assert.match(readFileSync(fake.ORCA_LOG, 'utf8'), /worker-start/)
    if (steering === 'interactive') assert.equal(result.workflow.developmentConfirmation, 'Yes, this is done; start the checks.')
    else assert.equal(result.workflow.developmentConfirmation, undefined)
  }
})

test('interactive development guidance requires a preview and done confirmation before final checks', () => {
  for (const steering of ['interactive', 'auto']) {
    const p = project()
    const raw = JSON.parse(readFileSync(p.file, 'utf8'))
    raw.workflow.steering = steering
    writeFileSync(p.file, JSON.stringify(raw))
    const result = JSON.parse(output(flow(p, ['status', '--issue', '7'])))
    if (steering === 'interactive') {
      assert.match(result.next, /concrete development preview/)
      assert.match(result.next, /ask whether the work is done/i)
      assert.match(result.next, /before final checks or review/)
      assert.match(result.next, /--human-confirmation/)
    } else assert.doesNotMatch(result.next, /--human-confirmation/)
  }
})

test('an interactive sibling prevents every selected issue from running finish checks', () => {
  const p = project()
  const raw = JSON.parse(readFileSync(p.file, 'utf8'))
  writeFileSync(join(p.work, '.neil-dev.issue-8.json'), JSON.stringify({ ...raw, issue: 8, workflow: { ...raw.workflow, issue: 8, steering: 'interactive' } }))
  const fake = services(p)
  const before = git(p.work, 'rev-parse', 'HEAD')
  const result = flow(p, ['finished-development', '--issue', '7', '--issue', '8', '--file', 'next.txt'], fake)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#8.*human confirmation/i)
  assert.equal(git(p.work, 'rev-parse', 'HEAD'), before)
  assert.equal(JSON.parse(readFileSync(p.file, 'utf8')).workflow.state, 'developing')
  assert.doesNotMatch(existsSync(fake.ORCA_LOG) ? readFileSync(fake.ORCA_LOG, 'utf8') : '', /worker-start/)
})

test('issue 26: resuming a conflicted finished PR persists revising without an idle owner', () => {
  const p = project()
  const fake = services(p)
  const record = JSON.parse(readFileSync(p.file, 'utf8'))
  record.workflow.state = 'done'
  delete record.workflow.owner
  writeFileSync(p.file, JSON.stringify(record))
  const result = JSON.parse(output(flow(p, ['start', '7'], { ...fake, PR_MERGEABLE: 'false' })))
  assert.equal(result.state, 'revising')
  const stored = JSON.parse(readFileSync(p.file, 'utf8')).workflow
  assert.equal(stored.state, 'revising')
  assert.ok(stored.history.some(entry => entry.tool === 'started' && entry.from === 'done' && entry.to === 'revising'))
  assert.match(result.text, /PR #9.*conflicts/)
  assert.match(result.text, /origin\/main/)
  assert.match(result.text, /checkpoint/)
})

test('issue 26: unknown or clean mergeability leaves a resumed finished PR done', () => {
  for (const mergeable of ['null', 'true']) {
    const p = project()
    const fake = services(p)
    const record = JSON.parse(readFileSync(p.file, 'utf8'))
    record.workflow.state = 'done'
    delete record.workflow.owner
    writeFileSync(p.file, JSON.stringify(record))
    const result = JSON.parse(output(flow(p, ['start', '7'], { ...fake, PR_MERGEABLE: mergeable })))
    assert.equal(result.state, 'done')
    assert.equal(JSON.parse(readFileSync(p.file, 'utf8')).workflow.state, 'done')
    assert.match(readFileSync(fake.GH_LOG, 'utf8'), /^pr-read 9$/m)
  }
})

test('issue 26: a failed finished-PR refresh names the PR and leaves the record unchanged', () => {
  const p = project()
  const fake = services(p)
  const record = JSON.parse(readFileSync(p.file, 'utf8'))
  record.workflow.state = 'done'
  delete record.workflow.owner
  writeFileSync(p.file, JSON.stringify(record))
  const before = readFileSync(p.file, 'utf8')
  const result = flow(p, ['start', '7'], { ...fake, PR_READ_FAIL: 'GitHub temporarily unavailable' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pr-read 9/)
  assert.match(result.stderr, /exited 37/)
  assert.match(result.stderr, /GitHub temporarily unavailable/)
  assert.equal(readFileSync(p.file, 'utf8'), before)
})
