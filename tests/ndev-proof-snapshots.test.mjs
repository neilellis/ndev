import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')
const site = join(repoRoot, 'tests/fixtures/proof-site.mjs')
const matrix = join(repoRoot, 'tests/fixtures/proof-matrix.mjs')
const VIEWPORTS = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }]

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function freePort() {
  const result = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' })
  return Number(result.stdout.trim())
}

function config(port, { routes, served = routes, command = `node ${site}` }) {
  return { devServers: { web: { command, port, ready: `http://127.0.0.1:${port}/`, env: { FIXTURE_PORT: String(port), FIXTURE_ROUTES: served.join(',') }, routes } }, proof: { viewports: VIEWPORTS } }
}

function repository(t, { base: baseConfig, head: headConfig }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-snapshots-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const origin = join(base, 'origin.git')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  const root = join(base, 'main')
  git(base, 'init', '-q', '-b', 'main', root)
  git(root, 'remote', 'add', 'origin', origin)
  writeFileSync(join(root, '.gitignore'), '.neil-dev.worktree.json\n')
  writeFileSync(join(root, '.ndev.json'), `${JSON.stringify(baseConfig, null, 2)}\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'switch', '-q', '-c', 'feature')
  writeFileSync(join(root, '.ndev.json'), `${JSON.stringify(headConfig, null, 2)}\n`)
  writeFileSync(join(root, 'app.tsx'), 'export const App = () => null\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'head')
  return { base, root, origin, head: git(root, 'rev-parse', 'HEAD').trim() }
}

function snapshots(root, args, env = {}) {
  const result = spawnSync(executable, ['proof', 'snapshots', ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NDEV_PROOF_MATRIX: matrix, GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_PATH: '', ...env },
  })
  assert.ifError(result.error)
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined, all: `${result.stdout}${result.stderr}` }
}

async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

function running(root) {
  const file = join(root, '.neil-dev.worktree.json')
  return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).resources?.['dev-servers'] ?? {}) : []
}

test('--local writes the grid of routes by viewports by schemes, with the findings, and pushes nothing', async t => {
  const port = freePort()
  const both = config(port, { routes: ['/', '/settings'] })
  const { base, root, origin } = repository(t, { base: both, head: both })
  const out = join(base, 'out')
  const result = snapshots(root, ['--local', '--out', out])
  assert.equal(result.status, 0, result.all)
  const found = result.json.result
  assert.equal(found.cells.length, 2 * 2 * 2)
  assert.equal(found.assets, null)
  assert.deepEqual(found.cells.find(cell => cell.route === '/settings' && cell.viewport === 'phone' && cell.scheme === 'dark'), {
    server: 'web', route: '/settings', viewport: 'phone', scheme: 'dark', image: 'head/web/shots/settings/phone-dark.jpg',
    findings: [{ check: 'contrast', severity: 'error', selector: 'p', detail: 'contrast 2.1:1' }], base: null,
  })
  assert.equal(readFileSync(join(out, 'head/web/shots/settings/phone-dark.jpg'), 'utf8'), `http://127.0.0.1:${port}/settings phone dark`)
  const grid = readFileSync(join(out, 'grid.md'), 'utf8')
  assert.equal(found.grid, join(out, 'grid.md'))
  assert.match(grid, /^### web \/settings$/m)
  assert.match(grid, /^\| \| light \| dark \|$/m)
  assert.match(grid, /^\| phone 390×844 \| !\[\/settings phone light\]\(head\/web\/shots\/settings\/phone-light\.jpg\) \| !\[\/settings phone dark\]\(head\/web\/shots\/settings\/phone-dark\.jpg\)<br>1 error: contrast p \|$/m)
  const argv = JSON.parse(readFileSync(join(out, 'head/web/argv.json'), 'utf8'))
  assert.deepEqual(argv.slice(argv.indexOf('--viewports'), argv.indexOf('--viewports') + 8), ['--viewports', 'phone:390x844,desktop:1440x900', '--schemes', 'light,dark', '--scale', '1', '--jpeg', '60'])
  assert.equal(spawnSync('git', ['--git-dir', origin, 'ls-remote', '--heads', origin, 'ndev-proof-assets'], { encoding: 'utf8' }).stdout, '')
  assert.equal(await answers(port), false)
  assert.deepEqual(running(root), [])
})

test('--pr pushes the images to ndev-proof-assets under pr-<n>/<sha>/, and the grid links them', t => {
  const port = freePort()
  const both = config(port, { routes: ['/'] })
  const { base, root, origin, head } = repository(t, { base: both, head: both })
  const first = snapshots(root, ['--pr', '7', '--out', join(base, 'out7')])
  assert.equal(first.status, 0, first.all)
  const assets = first.json.result.assets
  assert.deepEqual({ ...assets, commit: undefined }, { branch: 'ndev-proof-assets', prefix: `pr-7/${head}/`, commit: undefined })
  const tree = () => spawnSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'ndev-proof-assets'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  assert.ok(tree().includes(`pr-7/${head}/head/web/shots/root/phone-light.jpg`), tree().join('\n'))
  assert.ok(!tree().some(path => path.endsWith('argv.json') || path.endsWith('report.json')), tree().join('\n'))
  const grid = readFileSync(first.json.result.grid, 'utf8')
  assert.ok(grid.includes(`(https://github.com/owner/repo/blob/${assets.commit}/pr-7/${head}/head/web/shots/root/phone-light.jpg?raw=true)`), grid)
  const second = snapshots(root, ['--pr', '8', '--out', join(base, 'out8')])
  assert.equal(second.status, 0, second.all)
  assert.ok(tree().includes(`pr-7/${head}/head/web/shots/root/phone-light.jpg`), 'the second push dropped the first PR')
  assert.ok(tree().includes(`pr-8/${head}/head/web/shots/root/desktop-dark.jpg`))
  assert.equal(spawnSync('git', ['--git-dir', origin, 'rev-parse', 'ndev-proof-assets^'], { encoding: 'utf8' }).stdout.trim(), assets.commit)
})

test('--base takes a before image of each route that the base also serves', t => {
  const port = freePort()
  const { base, root } = repository(t, { base: config(port, { routes: ['/'] }), head: config(port, { routes: ['/', '/settings'] }) })
  const out = join(base, 'out')
  const result = snapshots(root, ['--local', '--base', 'main', '--out', out])
  assert.equal(result.status, 0, result.all)
  const cells = result.json.result.cells
  assert.deepEqual(cells.find(cell => cell.route === '/' && cell.viewport === 'phone' && cell.scheme === 'light').base, { image: 'base/web/shots/root/phone-light.jpg', findings: [] })
  assert.equal(cells.find(cell => cell.route === '/settings' && cell.viewport === 'phone' && cell.scheme === 'light').base, null)
  assert.ok(existsSync(join(out, 'base/web/shots/root/phone-light.jpg')))
  const grid = readFileSync(join(out, 'grid.md'), 'utf8')
  assert.match(grid, /^\| \| light before \| light after \| dark before \| dark after \|$/m)
  assert.match(grid, /^\| \| light \| dark \|$/m)
  assert.deepEqual(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1)
  assert.deepEqual(running(root), [])
})

test('a route that does not load fails with the server, the route and the end of its log', async t => {
  const port = freePort()
  const broken = config(port, { routes: ['/', '/gone'], served: ['/'] })
  const { base, root } = repository(t, { base: broken, head: broken })
  const result = snapshots(root, ['--local', '--out', join(base, 'out')])
  assert.equal(result.status, 1, result.all)
  const { message } = result.json.error
  assert.match(message, /Dev server web: \/gone did not load at phone light: HTTP 404/)
  assert.match(message, /GET \/gone 404/)
  assert.equal(await answers(port), false)
  assert.deepEqual(running(root), [])
})

test('a server that does not start fails with its name and its log', t => {
  const port = freePort()
  const dead = config(port, { routes: ['/'], command: `node -e "console.log('boom: no build');process.exit(3)"` })
  const { base, root } = repository(t, { base: dead, head: dead })
  const result = snapshots(root, ['--local', '--out', join(base, 'out')])
  assert.equal(result.status, 1, result.all)
  assert.match(result.json.error.message, /Dev server web .* exited 3/)
  assert.match(result.json.error.message, /boom: no build/)
})

test('a matrix that cannot run fails with its command and output', async t => {
  const port = freePort()
  const both = config(port, { routes: ['/'] })
  const { base, root } = repository(t, { base: both, head: both })
  const result = snapshots(root, ['--local', '--out', join(base, 'out')], { FAKE_MATRIX_EXIT: '2' })
  assert.equal(result.status, 1, result.all)
  assert.match(result.json.error.message, /The snapshot matrix for dev server web exited 2: fake matrix cannot run: no playwright/)
  assert.equal(await answers(port), false)
})

test('a matrix that writes no report fails, even when an earlier run left one in --out', t => {
  const port = freePort()
  const both = config(port, { routes: ['/'] })
  const { base, root } = repository(t, { base: both, head: both })
  const out = join(base, 'out')
  assert.equal(snapshots(root, ['--local', '--out', out]).status, 0)
  const result = snapshots(root, ['--local', '--out', out], { FAKE_MATRIX_NO_REPORT: '1' })
  assert.equal(result.status, 1, result.all)
  assert.match(result.json.error.message, /The snapshot matrix for dev server web exited 0/)
})

test('a route that does not load on the base names the base', t => {
  const port = freePort()
  const { base, root } = repository(t, { base: config(port, { routes: ['/', '/gone'], served: ['/'] }), head: config(port, { routes: ['/', '/gone'] }) })
  const result = snapshots(root, ['--local', '--base', 'main', '--out', join(base, 'out')])
  assert.equal(result.status, 1, result.all)
  assert.match(result.json.error.message, /Dev server web at the base main: \/gone did not load at phone light: HTTP 404/)
  assert.match(result.json.error.repair, /--base/)
  assert.deepEqual(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1)
})

test('a route that no dev server lists is refused, naming the listed routes', t => {
  const port = freePort()
  const both = config(port, { routes: ['/', '/settings'] })
  const { base, root } = repository(t, { base: both, head: both })
  const result = snapshots(root, ['--local', '--routes', '/nope', '--out', join(base, 'out')])
  assert.equal(result.status, 2, result.all)
  assert.match(result.json.error.message, /No dev server lists the route \/nope\. Listed: web: \/, \/settings\./)
})

test('--routes keeps only the named routes', t => {
  const port = freePort()
  const both = config(port, { routes: ['/', '/settings'] })
  const { base, root } = repository(t, { base: both, head: both })
  const result = snapshots(root, ['--local', '--routes', '/settings', '--out', join(base, 'out')])
  assert.equal(result.status, 0, result.all)
  assert.deepEqual([...new Set(result.json.result.cells.map(cell => cell.route))], ['/settings'])
})

test('without --pr or --local the command refuses to guess where the images go', t => {
  const both = config(freePort(), { routes: ['/'] })
  const { base, root } = repository(t, { base: both, head: both })
  const result = snapshots(root, ['--out', join(base, 'out')])
  assert.equal(result.status, 2, result.all)
  assert.match(result.json.error.message, /Give --pr <n> to push the images, or --local to keep them in --out\./)
})

test('--pr waits for a pre-push hook that runs past the network allowance and within its guard.timeoutSeconds (#317)', t => {
  const port = freePort()
  const both = config(port, { routes: ['/'] })
  const { base, root, origin } = repository(t, { base: both, head: both })
  const hook = join(root, '.git/hooks/pre-push')
  writeFileSync(hook, '#!/bin/sh\nsleep 3\n')
  chmodSync(hook, 0o755)
  git(root, 'config', 'guard.timeoutSeconds', '10')
  const result = snapshots(root, ['--pr', '7', '--out', join(base, 'out7')], { NDEV_PROOF_PUSH_MS: '1000' })
  assert.equal(result.status, 0, result.all)
  assert.equal(spawnSync('git', ['--git-dir', origin, 'rev-parse', 'ndev-proof-assets'], { encoding: 'utf8' }).stdout.trim(), result.json.result.assets.commit)
})

test('--pr stopped past the limit of the pre-push hook names the hook and its guard.timeoutSeconds', t => {
  const port = freePort()
  const both = config(port, { routes: ['/'] })
  const { base, root } = repository(t, { base: both, head: both })
  const hook = join(root, '.git/hooks/pre-push')
  writeFileSync(hook, '#!/bin/sh\nsleep 4\n')
  chmodSync(hook, 0o755)
  git(root, 'config', 'guard.timeoutSeconds', '1')
  const result = snapshots(root, ['--pr', '7', '--out', join(base, 'out7')], { NDEV_PROOF_PUSH_MS: '500' })
  assert.equal(result.status, 1, result.all)
  assert.ok(result.all.includes(hook), result.all)
  assert.match(result.all, /guard\.timeoutSeconds 1\b/)
})
