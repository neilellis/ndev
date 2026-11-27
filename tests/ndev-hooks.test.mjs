import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const made = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main' },
  }))
  return root
}

function hook(root, harness, toolName, command, env = {}) {
  const result = spawnSync(ndev, ['hook', 'pre-tool-use', '--harness', harness], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
    input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: toolName, tool_input: { command } }),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

function linkedFixture(t, ignore = '', separateGitDir = false) {
  const home = mkdtempSync(join(tmpdir(), 'ndev-hook-start-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const main = join(home, 'project')
  const linked = join(home, 'linked')
  const metadata = join(home, 'metadata')
  const env = { HOME: home, PATH: process.env.PATH }
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  const checkedGit = (cwd, ...args) => {
    const result = git(cwd, ...args)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  mkdirSync(main)
  checkedGit(main, 'init', '-q', ...(separateGitDir ? ['--separate-git-dir', metadata] : []))
  writeFileSync(join(main, '.gitignore'), ignore)
  checkedGit(main, 'add', '.gitignore')
  checkedGit(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
  checkedGit(main, 'worktree', 'add', '-q', '-b', 'topic', linked)
  const start = (harness = 'codex') => spawnSync(ndev, ['hook', 'session-start', '--harness', harness], {
    cwd: main, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'fixture', cwd: linked }),
  })
  return { main, linked, metadata, git, checkedGit, start }
}

test('session start copies project files and creates a separate worktree record', t => {
  const { main, linked, checkedGit, start } = linkedFixture(t, '.neil-dev.env\n')
  const config = '{"mode":"heavy","workflow":false}\n'
  const credentials = 'FIXTURE_API_KEY=fixture-only-secret\n'
  const projectFile = name => join(main, name)
  const linkedFile = name => join(linked, name)
  writeFileSync(projectFile('.ndev.json'), config)
  writeFileSync(projectFile('.neil-dev.env'), credentials, { mode: 0o644 })
  writeFileSync(projectFile('.neil-dev.worktree.json'), '{"version":1,"stacks":["different checkout"]}\n')
  const first = start()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(linkedFile('.ndev.json'), 'utf8'), config)
  assert.equal(readFileSync(linkedFile('.neil-dev.env'), 'utf8'), credentials)
  assert.equal(statSync(linkedFile('.neil-dev.env')).mode & 0o777, 0o600)
  const record = linkedFile('.neil-dev.worktree.json')
  const fresh = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(fresh, { version: 2, resources: { docker: [], 'dev-servers': {} } })
  assert.doesNotMatch(first.stdout + first.stderr, /fixture-only-secret/)
  assert.doesNotMatch(first.stdout, /Ask which issue/)
  assert.equal(checkedGit(linked, 'check-ignore', '.neil-dev.env', '.neil-dev.worktree.json'), '.neil-dev.env\n.neil-dev.worktree.json')
  writeFileSync(linkedFile('.ndev.json'), '{"mode":"light"}\n')
  writeFileSync(linkedFile('.neil-dev.env'), 'FIXTURE_API_KEY=local\n')
  writeFileSync(record, JSON.stringify({ ...fresh, settings: { steering: 'auto' } }))
  const again = start('claude')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(linkedFile('.ndev.json'), 'utf8'), '{"mode":"light"}\n')
  assert.equal(readFileSync(linkedFile('.neil-dev.env'), 'utf8'), 'FIXTURE_API_KEY=local\n')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).settings, { steering: 'auto' })
})

test('session start creates defaults when neither checkout has project files', t => {
  const { main, linked, checkedGit, start } = linkedFixture(t)
  const result = start('opencode')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(linked, '.ndev.json'), 'utf8')), { mode: 'light', steering: 'interactive' })
  const credentials = join(linked, '.neil-dev.env')
  assert.match(readFileSync(credentials, 'utf8'), /^(?:#.*\n)*$/)
  assert.equal(statSync(credentials).mode & 0o777, 0o600)
  assert.ok(existsSync(join(linked, '.neil-dev.worktree.json')))
  assert.equal(checkedGit(linked, 'check-ignore', '.neil-dev.env', '.neil-dev.worktree.json'), '.neil-dev.env\n.neil-dev.worktree.json')
  assert.equal(checkedGit(linked, 'diff', '--', '.gitignore'), '')
  assert.equal(existsSync(join(main, '.neil-dev.env')), false)
})

test('session start refuses to put credentials in a worktree that explicitly exposes them', t => {
  const { main, linked, start } = linkedFixture(t, '!.neil-dev.env\n.neil-dev.worktree.json\n')
  writeFileSync(join(main, '.neil-dev.env'), 'FIXTURE_API_KEY=fixture-only-secret\n', { mode: 0o600 })
  const result = start()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /\.neil-dev\.env is not git-ignored/)
  assert.match(result.stderr, /Repair:.*remove any line that un-ignores it/)
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only-secret/)
  assert.equal(existsSync(join(linked, '.neil-dev.env')), false)
})

test('session start creates defaults for a linked worktree of a bare repository', t => {
  const { main, linked, checkedGit, start } = linkedFixture(t)
  const bare = join(main, 'bare.git')
  checkedGit(main, 'worktree', 'remove', linked)
  checkedGit(main, 'clone', '-q', '--bare', main, bare)
  checkedGit(bare, 'worktree', 'add', '-q', linked, 'topic')
  const result = start()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(linked, '.ndev.json'), 'utf8')).mode, 'light')
  assert.equal(statSync(join(linked, '.neil-dev.env')).mode & 0o777, 0o600)
  assert.ok(existsSync(join(linked, '.neil-dev.worktree.json')))
})

test('session start does not copy project files from a separate Git metadata directory', t => {
  const { linked, metadata, start } = linkedFixture(t, '', true)
  writeFileSync(join(metadata, '.ndev.json'), '{"mode":"heavy"}')
  writeFileSync(join(metadata, '.neil-dev.env'), 'FIXTURE_WRONG_SOURCE=metadata\n')
  const result = start()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(linked, '.ndev.json'), 'utf8')).mode, 'light')
  assert.doesNotMatch(readFileSync(join(linked, '.neil-dev.env'), 'utf8'), /FIXTURE_WRONG_SOURCE/)
})

test('session start does not replace a dangling worktree record symlink', t => {
  const { linked, start } = linkedFixture(t, '.neil-dev.worktree.json\n')
  const record = join(linked, '.neil-dev.worktree.json')
  symlinkSync('missing-record', record)
  const result = start()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /\.neil-dev\.worktree\.json.*regular file/)
  assert.equal(readlinkSync(record), 'missing-record')
})

test('hook denies a guarded commit inside a shell script for every native adapter', t => {
  const root = fixture(t)
  for (const [harness, tool] of [['claude', 'Bash'], ['codex', 'Bash'], ['opencode', 'shell']]) {
    const decision = hook(root, harness, tool, "bash -c 'git commit -m test'")
    const permission = decision?.hookSpecificOutput?.permissionDecision ?? decision?.decision
    assert.equal(permission, 'deny', harness)
    const reason = decision?.hookSpecificOutput?.permissionDecisionReason ?? decision?.reason
    assert.match(reason, /issue #17.*ndev flow checkpoint/i)
  }
})

test('hook ignores words passed as data and allows a commit in a distinct repository', t => {
  const root = fixture(t)
  const unrelated = fixture(t)
  const echo = hook(root, 'claude', 'Bash', "echo 'git commit -m test'")
  assert.equal(echo, null)
  const outside = hook(root, 'claude', 'Bash', `git -C "${unrelated}" commit -m test`)
  assert.equal(outside, null)
})

test('native Git guards follow the PR workflow after issue development', t => {
  const root = fixture(t)
  const path = join(root, '.neil-dev.issue-17.json')
  const issue = { issue: 17, root, state: 'developed', branch: 'topic', base: 'main', prs: [18] }
  for (const state of ['blocked', 'ci', 'done']) {
    for (const off of [undefined, { at: 1, reason: 'human disabled workflow' }]) {
      writeFileSync(path, JSON.stringify({ version: 1, issue: 17, workflow: issue, prs: {
        18: { ...issue, pr: 18, state, off },
      } }))
      for (const [harness, tool] of [['claude', 'Bash'], ['codex', 'exec_command'], ['opencode', 'shell']]) {
        for (const command of ['git commit -m test', 'git push origin topic']) {
          const decision = hook(root, harness, tool, command)
          const permission = decision?.hookSpecificOutput?.permissionDecision ?? decision?.decision
          assert.equal(permission, off || state === 'done' ? undefined : 'deny', `${harness}: ${state}, off=${!!off}: ${command}`)
        }
      }
    }
  }
})

test('native Git guards allow disabled issue and project workflows', t => {
  const root = fixture(t)
  const path = join(root, '.neil-dev.issue-17.json')
  const held = JSON.parse(readFileSync(path, 'utf8'))
  for (const scope of ['issue', 'project']) {
    writeFileSync(path, JSON.stringify({ ...held, workflow: { ...held.workflow, off: scope === 'issue' ? { at: 1 } : undefined } }))
    writeFileSync(join(root, '.ndev.json'), JSON.stringify({ workflow: scope !== 'project' }))
    for (const [harness, tool] of [['claude', 'Bash'], ['codex', 'exec_command'], ['opencode', 'shell']]) {
      for (const command of ['git commit -m test', 'git push origin topic']) {
        assert.equal(hook(root, harness, tool, command), null, `${harness}: ${scope}: ${command}`)
      }
    }
  }
})

test('a developing issue keeps its guard while an earlier PR workflow is off', t => {
  const root = fixture(t)
  const issue = { issue: 17, root, state: 'developing', branch: 'topic', base: 'main', prs: [18] }
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({ version: 1, issue: 17, workflow: issue, prs: {
    18: { ...issue, pr: 18, state: 'blocked', off: { at: 1 } },
  } }))
  assert.equal(hook(root, 'codex', 'exec_command', 'git commit -m test')?.hookSpecificOutput?.permissionDecision, 'deny')
})

