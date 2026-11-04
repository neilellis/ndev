import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MACHINES, fixture, fixtureWithout } from './walk-doc-fixture'

const CONFIG = fixture({ valuesFile: '.walk-values' })
const PAGE = 'Run `./acme doctor`, then edit `config/foo.json`.'

type Ran = { argv: string[]; cwd?: string; timeoutMs?: number }

function harness(on: On, opts: { readyExit?: number; root?: string } = {}) {
  const flags = { agentsEnded: [] as string[], pageHtml: '', pageExit: 0, readyAborts: false, asciinemaExit: 0, files: new Set<string>(), contents: new Map<string, string>(), configFails: false, cwdFails: false, agentRegisterFails: false, envText: '' as string | null, toplevel: opts.root ?? '/repo', worktreeList: `worktree ${opts.root ?? '/repo'}\nHEAD 1\n`, gitFails: false, spawnHeld: Promise.resolve() as Promise<void>, spawnFails: false, toolError: false, toolResult: 'ran' as unknown, overlay: 'overlay:function/true', browser: { isConnected: true } as Record<string, unknown>, config: CONFIG as string | null }
  const ran: Ran[] = []
  const written: Record<string, string> = {}
  const prompts: string[] = []
  const bash: string[] = []
  const sent: { to: unknown; text: string }[] = []
  const spawns: { prompt: string; cwd?: string; subagentType?: string; description?: string }[] = []
  const tools: string[] = []
  const agents: string[] = []
  const clock = mock.clock(on)
  on('process.run', async (_$, e) => {
    ran.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const line = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'boom', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line.includes('--show-toplevel')) return out(`${flags.toplevel}\n`, flags.gitFails ? 128 : 0)
    if (line.includes('worktree list --porcelain')) return out(flags.worktreeList, flags.gitFails ? 128 : 0)
    if (line === 'asciinema --version') return out('asciinema 3.2.1\n', flags.asciinemaExit)
    if (line.includes('socket.socket')) return out('4000\n')
    if (line.includes('nohup')) return out('4242\n')
    if (e.argv[0] === 'curl' && e.argv.includes('--silent')) return { value: { exitCode: flags.pageExit, stdout: flags.pageHtml, stderr: flags.pageExit === 0 ? '' : 'connection refused', isStdoutTruncated: false, isStderrTruncated: false } }
    if (line.includes('curl -sf')) { if (flags.readyAborts) throw new Error('$.process.run(bash) aborted'); return out('', opts.readyExit ?? 0) }
    if (line.includes('tail -n 30')) return out('Error: port in use\n')
    if (line === 'bash -c uptime') return out('18:40  up 9 days, load averages: 196.39 195.25 196.50\n')
    if (line.includes('for c in')) return out('apps/docs/content/installation/quick-start.mdx\n')
    if (line.includes('find ')) return out('apps/docs/content/installation/quick-start.mdx\n')
    return out('')
  })
  on('fs.read', async (_$, e) => {
    if (flags.contents.has(e.path)) return { value: flags.contents.get(e.path)! } as never
    if (e.path.endsWith('.walk-values')) { if (flags.envText === null) throw new Error(`ENOENT ${e.path}`); return { value: flags.envText } as never }
    if (e.path.endsWith('.walk-doc.json') && (flags.configFails || flags.config === null || e.path !== `${opts.root ?? '/repo'}/.walk-doc.json`)) throw new Error(`ENOENT ${e.path}`)
    if (flags.contents.has(e.path)) return { value: flags.contents.get(e.path)! } as never
    return { value: e.path.endsWith('.walk-doc.json') ? flags.config! : PAGE } as never
  })
  on('fs.exists', async (_$, e) => ({ value: flags.files.has(e.path) || (flags.config !== null && e.path === `${opts.root ?? '/repo'}/.walk-doc.json`) || (flags.envText !== null && e.path === `${opts.root ?? '/repo'}/.walk-values`) }) as never)
  on('fs.write', async (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('env.get', async () => ({ value: '/home/n' }) as never)
  const browser: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.connect', async (_$, e) => {
    if (flags.browser.throws !== undefined) throw new Error(String(flags.browser.throws))
    return ({ value: flags.browser.isConnected === true ? { isConnected: true, server: `plugin:ndev:${e.server}` } : flags.browser }) as never
  })
  on('mcp.call', async (_$, e) => {
    browser.push({ tool: e.tool, args: e.args })
    const text = e.tool === 'browser_evaluate' ? `### Result\n"${flags.overlay}"` : '### Ran'
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async (_$, e) => {
    tools.push(e.name)
    return { value: undefined } as never
  })
  on('agent.register', async (_$, e) => {
    if (flags.agentRegisterFails) throw new Error('agent.register refused')
    agents.push(e.name)
    return { value: undefined } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('agent.spawn', async (_$, e) => {
    if (flags.spawnFails) throw new Error('agent type ndev:walk is not available')
    spawns.push({ prompt: e.prompt, cwd: e.cwd, subagentType: e.subagentType ?? (e as unknown as { subagent_type?: string }).subagent_type, description: e.description })
    await flags.spawnHeld
    return { model: 'm', agentId: `a${spawns.length}` }
  })
  // The test kit keeps a spawn's agentId to the core, so the agent list names the spawned agents.
  on('agent.list', async () => ({ value: spawns.map((s, i) => ({ id: `a${i + 1}`, type: 'ndev:walk', description: s.description, status: flags.agentsEnded.includes(`a${i + 1}`) ? 'completed' : 'running' })) }) as never)
  on('session.send', async (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', async (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('turn.complete', () => ({ text: 'text' }) as never)
  // ndev's quality hook reads the session folder on every Bash call.
  on('session.cwd', async () => {
    if (flags.cwdFails) throw new Error('session.cwd failed')
    return { value: opts.root ?? '/repo' } as never
  })
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash') bash.push((e as { command: string }).command)
    return (flags.toolError ? { result: 'Error: NOT_FOUND', isError: true } : { result: flags.toolResult }) as never
  })
  return { bash, ran, written, prompts, sent, spawns, clock, flags, browser, tools, agents, toasts }
}

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const start = ($: Engine, cwd = '/repo') => $.session.start({ cwd, surface: null, isInteractive: true } as never)
const walkDoc = ($: Engine, args: string) => $.command.run({ command: 'walk-doc', args } as never).then(r => JSON.stringify(r))
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never).then(r => JSON.stringify(r))
const REPORT = { tool: 'mcp__ndev__walk_report', code: 'OMISSION', step: '/installation/quick-start/#install', expected: 'an install command', actual: 'none given', evidence: 'page text' }

test('/walk-doc starts the dev server on a free port and a hidden Walk agent in a workspace outside the repo', async ($, on) => {
  const h = harness(on)
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('http://localhost:4000/installation/quick-start/')
  expect(h.ran.some(r => r.argv.join(' ').includes("'pnpm' '--dir' 'apps/docs' 'dev' '-p' '4000'"))).toBe(true)
  expect(h.spawns).toHaveLength(1)
  expect(h.spawns[0]!.cwd).toMatch(/^\/home\/n\/\.walk-doc\/[^/]+\/attempt-1$/)
  expect(h.spawns[0]!.prompt).toContain('http://localhost:4000/installation/quick-start/')
})

test('a dev server that never answers refuses the run with the command, the exit code and the log tail, and is stopped', async ($, on) => {
  const h = harness(on, { readyExit: 5 })
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('not ready')
  expect(text).toContain('port in use')
  expect(text).toContain("'pnpm'")
  expect(h.spawns).toHaveLength(0)
  expect(h.ran.some(r => r.argv.join(' ') === 'kill -TERM -- -4242')).toBe(true)
})

test('the readiness check bounds each probe, so a slow first compile meets its own deadline and not the process limit', async ($, on) => {
  const h = harness(on, { readyExit: 5 })
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const check = h.ran.find(r => r.argv.join(' ').includes('curl -sf'))!
  const script = check.argv.join(' ')
  const limit = Number(/curl -sf --max-time (\d+) /.exec(script)?.[1])
  const deadline = Number(/end=\$\(\(SECONDS \+ (\d+)\)\)/.exec(script)?.[1])
  expect(limit).toBeGreaterThan(0)
  expect(deadline).toBeGreaterThanOrEqual(540)
  expect(check.timeoutMs!).toBeGreaterThan((deadline + limit + 1) * 1000)
  expect(check.timeoutMs!).toBeLessThanOrEqual(600_000)
  expect(text).toContain(`did not answer within ${deadline} s`)
  expect(text).toContain('load averages: 196.39')
})

test('the dev server polls for file changes, so a machine out of file-event watchers still rebuilds edited pages', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const line = h.ran.find(r => r.argv.join(' ').includes('nohup'))!.argv.join(' ')
  expect(line).toContain("nohup env WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=1 'pnpm' '--dir' 'apps/docs' 'dev' '-p' '4000'")
})

