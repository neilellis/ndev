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
  writeFileSync(projectFile('.neil-dev.json'), config)
  writeFileSync(projectFile('.neil-dev.env'), credentials, { mode: 0o644 })
  writeFileSync(projectFile('.neil-dev.worktree.json'), '{"version":1,"stacks":["different checkout"]}\n')
  const first = start()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(linkedFile('.neil-dev.json'), 'utf8'), config)
  assert.equal(readFileSync(linkedFile('.neil-dev.env'), 'utf8'), credentials)
  assert.equal(statSync(linkedFile('.neil-dev.env')).mode & 0o777, 0o600)
  const record = linkedFile('.neil-dev.worktree.json')
  const fresh = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(fresh, { version: 2, resources: { docker: [], 'dev-servers': {} } })
  assert.doesNotMatch(first.stdout + first.stderr, /fixture-only-secret/)
  assert.doesNotMatch(first.stdout, /Ask which issue/)
  assert.equal(checkedGit(linked, 'check-ignore', '.neil-dev.env', '.neil-dev.worktree.json'), '.neil-dev.env\n.neil-dev.worktree.json')
  writeFileSync(linkedFile('.neil-dev.json'), '{"mode":"light"}\n')
  writeFileSync(linkedFile('.neil-dev.env'), 'FIXTURE_API_KEY=local\n')
  writeFileSync(record, JSON.stringify({ ...fresh, settings: { steering: 'auto' } }))
  const again = start('claude')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(linkedFile('.neil-dev.json'), 'utf8'), '{"mode":"light"}\n')
  assert.equal(readFileSync(linkedFile('.neil-dev.env'), 'utf8'), 'FIXTURE_API_KEY=local\n')
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).settings, { steering: 'auto' })
})

test('session start creates defaults when neither checkout has project files', t => {
  const { main, linked, checkedGit, start } = linkedFixture(t)
  const result = start('opencode')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(linked, '.neil-dev.json'), 'utf8')), { mode: 'light', steering: 'interactive' })
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
  assert.equal(JSON.parse(readFileSync(join(linked, '.neil-dev.json'), 'utf8')).mode, 'light')
  assert.equal(statSync(join(linked, '.neil-dev.env')).mode & 0o777, 0o600)
  assert.ok(existsSync(join(linked, '.neil-dev.worktree.json')))
})

test('session start does not copy project files from a separate Git metadata directory', t => {
  const { linked, metadata, start } = linkedFixture(t, '', true)
  writeFileSync(join(metadata, '.neil-dev.json'), '{"mode":"heavy"}')
  writeFileSync(join(metadata, '.neil-dev.env'), 'FIXTURE_WRONG_SOURCE=metadata\n')
  const result = start()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(linked, '.neil-dev.json'), 'utf8')).mode, 'light')
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
    writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ workflow: scope !== 'project' }))
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

test('a successful component edit gives one reuse prompt per file and session', t => {
  const root = fixture(t)
  writeFileSync(join(root, '.neil-dev.json'), '{"workflow":false}\n')
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
  writeFileSync(join(root, '.neil-dev.json'), '{"workflow":false}\n')
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
  writeFileSync(join(root, '.neil-dev.json'), '{"github":{"repo":"neilellis/ndev"}}')
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
  writeFileSync(join(root, '.neil-dev.json'), '{"workflow":false}')
  assert.match(start('startup').systemMessage, /Workflow is disabled.*ndev flow on --project/)
})

test('native chat prompt guard blocks stale sends and allows retry after local compaction', t => {
  const root = fixture(t)
  const state = join(root, 'state')
  const enabled = join(state, 'ndev', 'chat-guard')
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
  writeFileSync(enabled, '')
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

test('chat guard continue passes the saved request once without launching a new chat', t => {
  const root = fixture(t)
  const state = join(root, 'state')
  mkdirSync(join(state, 'ndev'), { recursive: true })
  writeFileSync(join(state, 'ndev', 'chat-guard'), '')
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
  mkdirSync(join(state, 'ndev'), { recursive: true })
  writeFileSync(join(state, 'ndev', 'chat-guard'), '')
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
  ]) {
    writeFileSync(gh, `#!/bin/sh\n${body}\n`)
    const decision = hook(root, 'codex', 'exec_command', 'git push origin topic', { NDEV_FLOW_GH: gh })
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny')
    const reason = decision.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, expected)
    assert.doesNotMatch(reason, /state merged/)
  }
})