test('session clear keeps the owned issue and a true end releases it', t => {
  const root = fixture(t)
  const path = join(root, '.neil-dev.issue-17.json')
  writeFileSync(path, JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main', owner: { session: 'fixture' }, rev: 1 },
  }))
  const state = () => JSON.parse(readFileSync(path, 'utf8')).workflow
  const end = reason => {
    const result = spawnSync(ndev, ['hook', 'session-end', '--harness', 'claude'], {
      cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH },
      input: JSON.stringify({ session_id: 'fixture', cwd: root, reason }),
    })
    assert.equal(result.status, 0, result.stderr)
  }
  end('clear')
  assert.equal(state().owner.session, 'fixture')
  end('logout')
  const workflow = state()
  assert.equal(workflow.owner, undefined)
  assert.equal(workflow.lastSession, 'fixture')
  assert.equal(workflow.state, 'developing')
})

test('a Claude turn end never blocks the stop or re-prompts, whether the workflow is off, actionable, blocked or waiting on the human', t => {
  const root = fixture(t)
  const path = join(root, '.neil-dev.issue-17.json')
  const workflow = { issue: 17, root, branch: 'topic', base: 'main', owner: { session: 'fixture' }, rev: 1 }
  const cases = [
    ['off', { ...workflow, state: 'developing' }, false],
    ['developing', { ...workflow, state: 'developing' }, true],
    ['blocked on the human', { ...workflow, state: 'blocked', previous: 'developing', blocked: { message: 'Sign in to the test account in the browser tab.', at: 1, group: 'human' } }, true],
    ['waiting', { ...workflow, state: 'waiting' }, true],
  ]
  for (const [name, record, enabled] of cases) {
    writeFileSync(path, JSON.stringify({ version: 1, issue: 17, workflow: record }))
    writeFileSync(join(root, '.ndev.json'), JSON.stringify({ workflow: enabled }))
    for (const [turn, active] of [['t1', false], ['t2', true]]) {
      const result = spawnSync(ndev, ['hook', 'turn-complete', '--harness', 'claude'], {
        cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH },
        input: JSON.stringify({ session_id: 'fixture', cwd: root, turn_id: turn, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'Waiting on you to sign in.' }),
      })
      assert.equal(result.status, 0, `${name}: ${result.stderr}`)
      assert.equal(result.stdout, '', name)
      assert.equal(result.stderr, '', name)
    }
  }
})

test('a successful component edit gives one reuse prompt per file and session', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}\n')
  const call = () => {
    const result = spawnSync(ndev, ['hook', 'post-tool-use', '--harness', 'claude'], {
      cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH },
      input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: 'Write', tool_input: { file_path: 'src/Control.tsx' }, tool_response: {} }),
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  assert.match(JSON.parse(call()).hookSpecificOutput.additionalContext, /Component map.*ui-components\.md/)
  assert.equal(call(), '')
})

test('the learning hook reacts to a landed push and leaves an unchanged ref alone', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}\n')
  const env = { HOME: root, PATH: process.env.PATH }
  const git = (...args) => {
    const command = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(command.status, 0, command.stderr)
  }
  const call = (event, id) => {
    const result = spawnSync(ndev, ['hook', event, '--harness', 'claude'], {
      cwd: root, encoding: 'utf8', env,
      input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'git push origin HEAD:topic' }, tool_response: { exitCode: 0 } }),
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '--bare', 'fixture-remote.git')
  git('remote', 'add', 'origin', join(root, 'fixture-remote.git'))
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture')
  call('pre-tool-use', 'no-push')
  assert.equal(call('post-tool-use', 'no-push'), '')
  call('pre-tool-use', 'landed')
  git('push', 'origin', 'HEAD:topic')
  assert.match(JSON.parse(call('post-tool-use', 'landed')).hookSpecificOutput.additionalContext, /origin\/topic.*ndev-dev-wiki/)
})

test('Codex SessionStart directs the first work turn to the linked GitHub issue', t => {
  const root = fixture(t)
  rmSync(join(root, '.neil-dev.issue-17.json'))
  writeFileSync(join(root, '.ndev.json'), '{"github":{"repo":"neilellis/ndev"}}')
  mkdirSync(join(root, 'dev-wiki'))
  writeFileSync(join(root, 'dev-wiki/wiki.md'), '')
  const orca = join(root, 'orca')
  writeFileSync(orca, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"result":{"references":[{"provider":"github","type":"issue","url":"https://github.com/neilellis/ndev/issues/41"},{"provider":"github","type":"issue","url":"https://github.com/neilellis/ndev/issues/42","selected":true}]}}\'\n', { mode: 0o700 })
  const start = source => {
    const result = spawnSync(ndev, ['hook', 'session-start', '--harness', 'codex'], {
      cwd: root, encoding: 'utf8',
      env: { HOME: root, PATH: process.env.PATH, ORCA_AGENT_SESSION_ID: 'fixture', ORCA_CLI_COMMAND: orca },
      input: JSON.stringify({ session_id: 'fixture', cwd: root, source }),
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.match(start('startup').hookSpecificOutput.additionalContext, /Before development work, run ndev flow start 42\./)
  assert.doesNotMatch(start('compact').hookSpecificOutput.additionalContext, /ndev flow start 42/)
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main' },
  }))
  assert.match(start('startup').hookSpecificOutput.additionalContext, /Before development work, run ndev flow start 17\./)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}')
  const declined = start('startup')
  assert.match(declined.systemMessage, /Workflow is disabled.*ndev flow on --project/)
  assert.doesNotMatch(declined.hookSpecificOutput.additionalContext, /Ask which issue|ndev flow start/)
})

test('native chat prompt guard blocks stale sends and allows retry after local compaction', t => {
  const root = fixture(t)
  const state = join(root, 'state')
  const legacyFlag = join(state, 'ndev', 'chat-guard')
  mkdirSync(join(state, 'ndev'), { recursive: true })
  const transcript = join(root, 'conversation.jsonl')
  const call = (harness, prompt, rows, structured = '1', modifiedAt) => {
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    if (modifiedAt) utimesSync(transcript, modifiedAt, modifiedAt)
    const result = spawnSync(ndev, ['hook', 'prompt-submit', '--harness', harness], {
      cwd: root, encoding: 'utf8',
      env: { HOME: root, PATH: process.env.PATH, XDG_STATE_HOME: state, ORCA_STRUCTURED_SESSION: structured },
      input: JSON.stringify({ cwd: root, session_id: 'fixture', transcript_path: transcript, prompt }),
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const stamp = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
  const codex = (minutes, tokens) => ({
    timestamp: stamp(minutes), type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens } } },
  })
  const stale = [codex(21, 200_001)]
  assert.notEqual(call('codex', 'draft', stale).decision, 'block')
  writeFileSync(legacyFlag, '')
  assert.notEqual(call('codex', 'draft', [codex(51, 200_001)]).decision, 'block')
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":false}')
  assert.notEqual(call('codex', 'draft', [codex(51, 200_001)]).decision, 'block')
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":true}')
  assert.notEqual(call('codex', 'draft', stale, '').decision, 'block')
  assert.notEqual(call('codex', 'draft', [codex(21, 200_000)]).decision, 'block')
  assert.notEqual(call('codex', 'draft', [codex(6, 300_000)]).decision, 'block')
  assert.notEqual(call('codex', 'draft', [codex(19, 300_000)]).decision, 'block')
  assert.notEqual(call('codex', 'draft', stale).decision, 'block')
  const blocked = call('codex', 'draft', [codex(51, 200_001)])
  assert.equal(blocked.decision, 'block')
  assert.match(blocked.reason, /51 minutes.*\/compact/)
  assert.notEqual(call('codex', '/compact keep the plan', stale).decision, 'block')
  assert.notEqual(call('codex', 'draft', [...stale, { timestamp: stamp(0), type: 'compacted' }]).decision, 'block')
  const claude = {
    timestamp: stamp(51), type: 'assistant',
    message: { usage: { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 10 } },
  }
  assert.match(call('claude', 'draft', [claude]).reason, /51 minutes.*\/compact/)
  assert.notEqual(call('claude', 'draft', [claude, { timestamp: stamp(0), type: 'system', subtype: 'compact_boundary' }]).decision, 'block')
  const oldLargeRecord = { ...claude, content: 'a'.repeat(1024 * 1024) }
  assert.equal(call('claude', 'draft', [oldLargeRecord], '1', new Date(stamp(51))).decision, 'block')
})