test('the dev server runs in its own process group, so stop and an interrupted start end every process in it', async ($, on) => {
  const h = harness(on)
  await start($)
  h.flags.readyAborts = true
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.ran.find(r => r.argv.join(' ').includes('nohup'))!.argv.join(' ')).toContain('set -m')
  expect(text).toMatch(/interrupted while the docs dev server started/)
  expect(text).toContain('/repo/walk-run/')
  expect(h.ran.some(r => r.argv.join(' ') === 'kill -TERM -- -4242')).toBe(true)
  expect(h.spawns).toHaveLength(0)
})

test('a Walk agent that fails to start stops the ready dev server, so nothing is left running', async ($, on) => {
  const h = harness(on)
  await start($)
  h.flags.spawnFails = true
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('agent.spawn')
  expect(text).toMatch(/process group 4242\) is stopped/)
  expect(h.ran.some(r => r.argv.join(' ') === 'kill -TERM -- -4242')).toBe(true)
  h.flags.spawnFails = false
  expect(await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')).toContain('started')
})

test('ending the session stops the dev server of a running walk', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  expect(h.ran.some(r => r.argv.join(' ') === 'kill -TERM -- -4242')).toBe(true)
})

test('a blocking report reaches the main agent, and CONTINUE resumes the same Walk agent', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const reported = await call($, { ...REPORT, agentId: 'a1' })
  expect(reported).toContain('End your turn')
  await h.clock.advance(0)
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('OMISSION')
  const replied = await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'Added the command', changed: ['/installation/quick-start/'] })
  expect(replied).toContain('CONTINUE sent')
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]!.to).toBe('a1')
  expect(h.sent[0]!.text).toContain('Added the command')
})

test('an ENHANCE note reaches the main agent while the Walk agent carries on, and NOTED lands in the pane only', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const told = await call($, { tool: 'mcp__ndev__walk_enhance', step: '/installation/quick-start/#install', note: 'A copy button would help', agentId: 'a1' })
  expect(told).toContain('Carry on')
  await h.clock.advance(0)
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('A copy button would help')
  const replied = await call($, { tool: 'mcp__ndev__walk_reply', action: 'NOTED', answers: 1, note: 'Added one' })
  expect(replied).toContain('NOTED')
  expect(h.sent).toHaveLength(0)
  const ui = await $.ui.mount({
    plugin: 'ndev', component: 'Pane', requestId: 'walk-doc', surface: 'terminal',
    props: { title: 'Walk', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^NOTED #1: Added one$/ })).toBeTruthy()
  await ui.unmount()
})

test('RESTART starts a fresh Walk agent in a new attempt workspace', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...REPORT, agentId: 'a1' })
  const replied = await call($, { tool: 'mcp__ndev__walk_reply', action: 'RESTART', note: 'Rewrote the page' })
  expect(replied).toContain('attempt 2')
  expect(h.spawns).toHaveLength(2)
  expect(h.spawns[1]!.cwd).toMatch(/attempt-2$/)
})

test('/walk-doc restart <note> starts a fresh reader with the person\'s note, mid-walk, and retires the old one', async ($, on) => {
  const h = harness(on)
  await start($)
  expect(await walkDoc($, 'restart')).toContain('no walk is running')
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const out = await walkDoc($, 'restart -- and capture the ./acme setup recording')
  expect(out).toContain('attempt 2')
  expect(h.spawns).toHaveLength(2)
  expect(h.spawns[1]!.cwd).toMatch(/attempt-2$/)
  expect(h.spawns[1]!.prompt).toContain('The person who runs this walk asks: and capture the ./acme setup recording')
  expect(h.sent[0]!.to).toBe('a1')
  expect(h.sent[0]!.text).toContain('STOP')
  expect(await call($, { tool: 'Bash', command: 'ls', agentId: 'a1' })).toContain('replaced')
  expect(h.bash).toHaveLength(0)
  expect(await call($, { tool: 'Read', file_path: '/repo/config/foo.json', agentId: 'a2' })).toContain('ran')
  await walkDoc($, 'restart')
  expect(h.spawns[2]!.prompt).not.toContain('The person who runs this walk asks')
})

