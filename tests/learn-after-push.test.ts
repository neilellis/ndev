import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

const ran = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake engine: a git repository at /proj with no .neil-dev.json, and ~/dev-wiki present.
// Beneath the plugin, every Bash call succeeds, or fails when `failed`.
const engine = async ($: Engine, on: On, failed = false) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({ value: e.path.startsWith('/home/neil/dev-wiki') }))
  on('fs.read', () => ({ value: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => (e.argv[0] === 'git' ? ran('/proj\n') : ran()))
  on('tool.call', () => (failed ? { isError: true as const, result: '' } : { result: '' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

const context = async ($: Engine, command: string, extra: Record<string, unknown> = {}) =>
  ((await $.tool.call({ tool: 'Bash', command, ...extra })).context ?? []).join('\n')

const asksForIngest = (text: string) => {
  expect(text).toContain('ndev:dev-wiki')
  expect(text).toContain('design')
  expect(text).toContain('copywriting')
  expect(text).toContain('project or domain')
}

test('a git push that lands asks for the dev-wiki ingest of development, design and copywriting lessons', async ($, on) => {
  await engine($, on)
  asksForIngest(await context($, 'git push origin feature'))
  asksForIngest(await context($, 'git -C /proj push -u origin feature'))
})

test('a push through a wrapper script or after cd asks for the ingest too', async ($, on) => {
  await engine($, on)
  asksForIngest(await context($, 'bash scripts/push-checked.sh origin feature > push.log 2>&1'))
  asksForIngest(await context($, 'cd /proj && git push'))
})

test('commands that push nothing ask for no ingest', async ($, on) => {
  await engine($, on)
  for (const command of ['ls -la', 'git stash push -m wip', 'echo push']) {
    expect(await context($, command)).not.toContain('ndev:dev-wiki')
  }
})

test('a dry-run push asks for no ingest', async ($, on) => {
  await engine($, on)
  expect(await context($, 'git push --dry-run origin feature')).not.toContain('ndev:dev-wiki')
})

test('a push that failed asks for no ingest', async ($, on) => {
  await engine($, on, true)
  expect(await context($, 'git push origin feature')).not.toContain('ndev:dev-wiki')
})

test('a push in the background asks for the ingest once it finishes with exit 0', async ($, on) => {
  await engine($, on)
  const text = await context($, 'git push origin feature', { run_in_background: true })
  expect(text).toContain('ndev:dev-wiki')
  expect(text).toContain('exit 0')
})
