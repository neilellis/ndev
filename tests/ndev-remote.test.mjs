import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('remote list shows each server ID and marks the saved choice, or the stale one', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-remote-list-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'owner/one' } }))
  const fake = servers => writeFileSync(join(root, 'orca'), '#!/bin/sh\necho \'' + JSON.stringify({ ok: true, result: { environments: servers } }) + "'\n", { mode: 0o755 })
  const list = (...flags) => spawnSync(binary, ['remote', 'list', ...flags], { cwd: root, env, encoding: 'utf8' })
  fake([{ id: 'host-1', name: 'build' }, { id: 'host-2', name: 'spare' }])
  assert.equal(spawnSync(binary, ['remote', 'set', 'build'], { cwd: root, env }).status, 0)
  const listed = JSON.parse(list('--json').stdout).result
  assert.deepEqual(listed.servers.map(s => [s.id, s.saved]), [['host-1', true], ['host-2', false]])
  const text = list().stdout
  assert.match(text, /\* build {2}host-1 {2}\(saved for owner\/one\)/)
  assert.match(text, /^ {4}spare {2}host-2$/m)
  fake([{ id: 'host-2', name: 'spare' }])
  const stale = list()
  assert.equal(stale.status, 0)
  assert.match(stale.stdout, /no longer has the server saved for owner\/one, build \(host-1\)/)
  assert.match(stale.stdout, /ndev remote set <server> or ndev remote off/)
})

function sshFakes(root) {
  writeFileSync(join(root, 'ssh-keyscan'), '#!/bin/sh\necho "host ssh-ed25519 AAAAfixturekey"\n', { mode: 0o755 })
  function fakeKeygen() {
    const fs = require('node:fs')
    const args = process.argv.slice(2)
    if (args[0] === '-lf') {
      const key = fs.readFileSync(0, 'utf8').trim().split(/\s+/)[1]
      return console.log(`256 SHA256:print-${key} no comment (ED25519)`)
    }
    if (args[0] === '-F') {
      const lines = fs.existsSync(args[3]) ? fs.readFileSync(args[3], 'utf8').split('\n').filter(l => l.split(' ')[0] === args[1]) : []
      if (!lines.length) process.exit(1)
      return console.log(lines.join('\n'))
    }
    console.error('unexpected ssh-keygen ' + args.join(' '))
    process.exit(9)
  }
  writeFileSync(join(root, 'ssh-keygen'), `#!/usr/bin/env node\n(${fakeKeygen.toString()})()\n`, { mode: 0o755 })
}

