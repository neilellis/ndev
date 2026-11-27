import { expect, test } from './sdk-testing'

import { until } from './until'

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]
type Dollar = Parameters<Body>[0]

const ROOT = '/proj'
const FILE = `${ROOT}/.neil-dev.env`
const ok = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
type Status = { file: string | null; copiedFrom: string | null; root: string; main: string | null; ignored: boolean; keys: string[]; missing: string[] }
const status = (s: Partial<Status>): Status => ({ file: null, copiedFrom: null, root: ROOT, main: ROOT, ignored: true, keys: [], missing: [], ...s })

// A fake engine: a git repository at /proj. `statuses` are what neil-dev-env.mjs status --json
// prints, in order (the last one repeats); `answers` are the dialog answers, then dismissal.
const engine = (on: On, opts: { statuses: (Status | { exitCode: number; stderr: string })[]; answers?: string[]; initOutput?: string; ghThrows?: boolean }) => {
  const ran: string[][] = []
  const toasts: string[] = []
  const asked: string[] = []
  const answers = [...(opts.answers ?? [])]
  let next = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => e)
  on('env.get', () => ({ value: '/home/user' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/user/dev-wiki') || e.path === `${ROOT}/.ndev-inited` }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-parse') return ok(`${ROOT}\n`)
    if (e.argv[0] === 'git' && e.argv[1] === 'check-ignore') return ok('.ndev-inited\n')
    if (e.argv[0] === 'node' && String(e.argv[1]).endsWith('scripts/env/neil-dev-env.mjs')) {
      if (e.argv[2] === 'init') return ok(opts.initOutput ?? 'Created /proj/.neil-dev.env (mode 600).\nmissing: UNSPLASH_ACCESS_KEY')
      const s = opts.statuses[Math.min(next++, opts.statuses.length - 1)]!
      return 'exitCode' in s ? ok('', s.exitCode, s.stderr) : ok(JSON.stringify(s))
    }
    if (e.argv[0] === 'gh') {
      if (opts.ghThrows) throw new Error('gh did not start')
      return ok('', 1, 'no gh here')
    }
    return ok()
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    asked.push(`${q.header}: ${q.question} [${q.options.map(o => o.label).join(' | ')}]`)
    // Only the credentials question is answered; the GitHub set-up dialog is closed.
    const answer = q.question.includes('.neil-dev.env') ? answers.shift() : undefined
    if (answer === undefined) throw new Error('dismissed')
    return { result: { answers: { [q.question]: answer } }, text: answer }
  })
  return { ran, toasts, asked }
}

const start = async ($: Dollar, isInteractive = false) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
}

const section = async ($: Dollar) => {
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  return sections.find(s => s.id === 'ndev:credentials')?.text
}

const inits = (ran: string[][]) => ran.filter(a => a[0] === 'node' && a[2] === 'init')
const credentialQuestions = (asked: string[]) => asked.filter(q => q.includes('.neil-dev.env'))

test('a project with the file: the agent gets its path, the key names and the run command', async ($, on) => {
  const { asked } = engine(on, { statuses: [status({ file: FILE, keys: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], missing: ['UNSPLASH_ACCESS_KEY'] })] })
  await start($, true)

  const text = (await section($)) ?? ''
  expect(text).toContain(FILE)
  expect(text).toContain('OPENROUTER_API_KEY, OPENAI_API_KEY')
  expect(text).toContain('UNSPLASH_ACCESS_KEY')
  expect(text).toContain('scripts/env/neil-dev-env.mjs run --need')
  expect(text).toContain('Never print')
  expect(credentialQuestions(asked)).toHaveLength(0)
})

test('a worktree that got a copy from the main checkout: a toast says where it came from', async ($, on) => {
  const { toasts } = engine(on, { statuses: [status({ file: FILE, copiedFrom: '/main/.neil-dev.env', main: '/main', keys: ['OPENAI_API_KEY'] })] })
  await start($)

  expect(toasts.join(' ')).toContain('copied .neil-dev.env from the main project checkout /main/.neil-dev.env')
})

test('no file: the person is asked, and a yes creates it from ~/.zshrc', async ($, on) => {
  const { ran, asked, toasts } = engine(on, {
    statuses: [status({}), status({ file: FILE, keys: ['OPENAI_API_KEY'], missing: ['UNSPLASH_ACCESS_KEY'] })],
    answers: ['Create from ~/.zshrc'],
  })
  await start($, true)
  await until('the created credentials section', async () => ((await section($)) ?? '').includes(FILE), () => ({ asked, toasts }))
  await until('the credentials question', () => credentialQuestions(asked).length === 1, () => asked)

  expect(credentialQuestions(asked)).toHaveLength(1)
  expect(credentialQuestions(asked)[0]).toContain('~/.zshrc')
  expect(inits(ran)).toHaveLength(1)
  expect(toasts.join(' ')).toContain('missing: UNSPLASH_ACCESS_KEY')
  expect((await section($)) ?? '').toContain(FILE)
})

test('no file and the dialog closed: nothing is created, and the agent asks before creating it', async ($, on) => {
  const { ran, asked } = engine(on, { statuses: [status({})] })
  await start($, true)
  await until('the credentials question', () => credentialQuestions(asked).length === 1, () => asked)

  expect(credentialQuestions(asked)).toHaveLength(1)
  expect(inits(ran)).toHaveLength(0)
  const text = (await section($)) ?? ''
  expect(text).toContain('no .neil-dev.env')
  expect(text).toContain('scripts/env/neil-dev-env.mjs init')
  expect(text).toContain('Never search other files')
})

test('no file in a non-interactive session: no dialog', async ($, on) => {
  const { asked, ran } = engine(on, { statuses: [status({})] })
  await start($, false)

  expect(credentialQuestions(asked)).toHaveLength(0)
  expect(inits(ran)).toHaveLength(0)
})

test('a file name git does not ignore: no dialog, and the repair is named', async ($, on) => {
  const { asked, toasts } = engine(on, { statuses: [status({ ignored: false })] })
  await start($, true)

  expect(credentialQuestions(asked)).toHaveLength(0)
  expect(toasts.join(' ')).toContain('.gitignore')
  expect((await section($)) ?? '').toContain('not git-ignored')
})

test('a status that fails: the toast and the agent get the exit code and the output', async ($, on) => {
  const { toasts } = engine(on, { statuses: [{ exitCode: 1, stderr: 'neil-dev-env: /proj/.neil-dev.env line 3 is not KEY=VALUE' }] })
  await start($, true)

  expect(toasts.join(' ')).toContain('line 3 is not KEY=VALUE')
  const text = (await section($)) ?? ''
  expect(text).toContain('exited 1')
  expect(text).toContain('line 3 is not KEY=VALUE')
})

test('a GitHub set-up that throws: the failure is shown, and the credentials question is still asked', async ($, on) => {
  const { asked, toasts } = engine(on, { statuses: [status({})], ghThrows: true })
  await start($, true)

  await until('the credentials question after GitHub setup failed', () => credentialQuestions(asked).length === 1, () => ({ asked, toasts }))
  expect(toasts.join(' ')).toContain('the GitHub set-up failed')
  expect(credentialQuestions(asked)).toHaveLength(1)
})
