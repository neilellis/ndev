import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../readability.sh', import.meta.url))
const bad = fileURLToPath(new URL('../vale/testdata/bad.md', import.meta.url))
const hasVale = spawnSync('vale', ['--version']).status === 0

function run(...files) {
  return spawnSync('bash', [script, ...files], { encoding: 'utf8' })
}

test('an .mdx docs page is linted like .md', { skip: !hasVale && 'vale not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'readability-'))
  const page = join(dir, 'page.mdx')
  copyFileSync(bad, page)
  const r = run(page)
  assert.equal(r.status, 1, `expected alerts on page.mdx, got exit ${r.status}:\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /House\./)
})

test('a file that Vale skips is not a pass: exit 2, naming the file and the repair', { skip: !hasVale && 'vale not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'readability-'))
  const page = join(dir, 'page.rst')
  writeFileSync(page, 'This is clearly a very robust and seamless solution.\n')
  const r = run(page)
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}:\n${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /page\.rst/)
  assert.match(r.stderr, /\.vale\.ini/)
})
