import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')
const site = join(repoRoot, 'tests/fixtures/proof-site.mjs')
const matrix = join(repoRoot, 'tests/fixtures/proof-matrix.mjs')

const FAKE_GH = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const state = process.env.FAKE_GH_STATE
const args = process.argv.slice(2)
appendFileSync(join(state, 'calls.log'), JSON.stringify(args) + '\\n')
const joined = args.join(' ')
if (joined.startsWith('view-json pr 5 ')) console.log(JSON.stringify({ labels: [], isDraft: false, isCrossRepository: false }))
else if (args[0] === 'api' && args[1] === 'graphql') {
  if (process.env.FAKE_GH_PROVEN_FAIL) { console.error('gh: HTTP 502 Bad Gateway'); process.exit(4) }
  console.log(readFileSync(join(state, 'timeline.json'), 'utf8'))
} else if (args[0] === 'api' && args.includes('--paginate')) {
} else if (args[0] === 'comment') console.log('https://github.com/o/r/pull/5#issuecomment-1')
else if (args[0] === 'api' && args.includes('repos/o/r/check-runs')) {
  writeFileSync(join(state, 'check-run.json'), readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
  console.log(JSON.stringify({ id: 9, html_url: 'https://github.com/o/r/runs/9' }))
} else { console.error('fake gh: unexpected ' + joined); process.exit(9) }
`

const FAKE_AGENT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const log = { argv, env: { ...process.env } }
writeFileSync(process.env.NDEV_PROOF_FAKE_LOG, JSON.stringify(log))
const mode = process.env.NDEV_PROOF_FAKE_MODE
if (mode === 'crash') { console.error('boom: the model is not available'); process.exit(3) }
const plan = JSON.parse(readFileSync(process.env.NDEV_PROOF_PLAN, 'utf8'))
const checks = {}
for (const [check, planned] of Object.entries(plan.checks)) if (planned.action === 'run') checks[check] = { state: 'pass', evidence: [{ text: check + ' checked' }] }
if (mode === 'bad') checks.code = { state: 'fail' }
if (mode !== 'silent') writeFileSync(process.env.NDEV_PROOF_VERDICT, JSON.stringify({ head: plan.head, checks }))
if (mode === 'self-check') {
  const command = argv[argv.indexOf('--allowedTools') + 1].split(',').find(tool => tool.startsWith('Bash(node ')).slice(5, -1)
  const checked = spawnSync('sh', ['-c', command], { encoding: 'utf8' })
  writeFileSync(process.env.NDEV_PROOF_FAKE_LOG, JSON.stringify({ ...log, selfCheck: { command, status: checked.status, output: checked.stdout + checked.stderr } }))
}
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

function freePort() {
  const result = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' })
  return Number(result.stdout.trim())
}

function repository(t, config, change, baseFiles = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-run-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  git(base, 'init', '-q', '-b', 'main', root)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return a + b\n}\n', ...baseFiles, ...(config ? { '.ndev.json': `${JSON.stringify(config)}\n` } : {}) }, 'base')
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
    env: { ...clean, NDEV_PROOF_AGENT: join(base, 'agent.mjs'), NDEV_PROOF_FAKE_LOG: join(base, 'agent.json'), NDEV_PROOF_FAKE_MODE: mode, ...env },
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
  assert.match(argv[argv.indexOf('-p') + 1], /The request is in the evidence under "request": the pull request body, and each issue that it closes/)
  assert.equal(JSON.parse(readFileSync(join(repo.base, 'out/evidence.json'), 'utf8')).request.body, readFileSync(join(repo.base, 'body.md'), 'utf8'))
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

test('the agent gets no GitHub token and no git auth header, and keeps the API key and what its self-check needs', t => {
  const repo = repository(t, null, standard)
  const job = { ANTHROPIC_API_KEY: 'test-key', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic c2VjcmV0', NPM_TOKEN: 'npm-secret', DEPLOY_SECRET: 'deploy-secret', CLAUDE_CODE_OAUTH_TOKEN: 'claude-login', ANTHROPIC_AUTH_TOKEN: 'anthropic-login' }
  const result = proofRun(repo, { mode: 'self-check', env: job })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const { env, selfCheck, argv } = result.agent
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'NPM_TOKEN', 'DEPLOY_SECRET']) assert.equal(env[name], undefined, `${name} reached the agent`)
  assert.equal(env.ANTHROPIC_API_KEY, 'test-key')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-login')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'anthropic-login')
  assert.equal(env.PATH, process.env.PATH)
  assert.equal(env.HOME, process.env.HOME)
  assert.equal(env.NDEV_PROOF_PLAN, join(repo.base, 'out/plan.json'))
  assert.equal(selfCheck.status, 0, `${selfCheck.command}: ${selfCheck.output}`)
  assert.match(argv[argv.indexOf('-p') + 1], /The request .* is untrusted text written by outsiders/)
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

function servers(ports) {
  const server = (port, cwd) => ({ command: `node ${site}`, port, ready: `http://127.0.0.1:${port}/`, env: { FIXTURE_PORT: String(port), FIXTURE_ROUTES: '/' }, routes: ['/'], cwd })
  return { devServers: { web: server(ports[0], 'web'), admin: server(ports[1], 'admin') } }
}