test('walk_reply RESTART mid-walk retires the walking reader and starts a fresh one told the note', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(await call($, { tool: 'mcp__ndev__walk_reply', action: 'RESTART', note: '  ' })).toContain('needs a note')
  const replied = await call($, { tool: 'mcp__ndev__walk_reply', action: 'RESTART', note: 'Record every screen again' })
  expect(replied).toContain('attempt 2')
  expect(h.spawns).toHaveLength(2)
  expect(h.spawns[1]!.prompt).toContain('Record every screen again')
  expect(h.sent[0]!.to).toBe('a1')
  expect(h.sent[0]!.text).toContain('STOP')
  expect(await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'x' })).toContain('not waiting')
})

test('the guard keeps the Walk agent out of the source and logs the denial, and leaves the main agent alone', async ($, on) => {
  harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const denied = await call($, { tool: 'Read', file_path: '/repo/apps/ui/x.ts', agentId: 'a1' })
  expect(denied).toContain('denied')
  expect(await call($, { tool: 'Read', file_path: '/repo/config/foo.json', agentId: 'a1' })).toContain('ran')
  expect(await call($, { tool: 'Read', file_path: '/repo/apps/ui/x.ts' })).toContain('ran')
  const status = await call($, { tool: 'mcp__ndev__walk_status' })
  expect(status).toContain('apps/ui/x.ts')
})

test('the main-side tools refuse the Walk agent', async ($, on) => {
  harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'x', agentId: 'a1' })).toContain('main agent')
})

test('walk_escalate texts the person at textTo with the question', { options: { textTo: '+447700900000' } }, async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...REPORT, code: 'BLOCKED', agentId: 'a1' })
  const out = await call($, { tool: 'mcp__ndev__walk_escalate', question: 'Which API key?', tried: ['.env', 'dev mode'] })
  expect(out).toContain('Texted +447700900000')
  const text = h.ran.find(r => r.argv[0] === 'osascript')
  expect(text?.argv.at(-2)).toBe('+447700900000')
  expect(text?.argv.at(-1)).toContain('Which API key?')
})

test('walk_finish writes the report, stops the dev server and says no text was sent without textTo', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...REPORT, agentId: 'a1' })
  const out = await call($, { tool: 'mcp__ndev__walk_finish', summary: 'Fixed one omission' })
  expect(out).toContain('report.md')
  expect(out).toContain('textTo is empty')
  const report = Object.entries(h.written).find(([p]) => p.endsWith('/report.md'))
  expect(report?.[0]).toMatch(/^\/repo\/walk-run\//)
  expect(report?.[1]).toContain('OMISSION')
  expect(h.ran.some(r => r.argv.join(' ').includes('kill -TERM -- -4242'))).toBe(true)
  expect(h.ran.some(r => r.argv[0] === 'osascript')).toBe(false)
})

test('a docs-site path resolves to its page under the content root', async ($, on) => {
  const h = harness(on)
  await start($)
  const text = await walkDoc($, '/installation/quick-start/')
  expect(text).toContain('http://localhost:4000/installation/quick-start/')
  expect(h.ran.some(r => r.argv.join(' ').includes("'apps/docs/content/installation/quick-start'"))).toBe(true)
})

test('the model cannot start a Walk agent itself, so only /walk-doc spawns and resumes one', async ($, on) => {
  harness(on)
  await start($)
  expect(await call($, { tool: 'Agent', subagent_type: 'ndev:walk', description: 'x', prompt: 'x' })).toContain('/walk-doc')
  expect(await call($, { tool: 'Agent', subagent_type: 'Explore', description: 'x', prompt: 'x' })).toContain('ran')
})

test('a session started in a subfolder finds the repo root by its .walk-doc.json', async ($, on) => {
  const h = harness(on)
  await start($, '/repo/sub/dir')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('http://localhost:4000/installation/quick-start/')
  expect(h.ran.some(r => r.argv.join(' ').includes('/repo/walk-run/'))).toBe(true)
})

test('a guard that fails never blocks the main agent, and names its error to the Walk agent', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  h.flags.configFails = true
  expect(await call($, { tool: 'Read', file_path: '/repo/apps/ui/x.ts' })).toContain('ran')
  const denied = await call($, { tool: 'Read', file_path: '/repo/apps/ui/x.ts', agentId: 'a1' })
  expect(denied).toContain('guard failed')
  expect(denied).toContain('cannot read /repo/.walk-doc.json')
})

test('the spawn /walk-doc starts passes the Agent guard, while the model\'s own Walk spawn is refused', async ($, on) => {
  const h = harness(on)
  await start($)
  let release = () => {}
  h.flags.spawnHeld = new Promise<void>(r => { release = r })
  const started = walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const tick = (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout
  while (h.spawns.length === 0) await new Promise<void>(r => tick(r, 1))
  // The engine routes $.agent.spawn through the Agent tool call while the spawn is under way.
  const own = { tool: 'Agent', subagent_type: 'ndev:walk', description: h.spawns[0]!.description, prompt: h.spawns[0]!.prompt }
  expect(await call($, own)).toContain('ran')
  expect(await call($, { ...own, description: 'my own walker' })).toContain('/walk-doc')
  release()
  expect(await started).toContain('http://localhost:4000/installation/quick-start/')
  expect(await call($, own)).toContain('/walk-doc')
})

test('the pane shows the Walk report and the main agent\'s reply as bubbles, on every surface', async ($, on) => {
  harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...REPORT, agentId: 'a1' })
  await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'Added the command' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ndev', component: 'Pane', requestId: 'walk-doc', surface,
      props: { title: 'Walk', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    expect((await ui.find({ type: 'Text', text: /^Walk · OMISSION$/ }))?.text).toBe('Walk · OMISSION')
    expect((await ui.find({ type: 'Text', text: /^Main · CONTINUE$/ }))?.text).toBe('Main · CONTINUE')
    expect((await ui.find({ type: 'Text', text: /^CONTINUE #1: Added the command$/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('values in .walk-values reach the reader when it starts and with each CONTINUE', async ($, on) => {
  const h = harness(on)
  h.flags.envText = 'DOWNLOAD_USER=download\nDOWNLOAD_PASSWORD=pw1\n'
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.spawns[0]!.prompt).toContain('DOWNLOAD_PASSWORD=pw1')
  expect(h.spawns[0]!.prompt).toContain('(from /repo/.walk-values, in the main project checkout)')
  await call($, { ...REPORT, agentId: 'a1' })
  h.flags.envText = 'DOWNLOAD_USER=download\nDOWNLOAD_PASSWORD=pw2\n'
  await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'Added the login' })
  expect(h.sent[0]!.text).toContain('DOWNLOAD_PASSWORD=pw2')
  expect(h.sent[0]!.text).toContain('(from /repo/.walk-values, in the main project checkout)')
})

test('with valueKeys, the reader gets only those keys and never sees another key of the file', async ($, on) => {
  const h = harness(on)
  h.flags.config = fixture({ valuesFile: '.walk-values', valueKeys: ['DOWNLOAD_USER'] })
  h.flags.envText = 'DOWNLOAD_USER=download\nOPENAI_API_KEY=sk-secret-1234\n'
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.spawns[0]!.prompt).toContain('DOWNLOAD_USER=download')
  expect(h.spawns[0]!.prompt).not.toContain('sk-secret-1234')
  expect(h.spawns[0]!.prompt).not.toContain('OPENAI_API_KEY')
})