test('chat guard hook ignores a folder outside Git and fails on an invalid project file', t => {
  const root = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'ndev-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const transcript = join(root, 'conversation.jsonl')
  writeFileSync(transcript, JSON.stringify({
    timestamp: new Date(Date.now() - 90 * 60_000).toISOString(), type: 'assistant', message: { usage: { input_tokens: 50 } },
  }) + '\n')
  const call = cwd => spawnSync(ndev, ['hook', 'prompt-submit', '--harness', 'claude'], {
    cwd, encoding: 'utf8',
    env: { HOME: root, PATH: process.env.PATH, XDG_STATE_HOME: join(root, 'state'), ORCA_STRUCTURED_SESSION: '1' },
    input: JSON.stringify({ cwd, session_id: 'fixture', transcript_path: transcript, prompt: 'draft' }),
  })
  assert.doesNotMatch(call(outside).stdout, /"block"/)
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":"yes"}')
  const bad = call(root)
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /"chatGuard" is "yes"; use true or false/)
  assert.ok(bad.stderr.includes(join(root, '.ndev.json')))
})

test('ndev chat-guard on, off and status set the project key and leave other keys alone', t => {
  const root = fixture(t)
  const guard = verb => spawnSync(ndev, ['chat-guard', verb], { cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH } })
  const config = () => JSON.parse(readFileSync(join(root, '.ndev.json'), 'utf8'))
  assert.match(guard('status').stdout, /guard is off for/)
  writeFileSync(join(root, '.ndev.json'), '{"mode":"heavy"}')
  assert.match(guard('on').stdout, /guard is on for/)
  assert.deepEqual(config(), { mode: 'heavy', chatGuard: true })
  assert.match(guard('status').stdout, /guard is on for/)
  assert.match(guard('off').stdout, /guard is off for/)
  assert.deepEqual(config(), { mode: 'heavy', chatGuard: false })
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":"yes"}')
  const bad = guard('status')
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /"chatGuard" is "yes"; use true or false/)
})

test('chat guard continue passes the saved request once without launching a new chat', t => {
  const root = fixture(t)
  const state = join(root, 'state')
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":true}')
  const transcript = join(root, 'conversation.jsonl')
  const timestamp = '2000-01-01T00:00:00.000Z'
  const draft = 'Check the release.\nKeep "$HOME" and `echo test` literal.'
  for (const harness of ['claude', 'codex']) {
    writeFileSync(transcript, JSON.stringify(harness === 'codex'
      ? { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 50 } } } }
      : { timestamp, type: 'assistant', message: { usage: { input_tokens: 50 } } }))
    const call = (session, prompt) => {
      const result = spawnSync(ndev, ['hook', 'prompt-submit', '--harness', harness], {
        cwd: root, encoding: 'utf8',
        env: { HOME: root, PATH: process.env.PATH, XDG_STATE_HOME: state, ORCA_STRUCTURED_SESSION: '1', ORCA_CLI_COMMAND: '/nonexistent-orca' },
        input: JSON.stringify({ cwd: root, session_id: session, transcript_path: transcript, prompt }),
      })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    const blocked = call('one', draft)
    assert.match(call('other', 'continue').reason, /no saved message/i)
    const resumed = call('one', ' Continue ')
    assert.notEqual(resumed.decision, 'block')
    assert.match(blocked.reason, /continue/)
    assert.equal(resumed.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.ok(resumed.hookSpecificOutput.additionalContext.endsWith(draft))
    assert.match(call('one', 'continue').reason, /no saved message/i)
    assert.equal(call('one', 'A new request').decision, 'block')
  }
})

test('chat guard replies launch Orca with the saved prompt from the same chat', t => {
  const root = fixture(t)
  const state = join(root, 'state')
  writeFileSync(join(root, '.ndev.json'), '{"chatGuard":true}')
  const transcript = join(root, 'conversation.jsonl')
  const timestamp = new Date(Date.now() - 51 * 60_000).toISOString()
  writeFileSync(transcript, [
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'The tests passed. The release still needs checking.' }] } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count',
      info: { last_token_usage: { total_tokens: 50 } } } },
  ].map(row => JSON.stringify(row)).join('\n'))
  const orca = join(root, 'orca')
  const launches = join(root, 'launches.jsonl')
  writeFileSync(orca, `#!/bin/sh
exec node --input-type=module -e '
import { appendFileSync } from "node:fs"
appendFileSync(process.env.LAUNCHES, JSON.stringify(process.argv.slice(1)) + "\\n")
const result = { outcome: { kind: "structured" }, prompt: { outcome: "journaled" } }
if (process.env.LAUNCH_RESULT === "missing") delete result.prompt
if (process.env.LAUNCH_RESULT === "replay") {
  console.log(JSON.stringify({ ok: false, error: { code: "agent_session_operation_unknown", data: { operationId: "replay-id" } } }))
  process.exit(1)
}
if (process.env.LAUNCH_RESULT === "incompatible") {
  console.log(JSON.stringify({ ok: false, error: { code: "incompatible_runtime" } }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, result }))
' -- "$@"
`, { mode: 0o700 })
  const call = (session, prompt, outcome = '') => {
    const result = spawnSync(ndev, ['hook', 'prompt-submit', '--harness', 'codex'], {
      cwd: root, encoding: 'utf8',
      env: { HOME: root, PATH: process.env.PATH, XDG_STATE_HOME: state, ORCA_STRUCTURED_SESSION: '1',
        ORCA_CLI_COMMAND: orca, LAUNCHES: launches, LAUNCH_RESULT: outcome },
      input: JSON.stringify({ cwd: root, session_id: session, transcript_path: transcript, prompt }),
    })
    assert.equal(result.status, 0, result.stderr)
    const reply = JSON.parse(result.stdout)
    assert.equal(reply.decision, 'block')
    return reply.reason
  }
  const draft = 'Check the release.\nKeep "$HOME" literal.'
  assert.match(call('one', draft), /hand-off.*new-session/)
  assert.match(call('other', 'new-session'), /no saved message/i)
  assert.equal(existsSync(launches), false)
  assert.match(call('one', 'new-session'), /sent.*new Orca chat/i)
  assert.match(call('one', 'new-session'), /no saved message/i)
  const second = 'Review the results.'
  call('two', second)
  assert.match(call('two', 'hand-off'), /sent.*new Orca chat/i)
  call('three', 'Keep this if delivery is uncertain.')
  assert.match(call('three', 'new-session', 'missing'), /could not confirm/i)
  assert.match(call('three', 'new-session'), /check Orca/i)
  assert.match(call('three', 'Replacement draft'), /check Orca/i)
  call('four', 'Replay this draft.')
  assert.match(call('four', 'new-session', 'replay'), /reply new-session again/i)
  assert.match(call('four', 'hand-off'), /reply new-session again/i)
  assert.match(call('four', 'continue'), /reply new-session again/i)
  assert.match(call('four', 'new-session'), /sent.*new Orca chat/i)
  call('five', 'Keep this draft after refusal.')
  assert.match(call('five', 'new-session', 'incompatible'), /incompatible_runtime.*update Orca/i)
  assert.match(call('five', 'new-session'), /sent.*new Orca chat/i)
  const [fresh, handoff, uncertain, replay, retried, incompatible, afterRefusal] = readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(fresh, [
    'agent', 'launch', '--agent', 'codex', '--surface', 'chat', '--worktree', `path:${root}`,
    '--focus', '--json', `--prompt=${draft}`,
  ])
  assert.deepEqual(handoff.slice(0, -1), fresh.slice(0, -1))
  assert.match(handoff.at(-1), /The tests passed\. The release still needs checking\.[\s\S]*Review the results\.$/)
  assert.equal(uncertain.at(-1), '--prompt=Keep this if delivery is uncertain.')
  assert.deepEqual(retried, [...replay, '--retry-launch', 'replay-id'])
  assert.deepEqual(afterRefusal, incompatible)
  assert.equal(readFileSync(launches, 'utf8').trim().split('\n').length, 7)
})

