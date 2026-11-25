import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ndev = fileURLToPath(new URL('../bin/ndev', import.meta.url))

function fixture(t, reply) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-github-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status, 0)
  const gh = join(root, 'gh.sh')
  writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$@" > "${root}/gh.args"
${reply}
`)
  chmodSync(gh, 0o755)
  return { root, gh, args: () => readFileSync(join(root, 'gh.args'), 'utf8').trim().split('\n'), called: () => existsSync(join(root, 'gh.args')) }
}

function github(f, args, { json = true } = {}) {
  const result = spawnSync(ndev, ['github', ...(json ? ['--json'] : []), ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, NDEV_FLOW_GH: f.gh } })
  assert.ifError(result.error)
  return { ...result, json: json && result.stdout ? JSON.parse(result.stdout) : undefined }
}

test('github label runs gh.sh label with the same arguments and returns its JSON lines', t => {
  const f = fixture(t, `echo '{"number":12,"label":"bug"}'`)
  const result = github(f, ['label', '12', 'bug'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(f.args(), ['label', '12', 'bug'])
  assert.deepEqual(result.json.result.lines, [{ number: 12, label: 'bug' }])
})

test('github passes each agent-facing command and its arguments through unchanged', t => {
  const calls = [
    ['subissues', 'link', '5', '6', '7'],
    ['blocked-by', 'add', '5', '9'],
    ['board', 'move', 'PVTI_x', 'In progress'],
    ['pr-edit', '8', '--title', 'New title', '--body-file', 'body.md'],
    ['issue-edit', '8', '--body-file', 'body.md'],
    ['pr-ready', '8'],
    ['issue-read', '219'],
    ['labelled', 'incomprehensible'],
    ['unlabel', '8', 'incomprehensible'],
    ['feedback', '5', '8'],
    ['view-json', 'pr', '8', '--fields', 'headRefName'],
    ['comment', '7', '--body', 'Carried by #9'],
    ['board', 'ready'],
    ['board', 'awaiting'],
  ]
  for (const call of calls) {
    const f = fixture(t, `echo '{}'`)
    const result = github(f, call)
    assert.equal(result.status, 0, `${call.join(' ')}: ${result.stdout || result.stderr}`)
    assert.deepEqual(f.args(), call)
  }
})

test('github prints the gh.sh output as it is without --json, and keeps lines that are not JSON', t => {
  const f = fixture(t, `printf '%s\\n' 'diff --git a/x b/x' '{"n":1}'; echo 'gh.sh: answered by REST' >&2`)
  const text = github(f, ['pr-diff', '8'], { json: false })
  assert.equal(text.status, 0, text.stderr)
  assert.equal(text.stdout, 'diff --git a/x b/x\n{"n":1}\n')
  assert.match(text.stderr, /answered by REST/)
  const result = github(f, ['pr-diff', '8'])
  assert.deepEqual(result.json.result.lines, ['diff --git a/x b/x', { n: 1 }])
})

test('github refuses a command that agents do not run before any GitHub call', t => {
  const f = fixture(t, 'exit 9')
  const result = github(f, ['pr-merge', '8', '--method', 'merge'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.match(result.json.error.message, /Unknown github command "pr-merge"/)
  assert.equal(result.json.error.repair, 'ndev github --help')
  assert.equal(f.called(), false)
})

test('github refuses a command with a missing argument before any GitHub call, with the help repair', t => {
  for (const call of [['board', 'move'], ['board', 'set', 'PVTI_x', 'Size'], ['feedback', '5'], ['subissues', 'link', '5'], ['blocked-by', 'list'], ['label', '8'], ['issue-read'], ['view-json'], ['comment', '7'], ['comment', '7', '--body'], ['dump', 'issue']]) {
    const f = fixture(t, 'exit 9')
    const result = github(f, call)
    assert.equal(result.status, 2, `${call.join(' ')}: ${result.stdout || result.stderr}`)
    assert.match(result.json.error.message, new RegExp(`^ndev github ${call[0]} .*needs`))
    assert.equal(result.json.error.repair, `ndev github ${call[0]} --help`)
    assert.equal(f.called(), false, call.join(' '))
  }
})

test('github refuses an unknown subcommand of subissues, blocked-by or board before any GitHub call', t => {
  const f = fixture(t, 'exit 9')
  const result = github(f, ['board', 'remove', 'PVTI_x'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.match(result.json.error.message, /ndev github board has no subcommand "remove"/)
  assert.equal(result.json.error.repair, 'ndev github board --help')
  assert.equal(f.called(), false)
})

test('github keeps the repair that gh.sh names when it refuses for a missing setting', t => {
  const f = fixture(t, `echo 'gh.sh: board commands need GH_PROJECT_OWNER and GH_PROJECT_NUMBER. Repair: run /dev-setup in Claude Code' >&2; exit 2`)
  const result = github(f, ['board', 'items'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.match(result.json.error.message, /gh\.sh board items exited 2: .*Repair: run \/dev-setup/)
  assert.equal(result.json.error.repair, undefined)
})

test('github gives the help repair when gh.sh prints its usage', t => {
  const f = fixture(t, `echo 'gh.sh: usage: gh.sh pr-list [--head <branch>] [--state open|closed|all] [--limit <n>]' >&2; exit 2`)
  const result = github(f, ['pr-list', '--sort', 'x'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.equal(result.json.error.repair, 'ndev github pr-list --help')
})

test('github reports a gh.sh failure with the command, exit code and output', t => {
  const f = fixture(t, `echo 'HTTP 502' >&2; exit 1`)
  const result = github(f, ['subissues', 'link', '5', '6'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /gh\.sh subissues link 5 6 exited 1: HTTP 502/)
  assert.equal(result.json.error.details.exitCode, 1)
})

test('github reports a refused body as nothing posted, with the fix', t => {
  const f = fixture(t, `echo "gh.sh: refusing to post: prose check failed" >&2; exit 3`)
  const result = github(f, ['pr-edit', '8', '--body-file', 'body.md'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /exited 3: gh\.sh: refusing to post: prose check failed/)
  assert.match(result.json.error.repair, /Nothing was posted\. Fix what the message names, then run ndev github pr-edit again\./)
})

test('github --help lists the agent-facing commands', t => {
  const f = fixture(t, 'exit 9')
  const result = github(f, ['--help'], { json: false })
  assert.equal(result.status, 0, result.stderr)
  for (const command of ['pr-ready <pr>', 'issue-read <issue>', 'subissues link <parent> <child>...', 'board ready | awaiting | items [<column>]', 'labelled <label>', 'unpushed', 'comment <issue-or-pr> --body <text>', 'dump issue|pr <n>', 'merge-main [--dry-run]']) {
    assert.match(result.stdout, new RegExp(`ndev github ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

