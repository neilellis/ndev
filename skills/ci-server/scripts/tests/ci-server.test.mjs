import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..')
const example = join(scripts, '..', 'examples', 'fcc-ssd-build.conf')

const workdir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-server-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const write = (file, text, mode) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode) chmodSync(file, mode)
  return file
}
const run = (script, args, env = {}) => {
  const r = spawnSync('bash', [join(scripts, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

test('provision.sh --plan reads a config and prints each runner and step', () => {
  const r = run('provision.sh', ['--config', example, '--plan'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /runner ssd-build-5: user ci5, repository TathataSystems\/analytics, labels tathata-build,supabase, ports 21500-21599, _work tmpfs 16G, tmp tmpfs 4G/)
  assert.match(r.out, /step 15 sweeps: recovery drop-in and runner sweep for TathataSystems\/fcc/)
})

test('a --runner on the command line replaces the runners of the config', () => {
  const r = run('provision.sh', ['--config', example, '--plan', '--runner', '7:TathataSystems/fcc:fcc'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /plan: 1 runners/)
  assert.match(r.out, /runner ssd-build-7: user ci7, repository TathataSystems\/fcc/)
})

test('provision.sh refuses a bad config with exit 2, the line and its usage', async t => {
  const dir = workdir(t)
  const cases = [
    ['name_prefix=x\nrunner=1:a/b:c\ncolour=blue\n', /line 3: unknown key 'colour'/],
    ['runner=1:a/b:c\n', /give the runner name prefix/],
    ['name_prefix=x\n', /give at least one runner/],
    ['name_prefix=x\nrunner=1:a/b:c\nsweep_repo=a/other\n', /sweep_repo a\/other has no runner in this plan/],
    ['name_prefix=x\nrunner=1:a/b:c\nrunner_version=2.400.0\n', /runner_version and runner_sha256 go together/],
    ['name_prefix=x\nrunner=1:a/b:c\nsupabase=true\n', /supabase must be yes or no/],
    ['name_prefix=x\nrunner=1:a/b:c\nrunner=1:a/b:d\n', /slot 1 is named twice/],
    ['name_prefix=x\nrunner 1\n', /line 2: 'runner 1' is not key=value/],
  ]
  for (const [text, message] of cases) {
    const r = run('provision.sh', ['--config', write(join(dir, 'c.conf'), text), '--plan'])
    assert.equal(r.status, 2, `${text}: ${r.out}`)
    assert.match(r.out, message)
    assert.match(r.out, /^Usage: provision.sh/m)
  }
  const missing = run('provision.sh', ['--config', join(dir, 'none.conf'), '--plan'])
  assert.equal(missing.status, 2)
  assert.match(missing.out, /cannot read the config file/)
})

test('sizing.sh refuses the six-supabase-runner layout that ran at load 58 on 16 CPUs', () => {
  const r = run('sizing.sh', ['--config', example, '--cpus', '16', '--mem-gb', '62'])
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /6 runners carry the supabase label, but 16 CPUs carry at most 4/)
  assert.match(r.out, /load average of 58/)
})

test('sizing.sh passes four supabase runners on 16 CPUs and 64 GB, and counts a heavy label of choice', () => {
  const fits = run('sizing.sh', ['--cpus', '16', '--mem-gb', '64', '--runners', '4', '--heavy', '4'])
  assert.equal(fits.status, 0, fits.out)
  assert.match(fits.out, /4 runners \(4 with supabase\) fit 16 CPUs and 64 GB/)
  const memory = run('sizing.sh', ['--cpus', '32', '--mem-gb', '30', '--runners', '4'])
  assert.equal(memory.status, 1)
  assert.match(memory.out, /4 runners need at least 32 GB of memory/)
  const label = run('sizing.sh', ['--name-prefix', 'x', '--cpus', '8', '--mem-gb', '64', '--heavy-label', 'stack', '--runner', '1:a/b:stack', '--runner', '2:a/b:stack', '--runner', '3:a/b:stack'])
  assert.equal(label.status, 1)
  assert.match(label.out, /3 runners carry the stack label, but 8 CPUs carry at most 2/)
  const both = run('sizing.sh', ['--config', example, '--runners', '2'])
  assert.equal(both.status, 2)
})

const fakeGh = dir => {
  const labels = '[{"name":"self-hosted"},{"name":"Linux"},{"name":"X64"},{"name":"app"},{"name":"supabase"}]'
  write(join(dir, 'api', 'app.json'), `{"runners":[{"name":"acme-build-1","status":"online","labels":${labels}}]}\n{"runners":[{"name":"acme-build-2","status":"offline","labels":${labels}},{"name":"acme-build-3","status":"online","labels":[{"name":"app"}]}]}\n`)
  return write(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
case "$*" in
  *"repos/acme/app/actions/runners"*) cat "${join(dir, 'api', 'app.json')}" ;;
  *"repos/acme/data/actions/runners"*) echo "gh: HTTP 404: Not Found" >&2; exit 1 ;;
esac
`, 0o755)
}

test('verify-server.sh --only api checks each runner is online with exactly its labels', async t => {
  const dir = workdir(t)
  const env = { GH_BIN: fakeGh(dir) }
  const verify = (...args) => run('verify-server.sh', ['--only', 'api', '--name-prefix', 'acme-build', ...args], env)

  let r = verify('--runner', '1:acme/app:app,supabase')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /^PASS acme-build-1 is online/m)
  assert.match(r.out, /1 passed, 0 failed/)

  r = verify('--runner', '2:acme/app:app,supabase')
  assert.equal(r.status, 1)
  assert.match(r.out, /^FAIL acme-build-2 .*: acme-build-2 is offline in acme\/app\. On the host: systemctl status actions\.runner\.acme-app\.acme-build-2\.service/m)

  r = verify('--runner', '3:acme/app:app,supabase')
  assert.equal(r.status, 1)
  assert.match(r.out, /has labels 'app', expected 'app,supabase'/)

  r = verify('--runner', '4:acme/app:app')
  assert.equal(r.status, 1)
  assert.match(r.out, /acme\/app has no runner named acme-build-4/)

  r = verify('--runner', '1:acme/app:app,supabase', '--runner', '5:acme/data:data')
  assert.equal(r.status, 1)
  assert.match(r.out, /^FAIL acme-build-5 .*gh api repos\/acme\/data\/actions\/runners failed: gh: HTTP 404/m)
  assert.match(r.out, /1 passed, 1 failed/)

  r = run('verify-server.sh', ['--only', 'api'])
  assert.equal(r.status, 2)
  assert.match(r.out, /give at least one runner/)
})

const fakeDocker = dir => write(join(dir, 'bin', 'docker'), `#!/usr/bin/env bash
old=2026-11-24T08:00:00Z
young=2026-11-24T11:30:00Z
echo "$*" >>"${join(dir, 'calls')}"
case "$1 $2" in
  "ps -a")
    case "$*" in
      *"--filter volume=app-test-ci9_db"*|*"--filter network=supabase_network_app-test-ci9"*) ;;
      *"--filter"*) echo busy ;;
      *) printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \\
           c1 app-test-ci9-db-1 postgres:17 "$old" app-test-ci9 \\
           c2 app-test-ci1-db-1 postgres:17 "$old" app-test-ci1 \\
           c3 app-test-ci9-web-1 nginx "$young" app-test-ci9 \\
           c4 0123456789abcdef0123456789abcdef_svc falkordb/falkordb-server:6 "$old" "" \\
           c5 unrelated postgres:17 "$old" other ;;
    esac ;;
  "volume ls") printf 'app-test-ci9_db\\tapp-test-ci9\\nother_db\\tother\\n' ;;
  "volume inspect") echo "$old" ;;
  "network ls") printf 'supabase_network_app-test-ci9\\t%s\\t\\nbridge\\t%s\\t\\n' "$old" "$old" ;;
  "image ls") printf 'app-graph-1-2\\t%s\\npostgres\\t%s\\n' "$old" "$old" ;;
  *) if [ -e "${join(dir, 'rm-fails')}" ]; then echo "Error: conflict (fake)" >&2; exit 1; fi ;;