test('a valueKeys key the file does not set refuses the walk before the dev server starts, naming the key and the repair', async ($, on) => {
  const h = harness(on)
  h.flags.config = fixture({ valuesFile: '.walk-values', valueKeys: ['DOWNLOAD_USER', 'DEMO_PASSWORD'] })
  h.flags.envText = 'DOWNLOAD_USER=download\n'
  await start($)
  const out = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(out).toContain('DEMO_PASSWORD is not set in /repo/.walk-values')
  expect(out).not.toContain('download\n')
  expect(h.ran.some(r => r.argv.join(' ').includes('nohup'))).toBe(false)
  expect(h.spawns).toHaveLength(0)
})

test('a values file removed during a walk refuses CONTINUE with the repair for the main agent, and the run waits', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...REPORT, agentId: 'a1' })
  h.flags.envText = null
  const text = await call($, { tool: 'mcp__ndev__walk_reply', action: 'CONTINUE', note: 'Added the login' })
  expect(text).toContain('the values file .walk-values is in neither /repo nor the main project checkout /repo')
  expect(text).toContain('Then retry the call.')
  expect(text).not.toContain('run /walk-doc again')
  expect(h.sent).toHaveLength(0)
})

test('a project root reached through a symlink is still the main project checkout', async ($, on) => {
  const h = harness(on, { root: '/link' })
  h.flags.toplevel = '/real'
  h.flags.worktreeList = 'worktree /real\nHEAD 1\n'
  await start($, '/link')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('Values: /link/.walk-values, in the main project checkout.')
})

test('a worktree of a bare repository has no main project checkout, and the walk says so', async ($, on) => {
  const h = harness(on, { root: '/wt' })
  h.flags.envText = null
  h.flags.toplevel = '/wt'
  h.flags.worktreeList = 'worktree /x/bare.git\nbare\n\nworktree /wt\nHEAD 2\n'
  await start($, '/wt')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('the values file .walk-values is not in /wt, and the bare repository /x/bare.git has no main project checkout')
  expect(text).toContain('Create /wt/.walk-values')
  expect(h.spawns).toHaveLength(0)
})

test('a git failure while looking for the values file names the command and its output', async ($, on) => {
  const h = harness(on)
  h.flags.gitFails = true
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('git worktree list --porcelain failed in /repo (exit 128): boom')
  expect(h.spawns).toHaveLength(0)
})

test('a config without valuesFile asks git nothing and sends no values', async ($, on) => {
  const h = harness(on)
  h.flags.config = fixture()
  await start($)
  // The workflow reads the worktrees at session start. This test is about the walk.
  h.ran.length = 0
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.ran.some(r => r.argv.join(' ').includes('worktree list'))).toBe(false)
  expect(h.spawns[0]!.prompt).not.toContain('Values the person has given you')
})

test('a walk refuses to start when the values file is nowhere, and says how to create it', async ($, on) => {
  const h = harness(on)
  h.flags.envText = null
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('the values file .walk-values is in neither /repo nor the main project checkout /repo')
  expect(text).toContain('Create /repo/.walk-values with one KEY=VALUE per line')
  expect(h.ran.some(r => r.argv.join(' ').includes('nohup'))).toBe(false)
  expect(h.spawns).toHaveLength(0)
})

test('a walk from a worktree refuses when neither it nor the main project checkout has the values file, and names a copy in another worktree', async ($, on) => {
  const h = harness(on, { root: '/wt' })
  h.flags.envText = null
  h.flags.toplevel = '/wt'
  h.flags.worktreeList = 'worktree /main\nHEAD 1\n\nworktree /wt\nHEAD 2\n\nworktree /other\nHEAD 3\n'
  h.flags.files.add('/other/.walk-values')
  await start($, '/wt')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('the values file .walk-values is in neither /wt nor the main project checkout /main')
  expect(text).toContain("cp '/other/.walk-values' '/main/.walk-values'")
  expect(h.spawns).toHaveLength(0)
})

test('a walk from a worktree takes the values file from the main project checkout, shows where it is and tells the reader', async ($, on) => {
  const h = harness(on, { root: '/wt' })
  h.flags.envText = null
  h.flags.toplevel = '/wt'
  h.flags.worktreeList = 'worktree /main\nHEAD 1\n\nworktree /wt\nHEAD 2\n'
  h.flags.files.add('/main/.walk-values')
  h.flags.contents.set('/main/.walk-values', 'DOWNLOAD_USER=download\n')
  await start($, '/wt')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('Values: /main/.walk-values, in the main project checkout.')
  expect(h.spawns[0]!.prompt).toContain('(from /main/.walk-values, in the main project checkout)')
  expect(h.spawns[0]!.prompt).toContain('DOWNLOAD_USER=download')
})

test('a values file in the worktree is used, and the reader is told it is not the main project checkout', async ($, on) => {
  const h = harness(on, { root: '/wt' })
  h.flags.toplevel = '/wt'
  h.flags.worktreeList = 'worktree /main\nHEAD 1\n\nworktree /wt\nHEAD 2\n'
  h.flags.envText = 'DOWNLOAD_USER=download\n'
  await start($, '/wt')
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('Values: /wt/.walk-values, in this worktree, not in the main project checkout /main.')
  expect(h.spawns[0]!.prompt).toContain('(from /wt/.walk-values, in this worktree, not in the main project checkout /main)')
})

test('a Walk Bash command is recorded with asciinema, one numbered cast each, while the main agent\'s runs as typed', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { tool: 'Bash', command: 'echo one', agentId: 'a1' })
  await call($, { tool: 'Bash', command: 'echo two', agentId: 'a1' })
  await call($, { tool: 'Bash', command: 'echo main' })
  expect(h.bash[0]).toContain('asciinema rec')
  expect(h.bash[0]).toMatch(/attempt-1\/media\/001\.cast/)
  expect(h.bash[1]).toMatch(/attempt-1\/media\/002\.cast/)
  expect(h.bash[2]).toBe('echo main')
})

