import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const exporter = new URL('../export.mjs', import.meta.url).pathname

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "ndev install '"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data') }
  const prefix = join(home, 'prefix')
  function run(...args) {
    return spawnSync(process.execPath, [exporter, 'install', ...args, '--prefix', prefix], { env, encoding: 'utf8', cwd: home, maxBuffer: 8 * 1024 * 1024 })
  }
  function install(...args) {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  return { home, env, prefix, run, install }
}

const read = path => JSON.parse(readFileSync(path, 'utf8'))

test('install recognises copied owned hooks and symlinked assets in a Claude profile', t => {
  const { home, env, install } = fixture(t)
  const first = install('claude')
  const original = env.CLAUDE_CONFIG_DIR
  const foreign = { matcher: 'Read', hooks: [{ type: 'command', command: 'check-read' }] }
  const document = read(join(original, 'settings.json'))
  document.hooks.PreToolUse.unshift(foreign)
  const settings = JSON.stringify(document)
  writeFileSync(join(original, 'settings.json'), settings)
  const profile = join(home, 'orca-profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'settings.json'), settings)
  symlinkSync(join(original, 'skills'), join(profile, 'skills'), 'dir')
  symlinkSync(join(original, 'agents'), join(profile, 'agents'), 'dir')
  env.CLAUDE_CONFIG_DIR = profile
  assert.deepEqual(install('claude', '--dry-run').conflicts, [])
  install('claude')
  assert.equal(read(join(profile, 'settings.json')).hooks.SessionStart.length, 1)
  assert.deepEqual(read(join(profile, 'settings.json')).hooks.PreToolUse[0], foreign)
  assert.equal(read(join(original, 'settings.json')).hooks.SessionStart.length, 1)
  assert.deepEqual(read(join(original, 'settings.json')).hooks.PreToolUse[0], foreign)
  assert.ok(existsSync(join(original, 'skills/ndev-work-light/SKILL.md')))
  assert.equal(read(first.manifest).profiles.claude.profile.config, join(profile, 'settings.json'))
  install('claude')
  env.CLAUDE_CONFIG_DIR = original
  install('claude')
  assert.equal(read(join(original, 'settings.json')).hooks.SessionStart.length, 1)
  assert.equal(read(join(profile, 'settings.json')).hooks.SessionStart.length, 1)
  assert.ok(existsSync(join(profile, 'agents/ndev-diff-reviewer.md')))
})

test('Claude installs retain and repair assets and hooks in separate config homes', t => {
  const { home, env, install } = fixture(t)
  const first = install('claude')
  const original = env.CLAUDE_CONFIG_DIR
  const second = join(home, 'second-claude')
  const third = join(home, 'third-claude')
  env.CLAUDE_CONFIG_DIR = second
  install('claude')
  env.CLAUDE_CONFIG_DIR = third
  install('claude')
  for (const dir of [original, second, third]) {
    assert.equal(read(join(dir, 'settings.json')).hooks.SessionStart.length, 1)
    assert.ok(existsSync(join(dir, 'skills/ndev-work-light/SKILL.md')))
    assert.ok(existsSync(join(dir, 'agents/ndev-diff-reviewer.md')))
  }
  rmSync(join(original, 'skills/ndev-work-light/SKILL.md'))
  rmSync(join(second, 'settings.json'))
  env.CLAUDE_CONFIG_DIR = original
  install('claude')
  assert.equal(read(first.manifest).profiles.claude.additionalInstalls.length, 2)
  assert.ok(existsSync(join(original, 'skills/ndev-work-light/SKILL.md')))
  assert.equal(read(join(second, 'settings.json')).hooks.SessionStart.length, 1)
  for (const dir of [original, second, third]) {
    env.CLAUDE_CONFIG_DIR = dir
    assert.deepEqual(install('claude', '--dry-run').conflicts, [])
  }
})

test('install refuses an identical hook without recorded ownership and gives its command and repair', t => {
  const { env, prefix, install, run } = fixture(t)
  const hook = install('claude', '--dry-run').hooks[0].entries.SessionStart
  mkdirSync(env.CLAUDE_CONFIG_DIR)
  const config = join(env.CLAUDE_CONFIG_DIR, 'settings.json')
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } })
  writeFileSync(config, original)
  const result = run('claude')
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(config), result.stderr)
  assert.ok(result.stderr.includes(hook.command), result.stderr)
  assert.match(result.stderr, /No matching ownership record/)
  assert.match(result.stderr, /rerun ndev install claude/)
  assert.equal(readFileSync(config, 'utf8'), original)
  assert.equal(existsSync(prefix), false)
})