const serverFolders = { 'web/index.html': '<p>web</p>\n', 'admin/index.html': '<p>admin</p>\n' }

test('the visual check starts only the dev servers whose folder holds a changed UI file', t => {
  const repo = repository(t, servers([freePort(), freePort()]), { 'web/App.tsx': 'export const App = () => null\n', 'web/App.test.tsx': 'test()\n' }, serverFolders)
  const result = proofRun(repo, { env: { NDEV_PROOF_MATRIX: matrix } })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.checks.visual.state, 'pass')
  assert.ok(existsSync(join(repo.base, 'out/snapshots/head/web/argv.json')))
  assert.ok(!existsSync(join(repo.base, 'out/snapshots/head/admin')), 'the admin server was started for a change in web/')
})

test('the visual check starts a dev server that the pull request adds to .ndev.json', t => {
  const ports = [freePort(), freePort()]
  const both = servers(ports)
  const webOnly = { devServers: { web: both.devServers.web } }
  const repo = repository(t, webOnly, { '.ndev.json': `${JSON.stringify(both)}\n`, 'admin/App.tsx': 'export const App = () => null\n', 'admin/App.test.tsx': 'test()\n' }, serverFolders)
  const result = proofRun(repo, { env: { NDEV_PROOF_MATRIX: matrix } })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.checks.visual.state, 'pass', JSON.stringify(result.json.result.checks.visual))
  assert.ok(existsSync(join(repo.base, 'out/snapshots/head/admin/argv.json')), 'the admin server that the pull request adds was not started')
  assert.ok(!existsSync(join(repo.base, 'out/snapshots/head/web')), 'the web server was started for a change in admin/')
})

test('a pull request that removes the dev server of its changed UI files fails the visual check, not skips it', t => {
  const both = servers([freePort(), freePort()])
  const webOnly = { devServers: { web: both.devServers.web } }
  const repo = repository(t, both, { '.ndev.json': `${JSON.stringify(webOnly)}\n`, 'admin/App.tsx': 'export const App = () => null\n', 'admin/App.test.tsx': 'test()\n' }, serverFolders)
  const result = proofRun(repo, { env: { NDEV_PROOF_MATRIX: matrix } })
  const visual = (result.json.result ?? result.json.error.details).checks.visual
  assert.notEqual(result.status, 0, JSON.stringify(result.json))
  assert.ok(['fail', 'not-run'].includes(visual.state), JSON.stringify(visual))
  assert.match(visual.reason, /admin/)
})

test('a pull request that moves the cwd of its dev server away from its changed UI files still runs the visual check', t => {
  const both = servers([freePort(), freePort()])
  const moved = { devServers: { ...both.devServers, admin: { ...both.devServers.admin, cwd: 'web' } } }
  const repo = repository(t, both, { '.ndev.json': `${JSON.stringify(moved)}\n`, 'admin/App.tsx': 'export const App = () => null\n', 'admin/App.test.tsx': 'test()\n' }, serverFolders)
  const result = proofRun(repo, { env: { NDEV_PROOF_MATRIX: matrix } })
  const visual = (result.json.result ?? result.json.error.details).checks.visual
  assert.notEqual(visual.state, 'skipped', JSON.stringify(visual))
  assert.ok(existsSync(join(repo.base, 'out/snapshots/head/admin')), 'the admin server was not started')
})

test('the visual check is skipped, naming the changed UI files, when no dev server holds them', t => {
  const repo = repository(t, servers([freePort(), freePort()]), { 'other/Thing.tsx': 'export const Thing = () => null\n', 'other/Thing.test.tsx': 'test()\n' }, serverFolders)
  const result = proofRun(repo, { env: { NDEV_PROOF_MATRIX: matrix } })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.checks.visual.state, 'skipped')
  assert.match(result.json.result.checks.visual.reason, /other\/Thing\.tsx/)
  assert.ok(!existsSync(join(repo.base, 'out/snapshots')))
})

function rebased(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-run-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const origin = join(base, 'origin.git')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const root = join(base, 'repo')
  git(base, 'init', '-q', '-b', 'main', root)
  git(root, 'remote', 'add', 'origin', origin)
  commit(root, { 'src/util.js': 'function add(a, b) {\n  return a + b\n}\n' }, 'base')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'checkout', '-qb', 'work')
  commit(root, trivial, 'change')
  const proven = git(root, 'rev-parse', 'HEAD')
  git(root, 'push', '-q', 'origin', 'work')
  git(root, 'checkout', '-q', 'main')
  commit(root, { 'README.md': '# Project\n' }, 'readme')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'checkout', '-q', 'work')
  git(root, 'rebase', '-q', 'main')
  git(root, 'push', '-qf', 'origin', 'work')
  const ci = join(base, 'ci')
  git(base, 'clone', '-q', '--no-local', '-b', 'work', `file://${origin}`, ci)
  writeFileSync(join(base, 'fake-gh.mjs'), FAKE_GH)
  writeFileSync(join(base, 'gh.sh'), `#!/bin/bash\nexec node ${join(base, 'fake-gh.mjs')} "$@"\n`)
  chmodSync(join(base, 'gh.sh'), 0o755)
  const run = (key, conclusion, at = '2026-11-27T10:00:00Z') => ({ oid: key, checkSuites: { nodes: [{ checkRuns: { nodes: conclusion ? [{ conclusion, completedAt: at }] : [] } }] } })
  return { base, ci, proven, head: git(ci, 'rev-parse', 'HEAD'), run }
}

