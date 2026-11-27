import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { validate } from '../../hooks/config.ts'
import { chooseConfig, CONFIG_FILE, LEGACY_CONFIG_FILE } from '../../hooks/workflow/config-file.ts'
import { proofSettings } from '../../hooks/workflow/proof-config.ts'
import { CliError } from './common.mjs'

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })

function textAtRef(root, ref, name) {
  if (git(root, ['cat-file', '-e', `${ref}:${name}`]).status !== 0) return undefined
  const shown = git(root, ['show', `${ref}:${name}`])
  if (shown.status !== 0) throw new CliError(1, `git show ${ref}:${name} in ${root} exited ${shown.status}: ${shown.stderr.trim()}`, { repair: `Check that ${ref} is fetched, then retry.` })
  return shown.stdout
}

export function proofSettingsAt(root, ref) {
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (commit.status !== 0) throw new CliError(1, `The base ref ${ref} is not a commit in ${root}, so the Proof settings cannot be read from it.`, { repair: `git -C ${root} fetch origin ${ref}` })
  const choice = chooseConfig(ref, textAtRef(root, ref, CONFIG_FILE), textAtRef(root, ref, LEGACY_CONFIG_FILE))
  if (choice.conflict) throw new CliError(1, `At ${ref}: ${choice.conflict.message}.`, { repair: `Fix the config on ${ref}: ${choice.conflict.repair}` })
  const source = `${ref}:${basename(choice.path)}`
  if (choice.text === undefined) return { ...proofSettings(undefined), devServers: {}, source: `${ref} (no config file)` }
  let raw
  try {
    raw = JSON.parse(choice.text)
  } catch (error) {
    throw new CliError(1, `${source} is not valid JSON: ${error.message}`, { repair: `Fix the JSON of ${basename(choice.path)} on ${ref}.` })
  }
  const error = validate(raw)
  if (error) throw new CliError(1, `${source}: ${error}`, { repair: `Fix ${basename(choice.path)} on ${ref}.` })
  return { ...proofSettings(raw.proof), devServers: raw.devServers ?? {}, source }
}
