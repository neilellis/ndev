import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { checked, CliError, releaseRoot, run } from './common.mjs'
import { devServers, start, stopAndWait, tail } from './dev-servers.mjs'
import { proofSettingsAt } from './proof-settings.mjs'

const BRANCH = 'ndev-proof-assets'
const FETCHED = 'refs/ndev-proof/assets'
const QUALITY = 60
const PUSH_ATTEMPTS = 3
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|stale info|cannot lock ref/
const AUTHOR = { GIT_AUTHOR_NAME: 'ndev proof', GIT_AUTHOR_EMAIL: 'ndev-proof@users.noreply.github.com', GIT_COMMITTER_NAME: 'ndev proof', GIT_COMMITTER_EMAIL: 'ndev-proof@users.noreply.github.com' }
const matrixScript = () => process.env.NDEV_PROOF_MATRIX || join(releaseRoot, 'skills/responsive-check/scripts/responsive-check.mjs')

const git = (root, args, options = {}) => checked('git', ['-C', root, ...args], { repair: `Run git ${args.join(' ')} in ${root} to see the fault.`, ...options })

function selected(servers, wanted) {
  const listed = Object.entries(servers).map(([name, server]) => ({ name, routes: server.routes ?? ['/'] }))
  if (listed.length === 0) throw new CliError(1, 'There are no devServers in .ndev.json, so there is nothing to snapshot.', { repair: 'Add the servers under "devServers", each with the "routes" it serves, to .ndev.json.' })
  if (!wanted) return listed
  const missing = wanted.filter(route => !listed.some(server => server.routes.includes(route)))
  if (missing.length > 0) {
    throw new CliError(2, `No dev server lists the route ${missing.join(', ')}. Listed: ${listed.map(server => `${server.name}: ${server.routes.join(', ')}`).join('; ')}.`, {
      repair: 'Pass a listed route, or add it to "devServers.<name>.routes" in .ndev.json.',
    })
  }
  return listed.map(server => ({ ...server, routes: server.routes.filter(route => wanted.includes(route)) })).filter(server => server.routes.length > 0)
}

function matrix({ name, started, routes, settings, out, base }) {
  rmSync(out, { recursive: true, force: true })
  const args = [
    matrixScript(), '--base', new URL(started.url).origin, '--out', out,
    '--viewports', settings.viewports.map(v => `${v.name}:${v.width}x${v.height}`).join(','),
    '--schemes', settings.schemes.join(','), '--scale', '1', '--jpeg', String(QUALITY), '--web-dir', started.cwd, ...routes,
  ]
  const command = `node ${args.join(' ')}`
  const result = run(process.execPath, args, { cwd: started.cwd, timeout: 1_800_000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  const report = join(out, 'report.json')
  if ((result.status !== 0 && result.status !== 1) || !existsSync(report)) {
    const how = result.status === null ? 'was stopped' : `exited ${result.status}${result.status <= 1 ? ' and wrote no report' : ''}`
    throw new CliError(1, `The snapshot matrix for dev server ${name} ${how}: ${output || 'no output'}`, {
      repair: `Install Playwright where the server runs (npm i -D playwright in ${started.cwd}, then npx playwright install chromium), and run ${command} to see the fault.`,
      details: { command, exitCode: result.status, output },
    })
  }
  const cells = JSON.parse(readFileSync(report, 'utf8')).cells
  const dead = cells.find(cell => cell.error)
  if (dead) {
    throw new CliError(1, `Dev server ${name}${base ? ` at the base ${base}` : ''}: ${dead.route} did not load at ${dead.viewport} ${dead.scheme}: ${dead.error}. The end of its log ${started.log}:\n${tail(started.log)}`, {
      repair: base
        ? `The base ${base} lists ${dead.route} for ${name} but does not serve it. Fix "devServers.${name}.routes" on ${base}, or run without --base.`
        : `Open ${new URL(dead.route, started.url)} and fix the page, or take ${dead.route} out of "devServers.${name}.routes".`,
      details: { name, route: dead.route, log: started.log },
    })
  }
  return cells
}

async function shoot(tree, name, routes, settings, out, base) {
  const started = await start(tree, name, { record: false })
  try {
    return matrix({ name, started, routes, settings, out, base })
  } finally {
    await stopAndWait(started.pid)
  }
}

function baseTree(root, ref, servers) {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { repair: `git -C ${root} fetch origin ${ref}` })
  const folder = mkdtempSync(join(tmpdir(), 'ndev-proof-base-'))
  const tree = join(folder, 'tree')
  const remove = () => {
    try {
      if (existsSync(tree)) git(root, ['worktree', 'remove', '--force', tree])
    } finally {
      rmSync(folder, { recursive: true, force: true })
      run('git', ['-C', root, 'worktree', 'prune'])
    }
  }
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', tree, sha])
    for (const cwd of new Set(['.', ...Object.values(servers).map(server => server.cwd ?? '.')])) {
      const modules = join(root, cwd, 'node_modules')
      if (existsSync(modules) && existsSync(join(tree, cwd)) && !existsSync(join(tree, cwd, 'node_modules'))) symlinkSync(modules, join(tree, cwd, 'node_modules'))
    }
  } catch (error) {
    remove()
    throw error
  }
  return { tree, remove }
}

