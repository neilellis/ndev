import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Dollar = Parameters<Parameters<typeof test>[1]>[0]

const ROOT = '/proj'
const CONFIG = `${ROOT}/.neil-dev.json`
const ok = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const BOARDS = JSON.stringify({ projects: [{ number: 3, title: 'Roadmap' }, { number: 7, title: 'Bugs' }] })

// A fake engine: a git repository at /proj whose origin is acme/app, with two boards. `answers`
// answers the dialog's questions in order; `boards` is what gh project list prints (an Error fails it).
const engine = (
  on: On,
  opts: { files?: Map<string, string>; answers?: string[]; boards?: string | Error } = {},
) => {
  const files = opts.files ?? new Map<string, string>()
  const answers = [...(opts.answers ?? [])]
  const asked: string[] = []
  const toasts: string[] = []
  const spawned: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
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
    if (e.argv[0] === 'git') return ok(`${ROOT}\n`)
    if (e.argv[0] === 'gh' && e.argv[1] === 'repo') return ok('acme/app\n')
    if (e.argv[0] === 'gh' && e.argv[1] === 'project') {
      const b = opts.boards ?? BOARDS
      return b instanceof Error ? ok('', 1, b.message) : ok(b)
    }
    return ok()
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    asked.push(`${q.header}: ${q.question} [${q.options.map(o => o.label).join(' | ')}]`)
    const answer = answers.shift()
    if (answer === undefined) throw new Error('dismissed')
    return { result: { answers: { [q.question]: answer } }, text: answer }
  })
  on('agent.spawn', (_, e) => {
    spawned.push(e.prompt)
    return { model: 'm', agentId: 'a1' }
  })
  return { files, asked, toasts, spawned }
}

const start = async ($: Dollar, isInteractive = true) => {
  await $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive })
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
  return sections.find(s => s.id === 'neil-development:dev-mode')?.text ?? ''
}

const saved = (files: Map<string, string>) => JSON.parse(files.get(CONFIG) ?? '{}') as Record<string, unknown>

test('a new project: the dialog offers the origin and its boards, and saves the choice', async ($, on) => {
  const { files, asked } = engine(on, { answers: ['acme/app', '#3 Roadmap'] })
  await start($)

  expect(asked[0]).toContain('acme/app')
  expect(asked[1]).toContain('#3 Roadmap')
  expect(saved(files).github).toEqual({ repo: 'acme/app', board: { owner: 'acme', number: 3 } })
  expect(await section($)).toContain('repository acme/app; project board acme #3')
})

test('a project that is set up is not asked again', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ github: { repo: 'acme/app', board: null } })]])
  const { asked } = engine(on, { files })
  await start($)

  expect(asked).toHaveLength(0)
  expect(await section($)).toContain('no project board')
})

test('"No GitHub repository" is saved, so the dialog does not ask again', async ($, on) => {
  const { files, asked } = engine(on, { answers: ['No GitHub repository'] })
  await start($)

  expect(asked).toHaveLength(1)
  expect(saved(files).github).toEqual({ repo: null, board: null })
  expect((await section($)).includes('GitHub (')).toBe(false)
})

test('a repository without a board: only the board is asked', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ mode: 'heavy', github: { repo: 'acme/app' } })]])
  const { asked } = engine(on, { files, answers: ['acme/7'] })
  await start($)

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('Board')
  expect(saved(files)).toEqual({ mode: 'heavy', github: { repo: 'acme/app', board: { owner: 'acme', number: 7 } } })
})

test('a typed answer goes to an agent, and the plugin writes nothing itself', async ($, on) => {
  const { files, spawned, toasts } = engine(on, { answers: ['acme/app', 'the bugs board'] })
  await start($)

  expect(files.has(CONFIG)).toBe(false)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toContain('Project board: "the bugs board"')
  expect(spawned[0]).toContain('"repo":"acme/app"')
  expect(toasts.join(' ')).toContain('an agent is resolving')
})

