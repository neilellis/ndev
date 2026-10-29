// Runs responsive-check.mjs against the fixture pages in a real browser.
// RESPONSIVE_CHECK_WEB_DIR names a folder that installs `playwright` (or `@playwright/test`)
// with Chromium and WebKit downloaded. RESPONSIVE_CHECK_NO_BROWSER=1 skips these tests by name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'responsive-check.mjs')
const FIXTURES = join(HERE, 'fixtures')
const WEB_DIR = process.env.RESPONSIVE_CHECK_WEB_DIR
const SKIP = process.env.RESPONSIVE_CHECK_NO_BROWSER === '1'
  ? 'RESPONSIVE_CHECK_NO_BROWSER=1: browser tests not run'
  : false

function serve() {
  const server = createServer((req, res) => {
    try {
      const body = readFileSync(join(FIXTURES, new URL(req.url, 'http://x').pathname))
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('missing')
    }
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function check(args) {
  if (!WEB_DIR) {
    assert.fail('RESPONSIVE_CHECK_WEB_DIR is not set. fix: npm i --prefix <dir> playwright && npx --prefix <dir> playwright install chromium webkit, then RESPONSIVE_CHECK_WEB_DIR=<dir>')
  }
  const server = await serve()
  const out = mkdtempSync(join(tmpdir(), 'rc-test-'))
  const base = `http://127.0.0.1:${server.address().port}`
  const ran = await new Promise((done) => {
    // spawnSync would block the server in this process, so run the child asynchronously.
    import('node:child_process').then(({ execFile }) => {
      execFile(process.execPath, [SCRIPT, '--base', base, '--out', out, ...args], { env: { ...process.env, WEB_DIR, RESPONSIVE_CHECK_STATE_DIR: join(out, 'state') } }, (error, stdout, stderr) => {
        done({ status: error ? error.code : 0, stdout, stderr })
      })
    })
  })
  server.close()
  const read = (name) => JSON.parse(readFileSync(join(out, name), 'utf8'))
  return { ...ran, out, read }
}

const findingsOf = (report, filter) =>
  report.cells.flatMap((c) => c.findings.map((f) => ({ ...f, viewport: c.viewport, scheme: c.scheme }))).filter(filter)

test('a broken page fails, and the report names each defect and its element', { skip: SKIP, timeout: 180000 }, async () => {
  const r = await check(['--only', 'iPhone SE,iPad Mini', '/broken.html'])
  assert.equal(r.status, 1, `expected exit 1\n${r.stdout}\n${r.stderr}`)
  const report = r.read('report.json')
  assert.equal(report.cells.length, 4, 'one route x two viewports x two schemes')

  const overflow = findingsOf(report, (f) => f.check === 'overflow' && f.viewport === 'iPhone SE')
  assert.ok(overflow.some((f) => f.severity === 'error' && f.selector.includes('#wide')), JSON.stringify(overflow))
  assert.ok(findingsOf(report, (f) => f.check === 'viewport-meta' && f.severity === 'error').length > 0)
  assert.ok(findingsOf(report, (f) => f.check === 'target-size' && f.severity === 'error' && f.selector.includes('#tiny')).length > 0, 'crowded small targets fail')
  assert.ok(findingsOf(report, (f) => f.check === 'input-zoom' && f.selector.includes('#small-input')).length > 0)
  assert.ok(findingsOf(report, (f) => f.check === 'vh-units').length > 0)

  const contrast = findingsOf(report, (f) => f.check === 'contrast' && f.selector.includes('.faint'))
  assert.ok(contrast.length > 0 && contrast.every((f) => f.scheme === 'dark'), JSON.stringify(contrast))

  const phone = report.cells.find((c) => c.viewport === 'iPhone SE')
  assert.equal(phone.engine, 'webkit', 'Apple devices run in WebKit')
  assert.equal(phone.measured.width, 320, 'the CSS viewport is the device width')
})

test('a clean page passes in light and dark at every default viewport', { skip: SKIP, timeout: 300000 }, async () => {
  const r = await check(['/clean.html'])
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`)
  const report = r.read('report.json')
  assert.deepEqual([...new Set(report.cells.map((c) => c.scheme))].sort(), ['dark', 'light'])
  assert.equal(findingsOf(report, (f) => f.severity === 'error').length, 0, JSON.stringify(findingsOf(report, (f) => f.severity === 'error')))
  assert.ok(!report.notes.some((n) => n.includes('no dark')), 'the clean page has a dark scheme')

  const progress = r.read('progress.json')
  assert.equal(progress.state, 'done')
  assert.equal(progress.cells.length, report.cells.length)
  assert.ok(progress.cells.every((c) => c.status === 'ok' || c.status === 'warn'), JSON.stringify(progress.cells.map((c) => c.status)))
})

test('an edge that clips its child, a skip link and spaced small links are judged as WCAG does', { skip: SKIP, timeout: 180000 }, async () => {
  const r = await check(['--only', 'iPhone SE', '--schemes', 'light', '/traps.html'])
  const report = r.read('report.json')
  const overflow = findingsOf(report, (f) => f.check === 'overflow')
  assert.deepEqual(overflow.map((f) => f.selector), ['#edge'], 'the element at the page edge, not its clipped child and not html')

  const targets = findingsOf(report, (f) => f.check === 'target-size')
  assert.ok(!targets.some((f) => f.selector.includes('skip')), `an off-screen skip link is not a target: ${JSON.stringify(targets)}`)
  const spaced = targets.filter((f) => f.selector.includes('spaced'))
  assert.ok(spaced.length > 0 && spaced.every((f) => f.severity === 'warning'), `spaced links are warnings only: ${JSON.stringify(spaced)}`)
})

test('no --base exits 2 and names the fix', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '/'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /fix: pass --base/)
})
