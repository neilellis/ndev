import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const scripts = new URL('..', import.meta.url).pathname
const example = new URL('../../examples/fcc-analytics.conf', import.meta.url).pathname
const exampleText = readFileSync(example, 'utf8')

function run(script, args, { input = '', env = {} } = {}) {
  const result = spawnSync('bash', [join(scripts, script), ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } })
  return { status: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-server-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function config(t, text, extra = {}) {
  const dir = scratch(t)
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body)
  const file = join(dir, 'server.conf')
  writeFileSync(file, text)
  return file
}

const steps = ['sizing', 'base', 'sources', 'packages', 'kernel', 'swap', 'docker', 'users', 'mounts', 'runner-download', 'cockpit', 'ssh', 'ports', 'register', 'sweeps']

test('--plan prints every step and each runner of the fcc and analytics layout', () => {
  const r = run('provision.sh', ['--config', example, '--plan'])
  assert.equal(r.status, 0, r.all)
  steps.forEach((step, i) => assert.match(r.out, new RegExp(`^  step ${i + 1} ${step}: \\S`, 'm'), `step ${step} missing`))
  assert.match(r.out, /^provision\.sh plan for .*fcc-analytics\.conf: 6 runners, name prefix ssd-build, port base 21000, swap file 16G if the host has no swap$/m)
  assert.ok(r.out.includes('  runner ssd-build-1: user ci1, repository TathataSystems/fcc, labels fcc,supabase, ports 21100-21199, _work tmpfs 10G, tmp tmpfs 3G, unit actions.runner.TathataSystems-fcc.ssd-build-1.service\n'), r.out)
  assert.ok(r.out.includes('  runner ssd-build-5: user ci5, repository TathataSystems/analytics, labels tathata-build,supabase, ports 21500-21599, _work tmpfs 16G, tmp tmpfs 4G, unit actions.runner.TathataSystems-analytics.ssd-build-5.service\n'), r.out)
  assert.match(r.out, /step 1 sizing: .*one supabase runner per 4 CPUs, one runner per 2 CPUs, 8 GB per runner/)
  assert.match(r.out, /step 15 sweeps: .*fcc-runner-sweep\.timer.*TathataSystems\/fcc/)
  assert.match(r.out, /step 15 sweeps: .*fcc-docker-prepull\.timer/)
  assert.match(r.out, /step 7 docker: .*publish container ports on 127\.0\.0\.1 only/)
})

test('--plan marks a skipped step and refuses a step name it does not know', () => {
  const skipped = run('provision.sh', ['--config', example, '--plan', '--skip', 'packages,cockpit'])
  assert.equal(skipped.status, 0, skipped.all)
  assert.match(skipped.out, /^  step 4 packages: skipped by --skip$/m)
  assert.match(skipped.out, /^  step 11 cockpit: skipped by --skip$/m)
  const bad = run('provision.sh', ['--config', example, '--plan', '--skip', 'nothing'])
  assert.equal(bad.status, 2)
  assert.match(bad.err, /--skip names 'nothing', which is not a step\. The steps are: sizing base sources/)
})

test('provision.sh without --config refuses and prints its usage', () => {
  const r = run('provision.sh', ['--plan'])
  assert.equal(r.status, 2)
  assert.match(r.err, /give --config <file>/)
  assert.match(r.err, /^Usage: provision\.sh --config <file>/m)
})

test('runner-env.sh writes the fcc .env of a slot from the config', () => {
  const r = run('runner-env.sh', ['--config', example, '1'])
  assert.equal(r.status, 0, r.all)
  assert.equal(r.out, [
    'LANG=en_US.UTF-8', 'TMPDIR=/home/ci1/tmp', 'CI_RUNNER_SLOT=ci1', 'CI_PORT_BASE=21100',
    'SUPABASE_PROJECT_ID_SUFFIX=-ci1', 'SUPABASE_SHADOW_PORT=21100', 'SUPABASE_API_PORT=21101', 'SUPABASE_DB_PORT=21102',
    'SUPABASE_STUDIO_PORT=21103', 'SUPABASE_INBUCKET_PORT=21104', 'SUPABASE_SMTP_PORT=21105', 'SUPABASE_POP3_PORT=21106',
    'SUPABASE_ANALYTICS_PORT=21107', 'SUPABASE_POOLER_PORT=21109', 'SUPABASE_EDGE_INSPECTOR_PORT=21183',
    'RUNNER_TOOL_CACHE=/home/ci1/toolcache', '',
  ].join('\n'))
  const missing = run('runner-env.sh', ['--config', example, '7'])
  assert.equal(missing.status, 2)
  assert.match(missing.err, /slot 7 has no runner line in .*fcc-analytics\.conf\. Repair: add "runner = 7:<owner>\/<repo>:<labels>"/)
})

