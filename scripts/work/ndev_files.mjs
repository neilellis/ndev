#!/usr/bin/env node
// The ndev files of a repository's git worktrees, for the /ndev:view pane.
//
//   ndev-files.sh list --json [--repo <dir>]
//   ndev-files.sh create --file .neil-dev.json|.neil-dev.env --worktree <dir> [--repo <dir>]
//   ndev-files.sh copy   --file .neil-dev.json|.neil-dev.env --worktree <dir> [--repo <dir>]
//
// list shows, for each worktree (the main checkout first), the three known files
// (.neil-dev.json, .neil-dev.env, .neil-dev.worktree.json) as present or missing and every other
// .neil-dev* file that exists, with whether git ignores the name. It never reads a file's content.
// create writes a minimal .neil-dev.json, or an empty .neil-dev.env (mode 600). copy takes the file
// from the main checkout. Neither overwrites a file. .neil-dev.env is only written where git ignores
// it, so it cannot be committed. .neil-dev.worktree.json belongs to worktree-env.sh.
//
// Exit codes: 0 done; 2 bad usage, or a folder that is not a worktree of the repository;
// 3 refused (the file exists, the source is missing, the main checkout is the target, or the env
// file is not git-ignored).
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

const KNOWN = ['.neil-dev.json', '.neil-dev.env', '.neil-dev.worktree.json']
const WRITABLE = ['.neil-dev.json', '.neil-dev.env']
const MINIMAL_CONFIG = { mode: 'light', steering: 'interactive' }

class Fail extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.error) throw new Fail(2, `ndev-files: git ${args.join(' ')} did not start in ${cwd}: ${r.error.message}`)
  return r
}

// Every worktree of the repository that holds `dir`, the main checkout first.
function worktrees(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) {
    throw new Fail(2, `ndev-files: ${dir} is not in a git repository (git rev-parse exited ${top.status}: ${top.stderr.trim()}). Run this inside the project, or pass --repo <dir>.`)
  }
  const r = git(top.stdout.trim(), ['worktree', 'list', '--porcelain'])
  if (r.status !== 0) throw new Fail(2, `ndev-files: git worktree list exited ${r.status} in ${top.stdout.trim()}: ${r.stderr.trim()}`)
  return r.stdout.trim().split(/\n\s*\n/).map((block, i) => {
    const lines = block.split('\n')
    const path = (lines.find(l => l.startsWith('worktree ')) ?? '').slice('worktree '.length)
    const ref = lines.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length)
    return { path: realpathSync(path), branch: ref ?? (lines.includes('detached') ? '(detached)' : '(bare)'), isMain: i === 0 }
  })
}

// 0 ignored, 1 not ignored; anything else is a git failure.
function isIgnored(dir, name) {
  const r = git(dir, ['check-ignore', '-q', name])
  if (r.status === 0) return true
  if (r.status === 1) return false
  throw new Fail(2, `ndev-files: git check-ignore ${name} exited ${r.status} in ${dir}: ${r.stderr.trim()}`)
}

function filesOf(dir) {
  const names = [...new Set([...KNOWN, ...readdirSync(dir).filter(n => n.startsWith('.neil-dev'))])]
  return names.map(name => ({
    name,
    isKnown: KNOWN.includes(name),
    present: existsSync(join(dir, name)),
    isIgnored: isIgnored(dir, name),
  }))
}

function list(trees) {
  console.log(JSON.stringify({ worktrees: trees.map(t => ({ ...t, files: filesOf(t.path).filter(f => f.isKnown || f.present) })) }, null, 2))
}

function target(trees, values) {
  const name = values.file
  if (!WRITABLE.includes(name ?? '')) throw new Fail(2, `ndev-files: --file must be one of ${WRITABLE.join(', ')}; got "${name ?? ''}". ${KNOWN[2]} belongs to worktree-env.sh.`)
  if (values.worktree === undefined) throw new Fail(2, 'ndev-files: --worktree <dir> is required.')
  const given = resolve(values.worktree)
  const dir = existsSync(given) ? realpathSync(given) : given
  const tree = trees.find(t => t.path === dir)
  if (!tree) throw new Fail(2, `ndev-files: ${dir} is not a worktree of ${trees[0].path}. The worktrees are: ${trees.map(t => t.path).join(', ')}.`)
  return { name, tree, file: join(tree.path, name) }
}

function refuseExisting({ name, file }) {
  if (existsSync(file)) throw new Fail(3, `ndev-files: ${file} already exists, so ${name} was not written. Nothing was changed.`)
}

function refuseOpenEnv({ name, tree }) {
  if (name === '.neil-dev.env' && !isIgnored(tree.path, name)) {
    throw new Fail(3, [
      `ndev-files: .neil-dev.env is not git-ignored in ${tree.path}, so it could be committed. Nothing was written.`,
      `Repair: add the line .neil-dev.env to ${tree.path}/.gitignore and commit it (or to the git common dir's info/exclude), then run this command again.`,
    ].join('\n'))
  }
}

function write(t, text) {
  writeFileSync(t.file, text, { flag: 'wx', mode: t.name === '.neil-dev.env' ? 0o600 : 0o644 })
  if (t.name === '.neil-dev.env') chmodSync(t.file, 0o600)
}

function create(trees, values) {
  const t = target(trees, values)
  refuseExisting(t)
  refuseOpenEnv(t)
  write(t, t.name === '.neil-dev.json' ? `${JSON.stringify(MINIMAL_CONFIG, null, 2)}\n` : '# Private keys for ndev skills: one KEY=VALUE per line. Never commit this file.\n')
  console.log(`ndev-files: created ${t.file}.`)
}

function copy(trees, values) {
  const t = target(trees, values)
  const main = trees[0]
  if (t.tree.isMain) throw new Fail(3, `ndev-files: ${t.tree.path} is the main checkout, which holds the original, so nothing was copied. Pick a linked worktree.`)
  const source = join(main.path, t.name)
  if (!existsSync(source)) throw new Fail(3, `ndev-files: the main checkout has no ${t.name} (${source}), so there is nothing to copy. Create it first with: ndev-files.sh create --file ${t.name} --worktree ${main.path}`)
  refuseExisting(t)
  refuseOpenEnv(t)
  write(t, readFileSync(source, 'utf8'))
  console.log(`ndev-files: copied ${source} to ${t.file}.`)
}

const HEADER = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1)
const HELP = HEADER.slice(0, HEADER.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')

function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(HELP)
    return command === undefined ? 2 : 0
  }
  let values
  try {
    ;({ values } = parseArgs({ args: rest, options: { json: { type: 'boolean' }, repo: { type: 'string' }, file: { type: 'string' }, worktree: { type: 'string' } }, strict: true }))
  } catch (error) {
    throw new Fail(2, `ndev-files ${command}: ${error.message}\n${HELP}`)
  }
  const trees = worktrees(resolve(values.repo ?? process.cwd()))
  switch (command) {
    case 'list':
      list(trees)
      return 0
    case 'create':
      create(trees, values)
      return 0
    case 'copy':
      copy(trees, values)
      return 0
    default:
      throw new Fail(2, `ndev-files: unknown command "${command}".\n${HELP}`)
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof Fail)) throw error
  console.error(error.message)
  process.exitCode = error.code
}
