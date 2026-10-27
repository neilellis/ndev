import { expect, test } from 'claude-code/testing'

const SECTION = 'ndev:dev-mode'

type On = Parameters<Parameters<typeof test>[1]>[1]

const ROOT = '/proj'
const CONFIG = `${ROOT}/.neil-dev.json`
const ran = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake engine: the project is a git repository at /proj, ~/dev-wiki exists, and `files`
// holds the project's files; `wiki` false leaves ~/dev-wiki missing. Returns the toasts shown and the commands run.
const engine = (on: On, files: Map<string, string> = new Map(), wiki = true) => {
  const toasts: string[] = []
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('fs.exists', (_, e) => ({ value: (wiki && e.path.startsWith('/home/neil/dev-wiki')) || files.has(e.path) }))
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
    runs.push([...e.argv])
    return e.argv[0] === 'git' ? ran(`${ROOT}\n`) : ran()
  })
  return { toasts, runs }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: `${ROOT}/src`, surface: 'terminal', isInteractive: true })

const section = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const { sections } = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  return sections.find(s => s.id === SECTION)?.text ?? ''
}

test('a session starts light and interactive', async ($, on) => {
  engine(on)
  await start($)

  const text = await section($)
  expect(text).toContain('LIGHT')
  expect(text).toContain('ndev:work-light')
  expect(text).toContain('INTERACTIVE')
})

test('/dev-mode toggles to heavy and back', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev-mode', args: '' })
  expect(ran.text).toContain('Development mode is now heavy.')
  expect(await section($)).toContain('ndev:work-heavy')

  await $.command.run({ command: 'dev-mode', args: '' })
  expect(await section($)).toContain('LIGHT')
})

test('/dev-steering auto tells the model not to stop for questions', async ($, on) => {
  engine(on)
  await start($)

  await $.command.run({ command: 'dev-steering', args: 'auto' })
  const text = await section($)
  expect(text).toContain('AUTO')
  expect(text).not.toContain('INTERACTIVE')
  expect(text).toContain('ndev:work-light-auto')

  await $.command.run({ command: 'dev-mode', args: 'heavy' })
  expect(await section($)).toContain('ndev:work-heavy-auto')
})

test('an unknown value is refused and changes nothing', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev-mode', args: 'medium' })
  expect(ran.text).toContain('"medium" is not a mode')
  expect(await section($)).toContain('LIGHT')
})

test('the prompt names ~/dev-wiki and the dev-wiki skill', async ($, on) => {
  engine(on)
  await start($)

  const text = await section($)
  expect(text).toContain('~/dev-wiki')
  expect(text).toContain('ndev:dev-wiki')
})

test('/learn hands the model the review instruction', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'learn', args: '' })
  expect(ran.context?.[0]).toContain('/learn section')
})

test('a correction gets the record-the-lesson nudge; a plain prompt does not', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await start($)

  const corrected = await $.prompt.submit({ text: "No, don't poll the CI run." })
  expect(corrected.context?.join(' ')).toContain('ndev:dev-wiki')

  const plain = await $.prompt.submit({ text: 'Add a date column to the table.' })
  expect(plain.context ?? []).toHaveLength(0)
})

test('a missing wiki is created from the plugin by init.sh', async ($, on) => {
  const { runs } = engine(on, new Map(), false)
  await start($)
  await new Promise(resolve => setTimeout(resolve, 50))

  const init = runs.filter(argv => argv[0] === 'bash')
  expect(init).toHaveLength(1)
  expect(init[0]?.[1]).toContain('scripts/wiki/init.sh')
  expect(init[0]?.[2]).toBe('/home/neil/dev-wiki')
})

test('the project file sets the mode and steering', async ($, on) => {
  engine(on, new Map([[CONFIG, '{ "mode": "heavy", "steering": "auto" }']]))
  await start($)

  const text = await section($)
  expect(text).toContain('HEAVY')
  expect(text).toContain('AUTO')
  expect(text).toContain('ndev:work-heavy-auto')
})

test('/dev-mode writes the project file and keeps its other keys', async ($, on) => {
  const files = new Map([[CONFIG, '{ "steering": "auto", "quality": { "precheckReminder": {} } }']])
  engine(on, files)
  await start($)

  const ran = await $.command.run({ command: 'dev-mode', args: 'heavy' })
  expect(ran.text).toContain('Saved to .neil-dev.json')
  expect(JSON.parse(files.get(CONFIG) ?? '{}')).toEqual({
    steering: 'auto',
    quality: { precheckReminder: {} },
    mode: 'heavy',
  })
})

test('with no project file, /dev-steering creates one', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await start($)

  await $.command.run({ command: 'dev-steering', args: 'auto' })
  expect(JSON.parse(files.get(CONFIG) ?? '{}')).toEqual({ steering: 'auto' })
})

test('a bad project file is shown, not used and not overwritten', async ($, on) => {
  const bad = '{ "mode": "medium" }'
  const files = new Map([[CONFIG, bad]])
  const { toasts } = engine(on, files)
  await start($)

  expect(toasts.join(' ')).toContain('"mode" is "medium"')
  expect(await section($)).toContain('LIGHT')

  const ran = await $.command.run({ command: 'dev-mode', args: 'heavy' })
  expect(ran.text).toContain('Not saved')
  expect(files.get(CONFIG)).toBe(bad)
})

test('branding appears only when the project file sets it', async ($, on) => {
  engine(on, new Map([[CONFIG, '{ "branding": { "site": "https://brand.example", "name": "Acme" } }']]))
  await start($)
  expect(await section($)).toContain('brand is Acme, defined at https://brand.example')
})

test('with no branding, the prompt names no brand', async ($, on) => {
  engine(on)
  await start($)
  expect((await section($)).toLowerCase()).not.toContain('brand')
})

test('/dev mode toggles and sets the mode like /dev-mode', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'mode' })
  expect(ran.text).toContain('Development mode is now heavy.')
  expect(await section($)).toContain('ndev:work-heavy')

  await $.command.run({ command: 'dev', args: 'Mode light' })
  expect(await section($)).toContain('LIGHT')
  expect(JSON.parse(files.get(CONFIG) ?? '{}').mode).toBe('light')
})

test('/dev steering auto sets the steering like /dev-steering', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'steering auto' })
  expect(ran.text).toContain('Steering is now auto.')
  expect(await section($)).toContain('ndev:work-light-auto')
})

test('/dev mode with an unknown value names /dev mode in the refusal', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'mode medium' })
  expect(ran.text).toContain('"medium" is not a mode')
  expect(ran.text).toContain('/dev mode heavy')
  expect(await section($)).toContain('LIGHT')
})

test('the /dev help lists /dev mode and /dev steering', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'help' })
  expect(ran.text).toContain('/dev mode [light|heavy]')
  expect(ran.text).toContain('/dev steering [interactive|auto]')
})
