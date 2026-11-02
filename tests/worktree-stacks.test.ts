import { expect, test } from 'claude-code/testing'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]

const ROOT = '/proj'
const RECORD = `${ROOT}/.neil-dev.worktree.json`
const CONFIG = `${ROOT}/.neil-dev.json`
const ok = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const stack = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'supabase', projectId: id, workdir: `${ROOT}/app`, cliVersion: '2.122.0', addedAt: '2026-10-30T10:00:00.000Z', ...extra,
})
const withServers = (servers: Record<string, unknown>, ...stacks: unknown[]) =>
  JSON.stringify({ version: 2, resources: { docker: stacks, 'dev-servers': servers } })
const record = (...stacks: unknown[]) => withServers({}, ...stacks)
const devServer = (pid: number, port: number, extra: Record<string, unknown> = {}) => ({
  pid, port, command: 'node next dev', cwd: `${ROOT}/apps/docs`, started: '2026-10-30T10:00:00.000Z', ...extra,
})

// A fake engine: a git worktree at /proj. `files` holds the worktree record and .neil-dev.json;
// `script` is what worktree-env.sh does when run.
const engine = (on: On, opts: { files?: Record<string, string>; script?: { exitCode: number; stdout?: string; stderr?: string } } = {}) => {
  const files = new Map(Object.entries({ [`${ROOT}/.ndev-inited`]: '', ...opts.files }))
  const ran: { argv: readonly string[]; cwd?: string }[] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => e)
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') || files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push({ argv: e.argv, cwd: e.init?.cwd })
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-parse') return ok(`${ROOT}\n`)
    if (e.argv[0] === 'git' && e.argv[1] === 'check-ignore') return ok('x\n')
    if (e.argv[0] === 'bash' && String(e.argv[1]).endsWith('scripts/work/worktree-env.sh')) {
      const s = opts.script ?? { exitCode: 0, stdout: 'worktree-env: stopping the stacks of /proj in the background, pid 77; log /proj/.git/ndev-worktree-stop.log\n' }
      return ok(s.stdout ?? '', s.exitCode, s.stderr ?? '')
    }
    if (e.argv[0] === 'node') return ok(JSON.stringify({ file: null, copiedFrom: null, root: ROOT, main: ROOT, ignored: true, keys: [], missing: [] }))
    return ok('', 1, 'not faked')
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('dismissed')
  })
  return { files, ran, toasts }
}

const start = async ($: Dollar) => {
  await $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive: false })
  await new Promise(resolve => setTimeout(resolve, 50))
}
const end = ($: Dollar, reason = 'prompt_input_exit') => $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)

const stops = (ran: { argv: readonly string[] }[]) => ran.filter(r => r.argv[0] === 'bash' && String(r.argv[1]).endsWith('scripts/work/worktree-env.sh'))

const section = async ($: Dollar) => {
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  return sections.find(s => s.id === 'ndev:worktree-stacks')?.text
}

test('a session end in a worktree with a listed stack starts the background stop, stop-and-delete by default', async ($, on) => {
  const { ran } = engine(on, { files: { [RECORD]: record(stack('fcc-211')) } })
  await start($)
  await end($)

  expect(stops(ran)).toHaveLength(1)
  expect(stops(ran)[0]!.argv.slice(2)).toEqual(['stop-all', '--background', '--on-end', 'stop-and-delete', '--worktree', ROOT])
})

test('the project file can keep the data: worktreeStacks.onSessionEnd stop-keep-data', async ($, on) => {
  const { ran } = engine(on, {
    files: { [RECORD]: record(stack('fcc-211')), [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'stop-keep-data' } }) },
  })
  await start($)
  await end($)

  expect(stops(ran)[0]!.argv).toContain('stop-keep-data')
})

test('keep-running stops nothing and says the stacks are left running', async ($, on) => {
  const { ran, toasts } = engine(on, {
    files: { [RECORD]: record(stack('fcc-211')), [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'keep-running' } }) },
  })
  await start($)
  await end($)

  expect(stops(ran)).toHaveLength(0)
  expect(toasts.join(' ')).toContain('fcc-211')
  expect(toasts.join(' ')).toContain('keep-running')
})