const minimal = 'name_prefix = build\nrunner = 1:acme/app:app\n'

const refusals = [
  ['an unknown field', 'name_prefix = build\ncolour = red\nrunner = 1:acme/app:app\n', /line 2: colour is not a known field\. Repair: .*name_prefix/],
  ['a line without =', 'name_prefix = build\nrunner 1:acme/app:app\n', /line 2: "runner 1:acme\/app:app" is not "key = value"\. Repair:/],
  ['slot 0', 'name_prefix = build\nrunner = 0:acme/app:app\n', /line 2: runner "0:acme\/app:app": the slot must be a number from 1 to 99\. Repair:/],
  ['a repository without owner', 'name_prefix = build\nrunner = 1:app:app\n', /line 2: runner "1:app:app": the repository must be <owner>\/<repo>\. Repair:/],
  ['upper-case labels', 'name_prefix = build\nrunner = 1:acme/app:App\n', /line 2: runner "1:acme\/app:App": labels must be a comma-separated list of lowercase names\. Repair:/],
  ['a slot named twice', 'name_prefix = build\nrunner = 1:acme/app:app\nrunner = 1:acme/app:app\n', /line 3: runner "1:acme\/app:app": slot 1 is already on line 2\. Repair:/],
  ['a field given twice', 'name_prefix = build\nname_prefix = other\nrunner = 1:acme/app:app\n', /line 2: name_prefix is already on line 1\. Repair: keep one\./],
  ['no name_prefix', 'runner = 1:acme/app:app\n', /server\.conf: no name_prefix\. Repair: add "name_prefix = <name>"/],
  ['no runner', 'name_prefix = build\n', /server\.conf: no runner\. Repair: add one "runner = <slot>:<owner>\/<repo>:<labels>" line/],
  ['a bad size', 'name_prefix = build\nwork_size = 10\nrunner = 1:acme/app:app\n', /line 2: work_size must be a whole number with M or G, such as 10G; got "10"\. Repair:/],
  ['a port block past 32767', 'name_prefix = build\nport_base = 30000\nrunner = 99:acme/app:app\n', /line 3: runner "99:acme\/app:app": slot 99 with port base 30000 ends at 39999, which is not below 32768.*Repair: use a lower port_base or a lower slot/],
  ['a sweep repository with no runner', 'name_prefix = build\nrunner = 1:acme/app:app\nsweep_repos = acme/other\n', /line 3: sweep_repos names acme\/other, which no runner line has\. Repair:/],
  ['a runner version without its checksum', 'name_prefix = build\nrunner = 1:acme/app:app\nrunner_version = 2.400.0\n', /server\.conf: runner_version is set but runner_sha256 is not\. Repair: give both/],
  ['a regular expression that does not compile', 'name_prefix = build\nrunner = 1:acme/app:app\ndocker_sweep_projects = ^(app\n', /line 3: docker_sweep_projects "\^\(app" is not a valid extended regular expression\. Repair:/],
  ['docker_sweep_keep without docker_sweep_projects', 'name_prefix = build\nrunner = 1:acme/app:app\ndocker_sweep_keep = ^app-ci({slots})$\n', /server\.conf: docker_sweep_keep is set but docker_sweep_projects is not\. Repair:/],
  ['a missing image list', 'name_prefix = build\nrunner = 1:acme/app:app\nprepull_images = images.txt\n', /line 3: prepull_images names .*images\.txt, which cannot be read\. Repair:/],
  ['an image list in another folder', 'name_prefix = build\nrunner = 1:acme/app:app\nprepull_images = lists/images.txt\n', /line 3: prepull_images must be a file name in the config's own folder, not "lists\/images\.txt"\. Repair:/],
  ['an env line that names a reserved variable', 'name_prefix = build\nrunner = 1:acme/app:app\nenv.TMPDIR = /tmp\n', /line 3: env\.TMPDIR sets TMPDIR, which runner-env\.sh writes itself\. Repair:/],
  ['a port offset above 99', 'name_prefix = build\nrunner = 1:acme/app:app\nport.API_PORT = 100\n', /line 3: port\.API_PORT must be an offset from 0 to 99; got "100"\. Repair:/],
  ['two port lines with one offset', 'name_prefix = build\nrunner = 1:acme/app:app\nport.API_PORT = 1\nport.DB_PORT = 1\n', /line 4: port\.DB_PORT uses offset 1, which port\.API_PORT on line 3 already uses\. Repair:/],
  ['a runner service name over 80 characters', 'name_prefix = a-very-long-name-prefix-for-this-build-server\nrunner = 1:acme-corporation/application-backend:app\n', /line 2: runner "1:acme-corporation\/application-backend:app": its service name actions\.runner\.acme-corporation-application-backend\.a-very-long-name-prefix-for-this-build-server-1\.service has 107 characters, and the runner shortens a name over 80, so the scripts would not find the unit\. Repair: use a shorter name_prefix/],
  ['an unknown apt source', 'name_prefix = build\nrunner = 1:acme/app:app\napt_sources = docker,yarn\n', /line 3: apt_sources names "yarn"\. Repair: use docker, github-cli, google-chrome or nodesource-22/],
]

for (const [what, text, message] of refusals) {
  test(`a config with ${what} is refused with the line and the repair`, t => {
    const r = run('provision.sh', ['--config', config(t, text), '--plan'])
    assert.equal(r.status, 2, r.all)
    assert.match(r.err, /^ci-server: /m)
    assert.match(r.err, message)
    assert.equal(r.out, '')
  })
}

test('a config file that cannot be read is refused by name', () => {
  const r = run('provision.sh', ['--config', '/nonexistent/server.conf', '--plan'])
  assert.equal(r.status, 2)
  assert.match(r.err, /cannot read the config file \/nonexistent\/server\.conf\. Repair:/)
})

test('a minimal config takes the defaults', t => {
  const r = run('provision.sh', ['--config', config(t, minimal), '--plan'])
  assert.equal(r.status, 0, r.all)
  assert.ok(r.out.includes('  runner build-1: user ci1, repository acme/app, labels app, ports 21100-21199, _work tmpfs 10G, tmp tmpfs 3G, unit actions.runner.acme-app.build-1.service\n'), r.out)
  assert.match(r.out, /step 2 base: set the time zone to UTC/)
  assert.match(r.out, /step 15 sweeps: nothing to install/)
})

test('sizing.sh refuses six supabase runners on 16 CPUs, the layout that ran at load 58', () => {
  const r = run('sizing.sh', ['--config', example, '--cpus', '16', '--mem-gb', '62'])
  assert.equal(r.status, 1, r.all)
  assert.match(r.all, /6 runners carry the supabase label, but 16 CPUs carry at most 4 \(one per 4 CPUs\)/)
  assert.match(r.all, /On 2026-11-24 six supabase runners on 16 CPUs ran at a load average of 58/)
  const fits = run('sizing.sh', ['--config', example, '--cpus', '24', '--mem-gb', '64'])
  assert.equal(fits.status, 0, fits.all)
  assert.match(fits.out, /6 runners, 6 with supabase, fit 24 CPUs and 64 GB/)
})

test('sizing.sh refuses too little memory and too many runners per CPU', t => {
  const file = config(t, 'name_prefix = build\nrunner = 1:acme/app:app\nrunner = 2:acme/app:app\nrunner = 3:acme/app:app\n')
  const r = run('sizing.sh', ['--config', file, '--cpus', '4', '--mem-gb', '16'])
  assert.equal(r.status, 1, r.all)
  assert.match(r.all, /3 runners on 4 CPUs is more than one runner per 2 CPUs \(2\)/)
  assert.match(r.all, /3 runners need at least 24 GB of memory \(8 GB each\), and the host has 16 GB/)
  const bad = run('sizing.sh', ['--config', file, '--cpus', 'many'])
  assert.equal(bad.status, 2)
  assert.match(bad.err, /--cpus must be a whole number; got 'many'/)
})

function fakeBin(t, name, body) {
  const dir = scratch(t)
  mkdirSync(join(dir, 'bin'))
  const path = join(dir, 'bin', name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return { dir, path }
}

test('verify-server.sh --only api passes a runner online with its labels and names the repair for each failure', t => {
  const labels = names => names.map(name => ({ name }))
  const page = { runners: [
    { name: 'build-1', status: 'online', labels: labels(['self-hosted', 'Linux', 'X64', 'app', 'heavy']) },
    { name: 'build-2', status: 'offline', labels: labels(['self-hosted', 'app']) },
    { name: 'build-3', status: 'online', labels: labels(['app']) },
  ] }
  const gh = fakeBin(t, 'gh', `case "$*" in *repos/acme/app/actions/runners*) cat "$FAKE_PAGE" ;; *) echo "gh: HTTP 404: Not Found" >&2; exit 1 ;; esac`)
  writeFileSync(join(gh.dir, 'page.json'), JSON.stringify(page))
  const env = { GH_BIN: gh.path, FAKE_PAGE: join(gh.dir, 'page.json') }
  const file = config(t, 'name_prefix = build\nrunner = 1:acme/app:app,heavy\nrunner = 2:acme/app:app\nrunner = 3:acme/app:app,heavy\nrunner = 4:acme/app:app\nrunner = 5:acme/other:app\n')
  const r = run('verify-server.sh', ['--config', file, '--only', 'api'], { env })
  assert.equal(r.status, 1, r.all)
  assert.match(r.out, /^PASS build-1 is online in acme\/app with labels app,heavy$/m)
  assert.match(r.out, /^FAIL build-2 is online in acme\/app with labels app: build-2 is offline in acme\/app\. On the host: systemctl status actions\.runner\.acme-app\.build-2\.service$/m)
  assert.match(r.out, /^FAIL build-3 .*: build-3 has labels 'app', expected 'app,heavy'/m)
  assert.match(r.out, /^FAIL build-4 .*: acme\/app has no runner named build-4\. Register it/m)
  assert.match(r.out, /^FAIL build-5 .*: gh api repos\/acme\/other\/actions\/runners failed: gh: HTTP 404: Not Found/m)
  assert.match(r.out, /^verify-server: 1 passed, 4 failed$/m)
})

test('docker-sweep.sh --dry-run lists the old leftovers the config owns and keeps the rest', t => {
  const now = 1_800_000_000
  const old = '2026-01-01 00:00:00 +0000 UTC'
  const young = new Date((now - 60) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC')
  const docker = fakeBin(t, 'docker', [
    'case "$1 $2" in',
    `  "ps -a") if [[ "$*" == *--filter* ]]; then exit 0; fi; printf '%s\\t%s\\t%s\\t%s\\t%s\\n' c1 fcc-falkordb-check-7 falkordb/falkordb-server:6 "${old}" "" c2 graphdb-1-2 img "${young}" "" c3 0123456789abcdef0123456789abcdef_falkor falkordb/falkordb-server:6 "${old}" "" c4 web-1 nginx "${old}" fcc-proto-ci2 c5 db-1 postgres "${old}" fcc-test-pg-ci1 c6 other postgres "${old}" another ;;`,
    `  "volume ls") printf '%s\\t%s\\n' v1 fcc-test-pg v2 fcc-test-pg-ci1 v3 another ;;`,
    `  "volume inspect") echo "${old}" ;;`,
    `  "network ls") printf '%s\\t%s\\n' supabase_network_fcc-proto-ci3 "${old}" supabase_network_fcc-test-pg-ci1 "${old}" bridge "${old}" ;;`,
    `  "image ls") printf '%s\\t%s\\t%s\\t%s\\n' i1 fcc-graphdb-1-2 latest "${old}" i2 postgres 16 "${old}" ;;`,
    '  *) echo "fake docker: unexpected $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'))
  const file = config(t, exampleText.replace('prepull_images = fcc-ci-images.txt\n', ''))
  const r = run('docker-sweep.sh', ['--config', file, '--dry-run', '--now', String(now)], { env: { PATH: `${join(docker.dir, 'bin')}:${process.env.PATH}` } })
  assert.equal(r.status, 0, r.all)
  assert.match(r.out, /would remove container fcc-falkordb-check-7 \(/)
  assert.match(r.out, /would remove container 0123456789abcdef0123456789abcdef_falkor \(/)
  assert.match(r.out, /would remove container web-1 \(container of the project fcc-proto-ci2/)
  assert.match(r.out, /would remove volume v1 \(/)
  assert.match(r.out, /would remove network supabase_network_fcc-proto-ci3 \(/)
  assert.match(r.out, /would remove image fcc-graphdb-1-2:latest \(/)
  for (const kept of ['container graphdb-1-2 ', 'container db-1 ', 'container other ', 'volume v2 ', 'volume v3 ', 'network supabase_network_fcc-test-pg-ci1 ', 'network bridge ', 'image postgres:16 ']) {
    assert.ok(!r.out.includes(`would remove ${kept}`), `${kept}must be kept: ${r.out}`)
  }
  assert.match(r.out, /docker-sweep: would remove 3 containers, 1 volumes, 1 networks, 1 images$/m)
})

test('docker-sweep.sh removes each tag of an old image by its own reference, and an untagged image by its ID', t => {
  const old = '2026-01-01 00:00:00 +0000 UTC'
  const docker = fakeBin(t, 'docker', [
    'case "$1 $2" in',
    '  "ps -a") if [[ "$*" == *"--filter ancestor="* ]]; then echo "$*" >>"$FAKE_LOG.ancestor"; fi; exit 0 ;;',
    '  "volume ls"|"network ls") exit 0 ;;',
    `  "image ls") printf '%s\\t%s\\t%s\\t%s\\n' i1 fcc-graphdb-1-2 latest "${old}" i1 fcc-graphdb-1-2 old "${old}" i9 fcc-graphdb-3-4 "<none>" "${old}" ;;`,
    '  "image rm") case "$3" in *:*|i9) echo "$3" >>"$FAKE_LOG" ;; *) echo "Error: No such image: $3:latest" >&2; exit 1 ;; esac ;;',
    '  *) echo "fake docker: unexpected $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'))
  const log = join(docker.dir, 'removed')
  const file = config(t, 'name_prefix = build\nrunner = 1:acme/app:app\ndocker_sweep_images = ^fcc-graphdb-\n')
  const r = run('docker-sweep.sh', ['--config', file, '--now', '1800000000'], { env: { PATH: `${join(docker.dir, 'bin')}:${process.env.PATH}`, FAKE_LOG: log } })
  assert.equal(r.status, 0, r.all)
  assert.equal(readFileSync(log, 'utf8'), 'fcc-graphdb-1-2:latest\nfcc-graphdb-1-2:old\ni9\n')
  assert.match(readFileSync(`${log}.ancestor`, 'utf8'), /ancestor=fcc-graphdb-1-2:old/)
  assert.match(r.out, /docker-sweep: removed 0 containers, 0 volumes, 0 networks, 3 images$/m)
})

test('docker-sweep.sh refuses a config with nothing to sweep', t => {
  const r = run('docker-sweep.sh', ['--config', config(t, minimal), '--dry-run'])
  assert.equal(r.status, 2)
  assert.match(r.err, /sets no docker_sweep_projects, docker_sweep_containers or docker_sweep_images, so there is nothing to sweep\. Repair:/)
})

test('docker-prepull.sh names the image list it cannot read', () => {
  const r = run('docker-prepull.sh', ['/nonexistent/images.txt'])
  assert.equal(r.status, 2)
  assert.match(r.err, /cannot read the image list \/nonexistent\/images\.txt\. Repair:/)
})
