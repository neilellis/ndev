import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG_FILE, missingGitHub, REPO, validate } from '../../hooks/config.ts'
import { argsFor, atomicJson, checked, CliError, gitWorkspace, locked, readObject, releaseRoot, stateRoot, worktreeScript } from './common.mjs'

const configPath = root => join(root, CONFIG_FILE)
const settingsPath = root => join(root, '.neil-dev.worktree.json')
const modes = ['light', 'heavy', 'hack']
const steerings = ['interactive', 'auto']
const string = { type: 'string' }
const boolean = { type: 'boolean' }

export function readProject(root) {
  const path = configPath(root)
  const config = readObject(path, { missing: {} })
  const problem = validate(config)
  if (problem) throw new CliError(1, `${path}: ${problem}.`, { repair: `Fix ${path} and retry.` })
  return config
}

function readSettings({ root, linked }) {
  if (!linked) return {}
  const path = settingsPath(root)
  const { settings = {} } = readObject(path, { missing: {} })
  const problem = validate({ mode: settings?.mode, steering: settings?.steering })
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || problem) {
    throw new CliError(1, `${path}: ${problem || 'invalid settings object'}.`, { repair: `Fix ${path} and retry.` })
  }
  return settings
}

function status(workspace) {
  const { root } = workspace
  const config = readProject(root)
  const settings = readSettings(workspace)
  const mode = settings.mode ?? config.mode ?? 'light'
  const steering = settings.steering ?? config.steering ?? 'interactive'
  if (mode === 'hack' && steering === 'auto') {
    throw new CliError(1, `${root} has hack mode and auto steering. Hack mode is interactive only.`, {
      repair: `Set steering to interactive in ${workspace.linked ? settingsPath(root) : configPath(root)}.`,
    })
  }
  const missing = missingGitHub(config)
  const github = config.github
  const location = workspace.linked ? settingsPath(root) : configPath(root)
  const githubText = github?.repo ? `GitHub: ${github.repo}.` : 'GitHub repository is unset.'
  const text = [`dev: ${mode} · ${steering}`, githubText, missing.length ? `Run ndev project setup to set ${missing.join(' and ')}.` : undefined].filter(Boolean).join('\n')
  return { root, mode, steering, github, missing, location, text }
}

function setupStatus(workspace, { prompt = false } = {}) {
  const result = status(workspace)
  const path = join(workspace.root, 'NORTH_STAR.md')
  const file = lstatSync(path, { throwIfNoEntry: false })
  const exists = file?.isFile() ?? false
  if (prompt && !exists) {
    result.text += file
      ? `\n${path} is not a regular file. Ask the project owner to replace it with a regular file.`
      : `\n${path} is missing. Ask the project owner to create it with the project's purpose and guiding rules.`
  }
  return { ...result, northStar: { path, exists } }
}

export function saveProject(root, key, value) {
  const path = configPath(root)
  locked(path, () => {
    const config = { ...readProject(root), [key]: value }
    const problem = validate(config)
    if (problem) throw new CliError(1, `${path}: ${problem}.`, { repair: 'Run ndev project status.' })
    atomicJson(path, config)
  })
}

function setChoice(workspace, key, argv, repair) {
  const { positionals: [input] } = argsFor(argv, {}, repair, { positionals: 1 })
  const current = status(workspace)
  const options = key === 'mode' ? modes : steerings
  const value = input?.toLowerCase() ?? (current[key] === options[0] ? options[1] : options[0])
  if (!options.includes(value)) throw new CliError(2, `Unknown ${key} ${JSON.stringify(input)}. Use ${options.join(', ')}.`, { repair })
  const mode = key === 'mode' ? value : current.mode
  const steering = key === 'steering' ? value : current.steering
  if (mode === 'hack' && steering === 'auto') {
    throw new CliError(1, 'Hack mode is interactive only.', {
      repair: key === 'mode' ? 'Run ndev project steering interactive.' : 'Run ndev project mode light.',
    })
  }
  if (workspace.linked) {
    checked('bash', [worktreeScript, 'set-setting', '--key', key, '--value', value, '--worktree', workspace.root], { repair })
  } else {
    saveProject(workspace.root, key, value)
  }
  return status(workspace)
}

