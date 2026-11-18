import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

function hook(root, harness, toolName, command) {
  const result = spawnSync(ndev, ['hook', 'pre-tool-use', '--harness', harness], {
    cwd: root, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'fixture', cwd: root, tool_name: toolName, tool_input: { command } }),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

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
  const stale = [codex(6, 200_001)]
  assert.notEqual(call('codex', 'draft', stale).decision, 'block')
  writeFileSync(enabled, '')
  assert.notEqual(call('codex', 'draft', stale, '').decision, 'block')
  assert.notEqual(call('codex', 'draft', [codex(6, 200_000)]).decision, 'block')
  assert.notEqual(call('codex', 'draft', [codex(4, 300_000)]).decision, 'block')
  const blocked = call('codex', 'draft', stale)
  assert.equal(blocked.decision, 'block')
  assert.match(blocked.reason, /200,001 tokens.*\/compact/)
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
