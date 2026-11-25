import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const skill = new URL('../../', import.meta.url).pathname
const image = 'ubuntu:24.04'
const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' })
const dockerWorks = docker.status === 0
const reason = docker.error ? `docker is not installed (${docker.error.message})` : `docker info exited ${docker.status}: ${docker.stderr.trim()}`

test('provision.sh provisions, repeats with no change, and verify-server.sh checks the host, inside Ubuntu 24.04', { skip: !dockerWorks && !process.env.CI && `${reason}; CI runs this test` }, () => {
  assert.ok(dockerWorks, `the container test needs docker in CI: ${reason}`)
  const pulled = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' })
  if (pulled.status !== 0) {
    const pull = spawnSync('docker', ['pull', '-q', image], { encoding: 'utf8' })
    assert.equal(pull.status, 0, `docker pull ${image} exited ${pull.status}: ${pull.stderr}`)
  }
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${skill}:/skill:ro`, image, 'bash', '/skill/scripts/tests/provision-container.sh'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const output = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 0, output.split('\n').filter(line => /^FAIL|failed|provision\.sh:.*(exited with code|step )/.test(line)).join('\n') || output)
  assert.match(r.stdout, /^provision \(in container\): all passed$/m)
})
