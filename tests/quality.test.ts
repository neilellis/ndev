import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Run = { argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }

const ROOT = '/proj'
const CONFIG = `${ROOT}/.neil-dev.json`

const answered = (config: string | undefined) => {
  if (config === undefined) return undefined
  try {
    const parsed = JSON.parse(config ?? '{}') as Record<string, unknown>
    return JSON.stringify({ github: { repo: null, board: null }, ...parsed })
  } catch {
    return config
  }
}

// The engine beneath the plugin: a project at /proj whose .neil-dev.json holds `config`
// (undefined: no file), and hook scripts that answer with `script`.
const engine = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: On,
  config: string | undefined,
  script: { exitCode: number; stdout?: string; stderr?: string } = { exitCode: 0 },
) => {
  const runs: Run[] = []
  const toasts: string[] = []
  // The set-up dialog is answered already (no GitHub), so it asks nothing and runs nothing here.
  config = answered(config)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  // The fix-all-prs loop registers its tool and timer at session start.
  on('tool.register', () => ({ value: { tool: 'mcp__ndev__report' } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.id', () => ({ value: 'test-session' }))
  on('clock.sleep', () => new Promise(() => {}))
  on('clock.every', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/neil' }))
  on('session.cwd', () => ({ value: ROOT }))
  // The dev wiki exists, so register.ts's init runs nothing.
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/dev-wiki/wiki.md') || (config !== undefined && e.path === CONFIG) }))
  on('fs.read', () => ({ value: config ?? '' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    // The worktree record check at session start is no hook script either.
    if (e.argv[0] === 'bash' && e.argv.includes('init') && String(e.argv[1]).endsWith('/scripts/work/worktree-env.sh')) {
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // gh is the set-up dialog's look-up (no repository here), not a hook script.
    if (e.argv[0] === 'gh') {
      return { value: { exitCode: 1, stdout: '', stderr: 'no repo', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // The credentials check at session start is no hook script either.
    if (e.argv[0] === 'node' && String(e.argv[1]).endsWith('/scripts/env/neil-dev-env.mjs')) {
      const status = { file: `${ROOT}/.neil-dev.env`, copiedFrom: null, root: ROOT, main: ROOT, ignored: true, keys: [], missing: [] }
      return { value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git') {
      return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // Session start reads the repository through gh.sh; that is no hook script.
    if (e.argv[1]?.endsWith('scripts/github/gh.sh')) return { value: { exitCode: 0, stdout: '{"repo":""}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env, stdin: e.init?.stdin })
    return {
      value: {
        exitCode: script.exitCode,
        stdout: script.stdout ?? '',
        stderr: script.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', () => ({ result: {} }))
  // register.ts reads .neil-dev.json once, at session start.
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return { runs, toasts }
}

const edit = { tool: 'Edit', file_path: `${ROOT}/a.py`, old_string: 'a', new_string: 'b' } as const

test('no config: an edit runs no hook script', async ($, on) => {
  const { runs, toasts } = await engine($, on, undefined)

  const ran = await $.tool.call(edit)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x && claude -p hi' })

  expect(runs.map(r => r.argv.join(' '))).toEqual([])
  // With no file the set-up dialog runs and reports; no quality hook adds a toast.
  expect(toasts.filter(t => !t.startsWith('Set-up'))).toEqual([])
  expect(ran.context ?? []).toEqual([])
})

test('a config that lists only other hooks does not run the edited-file guards', async ($, on) => {
  const { runs } = await engine($, on, JSON.stringify({ quality: { precheckReminder: {} } }))

  await $.tool.call(edit)

  expect(runs).toHaveLength(0)
})

test('edited-file guards: the script gets the payload and env, and exit-2 findings reach context', async ($, on) => {
  const findings = 'The guards refuse /proj/a.py.\n\nF401 unused import\nFix the file.'
  const { runs } = await engine($, on, JSON.stringify({ quality: { editedFileGuards: { venv: 'env' } } }), {
    exitCode: 2,
    stderr: findings,
  })

  const ran = await $.tool.call(edit)

  expect(runs).toHaveLength(1)
  const run = runs[0]!
  expect(run.argv[0]).toBe('bash')
  expect(run.argv[1]).toMatch(/kb\/hooks\/edited-file-guards\.sh$/)
  expect(run.cwd).toBe(ROOT)
  expect(run.env?.CLAUDE_PROJECT_DIR).toBe(ROOT)
  expect(run.env?.EDITED_FILE_GUARDS_VENV).toBe('env')
  const stdin = JSON.parse(run.stdin ?? '{}')
  expect(stdin.tool_name).toBe('Edit')
  expect(stdin.tool_input.file_path).toBe(`${ROOT}/a.py`)
  expect(ran.deny).toBeUndefined()
  expect(ran.context?.join('\n')).toContain('F401 unused import')
})

test('a script that cannot run is named with its exit code and stderr', async ($, on) => {
  const { toasts } = await engine($, on, JSON.stringify({ quality: { editedFileGuards: {} } }), {
    exitCode: 127,
    stderr: 'bash: no such file',
  })

  const ran = await $.tool.call(edit)

  const text = ran.context?.join('\n') ?? ''
  expect(text).toContain('edited-file-guards.sh')
  expect(text).toContain('exit 127')
  expect(text).toContain('bash: no such file')
  expect(toasts.join('\n')).toContain('exit 127')
})

test('bad JSON: nothing runs (register.ts reports the file error)', async ($, on) => {
  const { runs } = await engine($, on, '{ "quality": ')

  const ran = await $.tool.call(edit)

  expect(runs).toHaveLength(0)
  expect(ran.context ?? []).toHaveLength(0)
})

test('an unknown quality hook: one toast naming the file and the key, and nothing runs', async ($, on) => {
  const { runs, toasts } = await engine($, on, JSON.stringify({ quality: { editedFileGuards: {}, lintEverything: {} } }))

  await $.tool.call(edit)
  await $.tool.call(edit)

  expect(runs).toHaveLength(0)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('.neil-dev.json')
  expect(toasts[0]).toContain('quality.lintEverything')
})

test('a wrong setting type is refused, not defaulted', async ($, on) => {
  const { runs, toasts } = await engine($, on, JSON.stringify({ quality: { worktreeSubmodules: { paths: '.claude/agents' } } }))

  await $.tool.call({ tool: 'Bash', command: 'git worktree add ../x' })

  expect(runs).toHaveLength(0)
  expect(toasts[0]).toContain('quality.worktreeSubmodules.paths')
})

test('subscription warning: advisory context, never a deny', async ($, on) => {
  const warning = 'WARNING: this command can spend the subscription.'
  const { runs } = await engine($, on, JSON.stringify({ quality: { subscriptionWarning: { gateVar: 'NEXTGEN_ALLOW_CLAUDE_CLI' } } }), {
    exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }),
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'claude -p "summarise"' })

  expect(runs).toHaveLength(1)
  expect(runs[0]!.argv[1]).toMatch(/warn-subscription-cli\.sh$/)
  expect(runs[0]!.env?.SUBSCRIPTION_GATE_VAR).toBe('NEXTGEN_ALLOW_CLAUDE_CLI')
  expect(JSON.parse(runs[0]!.stdin ?? '{}').tool_input.command).toBe('claude -p "summarise"')
  expect(ran.deny).toBeUndefined()
  expect(ran.context).toEqual([warning])
})

test('precheck reminder: after a commit, the reminder reaches context; other commands run nothing', async ($, on) => {
  const { runs } = await engine($, on, JSON.stringify({ quality: { precheckReminder: { command: './scripts/precheck.sh' } } }), {
    exitCode: 0,
    stderr: 'Reminder: run ./scripts/precheck.sh before you push (recommended, not forced).\n',
  })

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(runs).toHaveLength(0)

  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix"' })
  expect(runs).toHaveLength(1)
  expect(runs[0]!.env?.PRECHECK_COMMAND).toBe('./scripts/precheck.sh')
  expect(ran.deny).toBeUndefined()
  expect(ran.context?.[0]).toContain('Reminder: run ./scripts/precheck.sh')
})

test('worktree submodules: runs after git worktree add with the listed paths', async ($, on) => {
  const { runs } = await engine($, on, JSON.stringify({ quality: { worktreeSubmodules: { paths: ['.claude/agents', 'vendor/x'] } } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'git worktree add ../wt -b feature' })
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(ran.deny).toBeUndefined()
  expect(runs).toHaveLength(1)
  expect(runs[0]!.argv[1]).toMatch(/init-worktree-submodules\.sh$/)
  expect(runs[0]!.env?.WORKTREE_SUBMODULES).toBe('.claude/agents vendor/x')
})
