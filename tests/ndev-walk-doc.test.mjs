import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runWalkDoc } from '../scripts/ndev/walk-doc.mjs'
import { runPane } from '../scripts/ndev/panes.mjs'

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'ndev-walk-'))
  t.after(() => rm(folder, { force: true, recursive: true }))
  const home = join(folder, 'home')
  const cwd = join(folder, 'worktree')
  await mkdir(home)
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await writeFile(join(cwd, 'docs/intro.md'), '# Start\n')
  await writeFile(join(cwd, '.walk-doc.json'), JSON.stringify({
    devCommand: ['serve', '--port', '{port}'], contentRoot: 'docs', deny: ['src'], finish: [], media: 'Link evidence.', issues: '',
  }))
  execFileSync('git', ['init', '-q', '-b', 'main', cwd])
  const effects = []
  let terminal = 'term_owner'
  let launches = 0
  const options = {
    cwd,
    env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, 'state') },
    identity: async () => ({ terminal, session: terminal.replace('term_', 'session_'), runtime: 'runtime-walk' }),
    server: async ({ runDir }) => {
      effects.push({ kind: 'server', runDir })
      return { port: 6670, pid: 1234, identity: 'expected process' }
    },
    stopServer: async server => { effects.push({ kind: 'stopServer', server }) },
    orca: async args => {
      effects.push({ kind: args.slice(0, 2).join(' '), args })
      if (args[0] === 'agent') return { launch: { outcome: { kind: 'terminal', handle: `term_reader${++launches}` } } }
      if (args[0] === 'terminal' && args[1] === 'send') return { accepted: true }
      return {}
    },
  }
  return { options, run: (...argv) => runWalkDoc(argv, options), role: id => { terminal = `term_${id}` }, effects }
}

test('walk start, report, continue and restart publish status and keep attempts distinct', async t => {
  const walk = await fixture(t)
  const start = await walk.run('start', 'docs/intro.md', '--persona', 'first-time reader')
  assert.equal(start.run.phase, 'walking')
  assert.equal(start.run.agentId, 'term_reader1')
  assert.deepEqual(start.run.startUrls, ['http://localhost:6670/intro/'])
  const report = join(walk.options.cwd, 'finding.json')
  await writeFile(report, JSON.stringify({ code: 'OMISSION', step: 'Install', expected: 'Click Next', actual: 'No button', evidence: 'Screenshot' }))
  await assert.rejects(walk.run('report', '--file', report), /current.*reader/i)
  walk.role('reader1')
  assert.match((await walk.run('report', '--file', report)).text, /end your turn/i)
  assert.equal((await walk.run('status')).run.phase, 'awaiting')
  const reply = join(walk.options.cwd, 'reply.json')
  await writeFile(reply, JSON.stringify({ action: 'CONTINUE', note: 'Clarified the step' }))
  await assert.rejects(walk.run('reply', '--file', reply), /owning.*session/i)
  walk.role('owner')
  const continued = await walk.run('reply', '--file', reply)
  assert.equal(continued.run.agentId, 'term_reader1')
  assert.equal(continued.run.phase, 'walking')
  assert.equal(walk.effects.at(-1).args[3], 'term_reader1')
  const restarted = await walk.run('restart', 'Check from the beginning')
  assert.equal(restarted.run.agentId, 'term_reader2')
  assert.equal(restarted.run.attempt, 2)
  assert.ok(walk.effects.some(entry => entry.kind === 'terminal close' && entry.args[3] === 'term_reader1'))
  const view = await runPane(['bridge', 'snapshot', 'walk-doc'], walk.options)
  assert.match(JSON.stringify(view.data), /OMISSION.*Install/)
  walk.role('reader1')
  await assert.rejects(walk.run('report', '--file', report), /current.*reader/i)
})

test('numbered walk questions reach the current reader and finish preserves reports after cleanup', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  await walk.run('ask', 'Which heading opened?')
  walk.role('reader1')
  await assert.rejects(walk.run('answer', '2', 'Wrong ID'), /no question #2/i)
  const answer = await walk.run('answer', '1', 'Install')
  assert.equal(answer.run.asks[0].answer.text, 'Install')
  await assert.rejects(walk.run('answer', '1', 'Duplicate'), /already answered/i)
  await walk.run('done', 'Read the whole page')
  walk.role('owner')
  const done = await walk.run('finish', 'Checked the intro')
  assert.equal(done.run.phase, 'finished')
  assert.match(await readFile(done.run.report, 'utf8'), /Checked the intro.*[\s\S]*Which heading opened/)
  assert.ok(walk.effects.some(effect => effect.kind === 'stopServer'))
})

test('walk record refuses symlinks that leave the active attempt', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const media = join(run.home, '.walk-doc', run.runId, 'attempt-1', 'media')
  const photo = join(walk.options.cwd, 'outside.jpg')
  const evidence = join(media, 'evidence.jpg')
  await writeFile(photo, 'image')
  await symlink(photo, evidence)
  const file = join(walk.options.cwd, 'record.json')
  await writeFile(file, JSON.stringify({ file: evidence, mode: 'INSERT', caption: 'Example' }))
  walk.role('reader1')
  await assert.rejects(walk.run('record', '--file', file), /outside.*attempt|attempt.*outside/i)
})

