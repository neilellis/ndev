import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')
const HEAD = 'a'.repeat(40)
const CHECKS = ['requirements', 'code', 'visual', 'tests', 'model', 'docs', 'lessons']

const FAKE_GH = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const state = process.env.FAKE_GH_STATE
const args = process.argv.slice(2)
appendFileSync(join(state, 'calls.log'), JSON.stringify(args) + '\\n')
const file = join(state, 'comments.json')
const comments = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
const save = () => writeFileSync(file, JSON.stringify(comments))
const me = process.env.FAKE_GH_ME || 'neil'
if (args[0] === 'me') console.log(JSON.stringify({ login: me }))
else if (args[0] === 'comment') {
  const id = 100 + comments.length
  comments.push({ id, body: args[3], login: me })
  save()
  console.log('https://github.com/o/r/pull/' + args[1] + '#issuecomment-' + id)
} else if (args[0] === 'comment-edit') {
  const comment = comments.find(entry => String(entry.id) === args[1])
  comment.body = args[3]
  save()
  console.log('https://github.com/o/r/pull/5#issuecomment-' + comment.id)
} else if (args[0] === 'api' && args.includes('--paginate')) {
  for (const comment of comments) console.log(JSON.stringify(comment))
} else if (args[0] === 'api' && args.includes('repos/o/r/check-runs')) {
  if (process.env.FAKE_GH_CHECKS_403) { console.error('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1) }
  const input = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
  writeFileSync(join(state, 'check-run.json'), JSON.stringify(input))
  console.log(JSON.stringify({ id: 9, html_url: 'https://github.com/o/r/runs/9' }))
} else { console.error('fake gh: unexpected ' + args.join(' ')); process.exit(9) }
`

function setup(t, { comments = [] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-report-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  spawnSync('git', ['init', '-q', base])
  writeFileSync(join(base, 'fake-gh.mjs'), FAKE_GH)
  writeFileSync(join(base, 'gh.sh'), `#!/bin/bash\nexec node ${join(base, 'fake-gh.mjs')} "$@"\n`)
  chmodSync(join(base, 'gh.sh'), 0o755)
  writeFileSync(join(base, 'comments.json'), JSON.stringify(comments))
  return base
}

function planOf({ tier = 'standard', skip = null, run = CHECKS } = {}) {
  return {
    base: 'main', baseSha: 'b'.repeat(40), head: HEAD, tier, reasons: ['2 new exported interfaces'], stats: { files: 2, lines: 30 }, pr: null, skip,
    checks: Object.fromEntries(CHECKS.map(check => [check, run.includes(check) ? { action: 'run' } : { action: 'skip', reason: `no ${check} here` }])),
    settings: 'main:.ndev.json',
  }
}

const passing = (checks = CHECKS) => ({ head: HEAD, checks: Object.fromEntries(checks.map(check => [check, { state: 'pass', evidence: [{ text: `${check} holds`, file: 'src/a.js', line: 3 }] }])) })

function write(base, name, value) {
  const file = join(base, name)
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

const EVIDENCE = { head: HEAD, evidence: {} }

function report(base, { plan = planOf(), verdict, evidence = EVIDENCE, grid, args = ['--pr', '5'], env = {} } = {}) {
  const argv = ['proof', 'report', '--plan', write(base, 'plan.json', plan), ...args]
  if (verdict !== undefined) argv.push('--verdict', write(base, 'verdict.json', verdict))
  if (evidence !== null) argv.push('--evidence', write(base, 'evidence.json', evidence))
  if (grid !== undefined) argv.push('--grid', write(base, 'grid.md', grid))
  const clean = { ...process.env }
  for (const name of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'NDEV_PROOF_COMMENTER', 'FAKE_GH_CHECKS_403']) delete clean[name]
  const result = spawnSync(executable, [...argv, '--json'], {
    cwd: base, encoding: 'utf8', timeout: 60_000,
    env: { ...clean, NDEV_FLOW_GH: join(base, 'gh.sh'), FAKE_GH_STATE: base, GITHUB_REPOSITORY: 'o/r', ...env },
  })
  assert.ifError(result.error)
  return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr }
}

const comments = base => JSON.parse(readFileSync(join(base, 'comments.json'), 'utf8'))
const checkRun = base => JSON.parse(readFileSync(join(base, 'check-run.json'), 'utf8'))