test('no record, or a record with no stacks: nothing runs', async ($, on) => {
  const { ran, files } = engine(on)
  await start($)
  await end($)
  expect(stops(ran)).toHaveLength(0)

  files.set(RECORD, record())
  await end($)
  expect(stops(ran)).toHaveLength(0)
})

test('a /clear or a resume is not the end of the work in this worktree: nothing is stopped', async ($, on) => {
  const { ran } = engine(on, { files: { [RECORD]: record(stack('fcc-211')) } })
  await start($)
  await end($, 'clear')
  await end($, 'resume')

  expect(stops(ran)).toHaveLength(0)
})

test('a stop that did not start: the toast names the exit code, the output and the repair command', async ($, on) => {
  const { toasts } = engine(on, {
    files: { [RECORD]: record(stack('fcc-211')) },
    script: { exitCode: 2, stderr: 'worktree-env: /proj/.neil-dev.worktree.json is not valid JSON' },
  })
  await start($)
  await end($)

  const text = toasts.join(' ')
  expect(text).toContain('exited 2')
  expect(text).toContain('is not valid JSON')
  expect(text).toContain('worktree-env.sh stop-all --worktree /proj --on-end stop-and-delete')
})

test('a project file with an error: nothing is stopped, and the toast names the error and the repair', async ($, on) => {
  const { ran, toasts } = engine(on, {
    files: { [RECORD]: record(stack('fcc-211')), [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'nuke' } }) },
  })
  await start($)
  expect(toasts.join(' ')).toContain('stop-and-delete, stop-keep-data or keep-running')
  await end($)

  expect(stops(ran)).toHaveLength(0)
  const text = toasts.join(' ')
  expect(text).toContain('fcc-211')
  expect(text).toContain('worktree-env.sh stop-all --worktree /proj')
})

test('a stop that failed at the last session end is reported at the next start, with the repair', async ($, on) => {
  const failed = stack('fcc-211', {
    lastStop: {
      at: '2026-10-30T11:00:00.000Z',
      command: 'npx -y supabase@2.122.0 stop --project-id fcc-211 --no-backup',
      exitCode: 1,
      output: 'Error response from daemon: cannot stop container supabase_db_fcc-211',
      repair: 'npx -y supabase@2.122.0 stop --project-id fcc-211 --no-backup',
    },
  })
  const { toasts } = engine(on, { files: { [RECORD]: record(failed, stack('fcc-212')) } })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('fcc-211')
  expect(text).toContain('exit code 1')
  expect(text).toContain('cannot stop container supabase_db_fcc-211')
  expect(text).toContain('npx -y supabase@2.122.0 stop --project-id fcc-211 --no-backup')
  expect(text).toContain('remove-stack --kind supabase --project-id fcc-211')
  expect(text).not.toMatch(/fcc-212 \(workdir[^\n]*did not stop/)
  expect(toasts.join(' ')).toContain('fcc-211')
})

test('a worktree whose stacks all stopped gets no section', async ($, on) => {
  engine(on, { files: { [RECORD]: record() } })
  await start($)

  expect(await section($)).toBeUndefined()
})

// A stop that never started (a launch failure or a config error at the last exit) leaves the
// stacks listed with no lastStop: the next session is told, so they are not forgotten.
test('stacks still listed at session start are named with the stop command', async ($, on) => {
  engine(on, { files: { [RECORD]: record(stack('fcc-212')) } })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('fcc-212')
  expect(text).toContain('worktree-env.sh stop-all --worktree /proj')
})

test('with keep-running, stacks still listed are expected and get no section', async ($, on) => {
  engine(on, { files: { [RECORD]: record(stack('fcc-212')), [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'keep-running' } }) } })
  await start($)

  expect(await section($)).toBeUndefined()
})

