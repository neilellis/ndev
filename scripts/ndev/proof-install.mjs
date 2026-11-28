import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { validate } from '../../hooks/config.ts'
import { CliError, releaseRoot, run } from './common.mjs'
import { readConfigObject } from './config-file.mjs'

export const CLAUDE_CODE = { package: '@anthropic-ai/claude-code', version: '2.1.331' }
export const WORKFLOW_FILE = '.github/workflows/ndev-proof.yml'
const NDEV_REPOSITORY = 'https://github.com/neilellis/ndev.git'
const ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  upload: 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2',
}
const FRAMEWORKS = [['next', 3000], ['nuxt', 3000], ['astro', 4321], ['@sveltejs/kit', 5173], ['vite', 5173], ['react-scripts', 3000]]
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']]
const INSTALL = {
  npm: ['npm ci'],
  pnpm: ['corepack enable', 'pnpm install --frozen-lockfile'],
  yarn: ['corepack enable', 'yarn install --frozen-lockfile'],
  berry: ['corepack enable', 'yarn install --immutable'],
}
const ADD_PLAYWRIGHT = { npm: 'npm install -D playwright', pnpm: 'pnpm add -D playwright', yarn: 'yarn add -D playwright', berry: 'yarn add -D playwright' }
const REF_REPAIR = 'Pass the ndev commit to pin: --ref $(gh api repos/neilellis/ndev/commits/main --jq .sha)'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CliError(1, `${file}: ${error.message}`, { repair: `Fix the JSON in ${file} and retry.` })
  }
}

function projectRoot(path) {
  if (!path) throw new CliError(2, 'Name the project to install Proof in: ndev proof install <project-path>.', { repair: 'ndev proof install --help' })
  const root = resolve(path)
  const top = run('git', ['-C', root, 'rev-parse', '--show-toplevel'])
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) {
    throw new CliError(2, `${root} is not the top folder of a git repository${top.status === 0 ? `; the top is ${top.stdout.trim()}` : `: ${top.stderr.trim()}`}.`, { repair: 'Give the path of the repository top folder (git rev-parse --show-toplevel).' })
  }
  return root
}

function pinnedRef(ref) {
  if (ref !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new CliError(2, `--ref ${JSON.stringify(ref)} is not a full 40-character commit id of ndev.`, { repair: REF_REPAIR })
    return ref
  }
  const head = run('git', ['-C', releaseRoot, 'rev-parse', 'HEAD'])
  if (head.status !== 0) throw new CliError(2, `This ndev at ${releaseRoot} is not a git checkout, so it cannot name the commit to pin: ${head.stderr.trim()}`, { repair: REF_REPAIR })
  const sha = head.stdout.trim()
  const published = run('git', ['-C', releaseRoot, 'merge-base', '--is-ancestor', sha, 'origin/main'])
  if (published.status !== 0) throw new CliError(2, `The ndev commit ${sha} at ${releaseRoot} is not on origin/main, so the workflow could not fetch it.`, { repair: REF_REPAIR })
  return sha
}

function workspaceDirs(root, manifest) {
  const patterns = [...(Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [])]
  const pnpm = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpm)) for (const line of readFileSync(pnpm, 'utf8').split('\n')) {
    const match = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/)
    if (match) patterns.push(match[1])
  }
  const dirs = []
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2))
      if (existsSync(parent)) for (const entry of readdirSync(parent).sort()) if (statSync(join(parent, entry)).isDirectory()) dirs.push(join(pattern.slice(0, -2), entry))
    } else if (!pattern.includes('*')) dirs.push(pattern.replace(/\/$/, ''))
  }
  return dirs.filter(dir => existsSync(join(root, dir, 'package.json')))
}

function packageManager(root) {
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) throw new CliError(1, `${root} uses bun, and the Proof workflow installs dependencies only with npm, pnpm or yarn.`, { repair: 'Use npm, pnpm or yarn for the project, or write .github/workflows/ndev-proof.yml by hand.' })
  const found = LOCKFILES.find(([file]) => existsSync(join(root, file)))
  if (!found) return 'npm'
  if (found[1] === 'yarn' && (existsSync(join(root, '.yarnrc.yml')) || /^yarn@([2-9]|\d{2,})/.test(readJson(join(root, 'package.json')).packageManager ?? ''))) return 'berry'
  return found[1]
}

function serverIn(root, dir, manifest, manager) {
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }
  const framework = FRAMEWORKS.find(([name]) => deps[name])
  if (!framework) return null
  const script = manifest.scripts?.dev ? 'dev' : manifest.scripts?.start ? 'start' : null
  if (!script) return null
  const port = Number(manifest.scripts[script].match(/(?:--port|-p)[ =](\d+)/)?.[1] ?? framework[1])
  const server = { command: `${manager === 'berry' ? 'yarn' : manager} run ${script}`, ...(dir === '.' ? {} : { cwd: dir }), port, ready: `http://localhost:${port}/`, routes: ['/'] }
  return { name: dir === '.' ? 'web' : basename(dir), dir, framework: framework[0], server, playwright: Boolean(deps.playwright || deps['@playwright/test']) }
}