test('"Ask me later" saves nothing, and a closed dialog says how to answer', async ($, on) => {
  const { files, toasts } = engine(on, { answers: ['Ask me later'] })
  await start($)

  expect(files.has(CONFIG)).toBe(false)
  expect(toasts.join(' ')).toContain('/dev-setup')
})

test('with no one to ask, a toast names /dev-setup and nothing is asked', async ($, on) => {
  const { asked, toasts } = engine(on, { answers: ['acme/app'] })
  await start($, false)

  expect(asked).toHaveLength(0)
  expect(toasts.join(' ')).toContain('Run /dev-setup')
})

test('a board look-up that fails names the command, its exit code and the repair', async ($, on) => {
  const { toasts, asked } = engine(on, {
    answers: ['acme/app', 'No project board'],
    boards: new Error('missing scope read:project'),
  })
  await start($)

  expect(toasts.join(' ')).toContain('gh project list --owner acme exited 1: missing scope read:project')
  expect(toasts.join(' ')).toContain('gh auth refresh -s read:project')
  expect(asked[1]).not.toContain('#3')
})

test('/dev-setup asks again even when the values are set', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ github: { repo: null, board: null } })]])
  const { asked } = engine(on, { files, answers: ['acme/app', 'No project board'] })
  await start($)
  expect(asked).toHaveLength(0)

  const ran = await $.command.run({ command: 'dev-setup', args: '' })
  expect(asked).toHaveLength(2)
  expect(ran.text).toContain('Saved github')
  expect(saved(files).github).toEqual({ repo: 'acme/app', board: null })
})

test('a bad github value is refused at start, and the dialog does not run', async ($, on) => {
  const bad = JSON.stringify({ github: { repo: 'not a repo' } })
  const { toasts, asked, files } = engine(on, { files: new Map([[CONFIG, bad]]) })
  await start($)

  expect(toasts.join(' ')).toContain('"github.repo" is "not a repo"')
  expect(asked).toHaveLength(0)
  expect(files.get(CONFIG)).toBe(bad)
})

test('/dev in a project that is not set up runs the set-up dialog', async ($, on) => {
  const { files, asked } = engine(on, { answers: ['Ask me later'] })
  await start($)
  asked.length = 0

  const ran = await $.command.run({ command: 'dev', args: '' })
  expect(asked[0]).toContain('Repository')
  expect(ran.text).toContain('Set-up skipped')
  expect(files.has(CONFIG)).toBe(false)
})

test('/dev in a project that is set up shows the help and asks nothing', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ github: { repo: 'acme/app', board: null } })]])
  const { asked } = engine(on, { files })
  await start($)

  const ran = await $.command.run({ command: 'dev', args: '' })
  expect(asked).toHaveLength(0)
  for (const name of ['/dev help', '/dev setup', '/dev-mode', '/dev-steering', '/learn']) expect(ran.text).toContain(name)
  expect(ran.text).toContain('light · interactive')
  expect(ran.text).toContain('acme/app')
})

test('/dev help shows the help even when the project is not set up', async ($, on) => {
  const { asked } = engine(on)
  await start($)
  asked.length = 0

  const ran = await $.command.run({ command: 'dev', args: 'help' })
  expect(asked).toHaveLength(0)
  expect(ran.text).toContain('/dev setup')
  expect(ran.text).toContain('not set up')
})

test('/dev setup asks again even when the values are set', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ github: { repo: null, board: null } })]])
  const { asked } = engine(on, { files, answers: ['acme/app', 'No project board'] })
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'setup' })
  expect(asked).toHaveLength(2)
  expect(saved(files).github).toEqual({ repo: 'acme/app', board: null })
  expect(ran.text).toContain('Saved github')
})

test('/dev with an unknown word names the word and the choices', async ($, on) => {
  const files = new Map([[CONFIG, JSON.stringify({ github: { repo: null, board: null } })]])
  engine(on, { files })
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'bogus' })
  expect(ran.text).toContain('"bogus"')
  expect(ran.text).toContain('/dev help')
  expect(ran.text).toContain('/dev setup')
})
