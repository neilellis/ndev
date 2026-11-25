import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const run = (workflowName, status, conclusion, createdAt, databaseId) => ({
  workflowName, status, conclusion, createdAt, databaseId, event: 'push', url: `https://github.com/o/r/actions/runs/${databaseId}`,
})

function fixture(t, scenario, record = { state: 'ci' }) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-wait-branch-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status, 0)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario))
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(root, 'gh.log'))}, args.join(' ') + '\\n')
const file = ${JSON.stringify(join(root, 'scenario.json'))}
const scenario = JSON.parse(readFileSync(file, 'utf8'))
const take = list => list.length > 1 ? list.shift() : list[0]
let out
if (args[0] === 'api') out = { name: 'main', commit: { sha: take(scenario.heads) } }
else if (args[0] === 'run') out = take(scenario.runs[args[args.indexOf('--commit') + 1]] ?? [[]])
else { process.stderr.write('unexpected gh call: ' + args.join(' ')); process.exit(9) }
writeFileSync(file, JSON.stringify(scenario))
process.stdout.write(JSON.stringify(out))
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const file = join(root, '.neil-dev.issue-12.json')
  writeFileSync(file, JSON.stringify({ version: 1, issue: 12, rounds: [], workflow: { issue: 12, root, pr: 7, prs: [7], state: 'developing', rev: 1, history: [], ...record } }))
  return { root, bin, workflow: () => JSON.parse(readFileSync(file, 'utf8')).workflow, calls: () => readFileSync(join(root, 'gh.log'), 'utf8').trim().split('\n') }
}

function wait(f, args) {
  const result = spawnSync(ndev, ['wait', '--json', 'branch-ci', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
  assert.ifError(result.error)
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
}

test('wait branch-ci follows the newest head when a merge cancels the runs of the old head', t => {
  const f = fixture(t, {
    heads: [OLD, NEW, NEW, NEW, NEW],
    runs: {
      [OLD]: [[run('CI', 'completed', 'cancelled', '2026-11-24T10:00:00Z', 1)]],
      [NEW]: [[], [run('CI', 'in_progress', '', '2026-11-24T10:05:00Z', 2)], [run('CI', 'completed', 'success', '2026-11-24T10:05:00Z', 2)]],
    },
  })
  const result = wait(f, ['main', '--period', '1'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  const { last, attempts } = result.json.result
  assert.equal(attempts, 4)
  assert.equal(last.branch, 'main')
  assert.equal(last.sha, NEW)
  assert.deepEqual(last.workflows, [{ name: 'CI', conclusion: 'SUCCESS', url: 'https://github.com/o/r/actions/runs/2' }])
  assert.match(f.calls()[0], /^api repos\/\{owner\}\/\{repo\}\/branches\/main$/)
  assert.match(f.calls()[1], /^run list --branch main --commit a{40} --json /)
})

test('wait branch-ci counts only the newest run of each workflow on the head', t => {
  const f = fixture(t, {
    heads: [NEW],
    runs: { [NEW]: [[run('CI', 'completed', 'cancelled', '2026-11-24T10:00:00Z', 1), run('CI', 'completed', 'success', '2026-11-24T10:05:00Z', 2), run('Deploy', 'completed', 'skipped', '2026-11-24T10:01:00Z', 3)]] },
  })
  const result = wait(f, ['main'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(result.json.result.last.workflows.map(w => [w.name, w.conclusion]), [['CI', 'SUCCESS'], ['Deploy', 'SKIPPED']])
})

test('wait branch-ci fails on a real failure of the newest head, naming the workflow and its log URL', t => {
  const f = fixture(t, {
    heads: [NEW],
    runs: { [NEW]: [[run('CI', 'completed', 'failure', '2026-11-24T10:05:00Z', 5), run('Lint', 'completed', 'success', '2026-11-24T10:05:00Z', 6)]] },
  })
  const result = wait(f, ['main'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  const { error } = result.json
  assert.match(error.message, /main at bbbbbbbb/)
  assert.match(error.message, /CI \(FAILURE\) https:\/\/github\.com\/o\/r\/actions\/runs\/5/)
  assert.doesNotMatch(error.message, /Lint/)
  assert.match(error.repair, /ndev wait branch-ci main/)
})

test('wait branch-ci holds no workflow record and accepts a timeout long enough for CI', t => {
  const f = fixture(t, { heads: [NEW], runs: { [NEW]: [[run('CI', 'completed', 'success', '2026-11-24T10:05:00Z', 2)]] } })
  const result = wait(f, ['main', '--timeout', '7200'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(f.workflow().state, 'ci')
  assert.equal(f.workflow().wait, undefined)
  assert.equal(f.workflow().rev, 1)
  const refused = wait(f, ['main', '--issue', '12'])
  assert.equal(refused.status, 2, refused.stdout || refused.stderr)
})
