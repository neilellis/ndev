import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const tool = fileURLToPath(new URL('../screenshots.mjs', import.meta.url))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-screenshots-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'view.tsx'), 'first version')
  writeFileSync(join(root, 'capture.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('view.png', Buffer.from('${png}', 'base64'))`)
  writeFileSync(join(root, 'screenshots.json'), JSON.stringify({ version: 1, captures: [{ id: 'view', inputs: ['view.tsx', 'capture.mjs'], command: [process.execPath, 'capture.mjs'], outputs: ['view.png'] }] }))
  const run = mode => spawnSync(process.execPath, [tool, mode, 'screenshots.json'], { cwd: root, encoding: 'utf8' })
  return { root, run }
}

test('refresh captures screenshots and check rejects changed sources or output bytes', t => {
  const { root, run } = fixture(t)
  const missing = run('check')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /view.*refresh/)
  const refresh = run('refresh')
  assert.equal(refresh.status, 0, refresh.stderr)
  assert.equal(run('check').status, 0)
  writeFileSync(join(root, 'view.tsx'), 'second version')
  assert.equal(run('check').status, 1)
  assert.equal(run('refresh').status, 0)
  writeFileSync(join(root, 'view.png'), Buffer.from(png, 'base64').subarray(0, 24))
  assert.equal(run('check').status, 1)
  assert.equal(run('refresh').status, 0)
  assert.equal(run('check').status, 0)
})

test('failed captures invalidate receipts, preserve diagnostics and can be repaired', t => {
  const { root, run } = fixture(t)
  assert.equal(run('refresh').status, 0)
  writeFileSync(join(root, 'capture.mjs'), "console.error('fixture account refused'); process.exit(7)")
  const failure = run('refresh')
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /fixture account refused/)
  assert.match(failure.stderr, /view: command.*exit 7.*refresh/)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'screenshots.json.receipt.json'))).captures, {})
  assert.equal(run('check').status, 1)
  writeFileSync(join(root, 'capture.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('view.png', Buffer.from('${png}', 'base64'))`)
  assert.equal(run('refresh').status, 0)
  assert.equal(run('check').status, 0)
})

test('a successful command must produce every declared PNG before receiving a receipt', t => {
  const { root, run } = fixture(t)
  assert.equal(run('refresh').status, 0)
  writeFileSync(join(root, 'capture.mjs'), '')
  const missing = run('refresh')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /view.*view.png.*missing/)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'screenshots.json.receipt.json'))).captures, {})
  writeFileSync(join(root, 'capture.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('view.png', 'not a PNG')")
  assert.match(run('refresh').stderr, /view.*view.png.*invalid PNG/)
  assert.equal(run('check').status, 1)
})


test('directory inputs detect added and removed files and current captures do not rerun', t => {
  const { root, run } = fixture(t)
  mkdirSync(join(root, 'source'))
  writeFileSync(join(root, 'source/a.tsx'), 'a')
  const manifestPath = join(root, 'screenshots.json')
  const manifest = JSON.parse(readFileSync(manifestPath))
  manifest.captures[0].inputs.push('source')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const capturePath = join(root, 'capture.mjs')
  writeFileSync(capturePath, readFileSync(capturePath, 'utf8') + "; writeFileSync('capture-marker', 'captured')")
  assert.equal(run('refresh').status, 0)
  rmSync(join(root, 'capture-marker'))
  assert.equal(run('refresh').status, 0)
  assert.equal(run('check').status, 0)
  assert.throws(() => readFileSync(join(root, 'capture-marker')), { code: 'ENOENT' })
  writeFileSync(join(root, 'source/b.tsx'), 'b')
  assert.equal(run('check').status, 1)
  assert.equal(run('refresh').status, 0)
  rmSync(join(root, 'source/a.tsx'))
  assert.equal(run('check').status, 1)
  assert.equal(run('refresh').status, 0)
  assert.equal(run('check').status, 0)
})

test('manifest paths cannot escape the project or reuse an output as an input', t => {
  const { root, run } = fixture(t)
  const manifestPath = join(root, 'screenshots.json')
  const manifest = JSON.parse(readFileSync(manifestPath))
  manifest.captures[0].outputs = ['../outside.png']
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(run('refresh').stderr, /paths must stay inside/)
  manifest.captures[0].outputs = ['view.png']
  symlinkSync(tmpdir(), join(root, 'outside'))
  manifest.captures[0].outputs = ['outside/view.png']
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(run('refresh').stderr, /symlink escapes/)
  manifest.captures[0].outputs = ['view.png']
  manifest.captures[0].inputs.push('view.png')
  writeFileSync(join(root, 'view.png'), Buffer.from(png, 'base64'))
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(run('refresh').stderr, /cannot be an input/)
})