test('a session end with only dev servers listed starts the background stop', async ($, on) => {
  const { ran } = engine(on, { files: { [RECORD]: withServers({ docs: devServer(4242, 3000) }) } })
  await start($)
  await end($)

  expect(stops(ran)).toHaveLength(1)
  expect(stops(ran)[0]!.argv.slice(2)).toEqual(['stop-all', '--background', '--on-end', 'stop-and-delete', '--worktree', ROOT])
})

test('keep-running still stops the dev servers: the stop runs with --on-end keep-running, and the toast names the stacks left running', async ($, on) => {
  const { ran, toasts } = engine(on, {
    files: {
      [RECORD]: withServers({ docs: devServer(4242, 3000) }, stack('fcc-211')),
      [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'keep-running' } }),
    },
  })
  await start($)
  await end($)

  expect(stops(ran)).toHaveLength(1)
  expect(stops(ran)[0]!.argv.slice(2)).toEqual(['stop-all', '--background', '--on-end', 'keep-running', '--worktree', ROOT])
  expect(toasts.join(' ')).toContain('fcc-211')
  expect(toasts.join(' ')).toContain('keep-running')
})

test('a project file with an error still stops the dev servers, and leaves the stacks', async ($, on) => {
  const { ran, toasts } = engine(on, {
    files: {
      [RECORD]: withServers({ docs: devServer(4242, 3000) }, stack('fcc-211')),
      [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'nuke' } }),
    },
  })
  await start($)
  await end($)

  expect(stops(ran)).toHaveLength(1)
  expect(stops(ran)[0]!.argv).toContain('keep-running')
  expect(toasts.join(' ')).toContain('did not stop supabase fcc-211')
})

test('a version 1 record is refused: the section and the toast name the migrate repair, and the session end stops nothing', async ($, on) => {
  const { ran, toasts } = engine(on, { files: { [RECORD]: JSON.stringify({ version: 1, stacks: [stack('fcc-211')] }) } })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('version 1')
  expect(text).toContain('worktree-env.sh migrate --worktree /proj')
  expect(toasts.join(' ')).toContain('migrate --worktree /proj')
  await end($)
  expect(stops(ran)).toHaveLength(0)
})

test('a record of an unknown shape is refused and named', async ($, on) => {
  engine(on, { files: { [RECORD]: JSON.stringify({ version: 2, resources: { docker: [], 'dev-servers': {}, vms: [] } }) } })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('"vms"')
  expect(text).toContain('worktree-env.sh list --worktree /proj')
})

test('a dev server stop that failed at the last session end is reported at the next start, with the repair', async ($, on) => {
  const failed = devServer(4242, 3000, {
    lastStop: {
      at: '2026-10-30T11:00:00.000Z',
      command: '',
      output: 'pid 4242 now runs "postgres" (started 2026-10-30T10:30:00.000Z), not the recorded "node next dev"',
      repair: 'find the server by its port, lsof -nP -iTCP:3000 -sTCP:LISTEN, and stop that process',
    },
  })
  const { toasts } = engine(on, { files: { [RECORD]: withServers({ docs: failed, ui: devServer(4343, 5173) }) } })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('dev server docs')
  expect(text).toContain('now runs "postgres"')
  expect(text).toContain('lsof -nP -iTCP:3000 -sTCP:LISTEN')
  expect(text).toContain('remove-dev-server --name docs --worktree /proj')
  expect(text).not.toMatch(/dev server ui[^\n]*did not stop/)
  expect(toasts.join(' ')).toContain('docs')
})

test('dev servers still listed at session start are named, even with keep-running', async ($, on) => {
  engine(on, {
    files: {
      [RECORD]: withServers({ ui: devServer(4343, 5173) }),
      [CONFIG]: JSON.stringify({ worktreeStacks: { onSessionEnd: 'keep-running' } }),
    },
  })
  await start($)

  const text = (await section($)) ?? ''
  expect(text).toContain('dev server ui (pid 4343, port 5173)')
  expect(text).toContain('worktree-env.sh stop-all --worktree /proj --on-end keep-running')
})
