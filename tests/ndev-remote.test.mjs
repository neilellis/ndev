import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const binary = fileURLToPath(new URL('../bin/ndev', import.meta.url))

test('remote set resolves a recipe prefix, reports stale saved IDs, and preserves other projects on clear', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-remote-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root,'.neil-dev.json'),JSON.stringify({github:{repo:'owner/one'}}))
  let servers = [{ id: 'host-1', name: 'build VM abc' }]
  const fake = () => writeFileSync(join(root, 'orca'), '#!/bin/sh\necho \'' + JSON.stringify({ ok: true, result: { environments: servers } }) + "'\n", { mode: 0o755 })
  const call = (...args) => {
    const p = spawnSync(binary, ['remote', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: p.status, ...JSON.parse(p.stdout) }
  }
  fake()
  assert.equal(call('set', 'build').result.server.id, 'host-1')
  assert.equal(call('status').result.server.id, 'host-1')
  writeFileSync(join(root,'.neil-dev.json'),JSON.stringify({github:{repo:'owner/two'}}))
  assert.equal(call('set','build').status,0)
  writeFileSync(join(root,'.neil-dev.json'),JSON.stringify({github:{repo:'owner/one'}}))
  servers = []
  fake()
  assert.equal(call('status').status, 1)
  assert.equal(call('off').status, 0)
  assert.equal(call('status').result.server, null)
  const store = JSON.parse(readFileSync(join(root, '.config/ndev/remote.json')))
  assert.equal(store.projects['owner/two'].id, 'host-1')
})

test('cloud operations refuse missing billing context before a write and retain the cloud CLI error', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-cloud-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init','-q',root]).status,0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root,'hcloud'), '#!/bin/sh\nif [ "$1" = context ]; then echo team; exit 0; fi\necho "fixture: access refused" >&2\nexit 17\n', { mode: 0o755 })
  const call = (...args) => {
    const result = spawnSync(binary, ['remote', 'create', 'test-server', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    return JSON.parse(result.stdout).error
  }
  assert.match(call().message, /no hcloud context is named/)
  const failed = call('--context','team')
  assert.match(failed.message,/exit(?:ed)? 17/)
  assert.match(failed.message,/fixture: access refused/)
})

test('remote remove recovers the paid snapshot after the cloud accepted it but lost its response', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-remove-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root, NDEV_FIXTURE_BIN: binary }
  const labels = { 'managed-by': 'ndev', 'ndev-name': 'work-box' }
  const srv = { id: 17, name: 'work-box', status: 'off', server_type: { name: 'cx33' }, labels, public_net: {}, location: { name: 'fsn1' } }
  const db = join(root, 'cloud.json')
  writeFileSync(db, JSON.stringify({ servers: [srv], images: [], attempts: 0 }))
  function fakeHcloud() {
    const fs = require('node:fs')
    const db = JSON.parse(fs.readFileSync('cloud.json'))
    const args = process.argv.slice(2)
    const send = data => console.log(JSON.stringify(data))
    const save = () => fs.writeFileSync('cloud.json', JSON.stringify(db))
    const fail = (code, message) => { console.error(message); process.exit(code) }
    if (args[0] === 'context') return console.log('billing')
    switch (args.slice(2, 4).join(' ')) {
      case 'server list': return send(db.servers)
      case 'image list': return send(db.images)
      case 'floating-ip list':
      case 'firewall list': return send([])
      case 'api /pricing': return send({ pricing: { currency: 'EUR' } })
      case 'server create-image': {
        db.attempts++
        if (!process.env.PROBE_NESTED && db.attempts === 1) {
          const removal = ['remote', 'remove', 'work-box', '--context', 'billing', '--unverified-host', '--yes', '--json']
          const run = require('node:child_process').spawnSync(process.env.NDEV_FIXTURE_BIN, removal, {
            encoding: 'utf8', env: { ...process.env, PROBE_NESTED: '1' },
          })
          db.overlap = { status: run.status, text: run.stdout }
        }
        const labels = Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split('=')] : []))
        db.images.push({ id: 30 + db.attempts, status: 'available', description: 'fixture', disk_size: 20, image_size: 2, created: new Date().toISOString(), labels })
        save()
        if (db.attempts === 1) fail(17, 'provider lost response after acceptance')
        return
      }
      case 'server delete':
        db.servers = []
        save()
        return fail(23, 'delete accepted; lost response')
      case 'image delete':
        db.images = db.images.filter(i => i.id !== Number(args[4]))
        return save()
      default: fail(37, 'unexpected command ' + args.join(' '))
    }
  }
  writeFileSync(join(root, 'hcloud'), `#!/usr/bin/env node\n(${fakeHcloud.toString()})()\n`, { mode: 0o755 })
  const remove = () => spawnSync(binary, ['remote', 'remove', 'work-box', '--context', 'billing', '--unverified-host', '--yes', '--json'], { cwd: root, env, encoding: 'utf8' })
  const first = remove()
  assert.equal(first.status, 1, first.stdout)
  assert.match(first.stdout, /provider lost response/)
  const accepted = JSON.parse(readFileSync(db))
  assert.equal(accepted.overlap.status, 5, accepted.overlap.text)
  assert.match(accepted.overlap.text, /running in process/)
  writeFileSync(db, JSON.stringify({ ...accepted, images: [] }))
  const hidden = remove()
  assert.equal(hidden.status, 1, hidden.stdout)
  assert.match(hidden.stdout, /snapshot|image/)
  assert.equal(JSON.parse(readFileSync(db)).attempts, 1)
  writeFileSync(db, JSON.stringify(accepted))
  const second = remove()
  assert.equal(second.status, 1, second.stdout)
  assert.match(second.stdout, /delete accepted; lost response/)
  const finished = remove()
  assert.equal(finished.status, 0, finished.stdout)
  const result = JSON.parse(readFileSync(db))
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.images.map(i => i.id), [31])
  assert.deepEqual(result.servers, [])
})