async function inBaseTree(base, work) {
  let failure
  try {
    return await work()
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      base.remove()
    } catch (error) {
      if (!failure) throw error
      failure.message = `${failure.message}\nThe base worktree ${base.tree} was not removed either: ${error.message}`
    }
  }
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const url = run('git', ['remote', 'get-url', 'origin']).stdout.trim()
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)
  if (!match) throw new CliError(1, `The origin remote ${url || '(none)'} is not a GitHub repository, so the images cannot be linked.`, { repair: 'Set GITHUB_REPOSITORY=<owner>/<repo>, or use --local.' })
  return match[1]
}

function pushAssets(root, prefix, files, message) {
  for (let attempt = 1; ; attempt++) {
    const remote = run('git', ['-C', root, 'ls-remote', '--heads', 'origin', BRANCH])
    if (remote.status !== 0) throw new CliError(1, `git ls-remote --heads origin ${BRANCH} exited ${remote.status}: ${`${remote.stdout}${remote.stderr}`.trim()}`, { repair: `Check the origin remote and its credentials: git -C ${root} remote -v` })
    const exists = remote.stdout.trim() !== ''
    if (exists) git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${BRANCH}:${FETCHED}`])
    const parent = exists ? git(root, ['rev-parse', FETCHED]) : undefined
    const folder = mkdtempSync(join(tmpdir(), 'ndev-proof-index-'))
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(folder, 'index') }
      git(root, ['read-tree', ...(parent ? [parent] : ['--empty'])], { env })
      const blobs = git(root, ['hash-object', '-w', '--stdin-paths'], { input: files.map(file => file.source).join('\n') }).split('\n')
      git(root, ['update-index', '--add', '--index-info'], { env, input: files.map((file, index) => `100644 blob ${blobs[index]}\t${prefix}${file.path}`).join('\n') })
      const tree = git(root, ['write-tree'], { env })
      const commit = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: { ...process.env, ...AUTHOR } })
      const push = run('git', ['-C', root, 'push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`], { timeout: 300_000 })
      if (push.status === 0) return commit
      const output = `${push.stdout}${push.stderr}`.trim()
      if (attempt < PUSH_ATTEMPTS && REJECTED.test(output)) continue
      throw new CliError(1, `git push origin ${commit}:refs/heads/${BRANCH} exited ${push.status} (attempt ${attempt} of ${PUSH_ATTEMPTS}): ${output}`, {
        repair: `The job needs contents: write to push ${BRANCH}. Check the token, then run ndev proof snapshots again.`,
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }
}