test('a reader who creates a Git repo in its attempt still reports to the parent worktree', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const attempt = join(run.home, '.walk-doc', run.runId, 'attempt-1')
  const folder = join(attempt, 'example')
  await mkdir(folder)
  execFileSync('git', ['init', '-q', '-b', 'main', folder])
  await writeFile(join(folder, 'note.json'), JSON.stringify({ step: 'Start', note: 'Show the working directory.' }))
  walk.role('reader1')
  const result = await runWalkDoc(['enhance', '--file', 'note.json'], { ...walk.options, cwd: folder })
  assert.equal(result.run.runId, run.runId)
  assert.equal(result.run.findings[0].actual, 'Show the working directory.')
})

test('a report with an uncertain delivery can only be replayed against the same Orca receipt', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const original = walk.options.orca
  let errors = 0
  walk.options.orca = async args => {
    if (args[0] === 'terminal' && args[1] === 'send' && args[3] === 'term_owner' && errors++ === 0) {
      throw Object.assign(Error('Connection lost'), { details: { receipt: { error: { data: { requestId: 'report-1' } } } } })
    }
    return original(args)
  }
  const file = join(walk.options.cwd, 'report.json')
  const finding = { code: 'BUG', step: 'First step', expected: 'Open', actual: 'Closed', evidence: 'Exit 1' }
  await writeFile(file, JSON.stringify(finding))
  walk.role('reader1')
  await assert.rejects(walk.run('report', '--file', file), /Connection lost/)
  assert.equal((await walk.run('status')).run.findings.length, 1)
  await writeFile(file, JSON.stringify({ ...finding, step: 'Different step' }))
  await assert.rejects(walk.run('report', '--file', file), /unresolved delivery/)
  await writeFile(file, JSON.stringify(finding))
  const recovered = await walk.run('report', '--file', file)
  assert.equal(recovered.run.findings.length, 1)
  assert.deepEqual(walk.effects.at(-1).args.slice(-2), ['--retry-request', 'report-1'])
})

test('walk panel controls require explicit desktop consent outside the owning terminal', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const { identity, ...options } = walk.options
  delete options.env.ORCA_TERMINAL_HANDLE
  const bindings = []
  options.confirm = binding => { bindings.push(binding); return false }
  await assert.rejects(runWalkDoc(['ask', 'What page opened?'], options), /confirmation declined/i)
  assert.deepEqual(bindings[0].target, { run: run.runId, input: 'What page opened?' })
  assert.equal(bindings[0].revision, run.revision)
  const snapshot = await walk.run('status')
  assert.equal(snapshot.run.asks, undefined)
})

test('the ndev binary returns a scoped walk status in a clean temporary Git checkout', async t => {
  const { options } = await fixture(t)
  const cli = new URL('../scripts/cli.mjs', import.meta.url)
  const output = execFileSync(process.execPath, [cli.pathname, '--json', 'walk-doc', 'status'], { cwd: options.cwd, env: options.env, encoding: 'utf8' })
  const response = JSON.parse(output)
  assert.equal(response.ok, true)
  assert.equal(response.result.run, null)
  assert.match(response.result.text, /No run is recorded/)
  assert.equal(response.result.snapshot.panelId, 'walk-doc')
})

test('session-end cleanup stops only an exact owned walk and keeps the report', async t => {
  const { finishWalkOnSessionEnd } = await import('../scripts/ndev/walk-doc.mjs')
  const walk = await fixture(t)
  const start = await walk.run('start', 'docs/intro.md')
  const before = walk.effects.length
  assert.equal(await finishWalkOnSessionEnd(walk.options.cwd, { session: 'session_reader1', terminal: 'term_owner' }, walk.options), null)
  assert.equal(walk.effects.length, before)
  const finished = await finishWalkOnSessionEnd(walk.options.cwd, { session: 'session_owner', terminal: 'term_owner' }, walk.options)
  assert.equal(finished.run.runId, start.run.runId)
  assert.equal(finished.run.phase, 'finished')
  assert.match(await readFile(finished.run.report, 'utf8'), /Walk report/)
  assert.equal(await finishWalkOnSessionEnd(walk.options.cwd, { session: 'session_owner', terminal: 'term_owner' }, walk.options), null)
})