test('a Walk agent reads its own saved tool output, and no other saved output', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const saved = '/home/n/.claude/projects/p/s1/tool-results/b1.txt'
  h.flags.toolResult = { stdout: 'too long', stderr: '', interrupted: false, persistedOutputPath: saved }
  await call($, { tool: 'Bash', command: 'ls -R /', agentId: 'a1' })
  h.flags.toolResult = 'ran'
  expect(await call($, { tool: 'Read', file_path: saved, agentId: 'a1' })).not.toContain('deny')
  expect(await call($, { tool: 'Read', file_path: '/home/n/.claude/projects/p/s1/tool-results/b2.txt', agentId: 'a1' })).toContain('~/.claude')
})

test('saved output from the main agent stays closed to the Walk agent', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const saved = '/home/n/.claude/projects/p/s1/tool-results/b3.txt'
  h.flags.toolResult = { stdout: 'source', stderr: '', interrupted: false, persistedOutputPath: saved }
  await call($, { tool: 'Bash', command: 'cat apps/ui/x.ts' })
  h.flags.toolResult = 'ran'
  expect(await call($, { tool: 'Read', file_path: saved, agentId: 'a1' })).toContain('~/.claude')
})

test('walk_record sends the main agent a recording to place while the reader carries on, and refuses a file that is not there', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const ws = h.spawns[0]!.cwd!
  const missing = await call($, { tool: 'mcp__ndev__walk_record', step: '/installation/quick-start/#install', file: `${ws}/media/001.cast`, mode: 'INSERT', caption: 'The install', agentId: 'a1' })
  expect(missing).toContain('no file at')
  expect(h.prompts).toHaveLength(0)
  h.flags.files.add(`${ws}/media/001.cast`)
  h.flags.contents.set(`${ws}/media/001.cast`, LIVE_CAST)
  const told = await call($, { tool: 'mcp__ndev__walk_record', step: '/installation/quick-start/#install', file: `${ws}/media/001.cast`, mode: 'INSERT', caption: 'The install', agentId: 'a1' })
  expect(told).toContain('Carry on')
  await h.clock.advance(0)
  expect(h.prompts[0]).toContain('RECORD #1')
  expect(h.sent).toHaveLength(0)
})

const LIVE_CAST = ['{"version":3}', '[0.5, "o", "GitHub login: "]', '[1.2, "o", "neilellis\\r\\n"]', '[0.4, "x", "0"]'].join('\n')

test('walk_record refuses a recording that is not a real one, names each problem and how to record it again', async ($, on) => {
  const h = harness(on)
  h.flags.envText = 'GITHUB_PAT_TOKEN=ghp_secret123\n'
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const ws = h.spawns[0]!.cwd!
  const record = (n: string) => call($, { tool: 'mcp__ndev__walk_record', step: 's', file: `${ws}/media/${n}.cast`, mode: 'INSERT', caption: 'The setup', agentId: 'a1' })
  const put = (n: string, cast: string, script: string) => {
    h.flags.files.add(`${ws}/media/${n}.cast`); h.flags.contents.set(`${ws}/media/${n}.cast`, cast)
    h.flags.files.add(`${ws}/media/${n}.sh`); h.flags.contents.set(`${ws}/media/${n}.sh`, script)
  }
  put('020', '{"version":3}\n[75.9, "o", "the whole wizard at once"]\n[0.0, "x", "0"]', "GHCR_TOKEN=ghp_secret123 expect setup.exp 2>&1 | sed -n '/Review/,$p' | tail -30")
  const refused = await record('020')
  expect(refused).toContain('020.cast is not a real recording')
  expect(refused).toContain('one chunk')
  expect(refused).toContain('filters its output through sed')
  expect(refused).toContain('holds the value of GITHUB_PAT_TOKEN')
  expect(refused).not.toContain('ghp_secret123')
  expect(refused).toContain('Record it again')
  put('021', LIVE_CAST, 'expect setup.exp > setup.log')
  expect(await record('021')).toContain('sends its output to a file')
  put('022', LIVE_CAST, 'GITHUB_PAT_TOKEN="$(cat token)" expect setup.exp')
  expect(await record('022')).toContain('Carry on')
  await h.clock.advance(0)
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('022.cast')
})

test('/walk-doc refuses to start without asciinema and names the install command', async ($, on) => {
  const h = harness(on)
  h.flags.asciinemaExit = 127
  await start($)
  const out = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(out).toContain('brew install asciinema')
  expect(h.spawns).toHaveLength(0)
})

test('/walk-doc refuses to start when the browser lacks the cursor and arrow overlay, names the repair and stops the dev server', async ($, on) => {
  const h = harness(on)
  h.flags.overlay = 'overlay:undefined/false'
  await start($)
  const out = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(out).toContain('/mcp')
  expect(out).toContain('overlay:undefined/false')
  expect(h.spawns).toHaveLength(0)
  expect(h.ran.some(r => r.argv.join(' ').includes('kill -TERM -- -4242'))).toBe(true)
})

test('/walk-doc refuses before the dev server starts when the Playwright server is not connected, with the host\'s reason and the /mcp repair', async ($, on) => {
  const h = harness(on)
  h.flags.browser = { isConnected: false, reason: 'failed', message: 'The MCP server "plugin:ndev:playwright" did not connect: connection timed out after 30000ms.' }
  await start($)
  const out = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(out).toContain('plugin:ndev:playwright is not connected (failed)')
  expect(out).toContain('connection timed out after 30000ms')
  expect(out).toContain('Run /mcp, reconnect plugin:ndev:playwright')
  expect(out).not.toContain('lacks the cursor')
  expect(h.ran.some(r => r.argv.join(' ').includes('nohup'))).toBe(false)
  expect(h.browser).toHaveLength(0)
  expect(h.spawns).toHaveLength(0)
})

test('/walk-doc names the walk browser and the /mcp repair when connecting it throws', async ($, on) => {
  const h = harness(on)
  h.flags.browser = { throws: 'spawn npx ENOENT' }
  await start($)
  const out = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(out).toContain('the walk browser plugin:ndev:playwright did not connect: ')
  expect(out).toContain('Run /mcp, reconnect plugin:ndev:playwright')
  expect(h.ran.some(r => r.argv.join(' ').includes('nohup'))).toBe(false)
})

