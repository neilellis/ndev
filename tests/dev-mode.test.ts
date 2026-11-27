import { expect, test } from './sdk-testing'

const SECTION = 'ndev:dev-mode'

type On = Parameters<Parameters<typeof test>[1]>[1]

const ROOT = '/proj'
const CONFIG = `${ROOT}/.ndev.json`
const ran = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake engine: the project is a git repository at /proj, ~/dev-wiki exists, and `files`
// holds the project's files; `wiki` false leaves ~/dev-wiki missing; `refused` names a command the engine refuses. Returns the toasts shown and the commands run.
type Fail = { exitCode: number; stderr: string }
const failed = (f: Fail) => ({ value: { exitCode: f.exitCode, stdout: '', stderr: f.stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const engine = (on: On, files: Map<string, string> = new Map(), wiki = true, refused?: string, initFails?: Fail, setFails?: Fail) => {
  const toasts: string[] = []
  const runs: string[][] = []
  on('command.register', (_, e) => {
    if (e.name === refused) throw new Error(`/${e.name} is taken`)
    return { value: { command: e.name } }
  })
  // The fix-all-prs loop registers its tool and timer at session start.
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('env.get', () => ({ value: '/home/user' }))
  on('fs.exists', (_, e) => ({ value: (wiki && e.path.startsWith('/home/user/dev-wiki')) || files.has(e.path) }))
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
    if (initFails && e.argv.includes('init')) return failed(initFails)
    if (setFails && e.argv.includes('set-setting')) return failed(setFails)
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

  const init = runs.filter(argv => argv[0] === 'bash' && !argv.includes('init') && !argv[1]?.endsWith('gh.sh'))
  expect(init).toHaveLength(1)
  expect(init[0]?.[1]).toContain('scripts/wiki/init.sh')
  expect(init[0]?.[2]).toBe('/home/user/dev-wiki')
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
  expect(ran.text).toContain('Saved to .ndev.json')
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

test('branding may name the local folder of the brand site, which the prompt gives to brand skills', async ($, on) => {
  const { toasts } = engine(on, new Map([[CONFIG, '{ "branding": { "site": "https://brand.example", "name": "Acme", "path": "apps/brand" } }']]))
  await start($)
  expect(toasts.join(' ')).not.toContain('unknown "branding" key')
  expect(await section($)).toContain('its source is apps/brand')
})

test('a non-string branding path is refused with the key named', async ($, on) => {
  const { toasts } = engine(on, new Map([[CONFIG, '{ "branding": { "site": "https://brand.example", "path": 3 } }']]))
  await start($)
  expect(toasts.join(' ')).toContain('"branding.path" must be a string')
})

for (const [label, bad] of [['an empty', '""'], ['an absolute', '"/Users/someone/acme-brand"']]) {
  test(`${label} branding path is refused with the key named`, async ($, on) => {
    const { toasts } = engine(on, new Map([[CONFIG, `{ "branding": { "site": "https://brand.example", "path": ${bad} } }`]]))
    await start($)
    expect(toasts.join(' ')).toContain('"branding.path" must be a folder relative to the project root')
  })
}

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
  expect(ran.text).toContain('/dev mode [light|heavy|hack]')
  expect(ran.text).toContain('/dev steering [interactive|auto]')
  expect(ran.text).toContain('/flow epic')
  expect(ran.text).toContain('more than one PR, more than one agent session, or decisions that need a spec others will implement from')
})

test('a command the engine refuses stops only its own feature: the toast names it, and the rest of the start goes on', async ($, on) => {
  const { toasts } = engine(on, new Map([[CONFIG, '{ "mode": "heavy" }']]), true, 'view')
  await start($)

  expect(await section($)).toContain('HEAVY')
  expect(toasts.join(' ')).toMatch(/ndev: view did not start: \S.*\/reload-plugins/)
  const ran = await $.command.run({ command: 'dev-mode', args: '' })
  expect(ran.text).toContain('Development mode is now light.')
})

const RECORD = `${ROOT}/.neil-dev.worktree.json`
const ENV_SH = 'worktree-env.sh'

test('a session start asks worktree-env.sh to create a missing worktree record', async ($, on) => {
  const { runs } = engine(on)
  await start($)
  expect(runs.some(a => a.some(x => x.endsWith(ENV_SH)) && a.includes('init') && a.includes(ROOT))).toBe(true)
})

test('a record that cannot be created is shown with the script\'s own message', async ($, on) => {
  const { toasts } = engine(on, new Map(), true, undefined, { exitCode: 3, stderr: 'worktree-env: not git-ignored. Repair: add the line to .gitignore' })
  await start($)
  const text = toasts.join(' ')
  expect(text).toContain('exited 3')
  expect(text).toContain('Repair: add the line')
})

test('the worktree record sets the mode and steering ahead of the project file', async ($, on) => {
  engine(on, new Map([
    [CONFIG, '{ "mode": "light", "steering": "interactive" }'],
    [RECORD, JSON.stringify({ version: 2, settings: { mode: 'heavy', steering: 'auto' }, resources: { docker: [], 'dev-servers': {} } })],
  ]))
  await start($)
  const text = await section($)
  expect(text).toContain('HEAVY')
  expect(text).toContain('AUTO')
})

test('/dev-mode in a worktree with a record saves through worktree-env.sh set-setting, not the project file', async ($, on) => {
  const files = new Map([
    [CONFIG, '{ "steering": "auto" }'],
    [RECORD, JSON.stringify({ version: 2, resources: { docker: [], 'dev-servers': {} } })],
  ])
  const { runs } = engine(on, files)
  await start($)
  const ran = await $.command.run({ command: 'dev-mode', args: 'heavy' })
  expect(ran.text).toContain('Development mode is now heavy.')
  expect(ran.text).toContain('Saved to .neil-dev.worktree.json')
  expect(ran.text).not.toContain('commit it')
  const call = runs.find(a => a.includes('set-setting'))
  expect(call?.slice(call.indexOf('set-setting'))).toEqual(['set-setting', '--key', 'mode', '--value', 'heavy', '--worktree', ROOT])
  expect(files.get(CONFIG)).toBe('{ "steering": "auto" }')
})

test('a failed set-setting is reported with its exit code and output, and the mode still switches', async ($, on) => {
  const files = new Map([[RECORD, JSON.stringify({ version: 2, resources: { docker: [], 'dev-servers': {} } })]])
  engine(on, files, true, undefined, undefined, { exitCode: 2, stderr: 'worktree-env: lock held' })
  await start($)
  const ran = await $.command.run({ command: 'dev-mode', args: 'heavy' })
  expect(ran.text).toContain('Not saved')
  expect(ran.text).toContain('exited 2')
  expect(ran.text).toContain('lock held')
})

// Hack mode: a human steers each step of the hack, so it is interactive only.
test('/dev mode hack loads the work-hack skill, and the toggle passes over it', async ($, on) => {
  engine(on)
  await start($)

  const ran = await $.command.run({ command: 'dev', args: 'mode hack' })
  expect(ran.text).toContain('Development mode is now hack.')
  expect(await section($)).toContain('ndev:work-hack')
  expect(await section($)).toContain('HACK')

  await $.command.run({ command: 'dev-mode', args: '' })
  expect(await section($)).toContain('LIGHT')
})

test('/dev refuses hack mode with auto steering, both ways round', async ($, on) => {
  engine(on)
  await start($)

  await $.command.run({ command: 'dev', args: 'steering auto' })
  const refused = await $.command.run({ command: 'dev', args: 'mode hack' })
  expect(refused.text).toContain('interactive only')
  expect(refused.text).toContain('/dev steering interactive')
  expect(await section($)).toContain('LIGHT')

  await $.command.run({ command: 'dev', args: 'steering interactive' })
  await $.command.run({ command: 'dev', args: 'mode hack' })
  const back = await $.command.run({ command: 'dev', args: 'steering auto' })
  expect(back.text).toContain('interactive only')
  expect(back.text).toContain('/dev mode light')
  expect(await section($)).toContain('INTERACTIVE')
})