test('walk tool guard distinguishes parent, active reader and unrelated sessions', async t => {
  const { walkPreTool } = await import('../scripts/ndev/walk-doc.mjs')
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const reader = { session: 'session_reader1', terminal: 'term_reader1' }
  const owner = { session: 'session_owner', terminal: 'term_owner' }
  const guard = (actor, tool, input, command) => walkPreTool(walk.options.cwd, { ...actor, tool, input, command }, walk.options)
  const attempt = join(run.home, '.walk-doc', run.runId, 'attempt-1')
  const local = join(attempt, 'media', 'example.jpg')
  const source = join(walk.options.cwd, 'docs', 'intro.md')
  await symlink(source, join(attempt, 'redirect.md'))
  assert.equal(await guard(reader, 'read', { filePath: local }), null)
  assert.match(await guard(reader, 'Read', { file_path: source }), /docs source|worktree/i)
  assert.match(await walkPreTool(walk.options.env.HOME, { ...reader, tool: 'Read', input: { file_path: source } }, walk.options), /docs source|worktree/i)
  assert.match(await guard(reader, 'Read', { path: join(attempt, 'redirect.md') }), /docs source|worktree/i)
  assert.match(await guard(reader, 'functions.apply_patch', { patch: `*** Begin Patch\n*** Update File: ${source}\n*** End Patch` }), /docs source|worktree/i)
  assert.match(await guard(reader, 'functions.apply_patch', { patch: `*** Begin Patch\n*** Update File: ${local}\n*** Move to: ${source}\n*** End Patch` }), /docs source|worktree/i)
  assert.match(await guard(reader, 'Glob', { path: attempt, pattern: `${run.home}/*` }), /outside.*reader/i)
  assert.match(await guard(reader, 'collaboration.spawn_agent', {}), /works alone/i)
  assert.match(await guard(reader, 'functions.exec_command', { command: 'ndev walk-doc reply --file own.json' }), /owning.*session/i)
  assert.equal(await guard(reader, 'bash', { command: 'ndev walk-doc report --file findings.json' }), null)
  assert.match(await guard(owner, 'Bash', { command: 'ndev walk-doc report --file findings.json' }), /current.*reader/i)
  assert.equal(await guard(owner, 'Read', { file_path: source }), null)
  assert.equal(await guard({ session: 'other' }, 'Read', { file_path: source }), null)
  await walk.run('restart', 'Another reading')
  assert.match(await guard(reader, 'Read', { path: local }), /earlier.*attempt|current.*reader/i)
  const status = await walk.run('status')
  assert.equal(status.run.denials.length, 10)
})

test('reader navigation queues one rendered page and a lost copy launch replays its exact receipt', async t => {
  const { walkPostTool, tickWalkCopy } = await import('../scripts/ndev/walk-doc.mjs')
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const url = 'http://localhost:6670/intro/'
  const readerEvent = { session: 'session_reader1', terminal: 'term_reader1', tool: 'exec_command', input: { command: `curl ${url}?query=private-value` }, succeeded: true }
  await walkPostTool(walk.options.cwd, { ...readerEvent, session: 'session_owner', terminal: 'term_owner' }, walk.options)
  assert.equal((await walk.run('status')).run.copyReviews?.length ?? 0, 0)
  await walkPostTool(walk.options.cwd, readerEvent, walk.options)
  await walkPostTool(walk.options.cwd, readerEvent, walk.options)
  assert.equal((await walk.run('status')).run.copyReviews.length, 1)
  let fetched = 0
  walk.options.fetchCopyPage = candidate => {
    fetched += 1
    assert.equal(candidate, url)
    return '<html><main><h1>Install</h1><p>Open the page.</p><pre>not prose</pre></main></html>'
  }
  const bridge = walk.options.orca
  let launchCount = 0
  walk.options.orca = async args => {
    if (args[0] === 'agent' && args[1] === 'launch' && args.includes('--prompt')) {
      walk.effects.push({ kind: 'copy launch', args })
      if (++launchCount === 1) {
        throw Object.assign(Error('Orca disconnected'), { details: { receipt: { error: { data: { operationId: 'copy-launch-1' } } } } })
      }
      return { launch: { outcome: { kind: 'terminal', handle: 'term_copy' } } }
    }
    return bridge(args)
  }
  const tick = () => tickWalkCopy(walk.options.cwd, { session: 'session_owner', terminal: 'term_owner' }, walk.options)
  const first = await tick()
  assert.equal(first.state, 'retry')
  const launched = await tick()
  assert.equal(launched.state, 'running')
  assert.equal(fetched, 1)
  assert.deepEqual(walk.effects.at(-1).args.slice(-2), ['--retry-launch', 'copy-launch-1'])
  assert.match(await readFile(launched.file, 'utf8'), /# Install.*[\s\S]*Open the page/)
  assert.doesNotMatch(await readFile(launched.file, 'utf8'), /not prose|private-value/)
  await writeFile(launched.answerFile, 'VALE: ran, 1 alerts kept of 1\nFINDINGS: 1\n\nMove the condition first.\n')
  const answer = await tick()
  assert.equal(answer.state, 'answered')
  assert.equal((await walk.run('status')).run.findings[0].code, 'COPY')
  assert.equal(launchCount, 2)
})

test('copy review does not start another worker when no launch receipt is available', async t => {
  const { walkPostTool, tickWalkCopy } = await import('../scripts/ndev/walk-doc.mjs')
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const url = 'http://localhost:6670/intro/'
  await walkPostTool(walk.options.cwd, {
    session: 'session_reader1', terminal: 'term_reader1', tool: 'browser_navigate', input: { url }, succeeded: false,
  }, walk.options)
  assert.equal((await walk.run('status')).run.copyReviews?.length ?? 0, 0)
  await walkPostTool(walk.options.cwd, { session: 'session_reader1', terminal: 'term_reader1', tool: 'browser_navigate', input: { url } }, walk.options)
  walk.options.fetchCopyPage = () => '<main><p>Read the instructions.</p></main>'
  const bridge = walk.options.orca
  let launches = 0
  walk.options.orca = async args => {
    if (args[0] === 'agent' && args.includes('--prompt')) {
      launches += 1
      throw new Error('Lost response and receipt')
    }
    if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [{ handle: 'term_copy' }] }
    return bridge(args)
  }
  const tick = () => tickWalkCopy(walk.options.cwd, { session: 'session_owner', terminal: 'term_owner' }, walk.options)
  const failure = await tick()
  assert.equal(failure.state, 'failed')
  assert.match(failure.detail, /Lost response and receipt.*orca terminal list/)
  assert.equal(await tick(), null)
  assert.equal(launches, 1)
  const done = await walk.run('stop')
  assert.equal(done.run.phase, 'finished')
  assert.ok(walk.effects.some(effect => effect.kind === 'terminal close' && effect.args[3] === 'term_copy'))
})