function setup(workspace, argv, repair) {
  const { values } = argsFor(argv, { repo: string, 'no-repo': boolean, board: string, 'no-board': boolean }, repair)
  if (values.repo !== undefined && (!REPO.test(values.repo) || values['no-repo'])) {
    throw new CliError(2, `Invalid GitHub repository choice ${JSON.stringify(values.repo)}. Use owner/name or --no-repo.`, { repair })
  }
  const board = values.board !== undefined ? /^([A-Za-z0-9_.-]+)\/([1-9]\d*)$/.exec(values.board) : null
  if (values.board !== undefined && (!board || values['no-board'] || !Number.isSafeInteger(Number(board[2])))) {
    throw new CliError(2, `Invalid GitHub board choice ${JSON.stringify(values.board)}. Use owner/number or --no-board.`, { repair })
  }
  if (Object.keys(values).length) {
    const path = configPath(workspace.root)
    locked(path, () => {
      const config = readProject(workspace.root)
      const repo = values['no-repo'] ? null : values.repo ?? config.github?.repo
      if (repo === undefined) throw new CliError(2, 'The project has no GitHub repository choice yet.', { repair: 'Run ndev project setup --repo <owner/name> or --no-repo.' })
      if (repo === null && board) throw new CliError(2, 'A project board needs a GitHub repository choice.', { repair })
      const existingBoard = config.github?.repo === repo ? config.github?.board : undefined
      const chosenBoard = values['no-board'] || repo === null ? null : board ? { owner: board[1], number: Number(board[2]) } : existingBoard
      const github = { repo, ...(chosenBoard !== undefined ? { board: chosenBoard } : {}) }
      atomicJson(path, { ...config, github })
    })
  }
  return setupStatus(workspace, { prompt: true })
}

function initialize({ root }) {
  const marker = join(root, '.ndev-inited')
  if (existsSync(marker)) return { initialized: true, marker, text: `Already initialized. See ${marker}.` }
  const script = join(root, 'scripts/init-project.sh')
  const repair = `Add .ndev-inited to the Git ignore rules and provide ${script}, then run ndev project init.`
  checked('git', ['check-ignore', '-q', '.ndev-inited'], { cwd: root, repair })
  const output = checked('bash', [script], { cwd: root, timeout: 600_000, repair: `Fix ${script} and run ndev project init.` })
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  return { initialized: true, marker, text: output || `Initialized ${root}.` }
}

function guidance(root, argv, repair) {
  const { positionals: [kind, description] } = argsFor(argv, {}, repair, { positionals: 2 })
  const project = readProject(root)
  const packages = ['package.json', 'pyproject.toml'].map(file => join(root, file)).filter(existsSync)
  const branding = project.branding
  const brandSources = [branding?.path && resolve(root, branding.path), branding?.guide ?? branding?.site].filter(Boolean)
  const catalog = {
    'react-component': [join(releaseRoot, 'kb/ui-components.md'), ...brandSources],
    library: [...packages, join(releaseRoot, 'kb/libraries.md')],
    'brand-style': brandSources,
    animation: [join(releaseRoot, 'skills/motion/SKILL.md'), join(releaseRoot, 'skills/motion/references/delight.md'), ...brandSources],
  }
  if (!description?.trim() || !Object.hasOwn(catalog, kind)) {
    throw new CliError(2, `Give a description and one of ${Object.keys(catalog).join(', ')}.`, { repair })
  }
  const sources = catalog[kind]
  if (!sources.length) throw new CliError(1, `${root} has no branding sources.`, { repair: 'Set branding.site in .neil-dev.json or load the ndev-brand skill.' })
  return { kind, description, sources, text: `Guidance for ${kind}. ${description}\nRead these sources in order and cite any suggestion you use.\n${sources.join('\n')}` }
}