test('commit refusal identifies the stale issue, PR state, record and repair for every harness', t => {
  const root = fixture(t)
  const path = join(root, '.neil-dev.issue-17.json')
  writeFileSync(path, JSON.stringify({ version: 1, issue: 17, workflow: {
    issue: 17, root, repo: 'o/r', state: 'ci', branch: 'topic', base: 'main', prs: [18],
  } }))
  const gh = join(root, 'gh.sh')
  writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' \'{"number":18,"state":"closed","merged":true}\'\n')
  for (const [harness, tool] of [['claude', 'Bash'], ['codex', 'exec_command'], ['opencode', 'shell']]) {
    const decision = hook(root, harness, tool, 'git commit -m next', { NDEV_FLOW_GH: gh })
    const reason = decision?.hookSpecificOutput?.permissionDecisionReason ?? decision?.reason
    assert.equal(decision?.hookSpecificOutput?.permissionDecision ?? decision?.decision, 'deny')
    assert.match(reason, /Issue #17.*PR #18.*merged/s)
    assert.ok(reason.includes(path), reason)
    assert.match(reason, /ndev flow off --pr 18/)
    assert.doesNotMatch(reason, /ndev flow checkpoint/)
  }
})

test('commit refusals distinguish open, unavailable and invalid PR state without allowing Git', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({ version: 1, issue: 17, workflow: {
    issue: 17, root, repo: 'o/r', state: 'ci', branch: 'topic', base: 'main', prs: [18],
  } }))
  const gh = join(root, 'gh.sh')
  for (const [body, expected] of [
    ['printf \'%s\\n\' \'{"number":18,"state":"open","merged":false}\'', /PR #18 state open/],
    ['echo "PR lookup denied" >&2\nexit 37', /PR #18 state unverified.*exited 37: PR lookup denied/],
    ['echo "not json"', /PR #18 state unverified.*invalid JSON.*not json/s],
    ['echo \'{"number":99,"state":"closed","merged":true}\'', /PR #18 state unverified.*returned PR #99/],
    ['echo \'{"number":18,"state":"open","merged":"false"}\'', /PR #18 state unverified/],
    ['echo null', /PR #18 state unverified.*non-object/],
  ]) {
    writeFileSync(gh, `#!/bin/sh\n${body}\n`)
    const decision = hook(root, 'codex', 'exec_command', 'git push origin topic', { NDEV_FLOW_GH: gh })
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny')
    const reason = decision.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, expected)
    assert.doesNotMatch(reason, /state merged/)
  }
})

test('the ci check wait is refused only while this session has a live ndev watch', t => {
  const root = fixture(t)
  const state = mkdtempSync(join(tmpdir(), 'ndev-hook-state-'))
  t.after(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({ version: 1, issue: 17, workflow: {
    issue: 17, root, repo: 'o/r', state: 'ci', branch: 'topic', base: 'main', prs: [18],
  } }))
  const env = { XDG_STATE_HOME: state, ORCA_AGENT_SESSION_ID: 'fixture' }
  const wait = 'gh pr checks 18 --watch'
  const unwatched = hook(root, 'claude', 'Bash', wait, env)
  assert.notEqual(unwatched?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(unwatched))
  const watchFile = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { realpathSync } from 'node:fs'; import { hookSessionFile } from ${JSON.stringify(new URL('../scripts/ndev/hooks.mjs', import.meta.url).href)}; console.log(hookSessionFile(realpathSync(process.argv[1]), 'fixture').replace(/\\.json$/, '.watch.json'))`, root,
  ], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(watchFile.status, 0, watchFile.stderr)
  const file = watchFile.stdout.trim()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ root, session: 'fixture', pid: process.pid }))
  const watched = hook(root, 'claude', 'Bash', wait, env)
  assert.equal(watched?.hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(watched.hookSpecificOutput.permissionDecisionReason, /ndev watch reads these checks/)
})

function liveWatcherFixture(t) {
  const root = fixture(t)
  const state = mkdtempSync(join(tmpdir(), 'ndev-hook-state-'))
  t.after(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({ version: 1, issue: 17, workflow: {
    issue: 17, root, repo: 'o/r', state: 'ci', branch: 'topic', base: 'main', prs: [18],
  } }))
  const env = { XDG_STATE_HOME: state, ORCA_AGENT_SESSION_ID: 'fixture' }
  const watchFile = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { realpathSync } from 'node:fs'; import { hookSessionFile } from ${JSON.stringify(new URL('../scripts/ndev/hooks.mjs', import.meta.url).href)}; console.log(hookSessionFile(realpathSync(process.argv[1]), 'fixture').replace(/\\.json$/, '.watch.json'))`, root,
  ], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(watchFile.status, 0, watchFile.stderr)
  mkdirSync(join(watchFile.stdout.trim(), '..'), { recursive: true })
  writeFileSync(watchFile.stdout.trim(), JSON.stringify({ root, session: 'fixture', pid: process.pid }))
  return { root, env }
}

const denied = decision => decision?.hookSpecificOutput?.permissionDecision === 'deny'

test('a live ndev watch does not refuse the ndev wait checks command, and the refusal of a gh watch names it', t => {
  const { root, env } = liveWatcherFixture(t)
  const allowed = hook(root, 'claude', 'Bash', 'ndev wait checks 18', env)
  assert.equal(denied(allowed), false, JSON.stringify(allowed))
  const helper = hook(root, 'claude', 'Bash', 'gh pr checks 18 --watch', env)
  assert.equal(denied(helper), true)
  assert.match(helper.hookSpecificOutput.permissionDecisionReason, /Run ndev wait checks 18 for one blocking wait/)
})

test('a bug report that only quotes a gh watch is not refused, and a quoted gh watch that runs still is', t => {
  const { root, env } = liveWatcherFixture(t)
  const helper = 'gh pr checks 18 --watch'
  for (const command of [
    `gh issue create --title "Wait is refused" --body "Flow status says run ${helper}, and the hook refuses it"`,
    `ndev issue create --body 'Evidence: gh pr checks 18 --watch and gh run watch 5 are refused too'`,
    `printf '%s' "${helper}" > report.txt`,
  ]) assert.equal(denied(hook(root, 'claude', 'Bash', command, env)), false, command)
  for (const command of [`bash -c "${helper}"`, `sh -c '${helper}'`, helper, 'gh run watch 5']) {
    assert.equal(denied(hook(root, 'claude', 'Bash', command, env)), true, command)
  }
})

function recordsFixture(t) {
  const root = fixture(t)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}\n')
  const env = { HOME: root, PATH: process.env.PATH }
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const recordFile = join(root, 'docs/formal/requirements/0001-the-report-names-each-source.md')
  const record = (trace, explanation = 'The report gives a list of each document that it uses.') => `---\nid: REQ-0001\ntitle: "The report names each source"\nstatus: Accepted\norigin: explicit\nlevel: normal\ntype: product\nsection: "Report"\ndate: 2026-01-02\nsource: []\nauthor:\n  - "Neil Ellis"\ndecided_by: "Neil Ellis"\nverification: unassigned\nissues: []\nprs: []\n---\n\n## Statement\n\nThe report names each source.\n\n## Explanation\n\n${explanation}\n\n## Source text\n\n## Trace\n\n${trace}\n\n## Notes\n\n## Log\n\n- 2026-01-02: Created.\n`
  mkdirSync(join(root, 'docs/formal/requirements'), { recursive: true })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/report.js'), 'export {}\n')
  writeFileSync(recordFile, record('- File: src/report.js'))
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  const call = (event, toolName, input, response = {}) => {
    const result = spawnSync(ndev, ['hook', event, '--harness', 'claude'], {
      cwd: root, encoding: 'utf8', env,
      input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: toolName, tool_input: input, tool_response: response }),
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() ? JSON.parse(result.stdout) : null
  }
  return { root, recordFile, record, call, git }
}

const contextOf = result => result?.hookSpecificOutput?.additionalContext ?? ''
const LISTED = /The requirements in force for the files of this commit\. The change must meet each:\n- REQ-0001 The report names each source: The report names each source\./

test('a commit lists the requirements in force of the files that it changes, and does not refuse it', t => {
  const { root, call, git } = recordsFixture(t)
  writeFileSync(join(root, 'src/other.js'), 'export {}\n')
  git('add', 'src/other.js')
  git('commit', '-q', '-m', 'other')
  writeFileSync(join(root, 'src/report.js'), 'export const a = 1\n')
  const unstaged = call('pre-tool-use', 'Bash', { command: 'git commit -m change' })
  assert.doesNotMatch(contextOf(unstaged), /REQ-0001/)
  for (const command of ['git commit -am change', 'git commit --all -m change', 'git commit -m "fix; x" -a', 'git add src/report.js && git commit -m change', 'git add -A && git commit -m change', 'ndev flow checkpoint --message m --file src/report.js', 'ndev flow finished-development --issue 1 --file=src/report.js']) {
    const result = call('pre-tool-use', 'Bash', { command })
    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined, command)
    assert.match(contextOf(result), LISTED, command)
  }
  const inSrc = spawnSync(ndev, ['hook', 'pre-tool-use', '--harness', 'claude'], { cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH }, input: JSON.stringify({ session_id: 'fixture', cwd: join(root, 'src'), tool_name: 'Bash', tool_input: { command: 'ndev flow checkpoint --message m --file report.js' } }) })
  assert.equal(inSrc.status, 0, inSrc.stderr)
  assert.match(contextOf(JSON.parse(inSrc.stdout)), LISTED)
  git('add', 'src/report.js')
  assert.match(contextOf(call('pre-tool-use', 'Bash', { command: 'git commit -m change' })), LISTED)
  git('commit', '-q', '-m', 'report')
  writeFileSync(join(root, 'src/other.js'), 'export const b = 1\n')
  git('add', 'src/other.js')
  assert.doesNotMatch(contextOf(call('pre-tool-use', 'Bash', { command: 'git commit -m change' })), /requirements in force/)
})