const PANE = 'tab-owner:leaf-owner'

function attested({ terminal = 'term_owner', pane = PANE, session = 'session_owner', runtime = 'runtime-walk' } = {}) {
  const [tabId, leafId] = pane.split(':')
  return {
    status: { ok: true, result: { runtime: { runtimeId: runtime } }, _meta: { runtimeId: runtime } },
    'terminal show': {
      ok: true, _meta: { runtimeId: runtime },
      result: { terminal: { handle: terminal, worktreeId: 'repo::walk', tabId, leafId, connected: true, writable: true, orphaned: false } },
    },
    'worktree ps': {
      ok: true, _meta: { runtimeId: runtime },
      result: { truncated: false, worktrees: [{ worktreeId: 'repo::walk', agents: [{ paneKey: pane, address: terminal, orcaSessionId: session, hasLivePty: true }] }] },
    },
    'terminal send': { ok: true, _meta: { runtimeId: runtime }, result: { accepted: true } },
  }
}

async function fakeOrca(walk) {
  const folder = join(walk.options.env.HOME, 'fake-orca')
  await mkdir(folder)
  const binary = join(folder, 'orca')
  const replies = join(folder, 'replies.json')
  const calls = join(folder, 'calls.jsonl')
  await writeFile(binary, [
    `#!${process.execPath}`,
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    'fs.appendFileSync(process.env.FAKE_ORCA_CALLS, JSON.stringify(args) + "\\n")',
    "const key = args.filter(arg => !arg.startsWith('--')).slice(0, 2).join(' ')",
    'const reply = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_REPLIES, "utf8"))[key]',
    "if (!reply) { process.stdout.write(JSON.stringify({ ok: false, error: { message: 'no fake reply for ' + key } })); process.exit(1) }",
    'process.stdout.write(JSON.stringify(reply))',
  ].join('\n'))
  await chmod(binary, 0o755)
  const env = { ...walk.options.env, ORCA_CLI_COMMAND: binary, FAKE_ORCA_REPLIES: replies, FAKE_ORCA_CALLS: calls, ORCA_TERMINAL_HANDLE: 'term_owner', ORCA_PANE_KEY: PANE }
  delete env.ORCA_AGENT_SESSION_ID
  delete env.ORCA_DEV_REPO_ROOT
  const answer = async state => {
    await writeFile(replies, JSON.stringify(state))
    await writeFile(calls, '')
  }
  const called = async () => (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const cli = new URL('../scripts/cli.mjs', import.meta.url).pathname
  const ndev = (overrides, ...argv) => {
    const result = spawnSync(process.execPath, [cli, '--json', 'walk-doc', ...argv], { cwd: walk.options.cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
    return { status: result.status, body: JSON.parse(result.stdout) }
  }
  return { env, answer, called, ndev }
}

test('an Orca terminal without an injected session is admitted by the session Orca attests for its pane', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const orca = await fakeOrca(walk)
  await orca.answer(attested())
  const tip = orca.ndev({}, 'tip', 'Read the install page first')
  assert.equal(tip.status, 0, JSON.stringify(tip.body))
  const calls = await orca.called()
  assert.deepEqual(calls.slice(0, 3).map(args => args.slice(0, 2).join(' ')), ['status --json', 'terminal show', 'worktree ps'])
  assert.deepEqual(calls.at(-1).slice(0, 4), ['terminal', 'send', '--terminal', 'term_reader1'])
  const unnamed = attested()
  unnamed.status.result.caller = null
  await orca.answer(unnamed)
  const again = orca.ndev({}, 'tip', 'Then open the settings page')
  assert.equal(again.status, 0, JSON.stringify(again.body))
  const pane = 'tab-reader:leaf-reader'
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader1' }))
  const enhanced = orca.ndev({ ORCA_TERMINAL_HANDLE: 'term_reader1', ORCA_PANE_KEY: pane }, 'enhance', '--file', await note(walk))
  assert.equal(enhanced.status, 0, JSON.stringify(enhanced.body))
  assert.equal((await walk.run('status')).run.readerSession, 'session_reader1')
})

test('pane attestation refuses a missing pane, a mismatch, a stale terminal and an absent or ambiguous attestation', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const orca = await fakeOrca(walk)
  const edit = change => { const state = attested(); change(state); return state }
  const cases = [
    ['an unset pane key', attested(), { ORCA_PANE_KEY: '' }, /ORCA_AGENT_SESSION_ID.*ORCA_PANE_KEY/],
    ['an injected session Orca cannot resolve', attested(), { ORCA_AGENT_SESSION_ID: 'session_owner' }, /injected session session_owner/],
    ['another pane', attested({ pane: 'tab-owner:leaf-other' }), {}, /pane tab-owner:leaf-other.*ORCA_PANE_KEY tab-owner:leaf-owner/],
    ['another terminal', edit(state => { state['terminal show'].result.terminal.handle = 'term_other' }), {}, /returned term_other/],
    ['a disconnected terminal', edit(state => { state['terminal show'].result.terminal.connected = false }), {}, /not connected/],
    ['an orphaned terminal', edit(state => { state['terminal show'].result.terminal.orphaned = true }), {}, /not connected/],
    ['a terminal from another runtime', edit(state => { state['terminal show']._meta.runtimeId = 'runtime-next' }), {}, /runtime runtime-next.*runtime-walk/],
    ['a list from another runtime', edit(state => { state['worktree ps']._meta.runtimeId = 'runtime-next' }), {}, /runtime runtime-next.*runtime-walk/],
    ['a truncated list', edit(state => { state['worktree ps'].result.truncated = true }), {}, /truncated/],
    ['no agent in the pane', edit(state => { state['worktree ps'].result.worktrees[0].agents = [] }), {}, /0 agents in pane/],
    ['two agents in the pane', edit(state => { const [agent] = state['worktree ps'].result.worktrees[0].agents; state['worktree ps'].result.worktrees[0].agents.push({ ...agent, orcaSessionId: 'session_twin' }) }), {}, /2 agents in pane/],
    ['a pane bound to another terminal', edit(state => { state['worktree ps'].result.worktrees[0].agents[0].address = 'term_other' }), {}, /belongs to term_other/],
    ['a pane in another worktree', edit(state => { state['worktree ps'].result.worktrees[0].worktreeId = 'repo::elsewhere' }), {}, /repo::elsewhere/],
    ['an agent without a live PTY', edit(state => { state['worktree ps'].result.worktrees[0].agents[0].hasLivePty = false }), {}, /no live session/],
    ['another session in the owner pane', attested({ session: 'session_intruder' }), {}, /owning Orca session/],
    ['a restarted runtime', attested({ runtime: 'runtime-next' }), {}, /owning Orca session/],
    ['a caller Orca reports as not live', edit(state => { state.status.result.caller = { live: false, refusal: { message: 'session ended' } } }), {}, /not live: session ended/],
  ]
  for (const [name, state, overrides, message] of cases) {
    await orca.answer(state)
    const refused = orca.ndev(overrides, 'tip', 'Read the install page first')
    assert.equal(refused.status, 2, `${name}: ${JSON.stringify(refused.body)}`)
    assert.match(refused.body.error.message, message, name)
    assert.ok(text(refused.body.error.repair), name)
    assert.ok(!(await orca.called()).some(args => args[1] === 'send'), name)
  }
})

test('the reader hook in a terminal without an injected session keeps the reader fence through pane attestation', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  walk.role('reader1')
  await walk.run('enhance', '--file', await note(walk))
  const orca = await fakeOrca(walk)
  const pane = 'tab-reader:leaf-reader'
  const local = join(run.home, '.walk-doc', run.runId, 'attempt-1', 'media', 'example.jpg')
  const cli = new URL('../scripts/cli.mjs', import.meta.url).pathname
  const hook = (overrides, harness = 'native-reader') => {
    const result = spawnSync(process.execPath, [cli, 'hook', 'pre-tool-use', '--harness', 'codex'], {
      cwd: walk.options.cwd, encoding: 'utf8', env: { ...orca.env, ORCA_TERMINAL_HANDLE: 'term_reader1', ORCA_PANE_KEY: pane, ...overrides },
      input: JSON.stringify({ session_id: harness, cwd: walk.options.cwd, tool_name: 'Read', tool_input: { file_path: local } }),
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout || 'null')?.hookSpecificOutput?.permissionDecisionReason ?? null
  }
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader1' }))
  assert.equal(hook({}), null)
  assert.deepEqual((await orca.called()).map(args => args.slice(0, 2).join(' ')), ['terminal show', 'worktree ps'])
  await orca.answer({})
  assert.equal(hook({}), null)
  assert.deepEqual(await orca.called(), [])
  const attestations = join(walk.options.env.XDG_STATE_HOME, 'ndev', 'walk-doc', 'attested')
  for (const name of await readdir(attestations)) {
    const file = join(attestations, name)
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), at: Date.now() - 31_000 }))
  }
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader_resumed' }))
  assert.match(hook({}), /not the current reader.*session_reader_resumed/)
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader_new' }))
  assert.match(hook({}, 'native-reader-new'), /not the current reader.*session_reader_new/)
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader1', runtime: 'runtime-next' }))
  assert.match(hook({}, 'native-reader-restarted'), /runtime runtime-next.*runtime-walk/)
  await orca.answer(attested({ terminal: 'term_reader1', pane, session: 'session_reader1' }))
  assert.equal(hook({}, 'native-reader-restarted'), null)
  assert.match(hook({ ORCA_PANE_KEY: '' }, 'native-reader-unpaned'), /not the current reader/)
  await orca.answer({})
  assert.match(hook({ ORCA_PANE_KEY: 'tab-reader:leaf-other' }), /not the current reader.*no fake reply/)
})