test('/walk-doc tip "text" sends the running reader the tip it saved, without the quotes', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(await walkDoc($, 'tip "Use the staging URL"')).toContain('Sent to the reader')
  expect(JSON.parse(h.written['/repo/.walk-doc.json']!).tips).toEqual(['Use the staging URL'])
  expect(h.sent.at(-1)!.text).toContain('TIP from the person who runs this walk: Use the staging URL\n')
})

test('/walk-doc checks the overlay in the browser before the reader starts', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.browser.map(c => c.tool)).toEqual(['browser_navigate', 'browser_evaluate'])
  expect(h.spawns).toHaveLength(1)
})

test('a reader click needs a walkArrow pointing at it first, and each arrow covers one click', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const browser = (name: string) => `mcp__plugin_ndev_playwright__${name}`
  const click = (agentId?: string) => call($, { tool: browser('browser_click'), element: 'Sign in button', ref: 'e5', ...(agentId ? { agentId } : {}) })
  const evaluate = (fn: string) => call($, { tool: browser('browser_evaluate'), function: fn, agentId: 'a1' })
  const point = "() => walkArrow.point('text=Sign in', { text: 'Click Sign in', untilClick: true })"
  expect(await click('a1')).toContain('walkArrow.point')
  await evaluate(point)
  await h.clock.advance(3000)
  expect(await click('a1')).not.toContain('deny')
  expect(await click('a1')).toContain('deny')
  await evaluate("() => walkArrow.point('text=Sign in', { text: 'Signed in', duration: 3000 })")
  expect(await click('a1')).toContain('deny')
  await evaluate(point)
  await h.clock.advance(3000)
  await evaluate('() => walkArrow.stop()')
  expect(await click('a1')).toContain('deny')
  await evaluate(point)
  await h.clock.advance(3000)
  await call($, { tool: browser('browser_navigate'), url: 'http://localhost:4000/', agentId: 'a1' })
  expect(await click('a1')).toContain('deny')
  h.flags.toolError = true
  await evaluate(point)
  h.flags.toolError = false
  await h.clock.advance(3000)
  expect(await click('a1')).toContain('deny')
  expect(await click()).not.toContain('deny')
})

test('a reader click waits for the arrow caption to be readable', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const browser = (name: string) => `mcp__plugin_ndev_playwright__${name}`
  const click = () => call($, { tool: browser('browser_click'), element: 'Sign in button', ref: 'e5', agentId: 'a1' })
  await call($, { tool: browser('browser_evaluate'), function: "() => walkArrow.point('text=Sign in', { text: 'Click Sign in', untilClick: true })", agentId: 'a1' })
  const early = await click()
  expect(early).toContain('deny')
  expect(early).toContain('browser_wait_for')
  expect(early).toMatch(/2650 ms/)
  await h.clock.advance(2000)
  expect(await click()).toMatch(/650 ms/)
  await h.clock.advance(650)
  expect(await click()).not.toContain('deny')
})

test('walk_ask sends the main agent\'s question to the reader, and walk_answer brings the answer back to the main agent and the pane', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(await call($, { tool: 'mcp__ndev__walk_ask', question: 'x', agentId: 'a1' })).toContain('main agent')
  expect(await call($, { tool: 'mcp__ndev__walk_ask', question: ' ' })).toContain('question')
  const asked = await call($, { tool: 'mcp__ndev__walk_ask', question: 'Please record ./acme setup as a cast' })
  expect(asked).toContain('ASK #1 sent')
  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]!.to).toBe('a1')
  expect(h.sent[0]!.text).toContain('Please record ./acme setup as a cast')
  expect(h.sent[0]!.text).toMatch(/walk_answer[^\n]*asks: 1/)
  expect(await call($, { tool: 'mcp__ndev__walk_answer', asks: 1, answer: 'x' })).toContain('Walk agent')
  expect(await call($, { tool: 'mcp__ndev__walk_answer', asks: 9, answer: 'x', agentId: 'a1' })).toContain('no question #9')
  const answered = await call($, { tool: 'mcp__ndev__walk_answer', asks: 1, answer: 'Sent it as RECORD #1', agentId: 'a1' })
  expect(answered).toContain('Sent')
  await h.clock.advance(0)
  expect(h.prompts).toHaveLength(1)
  expect(h.prompts[0]).toContain('ANSWER #1')
  expect(h.prompts[0]).toContain('Sent it as RECORD #1')
  expect(await call($, { tool: 'mcp__ndev__walk_answer', asks: 1, answer: 'again', agentId: 'a1' })).toContain('already answered')
  const ui = await $.ui.mount({
    plugin: 'ndev', component: 'Pane', requestId: 'walk-doc', surface: 'terminal',
    props: { title: 'Walk', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^Main · ASK$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Walk · ANSWER$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^ASK #1: Please record \.\/acme setup as a cast$/ })).toBeTruthy()
  await ui.unmount()
})

test('walk_ask refuses when no walk is running', async ($, on) => {
  harness(on)
  await start($)
  expect(await call($, { tool: 'mcp__ndev__walk_ask', question: 'Anyone there?' })).toContain('no walk is running')
})

test('/walk-doc ask <question> sends the person\'s question to the reader, as walk_ask does', async ($, on) => {
  const h = harness(on)
  await start($)
  expect(await walkDoc($, 'ask Anyone there?')).toContain('no walk is running')
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(await walkDoc($, 'ask   ')).toContain('Usage: /walk-doc ask <question>')
  const asked = await walkDoc($, 'ask Please record the install step')
  expect(asked).toContain('ASK #1 sent')
  expect(h.sent[0]!.to).toBe('a1')
  expect(h.sent[0]!.text).toContain('ASK #1 from the main agent: Please record the install step')
})

test('/walk-doc tip <text> adds the tip to .walk-doc.json and sends it to the running reader; a new reader is told every tip', async ($, on) => {
  const h = harness(on)
  await start($)
  const saved = await walkDoc($, 'tip The installer can reach GHCR.')
  expect(saved).toContain('Saved')
  expect(saved).toContain('No walk is running')
  const file = h.written['/repo/.walk-doc.json']!
  expect(JSON.parse(file).tips).toEqual(['The installer can reach GHCR.'])
  h.flags.contents.set('/repo/.walk-doc.json', file)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.spawns[0]!.prompt).toContain('Tips from the person who runs this walk:\n- The installer can reach GHCR.')
  const out = await walkDoc($, 'tip -- Use OrbStack.')
  expect(out).toContain('Sent to the reader')
  expect(h.sent.at(-1)!.to).toBe('a1')
  expect(h.sent.at(-1)!.text).toContain('TIP from the person who runs this walk: Use OrbStack.')
  expect(JSON.parse(h.written['/repo/.walk-doc.json']!).tips).toEqual(['The installer can reach GHCR.', 'Use OrbStack.'])
  expect(await walkDoc($, 'tip')).toContain('Usage: /walk-doc tip')
})

