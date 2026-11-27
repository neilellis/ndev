import type { On } from 'claude-code'
import { expect, test, type Engine } from './sdk-testing'

const ran = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake engine: a git repository at /proj with no .ndev.json, and ~/dev-wiki present.
// Beneath the plugin, every Edit and Write gives `result`.
const engine = async ($: Engine, on: On, result: () => { isError?: true; deny?: string; result?: string } = () => ({ result: '' })) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/user' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/user/dev-wiki') }))
  on('fs.read', () => ({ value: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => (e.argv[0] === 'git' ? ran('/proj\n') : ran()))
  on('tool.call', () => result() as { result: string })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

const context = async ($: Engine, tool: 'Edit' | 'Write', file_path: string) =>
  ((await $.tool.call({ tool, file_path })).context ?? []).join('\n')

test('writing a component asks the agent to check the component map for a richer component', async ($, on) => {
  await engine($, on)
  const text = await context($, 'Write', '/proj/src/components/NewPicker.tsx')
  expect(text).toContain('/proj/src/components/NewPicker.tsx')
  expect(text).toContain('/kb/ui-components.md')
  expect(text).toContain('Component map')
  expect(text).toContain('most basic')
})

test('editing a component asks for the check too', async ($, on) => {
  await engine($, on)
  expect(await context($, 'Edit', '/proj/src/app/settings/page.tsx')).toContain('/kb/ui-components.md')
})

test('.jsx, .vue and .svelte files are components', async ($, on) => {
  await engine($, on)
  for (const file of ['/proj/a.jsx', '/proj/b.vue', '/proj/c.svelte']) {
    expect(await context($, 'Edit', file)).toContain('/kb/ui-components.md')
  }
})

test('files that are not components ask for nothing', async ($, on) => {
  await engine($, on)
  for (const file of [
    '/proj/src/lib/format.ts',
    '/proj/src/app/ui.css',
    '/proj/README.md',
    '/proj/src/components/Picker.test.tsx',
    '/proj/src/components/Picker.spec.jsx',
    '/proj/src/components/Picker.stories.tsx',
    '/proj/node_modules/lib/Thing.tsx',
    '/proj/src/__tests__/Picker.tsx',
    '/proj/src/components/Picker.cy.tsx',
    '/proj/src/components/Picker.e2e.tsx',
  ]) {
    expect(await context($, 'Edit', file)).not.toContain('/kb/ui-components.md')
  }
})

test('the check is asked once for each file in a session', async ($, on) => {
  await engine($, on)
  expect(await context($, 'Edit', '/proj/once/First.tsx')).toContain('/proj/once/First.tsx')
  expect(await context($, 'Edit', '/proj/once/First.tsx')).not.toContain('/kb/ui-components.md')
  expect(await context($, 'Write', '/proj/once/First.tsx')).not.toContain('/kb/ui-components.md')
  expect(await context($, 'Edit', '/proj/once/Second.tsx')).toContain('/proj/once/Second.tsx')
})

test('an edit that failed asks for nothing, and the retry still asks', async ($, on) => {
  let failed = true
  await engine($, on, () => (failed ? { isError: true, result: '' } : { result: '' }))
  expect(await context($, 'Edit', '/proj/failed/Retry.tsx')).not.toContain('/kb/ui-components.md')
  failed = false
  expect(await context($, 'Edit', '/proj/failed/Retry.tsx')).toContain('/kb/ui-components.md')
})

test('a denied edit asks for nothing', async ($, on) => {
  await engine($, on, () => ({ deny: 'no' }))
  const ran = await $.tool.call({ tool: 'Edit', file_path: '/proj/denied/Thing.tsx' })
  expect((ran.context ?? []).join('\n')).not.toContain('/kb/ui-components.md')
})

test('a new session, such as after /clear, asks again for a file', async ($, on) => {
  await engine($, on)
  expect(await context($, 'Edit', '/proj/again/Thing.tsx')).toContain('/kb/ui-components.md')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(await context($, 'Edit', '/proj/again/Thing.tsx')).toContain('/kb/ui-components.md')
})

test('the prompt names the file for the rules and asks for the reason in the reply', async ($, on) => {
  await engine($, on)
  const text = await context($, 'Edit', '/proj/wording/Thing.tsx')
  expect(text).toContain('the rules in that file')
  expect(text).toContain('in your reply')
})
