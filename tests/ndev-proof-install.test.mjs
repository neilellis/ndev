import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const executable = join(repoRoot, 'bin/ndev')
const REF = 'a'.repeat(40)
const WORKFLOW = '.github/workflows/ndev-proof.yml'
const CLAUDE = JSON.parse(readFileSync(join(repoRoot, 'scripts/test/sdk-runtime.json'), 'utf8'))

const FAKE_GH = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/actions\\/secrets$/.test(args[1])) {
  if (process.env.FAKE_GH_SECRETS_403) { console.error('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1) }
  for (const name of (process.env.FAKE_GH_SECRETS || '').split(',').filter(Boolean)) console.log(name)
  process.exit(0)
}
console.error('fake gh: unexpected ' + args.join(' '))
process.exit(1)
`

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function project(t, files) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-proof-install-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'web')
  git(base, 'init', '-q', '-b', 'main', root)
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/web.git')
  for (const [name, text] of Object.entries(files).filter(([, text]) => text !== undefined)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base', '--allow-empty')
  writeFileSync(join(base, 'fake-gh.mjs'), FAKE_GH)
  writeFileSync(join(base, 'gh.sh'), `#!/bin/bash\nexec node ${join(base, 'fake-gh.mjs')} "$@"\n`)
  chmodSync(join(base, 'gh.sh'), 0o755)
  return { base, root }
}

function install({ base, root }, args = [], env = {}) {
  const clean = { ...process.env }
  for (const name of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'FAKE_GH_SECRETS', 'FAKE_GH_SECRETS_403']) delete clean[name]
  const result = spawnSync(executable, ['proof', 'install', root, '--ref', REF, ...args, '--json'], {
    cwd: base, encoding: 'utf8', timeout: 60_000,
    env: { ...clean, NDEV_FLOW_GH: join(base, 'gh.sh'), FAKE_GH_LOG: join(base, 'gh.log'), FAKE_GH_SECRETS: 'ANTHROPIC_API_KEY', ...env },
  })
  assert.ifError(result.error)
  return { status: result.status, json: JSON.parse(result.stdout) }
}

const read = (root, name) => readFileSync(join(root, name), 'utf8')
const config = root => JSON.parse(read(root, '.ndev.json'))

const next = {
  'package.json': { name: 'web', scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '15.0.0', react: '19.0.0' }, devDependencies: { playwright: '1.50.0' } },
  'package-lock.json': { lockfileVersion: 3 },
  'next.config.mjs': 'export default {}\n',
}
const vite = {
  'package.json': { name: 'site', scripts: { dev: 'vite --port 4000' }, devDependencies: { vite: '6.0.0' } },
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'vite.config.js': 'export default {}\n',
}
const library = {
  'package.json': { name: 'lib', scripts: { test: 'node --test' } },
  'package-lock.json': { lockfileVersion: 3 },
}

test('a Next.js project gets the workflow and its dev server after you confirm', t => {
  const repo = project(t, next)
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.deepEqual(config(repo.root).devServers, { web: { command: 'npm run dev', port: 3000, ready: 'http://localhost:3000/', routes: ['/'] } })
  assert.deepEqual(config(repo.root).proof, {})
  const workflow = read(repo.root, WORKFLOW)
  for (const line of workflow.split('\n').filter(line => /^\s*(- )?uses:/.test(line))) assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, line)
  assert.match(workflow, new RegExp(`NDEV_REF: ${REF}`))
  assert.match(workflow, new RegExp(`${CLAUDE.package.replace('/', '\\/')}@\\$CLAUDE_CODE_VERSION`))
  assert.match(workflow, new RegExp(`CLAUDE_CODE_VERSION: ${CLAUDE.version.replaceAll('.', '\\.')}`))
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /^permissions: \{\}$/m)
  assert.match(workflow, /contents: write\n\s+pull-requests: write\n\s+checks: write/)
  assert.match(workflow, /group: ndev-proof-\$\{\{ github\.event\.pull_request\.number \}\}/)
  assert.match(workflow, /run: npm ci/)
  assert.match(workflow, /npx playwright install --with-deps chromium/)
  assert.match(workflow, /proof run --pr "\$PR" --base "origin\/\$BASE_REF"/)
  assert.equal(result.json.result.secret.state, 'set')
  assert.match(result.json.result.text, /required/i)
  assert.match(result.json.result.text, /ndev proof/)
  assert.deepEqual(result.json.result.playwright.missing, [])
})