test('a project without .walk-doc.json gets no reader or walk tools, and /walk-doc names the file with an example', async ($, on) => {
  const h = harness(on)
  h.flags.config = null
  await start($)
  expect(h.agents).not.toContain('walk')
  expect(h.tools.filter(t => t.startsWith('walk_'))).toEqual([])
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('/repo/.walk-doc.json')
  expect(text).toMatch(/for example \{\\"devCommand\\"/)
  expect(h.spawns).toHaveLength(0)
})

test('a project with .walk-doc.json gets the reader and its ten tools', async ($, on) => {
  const h = harness(on)
  await start($)
  expect(h.agents).toContain('walk')
  expect(h.tools.filter(t => t.startsWith('walk_'))).toHaveLength(10)
})

test('/walk-doc refuses a config without a required key, naming the key, the file and an example value', async ($, on) => {
  const h = harness(on)
  h.flags.config = fixtureWithout('media')
  await start($)
  const text = await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(text).toContain('media is missing in /repo/.walk-doc.json')
  expect(text).toContain('for example \\"media\\": ')
  expect(h.spawns).toHaveLength(0)
  expect(h.ran.some(r => r.argv.join(' ').includes('nohup'))).toBe(false)
})

test('the configured persona and machines guide reach the reader, and finish runs the machines cleanup for this walk', async ($, on) => {
  const h = harness(on)
  h.flags.config = fixture({ persona: 'an SRE on a Linux laptop', machines: MACHINES })
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const prompt = h.spawns[0]!.prompt
  expect(prompt).toContain('You are an SRE on a Linux laptop.')
  expect(prompt).toContain(MACHINES.guide[0])
  const name = /name it (walk-[^ ]+-1)\./.exec(prompt)?.[1]
  expect(name).toBeTruthy()
  await call($, { tool: 'mcp__ndev__walk_finish', summary: 'Done' })
  const prefix = name!.replace(/1$/, '')
  expect(h.ran.some(r => r.argv.join(' ') === `bash -c vm list | grep "^${prefix}" | xargs -r vm delete`)).toBe(true)
})

test('without machines no cleanup runs and the reader is told of no machine', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  expect(h.spawns[0]!.prompt).not.toMatch(/name it walk-/)
  expect(h.spawns[0]!.prompt).toContain('You are a competent developer who has never seen this project before.')
  await call($, { tool: 'mcp__ndev__walk_finish', summary: 'Done' })
  expect(h.ran.some(r => /orb|docker|vm /.test(r.argv.join(' ')))).toBe(false)
})

test('walk_done hands the main agent the configured finish duties', async ($, on) => {
  const h = harness(on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { tool: 'mcp__ndev__walk_done', summary: 'All worked', agentId: 'a1' })
  await h.clock.advance(1)
  const told = h.prompts.at(-1)!
  expect(told).toContain('- node scripts/check-docs.mjs')
  expect(told).toContain('Then call walk_finish with a summary.')
  expect(told).not.toMatch(/docs map|wiki/)
})

test('a failing ndev Bash hook never lets a reader command run unguarded: it is refused with the cause, and the main agent still runs', async ($, on) => {
  const h = harness(on)
  h.flags.cwdFails = true
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  const refused = await call($, { tool: 'Bash', command: 'echo one', agentId: 'a1' })
  expect(refused).toContain('the guard failed')
  expect(refused).toContain('session.cwd')
  expect(h.bash.some(c => c.includes('echo one'))).toBe(false)
  await call($, { tool: 'Bash', command: 'echo main' })
  expect(h.bash).toContain('echo main')
})

test('a walk-doc failure at session start is shown and named, and the rest of ndev still starts', async ($, on) => {
  const h = harness(on)
  h.flags.agentRegisterFails = true
  await start($)
  expect(h.toasts.some(t => t.startsWith('walk-doc did not start') && t.includes('agent.register') && t.includes('new session'))).toBe(true)
  expect(h.agents).not.toContain('walk')
  // ndev's own start went on: the init-project hook ran after walk-doc.
  expect(h.ran.some(r => r.argv.join(' ').includes('rev-parse'))).toBe(true)
})

// The copy editor: each docs page that the reader opens goes to it once, and its findings reach the main agent.
const PAGE_HTML = '<html><head><style>a{}</style><script>var x=1</script></head><body><nav>Sidebar</nav><main><h1>Every read, <em>with the account.</em></h1><p>Fish &amp; chips.</p></main></body></html>'
const OPEN = { tool: 'mcp__plugin_ndev_playwright__browser_navigate', url: 'http://localhost:4000/installation/quick-start/', agentId: 'a1' }
const editors = (h: { spawns: { subagentType?: string; prompt: string }[] }) => h.spawns.filter(s => s.subagentType === 'ndev:copy-editor')

// The plugin fetches the page in the background, so the reader does not wait for it.
const copySent = async (h: { clock: { advance(ms: number): Promise<unknown> } }) => {
  for (let i = 0; i < 30; i++) {
    await h.clock.advance(0)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function pageServed(h: ReturnType<typeof harness>, _on: On, html = PAGE_HTML, exitCode = 0) {
  h.flags.pageHtml = html
  h.flags.pageExit = exitCode
}

test('a docs page the reader opens goes once to the copy editor, as its text only', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await call($, { ...OPEN, url: 'http://localhost:4000/installation/quick-start/#install' })
  await copySent(h)
  expect(editors(h)).toHaveLength(1)
  const file = Object.keys(h.written).find(p => p.includes('/copy/'))!
  expect(h.written[file]).toContain('# Every read, with the account.')
  expect(h.written[file]).toContain('Fish & chips.')
  expect(h.written[file]).not.toContain('var x=1')
  expect(h.written[file]).not.toContain('Sidebar')
  expect(editors(h)[0]!.prompt).toContain(file)
  expect(editors(h)[0]!.prompt).toContain('http://localhost:4000/installation/quick-start/')
})

test('an image, the product and a page of another site do not go to the copy editor', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, { ...OPEN, url: 'http://localhost:4000/screenshots/a.png' })
  await call($, { ...OPEN, url: 'http://localhost:8080/overview' })
  await call($, { ...OPEN, url: 'https://example.com/' })
  await copySent(h)
  expect(editors(h)).toHaveLength(0)
})