async function note(walk) {
  const file = join(walk.options.cwd, 'note.json')
  await writeFile(file, JSON.stringify({ step: 'Start', note: 'Show the working directory.' }))
  return file
}

const text = value => typeof value === 'string' && value.trim().length > 0

async function paneOwnedWalk(t) {
  const walk = await fixture(t)
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<main><h1>Install</h1><p>Open the page.</p></main>')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const { port } = server.address()
  walk.options.server = async () => ({ port, pid: 1234, identity: 'expected process' })
  walk.options.identity = async () => ({ terminal: 'term_owner', session: 'session_owner', runtime: 'runtime-walk', pane: PANE })
  const { run } = await walk.run('start', 'docs/intro.md')
  const { walkPostTool } = await import('../scripts/ndev/walk-doc.mjs')
  await walkPostTool(walk.options.cwd, { session: 'session_reader1', terminal: 'term_reader1', tool: 'browser_navigate', input: { url: run.startUrls[0] } }, walk.options)
  const orca = await fakeOrca(walk)
  const cli = new URL('../scripts/cli.mjs', import.meta.url).pathname
  const ndev = (overrides, input, ...argv) => new Promise((done, failed) => {
    const child = spawn(process.execPath, [cli, '--json', ...argv], { cwd: walk.options.cwd, env: { ...orca.env, ...overrides } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', failed)
    child.on('close', status => done({ status, stderr, body: JSON.parse(stdout || 'null') }))
    child.stdin.end(input ? JSON.stringify(input) : '')
  })
  const watcher = {
    ...attested(),
    'terminal list': { ok: true, result: { terminals: [{ handle: 'term_owner', writable: true }, { handle: 'term_other', writable: true }] } },
    'repo add': { ok: true, _meta: { runtimeId: 'runtime-walk' }, result: {} },
    'agent launch': { ok: true, _meta: { runtimeId: 'runtime-walk' }, result: { launch: { outcome: { kind: 'terminal', handle: 'term_copy' } } } },
  }
  const reviews = async () => (await walk.run('status')).run.copyReviews
  return { walk, orca, ndev, watcher, reviews }
}

test('the watcher of a pane-attested owner ticks its copy reviews on the session Orca attests for the owner terminal', async t => {
  const { walk, orca, ndev, watcher, reviews } = await paneOwnedWalk(t)
  const watch = terminal => ndev({ ORCA_TERMINAL_HANDLE: terminal, ORCA_PANE_KEY: 'tab-watch:leaf-watch' }, null, 'watch', '--session', 'native-owner', '--worktree', `path:${walk.options.cwd}`, '--once')
  await orca.answer({ ...watcher, 'worktree ps': attested({ session: 'session_intruder' })['worktree ps'] })
  const intruder = await watch('term_owner')
  assert.equal(intruder.status, 0, intruder.stderr)
  assert.equal((await reviews())[0].state, 'queued')
  await orca.answer(watcher)
  const elsewhere = await watch('term_other')
  assert.equal(elsewhere.status, 0, elsewhere.stderr)
  assert.equal((await reviews())[0].state, 'queued')
  assert.ok(!(await orca.called()).some(args => args[0] === 'worktree'))
  await orca.answer(watcher)
  const ticked = await watch('term_owner')
  assert.equal(ticked.status, 0, ticked.stderr)
  const [review] = await reviews()
  assert.equal(review.state, 'running', JSON.stringify(review))
  assert.equal(review.agentId, 'term_copy')
  const calls = await orca.called()
  assert.ok(calls.some(args => args[0] === 'terminal' && args[1] === 'show' && args.includes('term_owner')))
  assert.ok(calls.some(args => args[0] === 'agent' && args[1] === 'launch'))
})

test('the owner watcher fails with the attestation detail when Orca cannot attest the owner terminal', async t => {
  const { walk, orca, ndev, watcher, reviews } = await paneOwnedWalk(t)
  const moved = structuredClone(watcher)
  moved['terminal show'].result.terminal.leafId = 'leaf-moved'
  await orca.answer(moved)
  const refused = await ndev({ ORCA_TERMINAL_HANDLE: 'term_owner' }, null, 'watch', '--session', 'native-owner', '--worktree', `path:${walk.options.cwd}`, '--once')
  assert.equal(refused.status, 1, refused.stderr)
  assert.match(refused.body.error.message, /cannot attest the session in terminal term_owner.*leaf-moved/)
  assert.equal((await reviews())[0].state, 'queued')
})

test('session end in a pane-attested owner terminal keeps the walk and reports that it must be stopped by hand', async t => {
  const { walk, orca, ndev, watcher } = await paneOwnedWalk(t)
  await orca.answer(watcher)
  const ended = await ndev({}, { session_id: 'native-owner', cwd: walk.options.cwd, reason: 'other' }, 'hook', 'session-end', '--harness', 'claude')
  assert.equal(ended.status, 0, ended.stderr)
  assert.match(ended.body.result.native.systemMessage, /native-owner.*term_owner.*session_owner[\s\S]*ndev walk-doc stop/)
  const { run } = await walk.run('status')
  assert.equal(run.phase, 'walking')
  assert.equal(run.ownerSessionEnded.session, 'native-owner')
  const other = await ndev({ ORCA_TERMINAL_HANDLE: 'term_other' }, { session_id: 'native-other', cwd: walk.options.cwd, reason: 'other' }, 'hook', 'session-end', '--harness', 'claude')
  assert.equal(other.status, 0, other.stderr)
  assert.doesNotMatch(JSON.stringify(other.body), /walk-doc stop/)
  assert.equal((await walk.run('status')).run.ownerSessionEnded.session, 'native-owner')
  await walk.run('tip', 'Keep reading the install page')
  assert.equal((await walk.run('status')).run.ownerSessionEnded, null)
})

test('session end still releases the session when the walk step fails, then reports the walk failure', async t => {
  const { walk, orca, ndev, watcher } = await paneOwnedWalk(t)
  await orca.answer(watcher)
  const record = join(walk.options.cwd, '.neil-dev.issue-17.json')
  await writeFile(record, JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root: walk.options.cwd, repo: 'example/example', state: 'implementing', branch: 'topic', base: 'main', owner: { session: 'native-owner' } },
  }))
  const states = join(walk.options.env.XDG_STATE_HOME, 'ndev', 'walk-doc')
  const [state] = (await readdir(states)).filter(name => name.endsWith('.json'))
  await mkdir(join(states, `${state}.operation`))
  const ended = await ndev({}, { session_id: 'native-owner', cwd: walk.options.cwd, reason: 'other' }, 'hook', 'session-end', '--harness', 'claude')
  assert.equal(ended.status, 5, ended.stderr)
  assert.match(ended.body.error.message, /A Walk-doc command is using/)
  const released = JSON.parse(await readFile(record, 'utf8')).workflow
  assert.equal(released.owner, undefined)
  assert.equal(released.lastSession, 'native-owner')
})