test('a Vite project with pnpm gets its port from the script, and the missing Playwright and secret are named', t => {
  const repo = project(t, vite)
  const result = install(repo, ['--yes'], { FAKE_GH_SECRETS: 'OTHER' })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.deepEqual(config(repo.root).devServers, { web: { command: 'pnpm run dev', port: 4000, ready: 'http://localhost:4000/', routes: ['/'] } })
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /corepack enable/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.deepEqual(result.json.result.playwright.missing, ['.'])
  assert.match(result.json.result.text, /pnpm add -D playwright/)
  assert.equal(result.json.result.secret.state, 'missing')
  assert.match(result.json.result.text, /gh secret set ANTHROPIC_API_KEY --repo acme\/web/)
})

test('a project with no web app installs its dependencies for the tests and the model check, with no dev server or browser step', t => {
  const repo = project(t, library)
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(config(repo.root).devServers, undefined)
  assert.deepEqual(config(repo.root).proof, {})
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /run: npm ci\n/)
  assert.doesNotMatch(workflow, /playwright/)
  assert.deepEqual(result.json.result.servers, [])
})

test('a project with no package.json gets no install step', t => {
  const repo = project(t, { 'main.py': 'print(1)\n' })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.doesNotMatch(read(repo.root, WORKFLOW), /Install the dependencies|playwright/)
})