function detect(root, manager) {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return []
  const manifest = readJson(file)
  const found = [serverIn(root, '.', manifest, manager)]
  for (const dir of workspaceDirs(root, manifest)) found.push(serverIn(root, dir, readJson(join(root, dir, 'package.json')), manager))
  const servers = found.filter(Boolean)
  for (const server of servers) {
    const same = servers.filter(other => other.name === server.name)
    if (same.length > 1) throw new CliError(1, `The dev servers in ${same.map(other => other.dir).join(' and ')} would both be named ${JSON.stringify(server.name)} in .ndev.json.`, { repair: `Add "devServers" to ${join(root, '.ndev.json')} by hand with a different name for each, then run ndev proof install ${root} again: it keeps the servers that the file has.` })
  }
  return servers
}

function slugOf(root) {
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'])
  if (remote.status !== 0) return null
  return remote.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null
}

function secretState(slug) {
  if (!slug) return { state: 'unknown', reason: 'the origin remote is not a GitHub repository' }
  const script = process.env.NDEV_FLOW_GH || join(releaseRoot, 'scripts/github/gh.sh')
  const result = run('bash', [script, 'api', `repos/${slug}/actions/secrets`, '--paginate', '--jq', '.secrets[].name'], { timeout: 60_000 })
  if (result.status !== 0) return { state: 'unknown', reason: `gh.sh api repos/${slug}/actions/secrets exited ${result.status}: ${`${result.stdout}\n${result.stderr}`.trim() || 'no output'}` }
  return { state: result.stdout.split('\n').map(line => line.trim()).includes('ANTHROPIC_API_KEY') ? 'set' : 'missing' }
}

function workflow({ ref, servers, manager }) {
  const install = servers.length === 0 ? [] : [
    '      - name: Install the project dependencies',
    ...(INSTALL[manager].length === 1 ? [`        run: ${INSTALL[manager][0]}`] : ['        run: |', ...INSTALL[manager].map(line => `          ${line}`)]),
    '      - name: Install the browser for the snapshots',
    '        run: npx playwright install --with-deps chromium',
  ]
  return [
    'name: ndev proof',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]',
    '',
    'permissions: {}',
    '',
    'concurrency:',
    '  group: ndev-proof-${{ github.event.pull_request.number }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  proof:',
    '    name: ndev proof run',
    '    if: github.event.pull_request.head.repo.full_name == github.repository',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 90',
    '    permissions:',
    '      contents: write',
    '      pull-requests: write',
    '      checks: write',
    '    env:',
    `      NDEV_REF: ${ref}`,
    `      CLAUDE_CODE_VERSION: ${CLAUDE_CODE.version}`,
    '    steps:',
    `      - uses: ${ACTIONS.checkout}`,
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '          fetch-depth: 0',
    '          persist-credentials: false',
    `      - uses: ${ACTIONS.setupNode}`,
    '        with:',
    '          node-version: 24',
    ...install,
    '      - name: Install ndev and Claude Code',
    '        run: |',
    `          git clone --quiet ${NDEV_REPOSITORY} "$RUNNER_TEMP/ndev"`,
    '          git -C "$RUNNER_TEMP/ndev" checkout --quiet "$NDEV_REF"',
    `          npm install --global "${CLAUDE_CODE.package}@$CLAUDE_CODE_VERSION"`,
    '      - name: Run Proof',
    '        env:',
    '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
    '          GH_TOKEN: ${{ github.token }}',
    '          PR: ${{ github.event.pull_request.number }}',
    '          BASE_REF: ${{ github.event.pull_request.base.ref }}',
    '        run: |',
    '          export GIT_CONFIG_COUNT=1',
    '          export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader',
    '          GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf \'x-access-token:%s\' "$GH_TOKEN" | base64 | tr -d \'\\n\')"',
    '          echo "::add-mask::$GIT_CONFIG_VALUE_0"',
    '          export GIT_CONFIG_VALUE_0',
    '          "$RUNNER_TEMP/ndev/bin/ndev" proof run --pr "$PR" --base "origin/$BASE_REF" --out "$RUNNER_TEMP/proof"',
    `      - uses: ${ACTIONS.upload}`,
    '        if: always()',
    '        with:',
    '          name: ndev-proof',
    '          path: ${{ runner.temp }}/proof',
    '          if-no-files-found: ignore',
    '',
  ].join('\n')
}

