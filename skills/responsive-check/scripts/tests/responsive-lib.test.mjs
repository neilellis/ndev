import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UsageError, cellsFor, contrastRatio, findingsFor, parseArgs, shotFor, viewportMetaFindings, viewportsFor } from '../responsive-lib.mjs'

const DEVICES = {
  'iPhone SE': { viewport: { width: 320, height: 568 }, defaultBrowserType: 'webkit', isMobile: true, hasTouch: true },
  'iPhone 15 Pro': { viewport: { width: 393, height: 659 }, defaultBrowserType: 'webkit', isMobile: true },
  'Pixel 7': { viewport: { width: 412, height: 839 }, defaultBrowserType: 'chromium', isMobile: true },
  'iPad Mini': { viewport: { width: 768, height: 1024 }, defaultBrowserType: 'webkit', isMobile: true },
  'iPad Pro 11 landscape': { viewport: { width: 1194, height: 834 }, defaultBrowserType: 'webkit', isMobile: true },
}
const RAW = { clientWidth: 320, scrollWidth: 320, overflow: [], viewportMeta: 'width=device-width, initial-scale=1', targets: [], inputs: [], vh: [], smallText: [], contrast: [] }
const PHONE = { isMobile: true }
const OPTS = { target: 24, targetWarn: 44 }

test('the matrix is every route by every viewport by both schemes', () => {
  const o = parseArgs(['--base', 'http://x', '/a', 'b'])
  const v = viewportsFor(o, DEVICES)
  assert.deepEqual(o.routes, ['/a', '/b'])
  assert.equal(cellsFor(o.routes, v, o.schemes).length, 2 * 7 * 2)
  assert.equal(v.find((r) => r.name === 'iPhone SE').engine, 'webkit')
  assert.equal(v.find((r) => r.name === 'Laptop').engine, 'chromium')
})

test('--only and --widths shape the rows, and an unknown name lists the names', () => {
  const v = viewportsFor(parseArgs(['--base', 'http://x', '--only', 'iPhone SE,360px', '--widths', '360']), DEVICES)
  assert.deepEqual(v.map((r) => [r.name, r.width]), [['iPhone SE', 320], ['360px', 360]])
  assert.throws(() => viewportsFor(parseArgs(['--base', 'http://x', '--only', 'Nokia']), DEVICES), /no viewport named Nokia\. Names: iPhone SE/)
})

test('bad arguments raise a usage error that names the fix', () => {
  assert.throws(() => parseArgs([]), (e) => e instanceof UsageError && /fix: pass --base/.test(e.message))
  assert.throws(() => parseArgs(['--base', 'http://x', '--schemes', 'sepia']), /sepia is not light or dark/)
  assert.throws(() => parseArgs(['--base', 'http://x', '--target', '50']), /--target-warn at least --target/)
  assert.throws(() => parseArgs(['--base', 'http://x', '--out']), /--out needs a value/)
})

test('viewport meta: missing, zoom blocked, and good', () => {
  assert.match(viewportMetaFindings(null)[0].detail, /980px/)
  assert.equal(viewportMetaFindings('width=device-width, user-scalable=no, maximum-scale=1').length, 2)
  assert.deepEqual(viewportMetaFindings('width=device-width, initial-scale=1'), [])
})

test('contrast ratio matches the WCAG figures', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0')
  assert.equal(contrastRatio([118, 118, 118], [255, 255, 255]).toFixed(2), '4.54')
})

test('findings: overflow, targets, inputs and contrast get their severities', () => {
  const f = findingsFor({
    ...RAW,
    scrollWidth: 600,
    overflow: [{ selector: '#wide', right: 600 }],
    targets: [{ selector: '#tiny', width: 16, height: 16 }, { selector: '.ok', width: 48, height: 30 }],
    inputs: [{ selector: '#q', fontSize: 12 }],
    contrast: [{ selector: '.faint', fg: [34, 34, 34], bg: [17, 17, 17], isLarge: false }, { selector: 'h1', fg: [148, 148, 148], bg: [255, 255, 255], isLarge: true }],
  }, PHONE, OPTS)
  const by = (check) => f.filter((x) => x.check === check).map((x) => `${x.severity} ${x.selector}`)
  assert.deepEqual(by('overflow'), ['error #wide'])
  assert.deepEqual(by('target-size'), ['error #tiny', 'warning .ok'])
  assert.deepEqual(by('input-zoom'), ['warning #q'])
  assert.deepEqual(by('contrast'), ['error .faint'], 'large text needs 3:1 only')
})

test('a small target with room around it passes WCAG 2.5.8, and is still a warning on a phone', () => {
  const raw = { ...RAW, targets: [{ selector: 'li a', width: 40, height: 20, isSpaced: true }, { selector: '#crowded', width: 16, height: 16, isSpaced: false }] }
  const by = (v) => findingsFor(raw, v, OPTS).map((x) => `${x.severity} ${x.selector}`)
  assert.deepEqual(by(PHONE), ['warning li a', 'error #crowded'])
  assert.deepEqual(by({ isMobile: false }), ['error #crowded'])
})

test('desktop rows skip the phone-only checks', () => {
  const f = findingsFor({ ...RAW, viewportMeta: null, inputs: [{ selector: '#q', fontSize: 12 }], targets: [{ selector: '.b', width: 30, height: 30 }] }, { isMobile: false }, OPTS)
  assert.deepEqual(f, [])
})

test('--viewports replaces the default rows with named Chromium windows', () => {
  const v = viewportsFor(parseArgs(['--base', 'http://x', '--viewports', 'phone:390x844,desktop:1440x900']), DEVICES)
  assert.deepEqual(v.map((r) => [r.name, r.width, r.height, r.engine]), [['phone', 390, 844, 'chromium'], ['desktop', 1440, 900, 'chromium']])
  assert.throws(() => parseArgs(['--base', 'http://x', '--viewports', 'phone:390']), /--viewports: phone:390 is not name:WIDTHxHEIGHT, such as phone:390x844/)
})

test('--scale sets the device scale of every row', () => {
  const v = viewportsFor(parseArgs(['--base', 'http://x', '--scale', '1', '--only', 'iPhone SE,Laptop']), { ...DEVICES, 'iPhone SE': { ...DEVICES['iPhone SE'], deviceScaleFactor: 2 } })
  assert.deepEqual(v.map((r) => r.options.deviceScaleFactor), [1, 1])
  assert.throws(() => parseArgs(['--base', 'http://x', '--scale', '0']), /--scale 0 is not a device scale above 0/)
})

test('--jpeg writes compressed screenshots with a .jpg name', () => {
  const o = parseArgs(['--base', 'http://x', '--jpeg', '60'])
  assert.deepEqual(shotFor(o, '/out', '/a/b', { name: 'phone' }, 'dark'), { path: '/out/shots/a-b/phone-dark.jpg', options: { type: 'jpeg', quality: 60 } })
  assert.deepEqual(shotFor(parseArgs(['--base', 'http://x']), '/out', '/', { name: 'iPhone SE' }, 'light'), { path: '/out/shots/root/iPhone-SE-light.png', options: { type: 'png' } })
  assert.throws(() => parseArgs(['--base', 'http://x', '--jpeg', '101']), /--jpeg 101 is not a quality from 1 to 100/)
})