test('--dry-run writes nothing and says what it would write', t => {
  const repo = project(t, next)
  const result = install(repo, ['--dry-run', '--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.ok(!existsSync(join(repo.root, WORKFLOW)))
  assert.ok(!existsSync(join(repo.root, '.ndev.json')))
  assert.equal(result.json.result.workflow.action, 'create')
  assert.equal(result.json.result.config.action, 'create')
  assert.equal(git(repo.root, 'status', '--porcelain'), '')
})

test('a second run changes nothing', t => {
  const repo = project(t, next)
  assert.equal(install(repo, ['--yes']).status, 0)
  const before = { workflow: read(repo.root, WORKFLOW), config: read(repo.root, '.ndev.json') }
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.workflow.action, 'unchanged')
  assert.equal(result.json.result.config.action, 'unchanged')
  assert.deepEqual({ workflow: read(repo.root, WORKFLOW), config: read(repo.root, '.ndev.json') }, before)
})

test('without --yes the dev servers wait for your confirmation, and .ndev.json is not written', t => {
  const repo = project(t, next)
  const result = install(repo)
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.ok(!existsSync(join(repo.root, '.ndev.json')))
  assert.ok(existsSync(join(repo.root, WORKFLOW)))
  assert.equal(result.json.result.config.action, 'pending')
  assert.match(result.json.result.text, /--yes/)
  assert.match(result.json.result.text, /npm run dev/)
})

test('dev servers that .ndev.json already has are kept', t => {
  const docs = { docs: { command: 'npm run docs', port: 8080, ready: 'http://localhost:8080/' } }
  const repo = project(t, { ...next, '.ndev.json': { devServers: docs } })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.deepEqual(config(repo.root).devServers, docs)
  assert.deepEqual(config(repo.root).proof, {})
})

test('a workflow that you changed is not replaced without --force', t => {
  const repo = project(t, next)
  assert.equal(install(repo, ['--yes']).status, 0)
  writeFileSync(join(repo.root, WORKFLOW), `${read(repo.root, WORKFLOW)}# mine\n`)
  const refused = install(repo, ['--yes'])
  assert.equal(refused.status, 1, JSON.stringify(refused.json))
  assert.match(refused.json.error.message, /ndev-proof\.yml/)
  assert.match(refused.json.error.repair, /--force/)
  const forced = install(repo, ['--yes', '--force'])
  assert.equal(forced.status, 0, JSON.stringify(forced.json))
  assert.equal(forced.json.result.workflow.action, 'update')
  assert.doesNotMatch(read(repo.root, WORKFLOW), /# mine/)
})

test('when the secrets cannot be read, the secret state is unknown with the reason', t => {
  const repo = project(t, library)
  const result = install(repo, ['--yes'], { FAKE_GH_SECRETS_403: '1' })
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.secret.state, 'unknown')
  assert.match(result.json.result.secret.reason, /HTTP 403/)
})

test('the ndev ref must be a full commit id', t => {
  const repo = project(t, library)
  const result = install(repo, ['--ref', 'main'])
  assert.equal(result.status, 2, JSON.stringify(result.json))
  assert.match(result.json.error.message, /--ref/)
})

test('the project path must be the top of a git repository', t => {
  const repo = project(t, library)
  mkdirSync(join(repo.root, 'sub'))
  const result = install({ ...repo, root: join(repo.root, 'sub') })
  assert.equal(result.status, 2, JSON.stringify(result.json))
  assert.match(result.json.error.message, /git repository/)
})

const actionlint = spawnSync('actionlint', ['-version'], { encoding: 'utf8' })
for (const [name, files] of [['Next.js', next], ['Vite', vite], ['no web app', library]]) {
  test(`the workflow for ${name} passes actionlint`, { skip: actionlint.error ? 'actionlint is not installed' : false }, t => {
    const repo = project(t, files)
    assert.equal(install(repo, ['--yes']).status, 0)
    const lint = spawnSync('actionlint', [join(repo.root, WORKFLOW)], { encoding: 'utf8' })
    assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`)
  })
}

test('--dry-run on a changed workflow says it differs and needs --force, and writes nothing', t => {
  const repo = project(t, next)
  assert.equal(install(repo, ['--yes']).status, 0)
  writeFileSync(join(repo.root, WORKFLOW), `${read(repo.root, WORKFLOW)}# mine\n`)
  const result = install(repo, ['--dry-run'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.equal(result.json.result.workflow.action, 'differs')
  assert.match(result.json.result.text, /--force/)
  assert.match(read(repo.root, WORKFLOW), /# mine/)
})

test('the secret check reads every page, and a missing key names the org secrets that it cannot see', t => {
  const repo = project(t, library)
  const result = install(repo, ['--yes'], { FAKE_GH_SECRETS: 'OTHER' })
  const calls = readFileSync(join(repo.base, 'gh.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.some(args => args.includes('--paginate')), JSON.stringify(calls))
  assert.match(result.json.result.text, /organization secret/)
})

test('the workflow masks the encoded token, and its job is not the ndev proof check', t => {
  const repo = project(t, library)
  assert.equal(install(repo, ['--yes']).status, 0)
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /::add-mask::\$GIT_CONFIG_VALUE_0/)
  assert.doesNotMatch(workflow, /base64 -w0/)
  assert.doesNotMatch(workflow, /^    name: ndev proof$/m)
})

test('a Yarn Berry project installs with --immutable', t => {
  const repo = project(t, { ...vite, 'pnpm-lock.yaml': undefined, 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'nodeLinker: node-modules\n' })
  assert.equal(install(repo, ['--yes']).status, 0)
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /yarn install --immutable/)
  assert.doesNotMatch(workflow, /--frozen-lockfile/)
})

test('two workspace apps with one folder name stop the install, naming both', t => {
  const app = { scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } }
  const repo = project(t, {
    'package.json': { name: 'mono', workspaces: ['apps/*', 'packages/*'] },
    'package-lock.json': { lockfileVersion: 3 },
    'apps/web/package.json': app,
    'packages/web/package.json': app,
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 1, JSON.stringify(result.json))
  assert.match(result.json.error.message, /apps\/web/)
  assert.match(result.json.error.message, /packages\/web/)
  assert.ok(!existsSync(join(repo.root, WORKFLOW)))
})

test('a web app in a subfolder with its own lockfile is found and installed in that folder', t => {
  const repo = project(t, {
    'package.json': { name: 'tool', scripts: { test: 'node --test' } },
    'package-lock.json': { lockfileVersion: 3 },
    'site/package.json': { name: 'site', scripts: { dev: 'next dev' }, dependencies: { next: '16.0.0' }, devDependencies: { playwright: '1.50.0' } },
    'site/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'notes/package.json': { name: 'notes', scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } },
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.deepEqual(config(repo.root).devServers, { site: { command: 'pnpm run dev', cwd: 'site', port: 3000, ready: 'http://localhost:3000/', routes: ['/'] } })
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /pnpm install --frozen-lockfile\n\s+working-directory: site/)
  assert.match(workflow, /npx playwright install --with-deps chromium\n\s+working-directory: site/)
  assert.match(workflow, /run: npm ci\n(?!\s+working-directory)/)
  assert.equal(workflow.match(/playwright install/g).length, 1)
})

test('a subfolder app with no Playwright gets the add command of its own package manager', t => {
  const repo = project(t, {
    'site/package.json': { name: 'site', scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } },
    'site/yarn.lock': '# yarn lockfile v1\n',
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.deepEqual(result.json.result.playwright.missing, ['site'])
  assert.match(result.json.result.text, /cd site && yarn add -D playwright/)
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /yarn install --frozen-lockfile\n\s+working-directory: site/)
  assert.doesNotMatch(workflow, /npm ci/)
})

test('a workspace member with its own lockfile is installed at the root, once', t => {
  const repo = project(t, {
    'package.json': { name: 'mono', private: true, workspaces: ['apps/*'] },
    'package-lock.json': { lockfileVersion: 3 },
    'apps/web/package.json': { name: 'web', scripts: { dev: 'next dev' }, dependencies: { next: '16.0.0' } },
    'apps/web/package-lock.json': { lockfileVersion: 3 },
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const workflow = read(repo.root, WORKFLOW)
  assert.equal(workflow.match(/npm ci/g).length, 1)
  assert.doesNotMatch(workflow, /npm ci\n\s+working-directory/)
})

test('a subfolder app named like the root app stops the install with both folders named', t => {
  const repo = project(t, {
    'package.json': { name: 'web', scripts: { dev: 'next dev' }, dependencies: { next: '16.0.0' } },
    'package-lock.json': { lockfileVersion: 3 },
    'web/package.json': { name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } },
    'web/package-lock.json': { lockfileVersion: 3 },
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 1)
  assert.match(result.json.error.message, /\. and web would both be named "web"/)
})

test('a subfolder app that uses bun stops the install and names the folder', t => {
  const repo = project(t, {
    'site/package.json': { name: 'site', scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } },
    'site/bun.lock': '{}\n',
  })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 1)
  assert.match(result.json.error.message, /site uses bun/)
})

test('a root yarn.lock with no package.json does not stop the install', t => {
  const repo = project(t, { 'yarn.lock': '# yarn lockfile v1\n', 'main.py': 'print(1)\n' })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(read(repo.root, WORKFLOW), /Install the dependencies/)
})

test('a root package.json with no lockfile installs with npm install, and the result says why', t => {
  const repo = project(t, { 'package.json': { name: 'lib', scripts: { test: 'node --test' } } })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const workflow = read(repo.root, WORKFLOW)
  assert.match(workflow, /run: npm install\n/)
  assert.doesNotMatch(workflow, /npm ci/)
  assert.match(result.json.result.text, /no lockfile/)
})

test('an install that writes the config moves a tracked .neil-dev.json to .ndev.json with git mv, and says so', t => {
  const repo = project(t, { ...next, '.neil-dev.json': { github: { repo: 'acme/web' } } })
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  assert.ok(!existsSync(join(repo.root, '.neil-dev.json')))
  assert.deepEqual(config(repo.root).github, { repo: 'acme/web' })
  assert.deepEqual(Object.keys(config(repo.root).devServers), ['web'])
  assert.equal(result.json.result.config.path, join(repo.root, '.ndev.json'))
  assert.match(git(repo.root, 'status', '--porcelain'), /^R. \.neil-dev\.json -> \.ndev\.json$/m)
  assert.match(result.json.result.text, /Moved .*\.neil-dev\.json to .*\.ndev\.json/)
})

test('an install that does not write the config leaves .neil-dev.json where it is', t => {
  const legacy = { devServers: { web: { command: 'npm run dev', port: 3000, ready: 'http://localhost:3000/', routes: ['/'] } }, proof: {} }
  for (const [args, files] of [[['--dry-run', '--yes'], next], [[], next], [['--yes'], { ...next, '.neil-dev.json': legacy }]]) {
    const repo = project(t, { '.neil-dev.json': { github: { repo: 'acme/web' } }, ...files })
    const result = install(repo, args)
    assert.equal(result.status, 0, JSON.stringify(result.json))
    assert.ok(existsSync(join(repo.root, '.neil-dev.json')), args.join(' '))
    assert.ok(!existsSync(join(repo.root, '.ndev.json')), args.join(' '))
    assert.doesNotMatch(result.json.result.text, /Moved/)
  }
})

const job = (workflow, name) => workflow.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, 'm'))?.[1]

test('a pull request from a fork gets a job that says why Proof skipped it, with no secret, permission or checkout', t => {
  const repo = project(t, next)
  const result = install(repo, ['--yes'])
  assert.equal(result.status, 0, JSON.stringify(result.json))
  const workflow = read(repo.root, WORKFLOW)
  assert.match(job(workflow, 'proof'), /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  const fork = job(workflow, 'fork')
  assert.ok(fork, workflow)
  assert.match(fork, /if: github\.event\.pull_request\.head\.repo\.full_name != github\.repository/)
  assert.match(fork, /permissions: \{\}/)
  assert.match(fork, /GITHUB_STEP_SUMMARY/)
  assert.match(fork, /fork/)
  assert.match(fork, /ANTHROPIC_API_KEY/)
  assert.match(fork, /push the branch/)
  assert.doesNotMatch(fork, /uses:|secrets\.|\$\{\{ github\.event\.pull_request\.(title|body|head\.ref)/)
  assert.doesNotMatch(fork, /^    name: ndev proof$/m)
  assert.match(result.json.result.text, /fork.*says why/)
})

test('a Vite or Astro app with no port in its script takes the literal server port from its framework config', t => {
  const cases = [
    [{ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } }, 'vite.config.ts': "import { defineConfig } from 'vite'\nexport default defineConfig({ server: { host: true, port: 4100 } })\n" }, 4100],
    [{ 'package.json': { scripts: { dev: 'astro dev' }, dependencies: { astro: '5.0.0' } }, 'astro.config.mjs': 'export default {\n  server: {\n    port: 4400,\n  },\n}\n' }, 4400],
    [{ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } }, 'vite.config.js': 'const config = {}\nconfig.server.port = 4200\nexport default config\n' }, 4200],
    [{ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } }, 'vite.config.js': 'export default { server: { port: Number(process.env.PORT) } }\n' }, 5173],
    [{ 'package.json': { scripts: { dev: 'vite --port 4000' }, devDependencies: { vite: '6.0.0' } }, 'vite.config.js': 'export default { server: { port: 4100 } }\n' }, 4000],
  ]
  for (const [files, port] of cases) {
    const repo = project(t, { ...files, 'package-lock.json': { lockfileVersion: 3 } })
    const result = install(repo, ['--yes'])
    assert.equal(result.status, 0, JSON.stringify(result.json))
    assert.equal(config(repo.root).devServers.web.port, port, JSON.stringify(files))
    assert.equal(config(repo.root).devServers.web.ready, `http://localhost:${port}/`)
  }
})

test('the proof-install skill names no path of one machine', () => {
  const skill = read(repoRoot, 'skills/proof-install/SKILL.md')
  assert.doesNotMatch(skill, /\/Users\/|\/home\//)
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/work\/worktree-env\.sh stop/)
})