function reportBug(root, argv, repair) {
  const { values: { title, details } } = argsFor(argv, { title: string, details: string }, repair)
  if (!title?.trim() || /[\r\n]/.test(title) || !details?.trim()) {
    throw new CliError(2, 'Give a one-line --title and --details with the command, result, and expected behavior.', { repair })
  }
  const dir = join(stateRoot(), 'faults')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ledger = join(dir, 'reports.json')
  const fingerprint = createHash('sha256').update(title.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex')
  const now = Date.now()
  const existing = locked(ledger, () => {
    const records = readObject(ledger, { missing: {} })
    const recent = Object.fromEntries(Object.entries(records).filter(([, entry]) => now - entry.at < 86_400_000))
    if (recent[fingerprint]) return recent[fingerprint]
    if (Object.values(recent).filter(record => now - record.at < 3_600_000).length >= 5) {
      throw new CliError(1, 'Five ndev faults were reported in the past hour.', { repair: 'Wait for the limit to reset, or tell the maintainer about this fault.' })
    }
    atomicJson(ledger, { ...recent, [fingerprint]: { at: now, pending: true } })
    return null
  })
  if (existing) {
    if (existing.pending) throw new CliError(1, `The previous report of ${title} has an unknown outcome.`, { repair: 'Check neilellis/ndev issues for the report before retrying.' })
    return { url: existing.url, duplicate: true, text: `Already reported at ${existing.url}` }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ndev-fault-'))
  try {
    const body = join(scratch, 'report.md')
    writeFileSync(body, details + '\n', { mode: 0o600 })
    const url = checked('gh', ['issue', 'create', '-R', 'neilellis/ndev', '--title', title, '--body-file', body], { cwd: root, repair: 'Check neilellis/ndev issues for the report before retrying.' })
    if (!/^https:\/\/github\.com\/neilellis\/ndev\/issues\/[1-9]\d*$/.test(url)) throw new CliError(1, `GitHub returned no ndev issue URL: ${url}`)
    locked(ledger, () => atomicJson(ledger, { ...readObject(ledger), [fingerprint]: { at: now, url } }))
    return { url, text: url }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function runProject([verb, ...argv]) {
  const workspace = gitWorkspace()
  const repair = `ndev project ${verb} --help`
  if (verb === 'mode' || verb === 'steering') return setChoice(workspace, verb, argv, repair)
  if (verb === 'setup') return setup(workspace, argv, repair)
  if (verb === 'guidance') return guidance(workspace.root, argv, repair)
  if (verb === 'report-workflow-bug') return reportBug(workspace.root, argv, repair)
  if (verb === 'credentials') {
    const { values } = argsFor(argv, { init: boolean, 'copy-from-main': boolean }, repair)
    if (values.init && values['copy-from-main']) throw new CliError(2, 'Choose either --init or --copy-from-main.', { repair })
    const helper = join(releaseRoot, 'scripts/env/neil-dev-env.mjs')
    const options = { cwd: workspace.root, repair }
    if (values.init) checked(process.execPath, [helper, 'init'], options)
    const result = JSON.parse(checked(process.execPath, [helper, 'status', '--json'], options))
    if (values['copy-from-main'] && !result.file) {
      throw new CliError(1, `No credentials file found for ${workspace.root} or ${result.main}.`, { repair: 'Run ndev project credentials --init.' })
    }
    return { ...result, text: result.file ? `${result.file}\nKeys: ${result.keys.join(', ') || 'none'}` : 'No credentials file. Run ndev project credentials --init.' }
  }
  argsFor(argv, {}, repair)
  if (verb === 'status') return setupStatus(workspace)
  if (verb === 'init') return initialize(workspace)
  if (verb === 'learn') return { skill: 'ndev-dev-wiki', text: 'Load the ndev-dev-wiki skill. Review the session for reusable lessons and record each one. Use ndev-remember for project facts.' }
  throw new CliError(2, `Unknown project command ${JSON.stringify(verb)}.`, { repair: 'ndev project --help' })
}