const sentTo = (walk, terminal) => walk.effects.filter(effect => effect.kind === 'terminal send' && effect.args[3] === terminal).map(effect => effect.args[5])

test('start gives the reader the named persona and the re-record instruction only when asked', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md', '--persona', 'an SRE on a Linux laptop', '--re-record')
  assert.equal(run.persona, 'an SRE on a Linux laptop')
  assert.equal(run.reRecord, true)
  const [prompt] = sentTo(walk, 'term_reader1')
  assert.match(prompt, /Persona: an SRE on a Linux laptop/)
  assert.match(prompt, /Record every existing recording again/)
  const plain = await fixture(t)
  await plain.run('start', 'docs/intro.md')
  assert.doesNotMatch(sentTo(plain, 'term_reader1')[0], /Record every existing recording again/)
})

test('enhance saves a suggestion for the owner and the reader keeps walking', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const note = join(walk.options.cwd, 'note.json')
  await writeFile(note, JSON.stringify({ step: 'Install', note: 'Name the supported Node version.' }))
  walk.role('reader1')
  const result = await walk.run('enhance', '--file', note)
  assert.equal(result.run.phase, 'walking')
  assert.match(result.text, /Carry on/)
  assert.deepEqual(result.run.findings.map(({ code, step, actual }) => ({ code, step, actual })), [{ code: 'ENHANCE', step: 'Install', actual: 'Name the supported Node version.' }])
  assert.match(sentTo(walk, 'term_owner').at(-1), /ENHANCE #1 at Install.*Name the supported Node version/)
})

