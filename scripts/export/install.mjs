import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const version = '2.0.0'
const builtin = ['claude', 'codex', 'opencode']
const events = {
  SessionStart: 'session-start', UserPromptSubmit: 'prompt-submit', PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use', Stop: 'turn-complete', SubagentStop: 'turn-complete',
  SessionEnd: 'session-end', PostCompact: 'compact',
}
const sessionSkill = `---
name: ndev-session
description: Run the ndev session duties in a harness without native hooks.
---

These are instructions for the agent. At session start use ndev project status and ndev flow status to read the setup, mode, steering, issue and workflow. Read the applicable installed skills. At each prompt refresh that context and act on corrections. Use ndev flow checkpoint for Git changes. Report checks and workflow progress at turn end. Before leaving, finish or block the work and report outstanding resources.

Synchronous tool denial, guaranteed session-end cleanup, and recovery after terminal closure require host support.
`

const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const json = value => `${JSON.stringify(value, null, 2)}\n`
const hash = value => createHash('sha256').update(value).digest('hex')
const pathInfo = path => lstatSync(path, { throwIfNoEntry: false })
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const targetPath = path => {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  return resolve(realpathSync(ancestor), relative(ancestor, path))
}

function fail(code, message, repair, details) {
  throw Object.assign(new Error(message), { code, repair, details })
}

function parse(argv) {
  const args = [...argv]
  const verify = args[0] === 'verify'
  if (verify) args.shift()
  const name = args.shift()
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) fail(2, 'Name an install profile.', 'Run ndev install --help.')
  const opts = { name: name === 'opencode2' ? 'opencode' : name, verify }
  while (args.length) {
    const flag = args.shift()
    if (flag === '--dry-run' && !verify) opts.dryRun = true
    else if (flag === '--panels' && !verify) opts.panels = true
    else if (['--prefix', '--profile', ...(!verify ? ['--approve'] : [])].includes(flag)) {
      const value = args.shift()
      if (!value || value.startsWith('--')) fail(2, `${flag} needs a value.`)
      opts[flag.slice(2)] = value
    } else fail(2, `Unknown install option ${flag}.`, 'Run ndev install --help.')
  }
  if (opts.approve && !opts.panels) fail(2, '--approve requires --panels.')
  if (opts.profile && (builtin.includes(opts.name) || opts.name === 'all')) fail(2, 'Give a distinct name for a custom profile.')
  return opts
}

function readJson(path, code = 1) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(code, `Cannot read JSON in ${path}: ${error.message}`, `Repair the JSON in ${path} and rerun ndev install.`)
  }
}