test('switching a Claude profile refuses unrelated assets beside owned directory aliases', t => {
  const { home, env, install, run } = fixture(t)
  install('claude')
  const original = env.CLAUDE_CONFIG_DIR
  const profile = join(home, 'orca-profile')
  mkdirSync(profile)
  const settings = readFileSync(join(original, 'settings.json'), 'utf8')
  writeFileSync(join(profile, 'settings.json'), settings)
  symlinkSync(join(original, 'skills'), join(profile, 'skills'), 'dir')
  mkdirSync(join(profile, 'agents'))
  const foreign = join(profile, 'agents/ndev-diff-reviewer.md')
  writeFileSync(foreign, 'foreign agent')
  env.CLAUDE_CONFIG_DIR = profile
  const result = run('claude')
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(foreign), result.stderr)
  assert.equal(readFileSync(foreign, 'utf8'), 'foreign agent')
  assert.equal(readFileSync(join(original, 'settings.json'), 'utf8'), settings)
  assert.equal(readFileSync(join(profile, 'settings.json'), 'utf8'), settings)
})

test('install all plans active harness paths, a single shared release, and leaves HOME untouched', t => {
  const { env, prefix, install } = fixture(t)
  const result = install('all', '--dry-run')
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.profiles, ['claude', 'codex', 'opencode'])
  assert.ok(result.files.includes(join(prefix, 'bin/ndev')))
  assert.ok(result.files.includes(join(env.CODEX_HOME, 'agents/ndev-diff-reviewer.toml')))
  assert.ok(result.files.includes(join(env.XDG_CONFIG_HOME, 'opencode/plugins/ndev/index.ts')))
  assert.equal(result.files.length, new Set(result.files).size)
  assert.equal(existsSync(prefix), false)
  assert.equal(existsSync(env.CLAUDE_CONFIG_DIR), false)
})

