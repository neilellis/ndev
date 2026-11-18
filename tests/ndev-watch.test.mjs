import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, { remoteChanges = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-watch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: root, PATH: `${root}${delimiter}${process.env.PATH}`, ORCA_TERMINAL_HANDLE: 'term_fixture', ORCA_CLI_COMMAND: join(root, 'orca'), NDEV_WORKFLOW_CHECK_MS: '1' }
  mkdirSync(join(root, 'home'))
  const git = (...argv) => {
    const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture')
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({
    version: 1, issue: 17, workflow: { issue: 17, root, repo: 'example/example', state: 'ci', branch: 'topic', base: 'main', prs: [39], owner: { session: 'fixture' } },
  }))
  writeFileSync(join(root, 'gh'), `#!/bin/sh
case "$1 $2" in
  'pr view')
    case "$*" in
      *statusCheckRollup*) printf '%s\n' '{"state":"OPEN","headRefOid":"${sha}","mergeable":"MERGEABLE","statusCheckRollup":[{"name":"test","status":"COMPLETED","conclusion":"SUCCESS"}]}' ;;
      *) printf '%s\n' '{"headRefOid":"${remoteChanges ? sha.split('').reverse().join('') : sha}"}' ;;
    esac ;;
  *) printf '%s\n' "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, 'orca'), `#!/bin/sh
case "$1 $2" in
  'terminal list') printf '%s\n' '{"ok":true,"result":{"terminals":[{"handle":"term_fixture","writable":true}]}}' ;;
  'terminal send') printf '%s\n' "$*" >> "${root}/delivered"; printf '%s\n' '{"ok":true,"result":{"accepted":true,"requestId":"fixture-send"}}' ;;
  *) printf '%s\n' "unexpected orca $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  return { root, env, sha }
}

test('watch reports green checks once for the current head through Orca', t => {
  const { root, env, sha } = fixture(t)
  const once = () => {
    const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout).result
  }
  const first = once()
  assert.equal(first.notices.length, 1)
  assert.match(first.notices[0].message, new RegExp(sha.slice(0, 8)))
  assert.match(readFileSync(join(root, 'delivered'), 'utf8'), /ndev flow finished-checks/)
  assert.equal(once().notices.length, 0)
  assert.equal(readFileSync(join(root, 'delivered'), 'utf8').match(/terminal send/g).length, 1)
})

test('watch drops a check result when the GitHub head changes before delivery', t => {
  const { root, env } = fixture(t, { remoteChanges: true })
  const result = spawnSync(ndev, ['watch', '--session', 'fixture', '--once', '--json'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout).result.notices, [])
})