function profilesFor(opts, home, before) {
  const names = opts.name === 'all' ? builtin : [opts.name]
  return names.map(name => {
    if (!builtin.includes(name)) {
      const profile = opts.profile ? readJson(opts.profile === '-' ? 0 : resolve(opts.profile), 2) : opts.verify && before.profiles[name]?.profile
      if (!object(profile) || profile.name !== name || typeof profile.skillsDir !== 'string' || !profile.skillsDir) fail(2, `Invalid or missing custom profile ${name}.`, `Run ndev install ${name} --profile <file> with name and skillsDir.`)
      const expand = value => {
        if (value === '~' || value.startsWith('~/')) return resolve(home, value.slice(2))
        if (!isAbsolute(value)) fail(2, `Custom profile path must be absolute or start with ~/: ${value}`)
        return resolve(value)
      }
      if (profile.hooks && profile.hooks !== 'none') fail(2, `Unsupported hook adapter for profile ${name}.`)
      if (!!profile.agentsDir !== !!profile.agentFormat || (profile.agentFormat && !['codex-toml', 'opencode-md', 'claude-md'].includes(profile.agentFormat))) fail(2, `Invalid agentsDir or agentFormat for ${name}.`)
      return { name, skillsDir: expand(profile.skillsDir), agentsDir: profile.agentsDir && expand(profile.agentsDir), agentFormat: profile.agentFormat, hooks: 'none' }
    }
    const base = readJson(join(here, 'harnesses', `${name}.json`))
    const dir = name === 'claude' ? (process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
      : name === 'codex' ? (process.env.CODEX_HOME || join(home, '.codex')) : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
    const config = resolve(dir)
    return { name, skillsDir: name === 'codex' ? join(home, '.agents/skills') : join(config, 'skills'),
      agentsDir: join(config, 'agents'), agentFormat: base.agentFormat, agentModels: base.agentModels,
      ...(name === 'opencode' ? { adapter: join(config, 'plugins/ndev/index.ts') } : { config: join(config, name === 'codex' ? 'hooks.json' : 'settings.json') }) }
  })
}

function releaseFiles(share, binary) {
  const files = new Map()
  const skip = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.pytest_cache'])
  function add(relative) {
    const source = join(root, relative)
    const stat = lstatSync(source)
    if (stat.isDirectory()) {
      if (root !== share && (share === source || share.startsWith(source + '/'))) fail(2, `Release destination ${share} overlaps release assets at ${source}.`, 'Use a prefix outside the release assets.')
      for (const entry of readdirSync(source)) {
        if (!skip.has(entry) && !(entry === 'tests' && relative.startsWith('scripts/export'))) add(join(relative, entry))
      }
    } else if (stat.isFile()) files.set(join(share, relative), { text: readFileSync(source), mode: stat.mode & 0o777 })
    else fail(1, `Unsupported release file ${source}.`)
  }
  for (const entry of ['bin/ndev', 'package.json', 'scripts', 'hooks', 'skills', 'agents', 'kb', 'templates', '.claude-plugin/plugin.json']) add(entry)
  if (existsSync(join(root, 'orca-plugin'))) add('orca-plugin')
  files.set(binary, { text: `#!/bin/sh\nexec ${quote(join(share, 'bin/ndev'))} "$@"\n`, mode: 0o755 })
  return files
}

function hookPlan(profile, binary, previous, retire = false) {
  const { config } = profile
  const info = pathInfo(config)
  if (info && !info.isFile()) fail(1, `Hook configuration ${config} is not a regular file.`)
  const original = info ? readFileSync(config, 'utf8') : null
  const document = original === null ? {} : readJson(config)
  if (!object(document) || (document.hooks !== undefined && !object(document.hooks))) fail(1, `Invalid hooks object in ${config}.`)
  document.hooks ??= {}
  const desired = {}
  for (const [event, handler] of Object.entries(events)) {
    const entries = document.hooks[event] ?? []
    if (!Array.isArray(entries) || entries.some(group => !object(group) || !Array.isArray(group.hooks))) fail(1, `Invalid hooks.${event} in ${config}.`)
    const expected = { type: 'command', command: `${quote(binary)} hook ${handler} --harness ${profile.name}` }
    if (!retire) desired[event] = expected
    const kept = []
    for (const group of entries) {
      const hooks = group.hooks.filter(hook => !isDeepStrictEqual(hook, previous?.[event]))
      if (!retire && hooks.some(hook => isDeepStrictEqual(hook, expected))) fail(1, `Unowned ndev hook for ${event} in ${config}: ${expected.command}. No matching ownership record.`, `Move the conflicting entry in ${quote(config)}, then rerun ndev install ${profile.name}.`)
      if (hooks.length || group.hooks.length === 0) kept.push({ ...group, hooks })
    }
    if (!retire) kept.push({ hooks: [expected] })
    if (kept.length) document.hooks[event] = kept
    else delete document.hooks[event]
  }
  return { config, original, text: json(document), desired, mode: info ? info.mode & 0o777 : 0o600 }
}

function atomic(path, data, mode, replace) {
  mkdirSync(dirname(path), { recursive: true })
  const stage = join(dirname(path), `.ndev-stage-${randomUUID()}`)
  try {
    writeFileSync(stage, data, { flag: 'wx', mode })
    chmodSync(stage, mode)
    if (replace) renameSync(stage, path)
    else linkSync(stage, path)
  } finally {
    rmSync(stage, { force: true })
  }
}

function readManifest(path) {
  const info = pathInfo(path)
  if (!info) return { schemaVersion: 1, files: {}, profiles: {} }
  if (!info.isFile()) fail(1, `Install manifest is not a regular file: ${path}`)
  const record = readJson(path)
  if (record?.schemaVersion !== 1 || !object(record.files) || !object(record.profiles)) fail(1, `Unrecognized install manifest ${path}.`, 'Move the unrelated file and retry ndev install.')
  const share = dirname(path)
  const binary = resolve(share, '../../bin/ndev')
  for (const [file, item] of Object.entries(record.files)) {
    const profiles = [record.profiles[item?.owner]?.profile, record.pending?.beforeProfiles?.[item?.owner]?.profile].filter(Boolean)
    const releaseEntry = relative(share, file)
    const inRelease = item?.owner === 'release' && (file === binary || releaseEntry === 'package.json' || /^(?:agents|bin|hooks|kb|orca-plugin|scripts|skills|templates|\.claude-plugin)\//.test(releaseEntry))
    const inProfile = profiles.some(profile => (profile.skillsDir && /^ndev-[^/]+\/.+/.test(relative(profile.skillsDir, file))) ||
      (profile.agentsDir && /^ndev-[^/]+\.(md|toml)$/.test(relative(profile.agentsDir, file))) || file === profile.adapter)
    if (!isAbsolute(file) || resolve(file) !== file || (!inRelease && !inProfile) || !Number.isInteger(item?.mode) || !/^[a-f0-9]{64}$/.test(item?.sha256)) {
      fail(1, `Invalid ownership record for ${file} in ${path}.`, 'Restore an intact ndev install manifest and retry.')
    }
  }
  return record
}

function runChild(exe, args, extra = {}) {
  const child = spawnSync(exe, args, { encoding: 'utf8', timeout: 35000, maxBuffer: 16 * 1024 * 1024, ...extra })
  const details = { executable: exe, args, exitStatus: child.status, signal: child.signal, output: (child.error?.message ?? (child.stderr + child.stdout)).trim() }
  if (child.error || child.status !== 0) fail(1, `${exe} ${args.join(' ')} failed (exit ${child.status ?? child.signal ?? child.error?.code}): ${details.output}`, undefined, details)
  return child.stdout
}

function installPanels(opts, share, profiles) {
  const folder = join(share, 'orca-plugin/ndev')
  const args = ['plugin', 'install', folder, '--json']
  if (opts.approve) args.push('--approve', opts.approve)
  try {
    if (!existsSync(join(folder, 'orca-plugin.json'))) fail(1, `Release is missing ${folder}/orca-plugin.json.`, 'Install a release containing the ndev panel plugin and rerun with --panels.')
    return { status: 'installed', receipt: JSON.parse(runChild('orca', args)) }
  } catch (error) {
    if (error.details?.exitStatus === 3) {
      let receipt
      try { receipt = JSON.parse(error.details.output) } catch {}
      const fingerprint = receipt?.error?.details?.fingerprint ?? receipt?.fingerprint ?? error.details.output.match(/\bap1-[\w-]+/)?.[0]
      if (fingerprint) {
        const next = ['ndev', 'install', opts.name, '--prefix', dirname(dirname(share)), '--panels', '--approve', fingerprint]
        if (opts.profile) next.push('--profile', opts.profile)
        return { status: 'approval-required', fingerprint, nextAction: next, receipt }
      }
    }
    fail(1, error.message, error.repair, { ...error.details, harnessInstall: 'complete', profiles, panels: 'failed' })
  }
}

function verifyRelease(profiles, manifest, manifestPath, binary, repair, cwd) {
  if (manifest.pending || !existsSync(manifestPath)) fail(1, `Missing or incomplete installation in ${manifestPath}.`, repair)
  const selected = new Set(['release', ...profiles.map(p => p.name)])
  const results = []
  for (const [path, item] of Object.entries(manifest.files)) {
    if (!selected.has(item.owner)) continue
    const info = pathInfo(path)
    if (!info?.isFile() || (info.mode & 0o777) !== item.mode || hash(readFileSync(path)) !== item.sha256) fail(1, `Missing or changed installed file ${path}.`, repair)
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')))
  const probe = (exe, argv, extra) => runChild(exe, argv, { cwd, env, ...extra })
  const binaryVersion = probe(binary, ['--version']).trim()
  if (!binaryVersion.includes(manifest.version)) fail(1, `Installed binary ${binary} reported ${binaryVersion}, expected ${manifest.version}.`, repair)
  for (const profile of profiles) {
    const installed = manifest.profiles[profile.name]
    if (!installed || !isDeepStrictEqual(installed.profile, JSON.parse(JSON.stringify(profile)))) fail(1, `No install record for active ${profile.name} paths.`, repair)
    if (profile.config) {
      const config = readJson(profile.config)
      for (const [event, handler] of Object.entries(installed.hooks)) {
        const entries = config.hooks?.[event]?.filter(group => group.hooks?.some(hook => isDeepStrictEqual(hook, handler))) ?? []
        if (entries.length !== 1 || entries[0].matcher) fail(1, `Missing or changed ndev ${event} hook in ${profile.config}.`, repair)
      }
      const payload = { cwd, session_id: 'ndev-install-verify', tool_name: profile.name === 'codex' ? 'exec_command' : 'Bash', tool_input: { command: 'pwd', cmd: 'pwd' }, hook_event_name: 'PreToolUse' }
      probe('/bin/sh', ['-c', installed.hooks.PreToolUse.command], { input: json(payload) })
    }
    if (profile.name === 'claude') {
      const request = { type: 'control_request', request_id: 'ndev-discovery', request: { subtype: 'initialize' } }
      const output = probe('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { input: json(request).replaceAll('\n', '') + '\n' })
      const response = output.trim().split('\n').map(line => JSON.parse(line)).find(row => row.response?.request_id === request.request_id)?.response?.response
      if (!response?.commands?.some(cmd => cmd.name === 'ndev-work-light') || !response?.agents?.some(agent => agent.name === 'ndev-diff-reviewer')) fail(1, 'Claude did not discover ndev-work-light and ndev-diff-reviewer.', repair)
    }
    if (profile.name === 'codex') {
      const output = probe('codex', ['debug', 'prompt-input', 'ndev installation check'])
      if (!output.includes('ndev-work-light')) fail(1, 'Codex did not discover ndev-work-light.', repair)
    }
    if (profile.name === 'opencode') {
      probe(process.execPath, [join(here, 'verify-opencode.mjs')])
    }
    results.push({ profile: profile.name, skillsDir: profile.skillsDir, agentsDir: profile.agentsDir, ...(profile.hooks === 'none' ? { hookSupport: 'agent instructions only' } : {}) })
  }
  return { verified: true, version: manifest.version, binary, profiles: results }
}

function buildPlan(opts, profiles, before, share, binary, assets) {
  const files = releaseFiles(share, binary)
  for (const file of files.values()) file.owner = 'release'
  const hooks = []
  const conflicts = []
  const records = { ...before.profiles }
  for (const profile of profiles) {
    const added = assets({ profile, share, binary, root, version })
    if (profile.adapter) {
      const source = readFileSync(join(here, 'opencode-plugin.mjs'), 'utf8')
      added.set(profile.adapter, { text: source.replace("'__NDEV_BINARY__'", () => JSON.stringify(binary)), mode: 0o644 })
    }
    if (profile.hooks === 'none') added.set(join(profile.skillsDir, 'ndev-session/SKILL.md'), { text: sessionSkill, mode: 0o644 })
    for (const [path, entry] of added) {
      if (files.has(path) || (before.files[path] && before.files[path].owner !== profile.name)) conflicts.push(path)
      files.set(path, { ...entry, owner: profile.name })
    }
    records[profile.name] = { profile, version }
    if (profile.config) {
      const previous = before.profiles[profile.name]
      const original = before.pending?.beforeProfiles?.[profile.name] ?? previous
      if (original?.profile.config && original.profile.config !== profile.config && pathInfo(original.profile.config)) {
        hooks.push(hookPlan(original.profile, binary, original.hooks, true))
      }
      const hook = hookPlan(profile, binary, previous?.hooks)
      hooks.push(hook)
      records[profile.name].hooks = hook.desired
    }
  }
  const selected = new Set(['release', ...profiles.map(p => p.name)])
  const retired = Object.keys(before.files).filter(path => selected.has(before.files[path].owner) && !files.has(path))
  const activeTargets = new Set([...files.keys()].map(targetPath))
  const stale = retired.filter(path => !activeTargets.has(targetPath(path)))
  const owned = { ...before.files }
  const previousFiles = { ...before.files }
  const ownedTargets = new Map(Object.entries(before.files).map(([path, entry]) => [targetPath(path), entry]))
  for (const [path, entry] of files) {
    if (previousFiles[path]) continue
    const previous = ownedTargets.get(targetPath(path))
    if (previous?.owner === entry.owner) previousFiles[path] = previous
  }
  for (const path of retired) delete owned[path]
  for (const path of stale) {
    const info = pathInfo(path)
    if (info && (!info.isFile() || hash(readFileSync(path)) !== before.files[path].sha256)) conflicts.push(path)
  }
  for (const [path, entry] of files) {
    const info = pathInfo(path)
    const digest = hash(entry.text)
    const previous = previousFiles[path]
    if (info && (!info.isFile() || !previous || (previous.reserved && hash(readFileSync(path)) !== previous.sha256))) conflicts.push(path)
    owned[path] = { owner: entry.owner, mode: entry.mode, sha256: digest }
  }
  const result = { profiles: profiles.map(p => p.name), version, binary, files: [...files.keys()], removed: stale, conflicts,
    ...(opts.panels ? { panelSource: join(share, 'orca-plugin/ndev') } : {}),
    hooks: hooks.map(({ config, desired }) => ({ config, entries: desired })),
    ...(profiles.some(p => p.name === 'codex') ? { codex: { trust: 'Review and trust the hooks in Codex /hooks.', roleLimits: 'Read-only roles use the read-only sandbox. Agent tool lists and delegation restrictions require host support.' } } : {}) }
  return { files, hooks, stale, result, previousFiles, manifest: { schemaVersion: 1, version, files: owned, profiles: records } }
}

function apply(plan, before, manifestPath) {
  const reserved = { ...plan.manifest.files }
  for (const path of plan.files.keys()) {
    if (!plan.previousFiles[path] || plan.previousFiles[path].reserved) reserved[path] = { ...reserved[path], reserved: true }
  }
  for (const path of plan.stale) reserved[path] = before.files[path]
  atomic(manifestPath, json({ ...plan.manifest, pending: { profiles: plan.result.profiles, beforeProfiles: before.pending?.beforeProfiles ?? before.profiles }, files: reserved }), 0o600, !!pathInfo(manifestPath))
  for (const [path, { text, mode }] of plan.files) {
    const info = pathInfo(path)
    if (info?.isFile() && hash(readFileSync(path)) === plan.manifest.files[path].sha256 && (info.mode & 0o777) === mode) continue
    const previous = plan.previousFiles[path]
    if (info && (!previous || (previous.reserved && hash(readFileSync(path)) !== previous.sha256))) fail(1, `File appeared during install: ${path}.`, 'Move the conflicting file and rerun ndev install.')
    atomic(path, text, mode, !!info)
  }
  for (const hook of plan.hooks) {
    const current = pathInfo(hook.config) ? readFileSync(hook.config, 'utf8') : null
    if (current !== hook.original) fail(5, `Hook configuration changed during install: ${hook.config}.`, 'Rerun ndev install.')
    if (current !== hook.text) atomic(hook.config, hook.text, hook.mode, current !== null)
  }
  for (const path of plan.stale) {
    if (pathInfo(path) && hash(readFileSync(path)) !== before.files[path].sha256) fail(1, `Changed file at ${path} during install.`)
    rmSync(path, { force: true })
  }
  atomic(manifestPath, json(plan.manifest), 0o600, true)
}

export function installRelease(argv, assets) {
  try {
    const opts = parse(argv)
    const home = resolve(process.env.HOME)
    const prefix = resolve(opts.prefix ?? join(home, '.local'))
    const share = join(prefix, 'share/ndev')
    const binary = join(prefix, 'bin/ndev')
    const manifestPath = join(share, 'install-manifest.json')
    const before = readManifest(manifestPath)
    const profiles = profilesFor(opts, home, before)
    if (before.pending && !opts.verify && !isDeepStrictEqual(before.pending.profiles, profiles.map(p => p.name))) {
      const previous = before.pending.profiles?.length === 1 ? before.pending.profiles[0] : 'all'
      fail(1, `Unfinished install for ${previous} in ${manifestPath}.`, `Complete ndev install ${previous} --prefix ${quote(prefix)} first.`)
    }
    const repair = `Run ndev install ${opts.name} --prefix ${quote(prefix)}${opts.profile ? ` --profile ${quote(opts.profile)}` : ''}.`
    if (opts.verify) {
      const cwd = mkdtempSync(join(tmpdir(), 'ndev-install-verify-'))
      try { return verifyRelease(profiles, before, manifestPath, binary, repair, cwd) }
      finally { rmSync(cwd, { recursive: true, force: true }) }
    }
    const plan = buildPlan(opts, profiles, before, share, binary, assets)
    if (opts.dryRun) return { ...plan.result, dryRun: true }
    if (plan.result.conflicts.length) fail(1, `Install conflicts: ${plan.result.conflicts.join(', ')}`, `Move the conflicting files. ${repair}`, { conflicts: plan.result.conflicts })
    const lock = join(share, '.install-lock')
    mkdirSync(share, { recursive: true })
    try {
      atomic(lock, String(process.pid), 0o600, false)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      fail(5, `Install lock ${lock} belongs to PID ${readFileSync(lock, 'utf8')}.`, `Wait for that installer, then retry. If its process has ended, remove ${quote(lock)}. ${repair}`)
    }
    try {
      if (!isDeepStrictEqual(before, readManifest(manifestPath))) fail(5, `Install manifest changed: ${manifestPath}.`, repair)
      apply(plan, before, manifestPath)
    } finally {
      rmSync(lock)
    }
    return { ...plan.result, manifest: manifestPath, ...(opts.panels ? { panels: installPanels(opts, share, plan.result.profiles) } : {}) }
  } catch (error) {
    if (Number.isInteger(error.code)) throw error
    fail(1, `Installation failed: ${error.message}`, 'Correct the named path and rerun ndev install.')
  }
}
