import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const skill = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const image = process.env.CI_SERVER_TEST_IMAGE ?? 'ubuntu:24.04'

test('provision.sh and verify-server.sh run for real on Ubuntu 24.04 in a container', { timeout: 600_000 }, () => {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' })
  assert.equal(docker.status, 0, `docker info failed (${docker.error?.message ?? docker.stderr.trim()}). This test needs a running Docker; start it, or run the test where Docker is.`)
  const run = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${skill}:/skill:ro`, image, 'bash', '/skill/scripts/tests/provision-in-container.sh'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.status, 0, `the container test exited ${run.status}:\n${output}`)
  assert.match(output, /provision \(in container\): all passed/)
  assert.doesNotMatch(output, /^FAIL /m)
})
