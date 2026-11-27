import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')

const FAKE_AGENT = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('NDEV_PROOF_'))) }))
const mode = process.env.FAKE_AGENT_MODE
if (mode === 'crash') { console.error('boom: the model is not available'); process.exit(3) }
const plan = JSON.parse(readFileSync(process.env.NDEV_PROOF_PLAN, 'utf8'))
const checks = {}
for (const [check, planned] of Object.entries(plan.checks)) if (planned.action === 'run') checks[check] = { state: 'pass', evidence: [{ text: check + ' checked' }] }
if (mode === 'bad') checks.code = { state: 'fail' }
if (mode !== 'silent') writeFileSync(process.env.NDEV_PROOF_VERDICT, JSON.stringify({ head: plan.head, checks }))
console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 4, total_cost_usd: 0.21, result: 'done' }))
`

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(root, files, message) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
}

function repository(t, config, change) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-run-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  git(base, 'init', '-q', '-b', 'main', root)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return a + b\n}\n', ...(config ? { '.ndev.json': `${JSON.stringify(config)}\n` } : {}) }, 'base')
  git(root, 'checkout', '-qb', 'work')
  commit(root, change, 'change')
  writeFileSync(join(base, 'agent.mjs'), FAKE_AGENT)
  chmodSync(join(base, 'agent.mjs'), 0o755)
  writeFileSync(join(base, 'body.md'), '## Summary\n\nAdds sub.\n\n## Lessons\n\nKeep the helpers small.\n')
  return { base, root }
}

const trivial = { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n', 'tests/util.test.js': 'test()\n' }
const standard = { 'src/util.js': 'function add(a, b) {\n  return a + b\n}\nexport function sub(a, b) {\n  return a - b\n}\n', 'tests/util.test.js': 'test()\n' }

function proofRun({ base, root }, { args = ['--base', 'main'], mode = 'pass', env = {} } = {}) {
  const clean = { ...process.env }
  for (const name of ['GITHUB_BASE_REF', 'GITHUB_EVENT_PATH', 'GITHUB_ACTIONS', 'NDEV_FLOW_GH', 'ANTHROPIC_API_KEY']) delete clean[name]
  const result = spawnSync(executable, ['proof', 'run', '--local', '--body', join(base, 'body.md'), '--out', join(base, 'out'), ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...clean, NDEV_PROOF_AGENT: join(base, 'agent.mjs'), FAKE_AGENT_LOG: join(base, 'agent.json'), FAKE_AGENT_MODE: mode, ...env },
  })
  assert.ifError(result.error)
  return { status: result.status, json: JSON.parse(result.stdout), agent: existsSync(join(base, 'agent.json')) ? JSON.parse(readFileSync(join(base, 'agent.json'), 'utf8')) : null }
}

test('a trivial change is judged from the evidence alone, with no agent', t => {
  const repo = repository(t, null, trivial)
  const result = proofRun(repo)
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.agent, null)
  assert.equal(result.json.result.checks.tests.state, 'pass')
  assert.equal(result.json.result.checks.code.state, 'skipped')
  assert.match(result.json.result.checks.code.reason, /trivial tier: no agent/)
  assert.equal(JSON.parse(readFileSync(join(repo.base, 'out/verdict.json'), 'utf8')).checks.code, undefined)
  assert.ok(existsSync(join(repo.base, 'out/verdict.json')))
})

test('a trivial change with a missing test fails from the evidence', t => {
  const repo = repository(t, null, { 'src/util.js': 'function add(a, b) {\n  return b + a\n}\n' })
  const result = proofRun(repo)
  assert.equal(result.status, 1)
  assert.equal(result.agent, null)
  assert.match(result.json.error.message, /tests \(fail/)
})

test('a standard change runs the agent with the caps for its tier from the base config', t => {
  const repo = repository(t, { proof: { limits: { standard: { turns: 7, budget: 1.5 } } } }, standard)
  const result = proofRun(repo)
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const { argv, env } = result.agent
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '7')
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1.5')
  assert.ok(argv.includes('-p'))
  assert.match(argv[argv.indexOf('-p') + 1], /skills\/proof\/SKILL\.md/)
  assert.equal(env.NDEV_PROOF_VERDICT, join(repo.base, 'out/verdict.json'))
  assert.equal(env.NDEV_PROOF_PLAN, join(repo.base, 'out/plan.json'))
  assert.equal(env.NDEV_PROOF_EVIDENCE, join(repo.base, 'out/evidence.json'))
  assert.equal(result.json.result.agent.turns, 4)
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user')
  assert.ok(argv.includes('--strict-mcp-config'))
  assert.ok(!argv.includes('--bare'))
  const tools = argv[argv.indexOf('--allowedTools') + 1].split(',')
  assert.ok(tools.includes(`Write(/${join(repo.base, 'out/verdict.json')})`), tools.join(' '))
  assert.ok(!tools.includes('Write'))
  assert.ok(tools.every(tool => !tool.startsWith('Bash(node') || tool.includes('proof report --local')), tools.join(' '))
  assert.ok(tools.filter(tool => tool.startsWith('Bash(git')).every(tool => !/HEAD:\*\)$/.test(tool)), tools.join(' '))
})

test('with an API key the agent runs bare, so the pull request cannot add hooks or instructions', t => {
  const repo = repository(t, null, standard)
  const result = proofRun(repo, { env: { ANTHROPIC_API_KEY: 'test-key' } })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.ok(result.agent.argv.includes('--bare'))
})

test('in GitHub Actions a standard change needs ANTHROPIC_API_KEY, so the agent never reads the pull request instructions', t => {
  const repo = repository(t, null, standard)
  const result = proofRun(repo, { env: { GITHUB_ACTIONS: 'true' } })
  assert.equal(result.status, 2, JSON.stringify(result.json))
  assert.match(result.json.error.message, /ANTHROPIC_API_KEY/)
  assert.equal(result.agent, null)
})

test('a stale verdict in --out is not read when the agent writes none', t => {
  const repo = repository(t, null, standard)
  assert.equal(proofRun(repo).status, 0)
  const result = proofRun(repo, { mode: 'silent' })
  assert.equal(result.status, 1, JSON.stringify(result.json))
  assert.match(result.json.error.details.checks.code.reason, /wrote no verdict/)
})

for (const [mode, says] of [
  ['crash', /exited 3: boom: the model is not available/],
  ['silent', /wrote no verdict/],
  ['bad', /"checks\.code\.reason" is missing/],
]) {
  test(`an agent that ${mode === 'crash' ? 'fails' : mode === 'silent' ? 'writes no verdict' : 'writes a bad verdict'} leaves the judged checks not-run, and the run fails`, t => {
    const repo = repository(t, null, standard)
    const result = proofRun(repo, { mode })
    assert.equal(result.status, 1, JSON.stringify(result.json))
    const { checks } = result.json.error.details
    assert.equal(checks.code.state, 'not-run')
    assert.match(checks.code.reason, says)
  })
}

test('a base that opts out skips the run, with no agent', t => {
  const repo = repository(t, { proof: { enabled: false } }, standard)
  const result = proofRun(repo)
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.agent, null)
  assert.equal(result.json.result.conclusion, 'skipped')
})

test('run needs a base: --base, or GITHUB_BASE_REF in GitHub Actions', t => {
  const repo = repository(t, null, trivial)
  const result = proofRun(repo, { args: [] })
  assert.equal(result.status, 2)
  assert.match(result.json.error.message, /--base <ref>/)
})