test('the Codex profile installs the CLI and triage skills for dollar invocation', t => {
  const { home, env, install } = fixture(t)
  const skills = ['ndev-cli', 'ndev-triage']
  const files = install('codex', '--dry-run').files
  for (const name of skills) assert.ok(files.includes(join(home, '.agents/skills', name, 'SKILL.md')), `Missing $${name} from the install plan`)
  install('codex')
  for (const name of skills) {
    assert.match(readFileSync(join(home, '.agents/skills', name, 'SKILL.md'), 'utf8'), new RegExp(`^name: ${name}$`, 'm'))
  }
  if (process.env.NDEV_TEST_NATIVE_HARNESSES === '1') {
    const result = spawnSync('codex', ['debug', 'prompt-input', '$ndev-triage --open'], { cwd: home, env, encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    for (const name of skills) assert.ok(result.stdout.includes(`- ${name}: `), `Codex did not discover $${name}`)
  }
})

test('installed skills mention the North Star only briefly in work skills', t => {
  const { home, env, prefix, install } = fixture(t)
  install('all')
  const guide = join(prefix, 'share/ndev/kb/north-star.md')
  for (const skills of [join(env.CLAUDE_CONFIG_DIR, 'skills'), join(home, '.agents/skills'), join(env.XDG_CONFIG_HOME, 'opencode/skills')]) {
    for (const name of readdirSync(skills)) {
      const body = readFileSync(join(skills, name, 'SKILL.md'), 'utf8')
      assert.ok(!body.includes('kb/north-star.md'), `${name} still links the boilerplate guide`)
      if (name.startsWith('ndev-work-')) assert.match(body, /NORTH_STAR\.md/)
      else assert.doesNotMatch(body, /NORTH_STAR\.md/, name)
    }
  }
  const policy = readFileSync(guide, 'utf8')
  assert.match(policy, /keep the phase open/i)
  assert.match(policy, /read only the sections that apply/i)
  for (const reviewer of [
    join(env.CLAUDE_CONFIG_DIR, 'agents/ndev-diff-reviewer.md'),
    join(env.CODEX_HOME, 'agents/ndev-diff-reviewer.toml'),
    join(env.XDG_CONFIG_HOME, 'opencode/agents/ndev-diff-reviewer.md'),
  ]) {
    const instructions = readFileSync(reviewer, 'utf8')
    assert.ok(instructions.includes(guide), `${reviewer} must link to ${guide}`)
    assert.match(instructions, /check the axis that the brief assigns/i)
  }
})

test('sequential installs preserve foreign hook entries, install the CLI and repair missing owned files', t => {
  const { env, home, prefix, run, install } = fixture(t)
  const config = join(env.CLAUDE_CONFIG_DIR, 'settings.json')
  mkdirSync(env.CLAUDE_CONFIG_DIR)
  const existing = { matcher: 'Read', hooks: [{ type: 'command', command: 'check-read' }] }
  writeFileSync(config, JSON.stringify({ permissions: { deny: ['Read(secret)'] }, hooks: { PreToolUse: [existing] } }))
  const first = install('claude')
  const reviewer = join(env.CLAUDE_CONFIG_DIR, 'agents/ndev-diff-reviewer.md')
  assert.match(readFileSync(reviewer, 'utf8'), /^tools: Read, Grep, Glob, Bash$/m)
  assert.match(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'agents/ndev-plan-scout.md'), 'utf8'), /^  - ndev-work-heavy$/m)
  rmSync(reviewer)
  install('codex')
  install('claude')
  const settings = read(config)
  assert.equal(settings.hooks.PreToolUse.length, 2)
  assert.deepEqual(settings.hooks.PreToolUse[0], existing)
  assert.deepEqual(settings.permissions, { deny: ['Read(secret)'] })
  assert.ok(Object.hasOwn(read(first.manifest).profiles, 'codex'))
  assert.ok(existsSync(reviewer))
  assert.match(readFileSync(join(env.CODEX_HOME, 'agents/ndev-diff-reviewer.toml'), 'utf8'), /^sandbox_mode = "read-only"$/m)
  const bin = join(prefix, 'bin/ndev')
  const version = spawnSync(bin, ['--version'], { cwd: home, env, encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /2\.0\.0/)
  const result = spawnSync(bin, ['install', 'opencode2', '--prefix', prefix, '--json'], { cwd: home, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).result.profiles, ['opencode'])
  const foreign = join(env.XDG_CONFIG_HOME, 'opencode/foreign.txt')
  writeFileSync(foreign, 'untouched')
  assert.equal(run('unknown').status, 2)
  assert.equal(readFileSync(foreign, 'utf8'), 'untouched')
})

test('dry-run reports a foreign asset and installation fails before changing any paths', t => {
  const { env, prefix, run, install } = fixture(t)
  const dir = join(env.CLAUDE_CONFIG_DIR, 'agents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'ndev-plan-scout.md')
  writeFileSync(file, 'my role')
  assert.deepEqual(install('all', '--dry-run').conflicts, [file])
  const result = run('all')
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(file))
  assert.equal(existsSync(prefix), false)
  assert.equal(readFileSync(file, 'utf8'), 'my role')
})

test('a custom profile installs instructions and verifies from its saved manifest', t => {
  const { home, install, run } = fixture(t)
  const profile = join(home, 'profile.json')
  writeFileSync(profile, JSON.stringify({ name: 'local-agent', skillsDir: '~/skills', hooks: 'none' }))
  install('local-agent', '--profile', profile)
  const session = join(home, 'skills/ndev-session/SKILL.md')
  assert.match(readFileSync(session, 'utf8'), /tool denial.*session-end cleanup/)
  assert.equal(install('verify', 'local-agent').verified, true)
  writeFileSync(session, 'changed')
  const broken = run('verify', 'local-agent')
  assert.equal(broken.status, 1)
  assert.ok(broken.stderr.includes(session))
  install('local-agent', '--profile', profile)
  assert.equal(install('verify', 'local-agent').verified, true)
})

test('Orca approval can resume the harness install with the same fingerprint', t => {
  const { env, home, install } = fixture(t)
  const fake = join(home, 'fake')
  mkdirSync(fake)
  const executable = join(fake, 'orca')
  writeFileSync(executable, [
    '#!/usr/bin/env node', 'const args = process.argv.slice(2)',
    'if (args[0] !== "plugin" || args[1] !== "install" || !args.includes("--json")) process.exit(2)',
    'if (args.at(-1) !== "ap1-example") { console.log(JSON.stringify({error:{code:"approval_required",details:{fingerprint:"ap1-example"}}})); process.exit(3) }',
    'console.log(JSON.stringify({ok:true}))',
  ].join('\n'), { mode: 0o755 })
  env.PATH = fake + ':' + env.PATH
  const first = install('claude', '--panels')
  assert.equal(first.panels.status, 'approval-required')
  assert.ok(first.panels.nextAction.includes('ap1-example'))
  assert.ok(existsSync(first.binary))
  const approved = install('claude', '--panels', '--approve', 'ap1-example')
  assert.equal(approved.panels.status, 'installed')
  assert.equal(read(join(env.CLAUDE_CONFIG_DIR, 'settings.json')).hooks.Stop.length, 1)
})

test('native discovery and an opencode v2 model turn exercise the installed pre-tool guard', { skip: process.env.NDEV_TEST_NATIVE_HARNESSES !== '1' && 'Set NDEV_TEST_NATIVE_HARNESSES=1 with Claude, Codex, and opencode v2 installed.' }, async t => {
  const { home, env, install } = fixture(t)
  install('all')
  assert.equal(install('verify', 'all').verified, true)
  const root = join(home, 'repo')
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' })
  mkdirSync(root)
  assert.equal(git('init', '-q').status, 0)
  writeFileSync(join(root, '.neil-dev.issue-17.json'), JSON.stringify({ version: 1, issue: 17, workflow: { issue: 17, root, state: 'developing', branch: 'topic', base: 'main' } }))
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const { tools, messages } = JSON.parse(Buffer.concat(chunks))
    const wantsTool = tools?.some(t => t.function.name === 'shell') && !messages.some(m => m.role === 'tool')
    const call = { index: 0, id: 'case1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'git commit --allow-empty -m verify', description: 'Verify the hook' }) } }
    const delta = wantsTool ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: 'done' }
    const frame = (value, reason) => JSON.stringify({ id: 'case1', model: 'coder', created: 1, object: 'chat.completion.chunk', choices: [{ index: 0, delta: value, finish_reason: reason }] })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${frame(delta, null)}\n\ndata: ${frame({}, wantsTool ? 'tool_calls' : 'stop')}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const provider = { env: ['NDEV_TEST_MODEL'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { coder: { modelID: 'coder' } } }
  writeFileSync(join(env.XDG_CONFIG_HOME, 'opencode/opencode.json'), JSON.stringify({ model: 'fixture/coder', providers: { fixture: provider } }))
  Object.assign(env, { NDEV_TEST_MODEL: 'fixture', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.org', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.org' })
  const { stdout } = await promisify(execFile)('opencode', ['run', '--model', 'fixture/coder', '--standalone', '--auto', '--format', 'json', 'verify hook'], { cwd: root, env, timeout: 45000 })
  const tool = stdout.trim().split('\n').map(row => JSON.parse(row)).find(row => row.type === 'tool_use')
  assert.equal(tool.part.state.status, 'error')
  assert.match(tool.part.state.error, /ndev flow checkpoint/)
  assert.equal(git('rev-parse', '--verify', 'HEAD').status, 128)
})

test('a failed write records the partial install, refuses an unrelated retry, and resumes the original install', t => {
  const { env, home, prefix, run, install } = fixture(t)
  const fault = join(home, 'interrupt.mjs')
  const dest = join(prefix, 'bin/ndev')
  writeFileSync(fault, [
    "import fs from 'node:fs'",
    "import { syncBuiltinESMExports } from 'node:module'",
    'const link = fs.linkSync',
    'fs.linkSync = (source, target) => {',
    `  if (target === ${JSON.stringify(dest)}) throw new Error("interrupted at " + target)`,
    '  return link(source, target)',
    '}',
    'syncBuiltinESMExports()',
  ].join('\n'))
  env.NODE_OPTIONS = '--import=' + new URL('file://' + fault).href
  const failed = run('codex')
  assert.equal(failed.status, 1)
  assert.ok(failed.stderr.includes(dest), failed.stderr)
  const manifest = join(prefix, 'share/ndev/install-manifest.json')
  assert.deepEqual(read(manifest).pending.profiles, ['codex'])
  delete env.NODE_OPTIONS
  assert.equal(run('claude').status, 1)
  install('codex')
  assert.equal(read(manifest).pending, undefined)
  assert.ok(existsSync(dest))
})

test('opencode delivers lifecycle, prompt and post-tool context once to the originating session', async t => {
  const { env, prefix, install, home } = fixture(t)
  install('opencode')
  writeFileSync(join(prefix, 'bin/ndev'), '#!/usr/bin/env node\nconst d=JSON.parse(require("node:fs").readFileSync(0)); console.log(JSON.stringify({additionalContext:process.argv[3]+"/"+d.session_id}))\n')
  const file = join(env.XDG_CONFIG_HOME, 'opencode/plugins/ndev/index.ts')
  const plugin = (await import(file)).default
  const callbacks = new Map()
  const hook = (name, callback) => { callbacks.set(name, callback) }
  let handled
  const created = new Promise(resolve => { handled = resolve })
  const dispose = await plugin.setup({
    location: { directory: home }, session: { hook }, tool: { hook },
    event: { subscribe: async function * () { yield { type: 'session.created', data: { sessionID: 'first' } }; handled() } },
  })
  t.after(dispose)
  await created
  await callbacks.get('prompt')({ sessionID: 'first', prompt: { text: 'hello' } })
  await callbacks.get('execute.after')({ sessionID: 'first', tool: 'bash', input: {}, result: 'ok' })
  const context = async sessionID => {
    const system = []
    await callbacks.get('context')({ sessionID, system })
    return system.map(part => part.text)
  }
  assert.deepEqual(await context('other'), ['session-start/other', 'prompt-context/other'])
  assert.deepEqual(await context('first'), ['session-start/first', 'prompt-submit/first', 'post-tool-use/first', 'prompt-context/first'])
  assert.deepEqual(await context('first'), ['prompt-context/first'])
})


test('reinstall keeps an active skill when an old manifest path aliases the same file', t => {
  const { home, env, install } = fixture(t)
  const first = install('claude')
  const skill = join(env.CLAUDE_CONFIG_DIR, 'skills/ndev-work-light/SKILL.md')
  const oldDirectory = join(env.CLAUDE_CONFIG_DIR, 'skills/ndev-old-profile')
  symlinkSync(join(env.CLAUDE_CONFIG_DIR, 'skills/ndev-work-light'), oldDirectory, 'dir')
  const oldSkill = join(oldDirectory, 'SKILL.md')
  const manifest = read(first.manifest)
  manifest.files[oldSkill] = { ...manifest.files[skill] }
  writeFileSync(first.manifest, JSON.stringify(manifest))
  rmSync(skill)
  const result = install('claude')
  assert.equal(existsSync(skill), true, 'stale alias cleanup must keep the active skill')
  assert.equal(existsSync(oldSkill), true)
  assert.equal(result.removed.includes(oldSkill), false)
  assert.equal(Object.hasOwn(read(first.manifest).files, oldSkill), false)
  assert.match(readFileSync(skill, 'utf8'), /name: ndev-work-light/)
})


test('skill discovery has one entry for each consolidated task in both harnesses', t => {
  const { home, env, install } = fixture(t)
  for (const [profile, skillsDir] of [['claude', join(env.CLAUDE_CONFIG_DIR, 'skills')], ['codex', join(home, '.agents/skills')]]) {
    const { files } = install(profile, '--dry-run')
    for (const name of ['i', 'r', 'for-codex', 'mobile-testing']) {
      assert.ok(!files.includes(join(skillsDir, `ndev-${name}/SKILL.md`)), `${profile} still advertises ndev-${name}`)
    }
    for (const name of ['issue', 'remember', 'responsive-check']) {
      assert.ok(files.includes(join(skillsDir, `ndev-${name}/SKILL.md`)), `${profile} lost ndev-${name}`)
    }
    assert.ok(files.includes(join(skillsDir, 'ndev-responsive-check/scripts/mobile-shots.mjs')))
  }
})

test('reinstall retires owned aliases and mobile capture while preserving unrelated skills', t => {
  const { home, env, run, install } = fixture(t)
  install('claude')
  const { manifest } = install('codex')
  const record = read(manifest)
  const retired = []
  const foreign = []
  for (const [owner, skillsDir] of [['claude', join(env.CLAUDE_CONFIG_DIR, 'skills')], ['codex', join(home, '.agents/skills')]]) {
    for (const name of ['i/SKILL.md', 'r/SKILL.md', 'mobile-testing/SKILL.md', 'mobile-testing/scripts/mobile-shots.mjs', 'for-codex/SKILL.md', 'for-codex/scripts/link.sh']) {
      const path = join(skillsDir, `ndev-${name}`)
      const text = `old ${name} skill\n`
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text, { mode: 0o644 })
      record.files[path] = { owner, mode: 0o644, sha256: createHash('sha256').update(text).digest('hex') }
      retired.push(path)
    }
    const path = join(skillsDir, 'my-skill/SKILL.md')
    mkdirSync(join(skillsDir, 'my-skill'))
    writeFileSync(path, 'user skill')
    foreign.push(path)
  }
  writeFileSync(manifest, JSON.stringify(record))
  const changed = retired[0]
  const original = readFileSync(changed, 'utf8')
  writeFileSync(changed, 'local edit')
  const refusal = run('claude')
  assert.notEqual(refusal.status, 0)
  assert.ok(refusal.stderr.includes(changed), refusal.stderr)
  assert.equal(readFileSync(changed, 'utf8'), 'local edit')
  assert.deepEqual(read(manifest), record)
  writeFileSync(changed, original)
  install('claude')
  install('codex')
  for (const path of retired) assert.equal(existsSync(path), false, path)
  for (const path of foreign) assert.equal(readFileSync(path, 'utf8'), 'user skill')
  for (const path of retired) assert.equal(read(manifest).files[path], undefined)
})
