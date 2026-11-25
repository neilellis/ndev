// wait-for-pr-change.sh must work with an old gh. gh 2.45 has no `gh api --slurp` (it came in 2.48),
// and with --paginate it prints the pages as JSON documents one after the other. The stub gh here
// behaves like gh 2.45.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = {
  'brand-site template': join(HERE, '..', '..', '..', 'templates', 'brand-site', 'scripts', 'github', 'wait-for-pr-change.sh'),
}
const SHA = 'a'.repeat(40)
const PR = {
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: SHA, headRefName: 'feat',
  title: 'T', labels: [], comments: [], reviews: [], updatedAt: '2026-01-01T00:00:00Z',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}
const run = (id, conclusion) => ({ id, workflow_id: id, name: `w${id}`, event: 'pull_request', head_sha: SHA, head_branch: 'feat', run_number: 1, status: 'completed', conclusion, pull_requests: [{ number: 12 }] })
const page = runs => JSON.stringify({ total_count: 2, workflow_runs: runs })

// pages: the output of `gh api --paginate` for the workflow runs.
function wait(script, pages, pr = PR) {
  const dir = mkdtempSync(join(tmpdir(), 'wait-pr-'))
  mkdirSync(join(dir, 'bin'))
  const log = join(dir, 'calls.log')
  const stub = join(dir, 'bin', 'gh')
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args.includes('--slurp')) { console.error('unknown flag: --slurp'); process.exit(1) }
if (args[0] === 'pr' && args[1] === 'view') { process.stdout.write(${JSON.stringify(JSON.stringify(pr))}); process.exit(0) }
if (args[0] === 'api' && args.some(a => a.includes('/actions/runs'))) { process.stdout.write(${JSON.stringify(pages)}); process.exit(0) }
console.error('stub: no rule for: ' + args.join(' ')); process.exit(99)
`)
  chmodSync(stub, 0o755)
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_REPO: 'o/r' }
  const r = spawnSync('bash', [script, '12', '--repo', 'o/r', '--skip-success', '--json', '--timeout', '1', '--interval', '1'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 })
  return { code: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(log, 'utf8') }
}

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`${name}: reads the workflow runs with a gh that has no --slurp`, () => {
    const r = wait(script, page([run(1, 'success')]))
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.calls, /--slurp/)
    const result = JSON.parse(r.out)
    assert.deepEqual(result.changes, ['CI complete for the current PR revision'])
    assert.deepEqual(result.details.workflows, { completed: 1, total: 1, failed: 0, neutral: 0 })
  })

  test(`${name}: reads every page that gh prints, one JSON document after the other`, () => {
    const r = wait(script, page([run(1, 'success')]) + page([run(2, 'failure')]) + '\n')
    assert.equal(r.code, 0, r.err)
    const result = JSON.parse(r.out)
    assert.deepEqual(result.changes, ['CI failure detected in the current PR revision'])
    assert.deepEqual(result.details.workflows, { completed: 1, total: 2, failed: 1, neutral: 0 })
  })

  test(`${name}: output that is not JSON fails, and the message names the command and shows the output`, () => {
    const r = wait(script, page([run(1, 'success')]) + 'oops not json')
    assert.equal(r.code, 1, r.out)
    assert.match(r.err, /failed to fetch workflow runs for PR #12/)
    assert.match(r.err, /gh api --paginate repos\/o\/r\/actions\/runs/)
    assert.match(r.err, /oops not json/)
  })

  test(`${name}: counts only the newest run of each check, so a cancelled run that a newer run replaced is no failure`, () => {
    const check = (conclusion, startedAt) => ({ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion, startedAt })
    const pr = { ...PR, statusCheckRollup: [check('CANCELLED', '2026-11-24T10:00:00Z'), check('SUCCESS', '2026-11-24T10:05:00Z')] }
    const r = wait(script, page([run(1, 'success')]), pr)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).changes, ['CI complete for the current PR revision'])
  })
}
