import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  assert.equal(await finishWalkOnSessionEnd(walk.options.cwd, 'session_reader1', walk.options), null)
  assert.equal(walk.effects.length, before)
  const finished = await finishWalkOnSessionEnd(walk.options.cwd, 'session_owner', walk.options)
  assert.equal(finished.run.runId, start.run.runId)
  assert.equal(finished.run.phase, 'finished')
  assert.match(await readFile(finished.run.report, 'utf8'), /Walk report/)
  assert.equal(await finishWalkOnSessionEnd(walk.options.cwd, 'session_owner', walk.options), null)
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
  const tick = () => tickWalkCopy(walk.options.cwd, 'session_owner', walk.options)
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
  const tick = () => tickWalkCopy(walk.options.cwd, 'session_owner', walk.options)
  const failure = await tick()
  assert.equal(failure.state, 'failed')
  assert.match(failure.detail, /Lost response and receipt.*orca terminal list/)
  assert.equal(await tick(), null)
  assert.equal(launches, 1)
  const done = await walk.run('stop')
  assert.equal(done.run.phase, 'finished')
  assert.ok(walk.effects.some(effect => effect.kind === 'terminal close' && effect.args[3] === 'term_copy'))
})
