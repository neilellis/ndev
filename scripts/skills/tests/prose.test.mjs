import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const readability = join(repo, 'scripts/docs/readability.sh')
const hasVale = spawnSync('vale', ['--version']).status === 0

test('every SKILL.md and the corrected skill references pass the readability check with no errors', { skip: !hasVale && 'vale not installed' }, () => {
  const files = readdirSync(join(repo, 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(repo, 'skills', entry.name, 'SKILL.md'))
    .filter(existsSync)
    .concat(['skills/work-heavy/references/planning.md', 'agents/plan-scout.md'].map(path => join(repo, path)))
  assert.ok(files.length > 0, `no SKILL.md under ${join(repo, 'skills')}`)
  const r = spawnSync('bash', [readability, ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })
  const errors = r.stdout.split('\n').filter(line => /\.md$|\berror\b/.test(line.trim()))
  assert.equal(r.status, 0, `readability.sh exited ${r.status} on ${files.length} files. Repair: rewrite each sentence below, then run ${readability} on the file.\n${errors.join('\n')}\n${r.stderr}`)
})