function stubbed(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ndev-github-stub-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '))
  git('init', '-q', '--bare', '-b', 'main', 'origin.git')
  git('init', '-q', '-b', 'main', 'work')
  const work = join(root, 'work')
  const inWork = (...args) => assert.equal(spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' }).status, 0, args.join(' '))
  inWork('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'start')
  inWork('remote', 'add', 'origin', join(root, 'origin.git'))
  inWork('push', '-q', 'origin', 'main')
  const card = (id, number, status) => ({ id, content: { number, title: `Card ${number}`, url: `https://github.com/o/r/issues/${number}`, author: { login: 'me' } }, status: { name: status } })
  writeFileSync(join(root, 'items.json'), JSON.stringify({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [card('PVTI_a', 1, 'Ready'), card('PVTI_b', 2, 'Awaiting Feedback'), card('PVTI_c', 3, 'Done')] } } } }))
  writeFileSync(join(root, 'fields.json'), JSON.stringify({ data: { node: { fields: { nodes: [{ id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'O_ready', name: 'Ready' }, { id: 'O_progress', name: 'In progress' }, { id: 'O_doing', name: 'Doing' }] }] } } } }))
  writeFileSync(join(root, 'issue.json'), JSON.stringify({ number: 5, title: 'Fix the thing', state: 'OPEN', author: { login: 'me' }, assignees: [], labels: [], milestone: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', url: 'https://github.com/o/r/issues/5', body: 'The thing is broken.', comments: [] }))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gh'), `#!/bin/bash
printf '%s\n' "$*" >> "${root}/gh.log"
case "$1 $2" in
  "project view") echo PVT_1 ;;
  "project item-edit") echo '{}' ;;
  "api graphql") case "$*" in *"items(first"*) cat "${root}/items.json" ;; *) cat "${root}/fields.json" ;; esac ;;
  "issue view") cat "${root}/issue.json" ;;
  "auth token") echo '' ;;
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "pr list") echo '[]' ;;
  *) echo "stub gh: no answer for $*" >&2; exit 9 ;;