test('the first edit of a file in a session lists the requirements of that file, and later edits do not', t => {
  const { root, call } = recordsFixture(t)
  const first = contextOf(call('pre-tool-use', 'Edit', { file_path: join(root, 'src/report.js') }))
  assert.match(first, /The requirements in force for src\/report\.js\. The change must meet each:\n- REQ-0001 The report names each source: The report names each source\./)
  assert.doesNotMatch(contextOf(call('pre-tool-use', 'Edit', { file_path: join(root, 'src/report.js') })), /REQ-0001/)
  assert.doesNotMatch(contextOf(call('pre-tool-use', 'Write', { file_path: join(root, 'src/new.js') })), /requirements in force/)
})

test('the list of requirements stops at 20 records and names the command that prints the rest', t => {
  const { root, recordFile, record, call, git } = recordsFixture(t)
  for (let n = 2; n <= 22; n++) {
    const id = String(n).padStart(4, '0')
    writeFileSync(recordFile.replace('0001', id), record('- File: src/*.js').replace('REQ-0001', `REQ-${id}`))
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'records')
  const listed = contextOf(call('pre-tool-use', 'Edit', { file_path: join(root, 'src/report.js') }))
  assert.equal(listed.match(/^- REQ-\d{4} /gm).length, 20)
  assert.match(listed, /- REQ-0020 [^\n]*\n2 more\. Run: ndev requirements for src\/report\.js/)
})

test('a project with no requirement records gets no list of requirements', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}\n')
  const result = spawnSync(ndev, ['hook', 'pre-tool-use', '--harness', 'claude'], { cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH }, input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'README.md') } }) })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /requirements in force/)
})

test('a project with requirement records refuses a raw gh issue or pr create and names ndev project issue-new or pr-new', t => {
  const { call } = recordsFixture(t)
  for (const command of ['gh issue create --title T --body B', 'cd x && gh -R o/r pr create --fill']) {
    const reason = call('pre-tool-use', 'Bash', { command })?.hookSpecificOutput?.permissionDecisionReason ?? ''
    assert.match(reason, /must cite one in force.*Use ndev project (issue|pr)-new --title/, command)
  }
  assert.equal(call('pre-tool-use', 'Bash', { command: 'gh issue view 3' }), null)
  assert.equal(call('pre-tool-use', 'Bash', { command: 'echo "gh issue create"' }), null)
})

test('a project with no requirement records allows a raw gh issue create', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}\n')
  assert.equal(hook(root, 'claude', 'Bash', 'gh issue create --title T --body B', { HOME: root, PATH: process.env.PATH }), null)
})

test('a changed record that links a missing file is reported once after the edit, and refuses a commit until it is corrected', t => {
  const { recordFile, record, call } = recordsFixture(t)
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -m clean' }), null)
  writeFileSync(recordFile, record('- File: src/report.js\n- File: src/gone.js'))
  const note = call('post-tool-use', 'Edit', { file_path: recordFile }).hookSpecificOutput.additionalContext
  assert.match(note, /"- File: src\/gone\.js" matches no tracked file/)
  assert.equal(call('post-tool-use', 'Bash', { command: 'ls' }, { exitCode: 0 }), null)
  for (const command of ['git commit -am change', 'ndev flow checkpoint --issue 3']) {
    const reason = call('pre-tool-use', 'Bash', { command }).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /have problems, so this commit is refused:[\s\S]*src\/gone\.js[\s\S]*ndev requirements links --base HEAD/, command)
  }
  writeFileSync(recordFile, record('- File: src/report.js'))
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }), null)
})

test('a changed record with no Explanation is reported after the edit, and refuses a commit until it has one', t => {
  const { recordFile, record, call } = recordsFixture(t)
  writeFileSync(recordFile, record('- File: src/report.js', ''))
  const note = call('post-tool-use', 'Write', { file_path: recordFile }).hookSpecificOutput.additionalContext
  assert.match(note, /REQ-0001: the section "## Explanation" is empty, and the Statement has text/)
  const reason = call('pre-tool-use', 'Bash', { command: 'git commit -am change' }).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /this commit is refused:[\s\S]*## Explanation" is empty[\s\S]*ndev requirements explained --base HEAD/)
  writeFileSync(recordFile, record('- File: src/report.js', 'Each document that the report reads is named in it.'))
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }), null)
})

test('a changed record with no level or a wrong level is reported after the edit, and refuses a commit until it has a valid one', t => {
  const { recordFile, record, call } = recordsFixture(t)
  for (const [text, problem] of [[record('- File: src/report.js').replace('level: normal\n', ''), /REQ-0001: no "level"/], [record('- File: src/report.js').replace('level: normal', 'level: urgent'), /REQ-0001: level "urgent" is not soft, normal or hard/]]) {
    writeFileSync(recordFile, text)
    const note = call('post-tool-use', 'Edit', { file_path: recordFile }).hookSpecificOutput.additionalContext
    assert.match(note, problem)
    const reason = call('pre-tool-use', 'Bash', { command: 'git commit -am change' }).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, new RegExp(`this commit is refused:[\\s\\S]*${problem.source}[\\s\\S]*ndev requirements levels --base HEAD`))
  }
  writeFileSync(recordFile, record('- File: src/report.js').replace('level: normal', 'level: hard'))
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }), null)
})

test('a changed record with no type or a wrong type is reported after the edit, and refuses a commit until it has a valid one', t => {
  const { recordFile, record, call } = recordsFixture(t)
  for (const [text, problem] of [[record('- File: src/report.js').replace('type: product\n', ''), /REQ-0001: no "type"/], [record('- File: src/report.js').replace('type: product', 'type: feature'), /REQ-0001: type "feature" is not principle/]]) {
    writeFileSync(recordFile, text)
    const note = call('post-tool-use', 'Edit', { file_path: recordFile }).hookSpecificOutput.additionalContext
    assert.match(note, problem)
    const reason = call('pre-tool-use', 'Bash', { command: 'git commit -am change' }).hookSpecificOutput.permissionDecisionReason
    assert.match(reason, new RegExp(`this commit is refused:[\\s\\S]*${problem.source}[\\s\\S]*ndev requirements types --base HEAD`))
  }
  writeFileSync(recordFile, record('- File: src/report.js').replace('type: product', 'type: ux'))
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }), null)
})

