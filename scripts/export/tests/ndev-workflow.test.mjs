import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
pr-read) node -e 'console.log(JSON.stringify({number:9,state:"open",draft:false,head:{sha:process.env.PR_SHA || require("node:child_process").execSync("git rev-parse HEAD").toString().trim(),ref:require("node:child_process").execSync("git branch --show-current").toString().trim()},body:require("node:fs").readFileSync(process.env.PR_BODY,"utf8")}))' ;;
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
test('starting from the base uses the Orca worktree receipt and resumes one draft PR', () => {
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
  assert.deepEqual(start.workflow.prs, [9])
  const status = output(run(p.work, join(repo, 'bin/ndev'), ['flow', 'status', '--json'], fake))
  assert.equal(JSON.parse(status).result.root, start.root)
  const resumed = JSON.parse(output(flow(p, args, fake)))
  assert.equal(resumed.root, start.root)
  assert.equal(readFileSync(fake.GH_LOG, 'utf8').match(/^pr-new /gm).length, 1)
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