test('a passing verdict posts one sticky comment with the table, the tier and the grid, and a successful check run', t => {
  const base = setup(t)
  const result = report(base, { verdict: passing(), grid: '| route | phone |\n|---|---|\n| / | ![x](u) |\n' })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const [comment] = comments(base)
  assert.match(comment.body, /^<!-- ndev-proof -->/)
  assert.match(comment.body, /\| A \| Requirements \| ✅ pass \| requirements holds \(src\/a\.js:3\) \|/)
  assert.match(comment.body, /\| G \| Lessons \| ✅ pass \|/)
  assert.match(comment.body, /Tier: \*\*standard\*\*: 2 new exported interfaces/)
  assert.match(comment.body, /<details>[\s\S]*\| \/ \| !\[x\]\(u\) \|[\s\S]*<\/details>/)
  assert.deepEqual({ ...checkRun(base), output: undefined }, { name: 'ndev proof', head_sha: HEAD, status: 'completed', conclusion: 'success', output: undefined })
  assert.equal(result.json.result.comment.action, 'created')
})

test('a second report edits the same comment, so the pull request keeps one Proof comment', t => {
  const base = setup(t)
  assert.equal(report(base, { verdict: passing() }).status, 0)
  const second = report(base, { verdict: { ...passing(), checks: { ...passing().checks, code: { state: 'fail', reason: 'the guard is missing', evidence: [{ text: 'no check of the limit', file: 'src/a.js', line: 9 }] } } } })
  assert.equal(second.status, 1)
  const all = comments(base)
  assert.equal(all.length, 1)
  assert.match(all[0].body, /\| B \| Code \| ❌ fail \| the guard is missing: no check of the limit \(src\/a\.js:9\) \|/)
  assert.equal(second.json.error.details.comment.action, 'edited')
  assert.equal(checkRun(base).conclusion, 'failure')
})

test('a Proof comment by another user is never edited', t => {
  const base = setup(t, { comments: [{ id: 7, body: '<!-- ndev-proof -->\nforged', login: 'mallory' }] })
  assert.equal(report(base, { verdict: passing() }).status, 0)
  const all = comments(base)
  assert.equal(all.length, 2)
  assert.equal(all[0].body, '<!-- ndev-proof -->\nforged')
})

test('in GitHub Actions the commenter is the actions bot', t => {
  const base = setup(t, { comments: [{ id: 7, body: '<!-- ndev-proof -->\nold', login: 'github-actions[bot]' }] })
  assert.equal(report(base, { verdict: passing(), env: { GITHUB_ACTIONS: 'true', FAKE_GH_ME: 'github-actions[bot]' } }).status, 0)
  assert.equal(comments(base).length, 1)
  assert.ok(!readFileSync(join(base, 'calls.log'), 'utf8').includes('["me"]'))
})

for (const [name, change, status] of [
  ['every planned check passes', {}, 0],
  ['a planned check fails', { tests: { state: 'fail', reason: 'no test of the new branch', evidence: [{ text: 'src/a.js has no test' }] } }, 1],
  ['a planned check did not run', { visual: { state: 'not-run', reason: 'the dev server did not start' } }, 1],
]) {
  test(`the exit status is ${status} when ${name}`, t => {
    const base = setup(t)
    const verdict = passing()
    Object.assign(verdict.checks, change)
    const result = report(base, { verdict, args: ['--local'] })
    assert.equal(result.status, status, JSON.stringify(result.json))
    assert.ok(!existsSync(join(base, 'calls.log')), '--local made a gh call')
  })
}

for (const [name, plan] of [['passes', planOf()], ['is skipped', planOf({ skip: { reason: 'the pull request is a draft' } })]]) {
  test(`--local prints the comment when the run ${name}`, t => {
    const base = setup(t)
    const files = ['--plan', write(base, 'plan.json', plan), '--verdict', write(base, 'verdict.json', passing()), '--evidence', write(base, 'evidence.json', EVIDENCE)]
    const result = spawnSync(executable, ['proof', 'report', '--local', ...files], { cwd: base, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NDEV_FLOW_GH: join(base, 'gh.sh'), FAKE_GH_STATE: base } })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /<!-- ndev-proof -->\n## Proof of a{12}/)
    assert.match(result.stdout, /\| B \| Code \| (✅ pass|⏭️ skipped) \|/)
    assert.ok(!existsSync(join(base, 'calls.log')), '--local made a gh call')
  })
}

test('a check the plan skips shows its reason and needs no verdict entry', t => {
  const base = setup(t)
  const result = report(base, { plan: planOf({ run: ['code', 'tests'] }), verdict: passing(['code', 'tests']), args: ['--local'] })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.match(result.json.result.body, /\| C \| Visual \| ⏭️ skipped \| no visual here \|/)
})

test('a skipped run needs no verdict, and sets a skipped check run', t => {
  const base = setup(t)
  const result = report(base, { plan: planOf({ skip: { reason: 'the pull request has the label no-proof' } }) })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(checkRun(base).conclusion, 'skipped')
  assert.match(comments(base)[0].body, /Proof skipped: the pull request has the label no-proof/)
})

