// Tests for component-sources.mjs. Run: node --test scripts/ui/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvedSources, checkFile } from '../component-sources.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'component-sources.mjs')
const CATALOGUE = join(HERE, '..', '..', '..', 'kb', 'ui-components.md')
const sources = approvedSources(readFileSync(CATALOGUE, 'utf8'))
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('the catalogue table gives every approved source and its hosts', () => {
  assert.equal(sources.size, 16)
  assert.ok(sources.get('shadcn/ui').hosts.has('ui.shadcn.com'))
  assert.ok(sources.get('kokonut ui').hosts.has('kokonutui.com'))
  assert.ok(sources.get('coss ui').hosts.has('coss.com'))
})

test('a From line with an approved source, its host and a date passes', () => {
  assert.equal(checkFile('"use client"\n// From shadcn/ui button (https://ui.shadcn.com/r/styles/base-nova/button.json), 2026-10-29.\n', sources), null)
  assert.equal(checkFile('"use client";\n\n/**\n * From Kokonut UI hold-button (https://kokonutui.com/r/hold-button.json), 2026-10-30.\n */\n', sources), null)
})

test('an own component with a reason passes', () => {
  assert.equal(checkFile('// Own component: a crossfading label; no map row fits.\n', sources), null)
})

test('each kind of bad header names its own reason', () => {
  assert.match(checkFile('export const A = 1\n', sources), /no "From/)
  assert.match(checkFile('// Own component:\n', sources), /needs the reason/)
  assert.match(checkFile('// From Aceternity UI card (https://ui.aceternity.com/r/card.json), 2026-11-01.\n', sources), /not start with an approved source/)
  assert.match(checkFile('// From shadcn/ui button (https://example.com/button.json), 2026-11-01.\n', sources), /host example.com is not a host of shadcn\/ui/)
  assert.match(checkFile('// From shadcn/ui button https://ui.shadcn.com/r/button.json\n', sources), /needs "<source> <item>/)
})

test('the CLI fails on a bad file, lists it with the repair, and skips tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'component-sources-'))
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui', 'good.tsx'), '// From shadcn/ui badge (https://ui.shadcn.com/r/badge.json), 2026-10-29.\n')
  writeFileSync(join(dir, 'ui', 'good.test.tsx'), 'test()\n')
  writeFileSync(join(dir, 'ui', 'bad.tsx'), 'export {}\n')
  const r = run(join(dir, 'ui'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bad\.tsx: no "From/)
  assert.doesNotMatch(r.stderr, /good/)
  assert.match(r.stderr, /1 of 2 component files/)
  assert.match(r.stderr, /Repair: add/)
  writeFileSync(join(dir, 'ui', 'bad.tsx'), '// Own component: test fixture with a reason.\n')
  const ok = run(join(dir, 'ui'))
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /2 component files/)
})

test('the CLI exits 2 on a missing path or no arguments', () => {
  assert.equal(run('/no/such/dir').status, 2)
  assert.match(run().stderr, /give one or more/)
})
