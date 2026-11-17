import { expect, test } from 'claude-code/testing'

declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const ROOT = '/proj'
const MARKER = `${ROOT}/.ndev-inited`
const SCRIPT = `${ROOT}/scripts/init-project.sh`
const ok = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake engine: a git repository at /proj. `ignored` is whether git ignores the marker; `build`
// is what scripts/init-project.sh does when run (absent: the script does not exist).
const engine = (
  on: On,
  opts: { files?: Map<string, string>; ignored?: boolean; inGit?: boolean; build?: { exitCode: number; stdout?: string; stderr?: string } } = {},
) => {
  const files = opts.files ?? new Map<string, string>()
  if (opts.build) files.set(SCRIPT, '#!/usr/bin/env bash\n')
  const ran: { argv: readonly string[]; cwd?: string }[] = []
  const toasts: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
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
    const inGit = opts.inGit ?? true
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-parse') return inGit ? ok(`${ROOT}\n`) : ok('', 128, 'fatal: not a git repository')
    if (e.argv[0] === 'git' && e.argv[1] === 'check-ignore') {
      if (!inGit) return ok('', 128, 'fatal: not a git repository')
      return (opts.ignored ?? true) ? ok('.ndev-inited\n') : ok('', 1)
    }
    if (e.argv[0] === 'bash' && e.argv[1] === SCRIPT && opts.build) {
      return ok(opts.build.stdout ?? '', opts.build.exitCode, opts.build.stderr ?? '')
    }
    return ok()
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

const section = async ($: Dollar) => {
  const { sections } = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  return sections.find(s => s.id === 'ndev:init-project')?.text
}

const builds = (ran: { argv: readonly string[]; cwd?: string }[]) => ran.filter(r => r.argv[0] === 'bash' && r.argv[1] === SCRIPT)

test('an initialised worktree: the script does not run and nothing is added', async ($, on) => {
  const { ran } = engine(on, { files: new Map([[MARKER, '']]), build: { exitCode: 0 } })
  await start($)

  expect(builds(ran)).toHaveLength(0)
  expect(await section($)).toBeUndefined()
})

test('a new worktree: the script runs at the project root and the marker is written', async ($, on) => {
  const { ran, files, toasts } = engine(on, { build: { exitCode: 0 } })
  await start($)

  expect(builds(ran)).toHaveLength(1)
  expect(builds(ran)[0]!.cwd).toBe(ROOT)
  expect(files.has(MARKER)).toBe(true)
  expect(toasts.join(' ')).toContain('init-project.sh passed')
  expect(await section($)).toBeUndefined()
})

test('a failed build: no marker, and the agent gets the exit code, the output and the rerun command', async ($, on) => {
  const { files, toasts } = engine(on, { build: { exitCode: 2, stdout: 'installing\n', stderr: 'npm ERR! missing peer\n' } })
  await start($)

  expect(files.has(MARKER)).toBe(false)
  expect(toasts.join(' ')).toContain('exited 2')
  const text = (await section($)) ?? ''
  expect(text).toContain('exited 2')
  expect(text).toContain('npm ERR! missing peer')
  expect(text).toContain('bash scripts/init-project.sh && touch .ndev-inited')
})

test('no init script: the agent is told to write one that builds the project from source', async ($, on) => {
  const { ran, files } = engine(on)
  await start($)

  expect(builds(ran)).toHaveLength(0)
  expect(files.has(MARKER)).toBe(false)
  const text = (await section($)) ?? ''
  expect(text).toContain('scripts/init-project.sh does not exist')
  expect(text).toContain('build the project from source')
})

test('a marker git does not ignore: the script does not run and the repair is named', async ($, on) => {
  const { ran, files, toasts } = engine(on, { ignored: false, build: { exitCode: 0 } })
  await start($)

  expect(builds(ran)).toHaveLength(0)
  expect(files.has(MARKER)).toBe(false)
  expect(toasts.join(' ')).toContain('.gitignore')
  expect((await section($)) ?? '').toContain('Add `.ndev-inited` to .gitignore')
})

test('once the agent writes the marker, the instruction goes away', async ($, on) => {
  const { files } = engine(on)
  await start($)
  expect(await section($)).toBeDefined()

  files.set(MARKER, '')
  await $.prompt.submit({ text: 'next' } as never)
  expect(await section($)).toBeUndefined()
})

test('outside a git repository: nothing runs and nothing is added', async ($, on) => {
  const { ran } = engine(on, { inGit: false, build: { exitCode: 0 } })
  await start($)

  expect(builds(ran)).toHaveLength(0)
  expect(await section($)).toBeUndefined()
})