test('a bad verdict lists every problem and exits 2', t => {
  const base = setup(t)
  const verdict = {
    head: 'c'.repeat(40), colour: 1,
    checks: {
      requirements: { state: 'maybe' },
      code: { state: 'fail', reason: 'wrong' },
      visual: { state: 'not-run' },
      tests: { state: 'pass', evidence: [{ text: 'x', line: 2 }] },
      model: { state: 'pass', evidence: [{ text: 'x', file: 'a.qnt', line: 0 }] },
      docs: { state: 'pass', extra: true, evidence: [{ text: 'x' }] },
      lessons: { state: 'skipped', reason: 'nothing to learn' },
      speed: { state: 'pass' },
    },
  }
  const result = report(base, { verdict, args: ['--local'] })
  assert.equal(result.status, 2)
  const message = result.json.error.message
  for (const problem of [
    `"head" is ${'c'.repeat(40)}, and the plan is for ${HEAD}`,
    '"colour" is not a verdict key',
    '"checks.speed" is not a check',
    '"checks.requirements.state" is "maybe"',
    '"checks.code.evidence" is empty, and a fail needs at least one item',
    '"checks.visual.reason" is missing',
    '"checks.tests.evidence[0].line" needs a file',
    '"checks.model.evidence[0].line" is 0',
    '"checks.docs" has the unknown key "extra"',
    '"checks.lessons.state" is "skipped", and the plan runs it',
  ]) assert.ok(message.includes(problem), `${message}\ndoes not say: ${problem}`)
  assert.match(result.json.error.repair, /skills\/proof\/references\/verdict\.md/)
})

test('a verdict with a check missing or a pass with no evidence is refused', t => {
  const base = setup(t)
  const verdict = passing(CHECKS.filter(check => check !== 'lessons'))
  verdict.checks.code = { state: 'pass' }
  const result = report(base, { verdict, args: ['--local'] })
  assert.equal(result.status, 2)
  assert.match(result.json.error.message, /"checks\.lessons" is missing, and the plan runs it/)
  assert.match(result.json.error.message, /"checks\.code\.evidence" is empty, and a pass needs at least one item/)
})

test('a verdict without the evidence file is refused', t => {
  const base = setup(t)
  const result = report(base, { verdict: passing(), evidence: null, args: ['--local'] })
  assert.equal(result.status, 2)
  assert.match(result.json.error.message, /--evidence <file>/)
})

test('agent text cannot ping people, forge the marker or break the table', t => {
  const base = setup(t)
  const verdict = passing()
  verdict.summary = 'All good @octocat <!-- ndev-proof --> </details>'
  verdict.checks.code.evidence = [{ text: 'see <img src=x> and @team|x', file: 'src/a.js', line: 2 }]
  const result = report(base, { verdict, args: ['--local'] })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const { body } = result.json.result
  assert.equal(body.split('<!-- ndev-proof -->').length, 2)
  assert.ok(!body.includes('@octocat') && !body.includes('@team') && !body.includes('<img'), body)
  assert.match(body, /\| B \| Code \| ✅ pass \| see &lt;img src=x&gt; and &#64;team\\\|x \(src\/a\.js:2\) \|/)
})

test('agent text cannot render a remote image or a link', t => {
  const base = setup(t)
  const verdict = passing()
  verdict.summary = 'Done ![x](https://evil.example/p.png) [click](https://evil.example)'
  const result = report(base, { verdict, args: ['--local'] })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const { body } = result.json.result
  assert.ok(!body.includes('![x]') && !body.includes('[click]'), body)
})

test('a check whose evidence did not run cannot pass', t => {
  const base = setup(t)
  const evidence = { head: HEAD, evidence: { tests: { state: 'not-run', command: 'git diff', output: 'fatal: bad revision' } } }
  const result = report(base, { verdict: passing(), evidence, args: ['--local'] })
  assert.equal(result.status, 2)
  assert.match(result.json.error.message, /"checks\.tests\.state" is "pass", and its evidence did not run: fatal: bad revision/)
})

test('a check run that GitHub refuses names the token permission', t => {
  const base = setup(t)
  const result = report(base, { verdict: passing(), env: { FAKE_GH_CHECKS_403: '1' } })
  assert.equal(result.status, 1)
  assert.match(result.json.error.message, /HTTP 403/)
  assert.match(result.json.error.repair, /checks: write/)
})

test('report refuses to run without --pr or --local', t => {
  const base = setup(t)
  const result = report(base, { verdict: passing(), args: [] })
  assert.equal(result.status, 2)
  assert.match(result.json.error.message, /--pr <n> or --local/)
})