test('done stores the reader completion and sends its summary to the owner', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  walk.role('owner')
  await assert.rejects(walk.run('done', 'Owner cannot finish the reading'), /current Walk reader/)
  walk.role('reader1')
  const done = await walk.run('done', 'Read every page without a block')
  assert.equal(done.run.phase, 'done')
  assert.equal(done.run.summary, 'Read every page without a block')
  assert.match(sentTo(walk, 'term_owner').at(-1), /finished docs\/intro\.md on attempt 1\. Read every page without a block[\s\S]*ndev walk-doc finish/)
  await assert.rejects(walk.run('done', 'Again'), /is done/)
})

test('escalate sends the question and the steps tried to the human through the owner and the panel', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const finding = join(walk.options.cwd, 'finding.json')
  await writeFile(finding, JSON.stringify({ code: 'BLOCKED', step: 'Sign in', expected: 'A test account', actual: 'No account', evidence: 'Login page' }))
  const file = join(walk.options.cwd, 'escalate.json')
  await writeFile(file, JSON.stringify({ question: 'Which test account should the reader use?', tried: ['Local credentials', 'Free sign-up'] }))
  await assert.rejects(walk.run('escalate', '--file', file), /not waiting on a report/)
  walk.role('reader1')
  await walk.run('report', '--file', finding)
  await assert.rejects(walk.run('escalate', '--file', file), /owning Orca session/)
  walk.role('owner')
  const empty = join(walk.options.cwd, 'empty.json')
  await writeFile(empty, JSON.stringify({ question: 'Which account?', tried: [] }))
  await assert.rejects(walk.run('escalate', '--file', empty), /needs tried/)
  const escalated = await walk.run('escalate', '--file', file)
  assert.equal(escalated.run.phase, 'escalated')
  assert.match(escalated.text, /Which test account should the reader use\?.*Tried: Local credentials; Free sign-up/)
  assert.match(escalated.text, /Ask the person/)
  const panel = await runPane(['bridge', 'snapshot', 'walk-doc'], walk.options)
  assert.match(panel.data.status, /escalated.*Which test account should the reader use\?.*Local credentials; Free sign-up/)
})