test('remote import requires the billing context and host-key proof, then labels and records the managed resources', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-import-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'owner/one' } }))
  const db = join(root, 'cloud.json')
  writeFileSync(db, JSON.stringify({
    server: { id: 17, name: 'work-box', status: 'running', labels: { team: 'ops' }, public_net: { firewalls: [{ id: 5 }], ipv4: { ip: '198.51.100.9' } }, server_type: { name: 'cx33' } },
    firewalls: [{ id: 5, name: 'work-box-ssh', labels: {}, applied_to: [{ type: 'server', server: { id: 17 } }] }],
    fips: [{ id: 8, name: 'work-box', ip: '203.0.113.4', server: 17, labels: {} }],
    labelled: [],
  }))
  function fakeHcloud() {
    const fs = require('node:fs')
    const db = JSON.parse(fs.readFileSync('cloud.json'))
    const args = process.argv.slice(2)
    const send = data => console.log(JSON.stringify(data))
    if (args[0] === 'context') return console.log('billing')
    switch (args.slice(2, 4).join(' ')) {
      case 'server describe': return send(db.server)
      case 'firewall list': return send(db.firewalls)
      case 'floating-ip list': return send(db.fips)
      case 'image list': return send([])
      case 'server add-label':
      case 'firewall add-label':
      case 'floating-ip add-label':
        db.labelled.push(args.slice(2))
        return fs.writeFileSync('cloud.json', JSON.stringify(db))
      default: console.error('unexpected command ' + args.join(' ')); process.exit(37)
    }
  }
  writeFileSync(join(root, 'hcloud'), `#!/usr/bin/env node\n(${fakeHcloud.toString()})()\n`, { mode: 0o755 })
  sshFakes(root)
  const run = (...args) => {
    const p = spawnSync(binary, ['remote', 'import', '17', ...args, '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: p.status, ...JSON.parse(p.stdout) }
  }
  const labelled = () => JSON.parse(readFileSync(db)).labelled
  assert.match(run('--yes').error.message, /no hcloud context is named for the server 17/)
  const untrusted = run('--context', 'billing', '--yes')
  assert.equal(untrusted.status, 1)
  assert.match(untrusted.error.message, /--yes cannot give trust to the host key SHA256:print-AAAAfixturekey of 203\.0\.113\.4/)
  const asked = run('--context', 'billing')
  assert.equal(asked.status, 0)
  assert.equal(asked.result.nextAction.action, 'remote import')
  assert.match(asked.result.question, /SHA256:print-AAAAfixturekey/)
  assert.deepEqual(labelled(), [])
  assert.throws(() => readFileSync(join(root, '.config/ndev/remote.json')), { code: 'ENOENT' })
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh/known_hosts'), '203.0.113.4 ssh-ed25519 AAAAfixturekey\n')
  const imported = run('--context', 'billing', '--yes')
  assert.equal(imported.status, 0, JSON.stringify(imported))
  assert.match(imported.result.text, /is now the remote work-box/)
  assert.deepEqual(labelled(), [
    ['server', 'add-label', '17', 'managed-by=ndev', 'ndev-name=work-box'],
    ['firewall', 'add-label', '5', 'managed-by=ndev', 'ndev-name=work-box'],
    ['floating-ip', 'add-label', '8', 'managed-by=ndev', 'ndev-name=work-box'],
  ])
  const store = JSON.parse(readFileSync(join(root, '.config/ndev/remote.json')))
  assert.deepEqual(store.hosts['work-box'], { context: 'billing', hostKey: 'ssh-ed25519 AAAAfixturekey', floatingIp: 8, ip: '203.0.113.4', imported: true })
})

