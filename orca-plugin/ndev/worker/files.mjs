// Reading, creating and copying the ndev files of a workspace. No Orca API in here, so it can be tested on real folders.
import { execFile } from 'node:child_process'
import { copyFile, constants, link, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class NdevError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const JSON_FILE = '.neil-dev.json'
export const ENV_FILE = '.neil-dev.env'
export const WORKTREE_FILE = '.neil-dev.worktree.json'
export const NDEV_FILES = [JSON_FILE, ENV_FILE, WORKTREE_FILE]

const DEFAULT_JSON = { mode: 'light', steering: 'interactive' }
const ENV_HEADER = '# Private credentials for ndev skills. Git-ignored; keep it mode 600.\n# One KEY=VALUE on each line.\n'

async function git(dir, args) {
  try {
    return (await run('git', ['-C', dir, ...args])).stdout.trim()
  } catch (error) {
    // git check-ignore exits 1 for "not ignored"; the caller decides. Anything else is a real failure.
    if (error.code === 1 && args[0] === 'check-ignore') return null
    throw new NdevError('git', `git ${args.join(' ')} failed in ${dir} (exit ${error.code}): ${error.stderr || error.message}`.trim())
  }
}

async function findMainCheckout(dir) {
  const list = await git(dir, ['worktree', 'list', '--porcelain', '-z'])
  const first = list.split('\0\0', 1)[0].split('\0')
  if (first.includes('bare')) return null
  if (!first[0].startsWith('worktree ')) throw new NdevError('git', `git worktree list did not identify the main checkout in ${dir}.`)
  return first[0].slice('worktree '.length)
}

export async function mainCheckout(dir) {
  const main = await findMainCheckout(dir)
  if (main === null) throw new NdevError('no_main', `${dir} belongs to a bare repository with no main checkout.`)
  return main
}

/** The same folder through symlinks (macOS /var is /private/var), so two spellings compare equal. */
async function sameFolder(a, b) {
  return (await realpath(a)) === (await realpath(b))
}

const isIgnored = async (dir, name) => (await git(dir, ['check-ignore', '-q', name])) !== null

async function exists(file) {
  try {
    return await lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new NdevError('unreadable', `Could not read ${file}: ${error.message}`)
  }
}

/** Key names of a KEY=VALUE file. Values are never returned. */
function keyNames(text) {
  return text
    .split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter(Boolean)
}

async function describe(dir, name) {
  const file = path.join(dir, name)
  const info = await exists(file)
  const entry = { name, exists: Boolean(info), ignored: await isIgnored(dir, name) }
  if (!info) return entry
  if (!info.isFile()) return { ...entry, problem: `Use a regular file for ${file}.` }
  entry.size = info.size
  entry.mode = (info.mode & 0o777).toString(8)
  const text = await readFile(file, 'utf8')
  if (name === ENV_FILE) {
    entry.keys = keyNames(text)
    if (info.mode & 0o077) entry.problem = `Other users can read ${file}. Run: chmod 600 ${file}`
    if (!entry.ignored) entry.problem = `${name} is not ignored by git, so it could be committed. Run: echo ${name} >> ${path.join(dir, '.gitignore')}`
  } else {
    try {
      const parsed = JSON.parse(text)
      if (name === JSON_FILE) {
        entry.summary = ['mode', 'steering'].filter((k) => parsed[k]).map((k) => `${k} ${parsed[k]}`).join(' · ') || 'no mode or steering set'
      } else {
        entry.summary = `${Array.isArray(parsed.stacks) ? parsed.stacks.length : Object.keys(parsed).length} entries`
      }
    } catch (error) {
      entry.problem = `${file} is not valid JSON: ${error.message}`
    }
  }
  return entry
}

/** The state of the three ndev files in one workspace folder. */
/** Any other .neil-dev* file in the folder (name, size, mode only; contents are never read). */
async function otherNdevFiles(dir) {
  const names = (await readdir(dir)).filter((n) => n.startsWith('.neil-dev') && !NDEV_FILES.includes(n)).sort()
  return Promise.all(names.map(async (name) => {
    const info = await lstat(path.join(dir, name))
    return { name, size: info.size, mode: (info.mode & 0o777).toString(8), isDirectory: info.isDirectory() }
  }))
}

export async function inspectWorkspace(dir) {
  const main = await mainCheckout(dir)
  return { dir, main, isMain: await sameFolder(main, dir), files: await Promise.all(NDEV_FILES.map((name) => describe(dir, name))), others: await otherNdevFiles(dir) }
}

function assertKnown(name) {
  if (!NDEV_FILES.includes(name)) throw new NdevError('invalid_params', `"${name}" is not an ndev file. Known: ${NDEV_FILES.join(', ')}.`)
  if (name === WORKTREE_FILE) throw new NdevError('not_allowed', `${WORKTREE_FILE} lists the stacks one worktree started. ndev writes it itself (scripts/worktree-env.sh), so it is not created or copied here.`)
}

async function assertEnvIgnored(dir) {
  if (!(await isIgnored(dir, ENV_FILE))) {
    throw new NdevError('not_ignored', `${ENV_FILE} would not be ignored by git in ${dir}, so it could be committed. Run: echo ${ENV_FILE} >> ${path.join(dir, '.gitignore')}`)
  }
}

async function writePrivateEnv(dir, target, contents) {
  const gitDir = await git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const scratch = await mkdtemp(path.join(gitDir, 'ndev-env-'))
  const file = path.join(scratch, ENV_FILE)
  try {
    await writeFile(file, contents, { flag: 'wx', mode: 0o600 })
    try {
      await link(file, target)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await copyFile(file, target, constants.COPYFILE_EXCL)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function createFile(dir, name) {
  assertKnown(name)
  const target = path.join(dir, name)
  if (name === ENV_FILE) await assertEnvIgnored(dir)
  try {
    if (name === ENV_FILE) await writePrivateEnv(dir, target, ENV_HEADER)
    else await writeFile(target, `${JSON.stringify(DEFAULT_JSON, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new NdevError('exists', `${target} already exists. It was not changed.`)
    throw new NdevError('write_failed', `Could not create ${target}: ${error.message}`)
  }
  return describe(dir, name)
}

export async function copyFromMain(dir, name) {
  assertKnown(name)
  const main = await mainCheckout(dir)
  if (await sameFolder(main, dir)) throw new NdevError('is_main', `${dir} is the main checkout, so there is nothing to copy from.`)
  return copyInto(dir, name, path.join(main, name))
}

async function copyInto(dir, name, source) {
  const target = path.join(dir, name)
  const sourceInfo = await exists(source)
  if (!sourceInfo) throw new NdevError('no_source', `The main checkout has no ${source}. Create it there first.`)
  if (!sourceInfo.isFile()) throw new NdevError('invalid_params', `Use a regular file for ${source}.`)
  if (name === ENV_FILE) await assertEnvIgnored(dir)
  try {
    if (name === ENV_FILE) await writePrivateEnv(dir, target, await readFile(source))
    else await copyFile(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if (error.code === 'EEXIST') throw new NdevError('exists', `${target} already exists. It was not changed.`)
    throw new NdevError('write_failed', `Could not copy ${source} to ${target}: ${error.message}`)
  }
  return describe(dir, name)
}

export async function ensureProjectFiles(dir) {
  const main = await findMainCheckout(dir)
  for (const name of [JSON_FILE, ENV_FILE]) {
    const target = path.join(dir, name)
    const info = await exists(target)
    if (info) {
      if (!info.isFile()) throw new NdevError('invalid_params', `Use a regular file for ${target}.`)
      continue
    }
    const source = main && path.join(main, name)
    try {
      if (source && await exists(source)) await copyInto(dir, name, source)
      else await createFile(dir, name)
    } catch (error) {
      if (error.code !== 'exists') throw error
      if (!(await exists(target))?.isFile()) throw new NdevError('invalid_params', `Use a regular file for ${target}.`)
    }
  }
}