function findingsText(findings) {
  if (findings.length === 0) return ''
  const errors = findings.filter(finding => finding.severity === 'error').length
  const warnings = findings.length - errors
  const counts = [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ')
  return `<br>${counts}: ${findings[0].check} ${findings[0].selector}`
}

function gridOf(cells, settings, link, heading) {
  const lines = [heading]
  const groups = [...new Set(cells.map(cell => `${cell.server} ${cell.route}`))]
  for (const group of groups) {
    const rows = cells.filter(cell => `${cell.server} ${cell.route}` === group)
    const hasBase = rows.some(cell => cell.base)
    const columns = settings.schemes.flatMap(scheme => hasBase ? [`${scheme} before`, `${scheme} after`] : [scheme])
    lines.push('', `### ${group}`, '', `| | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`)
    for (const viewport of settings.viewports) {
      const entries = settings.schemes.flatMap(scheme => {
        const cell = rows.find(row => row.viewport === viewport.name && row.scheme === scheme)
        const alt = `${cell.route} ${viewport.name} ${scheme}`
        const after = `![${alt}](${link(cell.image)})${findingsText(cell.findings)}`
        if (!hasBase) return [after]
        return [cell.base ? `![${alt} before](${link(cell.base.image)})${findingsText(cell.base.findings)}` : 'not on the base', after]
      })
      lines.push(`| ${viewport.name} ${viewport.width}×${viewport.height} | ${entries.join(' | ')} |`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function snapshots(root, values) {
  if (!values.pr && !values.local) throw new CliError(2, 'Give --pr <n> to push the images, or --local to keep them in --out.', { repair: 'ndev proof snapshots --help' })
  if (values.pr && !/^[1-9]\d*$/.test(values.pr)) throw new CliError(2, `--pr ${JSON.stringify(values.pr)} is not a pull request number.`, { repair: 'ndev proof snapshots --help' })
  if (!values.out) throw new CliError(2, 'Give the output folder with --out <dir>.', { repair: 'ndev proof snapshots --help' })
  const out = resolve(values.out)
  const head = git(root, ['rev-parse', 'HEAD'])
  if (!values.local && git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new CliError(1, `The worktree ${root} has changes, so images pushed for ${head.slice(0, 12)} would not show that commit.`, { repair: 'Commit or stash the changes, or use --local.' })
  }
  const settings = proofSettingsAt(root, values.base ?? 'HEAD')
  const wanted = values.routes?.split(',').map(route => route.trim()).filter(Boolean)
  const servers = selected(devServers(root).servers, wanted)
  const cells = []
  for (const server of servers) {
    for (const cell of await shoot(root, server.name, server.routes, settings, join(out, 'head', server.name))) {
      cells.push({ server: server.name, route: cell.route, viewport: cell.viewport, scheme: cell.scheme, image: relative(out, cell.screenshot), findings: cell.findings, base: null })
    }
  }
  if (values.base) {
    const baseServers = settings.devServers
    const plans = servers.map(server => ({ name: server.name, routes: server.routes.filter(route => (baseServers[server.name]?.routes ?? (baseServers[server.name] ? ['/'] : [])).includes(route)) })).filter(server => server.routes.length > 0)
    if (plans.length > 0) {
      const base = baseTree(root, values.base, baseServers)
      await inBaseTree(base, async () => {
        for (const server of plans) {
          for (const shot of await shoot(base.tree, server.name, server.routes, settings, join(out, 'base', server.name), values.base)) {
            const cell = cells.find(entry => entry.server === server.name && entry.route === shot.route && entry.viewport === shot.viewport && entry.scheme === shot.scheme)
            cell.base = { image: relative(out, shot.screenshot), findings: shot.findings }
          }
        }
      })
    }
  }
  const images = cells.flatMap(cell => [cell.image, cell.base?.image].filter(Boolean))
  let assets = null
  let link = image => image
  if (!values.local) {
    const prefix = `pr-${values.pr}/${head}/`
    const slug = repository()
    const commit = pushAssets(root, prefix, images.map(image => ({ path: image, source: join(out, image) })), `Proof snapshots for pull request ${values.pr} at ${head}`)
    assets = { branch: BRANCH, prefix, commit }
    link = image => `https://github.com/${slug}/blob/${commit}/${`${prefix}${image}`.split('/').map(encodeURIComponent).join('/')}?raw=true`
  }
  const heading = `Snapshots of ${head.slice(0, 12)}${values.base ? ` against ${values.base}` : ''}, at device scale 1 and JPEG quality ${QUALITY}.`
  const grid = join(out, 'grid.md')
  mkdirSync(dirname(grid), { recursive: true })
  writeFileSync(grid, gridOf(cells, settings, link, heading))
  const findings = cells.reduce((sum, cell) => sum + cell.findings.length, 0)
  const text = `${cells.length} snapshot cells on ${new Set(cells.map(cell => `${cell.server} ${cell.route}`)).size} routes, ${findings} findings. Grid: ${grid}${assets ? `. Images: ${BRANCH} ${assets.commit.slice(0, 12)} under ${assets.prefix}` : '. Nothing was pushed (--local)'}.`
  return { head, base: values.base ?? null, servers: servers.map(server => server.name), cells, assets, grid, text }
}