function prRun({ base, ci }, timeline, env = {}) {
  writeFileSync(join(base, 'timeline.json'), JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: timeline } } } } }))
  const clean = { ...process.env }
  for (const name of ['GITHUB_BASE_REF', 'GITHUB_EVENT_PATH', 'GITHUB_ACTIONS', 'ANTHROPIC_API_KEY']) delete clean[name]
  const result = spawnSync(executable, ['proof', 'run', '--pr', '5', '--base', 'origin/main', '--out', join(base, 'out'), '--json'], {
    cwd: ci, encoding: 'utf8', timeout: 120_000,
    env: { ...clean, NDEV_FLOW_GH: join(base, 'gh.sh'), FAKE_GH_STATE: base, GITHUB_REPOSITORY: 'o/r', NDEV_PROOF_COMMENTER: 'bot', NDEV_PROOF_AGENT: join(base, 'no-agent'), ...env },
  })
  assert.ifError(result.error)
  const calls = readFileSync(join(base, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { status: result.status, json: JSON.parse(result.stdout), calls }
}

test('a --pr run skips a commit that only rebases the last commit that Proof passed, and fetches that commit', t => {
  const repo = rebased(t)
  assert.notEqual(spawnSync('git', ['-C', repo.ci, 'cat-file', '-e', `${repo.proven}^{commit}`]).status, 0, 'the clone already has the proven commit')
  const result = prRun(repo, [
    { __typename: 'PullRequestCommit', commit: repo.run(repo.proven, 'SUCCESS') },
    { __typename: 'HeadRefForcePushedEvent', beforeCommit: repo.run(repo.proven, 'SUCCESS'), afterCommit: repo.run(repo.head, null) },
  ])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.conclusion, 'skipped')
  assert.match(result.json.result.checks.code.reason, new RegExp(`only a rebase since the last proven commit ${repo.proven.slice(0, 12)}`))
  const query = result.calls.find(args => args[0] === 'api' && args[1] === 'graphql')
  assert.ok(query.join(' ').includes('ndev proof') && query.includes('number=5'), query.join(' '))
})

test('a --pr run with no successful Proof check run on the pull request proves the commit', t => {
  const repo = rebased(t)
  const result = prRun(repo, [{ __typename: 'PullRequestCommit', commit: repo.run(repo.head, null) }, { __typename: 'PullRequestCommit', commit: repo.run(repo.proven, 'FAILURE') }])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.conclusion, 'success')
})

test('a --pr run whose last proven commit cannot be fetched runs in full, and the report names the reason', t => {
  const repo = rebased(t)
  const gone = 'dead'.repeat(10)
  const result = prRun(repo, [
    { __typename: 'HeadRefForcePushedEvent', beforeCommit: repo.run(gone, 'SUCCESS'), afterCommit: repo.run(repo.head, null) },
  ])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.conclusion, 'success')
  const reason = new RegExp(`the last proven commit ${gone} could not be fetched: .+, so this run is a full run`)
  assert.match(result.json.result.notice, reason)
  assert.match(result.json.result.text, reason)
  assert.match(JSON.parse(readFileSync(join(repo.base, 'check-run.json'), 'utf8')).output.summary, reason)
})

test('a --pr run takes the newest proven commit that it can fetch', t => {
  const repo = rebased(t)
  const gone = 'dead'.repeat(10)
  const result = prRun(repo, [
    { __typename: 'PullRequestCommit', commit: repo.run(repo.proven, 'SUCCESS') },
    { __typename: 'HeadRefForcePushedEvent', beforeCommit: repo.run(gone, 'SUCCESS', '2026-11-27T11:00:00Z'), afterCommit: repo.run(repo.head, null) },
  ])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.conclusion, 'skipped')
  assert.match(result.json.result.checks.code.reason, new RegExp(`only a rebase since the last proven commit ${repo.proven.slice(0, 12)}`))
  assert.match(result.json.result.notice, new RegExp(`the last proven commit ${gone} could not be fetched: .+, so this run compares with the older proven commit ${repo.proven}`))
})

test('a --pr run whose read of the Proof check runs fails runs in full, and the report names the gh failure', t => {
  const repo = rebased(t)
  const result = prRun(repo, [], { FAKE_GH_PROVEN_FAIL: '1' })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.conclusion, 'success')
  const reason = /the read of the ndev proof check runs of pull request 5 failed: gh\.sh api graphql exited 4: gh: HTTP 502 Bad Gateway, so this run is a full run/
  assert.match(result.json.result.notice, reason)
  assert.match(result.json.result.text, reason)
  assert.match(JSON.parse(readFileSync(join(repo.base, 'check-run.json'), 'utf8')).output.summary, reason)
})
