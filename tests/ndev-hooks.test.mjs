import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