test('the findings of the copy editor reach the main agent as a COPY note that NOTED answers, and the reader is not stopped', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nHeading: "Every read" is a slogan.' } as never)
  await copySent(h)
  const told = h.prompts.find(p => p.includes('COPY'))!
  expect(told).toContain('is a slogan')
  expect(told).toContain('http://localhost:4000/installation/quick-start/')
  expect(h.sent.filter(s => s.to === 'a1')).toHaveLength(0)
  const status = JSON.parse(JSON.parse(await call($, { tool: 'mcp__ndev__walk_status' })).result)
  expect(status.findings[0].code).toBe('COPY')
  expect(status.phase).toBe('walking')
  const replied = await call($, { tool: 'mcp__ndev__walk_reply', action: 'NOTED', answers: 1, note: 'Rewrote the heading' })
  expect(replied).not.toContain('deny')
})

test('a page with nothing to change adds no finding, and the review stays on the record', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 0' } as never)
  await copySent(h)
  expect(h.prompts.filter(p => p.includes('COPY'))).toHaveLength(0)
  const status = JSON.parse(JSON.parse(await call($, { tool: 'mcp__ndev__walk_status' })).result)
  expect(status.findings).toHaveLength(0)
  expect(status.copyReviews[0].state).toBe('answered')
})

test('a Vale that did not run is told to the main agent, even with no other finding', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: not run: E201 no styles\nFINDINGS: 0' } as never)
  await copySent(h)
  expect(h.prompts.find(p => p.includes('COPY'))).toContain('E201')
})

test('a page that cannot be fetched is told to the main agent with the URL, the exit code and the repair', async ($, on) => {
  const h = harness(on)
  pageServed(h, on, '', 7)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  expect(editors(h)).toHaveLength(0)
  const told = h.prompts.find(p => p.includes('copy editor'))!
  expect(told).toContain('http://localhost:4000/installation/quick-start/')
  expect(told).toContain('exit 7')
  expect(told).toContain('ndev:copy-editor')
})

test('walk_finish waits for a copy editor that still runs, and names the page', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  const refused = await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })
  expect(refused).toContain('copy editor')
  expect(refused).toContain('http://localhost:4000/installation/quick-start/')
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 0' } as never)
  expect(await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })).toContain('Walk finished')
})

// The copy reviews end on their own time, so nothing here may stall the walk or lose an answer.
const OPEN2 = { ...OPEN, url: 'http://localhost:4000/using/overview/' }
const statusOf = async ($: Parameters<typeof call>[0]) => JSON.parse(JSON.parse(await call($, { tool: 'mcp__ndev__walk_status' })).result)

test('after a refused walk_finish, a clean last answer wakes the main agent', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  await call($, { tool: 'mcp__ndev__walk_done', summary: 'All worked', agentId: 'a1' })
  expect(await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })).toContain('copy editor')
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 0' } as never)
  await copySent(h)
  expect(h.prompts.join('\n')).toContain('Every copy review has ended')
})

test('a clean answer before the reader has finished does not disturb the main agent', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 0' } as never)
  await copySent(h)
  expect(h.prompts.join('\n')).not.toContain('Every copy review has ended')
})

test('an editor that ended with no answer does not hold walk_finish, and the finish names the page', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  const refused = await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })
  expect(refused).toContain('call walk_finish again')
  h.flags.agentsEnded.push('a2')
  const finished = await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })
  expect(finished).toContain('Walk finished')
  expect(finished).toContain('had no copy review')
  expect(finished).toContain('http://localhost:4000/installation/quick-start/')
  expect(finished).toContain('ndev:copy-editor')
})

test('a page still being sent holds walk_finish, and /walk-doc stop settles it as lost', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  let release = () => {}
  h.flags.spawnHeld = new Promise<void>(r => { release = r })
  await call($, OPEN)
  await copySent(h)
  expect(await call($, { tool: 'mcp__ndev__walk_finish', summary: 'done' })).toContain('still reviews')
  const stopped = await walkDoc($, 'stop')
  expect(stopped).toContain('had no copy review')
  const report = Object.entries(h.written).find(([p]) => p.endsWith('/report.md'))![1]
  expect(report).toContain('quick-start/: lost')
  release()
  await copySent(h)
})

test('an answer is kept when the project config cannot be read', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  h.flags.configFails = true
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nA slogan.' } as never)
  await copySent(h)
  h.flags.configFails = false
  expect(h.prompts.join('\n')).toContain('A slogan')
  expect((await statusOf($)).findings[0].code).toBe('COPY')
})

test('two editors that end together keep both findings, with their own numbers', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await call($, OPEN2)
  await copySent(h)
  await Promise.all([
    $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nFirst.' } as never),
    $.turn.complete({ reason: 'end', agentId: 'a3', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nSecond.' } as never),
  ])
  await copySent(h)
  const { findings } = await statusOf($)
  expect(findings.map((f: { n: number }) => f.n)).toEqual([1, 2])
  expect(findings.map((f: { actual: string }) => f.actual.split('\n').at(-1)).sort()).toEqual(['First.', 'Second.'])
})

test('an answer that arrives during a restart survives the restart', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await call($, OPEN)
  await copySent(h)
  let release = () => {}
  h.flags.spawnHeld = new Promise<void>(r => { release = r })
  const restarted = walkDoc($, 'restart')
  await copySent(h)
  await $.turn.complete({ reason: 'end', agentId: 'a2', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nA slogan.' } as never)
  await copySent(h)
  release()
  await restarted
  const status = await statusOf($)
  expect(status.findings.map((f: { code: string }) => f.code)).toEqual(['COPY'])
  expect(status.copyReviews[0].state).toBe('answered')
})

test('a page that the reader reached with a click goes to the copy editor', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  h.flags.toolResult = '### Ran\n### Page\n- Page URL: http://localhost:4000/using/overview/\n- Page Title: The overview'
  await call($, { tool: 'mcp__plugin_ndev_playwright__browser_evaluate', function: "() => walkArrow.point('text=Overview', { text: 'Click Overview', untilClick: true })", agentId: 'a1' })
  await h.clock.advance(3000)
  await call($, { tool: 'mcp__plugin_ndev_playwright__browser_click', element: 'Overview link', ref: 'e12', agentId: 'a1' })
  await copySent(h)
  expect(editors(h)).toHaveLength(1)
  expect(editors(h)[0]!.prompt).toContain('http://localhost:4000/using/overview/')
})

test('two calls of the reader for one page start one editor', async ($, on) => {
  const h = harness(on)
  pageServed(h, on)
  await start($)
  await walkDoc($, 'apps/docs/content/installation/quick-start.mdx')
  await Promise.all([call($, OPEN), call($, OPEN)])
  await copySent(h)
  expect(editors(h)).toHaveLength(1)
})
