// Proves the rule of gh.sh: the gh command first, and REST when it fails. A stub gh on PATH answers
// by rule and records each call, so a test can see which route answered and what it cost.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const GHSH = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh.sh')
const LIMITED = 'API rate limit exceeded for user ID 1. (HTTP 403)'

// rules: [{ match: 'substring of the arguments', out?: string, err?: string, exit?: number }]. The first match answers.
function ghsh(args, rules = [], opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-first-'))
  mkdirSync(join(dir, 'bin'))
  const log = join(dir, 'calls.log')
  const stub = join(dir, 'bin', 'gh')
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs')
const line = process.argv.slice(2).join(' ').replace(/\\n/g, ' ')
fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
const rule = ${JSON.stringify(rules)}.find(r => line.includes(r.match))
if (!rule) { console.error('stub: no rule for: ' + line); process.exit(99) }
if (rule.out) process.stdout.write(rule.out)
if (rule.err) process.stderr.write(rule.err)
process.exit(rule.exit ?? 0)
`)
  chmodSync(stub, 0o755)
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_REPO: opts.noRepo ? '' : 'o/r' }
  const r = spawnSync('bash', [GHSH, ...args], { cwd: opts.cwd ?? dir, env, encoding: 'utf8' })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  return { code: r.status, out: r.stdout, err: r.stderr, calls, lines: r.stdout.trim().split('\n').filter(Boolean) }
}
const json = r => JSON.parse(r.out)
const viaRest = c => c.startsWith('api ') && !c.startsWith('api graphql')

const GH_PR = { number: 12, state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', body: 'b', createdAt: '2026-01-01T00:00:00Z', headRefOid: 'abc', headRefName: 'feat', baseRefName: 'main', title: 'T', url: 'u', author: { login: 'neil' } }
const REST_PR = { number: 12, state: 'open', merged: false, draft: true, mergeable: false, mergeable_state: 'dirty', body: 'b', created_at: '2026-01-01T00:00:00Z', head: { sha: 'abc', ref: 'feat' }, base: { ref: 'main' }, title: 'T', html_url: 'u', user: { login: 'neil' }, merge_commit_sha: null, node_id: 'x', extra: 1 }

test('pr-read uses the gh command only when it works, and gives the same shape as REST', () => {
  const viaGh = ghsh(['pr-read', '12'], [{ match: 'pr view 12', out: JSON.stringify(GH_PR) }])
  assert.equal(viaGh.code, 0, viaGh.err)
  assert.deepEqual(viaGh.calls.length, 1)
  assert.ok(viaGh.calls[0].startsWith('pr view 12 --repo o/r --json '), viaGh.calls[0])
  const rest = ghsh(['pr-read', '12'], [{ match: 'pr view', err: LIMITED, exit: 1 }, { match: 'api repos/o/r/pulls/12', out: JSON.stringify(REST_PR) }])
  assert.equal(rest.code, 0, rest.err)
  assert.deepEqual(json(viaGh), json(rest))
  assert.equal(rest.calls.length, 2)
  assert.match(rest.err, /Trying REST/)
})

test('pr-read turns gh words into REST values', () => {
  const read = over => json(ghsh(['pr-read', '12'], [{ match: 'pr view', out: JSON.stringify({ ...GH_PR, ...over }) }]))
  assert.equal(read({ mergeable: 'MERGEABLE' }).mergeable, true)
  assert.equal(read({ mergeable: 'CONFLICTING' }).mergeable, false)
  assert.equal(read({ mergeable: 'UNKNOWN' }).mergeable, null)
  const merged = read({ state: 'MERGED' })
  assert.equal(merged.state, 'closed')
  assert.equal(merged.merged, true)
  assert.equal(read({ state: 'CLOSED' }).merged, false)
  assert.equal(read({}).draft, true)
})

test('a read that fails both ways exits non-zero and names both failures and the repair', () => {
  const r = ghsh(['pr-read', '12'], [{ match: 'pr view', err: 'graphql is out', exit: 1 }, { match: 'api repos', err: LIMITED, exit: 4 }])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /graphql is out/)
  assert.match(r.err, /rate limit exceeded/)
  assert.match(r.err, /exited 1/)
  assert.match(r.err, /exited 4/)
  assert.match(r.err, /gh api rate_limit/)
  assert.equal(r.out, '')
})

test('issue-read works through gh, and through REST when gh fails', () => {
  const viaGh = ghsh(['issue-read', '340'], [{ match: 'issue view 340', out: '{"number":340,"title":"T","state":"OPEN","body":"b","url":"u"}' }])
  assert.deepEqual(json(viaGh), { number: 340, title: 'T', state: 'open', body: 'b', url: 'u' })
  assert.equal(viaGh.calls.filter(viaRest).length, 0)
  // The failure that started this: REST is out, and gh is what still works; and the reverse.
  const rest = ghsh(['issue-read', '340'], [{ match: 'issue view', err: 'GraphQL: rate limit', exit: 1 }, { match: 'api repos/o/r/issues/340', out: '{"number":340,"title":"T","state":"open","body":"b","html_url":"u","id":9}' }])
  assert.deepEqual(json(rest), json(viaGh))
})

test('pr-list gives one line per pull request, by either route', () => {
  const row = { number: 12, state: 'OPEN', headRefName: 'feat', headRefOid: 'abc', isDraft: false, title: 'T', url: 'u', createdAt: 'c', author: { login: 'neil' } }
  const viaGh = ghsh(['pr-list', '--head', 'feat', '--state', 'open'], [{ match: 'pr list', out: JSON.stringify([row]) }])
  assert.equal(viaGh.code, 0, viaGh.err)
  assert.ok(viaGh.calls[0].includes('--head feat'), viaGh.calls[0])
  assert.equal(viaGh.lines.length, 1)
  assert.equal(JSON.parse(viaGh.lines[0]).head.ref, 'feat')
  const rest = ghsh(['pr-list', '--head', 'feat', '--state', 'open'], [{ match: 'pr list', err: LIMITED, exit: 1 }, { match: 'pulls?', out: '[{"number":12,"state":"open","draft":false,"title":"T","html_url":"u","created_at":"c","user":{"login":"neil"},"head":{"ref":"feat","sha":"abc"}}]' }])
  assert.equal(rest.code, 0, rest.err)
  assert.ok(rest.calls[1].includes('head=o:feat'), rest.calls[1])
  assert.deepEqual(JSON.parse(rest.lines[0]), JSON.parse(viaGh.lines[0]))
})

test('pr-list with no pull requests prints nothing and passes', () => {
  const r = ghsh(['pr-list', '--head', 'none', '--state', 'open'], [{ match: 'pr list', out: '[]' }])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, '')
})

const ROLLUP = { headRefOid: 'abc', statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'StatusContext', context: 'vercel', state: 'PENDING' }] }
const CHECKS = { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }, { name: 'e2e', status: 'in_progress', conclusion: null }], statuses: [{ context: 'vercel', state: 'pending' }] }

test('commit-checks reads the PR rollup in one gh call, in the shape of REST', () => {
  const r = ghsh(['commit-checks', 'abc', '--pr', '12'], [{ match: 'pr view 12', out: JSON.stringify(ROLLUP) }])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.calls.length, 1)
  assert.deepEqual(json(r), CHECKS)
})

test('commit-checks reads the commit through REST when the PR head is another commit, or gh fails', () => {
  const rules = [{ match: 'pr view', out: JSON.stringify({ ...ROLLUP, headRefOid: 'other' }) }, { match: 'commits/abc/check-runs', out: JSON.stringify({ check_runs: CHECKS.check_runs, total_count: 2 }) }, { match: 'commits/abc/status', out: JSON.stringify({ statuses: CHECKS.statuses, state: 'pending' }) }]
  const moved = ghsh(['commit-checks', 'abc', '--pr', '12'], rules)
  assert.equal(moved.code, 0, moved.err)
  assert.deepEqual(json(moved), CHECKS)
  const failed = ghsh(['commit-checks', 'abc', '--pr', '12'], [{ match: 'pr view', err: LIMITED, exit: 1 }, ...rules.slice(1)])
  assert.deepEqual(json(failed), CHECKS)
  const noPr = ghsh(['commit-checks', 'abc'], rules.slice(1))
  assert.equal(noPr.calls.filter(c => c.startsWith('pr ')).length, 0)
  assert.deepEqual(json(noPr), CHECKS)
})

test('commit-checks with no PR and no REST quota reads the commit through GraphQL', () => {
  const r = ghsh(['commit-checks', 'abc'], [{ match: 'commits/abc', err: LIMITED, exit: 1 }, { match: 'api graphql', out: JSON.stringify({ data: { repository: { object: { statusCheckRollup: { contexts: { nodes: ROLLUP.statusCheckRollup } } } } } }) }])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(json(r), CHECKS)
})

test('a command that says why on stdout still has its words in the failure', () => {
  const r = ghsh(['pr-read', '12'], [{ match: 'pr view', out: 'said on stdout', exit: 1 }, { match: 'api repos', err: 'gh: Not Found (HTTP 404)', exit: 1 }])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /said on stdout/)
  assert.match(r.err, /Not Found/)
})

const GRAPH = { data: { repository: {
  issue: { comments: { nodes: [{ databaseId: 1, body: 'on the issue', createdAt: 't1', author: { __typename: 'User', login: 'ann' } }] } },
  pullRequest: {
    comments: { nodes: [{ databaseId: 2, body: 'from a bot', createdAt: 't2', author: { __typename: 'Bot', login: 'github-actions' } }] },
    reviews: { nodes: [{ databaseId: 3, body: 'changes', state: 'CHANGES_REQUESTED', submittedAt: 't3', author: { __typename: 'User', login: 'bob' }, comments: { nodes: [{ databaseId: 4, body: 'inline', createdAt: 't4', author: { __typename: 'User', login: 'bob' } }] } }] },
  },
} } }

test('feedback reads all four lists in one call, and keeps numeric ids and bot authors', () => {
  const r = ghsh(['feedback', '7', '12'], [{ match: 'api graphql', out: JSON.stringify(GRAPH) }])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.calls.length, 1)
  const rows = r.lines.map(l => JSON.parse(l))
  assert.deepEqual(rows.map(c => c.id).sort(), [1, 2, 3, 4])
  const bot = rows.find(c => c.id === 2)
  assert.equal(bot.user.type, 'Bot')
  assert.equal(bot.user.login, 'github-actions[bot]')
  assert.equal(rows.find(c => c.id === 3).submitted_at, 't3')
  assert.equal(rows.find(c => c.id === 4).created_at, 't4')
  assert.deepEqual(rows.sort((a, b) => a.id - b.id).map(c => c.surface), ['issue', 'pr', 'review', 'inline'])
})

test('feedback answers through REST in the same shape when GraphQL fails', () => {
  const rules = [
    { match: 'api graphql', err: 'GraphQL: rate limit', exit: 1 },
    { match: 'issues/7/comments', out: '[{"id":1,"body":"on the issue","created_at":"t1","user":{"login":"ann","type":"User"}}]' },
    { match: 'issues/12/comments', out: '[{"id":2,"body":"from a bot","created_at":"t2","user":{"login":"github-actions[bot]","type":"Bot"}}]' },
    { match: 'pulls/12/reviews', out: '[{"id":3,"body":"changes","state":"CHANGES_REQUESTED","submitted_at":"t3","user":{"login":"bob","type":"User"}}]' },
    { match: 'pulls/12/comments', out: '[{"id":4,"body":"inline","created_at":"t4","user":{"login":"bob","type":"User"}}]' },
  ]
  const r = ghsh(['feedback', '7', '12'], rules)
  assert.equal(r.code, 0, r.err)
  const graph = ghsh(['feedback', '7', '12'], [{ match: 'api graphql', out: JSON.stringify(GRAPH) }])
  const sorted = x => x.lines.map(l => JSON.parse(l)).sort((a, b) => a.id - b.id)
  assert.deepEqual(sorted(r), sorted(graph))
})

test('comment falls back to REST on a rate limit only: another failure may already have posted', () => {
  const works = ghsh(['comment', '12', '--body', 'hi'], [{ match: 'issue comment 12', out: 'https://x/12#c\n' }])
  assert.equal(works.code, 0, works.err)
  assert.equal(works.calls.length, 1)
  const limited = ghsh(['comment', '12', '--body', 'hi'], [{ match: 'issue comment', err: LIMITED, exit: 1 }, { match: 'issues/12/comments', out: '{"id":1}' }])
  assert.equal(limited.code, 0, limited.err)
  assert.ok(limited.calls[1].includes('-X POST'), limited.calls[1])
  assert.ok(limited.calls[1].includes('body=hi'), limited.calls[1])
  const timedOut = ghsh(['comment', '12', '--body', 'hi'], [{ match: 'issue comment', err: 'net/http: timeout', exit: 1 }, { match: 'issues/12/comments', out: '{"id":1}' }])
  assert.notEqual(timedOut.code, 0)
  assert.equal(timedOut.calls.length, 1)
  assert.match(timedOut.err, /timeout/)
})

test('pr-review posts through gh, and on a rate limit through REST on the named commit', () => {
  const works = ghsh(['pr-review', '12', '--commit', 'abc', '--body', 'smoke'], [{ match: 'pr review 12', out: '' }])
  assert.equal(works.code, 0, works.err)
  assert.ok(works.calls[0].includes('--comment'), works.calls[0])
  const limited = ghsh(['pr-review', '12', '--commit', 'abc', '--body', 'smoke'], [{ match: 'pr review', err: LIMITED, exit: 1 }, { match: 'pulls/12/reviews', out: '{}' }])
  assert.equal(limited.code, 0, limited.err)
  assert.ok(limited.calls[1].includes('commit_id=abc'), limited.calls[1])
  assert.ok(limited.calls[1].includes('event=COMMENT'), limited.calls[1])
})

test('pr-ready has no REST route, so a failure says so and names the repair', () => {
  assert.equal(ghsh(['pr-ready', '12'], [{ match: 'pr ready 12', out: '' }]).code, 0)
  const r = ghsh(['pr-ready', '12'], [{ match: 'pr ready', err: 'GraphQL: rate limit', exit: 1 }])
  assert.notEqual(r.code, 0)
  assert.equal(r.calls.length, 1)
  assert.match(r.err, /REST has no way/)
  assert.match(r.err, /gh api rate_limit/)
})

test('label and pr-merge fall back on any failure, because a repeat changes nothing', () => {
  const label = ghsh(['label', '12', 'smoke-tested'], [{ match: 'pr edit', err: 'Projects (classic) is being deprecated', exit: 1 }, { match: 'issues/12/labels', out: '[]' }])
  assert.equal(label.code, 0, label.err)
  assert.ok(label.calls[1].includes('labels[]=smoke-tested'), label.calls[1])

  const merge = ghsh(['pr-merge', '12', '--method', 'squash'], [{ match: 'pr merge 12', out: '' }])
  assert.equal(merge.code, 0, merge.err)
  assert.ok(merge.calls[0].includes('--squash'), merge.calls[0])
  assert.equal(merge.calls.length, 1)
  const rest = ghsh(['pr-merge', '12', '--method', 'merge'], [{ match: 'pr merge', err: LIMITED, exit: 1 }, { match: 'pulls/12/merge', out: '{"sha":"s","merged":true}' }])
  assert.equal(rest.code, 0, rest.err)
  assert.ok(rest.calls[1].includes('merge_method=merge'), rest.calls[1])
  const refused = ghsh(['pr-merge', '12', '--method', 'merge'], [{ match: 'pr merge', err: 'not mergeable', exit: 1 }, { match: 'pulls/12/merge', err: 'Pull Request is not mergeable', exit: 1 }])
  assert.notEqual(refused.code, 0)
  assert.match(refused.err, /not mergeable/)
  assert.ok(ghsh(['pr-merge', '12', '--method', 'nope']).code !== 0)
})

test('default-branch works through gh and through REST', () => {
  const viaGh = ghsh(['default-branch'], [{ match: 'repo view o/r', out: '{"defaultBranchRef":{"name":"main"}}' }])
  assert.deepEqual(json(viaGh), { default_branch: 'main' })
  const rest = ghsh(['default-branch'], [{ match: 'repo view', err: LIMITED, exit: 1 }, { match: 'api repos/o/r', out: '{"default_branch":"main","id":1}' }])
  assert.deepEqual(json(rest), json(viaGh))
})

test('blocked-by list: no gh command exists, so REST first, then the same answer through GraphQL', () => {
  const rest = ghsh(['blocked-by', 'list', '7'], [{ match: 'dependencies/blocked_by', out: '[{"number":3,"title":"T","state":"open","html_url":"u"}]' }])
  assert.equal(rest.code, 0, rest.err)
  assert.deepEqual(JSON.parse(rest.lines[0]), { number: 3, title: 'T', state: 'open', url: 'u' })
  const graph = ghsh(['blocked-by', 'list', '7'], [{ match: 'dependencies/blocked_by', err: LIMITED, exit: 1 }, { match: 'api graphql', out: '{"data":{"repository":{"issue":{"blockedBy":{"nodes":[{"number":3,"title":"T","state":"OPEN","url":"u"}]}}}}}' }])
  assert.equal(graph.code, 0, graph.err)
  assert.deepEqual(JSON.parse(graph.lines[0]), JSON.parse(rest.lines[0]))
})

test('the repository comes from the origin remote with no GitHub call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-first-repo-'))
  spawnSync('git', ['init', '-q', dir])
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git'])
  const r = ghsh(['issue-read', '1'], [{ match: 'issue view 1', out: '{"number":1,"title":"T","state":"OPEN","body":"","url":"u"}' }], { cwd: dir, noRepo: true })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.calls.length, 1)
  assert.ok(r.calls[0].includes('--repo acme/widget'), r.calls[0])
})

test('api passes a call with no gh command straight through', () => {
  const r = ghsh(['api', 'repos/o/r/compare/a...b', '--jq', '.status'], [{ match: 'api repos/o/r/compare/a...b --jq .status', out: 'ahead\n' }])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'ahead\n')
})

test('pr-rows reads every open pull request of the user in one call, with no REST call', () => {
  const row = { number: 4, mergeStateStatus: 'DIRTY', statusCheckRollup: [] }
  const r = ghsh(['pr-rows', '--limit', '5'], [{ match: 'pr list', out: JSON.stringify([row, { ...row, number: 5 }]) }])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.lines.map(l => JSON.parse(l).number), [4, 5])
  assert.equal(r.calls.length, 1)
  assert.match(r.calls[0], /--author @me .*--limit 5/)
})

test('pr-rows that fails names the failure and the per-PR reads to use instead', () => {
  const r = ghsh(['pr-rows'], [{ match: 'pr list', err: LIMITED, exit: 1 }])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /rate limit/)
  assert.match(r.err, /gh\.sh pr-read/)
})

test('pr-new creates through gh with the draft flag, prints {url}, and falls back on a rate limit only', () => {
  writeFileSync(join(tmpdir(), 'gh-first-body.md'), 'body')
  const body = join(tmpdir(), 'gh-first-body.md')
  const args = ['pr-new', '--title', 'T', '--body-file', body, '--base', 'main', '--head', 'feat']
  const works = ghsh(args, [{ match: 'pr create', out: 'https://github.com/o/r/pull/7\n' }])
  assert.equal(works.code, 0, works.err)
  assert.deepEqual(json(works), { url: 'https://github.com/o/r/pull/7' })
  assert.equal(works.calls.length, 1)
  assert.ok(works.calls[0].includes('--draft') && works.calls[0].includes('--head feat'), works.calls[0])
  const ready = ghsh([...args, '--ready'], [{ match: 'pr create', out: 'https://github.com/o/r/pull/7\n' }])
  assert.ok(!ready.calls[0].includes('--draft'), ready.calls[0])
  const limited = ghsh(args, [{ match: 'pr create', err: LIMITED, exit: 1 }, { match: 'api -X POST repos/o/r/pulls', out: 'https://github.com/o/r/pull/8\n' }])
  assert.equal(limited.code, 0, limited.err)
  assert.deepEqual(json(limited), { url: 'https://github.com/o/r/pull/8' })
  assert.ok(limited.calls[1].includes('draft=true'), limited.calls[1])
  const other = ghsh(args, [{ match: 'pr create', err: 'timeout', exit: 1 }, { match: 'api', out: 'x' }])
  assert.notEqual(other.code, 0)
  assert.equal(other.calls.length, 1)
  assert.match(other.err, /timeout/)
})

test('issue-new creates through gh, and goes straight to REST with a milestone or a type', () => {
  const body = join(tmpdir(), 'gh-first-body.md')
  writeFileSync(body, 'body')
  const base = ['issue-new', '--title', 'T', '--body-file', body, '--label', 'bug', '--assignee', 'neil']
  const works = ghsh(base, [{ match: 'issue create', out: 'https://github.com/o/r/issues/41\n' }])
  assert.equal(works.code, 0, works.err)
  assert.deepEqual(json(works), { number: 41, url: 'https://github.com/o/r/issues/41' })
  assert.ok(works.calls[0].includes('--label bug') && works.calls[0].includes('--assignee neil'), works.calls[0])
  const limited = ghsh(base, [{ match: 'issue create', err: LIMITED, exit: 1 }, { match: 'api -X POST repos/o/r/issues', out: 'https://github.com/o/r/issues/42\n' }])
  assert.deepEqual(json(limited), { number: 42, url: 'https://github.com/o/r/issues/42' })
  assert.ok(limited.calls[1].includes('labels[]=bug'), limited.calls[1])
  for (const extra of [['--milestone', '4'], ['--type', 'Bug']]) {
    const rest = ghsh([...base, ...extra], [{ match: 'api -X POST repos/o/r/issues', out: 'https://github.com/o/r/issues/43\n' }])
    assert.equal(rest.code, 0, rest.err)
    assert.equal(rest.calls.length, 1)
    assert.ok(viaRest(rest.calls[0]), rest.calls[0])
    assert.equal(json(rest).number, 43)
  }
  const other = ghsh(base, [{ match: 'issue create', err: 'timeout', exit: 1 }, { match: 'api', out: 'x' }])
  assert.notEqual(other.code, 0)
  assert.equal(other.calls.length, 1)
})

test('me, repo-read, pr-commit-messages, rerun-failed and issue-search answer through gh, and through REST when gh fails', () => {
  const me = ghsh(['me'], [{ match: 'api graphql', out: '{"data":{"viewer":{"login":"neil"}}}' }])
  assert.deepEqual(json(me), { login: 'neil' })
  const meRest = ghsh(['me'], [{ match: 'api graphql', err: LIMITED, exit: 1 }, { match: 'api user', out: '{"login":"neil","id":1}' }])
  assert.deepEqual(json(meRest), { login: 'neil' })

  const gh = { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' }, mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: true }
  const want = { full_name: 'o/r', default_branch: 'main', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true }
  assert.deepEqual(json(ghsh(['repo-read'], [{ match: 'repo view', out: JSON.stringify(gh) }])), want)
  const repoRest = ghsh(['repo-read'], [{ match: 'repo view', err: 'x', exit: 1 }, { match: 'api repos/o/r', out: JSON.stringify({ ...want, id: 9 }) }])
  assert.deepEqual(json(repoRest), want)

  const msgs = ghsh(['pr-commit-messages', '5'], [{ match: 'pr view 5', out: 'first\n\nbody\n' }])
  assert.equal(msgs.out, 'first\n\nbody\n')
  const msgsRest = ghsh(['pr-commit-messages', '5'], [{ match: 'pr view', err: LIMITED, exit: 1 }, { match: 'pulls/5/commits', out: 'first\n\nbody\n' }])
  assert.equal(msgsRest.out, 'first\n\nbody\n')

  const rerun = ghsh(['rerun-failed', '99'], [{ match: 'run rerun 99', out: '' }])
  assert.equal(rerun.code, 0, rerun.err)
  assert.ok(rerun.calls[0].includes('--failed'), rerun.calls[0])
  const rerunRest = ghsh(['rerun-failed', '99'], [{ match: 'run rerun', err: 'x', exit: 1 }, { match: 'actions/runs/99/rerun-failed-jobs', out: '' }])
  assert.equal(rerunRest.code, 0, rerunRest.err)
  assert.ok(rerunRest.calls[1].includes('-X POST'), rerunRest.calls[1])

  const search = ghsh(['issue-search', 'foo', '--limit', '5'], [{ match: 'issue list', out: '[{"number":1,"title":"a","url":"u1"},{"number":2,"title":"b","url":"u2"}]' }])
  assert.deepEqual(search.lines.map(l => JSON.parse(l).number), [1, 2])
  const searchRest = ghsh(['issue-search', 'foo'], [{ match: 'issue list', err: LIMITED, exit: 1 }, { match: 'search/issues', out: '{"items":[{"number":3,"title":"c","html_url":"u3","id":1}]}' }])
  assert.deepEqual(json(searchRest), { number: 3, title: 'c', url: 'u3' })
})

test('subissues list reads REST first and falls back to GraphQL, in one shape', () => {
  const rest = ghsh(['subissues', 'list', '10'], [{ match: 'issues/10/sub_issues', out: '[{"number":11,"title":"a","state":"open","html_url":"u"}]' }])
  assert.deepEqual(json(rest), { number: 11, title: 'a', state: 'open', url: 'u' })
  assert.equal(rest.calls.length, 1)
  const graph = ghsh(['subissues', 'list', '10'], [{ match: 'issues/10/sub_issues', err: LIMITED, exit: 1 }, { match: 'api graphql', out: '{"data":{"repository":{"issue":{"subIssues":{"nodes":[{"number":11,"title":"a","state":"OPEN","url":"u"}]}}}}}' }])
  assert.deepEqual(json(graph), { number: 11, title: 'a', state: 'open', url: 'u' })
})

test('view-json gives the gh shape for a PR, an issue and the open list, and has no REST route', () => {
  const pr = ghsh(['view-json', 'pr', 'feat', '--fields', 'number,reviewDecision'], [{ match: 'pr view feat', out: '{"number":3,"reviewDecision":"APPROVED"}' }])
  assert.deepEqual(json(pr), { number: 3, reviewDecision: 'APPROVED' })
  assert.ok(pr.calls[0].includes('--json number,reviewDecision'), pr.calls[0])
  const issue = ghsh(['view-json', 'issue', '9', '--fields', 'number,state'], [{ match: 'issue view 9', out: '{"number":9,"state":"OPEN"}' }])
  assert.deepEqual(json(issue), { number: 9, state: 'OPEN' })
  const list = ghsh(['view-json', 'pr', '--open', '--limit', '50', '--fields', 'number'], [{ match: 'pr list', out: '[{"number":1},{"number":2}]' }])
  assert.deepEqual(list.lines.map(l => JSON.parse(l).number), [1, 2])
  assert.ok(list.calls[0].includes('--limit 50'), list.calls[0])
  const bad = ghsh(['view-json', 'pr', '3', '--fields', 'number'], [{ match: 'pr view', err: LIMITED, exit: 1 }])
  assert.notEqual(bad.code, 0)
  assert.equal(bad.calls.length, 1)
  assert.match(bad.err, /exited 1/)
  assert.match(bad.err, /rate limit/)
  assert.match(bad.err, /pr-read/)
})

test('run-status, pr-diff, pr-commit-dates and pr-reopen answer through gh, and through REST when gh fails', () => {
  assert.deepEqual(json(ghsh(['run-status', '55'], [{ match: 'run view 55', out: '{"status":"completed"}' }])), { status: 'completed' })
  const runRest = ghsh(['run-status', '55'], [{ match: 'run view', err: 'x', exit: 1 }, { match: 'actions/runs/55', out: '{"status":"queued","id":1}' }])
  assert.deepEqual(json(runRest), { status: 'queued' })

  const diff = ghsh(['pr-diff', '5'], [{ match: 'pr diff 5', out: 'diff --git a b\n' }])
  assert.match(diff.out, /^diff --git/)
  const diffRest = ghsh(['pr-diff', '5'], [{ match: 'pr diff', err: LIMITED, exit: 1 }, { match: 'application/vnd.github.diff', out: 'diff --git a b\n' }])
  assert.match(diffRest.out, /^diff --git/)
  assert.ok(diffRest.calls[1].includes('repos/o/r/pulls/5'), diffRest.calls[1])

  const dates = ghsh(['pr-commit-dates', '5'], [{ match: 'pr view 5', out: '2026-01-01T00:00:00Z\n2026-01-02T00:00:00Z\n' }])
  assert.deepEqual(dates.lines, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'])
  const datesRest = ghsh(['pr-commit-dates', '5'], [{ match: 'pr view', err: 'x', exit: 1 }, { match: 'pulls/5/commits', out: '2026-01-01T00:00:00Z\n' }])
  assert.deepEqual(datesRest.lines, ['2026-01-01T00:00:00Z'])

  const reopen = ghsh(['pr-reopen', '5'], [{ match: 'pr reopen 5', out: '' }])
  assert.equal(reopen.code, 0, reopen.err)
  const reopenRest = ghsh(['pr-reopen', '5'], [{ match: 'pr reopen', err: 'x', exit: 1 }, { match: 'api -X PATCH repos/o/r/pulls/5', out: 'u' }])
  assert.equal(reopenRest.code, 0, reopenRest.err)
  assert.ok(reopenRest.calls[1].includes('state=open'), reopenRest.calls[1])
})

test('pr-search gives one shape by gh and by REST, with the body and the merge time', () => {
  const gh = [{ number: 4, title: 'T', state: 'MERGED', createdAt: 'c', mergedAt: 'm', url: 'u', author: { login: 'neil' }, body: 'Closes #3' }]
  const viaGh = ghsh(['pr-search', 'Closes #3 in:body', '--limit', '10'], [{ match: 'pr list', out: JSON.stringify(gh) }])
  assert.ok(viaGh.calls[0].includes('--state all') && viaGh.calls[0].includes('--search Closes #3 in:body'), viaGh.calls[0])
  const item = { number: 4, title: 'T', state: 'closed', created_at: 'c', html_url: 'u', user: { login: 'neil' }, body: 'Closes #3', pull_request: { merged_at: 'm' } }
  const viaRest = ghsh(['pr-search', 'Closes #3 in:body'], [{ match: 'pr list', err: LIMITED, exit: 1 }, { match: 'search/issues', out: JSON.stringify({ items: [item] }) }])
  assert.equal(viaRest.code, 0, viaRest.err)
  assert.deepEqual(json(viaGh), json(viaRest))
  assert.equal(json(viaGh).merged, true)
  assert.equal(json(viaGh).merged_at, 'm')
  assert.ok(viaRest.calls[1].includes('is:pr Closes #3 in:body'), viaRest.calls[1])
})
