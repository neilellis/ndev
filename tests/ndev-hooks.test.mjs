import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