test('a merge commit is not refused for records the merged branch brought in, and is refused for a record the merge changes', t => {
  const { root, recordFile, record, call, git } = recordsFixture(t)
  git('checkout', '-q', '-b', 'incoming')
  writeFileSync(recordFile.replace('0001-the-report-names-each-source', '0002-a-new-rule'), record('- File: src/report.js').replace('REQ-0001', 'REQ-0002').replace('type: product\n', ''))
  git('add', '-A')
  git('commit', '-q', '-m', 'untyped record')
  git('checkout', '-q', '-')
  writeFileSync(join(root, 'src/other.js'), 'export {}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'other')
  git('merge', '-q', '--no-commit', '--no-ff', 'incoming')
  for (const command of ['git commit -m merge', 'ndev flow checkpoint --issue 3']) {
    const output = call('pre-tool-use', 'Bash', { command })?.hookSpecificOutput
    assert.equal(output?.permissionDecision, undefined, `${command}: ${output?.permissionDecisionReason}`)
  }
  writeFileSync(recordFile, record('- File: src/report.js').replace('level: normal\n', ''))
  const reason = call('pre-tool-use', 'Bash', { command: 'git commit -am merge' }).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /this commit is refused:[\s\S]*REQ-0001: no "level"[\s\S]*ndev requirements levels --base MERGE_HEAD/)
  assert.doesNotMatch(reason, /REQ-0002/)
})

test('a pass saved during a merge is not reused for a squash of the same records after the merge is aborted', t => {
  const { root, recordFile, record, call, git } = recordsFixture(t)
  git('checkout', '-q', '-b', 'incoming')
  writeFileSync(recordFile.replace('0001-the-report-names-each-source', '0002-a-new-rule'), record('- File: src/report.js').replace('REQ-0001', 'REQ-0002').replace('type: product\n', ''))
  git('add', '-A')
  git('commit', '-q', '-m', 'untyped record')
  git('checkout', '-q', '-')
  git('merge', '-q', '--no-commit', '--no-ff', 'incoming')
  assert.equal(call('pre-tool-use', 'Bash', { command: 'git commit -m merge' })?.hookSpecificOutput?.permissionDecision, undefined)
  git('merge', '--abort')
  git('merge', '-q', '--squash', 'incoming')
  const reason = call('pre-tool-use', 'Bash', { command: 'git commit -m squash' })?.hookSpecificOutput?.permissionDecisionReason ?? ''
  assert.match(reason, /this commit is refused:[\s\S]*REQ-0002: no "type"[\s\S]*ndev requirements types --base HEAD/)
})

test('a commit is checked again after a link problem is repaired outside the record', t => {
  const { root, recordFile, record, call } = recordsFixture(t)
  writeFileSync(recordFile, record('- File: src/new.js'))
  writeFileSync(join(root, 'src/new.js'), 'export {}\n')
  assert.match(call('post-tool-use', 'Edit', { file_path: recordFile }).hookSpecificOutput.additionalContext, /src\/new\.js" matches no tracked file/)
  assert.match(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }).hookSpecificOutput.permissionDecisionReason, /src\/new\.js/)
  spawnSync('git', ['add', 'src/new.js'], { cwd: root })
  const repaired = call('pre-tool-use', 'Bash', { command: 'git commit -am change' })
  assert.equal(repaired?.hookSpecificOutput?.permissionDecision, undefined)
  assert.match(contextOf(repaired), /The requirements in force for the files of this commit\.[^]*REQ-0001/)
})

test('an edit that changes the id, title, author or origin of a record is refused, and other edits are not', t => {
  const { root, recordFile, record, call } = recordsFixture(t)
  const text = record('- File: src/report.js')
  const refused = /REQ-0001 keeps its id, title, author and origin after it is created, and this edit changes the (title|author|origin)\. Leave them as they are\. To change the requirement, ask the human to deprecate the record and create a new one: ndev requirements deprecate REQ-0001/
  const denied = result => result?.hookSpecificOutput?.permissionDecision === 'deny' ? result.hookSpecificOutput.permissionDecisionReason : ''
  assert.match(denied(call('pre-tool-use', 'Edit', { file_path: recordFile, old_string: 'title: "The report names each source"', new_string: 'title: "The report names every source"' })), refused)
  assert.match(denied(call('pre-tool-use', 'Edit', { file_path: recordFile, old_string: 'origin: explicit', new_string: 'origin: implied', replace_all: true })), refused)
  assert.match(denied(call('pre-tool-use', 'Write', { file_path: recordFile, content: text.replace('"Neil Ellis"\ndecided_by', '"Ann Smith"\ndecided_by') })), refused)
  assert.match(denied(call('pre-tool-use', 'MultiEdit', { file_path: recordFile, edits: [{ old_string: 'level: normal', new_string: 'level: hard' }, { old_string: 'origin: explicit', new_string: 'origin: PR' }] })), refused)
  assert.equal(denied(call('pre-tool-use', 'Edit', { file_path: recordFile, old_string: 'level: normal', new_string: 'level: hard' })), '')
  assert.equal(denied(call('pre-tool-use', 'Write', { file_path: recordFile.replace('0001-the-report-names-each-source', '0002-a-new-rule'), content: text.replace('REQ-0001', 'REQ-0002') })), '')
  mkdirSync(join(root, 'docs/formal/deprecated'))
  const moved = join(root, 'docs/formal/deprecated/0001-the-report-names-each-source.md')
  writeFileSync(moved, text)
  assert.match(denied(call('pre-tool-use', 'Edit', { file_path: moved, old_string: 'origin: explicit', new_string: 'origin: implied' })), refused)
})

test('a record whose fixed field changed outside an edit tool blocks the commit', t => {
  const { root, recordFile, record, call } = recordsFixture(t)
  writeFileSync(recordFile, record('- File: src/report.js').replace('origin: explicit', 'origin: implied'))
  assert.match(contextOf(call('post-tool-use', 'Bash', { command: 'sed -i x' })), /the origin changed since HEAD/)
  assert.match(call('pre-tool-use', 'Bash', { command: 'git commit -am change' }).hookSpecificOutput.permissionDecisionReason, /the origin changed since HEAD[^]*ndev requirements fixed --base HEAD/)
})

