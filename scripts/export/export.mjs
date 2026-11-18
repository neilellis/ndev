#!/usr/bin/env node
import { installRelease } from './install.mjs'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const USAGE = 'usage: export.mjs <harness> [--out <dir>] [--skills-dir <dir>] [--agents-dir <dir>] [--home <dir>] [--plugin-root <dir>] [--date <iso>] [--dry-run]'
const HOME_DIRS = ['scripts', 'kb', 'templates']
const EXCLUDED_SKILLS = new Set(['for-codex'])
const SKIPPED = new Set(['node_modules', '.DS_Store', '__pycache__', '.pytest_cache'])
const TEXT = new Set(['.md', '.sh', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.toml', '.yaml', '.yml', '.py', '.txt', '.html', '.css', '.svg', '.bash', '.zsh', ''])
const FLOW_FILES = { 'flow/workflow/machine.ts': 'hooks/workflow/machine.ts', 'flow/workflow/change-types.ts': 'hooks/workflow/change-types.ts' }
const LEFTOVERS = [
  [/\bAgent tool\b|\bsubagent_type\b|\bTask tool\b|\bisolation: ?"?worktree/, 'Claude subagent call'],
  [/\bAskUserQuestion\b/, 'Claude question dialog'],
  [/\bmcp__(?!ndev__)\w+/, 'MCP tool of another server'],
  [/\b(TaskStop|TaskOutput|Monitor|ScheduleWakeup|SendMessage|ToolSearch|EnterPlanMode|ExitPlanMode|TodoWrite|WebFetch|WebSearch)\b/, 'Claude Code built-in tool'],
  [/\bCLAUDE\.md\b/, 'Claude instructions file'],
  [/(^|[\s`"'(])~?\.claude\//, 'Claude config folder'],
  [/(^|[\s`(])\/(flow|unblock|learn|dev|dev-mode|dev-steering|dev-setup|ndev:[\w-]+)(?=[\s`).,:]|$)/, 'Claude slash command'],
  [/\b(PreToolUse|PostToolUse|SessionStart|UserPromptSubmit|hooks\.json)\b/, 'Claude hook'],
  [/\bCLAUDE_[A-Z_]+\b/, 'Claude environment variable'],
]

class Fail extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function parseArgs(argv) {
  const [harness, ...rest] = argv
  if (!harness || harness.startsWith('-')) throw new Fail(2, `export: name the harness. ${USAGE}`)
  const opts = { harness }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--dry-run') { opts.dryRun = true; continue }
    const key = { '--out': 'out', '--skills-dir': 'skillsDir', '--agents-dir': 'agentsDir', '--home': 'home', '--plugin-root': 'pluginRoot', '--date': 'date' }[flag]
    if (!key) throw new Fail(2, `export: "${flag}" is not an option. ${USAGE}`)
    const value = rest[++i]
    if (value === undefined) throw new Fail(2, `export: ${flag} needs a value. ${USAGE}`)
    opts[key] = value
  }
  return opts
}

const expand = (path, home) => resolve(path.replace(/^~(?=\/|$)/, home))

function loadProfile(harness, home) {
  const dir = join(HERE, 'harnesses')
  const profiles = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const found = profiles.find(p => p.name === harness || p.aliases?.includes(harness))
  return { found, known: profiles.flatMap(p => [p.name, ...(p.aliases ?? [])]) }
}

function placesFor(opts) {
  const home = process.env.HOME || homedir()
  const { found, known } = loadProfile(opts.harness, home)
  if (!found && !opts.skillsDir) {
    throw new Fail(2, `export: no profile for the harness "${opts.harness}". Known harnesses: ${known.join(', ')}. Repair: give --skills-dir <the folder where ${opts.harness} reads user skills>, and --agents-dir for its agents.`)
  }
  const profile = found ?? { name: opts.harness, aliases: [], skillsDir: null, agentsDir: null, agentFormat: null, reviewCommand: null, verify: null, notes: `No profile: find how ${opts.harness} loads skills and agents.` }
  const out = opts.out && resolve(opts.out)
  const pick = (given, fromOut, fromProfile) => (given ? resolve(given) : out ? join(out, fromOut) : fromProfile && expand(fromProfile, home))
  return {
    profile,
    pluginRoot: resolve(opts.pluginRoot ?? join(HERE, '../..')),
    skillsDir: pick(opts.skillsDir, 'skills', profile.skillsDir),
    agentsDir: pick(opts.agentsDir, 'agents', profile.agentsDir),
    home: pick(opts.home, 'home', `~/.ndev-export/${profile.name}`),
  }
}

const listFiles = (dir, skipDir = () => false) =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIPPED.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (!statSync(path).isDirectory()) return [path]
    return skipDir(path) ? [] : listFiles(path, skipDir)
  })

const isPluginTest = path => basename(path) === 'tests' || path.endsWith('/scripts/export')

const isText = path => TEXT.has(extname(path)) || basename(path).startsWith('.')

function frontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') return undefined
  const close = lines.indexOf('---', 1)
  if (close < 0) return undefined
  const fields = {}
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (m) fields[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2]
  }
  return { fields, head: lines.slice(1, close), body: lines.slice(close + 1).join('\n') }
}

function makeRewriter({ pluginRoot, skillsDir, home, skills, agents, binary }) {
  const known = new Set([...skills, ...agents])
  const flow = binary ? 'ndev flow' : `${home}/bin/ndev-flow`
  return text =>
    text
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([a-z0-9-]+)/g, (all, name) => (skills.includes(name) ? `${skillsDir}/ndev-${name}` : all))
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', home)
      .replaceAll(`${pluginRoot}/`, `${home}/`)
      .replaceAll('mcp__ndev__*', `${flow} <command>`)
      .replaceAll('mcp__ndev__<', `${flow} <`)
      .replace(binary ? /\bmcp__ndev__(\w+)(?:\([^()`\n]*\))?/g : /\bmcp__ndev__(\w+)/g, (_, tool) => binary ? `ndev ${cliCommand(tool)}` : `${flow} ${tool}`)
      .replace(/(?<![\w/.-])\/?ndev:([a-z0-9-]+)/g, (all, name) => (known.has(name) ? `ndev-${name}` : all))
      .replace(/`([a-z0-9-]+)`(?= skills?\b)/g, (all, name) => (skills.includes(name) ? `\`ndev-${name}\`` : all))
      .replace(/(?<=\bskills? )`([a-z0-9-]+)`/g, (all, name) => (skills.includes(name) ? `\`ndev-${name}\`` : all))
}

function cliCommand(tool) {
  const specific = {
    started: 'flow start', unblocked: 'flow unblock', setSteering: 'flow steering',
    iNeedA: 'project guidance', reportWorkflowBug: 'project report-workflow-bug',
    waitForIssue: 'wait issue', waitForPR: 'wait pr', waitForState: 'wait state',
    epic: 'epic status', epicStarted: 'epic start',
  }
  if (specific[tool]) return specific[tool]
  const words = tool.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  return words.startsWith('epic-') ? `epic ${words.slice(5)}` : `flow ${words}`
}

const regenerate = ctx => ctx.binary ? `Regenerate with ndev install ${ctx.profile.name}.` : `Do not edit: run /dev export ${ctx.profile.name} to regenerate.`

const stampText = (ctx, how) => ctx.binary ? `Installed by ndev ${ctx.version} for ${ctx.profile.name}. ${how}` : `Generated by ndev export for ${ctx.profile.name} from ndev ${ctx.version} (${ctx.commit}) on ${ctx.date}. ${how}`

function skillFile(ctx, text, name) {
  const fm = frontmatter(text)
  if (!fm) throw new Fail(1, `export: ${join(ctx.pluginRoot, 'skills', name, 'SKILL.md')} has no frontmatter, so it cannot be renamed ndev-${name}. Repair: add a "---" block with name and description.`)
  const head = fm.head.some(l => l.startsWith('name:')) ? fm.head.map(l => (l.startsWith('name:') ? `name: ndev-${name}` : l)) : [`name: ndev-${name}`, ...fm.head]
  return ['---', ...head, '---', `<!-- ${stampText(ctx, regenerate(ctx))} -->`, fm.body.replace(/^\n?/, '\n')].join('\n')
}

function agentFile(ctx, source, text, name) {
  const fm = frontmatter(text)
  if (!fm?.fields.description) throw new Fail(1, `export: the agent ${source} has no description in its frontmatter. Repair: add one.`)
  const body = fm.body.replace(/^\n+/, '')
  const how = regenerate(ctx)
  if (ctx.profile.agentFormat === 'claude-md') {
    const head = fm.head.map(line => {
      if (line.startsWith('name:')) return `name: ndev-${name}`
      return line.replace(/^  - ([a-z0-9-]+)$/, (all, id) => ctx.skills.includes(id) ? `  - ndev-${id}` : all)
    })
    return { path: `ndev-${name}.md`, text: ['---', ...head, '---', '', body].join('\n') }
  }
  if (ctx.profile.agentFormat === 'codex-toml') {
    if (body.includes("'''")) throw new Fail(1, `export: the agent ${source} holds ''' and cannot be a TOML literal string. Repair: remove it from the agent text.`)
    const model = ctx.profile.agentModels?.[name]
    return { path: `ndev-${name}.toml`, text: [`# ${stampText(ctx, how)}`, `name = "ndev-${name}"`, `description = ${JSON.stringify(fm.fields.description)}`, ...(model ? [`model = ${JSON.stringify(model)}`] : []), ...(ctx.binary && fm.fields.tools ? ['sandbox_mode = "read-only"'] : []), `developer_instructions = '''`, `${body}'''`, ''].join('\n') }
  }
  const permissions = []
  if (ctx.binary && ctx.profile.agentFormat === 'opencode-md') {
    const actions = { Read: 'read', Glob: 'glob', Grep: 'grep', Bash: 'shell', WebFetch: 'webfetch', Agent: 'subagent' }
    const rules = []
    if (fm.fields.tools) {
      rules.push(['*', 'deny'])
      for (const tool of fm.fields.tools.split(/,\s*/)) rules.push([actions[tool], 'allow'])
    }
    for (const tool of fm.fields.disallowedTools?.split(/,\s*/) ?? []) rules.push([actions[tool], 'deny'])
    if (rules.length) permissions.push('permissions:')
    for (const [action, effect] of rules) {
      if (!action) throw new Fail(1, `Unknown role permission in ${source}`)
      permissions.push(`  - action: ${JSON.stringify(action)}`, '    resource: "*"', `    effect: ${effect}`)
    }
  }
  return { path: `ndev-${name}.md`, text: ['---', `description: ${JSON.stringify(fm.fields.description)}`, 'mode: subagent', ...permissions, '---', `<!-- ${stampText(ctx, how)} -->`, '', body].join('\n') }
}

const leftoversOf = (file, text) =>
  text.split('\n').flatMap((line, i) => LEFTOVERS.filter(([re]) => re.test(line)).map(([, construct]) => ({ file, line: i + 1, construct, text: line.trim().slice(0, 200) })))

function plugin(root) {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  const git = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return { version: manifest.version, commit: git.status === 0 ? `commit ${git.stdout.trim()}` : 'no git commit: the plugin is not a git checkout' }
}

function plan(ctx) {
  const files = new Map()
  const leftovers = []
  const rewrite = makeRewriter(ctx)
  const put = (path, text, mode = 0o644, scan = false) => {
    files.set(path, { text, mode })
    if (scan && typeof text === 'string') leftovers.push(...leftoversOf(path, text))
  }
  const copy = (source, target, scan) => {
    const mode = statSync(source).mode & 0o777
    if (!isText(source)) return put(target, readFileSync(source), mode)
    put(target, rewrite(readFileSync(source, 'utf8')), mode, scan)
  }
  for (const name of ctx.skills) {
    const dir = join(ctx.pluginRoot, 'skills', name)
    for (const source of listFiles(dir, isPluginTest)) {
      const target = join(ctx.skillsDir, `ndev-${name}`, source.slice(dir.length + 1))
      if (source === join(dir, 'SKILL.md')) put(target, skillFile(ctx, rewrite(readFileSync(source, 'utf8')), name), 0o644, true)
      else copy(source, target, source.endsWith('.md'))
    }
  }
  if (ctx.agentsDir && ctx.profile.agentFormat) {
    for (const name of ctx.agents) {
      const source = join(ctx.pluginRoot, 'agents', `${name}.md`)
      const raw = readFileSync(source, 'utf8')
      const made = agentFile(ctx, source, rewrite(raw), name)
      const target = join(ctx.agentsDir, made.path)
      put(target, made.text, 0o644, true)
      const tools = frontmatter(raw)?.fields.tools
      if (tools) leftovers.push({ file: target, line: 1, construct: 'Claude tools list', text: `tools: ${tools}. Set the same limits in the harness's own permissions or sandbox.` })
    }
  }
  if (ctx.binary) return { files, leftovers }
  for (const dir of HOME_DIRS) {
    const root = join(ctx.pluginRoot, dir)
    if (!existsSync(root)) continue
    for (const source of listFiles(root, dir === 'templates' ? () => false : isPluginTest)) copy(source, join(ctx.home, dir, source.slice(root.length + 1)), source.endsWith('.md'))
  }
  for (const [target, source] of Object.entries(FLOW_FILES)) {
    const text = readFileSync(join(ctx.pluginRoot, source), 'utf8').replace(/from '(\.\/[\w-]+)'/g, "from '$1.ts'")
    put(join(ctx.home, target), target.endsWith('machine.ts') ? text : rewrite(text))
  }
  put(join(ctx.home, 'flow/cli.ts'), rewrite(readFileSync(join(HERE, 'flow/cli.ts'), 'utf8')))
  put(join(ctx.home, 'flow/profile.json'), `${JSON.stringify({ ...ctx.profile, home: ctx.home, skillsDir: ctx.skillsDir, agentsDir: ctx.agentsDir, version: ctx.version }, null, 2)}\n`)
  put(join(ctx.home, 'bin/ndev-flow'), [
    '#!/bin/sh',
    `# ${stampText(ctx, regenerate(ctx))}`,
    'major=$(node -p "process.versions.node.split(\'.\')[0]" 2>/dev/null) || { echo "ndev-flow: node is not on PATH. Repair: install Node.js 23.6 or later." >&2; exit 127; }',
    '[ "$major" -ge 23 ] || { echo "ndev-flow: Node.js $major cannot run TypeScript. Repair: install Node.js 23.6 or later." >&2; exit 127; }',
    `exec node --no-warnings ${shellQuote(`${ctx.home}/flow/cli.ts`)} "$@"`,
    '',
  ].join('\n'), 0o755)
  put(join(ctx.home, 'README.md'), readme(ctx))
  return { files, leftovers }
}

const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`

function readme(ctx) {
  return [
    `<!-- ${stampText(ctx, regenerate(ctx))} -->`,
    `# ndev for ${ctx.profile.name}`,
    '',
    `This folder holds the scripts, the knowledge base and the workflow CLI that the ndev skills in ${ctx.skillsDir} call.`,
    '',
    `- Workflow CLI: \`${ctx.home}/bin/ndev-flow\`. Run \`${ctx.home}/bin/ndev-flow help\` for its commands. Add \`${ctx.home}/bin\` to PATH to call it as \`ndev-flow\`.`,
    `- Skills: ${ctx.skillsDir}/ndev-*. Agents: ${ctx.agentsDir ?? 'not exported'}.`,
    `- Constructs that only Claude Code understands, left for the adapter: ${ctx.home}/leftovers.json.`,
    `- The list of generated files: ${ctx.home}/manifest.json. A new export replaces and removes only these files.`,
    '',
    `Harness notes: ${ctx.profile.notes ?? 'none'}`,
    '',
  ].join('\n')
}

function guard(ctx, files) {
  const manifestFile = join(ctx.home, 'manifest.json')
  const before = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { files: [] }
  const owned = new Set(before.files)
  const foreign = [...files.keys()].filter(path => existsSync(path) && !owned.has(path))
  if (foreign.length) {
    const shown = foreign.slice(0, 20).join('\n  ')
    throw new Fail(3, `export: ${foreign.length} file(s) exist that this export did not generate, so nothing was written:\n  ${shown}${foreign.length > 20 ? `\n  and ${foreign.length - 20} more` : ''}\nRepair: move or delete them, or export to another folder with --out <dir> (or --skills-dir and --agents-dir).`)
  }
  const roots = new Set([ctx.skillsDir, ctx.agentsDir, ctx.home, before.skillsDir, before.agentsDir, before.home].filter(Boolean))
  return { manifestFile, before, roots, stale: before.files.filter(path => !files.has(path)) }
}

const inside = (dir, roots) => [...roots].some(root => dir.startsWith(`${root}/`))

function saveManifest(ctx, file, paths) {
  const manifest = { harness: ctx.profile.name, version: ctx.version, commit: ctx.commit, generatedAt: ctx.date, home: ctx.home, skillsDir: ctx.skillsDir, agentsDir: ctx.agentsDir, files: [...new Set(paths)].sort() }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(manifest, null, 1)}\n`)
}

function step(path, what, action) {
  try {
    action()
  } catch (error) {
    throw new Fail(1, `export: ${what} ${path} failed: ${error.message}. Nothing else was changed after it, and the manifest lists each file of the export.\nRepair: clear or fix ${path}, then export again.`)
  }
}

function write(ctx, files, leftovers, guarded) {
  const leftoversFile = join(ctx.home, 'leftovers.json')
  files.set(leftoversFile, { text: `${JSON.stringify(leftovers, null, 1)}\n`, mode: 0o644 })
  files.set(guarded.manifestFile, { text: '', mode: 0o644 })
  step(guarded.manifestFile, 'writing', () => saveManifest(ctx, guarded.manifestFile, [...guarded.before.files, ...files.keys()]))
  for (const path of guarded.stale) {
    step(path, 'removing', () => rmSync(path, { force: true }))
    for (let dir = dirname(path); inside(dir, guarded.roots); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length) break
      step(dir, 'removing', () => rmdirSync(dir))
    }
  }
  for (const [path, { text, mode }] of files) {
    if (path === guarded.manifestFile) continue
    step(path, 'writing', () => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      chmodSync(path, mode)
    })
  }
  step(guarded.manifestFile, 'writing', () => saveManifest(ctx, guarded.manifestFile, files.keys()))
  return leftoversFile
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const places = placesFor(opts)
  const { version, commit } = plugin(places.pluginRoot)
  const skills = readdirSync(join(places.pluginRoot, 'skills')).filter(n => !EXCLUDED_SKILLS.has(n) && existsSync(join(places.pluginRoot, 'skills', n, 'SKILL.md'))).sort()
  const agents = readdirSync(join(places.pluginRoot, 'agents')).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => f.slice(0, -3)).sort()
  const ctx = { ...places, version, commit, date: opts.date ?? new Date().toISOString(), skills, agents }
  const { files, leftovers } = plan(ctx)
  const guarded = guard(ctx, files)
  const byConstruct = leftovers.reduce((acc, l) => ({ ...acc, [l.construct]: (acc[l.construct] ?? 0) + 1 }), {})
  const summary = { harness: ctx.profile.name, profileFound: !!ctx.profile.skillsDir || !opts.skillsDir, home: ctx.home, skillsDir: ctx.skillsDir, agentsDir: ctx.agentsDir, skills: skills.length, agents: ctx.profile.agentFormat ? agents.length : 0, files: files.size + 2, removed: guarded.stale.length, version, commit, generatedAt: ctx.date }
  if (opts.dryRun) {
    console.log(JSON.stringify({ ...summary, dryRun: true, leftovers: { total: leftovers.length, byConstruct } }))
    return
  }
  const leftoversFile = write(ctx, files, leftovers, guarded)
  console.log(JSON.stringify({ ...summary, flow: join(ctx.home, 'bin/ndev-flow'), verify: ctx.profile.verify, verifyExpect: ctx.profile.verifyExpect, notes: ctx.profile.notes, leftovers: { total: leftovers.length, file: leftoversFile, byConstruct } }))
}

export function runInstall(argv) {
  return installRelease(argv, ({ profile, share, binary, root, version }) => {
    const skills = readdirSync(join(root, 'skills')).filter(name => !EXCLUDED_SKILLS.has(name) && existsSync(join(root, 'skills', name, 'SKILL.md'))).sort()
    const agents = readdirSync(join(root, 'agents')).filter(name => name.endsWith('.md') && name !== 'README.md').map(name => name.slice(0, -3)).sort()
    return plan({ profile, binary, pluginRoot: root, home: share, skillsDir: profile.skillsDir, agentsDir: profile.agentsDir, skills, agents, version, commit: 'release', date: version }).files
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'install') console.log(JSON.stringify(runInstall(process.argv.slice(3))))
    else main()
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error
    console.error([error.message, error.repair].filter(Boolean).join('\n'))
    process.exitCode = error.code
  }
}