esac
`)
  chmodSync(join(root, 'bin/gh'), 0o755)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NDEV_FLOW_GH|GH_CACHE_TTL|GH_PROJECT_|WORK_READY_COL_|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)))
  Object.assign(env, { PATH: `${join(root, 'bin')}:${process.env.PATH}`, GH_REPO: 'o/r', GH_PROJECT_OWNER: 'o', GH_PROJECT_NUMBER: '1', NDEV_GH_CACHE_DIR: join(root, 'cache') })
  const ndevIn = (args, extra = {}) => {
    const result = spawnSync(ndev, ['github', '--json', ...args], { cwd: work, encoding: 'utf8', env: { ...env, ...extra } })
    assert.ifError(result.error)
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined }
  }
  const log = () => existsSync(join(root, 'gh.log')) ? readFileSync(join(root, 'gh.log'), 'utf8') : ''
  return { root, work, ndev: ndevIn, log }
}

test('github board ready and awaiting list the cards of those columns', t => {
  const s = stubbed(t)
  const ready = s.ndev(['board', 'ready'])
  assert.equal(ready.status, 0, ready.stdout || ready.stderr)
  assert.deepEqual(ready.json.result.lines.map(card => card.number), [1])
  const awaiting = s.ndev(['board', 'awaiting'])
  assert.equal(awaiting.status, 0, awaiting.stdout || awaiting.stderr)
  assert.deepEqual(awaiting.json.result.lines.map(card => card.number), [2])
})

test('github board move takes a status keyword, a renamed column or an exact column name', t => {
  const s = stubbed(t)
  for (const [status, extra, option] of [['progress', {}, 'O_progress'], ['progress', { WORK_READY_COL_PROGRESS: 'Doing' }, 'O_doing'], ['In progress', {}, 'O_progress']]) {
    const result = s.ndev(['board', 'move', 'PVTI_a', status], extra)
    assert.equal(result.status, 0, result.stdout || result.stderr)
    assert.match(s.log().trim().split('\n').at(-1), new RegExp(`^project item-edit --id PVTI_a --project-id PVT_1 --field-id F_status --single-select-option-id ${option}$`))
  }
})

test('github dump writes the issue to one markdown file and prints its path', t => {
  const s = stubbed(t)
  const out = join(s.root, 'out')
  const result = s.ndev(['dump', 'issue', '5', '--out', out])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.equal(result.json.result.lines[0], `MARKDOWN: ${join(out, 'issue-5.md')}`)
  const markdown = readFileSync(join(out, 'issue-5.md'), 'utf8')
  assert.match(markdown, /^# Issue #5: Fix the thing/)
  assert.match(markdown, /The thing is broken\./)
})

test('github dump reports a refused kind with the help repair', t => {
  const s = stubbed(t)
  const result = s.ndev(['dump', 'commit', '5'])
  assert.equal(result.status, 2, result.stdout || result.stderr)
  assert.match(result.json.error.message, /^dump\.py commit 5 exited 2: .*invalid choice: 'commit'/s)
  assert.equal(result.json.error.repair, 'ndev github dump --help')
})

test('github merge-main lists the open PRs that need the base branch', t => {
  const s = stubbed(t)
  const result = s.ndev(['merge-main', '--dry-run'])
  assert.equal(result.status, 0, result.stdout || result.stderr)
  assert.deepEqual(result.json.result.lines, ['Processed 0 open PRs.'])
  assert.match(s.log(), /^pr list --repo o\/r --state open/m)
})

test('github merge-main reports a stopped batch with the command, exit code and output', t => {
  const s = stubbed(t)
  const result = s.ndev(['merge-main', '--dry-run', '--pr', '9'])
  assert.equal(result.status, 1, result.stdout || result.stderr)
  assert.match(result.json.error.message, /^merge-main-into-open-prs\.sh --dry-run --pr 9 exited 1: .*Requested PRs are not open: \[9\]/s)
  assert.equal(result.json.error.details.exitCode, 1)
})

const byPath = /\bgh\.sh\s+[a-z][a-z-]*|scripts\/github\/gh\.sh|\bboard\.sh\b|\bdump\.py\b|merge-main-into-open-prs\.sh|\bgh issue comment\b/

function prose(dir) {
  const out = spawnSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'ls-files', '-z', '--', `${dir}/*.md`], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.split('\0').filter(Boolean)
}

test('no skill or agent tells an agent to run gh.sh, board.sh, dump.py, merge-main-into-open-prs.sh or gh issue comment by path', () => {
  assert.match('Run `gh.sh labelled incomprehensible`.', byPath)
  assert.match('"${CLAUDE_PLUGIN_ROOT}/scripts/github/gh.sh" pr-rows', byPath)
  assert.doesNotMatch('Use `ndev github labelled incomprehensible`.', byPath)
  for (const line of ['`${CLAUDE_PLUGIN_ROOT}/scripts/board/board.sh ready`', '`board.sh move <itemId> progress`', '`dump.py pr <n> [--out DIR]`', 'merge-main-into-open-prs.sh [--dry-run]', "`gh issue comment <child> --body 'Carried by #<pr>'`"]) assert.match(line, byPath)
  for (const line of ['`ndev github board ready`', '`ndev github dump pr <n>`', 'ndev github merge-main --dry-run', "`ndev github comment <child> --body 'Carried by #<pr>'`"]) assert.doesNotMatch(line, byPath)
  const files = [...prose('skills'), ...prose('agents')]
  assert.ok(files.length > 100, `only ${files.length} skill and agent files were read`)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const found = files.flatMap(file => readFileSync(join(root, file), 'utf8').split('\n').flatMap((line, i) => byPath.test(line) ? [`${file}:${i + 1}: ${line.trim().slice(0, 160)}`] : []))
  assert.deepEqual(found, [], `Run these with ndev github instead:\n${found.join('\n')}`)
})

async function workReadyPrompts() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = readFileSync(join(root, 'skills/work-heavy-auto/scripts/work_ready_workflow.js'), 'utf8').replace(/^export const meta/m, 'const meta')
  const run = new (async () => {}).constructor('args', 'agent', 'parallel', 'phase', 'log', 'console', source)
  const pr = (number, state, extra = {}) => ({ number, title: `Card ${number}`, itemId: `PVTI_${number}`, pr: { number: 100 + number, url: `https://github.com/o/r/pull/${100 + number}`, state, branch: `claude/issue-${number}` }, newFeedback: [], ...extra })
  const replies = {
    'feedback-scan': { items: [pr(1, 'MERGED'), pr(2, 'OPEN', { newFeedback: [{ id: 7, surface: 'pr', body: 'Rename it' }] }), pr(3, 'OPEN', { state: null }), pr(4, 'OPEN', { state: { next: 'waiting-human' }, smoke: { reviewedAt: null, stale: true } })] },
    survey: { empty: false, items: [{ number: 10, title: 'Card 10', itemId: 'PVTI_10', parent: 9, dependsOn: [11], startable: true, issueModel: 'sonnet', issueEffort: 'high' }] },
    'ready-roster': { numbers: [10] },
    'peer-activity': { items: [1, 2, 3, 4, 10].map(number => ({ number, exitCode: 0 })) },
  }
  const prompts = []
  const agent = async (prompt, { label }) => {
    prompts.push({ label, prompt })
    return replies[label] ?? null
  }
  const parallel = thunks => Promise.all(thunks.map(thunk => thunk()))
  const quiet = { info() {}, debug() {}, log() {} }
  await run({ repoDir: '/repo', skillDir: join(root, 'skills/work-heavy-auto'), repoSlug: 'o/r', commitTrailer: 'Co-Authored-By: T <t@example.com>', previewCheck: 'preview' }, agent, parallel, () => {}, () => {}, quiet)
  return prompts
}

test('no prompt of the work-heavy-auto workflow tells an agent to run gh.sh or board.sh by path', async () => {
  const prompts = await workReadyPrompts()
  const labels = prompts.map(p => p.label)
  for (const label of ['feedback-scan', 'survey', 'ready-roster', 'peer-activity', 'record-blocks', 'close #1', 'revise #2', 'resume #3', 'smoke #4', 'start #10']) assert.ok(labels.includes(label), `the workflow sent no ${label} prompt; it sent ${labels.join(', ')}`)
  const found = prompts.flatMap(({ label, prompt }) => prompt.split('\n').flatMap(line => byPath.test(line) ? [`${label}: ${line.trim().slice(0, 160)}`] : []))
  assert.deepEqual(found, [], `Name ndev github in these prompts instead:\n${found.join('\n')}`)
})

test('every ndev github command the hooks name as a repair is one ndev github accepts', t => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', 'hooks/*.ts', 'hooks/*.tsx'], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const repairs = listed.stdout.split('\0').filter(Boolean).flatMap(file => readFileSync(join(root, file), 'utf8').split('\n').flatMap((line, i) =>
    [...line.matchAll(/Repair: (?:run )?ndev github ((?:\$\{[^}]*\}|[^.`\n$])+)/g)].map(m => ({ where: `${file}:${i + 1}`, line, args: m[1].trim().replace(/\$\{[^}]*\}/g, '7').split(/\s+/) }))))
  assert.ok(repairs.some(r => r.line.includes('has no card on the board')), 'the missing-card repair in hooks/workflow/tools.ts names no ndev github command')
  for (const { where, args } of repairs) {
    const f = fixture(t, `echo '{}'`)
    const result = github(f, args)
    assert.equal(result.status, 0, `${where}: ndev github ${args.join(' ')}: ${result.stdout || result.stderr}`)
    assert.deepEqual(f.args(), args, where)
  }
})