test('tip saves advice for later readers and delivers it to the current reader', async t => {
  const walk = await fixture(t)
  await walk.run('start', 'docs/intro.md')
  const tipped = await walk.run('tip', 'The dev server needs a minute on first start.')
  assert.equal(tipped.run.agentId, 'term_reader1')
  assert.deepEqual(JSON.parse(await readFile(join(walk.options.cwd, '.walk-doc.json'), 'utf8')).tips, ['The dev server needs a minute on first start.'])
  assert.match(sentTo(walk, 'term_reader1').at(-1), /Tip for the Walk reader: The dev server needs a minute on first start\./)
  await assert.rejects(walk.run('tip', 'The dev server needs a minute on first start.'), /already in/)
  await walk.run('restart', 'Start again')
  assert.match(sentTo(walk, 'term_reader2')[0], /The dev server needs a minute on first start\./)
})

test('stop closes the reader and the server and keeps the report and the evidence', async t => {
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const evidence = join(run.home, '.walk-doc', run.runId, 'attempt-1', 'media', 'step.jpg')
  await writeFile(evidence, 'image')
  const finding = join(walk.options.cwd, 'finding.json')
  await writeFile(finding, JSON.stringify({ code: 'OMISSION', step: 'Install', expected: 'A command', actual: 'None', evidence }))
  walk.role('reader1')
  await walk.run('report', '--file', finding)
  walk.role('owner')
  const stopped = await walk.run('stop')
  assert.equal(stopped.run.phase, 'finished')
  assert.equal(stopped.run.agentId, null)
  assert.ok(walk.effects.some(effect => effect.kind === 'terminal close' && effect.args[3] === 'term_reader1'))
  assert.ok(walk.effects.some(effect => effect.kind === 'stopServer'))
  assert.match(await readFile(stopped.run.report, 'utf8'), /OMISSION[\s\S]*Install/)
  assert.equal(await readFile(evidence, 'utf8'), 'image')
  await assert.rejects(walk.run('stop'), /already finished/)
})

test('the walk-doc panel and walk-doc status show the same findings, messages, media and copy review state', async t => {
  const { walkPostTool } = await import('../scripts/ndev/walk-doc.mjs')
  const { renderPanel } = await import('../scripts/ndev/panes.mjs')
  const walk = await fixture(t)
  const { run } = await walk.run('start', 'docs/intro.md')
  const media = join(run.home, '.walk-doc', run.runId, 'attempt-1', 'media', 'install.jpg')
  await writeFile(media, 'image')
  const record = join(walk.options.cwd, 'record.json')
  await writeFile(record, JSON.stringify({ step: 'Install', file: media, mode: 'INSERT', caption: 'The install screen' }))
  await walk.run('ask', 'Which heading opened?')
  walk.role('reader1')
  await walk.run('record', '--file', record)
  await walkPostTool(walk.options.cwd, { session: 'session_reader1', terminal: 'term_reader1', tool: 'browser_navigate', input: { url: 'http://localhost:6670/intro/' } }, walk.options)
  walk.role('owner')
  const status = await walk.run('status')
  const panel = await runPane(['bridge', 'snapshot', 'walk-doc'], walk.options)
  assert.deepEqual(panel, status.snapshot)
  assert.equal(status.text, renderPanel(panel.data))
  assert.match(status.text, /#1 RECORD · Install[\s\S]*The install screen[\s\S]*install\.jpg/)
  assert.match(status.text, /#1 Which heading opened\?: Awaiting answer/)
  assert.match(status.text, /http:\/\/localhost:6670\/intro\/: queued/)
})

test('the Walk reader launches only for a Walk run and its tools stay bound to that run', async t => {
  const walk = await fixture(t)
  const launches = () => walk.effects.filter(effect => effect.kind === 'agent launch').length
  const finding = join(walk.options.cwd, 'finding.json')
  await writeFile(finding, JSON.stringify({ code: 'BUG', step: 'Start', expected: 'Open', actual: 'Closed', evidence: 'Exit 1' }))
  walk.role('reader1')
  await assert.rejects(walk.run('report', '--file', finding), /no Walk-doc run/)
  walk.role('owner')
  await assert.rejects(walk.run('restart', 'Too early'), /no Walk-doc run/)
  assert.equal(launches(), 0)
  const { run } = await walk.run('start', 'docs/intro.md')
  assert.equal(launches(), 1)
  const attempt = join(run.home, '.walk-doc', run.runId, 'attempt-1')
  walk.role('reader1')
  assert.equal((await runWalkDoc(['report', '--file', finding], { ...walk.options, cwd: attempt })).run.runId, run.runId)
  walk.role('owner')
  await walk.run('stop')
  await assert.rejects(walk.run('restart', 'After the run'), /already finished/)
  walk.role('reader1')
  await assert.rejects(runWalkDoc(['report', '--file', finding], { ...walk.options, cwd: attempt }), /already finished/)
  assert.equal(launches(), 1)
})
