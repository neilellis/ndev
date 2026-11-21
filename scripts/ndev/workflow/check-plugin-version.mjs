import { spawnSync } from 'node:child_process'

const manifest = '.claude-plugin/plugin.json'
const assets = ['.claude-plugin', 'hooks', 'skills', 'agents', 'scripts', 'kb', 'templates', 'types', 'README.md', 'tsconfig.json']

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr || result.error?.message || result.stdout}`)
  return result.stdout
}

function versionAt(commit) {
  const raw = git('show', `${commit}:${manifest}`)
  let value
  try {
    value = JSON.parse(raw).version
  } catch (error) {
    throw new Error(`${commit}:${manifest}: ${error.message}. Repair the manifest JSON.`)
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${commit}:${manifest} has invalid version ${JSON.stringify(value)}. Repair: set a numeric major.minor.patch version.`)
  }
  return value
}

function check() {
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    throw new Error('Plugin version history is shallow. Repair: git fetch --unshallow before checking the plugin version.')
  }
  const current = versionAt('HEAD')
  const history = git('log', '--first-parent', '--format=%H', 'HEAD', '--', manifest).trim().split('\n').filter(Boolean)
  if (!history.length) throw new Error(`${manifest} has no committed history.`)
  let anchor = history[0]
  let foundEarlierVersion = false
  const nextParts = current.split('.').map(BigInt)
  for (const commit of history.slice(1)) {
    const previous = versionAt(commit)
    if (!foundEarlierVersion && previous === current) {
      anchor = commit
      continue
    }
    foundEarlierVersion = true
    const oldParts = previous.split('.').map(BigInt)
    const differing = nextParts.findIndex((value, index) => value !== oldParts[index])
    if (differing === -1 || nextParts[differing] < oldParts[differing]) {
      throw new Error(`${manifest} version ${current} does not exceed earlier version ${previous} at ${commit}. Repair: raise the patch version above ${previous}.`)
    }
  }
  const changed = git('diff', '--name-only', '-z', anchor, 'HEAD', '--', ...assets).split('\0').filter(Boolean)
  if (changed.length) {
    const parts = current.split('.')
    parts[2] = String(BigInt(parts[2]) + 1n)
    throw new Error(`Plugin assets changed after version ${current} at ${anchor}: ${changed.map(path => JSON.stringify(path)).join(', ')}. Repair: raise the patch version in ${manifest} to ${parts.join('.')} and commit it with the plugin changes.`)
  }
  console.log(`Plugin version ${current} covers the committed plugin assets at HEAD.`)
}

try {
  check()
} catch (error) {
  console.error(`Plugin version guard: ${error.message}`)
  process.exitCode = 1
}