function planConfig(root, servers, confirmed) {
  const { path, config } = readConfigObject(root)
  const next = { ...config }
  if (next.devServers === undefined && servers.length > 0) next.devServers = Object.fromEntries(servers.map(found => [found.name, found.server]))
  if (next.proof === undefined) next.proof = {}
  const error = validate(next)
  if (error) throw new CliError(1, `${path} would not be valid after the install: ${error}`, { repair: `Fix ${path} and retry.` })
  const text = `${JSON.stringify(next, null, 2)}\n`
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const changed = current === undefined ? true : JSON.stringify(JSON.parse(current)) !== JSON.stringify(next)
  const action = !changed ? 'unchanged' : !confirmed ? 'pending' : current === undefined ? 'create' : 'update'
  return { path, text, action, kept: config.devServers !== undefined }
}

function planWorkflow(root, text, force, dryRun) {
  const path = join(root, WORKFLOW_FILE)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (current === undefined) return { path, text, action: 'create' }
  if (current === text) return { path, text, action: 'unchanged' }
  if (!force && dryRun) return { path, text, action: 'differs' }
  if (!force) throw new CliError(1, `${path} differs from the workflow that this ndev writes, so it was not replaced.`, { repair: `Keep your changes elsewhere, then run ndev proof install ${root} --force to replace it.` })
  return { path, text, action: 'update' }
}

function describe({ root, slug, servers, config, file, secret, playwright, manager, dryRun }) {
  const lines = [`${dryRun ? 'Would install' : 'Installed'} Proof in ${root}.`]
  lines.push(file.action === 'differs' ? `${file.path}: differs from the workflow that this ndev writes; --force would replace it.` : `${file.path}: ${file.action}${dryRun && file.action !== 'unchanged' ? ' (dry run)' : ''}.`)
  if (servers.length === 0) lines.push('No dev server found: no package.json script runs a known web framework, so the visual check is skipped.')
  for (const found of servers) lines.push(`Dev server ${found.name} (${found.framework}): ${found.server.command}${found.server.cwd ? ` in ${found.server.cwd}` : ''}, ready at ${found.server.ready}, routes ${found.server.routes.join(', ')}.`)
  if (config.kept) lines.push(`${config.path} already has devServers, so they were kept.`)
  if (config.action === 'pending') lines.push(`${config.path}: pending. Confirm the dev servers above, then run ndev proof install ${root} --yes to write them and the proof section.`)
  else lines.push(`${config.path}: ${config.action}${dryRun && config.action !== 'unchanged' ? ' (dry run)' : ''}.`)
  for (const dir of playwright.missing) lines.push(`Playwright is not a dependency${dir === '.' ? '' : ` of ${dir}`}, and the snapshots need it: ${dir === '.' ? '' : `cd ${dir} && `}${ADD_PLAYWRIGHT[manager]}`)
  if (secret.state === 'set') lines.push('The ANTHROPIC_API_KEY secret is set.')
  else if (secret.state === 'missing') lines.push(`The ANTHROPIC_API_KEY secret is not a repository secret of ${slug}. An organization secret is not listed here; if there is none, set it: gh secret set ANTHROPIC_API_KEY --repo ${slug}`)
  else lines.push(`The ANTHROPIC_API_KEY secret could not be checked: ${secret.reason}. Check it: gh secret list${slug ? ` --repo ${slug}` : ''}`)
  lines.push(`To make Proof gate the merge, add "ndev proof" as a required status check: ${slug ? `https://github.com/${slug}/settings/rules` : 'the repository settings, Rules'}. A pull request from a fork gets no run, so it gets no ndev proof check and cannot merge until a maintainer runs Proof on it.`)
  return lines.join('\n')
}

export function proofInstall(path, values) {
  const root = projectRoot(path)
  const ref = pinnedRef(values.ref)
  const manager = packageManager(root)
  const found = detect(root, manager)
  const slug = slugOf(root)
  const file = planWorkflow(root, workflow({ ref, servers: found, manager }), values.force, values['dry-run'])
  const config = planConfig(root, found, values.yes)
  const playwright = { missing: found.filter(server => !server.playwright).map(server => server.dir) }
  const secret = secretState(slug)
  if (!values['dry-run']) {
    if (file.action === 'create' || file.action === 'update') {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.text)
    }
    if (config.action === 'create' || config.action === 'update') writeFileSync(config.path, config.text)
  }
  const servers = found.map(({ name, framework, server }) => ({ name, framework, ...server }))
  return {
    root, ref, slug, servers, secret, playwright,
    workflow: { path: file.path, action: file.action },
    config: { path: config.path, action: config.action },
    dryRun: Boolean(values['dry-run']),
    text: describe({ root, slug, servers: found, config, file, secret, playwright, manager, dryRun: values['dry-run'] }),
  }
}