function hookEvent(root, event, payload = {}, { harness = 'claude', env = {} } = {}) {
  const result = spawnSync(ndev, ['hook', event, '--harness', harness], {
    cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH, ...env },
    input: JSON.stringify({ session_id: 'fixture', cwd: root, ...payload }),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

const textOf = output => output?.hookSpecificOutput?.additionalContext ?? output?.additionalContext ?? output?.systemMessage ?? ''

function quietFixture(t, config = { workflow: false }) {
  const root = fixture(t)
  rmSync(join(root, '.neil-dev.issue-17.json'))
  mkdirSync(join(root, 'dev-wiki'))
  writeFileSync(join(root, 'dev-wiki/wiki.md'), '')
  writeFileSync(join(root, '.ndev.json'), JSON.stringify(config))
  return root
}

function projectCli(root, ...args) {
  const result = spawnSync(ndev, ['project', ...args, '--json'], { cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH } })
  return { status: result.status, ...JSON.parse(result.stdout) }
}

test('project learn returns the lesson workflow with the shared and the project wiki', t => {
  const root = quietFixture(t)
  const learned = projectCli(root, 'learn')
  assert.equal(learned.ok, true)
  assert.equal(learned.result.skill, 'ndev-dev-wiki')
  assert.match(learned.result.text, /ndev-dev-wiki.*reusable lessons.*ndev-remember for project facts/s)
})

test('session start offers GitHub setup until a selected or typed answer is saved', t => {
  const root = quietFixture(t)
  const offer = /Use ndev project setup to set the GitHub repository and board\./
  assert.match(textOf(hookEvent(root, 'session-start')), offer)
  const saved = projectCli(root, 'setup', '--repo', 'owner/example', '--board', 'owner/3')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const configured = textOf(hookEvent(root, 'session-start'))
  assert.doesNotMatch(configured, offer)
  assert.match(configured, /GitHub repository owner\/example, board owner\/3\./)
  assert.equal(projectCli(root, 'setup', '--no-repo').ok, true)
  assert.doesNotMatch(textOf(hookEvent(root, 'session-start')), /GitHub repository|ndev project setup/)
})

test('session start seeds an absent shared wiki and reports a wiki folder with no index', t => {
  const root = quietFixture(t)
  const home = mkdtempSync(join(tmpdir(), 'ndev-hook-wiki-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const start = () => textOf(hookEvent(root, 'session-start', {}, { env: { HOME: home } }))
  assert.doesNotMatch(start(), /dev-wiki exists/)
  assert.ok(existsSync(join(home, 'dev-wiki/wiki.md')))
  assert.ok(existsSync(join(home, 'dev-wiki/AGENTS.md')))
  rmSync(join(home, 'dev-wiki/wiki.md'))
  writeFileSync(join(home, 'dev-wiki/notes.md'), 'kept\n')
  assert.match(start(), new RegExp(`${join(home, 'dev-wiki')} exists without wiki\\.md\\. Move it aside or restore wiki\\.md`))
  assert.equal(readFileSync(join(home, 'dev-wiki/notes.md'), 'utf8'), 'kept\n')
  assert.equal(existsSync(join(home, 'dev-wiki/wiki.md')), false)
})

test('an unbuilt worktree names ndev project init at session start and prompt submit, and init reports failure and repair', t => {
  const root = quietFixture(t)
  const trigger = /This worktree needs its project build\. Run ndev project init\./
  const script = join(root, 'scripts/init-project.sh')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(script, 'echo building\necho broken dependency >&2\nexit 4\n')
  assert.match(textOf(hookEvent(root, 'session-start')), trigger)
  assert.match(textOf(hookEvent(root, 'prompt-submit', { prompt: 'continue' })), trigger)
  const unignored = projectCli(root, 'init')
  assert.equal(unignored.ok, false)
  assert.match(unignored.error.repair, /Add \.ndev-inited to the Git ignore rules/)
  writeFileSync(join(root, '.gitignore'), '.ndev-inited\n')
  const failed = projectCli(root, 'init')
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /init-project\.sh exited 4: building\nbroken dependency/)
  assert.match(failed.error.repair, /^Fix \S*\/scripts\/init-project\.sh and run ndev project init\.$/)
  assert.equal(existsSync(join(root, '.ndev-inited')), false)
  writeFileSync(script, 'echo built\n')
  const built = projectCli(root, 'init')
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.result.text, 'built')
  assert.ok(existsSync(join(root, '.ndev-inited')))
  assert.doesNotMatch(textOf(hookEvent(root, 'session-start')), trigger)
  assert.doesNotMatch(textOf(hookEvent(root, 'prompt-submit', { prompt: 'continue' })), trigger)
})

test('prompt submit reloads changed settings and adds correction guidance to a human correction only', t => {
  const root = quietFixture(t, { workflow: false, mode: 'light' })
  const lesson = /Apply the correction\. Record reusable lessons with ndev-dev-wiki or project facts with ndev-remember\./
  const first = textOf(hookEvent(root, 'prompt-submit', { prompt: 'Please add the parser test.' }))
  assert.match(first, /Mode light\./)
  assert.doesNotMatch(first, lesson)
  writeFileSync(join(root, '.ndev.json'), JSON.stringify({ workflow: false, mode: 'heavy' }))
  const corrected = textOf(hookEvent(root, 'prompt-submit', { prompt: "No, don't mock the parser." }))
  assert.match(corrected, /Mode heavy\..*Load ndev-work-heavy/s)
  assert.match(corrected, lesson)
  assert.match(textOf(hookEvent(root, 'prompt-submit', { prompt: 'From now on, run the linter first.' })), lesson)
  assert.doesNotMatch(textOf(hookEvent(root, 'prompt-submit', { prompt: 'Issue #17 is in developing. Run ndev flow status for the next action and keep working or record the blocker.' })), lesson)
})

test('prompt context supplies mode, steering, brand, GitHub, wiki, report, setup and active work', t => {
  const root = quietFixture(t, { mode: 'heavy', steering: 'auto', branding: { site: 'https://brand.example' }, github: { repo: 'owner/example', board: { owner: 'owner', number: 3 } } })
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main', mode: 'heavy', steering: 'auto' },
  }))
  for (const harness of ['claude', 'codex', 'opencode']) {
    const context = textOf(hookEvent(root, 'prompt-context', {}, { harness }))
    assert.match(context, /Mode heavy\. Steering auto\. Load ndev-work-heavy-auto for development work\./, harness)
    assert.match(context, /GitHub repository owner\/example, board owner\/3\./, harness)
    assert.match(context, /Use the project brand at https:\/\/brand\.example\./, harness)
    assert.match(context, /Use ndev-dev-wiki for reusable lessons and ndev-remember for project facts\./, harness)
    assert.match(context, /Report decisions needed, PRs and their check status, and any follow-up issues for review\./, harness)
    assert.match(context, /Issue #17 is in developing\. Run ndev flow status for the next step\./, harness)
  }
  writeFileSync(join(root, '.ndev.json'), '{}')
  rmSync(join(root, '.neil-dev.issue-17.json'))
  const fresh = textOf(hookEvent(root, 'prompt-context'))
  assert.match(fresh, /Mode light\. Steering interactive\. Load ndev-work-light for development work\./)
  assert.match(fresh, /Use ndev project setup to set the GitHub repository and board\./)
  assert.match(fresh, /For GitHub issue work, run ndev flow start <issue> or ndev flow create\./)
  writeFileSync(join(root, '.gitignore'), '.neil-dev.epic-*.json\n')
  writeFileSync(join(root, '.neil-dev.epic-5.json'), JSON.stringify({
    epic: 5, state: 'coordinating', roles: { implementer: { agent: 'claude' }, reviewer: { agent: 'codex' } }, parallel: 1, evidence: {}, history: [], issues: {}, owner: { session: 'fixture' },
  }))
  const epic = textOf(hookEvent(root, 'prompt-context', {}, { env: { ORCA_AGENT_SESSION_ID: 'fixture' } }))
  assert.match(epic, /Epic #5 is in coordinating\. Run ndev epic status 5 for the coordinator's next action\./)
  assert.doesNotMatch(epic, /ndev flow start/)
})

test('a configured subscription warning reaches the agent and lets the matched command run', t => {
  const root = quietFixture(t, { workflow: false, quality: { subscriptionWarning: { gateVar: 'FIXTURE_GATE' } } })
  for (const command of ['claude -p "summarize"', 'FIXTURE_GATE=1 ./run.sh']) {
    const output = hookEvent(root, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command } })
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined, command)
    assert.match(textOf(output), /WARNING: this command can spend the user's subscription.*FIXTURE_GATE gate/, command)
  }
  assert.equal(hookEvent(root, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' } }), null)
  writeFileSync(join(root, '.ndev.json'), '{"workflow":false}')
  assert.equal(hookEvent(root, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'claude -p "summarize"' } }), null)
})

test('edited file checks report findings outside a workflow and leave the check to a workflow that owns it', t => {
  const root = quietFixture(t, { workflow: false, quality: { editedFileGuards: {} } })
  writeFileSync(join(root, 'sgconfig.yml'), 'ruleDirs: []\n')
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules/.bin/ast-grep'), '#!/bin/sh\necho "fixture-rule: banned call at $2:1"\nexit 1\n', { mode: 0o755 })
  const file = join(root, 'source.ts')
  writeFileSync(file, 'banned()\n')
  const edit = (env = {}) => hookEvent(root, 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file }, tool_response: {} }, { env })
  assert.match(textOf(edit()), new RegExp(`The guards refuse ${file}\\.[\\s\\S]*fixture-rule: banned call at ${file}:1[\\s\\S]*Fix the file\\.`))
  writeFileSync(join(root, '.ndev.json'), JSON.stringify({ quality: { editedFileGuards: {} } }))
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main' },
  }))
  assert.equal(edit(), null)
})

test('a commit outside a workflow returns the configured check reminder', t => {
  const root = quietFixture(t, { workflow: false, quality: { precheckReminder: { command: './scripts/check-all.sh' } } })
  const after = command => textOf(hookEvent(root, 'post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_response: { exitCode: 0 } }))
  assert.match(after('git commit -m "fix parser"'), /Reminder: run \.\/scripts\/check-all\.sh before you push \(recommended, not forced\)\./)
  assert.equal(after('git status'), '')
  assert.equal(textOf(hookEvent(root, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { exitCode: 1 } })), '')
})

test('a worktree add starts submodule setup and reports a failed setup with the command output', t => {
  const root = quietFixture(t, { workflow: false, quality: { worktreeSubmodules: { paths: ['vendor/lib'] } } })
  const env = { HOME: root, PATH: process.env.PATH, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const library = join(root, 'library')
  mkdirSync(library)
  git(library, 'init', '-q')
  writeFileSync(join(library, 'lib.txt'), 'library\n')
  git(library, 'add', '.')
  git(library, 'commit', '-q', '-m', 'library')
  writeFileSync(join(root, '.gitignore'), 'library/\nlinked/\nbroken/\n.ndev.json\ndev-wiki/\n')
  git(root, 'submodule', 'add', '-q', library, 'vendor/lib')
  git(root, 'add', '.gitignore')
  git(root, 'commit', '-q', '-m', 'fixture')
  const linked = join(root, 'linked')
  git(root, 'worktree', 'add', '-q', linked)
  const added = hookEvent(root, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: `git worktree add ${linked}` }, tool_response: { exitCode: 0 } }, { env })
  assert.equal(added, null)
  assert.equal(readFileSync(join(linked, 'vendor/lib/lib.txt'), 'utf8'), 'library\n')
  const broken = join(root, 'broken')
  git(root, 'worktree', 'add', '-q', broken)
  rmSync(library, { recursive: true, force: true })
  const failed = textOf(hookEvent(root, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: `git worktree add ${broken}` }, tool_response: { exitCode: 0 } }, { env }))
  assert.match(failed, new RegExp(`init-worktree-submodules: could not initialise vendor/lib in ${broken}: [\\s\\S]*library[\\s\\S]*Run by hand: git -C ${broken} submodule update --init -- vendor/lib`))
})