esac
`, 0o755)

test('docker-sweep.sh removes only old leftovers that the config names, and keeps the kept projects', async t => {
  const dir = workdir(t)
  fakeDocker(dir)
  const config = write(join(dir, 'sweep.conf'), 'project=^app-test(-ci[0-9]+)?$\nkeep=^app-test-ci1$\ncontainer=^[0-9a-f]{32}_[^ ]* falkordb/falkordb-server\nimage=^app-graph-[0-9]+-[0-9]+$\n')
  const now = String(Date.parse('2026-11-24T12:00:00Z') / 1000)
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}` }

  let r = run('docker-sweep.sh', ['--config', config, '--now', now, '--dry-run'], env)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /would remove container app-test-ci9-db-1 \(container of the compose project app-test-ci9\)/)
  assert.match(r.out, /would remove container 0123456789abcdef0123456789abcdef_svc \(matches a container rule\)/)
  assert.match(r.out, /would remove volume app-test-ci9_db/)
  assert.match(r.out, /would remove network supabase_network_app-test-ci9/)
  assert.doesNotMatch(r.out, /app-test-ci1|app-test-ci9-web-1|unrelated|other_db|bridge|image app-graph/)
  assert.match(r.out, /would remove 2 containers, 1 volumes, 1 networks, 0 images/)
  assert.doesNotMatch(readFileSync(join(dir, 'calls'), 'utf8'), /^(rm|volume rm|network rm|image rm)/m)

  r = run('docker-sweep.sh', ['--config', config, '--now', now], env)
  assert.equal(r.status, 0, r.out)
  assert.match(readFileSync(join(dir, 'calls'), 'utf8'), /^rm -f -v c1$/m)

  write(join(dir, 'rm-fails'), '')
  r = run('docker-sweep.sh', ['--config', config, '--now', now], env)
  assert.equal(r.status, 1)
  assert.match(r.out, /could not remove container app-test-ci9-db-1: Error: conflict \(fake\)/)

  const bad = write(join(dir, 'bad.conf'), 'project=(\n')
  r = run('docker-sweep.sh', ['--config', bad], env)
  assert.equal(r.status, 2)
  assert.match(r.out, /'\(' is not a valid extended regular expression/)
})
