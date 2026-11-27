import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chooseConfig, CONFIG_FILE, LEGACY_CONFIG_FILE } from '../../hooks/workflow/config-file.ts'
import { CliError } from './common.mjs'

export { CONFIG_FILE, LEGACY_CONFIG_FILE }

const textOf = file => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new CliError(1, `${file}: ${error.message}`, { repair: `Check ${file} and retry.` })
  }
}

export function readConfigText(root) {
  const choice = chooseConfig(root, textOf(join(root, CONFIG_FILE)), textOf(join(root, LEGACY_CONFIG_FILE)))
  if (choice.conflict) throw new CliError(1, `${choice.conflict.message}.`, { repair: choice.conflict.repair })
  return choice
}

export function readConfigObject(root) {
  const { path, text } = readConfigText(root)
  if (text === undefined) return { path, config: {} }
  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    throw new CliError(1, `${path}: ${error.message}`, { repair: `Fix the JSON in ${path} and retry.` })
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new CliError(1, `${path}: expected a JSON object`, { repair: `Fix ${path} and retry.` })
  return { path, config }
}

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })

function tracked(root, name) {
  const result = git(root, ['ls-files', '--error-unmatch', '--', name])
  if (result.error) throw new CliError(1, `git ls-files in ${root} did not start: ${result.error.message}`, { repair: 'Install git and retry.' })
  return result.status === 0
}

export function moveLegacyConfig(root) {
  const { legacy } = readConfigText(root)
  if (!legacy) return { from: join(root, LEGACY_CONFIG_FILE), to: join(root, CONFIG_FILE), moved: false }
  const to = join(root, CONFIG_FILE)
  if (tracked(root, LEGACY_CONFIG_FILE)) {
    const moved = git(root, ['mv', '-f', '--', LEGACY_CONFIG_FILE, CONFIG_FILE])
    if (moved.status !== 0) {
      throw new CliError(1, `git mv ${LEGACY_CONFIG_FILE} ${CONFIG_FILE} in ${root} exited ${moved.status}: ${(moved.stderr || moved.stdout).trim()}`, { repair: `Move ${legacy} to ${to} by hand and retry.` })
    }
  } else if (textOf(to) === undefined) {
    renameSync(legacy, to)
  } else {
    rmSync(legacy)
  }
  return { from: legacy, to, moved: true }
}

export function migrateConfig(root) {
  const result = moveLegacyConfig(root)
  return { ...result, text: result.moved ? `Moved ${result.from} to ${result.to}. Commit the rename.` : `Nothing to move: ${result.from} does not exist.` }
}