test('remote create refuses without a confirmation, then restores a labelled server that must present the recorded host key', t => {
  const root = mkdtempSync(join(tmpdir(), 'ndev-create-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'owner/one' } }))
  mkdirSync(join(root, '.config/ndev'), { recursive: true })
  writeFileSync(join(root, '.config/ndev/remote.json'), JSON.stringify({ projects: {}, hosts: { 'work-box': { context: 'billing', hostKey: 'ssh-ed25519 AAAArecorded', floatingIp: 8, ip: '203.0.113.4' } } }))
  const labels = { 'managed-by': 'ndev', 'ndev-name': 'work-box' }
  const db = join(root, 'cloud.json')
  writeFileSync(db, JSON.stringify({
    presented: 'AAAAimpostor', servers: [], created: [], ssh: [],
    images: [{ id: 31, status: 'available', description: 'snap', disk_size: 40, image_size: 2, created: '2026-11-01T00:00:00Z', labels: { ...labels, 'ndev-type': 'cx33', 'ndev-location': 'fsn1' } }],
    fips: [{ id: 8, name: 'work-box', ip: '203.0.113.4', server: null, labels, home_location: { name: 'fsn1', network_zone: 'eu-central' } }],
    firewalls: [{ id: 5, name: 'work-box-ssh', labels, rules: [{ direction: 'in', protocol: 'tcp', port: '22' }] }],
  }))
  function fakeHcloud() {
    const fs = require('node:fs')
    const db = JSON.parse(fs.readFileSync('cloud.json'))
    const args = process.argv.slice(2)
    const send = data => console.log(JSON.stringify(data))
    const save = () => fs.writeFileSync('cloud.json', JSON.stringify(db))
    if (args[0] === 'context') return console.log('billing')
    switch (args.slice(2, 4).join(' ')) {
      case 'server list': return send(db.servers)
      case 'image list': return send(db.images)
      case 'floating-ip list': return send(db.fips)
      case 'firewall list': return send(db.firewalls)
      case 'api /pricing': return send({ pricing: { currency: 'EUR' } })
      case 'server-type describe': return send({ name: 'cx33', cores: 4, memory: 8, disk: 80, architecture: 'x86', prices: [{ location: 'fsn1', price_monthly: { gross: '10.19' } }] })
      case 'ssh-key list': return send([{ id: 1, name: 'mine', public_key: 'ssh-ed25519 AAAAmine' }])
      case 'server create': {
        db.created.push(args.slice(2))
        db.servers.push({ id: 90, name: 'work-box', status: 'running', labels: db.fips[0].labels, server_type: { name: 'cx33', disk: 80 }, public_net: { ipv4: { ip: '198.51.100.9' } } })
        return save()
      }
      case 'floating-ip assign':
        db.fips[0].server = Number(args[5])
        return save()
      default: console.error('unexpected command ' + args.join(' ')); process.exit(37)
    }
  }
  function fakeSsh() {
    const fs = require('node:fs')
    const db = JSON.parse(fs.readFileSync(process.env.HOME + '/cloud.json'))
    const args = process.argv.slice(2)
    const option = args.find(a => a.startsWith('UserKnownHostsFile='))
    const known = option ? option.slice(19) : process.env.HOME + '/.ssh/known_hosts'
    const host = args.at(-2).split('@')[1]
    const trusted = fs.existsSync(known) && fs.readFileSync(known, 'utf8').split('\n').includes(`${host} ssh-ed25519 ${db.presented}`)
    db.ssh.push({ target: args.at(-2), command: args.at(-1), known, trusted })
    fs.writeFileSync(process.env.HOME + '/cloud.json', JSON.stringify(db))
    if (!trusted) { console.error('Host key verification failed.'); process.exit(255) }
    if (args.at(-1) === 'test -f /var/run/reboot-required') process.exit(1)
  }
  writeFileSync(join(root, 'hcloud'), `#!/usr/bin/env node\n(${fakeHcloud.toString()})()\n`, { mode: 0o755 })
  writeFileSync(join(root, 'ssh'), `#!/usr/bin/env node\n(${fakeSsh.toString()})()\n`, { mode: 0o755 })
  writeFileSync(join(root, 'ssh-keygen'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(root, 'orca'), '#!/bin/sh\necho \'' + JSON.stringify({ ok: true, result: { environments: [{ id: 'env-9', name: 'work-box VM 1' }] } }) + "'\n", { mode: 0o755 })
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh/id_ed25519.pub'), 'ssh-ed25519 AAAAmine me@here\n')
  const create = (...flags) => {
    const p = spawnSync(binary, ['remote', 'create', 'work-box', '--context', 'billing', ...flags, '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: p.status, ...JSON.parse(p.stdout) }
  }
  const cloud = () => JSON.parse(readFileSync(db))
  const asked = create()
  assert.equal(asked.status, 0, JSON.stringify(asked))
  assert.equal(asked.result.nextAction.action, 'remote create')
  assert.match(asked.result.question, /restored from the snapshot 31/)
  assert.deepEqual(cloud().created, [])
  const impostor = create('--yes')
  assert.equal(impostor.status, 1)
  assert.match(impostor.error.message, /refused the host key/)
  assert.ok(cloud().ssh.every(call => !call.trusted))
  const created = cloud().created
  assert.equal(created.length, 1)
  for (const label of ['managed-by=ndev', 'ndev-name=work-box']) assert.ok(created[0].includes(label), created[0].join(' '))
  assert.ok(created[0].includes('31'))
  writeFileSync(db, JSON.stringify({ ...cloud(), presented: 'AAAArecorded', ssh: [] }))
  const up = create('--yes')
  assert.equal(up.status, 0, JSON.stringify(up))
  assert.match(up.result.text, /The remote work-box is up.*server 90, floating IPv4 203\.0\.113\.4/)
  const after = cloud()
  assert.equal(after.created.length, 1)
  assert.equal(after.fips[0].server, 90)
  assert.ok(after.ssh.length && after.ssh.every(call => call.trusted))
  assert.ok(after.ssh.some(call => call.target === 'orca@203.0.113.4'))
  assert.match(readFileSync(join(root, '.ssh/known_hosts'), 'utf8'), /^203\.0\.113\.4 ssh-ed25519 AAAArecorded$/m)
  assert.equal(JSON.parse(readFileSync(join(root, '.config/ndev/remote.json'))).projects['owner/one'].id, 'env-9')
})

function resizeWorld(t, extraWorkers = []) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-resize-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const env = { PATH: root + ':' + process.env.PATH, HOME: root }
  writeFileSync(join(root, '.neil-dev.json'), JSON.stringify({ github: { repo: 'owner/one' } }))
  const type = (name, cores, memory, disk) => ({ name, cores, memory, disk, architecture: 'x86', deprecated: false, deprecation: null, prices: [{ location: 'fsn1', price_monthly: { net: '0', gross: String(cores * 2.5) } }] })
  const box = { id: 901, name: 'orca-dev-2', status: 'running', primary_disk_size: 80, datacenter: { location: { name: 'fsn1' } } }
  const db = join(root, 'world.json')
  writeFileSync(db, JSON.stringify({
    box, types: [type('cx33', 4, 8, 80), type('cx43', 8, 16, 160)], boxType: 'cx33', sent: [], starts: [], changes: [],
    localRuns: ['run-1', 'run-2'],
    workers: [
      { dispatchId: 'd-a', runId: 'run-1', taskId: 't-a', worktree: 'repo-1::/home/orca/ws/772-docs', agent: 'claude', model: 'opus' },
      { dispatchId: 'd-e', runId: 'run-2', taskId: 't-e', worktree: 'repo-1::/home/orca/ws/fix-login', agent: 'codex' },
      ...extraWorkers,
    ],
    tasks: { 'run-1': [{ id: 't-a', task_title: '#772 docs', spec: 'Write the docs for #772.' }], 'run-2': [{ id: 't-e', task_title: 'Fix login', spec: 'Fix the login redirect.' }] },
  }))
  function fakeHcloud() {
    const fs = require('node:fs')
    const w = JSON.parse(fs.readFileSync(process.env.HOME + '/world.json'))
    const a = process.argv.slice(2)
    const save = () => fs.writeFileSync(process.env.HOME + '/world.json', JSON.stringify(w))
    const send = data => console.log(JSON.stringify(data))
    const box = () => ({ ...w.box, server_type: w.types.find(t => t.name === w.boxType) })
    if (a[0] === 'context') return console.log('proj')
    const r = a.slice(2).join(' ')
    if (r === 'server list -o json') return send([box()])
    if (r === 'server-type list -o json') return send(w.types)
    if (r === 'api /pricing') return send({ pricing: { currency: 'EUR' } })
    if (r === 'server describe 901 -o json') return send(box())
    w.changes.push(r)
    if (r.startsWith('server shutdown 901')) w.box.status = 'off'
    else if (r.startsWith('server change-type --keep-disk 901 ')) w.boxType = a.at(-1)
    else if (r === 'server poweron 901') w.box.status = 'running'
    else { console.error('unexpected hcloud ' + a.join(' ')); process.exit(37) }
    save()
  }
  function fakeSsh() {
    const fs = require('node:fs')
    const w = JSON.parse(fs.readFileSync(process.env.HOME + '/world.json'))
    const command = process.argv.at(-1)
    if (process.argv.at(-2) !== 'orca@88.99.125.86' || w.box.status !== 'running') { console.error('ssh: connect refused'); process.exit(255) }
    if (command.startsWith('curl -s http://169.254.169.254/')) return console.log(String(w.box.id))
    if (command.includes('handoff')) return console.log(w.sent.filter(id => command.includes(`paused ${id}`)).join('\n'))
    if (command !== 'true') { console.error('unexpected ssh ' + command); process.exit(9) }
  }
  function fakeOrca() {
    const fs = require('node:fs')
    const w = JSON.parse(fs.readFileSync(process.env.HOME + '/world.json'))
    const a = process.argv.slice(2)
    const save = () => fs.writeFileSync(process.env.HOME + '/world.json', JSON.stringify(w))
    const flag = name => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined)
    const ok = result => console.log(JSON.stringify({ ok: true, result }))
    const sub = a.slice(0, 2).join(' ')
    if (sub === 'environment list') return ok({ environments: [{ id: 'env-1', name: 'orca-dev-2' }] })
    if (sub === 'orchestration run-list') return ok({ runs: flag('--environment') ? [{ id: 'srv-runs' }] : w.localRuns.map(id => ({ id })) })
    if (sub === 'orchestration worker-list' && flag('--environment')) {
      return ok({ workers: w.workers.map(x => ({ dispatchId: x.dispatchId, taskId: x.taskId, dispatchStatus: 'dispatched', resource: { worktreeId: x.worktree }, projection: { liveness: { verdict: 'live' } } })), page: { hasMore: false } })
    }
    if (sub === 'orchestration worker-list') {
      return ok({ workers: w.workers.filter(x => x.runId === flag('--run')).map(x => ({ dispatchId: x.dispatchId, runId: x.runId, taskId: x.taskId, server: { environmentId: 'env-1' } })), page: { hasMore: false } })
    }
    if (sub === 'orchestration worker-show') {
      const x = w.workers.find(y => y.dispatchId === flag('--dispatch'))
      return ok({ worker: { startOptions: { agent: x.agent, launch: { requested: { agent: x.agent, ...(x.model ? { model: x.model } : {}) } } } } })
    }
    if (sub === 'orchestration task-list') return ok({ tasks: w.tasks[flag('--run')] ?? [] })
    if (sub === 'orchestration send') {
      w.sent.push(flag('--to').replace('dispatch:', ''))
      save()
      return ok({ id: 'msg-1' })
    }
    if (sub === 'orchestration worker-start') {
      w.starts.push(a)
      save()
      if (flag('--spec').includes('login redirect')) {
        console.log(JSON.stringify({ ok: true, result: { state: 'failed', dispatchId: 'new-e', lastError: 'agent_launch_failed', failedStage: 'launch', recovery: 'Run orca orchestration worker-release --dispatch new-e.' } }))
        process.exit(1)
      }
      return ok({ state: 'ready', dispatchId: 'new-a', taskId: 'nt-a' })
    }
    console.error('unexpected orca ' + a.join(' '))
    process.exit(23)
  }
  for (const [name, fn] of [['hcloud', fakeHcloud], ['ssh', fakeSsh], ['orca', fakeOrca]]) writeFileSync(join(root, name), `#!/usr/bin/env node\n(${fn.toString()})()\n`, { mode: 0o755 })
  writeFileSync(join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const resize = () => {
    const p = spawnSync(binary, ['remote', 'resize', 'cx43', '--context', 'proj', '--server', 'env-1', '--ssh', 'orca@88.99.125.86', '--yes', '--json'], { cwd: root, env, encoding: 'utf8' })
    return { status: p.status, ...JSON.parse(p.stdout) }
  }
  return { resize, world: () => JSON.parse(readFileSync(db)) }
}

test('remote resize refuses a worker on the box that no Run of this machine dispatched, before any change', t => {
  const { resize, world } = resizeWorld(t, [{ dispatchId: 'd-x', runId: 'run-9', taskId: 't-x', worktree: 'repo-1::/home/orca/x', agent: 'claude' }])
  const refused = resize()
  assert.equal(refused.status, 1)
  assert.match(refused.error.message, /d-x \(task t-x\): it runs on the box, but no Run of this machine dispatched it/)
  const w = world()
  assert.deepEqual([w.sent, w.changes, w.starts], [[], [], []])
})

test('remote resize resumes each paused worker in its worktree after the change and reports the one that failed to start', t => {
  const { resize, world } = resizeWorld(t)
  const result = resize()
  assert.equal(result.status, 1, JSON.stringify(result))
  const w = world()
  assert.deepEqual(w.sent.sort(), ['d-a', 'd-e'])
  assert.deepEqual(w.changes, ['server shutdown 901 --wait --wait-timeout 180s', 'server change-type --keep-disk 901 cx43', 'server poweron 901'])
  assert.equal(w.boxType, 'cx43')
  assert.equal(w.starts.length, 2)
  const a = w.starts.find(s => s.includes('run-1'))
  assert.equal(a[a.indexOf('--worktree') + 1], 'id:repo-1::/home/orca/ws/772-docs')
  assert.equal(a[a.indexOf('--on') + 1], 'env-1')
  assert.equal(a[a.indexOf('--model') + 1], 'opus')
  assert.match(a[a.indexOf('--spec') + 1], /^Write the docs for #772\.[\s\S]*Resume from ~\/handoff\/772\.md/)
  const message = result.error.message
  assert.match(message, /step 5 \(start the workers again\) failed: orca-dev-2 is now cx43, but 1 of 2 workers did not start again/)
  assert.match(message, /d-e \(Fix login\): .*agent_launch_failed at launch \(dispatch new-e\)/)
  assert.match(message, /Repair: orca orchestration worker-start --spec/)
  assert.match(message, /Started again:\n {2}d-a -> new-a/)
})
