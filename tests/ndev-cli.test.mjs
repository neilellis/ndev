import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function run(args, cwd = tmpdir()) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function worktree(t) {
  const root = mkdtempSync(join(tmpdir(), 'ndev-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('help and version work outside a Git repository', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev <group> <command>/)
  assert.match(help.stdout, /\binstall\b/)
  const command = run(['flow', 'checkpoint', '--help'])
  assert.equal(command.status, 0, command.stderr)
  assert.match(command.stdout, /ndev flow checkpoint .*--file/)
  const repair = run(['flow', 'repair', '--help'])
  assert.equal(repair.status, 0, repair.stderr)
  assert.match(repair.stdout, /ndev flow repair --issue <n> --pr <n>/)
  const version = run(['--version', '--json'])
  assert.equal(version.status, 0, version.stderr)
  assert.deepEqual(JSON.parse(version.stdout), { ok: true, result: { version: '2.0.0' } })
})

test('an unknown command returns one JSON error with the repair', () => {
  const result = run(['--json', 'flow', 'made-up'])
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  const { ok, error } = JSON.parse(result.stdout)
  assert.equal(ok, false)
  assert.match(error.message, /made-up/)
  assert.equal(error.repair, 'ndev flow --help')
})

test('project setup preserves existing settings and returns persisted values', t => {
  const root = worktree(t)
  const path = join(root, '.ndev.json')
  writeFileSync(path, '{"branding":{"name":"Example","site":"https://example.com"}}\n')
  const result = run(['project', 'setup', '--repo', 'owner/example', '--no-board', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const { result: settings } = JSON.parse(result.stdout)
  assert.deepEqual(settings.github, { repo: 'owner/example', board: null })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    branding: { name: 'Example', site: 'https://example.com' }, github: { repo: 'owner/example', board: null },
  })
})

test('project setup asks the owner for a root North Star when the file is missing', t => {
  const root = realpathSync(worktree(t))
  const path = join(root, 'NORTH_STAR.md')
  const nested = join(root, 'src')
  mkdirSync(nested)
  writeFileSync(join(nested, 'NORTH_STAR.md'), '# Notes for this package\n')

  const before = run(['project', 'status', '--json'], nested)
  assert.equal(before.status, 0, before.stderr)
  const { result: status } = JSON.parse(before.stdout)
  assert.deepEqual(status.northStar, { path, exists: false })
  assert.doesNotMatch(status.text, /ask the project owner/i)
  const setup = run(['project', 'setup', '--no-repo'], nested)
  assert.equal(setup.status, 0, setup.stderr)
  assert.ok(setup.stdout.includes(path))
  assert.match(setup.stdout, /ask the project owner to create/i)
  assert.equal(existsSync(path), false)

  mkdirSync(path)
  const occupied = run(['project', 'setup'], nested)
  assert.equal(occupied.status, 0, occupied.stderr)
  assert.match(occupied.stdout, /ask the project owner to replace it with a regular file/i)
  rmSync(path, { recursive: true })

  const original = '# North Star\n\nKeep decisions traceable to evidence.\n'
  writeFileSync(path, original)
  const after = run(['project', 'setup', '--json'], nested)
  assert.equal(after.status, 0, after.stderr)
  const { result } = JSON.parse(after.stdout)
  assert.deepEqual(result.northStar, { path, exists: true })
  assert.doesNotMatch(result.text, /ask the project owner to create|Keep decisions traceable/)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('setting auto in hack mode fails before saving the configuration', t => {
  const root = worktree(t)
  const path = join(root, '.ndev.json')
  const original = '{"mode":"hack","steering":"interactive"}\n'
  writeFileSync(path, original)
  const result = run(['project', 'steering', 'auto', '--json'], root)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(JSON.parse(result.stdout).error.message, /hack mode.*interactive/i)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('project mode toggles light and heavy, sets hack by name and refuses hack in auto', t => {
  const root = worktree(t)
  const path = join(root, '.ndev.json')
  const mode = (...args) => {
    const result = run(['project', 'mode', ...args, '--json'], root)
    return { status: result.status, body: JSON.parse(result.stdout) }
  }
  const saved = () => JSON.parse(readFileSync(path, 'utf8')).mode
  assert.equal(mode().body.result.mode, 'heavy')
  assert.equal(saved(), 'heavy')
  assert.equal(mode().body.result.mode, 'light')
  assert.equal(saved(), 'light')
  assert.equal(mode('hack').body.result.mode, 'hack')
  assert.equal(saved(), 'hack')
  assert.equal(mode().body.result.mode, 'light')
  const unknown = mode('fast')
  assert.equal(unknown.status, 2)
  assert.match(unknown.body.error.message, /Unknown mode "fast"\. Use light, heavy, hack/)
  const original = '{"mode":"heavy","steering":"auto"}\n'
  writeFileSync(path, original)
  const refused = mode('hack')
  assert.equal(refused.status, 1)
  assert.match(refused.body.error.message, /Hack mode is interactive only/)
  assert.equal(refused.body.error.repair, 'Run ndev project steering interactive.')
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('project status shows the settings and names the setup command while values are absent', t => {
  const root = worktree(t)
  const absent = JSON.parse(run(['project', 'status', '--json'], root).stdout).result
  assert.deepEqual(absent.missing, ['repo', 'board'])
  assert.match(absent.text, /^dev: light · interactive$/m)
  assert.match(absent.text, /Run ndev project setup to set repo and board\./)
  assert.equal(run(['project', 'setup', '--repo', 'owner/example', '--board', 'owner/3'], root).status, 0)
  const set = JSON.parse(run(['project', 'status', '--json'], root).stdout).result
  assert.deepEqual(set.missing, [])
  assert.match(set.text, /GitHub: owner\/example\./)
  assert.doesNotMatch(set.text, /ndev project setup/)
})

test('help shows the project commands that replace the dev slash aliases, and the flow target flags', () => {
  const project = run(['project', '--help'])
  assert.equal(project.status, 0, project.stderr)
  assert.match(project.stdout, /^ {2}ndev project mode \[light\|heavy\|hack\]$/m)
  assert.match(project.stdout, /^ {2}ndev project steering \[interactive\|auto\]$/m)
  assert.match(project.stdout, /^ {2}ndev project setup /m)
  const flow = run(['flow', '--help'])
  assert.equal(flow.status, 0, flow.stderr)
  for (const command of ['status', 'start', 'checkpoint', 'finished-development', 'unblock', 'goto']) assert.match(flow.stdout, new RegExp(`^  ndev flow ${command}\\b`, 'm'))
  assert.match(flow.stdout, /^ {2}ndev flow status \[--issue <n>\|--pr <n>\]$/m)
  assert.match(flow.stdout, /accept --issue <n> or --pr <n> to select the workflow/)
})

test('guidance returns project files and the bundled catalogue for a library choice', t => {
  const root = worktree(t)
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"existing-example":"1.2.3"}}')
  const result = run(['project', 'guidance', 'library', 'Parse a request body', '--json'], root)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const guidance = JSON.parse(result.stdout).result
  assert.equal(guidance.kind, 'library')
  assert.equal(guidance.description, 'Parse a request body')
  assert.ok(guidance.sources.some(source => source.endsWith('kb/libraries.md')))
  assert.ok(guidance.sources.some(source => source.endsWith('package.json')))
})

test('guidance names the sources of each kind, refuses a missing brand, and names an invalid kind', t => {
  const root = worktree(t)
  const ask = kind => {
    const result = run(['project', 'guidance', kind, 'A need', '--json'], root)
    return { status: result.status, body: JSON.parse(result.stdout) }
  }
  const noBrand = ask('brand-style')
  assert.equal(noBrand.status, 1)
  assert.match(noBrand.body.error.message, /has no branding sources/)
  assert.match(noBrand.body.error.repair, /branding\.site in \.ndev\.json/)
  writeFileSync(join(root, '.ndev.json'), '{"branding":{"name":"Example","site":"https://brand.example.test"}}\n')
  const expected = {
    'react-component': ['kb/ui-components.md', 'https://brand.example.test'],
    library: ['kb/libraries.md'],
    'brand-style': ['https://brand.example.test'],
    animation: ['skills/motion/SKILL.md', 'skills/motion/references/delight.md', 'https://brand.example.test'],
  }
  for (const [kind, ends] of Object.entries(expected)) {
    const { status, body } = ask(kind)
    assert.equal(status, 0, JSON.stringify(body))
    assert.equal(body.result.kind, kind)
    assert.deepEqual(body.result.sources.map(source => ends.find(end => source.endsWith(end))), ends, `${kind}: ${body.result.sources}`)
    for (const source of body.result.sources.filter(source => !source.startsWith('https:'))) assert.ok(existsSync(source), `${kind} names a missing source ${source}`)
  }
  const invalid = ask('nonsense')
  assert.equal(invalid.status, 2)
  assert.match(invalid.body.error.message, /"nonsense" is not a kind\. The kinds are react-component, library, brand-style, animation\./)
})

test('draft push reaches the workflow handler through the public CLI', t => {
  const help = run(['flow', 'push-draft', '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev flow push-draft .*--sha .*--review/)
  const command = run(['flow', 'push-draft', '--issue', '79', '--json'], worktree(t))
  assert.equal(command.status, 2, command.stdout)
  const { error } = JSON.parse(command.stdout)
  assert.match(error.message, /issue #79 has no workflow/)
})

test('requirements commands run through ndev requirements', t => {
  const root = worktree(t)
  const help = run(['requirements', '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ndev requirements check \[<REQ-NNNN>\.\.\. \| --base <git ref>\]\n/)
  assert.match(help.stdout, /ndev requirements related <REQ-NNNN>\.\.\. \| --base <git ref>\n/)
  assert.match(help.stdout, /ndev requirements index\n/)
  assert.match(help.stdout, /ndev requirements retire <path>\.\.\. --pdr <file> \[--keep <file>,<file>\]/)
  const empty = run(['requirements', 'list', '--root', root])
  assert.equal(empty.status, 0, empty.stderr)
  const usage = run(['requirements', 'quote', '--root', root])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /^ndev: quote needs <path> <first line> <last line>/)
  const unknown = run(['requirements', 'nonsense'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown requirements command "nonsense"/)
})

test('requirements arguments after -- reach the command unchanged, and --json wraps the output', t => {
  const root = worktree(t)
  writeFileSync(join(root, 'guide.md'), 'One\nTwo\n')
  const ledger = run(['requirements', 'ledger', '--root', root, '--', 'guide.md', '1', '2', '--help'])
  assert.equal(ledger.status, 0, ledger.stderr)
  assert.match(readFileSync(join(root, 'docs/formal/requirements/extra/ledger.md'), 'utf8'), /- guide\.md#L1-L2 [0-9a-f]{12}: --help\n/)
  const json = run(['requirements', 'quote', 'guide.md', '1', '1', '--root', root, '--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, result: { text: '- guide.md#L1-L1\n\n> One\n' } })
})

function faultReporter(t) {
  const root = worktree(t)
  const outside = mkdtempSync(join(tmpdir(), 'ndev-fault-gh-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...identity } })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('switch', '-q', '-c', 'main')
  writeFileSync(join(root, 'README.md'), 'project\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'Base')
  const calls = join(outside, 'calls')
  const bodies = join(outside, 'bodies')
  mkdirSync(join(outside, 'bin'))
  writeFileSync(join(outside, 'bin/gh'), `#!/bin/sh
echo "$*" >> '${calls}'
n=$(wc -l < '${calls}' | tr -d ' ')
while [ "$#" -gt 0 ]; do [ "$1" = --body-file ] && cat "$2" >> '${bodies}'; shift; done
echo "https://github.com/neilellis/ndev/issues/$n"
`, { mode: 0o755 })
  const env = { ...process.env, HOME: join(outside, 'home'), XDG_STATE_HOME: join(outside, 'state'), PATH: `${join(outside, 'bin')}:${process.env.PATH}` }
  const report = (title, details) => spawnSync(executable, ['project', 'report-workflow-bug', '--title', title, '--details', details, '--json'], { cwd: root, env, encoding: 'utf8' })
  const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  return { git, report, calls: () => read(calls).split('\n').filter(Boolean), bodies: () => read(bodies) }
}

test('report-workflow-bug sends the reproduction to the ndev maintainers, deduplicates a repeated fault and limits the rate', t => {
  const f = faultReporter(t)
  const first = f.report('done refuses a clean tree', 'ndev flow done said the tree is dirty; git status is clean.')
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(JSON.parse(first.stdout).result.url, 'https://github.com/neilellis/ndev/issues/1')
  assert.match(f.calls()[0], /^issue create -R neilellis\/ndev --title done refuses a clean tree --body-file /)
  assert.equal(f.bodies(), 'ndev flow done said the tree is dirty; git status is clean.\n')
  const again = JSON.parse(f.report('Done refuses  a clean TREE', 'Seen again.').stdout).result
  assert.deepEqual([again.duplicate, again.url], [true, 'https://github.com/neilellis/ndev/issues/1'])
  for (const n of [2, 3, 4, 5]) assert.equal(f.report(`fault ${n}`, 'details').status, 0)
  const limited = f.report('fault 6', 'details')
  assert.equal(limited.status, 1, limited.stdout)
  assert.match(JSON.parse(limited.stdout).error.message, /Five ndev faults were reported in the past hour/)
  assert.equal(f.calls().length, 5)
})

test('a fault report leaves the default branch of the project untouched', t => {
  const f = faultReporter(t)
  const head = f.git('rev-parse', 'HEAD')
  const result = f.report('status crashed', 'ndev flow status threw a TypeError.')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.git('branch', '--show-current'), 'main')
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.git('log', '--oneline').split('\n').length, 1)
  assert.match(f.calls()[0], /-R neilellis\/ndev /)
})
