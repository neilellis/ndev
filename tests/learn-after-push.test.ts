import type { On } from 'claude-code'
import { expect, test, type Engine } from './sdk-testing'

const ran = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Git = {
  // What the Bash call does to the remote-tracking ref, as its reflog words it. Unset moves nothing.
  moves?: string
  // The Bash call itself reports a failure.
  failed?: boolean
  // The ref that moves. A worktree shares refs/remotes with the other worktrees of its repository.
  ref?: string
  // Another worktree sent the moved commit, so this worktree's HEAD does not contain it.
  fromSibling?: boolean
}

// A fake engine: a git repository at /proj with no .ndev.json, and ~/dev-wiki present.
// Beneath the plugin, each Bash call can move the remote-tracking ref. The answer counts the git ref reads.
const engine = async ($: Engine, on: On, { moves, failed = false, ref = 'refs/remotes/origin/feature', fromSibling = false }: Git = {}) => {
  let sha = 'aaa'
  const reads = { count: 0 }
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
  on('process.run', (_, e) => {
    if (e.argv[1] === 'for-each-ref') {
      reads.count += 1
      return ran(`${ref} ${sha}\n`)
    }
    if (e.argv[1] === 'reflog') return ran(`${moves ?? ''}\n`)
    if (e.argv[1] === 'merge-base') {
      expect(e.argv.slice(2)).toEqual(['--is-ancestor', 'bbb', 'HEAD'])
      return { value: { ...ran().value, exitCode: fromSibling ? 1 : 0 } }
    }
    return e.argv[0] === 'git' ? ran('/proj\n') : ran()
  })
  on('tool.call', () => {
    if (moves) sha = 'bbb'
    return failed ? { isError: true as const, result: '' } : { result: '' }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  return reads
}

const context = async ($: Engine, command: string, extra: Record<string, unknown> = {}) =>
  ((await $.tool.call({ tool: 'Bash', command, ...extra })).context ?? []).join('\n')

const asksForIngest = (text: string) => {
  expect(text).toContain('ndev:dev-wiki')
  expect(text).toContain('design')
  expect(text).toContain('copywriting')
  expect(text).toContain('project or domain')
}

const PUSHED = 'update by push'

test('a git push that lands asks for the dev-wiki ingest of development, design and copywriting lessons', async ($, on) => {
  await engine($, on, { moves: PUSHED })
  asksForIngest(await context($, 'git push origin feature'))
})

test('a push with options before the verb asks for the ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED })
  asksForIngest(await context($, 'git -C /proj push -u origin feature'))
})

test('a push through a wrapper script asks for the ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED })
  asksForIngest(await context($, 'bash scripts/push-checked.sh origin feature > push.log 2>&1'))
})

test('a push through a script whose name only ends in push asks for the ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED })
  asksForIngest(await context($, 'bash scripts/merge_finish_and_push.sh'))
})

test('a push that lands before a later command fails asks for the ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED, failed: true })
  asksForIngest(await context($, 'git push origin feature && false'))
})

test('a command that only names a push asks for no ingest', async ($, on) => {
  await engine($, on)
  for (const command of [
    'grep -rn "git push" hooks',
    'sed -n 1,40p scripts/push-checked.sh',
    'git stash push -m wip',
    'echo push',
  ]) {
    expect(await context($, command)).not.toContain('ndev:dev-wiki')
  }
})

test('a refused push whose call still exits 0 asks for no ingest', async ($, on) => {
  await engine($, on)
  const command = 'scripts/push-checked.sh -u origin feature > push.log 2>&1; rc=$?; echo "push exit $rc"; tail -30 push.log'
  expect(await context($, command)).not.toContain('ndev:dev-wiki')
})

test('a push with nothing to send asks for no ingest', async ($, on) => {
  await engine($, on)
  expect(await context($, 'git push origin feature')).not.toContain('ndev:dev-wiki')
})

test('a fetch that moves a remote-tracking ref asks for no ingest', async ($, on) => {
  await engine($, on, { moves: 'fetch origin: fast-forward' })
  expect(await context($, 'git fetch origin; echo push')).not.toContain('ndev:dev-wiki')
})

test('a push from another worktree during a refused push asks for no ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED, ref: 'refs/remotes/origin/sibling', fromSibling: true, failed: true })
  const command = 'git push > push.log 2>&1; echo "push exit $?"; ndev wait checks 464'
  expect(await context($, command)).not.toContain('ndev:dev-wiki')
})

test('a push of a branch that is not checked out, named in the command, asks for the ingest', async ($, on) => {
  await engine($, on, { moves: PUSHED, ref: 'refs/remotes/origin/release/1.2', fromSibling: true })
  asksForIngest(await context($, 'git push origin release/1.2'))
})

test('the ingest request names the ref that the push moved', async ($, on) => {
  await engine($, on, { moves: PUSHED })
  expect(await context($, 'git push origin feature')).toContain('A push just landed on origin/feature.')
})

test('a dry-run push asks for no ingest', async ($, on) => {
  await engine($, on)
  expect(await context($, 'git push --dry-run origin feature')).not.toContain('ndev:dev-wiki')
})

test('a command that does not name a push reads no git refs', async ($, on) => {
  const reads = await engine($, on)
  expect(await context($, 'ls -la')).not.toContain('ndev:dev-wiki')
  expect(reads.count).toBe(0)
})

test('a push in the background asks for the ingest once it finishes with exit 0', async ($, on) => {
  await engine($, on)
  const text = await context($, 'git push origin feature', { run_in_background: true })
  expect(text).toContain('ndev:dev-wiki')
  expect(text).toContain('exit 0')
})