test('prompt context lists the services a worktree still runs and the repair of each failed stop', t => {
  const root = quietFixture(t, { workflow: false, github: { repo: null } })
  const record = join(root, '.neil-dev.worktree.json')
  const failedStop = { at: '2026-11-24T10:00:00Z', command: 'supabase stop --project-id fixture-db', exitCode: 1, output: 'container fixture-db is busy', repair: 'docker rm -f supabase_db_fixture-db' }
  const stack = { kind: 'supabase', projectId: 'live-db', workdir: root, cliVersion: '2.0.0', addedAt: '2026-11-24T09:00:00Z' }
  writeFileSync(record, JSON.stringify({ version: 2, resources: {
    docker: [{ ...stack, projectId: 'fixture-db', lastStop: failedStop }, stack],
    'dev-servers': { web: { pid: 4242, port: 3000, command: 'npm run dev', cwd: root, started: '2026-11-24T09:00:00Z' } },
  } }))
  for (const harness of ['claude', 'opencode']) {
    const context = textOf(hookEvent(root, 'prompt-context', {}, { harness }))
    assert.match(context, /Worktree stacks: a stop at an earlier session end failed/, harness)
    assert.match(context, /- supabase stack fixture-db .*did not stop at 2026-11-24T10:00:00Z\.\n {2}command: supabase stop --project-id fixture-db; exit code 1\n {2}output: container fixture-db is busy\n {2}repair: docker rm -f supabase_db_fixture-db\n {2}then: bash \S+worktree-env\.sh remove-stack --kind supabase --project-id fixture-db --worktree \S+/, harness)
    assert.match(context, /still lists supabase live-db, which may run from an earlier session\..*stop-all --worktree/, harness)
    assert.match(context, /still lists dev server web \(pid 4242, port 3000\)/, harness)
  }
  writeFileSync(join(root, '.ndev.json'), JSON.stringify({ workflow: false, github: { repo: null }, worktreeStacks: { onSessionEnd: 'keep-running' } }))
  const kept = textOf(hookEvent(root, 'prompt-context'))
  assert.doesNotMatch(kept, /still lists supabase live-db/)
  assert.match(kept, /supabase stack fixture-db/)
  writeFileSync(record, JSON.stringify({ version: 2, resources: { docker: [], 'dev-servers': {} } }))
  assert.doesNotMatch(textOf(hookEvent(root, 'prompt-context')), /Worktree (stacks|dev servers)/)
  writeFileSync(record, JSON.stringify({ version: 2, resources: { docker: 'broken' } }))
  const invalid = spawnSync(ndev, ['hook', 'prompt-context', '--harness', 'claude'], {
    cwd: root, encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH }, input: JSON.stringify({ session_id: 'fixture', cwd: root }),
  })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /\.neil-dev\.worktree\.json/)
  assert.match(invalid.stderr, /Repair:/)
})

test('a main session compaction asks the next context hook once to load the work skill again', t => {
  const root = quietFixture(t, { workflow: false, mode: 'heavy', github: { repo: null } })
  const reload = /The context was compacted, so the loaded skills are gone\. Load ndev-work-heavy again before more development work\./
  assert.doesNotMatch(textOf(hookEvent(root, 'prompt-context')), reload)
  hookEvent(root, 'compact', { agent_id: 'helper' })
  assert.doesNotMatch(textOf(hookEvent(root, 'prompt-context')), reload)
  hookEvent(root, 'compact', { trigger: 'auto' })
  for (const harness of ['claude', 'opencode']) {
    assert.match(textOf(hookEvent(root, harness === 'claude' ? 'prompt-submit' : 'prompt-context', { prompt: 'continue' }, { harness })), reload, harness)
    assert.doesNotMatch(textOf(hookEvent(root, 'prompt-context', {}, { harness })), reload, harness)
    hookEvent(root, 'compact', {}, { harness })
  }
})

test('a live ndev watch refuses a wait on the watched PR and allows the wait on a hotfix PR', t => {
  const { root, env } = liveWatcherFixture(t)
  for (const command of ['gh pr checks 18 --watch', 'gh pr checks --watch', 'gh run watch 991', 'gh pr checks 31 --watch && gh run watch 991', 'gh pr checks 31 --watch; gh pr checks 18 --watch']) {
    assert.equal(denied(hook(root, 'claude', 'Bash', command, env)), true, command)
  }
  for (const command of ['gh pr checks 31 --watch', 'gh pr checks 31 --watch --interval 30']) {
    assert.equal(denied(hook(root, 'claude', 'Bash', command, env)), false, command)
  }
})

function antigravity(root, event, payload, env = {}) {
  const result = spawnSync(ndev, ['hook', event, '--harness', 'antigravity'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
    input: JSON.stringify({ conversationId: 'fixture', cwd: root, workspacePaths: [root], lastUserInput: 'go', ...payload }),
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('Antigravity hooks deny a guarded commit and allow other commands in its own format', t => {
  const root = fixture(t)
  const shell = CommandLine => ({ toolCall: { id: 'call_1', name: 'run_command', args: { CommandLine } } })
  const denied = antigravity(root, 'pre-tool-use', shell("bash -c 'git commit -m test'"))
  assert.equal(denied.decision, 'deny')
  assert.match(denied.reason, /issue #17.*ndev flow checkpoint/i)
  assert.deepEqual(antigravity(root, 'pre-tool-use', shell('echo hi')), { decision: 'allow' })
})

test('Antigravity gets context at its first model call of a turn and a plain stop answer', t => {
  const root = fixture(t)
  const steps = answer => answer.injectSteps?.map(step => step.systemMessage?.systemMessage).join('\n') ?? ''
  assert.match(steps(antigravity(root, 'session-start', {})), /Mode light/)
  assert.match(steps(antigravity(root, 'prompt-submit', { invocationNum: 0, initialNumSteps: 1 })), /Mode light/)
  assert.doesNotMatch(steps(antigravity(root, 'prompt-submit', { invocationNum: 1, initialNumSteps: 3 })), /Mode light/)
  assert.deepEqual(antigravity(root, 'turn-complete', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', fullyIdle: true }), { decision: '' })
})

test('Antigravity edits reach the requirement hooks, and their notes arrive at the next model call', t => {
  const { root } = recordsFixture(t)
  const env = { HOME: root, PATH: process.env.PATH, ORCA_AGENT_SESSION_ID: '' }
  const file = join(root, 'src/report.js')
  const edits = [
    ['edit_file', { Path: file, Target: 'export {}', Replacement: 'export const a = 1' }],
    ['replace_file_content', { TargetFile: file, TargetContent: 'export {}', ReplacementContent: 'export const a = 1' }],
    ['multi_replace_file_content', { TargetFile: file, ReplacementChunks: [{ TargetContent: 'export {}', ReplacementContent: 'export const a = 1' }] }],
    ['write_to_file', { TargetFile: file, CodeContent: 'export const a = 1\n' }],
  ]
  for (const [index, [name, args]] of edits.entries()) {
    const conversation = { conversationId: `edit-${index}` }
    assert.deepEqual(antigravity(root, 'pre-tool-use', { ...conversation, toolCall: { id: 'call_2', name, args } }, env), { decision: 'allow' }, name)
    const steps = antigravity(root, 'prompt-submit', { ...conversation, invocationNum: 1, initialNumSteps: 3 }, env).injectSteps?.map(step => step.systemMessage.systemMessage).join('\n') ?? ''
    assert.match(steps, /The requirements in force for src\/report\.js\. The change must meet each:\n- REQ-0001 The report names each source/, name)
    assert.equal(antigravity(root, 'prompt-submit', { ...conversation, invocationNum: 2, initialNumSteps: 5 }, env).injectSteps, undefined, name)
  }
})

test('the Antigravity Git guard checks the worktree that run_command names in Cwd', t => {
  const root = fixture(t)
  const elsewhere = mkdtempSync(join(tmpdir(), 'ndev-hook-outside-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  const answer = antigravity(elsewhere, 'pre-tool-use', { cwd: elsewhere, workspacePaths: [elsewhere], toolCall: { id: 'call_3', name: 'run_command', args: { CommandLine: 'git commit -m test', Cwd: root } } })
  assert.equal(answer.decision, 'deny')
  assert.match(answer.reason, /issue #17/i)
})
