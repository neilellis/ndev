import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BEFORE_REVIEW, MACHINES, MERGEABLE_BEFORE_DONE, afterSkip, afterStarted, afterTool, baseCheckScript, hooksFiredBy, mayMerge, maySkipReview, needsSmoke, nextStep } from './workflow/machine.ts'
import { CHANGE_TYPES, inferChangeTypes, isDocsOnly, isWebPath, requiredSmokeTypes, reviewerBrief } from './workflow/change-types.ts'

class Fail extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE = JSON.parse(readFileSync(join(HERE, 'profile.json'), 'utf8'))
const HOME: string = PROFILE.home
const FLOW = `${HOME}/bin/ndev-flow`
const CHECK_DIR = 'scripts/ndev/workflow'
const CHECKS = ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh']
const CHECK_MAX_MS = 20 * 60_000
const WAIT_PR = `${HOME}/scripts/github/wait-for-pr-change.sh`
const WAIT_PID = `${HOME}/scripts/work/wait_for_process_end.sh`
const now = () => Date.now()
const OWNER_LIVE_MS = 10 * 60_000
const GOTO = ['setup', 'interviewing', 'planning', 'developing', 'hardening', 'reviewing', 'ci', 'smoke', 'finishing', 'revising', 'done']
const MARK = '<!-- ndev-flow -->'
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

type Run = { status: number; stdout: string; stderr: string }
function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeout?: number } = {}): Run {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: 'utf8', timeout: opts.timeout, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { status: 127, stdout: '', stderr: `${cmd} did not run: ${r.error.message}` }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const said = (r: Run) => (r.stderr.trim() || r.stdout.trim() || 'no output').split('\n').slice(-20).join('\n')

type Args = Record<string, string>
function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!
    if (!flag.startsWith('--')) throw new Fail(2, `ndev-flow: "${flag}" is not a flag. Flags have the form --name value. Repair: run ndev-flow help.`)
    const value = argv[i + 1]
    if (value === undefined) throw new Fail(2, `ndev-flow: ${flag} needs a value. Repair: run ndev-flow help.`)
    out[flag.slice(2)] = value
    i += 1
  }
  return out
}
const need = (args: Args, name: string) => {
  const value = args[name]?.trim()
  if (!value) throw new Fail(2, `ndev-flow: --${name} is required here. Repair: run ndev-flow help.`)
  return value
}
const list = (value?: string) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean)

const cwd = process.cwd()
function topLevel(): string {
  const r = run('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (r.status !== 0) throw new Fail(2, `ndev-flow: ${cwd} is not in a git worktree (git rev-parse exited ${r.status}: ${said(r)}). Repair: run ndev-flow inside the worktree of the issue.`)
  return r.stdout.trim()
}
const git = (root: string, ...args: string[]) => run('git', args, { cwd: root })
function gitOk(root: string, ...args: string[]): string {
  const r = git(root, ...args)
  if (r.status !== 0) throw new Fail(1, `git ${args.join(' ')} exited ${r.status} in ${root}: ${said(r)}`)
  return r.stdout.trim()
}
const gitDir = (root: string) => gitOk(root, 'rev-parse', '--path-format=absolute', '--git-dir')
const headSha = (root: string) => gitOk(root, 'rev-parse', 'HEAD')

type Config = { mode?: string; steering?: string; projectLevel?: string; workflow?: boolean; github?: { repo?: string } }
function readConfig(root: string): Config {
  const file = join(root, '.neil-dev.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Fail(1, `ndev-flow: ${file} is not valid JSON (${(error as Error).message}). Repair: fix the file.`)
  }
}

type Workflow = Record<string, any> & { issue: number; root: string; repo: string; base: string; branch: string; prs: number[]; state: string; previous?: string; mode: string; steering: string; history: { at: number; tool: string; from: string; to: string }[]; rev?: number }

const issueFile = (root: string, n: number) => join(root, `.neil-dev.issue-${n}.json`)
function readRecord(root: string, n: number): Workflow | undefined {
  const file = issueFile(root, n)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')).workflow
  } catch (error) {
    throw new Fail(1, `ndev-flow: ${file} is not valid JSON (${(error as Error).message}). Repair: fix the file, or move it away and run ndev-flow started again.`)
  }
}
function findIssue(root: string, args: Args): number {
  if (args.issue) {
    const n = Number(args.issue)
    if (!Number.isInteger(n) || n <= 0) throw new Fail(2, `ndev-flow: --issue "${args.issue}" is not an issue number.`)
    return n
  }
  const held = readdirSync(root).map(name => /^\.neil-dev\.issue-(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => !!n).map(Number).filter(n => readRecord(root, n))
  if (held.length === 1) return held[0]!
  if (!held.length) throw new Fail(2, `ndev-flow: no workflow in ${root}. Repair: run ndev-flow started --issue <n> --short-name <two-to-five-words>.`)
  throw new Fail(2, `ndev-flow: ${root} holds the workflows of issues ${held.map(n => `#${n}`).join(', ')}. Repair: add --issue <n>.`)
}
function load(root: string, args: Args): Workflow {
  const n = findIssue(root, args)
  const wf = readRecord(root, n)
  if (!wf) throw new Fail(2, `ndev-flow: issue #${n} has no workflow in ${root}. Repair: run ndev-flow started --issue ${n} --short-name <two-to-five-words>.`)
  return wf
}
const SESSION = `ndev-flow:${PROFILE.name}`
function ownedElsewhere(wf: Workflow): string | undefined {
  const owner = wf.owner
  if (!owner || owner.session === SESSION || typeof owner.at !== 'number' || now() - owner.at >= OWNER_LIVE_MS) return undefined
  return `ndev-flow: the session ${owner.session} owns the workflow of #${wf.issue}, and it saved ${Math.round((now() - owner.at) / 1000)} s ago. Nothing changed. Leave it to that session. If that session is dead, run ndev-flow started --issue ${wf.issue} --take-over true.`
}
function save(wf: Workflow) {
  const { rev, ...rest } = wf
  const r = run('bash', [`${HOME}/scripts/work/worktree-env.sh`, 'set-workflow', '--expect-rev', String(rev ?? 0), '--worktree', wf.root], { cwd: wf.root, input: JSON.stringify(rest) })
  if (r.status !== 0) throw new Fail(r.status === 5 ? 5 : 1, `ndev-flow: could not save the workflow of #${wf.issue}: worktree-env.sh set-workflow exited ${r.status}: ${said(r)}`)
  wf.rev = Number(r.stdout.trim().split('\n').pop())
}

function ghRun(root: string, repo: string | undefined, args: string[]): string {
  const script = process.env.NDEV_FLOW_GH || `${HOME}/scripts/github/gh.sh`
  const r = run('bash', [script, ...args], { cwd: root, env: repo ? { GH_REPO: repo } : {}, timeout: 300_000 })
  if (r.status !== 0) throw new Fail(1, `ndev-flow: gh.sh ${args[0]} exited ${r.status}: ${said(r)}`)
  return r.stdout.trim()
}
function ghJson<T>(root: string, repo: string | undefined, args: string[]): T {
  const out = ghRun(root, repo, args)
  try {
    return JSON.parse(out)
  } catch {
    throw new Fail(1, `ndev-flow: gh.sh ${args[0]} printed no JSON: ${out.slice(0, 300)}`)
  }
}
const gh = (wf: Workflow, args: string[]) => ghRun(wf.root, wf.repo, args)
type Pr = { number: number; state: string; merged?: boolean; draft?: boolean; mergeable?: boolean | null; body?: string | null; created_at: string; head: { sha: string; ref: string } }
const readPr = (wf: Workflow, n: number) => ghJson<Pr>(wf.root, wf.repo, ['pr-read', String(n)])
const prOf = (wf: Workflow) => {
  const pr = wf.prs[0]
  if (!pr) throw new Fail(1, `ndev-flow: #${wf.issue} has no PR yet. Repair: run ndev-flow started --issue ${wf.issue}.`)
  return pr
}
const prUrl = (wf: Workflow) => (wf.prs[0] ? `https://github.com/${wf.repo}/pull/${wf.prs[0]}` : '')

function writeTemp(wf: Workflow, name: string, text: string): string {
  const file = join(gitDir(wf.root), `ndev-flow-${name}`)
  writeFileSync(file, text)
  return file
}
function comment(wf: Workflow, n: number, body: string) {
  return gh(wf, ['comment', String(n), '--body', `${MARK}\n${body}`])
}

const facts = (wf: Workflow, config: Config, extra: Record<string, unknown> = {}) => ({
  mode: wf.mode as any,
  steering: wf.steering as any,
  level: config.projectLevel as any,
  changeTypes: wf.changeTypes ?? [],
  webFiles: wf.webFiles ?? [],
  baseChecked: MACHINES[wf.mode as 'light'].baseCheck && !wf.baseCheck ? false : undefined,
  remembered: !!wf.hooks?.remember?.result,
  merged: !!wf.merged,
  ...extra,
})
type Position = { state: string; previous?: string }
function moveFor(wf: Workflow, config: Config, tool: string, extra: Record<string, unknown> = {}): Position {
  const m = afterTool({ state: wf.state as any, previous: wf.previous as any }, tool as any, facts(wf, config, extra) as any)
  if ('refused' in m) throw new Fail(1, rewrite(m.refused, wf))
  return m
}
function apply(wf: Workflow, to: Position, tool: string, notes: string[]) {
  const from = wf.state
  wf.history.push({ at: now(), tool, from, to: to.state })
  wf.state = to.state
  if (to.previous) wf.previous = to.previous
  else delete wf.previous
  wf.owner = { session: SESSION, at: now() }
  if (hooksFiredBy(from as any, to.state as any).includes('review')) notes.push(...startReview(wf))
}

const CHECK_FAILED = 'check'
function changeTypesEnv(root: string, mergeBase: string, declared: readonly string[]): string {
  const r = mergeBase ? git(root, 'diff', '--cached', '--name-only', mergeBase) : { status: 1, stdout: '', stderr: '' }
  const names = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []
  return [...new Set([...inferChangeTypes(names), ...declared])].join(',')
}
function runCheck(wf: Workflow, check: string, args: string[] = [], declared: readonly string[] = []): string | undefined {
  const path = `${CHECK_DIR}/${check}`
  const dir = gitDir(wf.root)
  if (wf.noChecks && !existsSync(join(wf.root, path))) return `${path} did not run: the human skipped the set-up.`
  const onBase = git(wf.root, 'cat-file', '-e', `origin/${wf.base}:${path}`).status === 0
  let script = join(wf.root, path)
  let note: string | undefined = `${path} is not on ${wf.base} yet, so a human must read it in this PR.`
  if (onBase) {
    script = join(dir, `ndev-${check}`)
    writeFileSync(script, git(wf.root, 'show', `origin/${wf.base}:${path}`).stdout)
    chmodSync(script, 0o755)
    note = git(wf.root, 'diff', '--quiet', `origin/${wf.base}...HEAD`, '--', path).status !== 0 ? `This branch changes ${path}. ndev-flow ran the version on ${wf.base}, and a human must read the change in this PR.` : undefined
  }
  const mergeBase = git(wf.root, 'merge-base', `origin/${wf.base}`, 'HEAD')
  const baseSha = mergeBase.status === 0 ? mergeBase.stdout.trim() : ''
  const types = changeTypesEnv(wf.root, baseSha, declared)
  const env = { ...(baseSha ? { NDEV_MERGE_BASE: baseSha } : {}), ...(types ? { NDEV_CHANGE_TYPES: types } : {}) }
  const before = git(wf.root, 'status', '--porcelain').stdout
  const r = run('bash', [script, ...args], { cwd: wf.root, env, timeout: CHECK_MAX_MS })
  const log = join(dir, `ndev-${check}.log`)
  writeFileSync(log, `$ ${path} ${args.join(' ')}\nexit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`)
  if (r.status !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n').slice(-4000)
    const error = new Fail(1, `${path} exited ${r.status}. Nothing was pushed. Fix the cause and run the command again. Log: ${log}\n${tail}`)
    error.name = CHECK_FAILED
    throw error
  }
  const after = git(wf.root, 'status', '--porcelain').stdout
  if (after !== before) throw new Fail(1, `${path} passed but changed the working tree. Name the changed files in --files and run the command again:\n${after}`)
  return note
}

function runBaseCheck(wf: Workflow, notes: string[]) {
  const script = baseCheckScript(wf.mode as any)
  if (!script) return
  const at = now()
  const sha = headSha(wf.root)
  try {
    const note = runCheck(wf, script)
    wf.baseCheck = { sha, script, exitCode: 0, at, ...(note ? { note } : {}) }
    notes.push(`Base check: ${CHECK_DIR}/${script} passed on ${sha.slice(0, 8)}.${note ? ` ${note}` : ''}`)
  } catch (error) {
    if (!(error instanceof Fail) || error.name !== CHECK_FAILED) throw error
    wf.baseCheck = { sha, script, exitCode: 1, at, note: error.message.slice(0, 2000) }
    notes.push(`Base check failed: the base was already broken before your change. ${error.message}\nThis does not stop the work: fix it if it is small, or file it with ndev-flow followUp --mode issue_only, or ask the human with ndev-flow blocked.`)
  }
}

function stage(wf: Workflow, files: string[]): boolean {
  if (!files.length) return false
  const add = git(wf.root, 'add', '-A', '--', ...files)
  if (add.status !== 0) throw new Fail(1, `git add of ${files.join(', ')} exited ${add.status}: ${said(add)}. Repair: name only paths in this worktree.`)
  return git(wf.root, 'diff', '--cached', '--quiet').status !== 0
}
function commit(wf: Workflow, message: string, op: string, empty = false) {
  const r = git(wf.root, 'commit', ...(empty ? ['--allow-empty'] : []), '-m', message, '--trailer', `Ndev-Op: ${op}`)
  if (r.status !== 0) throw new Fail(1, `git commit exited ${r.status}: ${said(r)}. Nothing was pushed.`)
}
function push(wf: Workflow) {
  const r = run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${wf.branch}`], { cwd: wf.root, timeout: 300_000 })
  if (r.status !== 0) throw new Fail(1, `git push to origin ${wf.branch} exited ${r.status}: ${said(r)}. Repair: if the remote moved, run git pull --rebase origin ${wf.branch}, then run the command again.`)
}
const opId = (wf: Workflow, tool: string) => `${tool}-${wf.issue}-${Date.now().toString(36)}`
function addTypes(wf: Workflow, files: string[], declared: string[]) {
  const all = new Set([...(wf.changeTypes ?? []), ...inferChangeTypes(files), ...declared])
  wf.changeTypes = CHANGE_TYPES.filter(t => all.has(t))
  wf.webFiles = [...new Set([...(wf.webFiles ?? []), ...files.filter(isWebPath)])]
}
function declaredTypes(args: Args): string[] {
  const types = list(args['change-types'])
  const bad = types.filter(t => !(CHANGE_TYPES as readonly string[]).includes(t))
  if (bad.length) throw new Fail(2, `ndev-flow: ${bad.join(', ')} is not a change type. The types are ${CHANGE_TYPES.join(', ')}.`)
  return types
}

type Sweep = { language: string; exitCode: number; output: string }
function sweepText(results: Sweep[]): string {
  if (!results.length) return 'Dead-code sweep: this change has no Python or TypeScript, so nothing was swept.'
  return results.map(r => {
    if (r.exitCode === 0) return `Dead-code sweep (${r.language}): it found nothing new. ${r.output}`.trim()
    if (r.exitCode === 1) return `Dead-code sweep (${r.language}): these names need triage:\n${r.output}`
    return `Dead-code sweep (${r.language}) did not measure: it exited ${r.exitCode}. This is not a pass. Repair the cause and run the ndev-deadcode skill, or say why not in --deadcode.\n${r.output}`
  }).join('\n')
}
function sweepDeadCode(wf: Workflow): Sweep[] {
  const scripts = `${PROFILE.skillsDir}/ndev-deadcode/scripts`
  const ref = `origin/${wf.base}`
  const listed = git(wf.root, 'diff', '--name-only', '--diff-filter=d', `${ref}...HEAD`)
  if (listed.status !== 0) return [{ language: 'all', exitCode: listed.status || 2, output: `git diff ${ref}...HEAD exited ${listed.status}: ${said(listed)}` }]
  const names = listed.stdout.split('\n').filter(Boolean)
  const out: Sweep[] = []
  const sweep = (language: string, argv: string[]) => {
    const r = run('bash', argv, { cwd: wf.root, timeout: 300_000 })
    const all = `${r.stdout}\n${r.stderr}`.trim()
    const log = join(gitDir(wf.root), `ndev-deadcode-${language}.log`)
    writeFileSync(log, all)
    out.push({ language, exitCode: r.status, output: all.length > 2000 ? `${all.slice(0, 2000)}\nThe rest is in ${log}.` : all })
  }
  if (names.some(n => n.endsWith('.py'))) {
    const tracked = git(wf.root, 'ls-files', '*.py').stdout.split('\n').filter(Boolean)
    const tops = [...new Set(tracked.map(n => (n.includes('/') ? n.split('/')[0]! : '.')))].sort()
    sweep('Python', [`${scripts}/sweep.sh`, '--base', ref, ...(tops.includes('.') ? ['.'] : tops)])
  }
  if (names.some(n => /\.tsx?$/.test(n))) sweep('TypeScript', [`${scripts}/sweep-ts.sh`, ref])
  return out
}

const AXES: Record<string, string> = {
  review: 'Review the change for correctness, security and simplification.',
  standards: 'Axis: standards. Check that the change follows the documented standards of this repository (AGENTS.md, CLAUDE.md, CONTRIBUTING and the like).',
  specification: 'Axis: specification. Check that the change does what the issue asks, all of it and nothing else.',
}
function reviewerFile(): string | undefined {
  const dir = PROFILE.agentsDir
  if (!dir) return undefined
  return [join(dir, 'ndev-diff-reviewer.toml'), join(dir, 'ndev-diff-reviewer.md')].find(existsSync)
}
function startReview(wf: Workflow): string[] {
  const issue = ghJson<{ title: string; body: string | null }>(wf.root, wf.repo, ['issue-read', String(wf.issue)])
  const axes = MACHINES[wf.mode as 'light'].twoAxisReview ? ['standards', 'specification'] : ['review']
  const dir = gitDir(wf.root)
  const reviewer = reviewerFile()
  const sha = headSha(wf.root)
  const runs = axes.map(axis => {
    const brief = join(dir, `ndev-review-${axis}.md`)
    const out = join(dir, `ndev-review-${axis}.out.md`)
    const log = join(dir, `ndev-review-${axis}.log`)
    rmSync(out, { force: true })
    writeFileSync(brief, [
      `# Review of issue #${wf.issue}: ${issue.title}`,
      'You are an independent reviewer. Read only: do not edit, commit or push. Report Critical and Important findings, each with file:line, the failure and the fix. If you find none, say so.',
      `Worktree: ${wf.root}`,
      `The change: run git diff origin/${wf.base}...HEAD in the worktree. HEAD is ${sha}, and its last commit is not pushed yet.`,
      AXES[axis],
      ...reviewerBrief((wf.changeTypes ?? []) as any),
      MACHINES[wf.mode as 'light'].reviewBrief ?? '',
      reviewer ? `Your instructions as reviewer are in ${reviewer}: follow them.` : '',
      `## Issue #${wf.issue}: ${issue.title}`,
      issue.body ?? '(no body)',
    ].filter(Boolean).join('\n\n'))
    if (!PROFILE.reviewCommand) return { axis, brief, out, log }
    const cmd = PROFILE.reviewCommand.replaceAll('{brief}', quote(brief)).replaceAll('{out}', quote(out))
    const fd = openSync(log, 'w')
    const child = spawn('sh', ['-c', cmd], { cwd: wf.root, detached: true, stdio: ['ignore', fd, fd] })
    if (!child.pid) throw new Fail(1, `ndev-flow: the review command did not start: ${cmd}`)
    child.unref()
    return { axis, brief, out, log, pid: child.pid }
  })
  wf.exportReview = { sha, at: now(), runs }
  wf.deadcode = { sha, results: sweepDeadCode(wf) }
  return [sweepText(wf.deadcode.results)]
}
function reviewText(wf: Workflow): string {
  const runs: { axis: string; brief: string; out: string; log: string; pid?: number }[] = wf.exportReview?.runs ?? []
  if (!runs.length) return 'ndev-flow started no review. Run ndev-flow skip only if the human says so; else ask the human.'
  if (!runs[0]!.pid) return `This harness has no review command, so ndev-flow wrote the brief${runs.length > 1 ? 's' : ''} and started nothing: ${runs.map(r => r.brief).join(', ')}. Give each brief to an independent reviewer (a subagent of this harness, or another agent) and keep the reports apart.`
  const each = runs.map(r => `${r.axis === 'review' ? 'the review' : `the ${r.axis} review`} (pid ${r.pid}): wait with ${WAIT_PID} ${r.pid}, then read ${r.out} (log ${r.log})`).join('; ')
  return `ndev-flow started ${runs.length === 1 ? 'one independent review' : `the two-axis review, ${runs.length} reviewers`} with the review command of this harness: ${each}. Do not start another review.${runs.length > 1 ? ' Keep the reports apart.' : ''} The wait is one blocking call, not a loop.`
}
function reviewAlive(wf: Workflow): string[] {
  const runs: { axis: string; pid?: number }[] = wf.exportReview?.runs ?? []
  return runs.filter(r => {
    if (!r.pid) return false
    try {
      process.kill(r.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }).map(r => `${r.axis} (pid ${r.pid})`)
}

type Checks = { pending: string[]; red: string[]; green: string[]; names: string[] }
function readChecks(wf: Workflow, sha: string): Checks {
  const { check_runs: runs = [], statuses = [] } = ghJson<{ check_runs?: { name: string; status: string; conclusion: string | null; started_at?: string | null }[]; statuses?: { context: string; state: string }[] }>(wf.root, wf.repo, ['commit-checks', sha, '--pr', String(prOf(wf))])
  const out: Checks = { pending: [], red: [], green: [], names: [] }
  const latest = new Map<string, (typeof runs)[number]>()
  for (const c of runs) {
    const seen = latest.get(c.name)
    if (!seen || (c.started_at ?? '') >= (seen.started_at ?? '')) latest.set(c.name, c)
  }
  for (const c of latest.values()) {
    out.names.push(c.name)
    if (c.status !== 'completed') out.pending.push(`${c.name} (${c.status})`)
    else if (['success', 'skipped', 'neutral'].includes(c.conclusion ?? '')) out.green.push(c.name)
    else out.red.push(`${c.name} (${c.conclusion})`)
  }
  for (const s of statuses) {
    out.names.push(s.context)
    if (s.state === 'pending') out.pending.push(`${s.context} (pending)`)
    else if (s.state === 'success') out.green.push(s.context)
    else out.red.push(`${s.context} (${s.state})`)
  }
  if (!out.names.length) {
    const workflows = git(wf.root, 'ls-tree', '-d', 'HEAD', '.github/workflows').stdout.trim() !== ''
    const limit = workflows ? 10 * 60_000 : 2 * 60_000
    const at = git(wf.root, 'log', '-1', '--format=%ct', sha)
    const age = Date.now() - Number(at.stdout.trim()) * 1000
    if (at.status !== 0 || age < limit) out.pending.push(`no check has started yet for this commit. If none has started ${limit / 60_000} minutes after the commit, this repository runs none for it`)
  }
  return out
}
function greenOrFail(wf: Workflow): Checks {
  const sha = headSha(wf.root)
  const pushed = git(wf.root, 'rev-parse', `origin/${wf.branch}`)
  if (pushed.status !== 0 || pushed.stdout.trim() !== sha) throw new Fail(1, `HEAD ${sha.slice(0, 8)} is not pushed to origin/${wf.branch}, so no check runs on it. Repair: commit and push with ndev-flow checkpoint.`)
  const pr = ghJson<{ mergeable?: boolean | null; state?: string; merged?: boolean }>(wf.root, wf.repo, ['pr-read', String(prOf(wf))])
  if (pr.mergeable === false) throw new Fail(1, `PR #${prOf(wf)} has merge conflicts with ${wf.base}. Merge origin/${wf.base} into the branch, resolve them (the ndev-resolving-merge-conflicts skill), and commit with ndev-flow checkpoint.`)
  const checks = readChecks(wf, sha)
  if (checks.red.length) throw new Fail(1, `Checks failed on ${sha.slice(0, 8)}: ${checks.red.join(', ')}. Fix each one and commit with ndev-flow checkpoint, then wait with ${WAIT_PR} ${prOf(wf)} --skip-success --json.`)
  if (checks.pending.length) throw new Fail(1, `Checks still run on ${sha.slice(0, 8)}: ${checks.pending.join(', ')}. Wait with one blocking call: ${WAIT_PR} ${prOf(wf)} --skip-success --json. Then run ndev-flow finishedChecks again.`)
  return checks
}
const changedPaths = (wf: Workflow) => git(wf.root, 'diff', '--name-only', `origin/${wf.base}...HEAD`).stdout.split('\n').filter(Boolean)

function rewrite(text: string, wf?: Workflow): string {
  const pr = wf?.prs?.[0] ?? '<pr>'
  return text
    .replace(/The plugin started [^:]+:[\s\S]*?because its answer comes to you\./, () => (wf ? reviewText(wf) : 'ndev-flow started the review.'))
    .replaceAll('The plugin ran the dead-code sweep', 'ndev-flow ran the dead-code sweep')
    .replaceAll('When the answer comes,', 'When the review ends,')
    .replace(/Do not run a wait helper: the workflow watches[^.]*\. If nothing else is open, end your turn\. When it prompts you,/, `Nothing watches the checks for you in this harness. Wait for them with one blocking call: ${WAIT_PR} ${pr} --skip-success --json. When it returns,`)
    .replaceAll('Ask with interview(interviewJson).', `${PROFILE.askHuman ?? 'Ask the human in the chat and end your turn.'} Ask at most one round at a time.`)
    .replaceAll('in the interview pane or in the chat', 'in the chat')
    .replaceAll("the project's CLAUDE.md", "the project's AGENTS.md or CLAUDE.md")
    .replaceAll('(kb/comments.md)', `(${HOME}/kb/comments.md)`)
    .replace(/run \/flow off <reason> to work on this issue without the workflow/g, 'stop using ndev-flow to work on this issue without the workflow')
    .replace(/\/flow skip <reason>/g, 'ndev-flow skip --reason <reason>')
    .replace(/\/unblock <([^>]+)>/g, 'ndev-flow unblocked --message <$1>')
    .replace(/\/flow unblock\b/g, 'ndev-flow unblocked')
    .replace(/\/flow goto <state>/g, 'ndev-flow goto --state <state>')
    .replace(/\/flow goto (\w+)/g, 'ndev-flow goto --state $1')
    .replace(/\/flow mode (\w+)/g, 'ndev-flow mode --mode $1')
    .replace(/\/flow steering (\w+)/g, 'ndev-flow steering --steering $1')
    .replace(/\/flow (\w+)/g, 'ndev-flow $1')
    .replace(/(?<![\w/.-])ndev:([a-z0-9-]+)/g, 'ndev-$1')
}

function report(wf: Workflow, config: Config, notes: string[]) {
  const lines = [
    `State: ${wf.state}${wf.previous ? ` (then ${wf.previous})` : ''}. Issue #${wf.issue}, mode ${wf.mode}, steering ${wf.steering}.`,
    wf.prs[0] ? `PR: ${prUrl(wf)}` : '',
    ...notes.filter(Boolean),
    `Next: ${rewrite(nextStep(wf.state as any, facts(wf, config) as any), wf)}`,
    `ndev-flow is ${FLOW}. Each tool named above is one of its commands: ndev-flow <tool> --name value. Run ndev-flow help for the flags.`,
  ]
  console.log(lines.filter(Boolean).join('\n'))
}

function resolveRepo(root: string, config: Config): string {
  if (config.github?.repo) return config.github.repo
  if (process.env.GH_REPO) return process.env.GH_REPO
  return ghJson<{ repo: string }>(root, undefined, ['repo']).repo
}

function setUpPr(wf: Workflow, title: string) {
  const open = ghRun(wf.root, wf.repo, ['pr-list', '--head', wf.branch, '--state', 'open']).split('\n').filter(Boolean).map(line => JSON.parse(line) as { number: number })
  if (open[0]) {
    wf.prs = [open[0].number]
    return
  }
  if (gitOk(wf.root, 'rev-list', '--count', `origin/${wf.base}..HEAD`) === '0') commit(wf, `Start work on #${wf.issue}`, `start-${wf.issue}`, true)
  push(wf)
  const body = writeTemp(wf, 'pr-body.md', `Plan incoming.\n\nCloses #${wf.issue}\n`)
  const made = ghRun(wf.root, wf.repo, ['pr-new', '--title', title, '--body-file', body, '--base', wf.base, '--head', wf.branch])
  const number = /\/pull\/(\d+)/.exec(made)?.[1]
  if (!number) throw new Fail(1, `ndev-flow: gh.sh pr-new printed no pull request URL: ${made.slice(0, 200)}`)
  wf.prs = [Number(number)]
}

function started(root: string, config: Config, args: Args) {
  if (config.workflow === false) throw new Fail(2, `ndev-flow: ${root}/.neil-dev.json sets "workflow": false, so this project works without the workflow. Repair: remove that key to use ndev-flow.`)
  const issue = findIssue(root, args)
  const notes: string[] = []
  let wf = readRecord(root, issue)
  if (wf) {
    const elsewhere = ownedElsewhere(wf)
    if (elsewhere && args['take-over'] !== 'true') throw new Fail(1, elsewhere)
    if (elsewhere) notes.push(`Took over from ${wf.owner.session}.`)
  }
  if (wf && wf.state !== 'setup') {
    if (!wf.prs.length && !wf.direct && wf.state !== 'done') {
      setUpPr(wf, ghJson<{ title: string }>(root, wf.repo, ['issue-read', String(issue)]).title)
      notes.push(`Opened ${prUrl(wf)}.`)
    }
    const to = afterStarted({ state: wf.state as any, previous: wf.previous as any }, { mode: wf.mode as any, steering: wf.steering as any })
    if (to.state !== wf.state) apply(wf, to, 'started', notes)
    wf.owner = { session: SESSION, at: now() }
    save(wf)
    return report(wf, config, ['Resumed.', ...notes])
  }
  if (!wf) {
    const shortName = need(args, 'short-name')
    if (!/^[a-z0-9]+(-[a-z0-9]+){1,4}$/.test(shortName)) throw new Fail(2, `ndev-flow: --short-name "${shortName}" must be two to five lower-case words joined by hyphens.`)
    const mode = args.mode ?? config.mode ?? 'light'
    if (!(mode in MACHINES)) throw new Fail(2, `ndev-flow: --mode "${mode}" is not a mode. The modes are ${Object.keys(MACHINES).join(', ')}.`)
    const steering = config.steering ?? 'interactive'
    const repo = resolveRepo(root, config)
    const base = ghJson<{ default_branch: string }>(root, repo, ['default-branch']).default_branch
    const branch = gitOk(root, 'branch', '--show-current')
    if (!branch) throw new Fail(2, `ndev-flow: ${root} has a detached HEAD. Repair: git switch -c ${issue}-${shortName}`)
    if (branch === base) throw new Fail(2, `ndev-flow: ${root} is on the base branch ${base}, and each issue needs its own branch. Repair: git switch -c ${issue}-${shortName}`)
    wf = { issue, root, repo, base, branch, prs: [], shortName, state: 'setup', owner: { session: SESSION, at: now() }, evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], mode, steering }
  }
  const info = ghJson<{ title: string; state: string }>(root, wf.repo, ['issue-read', String(issue)])
  const fetched = git(root, 'fetch', '-q', 'origin', wf.base)
  if (fetched.status !== 0) notes.push(`git fetch origin ${wf.base} exited ${fetched.status}: ${said(fetched)}. The checks compare with an old base.`)
  const missing = CHECKS.filter(c => !existsSync(join(root, CHECK_DIR, c)))
  if (missing.length) {
    apply(wf, afterStarted(undefined, { mode: wf.mode as any, steering: wf.steering as any, scriptsMissing: true }), 'started', notes)
    save(wf)
    return report(wf, config, [`Missing check scripts in ${root}/${CHECK_DIR}: ${missing.join(', ')}. Start each from the template ${HOME}/scripts/workflow/fast-checks-template.sh.`])
  }
  setUpPr(wf, info.title)
  apply(wf, afterStarted(undefined, { mode: wf.mode as any, steering: wf.steering as any }), 'started', notes)
  save(wf)
  report(wf, config, [`Issue #${issue}: ${info.title}`, ...notes])
}

function checkpoint(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const files = list(need(args, 'files'))
  const declared = declaredTypes(args)
  const types = [...new Set([...inferChangeTypes(files), ...declared])]
  const all = [...new Set([...(wf.changeTypes ?? []), ...types])]
  const prOpen = wf.state === 'done' ? (() => {
    const pr = ghJson<{ state: string; merged?: boolean }>(wf.root, wf.repo, ['pr-read', String(prOf(wf))])
    return pr.state === 'open' && !pr.merged
  })() : undefined
  const to = moveFor(wf, config, 'checkpoint', { docsOnly: isDocsOnly(types as any), smoke: !wf.evidence?.smoke && needsSmoke(wf.mode as any, files, [], all as any), prOpen })
  const localOnly = !!MACHINES[wf.mode as 'light'].localOnly?.includes(wf.state as any)
  const pushes = !localOnly && wf.state !== 'reviewing' && wf.state !== 'hardening'
  if (!stage(wf, files)) throw new Fail(1, `ndev-flow: ${files.join(', ')} hold no change to commit. Repair: name the changed files in --files.`)
  const notes: string[] = []
  try {
    const note = runCheck(wf, 'fast-checks.sh', files, declared)
    if (note) notes.push(note)
  } catch (error) {
    if (!localOnly) throw error
    notes.push(`Advice only, in this state: ${(error as Error).message}`)
  }
  if (!localOnly) {
    const note = runCheck(wf, 'pre-commit-check.sh', [], declared)
    if (note) notes.push(note)
  }
  commit(wf, message, opId(wf, 'checkpoint'))
  if (pushes) {
    const note = runCheck(wf, 'pre-push-check.sh', [], declared)
    if (note) notes.push(note)
    push(wf)
    notes.push(`Committed and pushed ${headSha(wf.root).slice(0, 8)}.`)
  } else notes.push(`Committed ${headSha(wf.root).slice(0, 8)} on this computer only: in the state "${wf.state}" nothing is pushed.`)
  addTypes(wf, files, declared)
  apply(wf, to, 'checkpoint', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedDevelopment(wf: Workflow, config: Config, args: Args) {
  const machine = MACHINES[wf.mode as 'light']
  const to = moveFor(wf, config, 'finishedDevelopment')
  const files = list(args.files)
  const declared = declaredTypes(args)
  if (machine.hardens && !args.hardening?.trim()) throw new Fail(2, 'ndev-flow: hack mode needs --hardening: each test that pins the change, the command and the failing line on the base, and its pass on HEAD.')
  const notes: string[] = []
  if (stage(wf, files)) {
    runCheck(wf, 'fast-checks.sh', files, declared)
    runCheck(wf, 'pre-commit-check.sh', [], declared)
    commit(wf, need(args, 'message'), opId(wf, 'finishedDevelopment'))
    notes.push(`Committed ${headSha(wf.root).slice(0, 8)}. It is not pushed until finishedReview.`)
  }
  addTypes(wf, files, declared)
  if (machine.hardens) runCheck(wf, 'pre-push-check.sh', [], declared)
  if (machine.gates) {
    const gates = run('bash', [`${HOME}/scripts/work/gates.sh`, String(wf.issue), 'HEAD', String(prOf(wf))], { cwd: wf.root, env: { GH_REPO: wf.repo } })
    if (gates.status !== 0) throw new Fail(1, `gates.sh exited ${gates.status} for #${wf.issue}: ${said(gates)}\nThe commit is held here and not pushed. Add what is missing, then run ndev-flow finishedDevelopment again.`)
  }
  if (args['body-file']) {
    const text = readFileSync(args['body-file'], 'utf8')
    const body = new RegExp(`(close[sd]?|fix(e[sd])?|resolve[sd]?) #${wf.issue}\\b`, 'i').test(text) ? text : `${text.trimEnd()}\n\nCloses #${wf.issue}\n`
    gh(wf, ['pr-edit', String(prOf(wf)), '--body-file', writeTemp(wf, 'pr-body.md', body)])
    notes.push('The PR body is updated.')
  }
  if (args.hardening) comment(wf, prOf(wf), `Hardening evidence:\n\n${args.hardening}`)
  apply(wf, to, 'finishedDevelopment', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedReview(wf: Workflow, config: Config, args: Args) {
  const fields = { review: need(args, 'review'), deadcode: need(args, 'deadcode'), remembered: need(args, 'remembered') }
  const to = moveFor(wf, config, 'finishedReview')
  const alive = reviewAlive(wf)
  if (alive.length) throw new Fail(1, `ndev-flow: the review still runs: ${alive.join(', ')}. Wait with ${WAIT_PID} <pid>, read its report, then run ndev-flow finishedReview again.`)
  const notes: string[] = []
  const note = runCheck(wf, 'pre-ready-check.sh', [], wf.changeTypes ?? [])
  if (note) notes.push(note)
  push(wf)
  gh(wf, ['pr-ready', String(prOf(wf))])
  const sha = headSha(wf.root)
  const text = `review: ${fields.review}\ndeadcode: ${fields.deadcode}\nremembered: ${fields.remembered}`
  comment(wf, prOf(wf), `Review of ${sha.slice(0, 8)}\n\n${text}`)
  wf.evidence = { ...wf.evidence, review: { sha, text } }
  const firedAt = now()
  wf.hooks = { ...wf.hooks, review: { firedAt: wf.hooks?.review?.firedAt ?? firedAt, result: fields.review.slice(0, 2000) }, remember: { firedAt: wf.hooks?.remember?.firedAt ?? firedAt, result: fields.remembered.slice(0, 2000) } }
  notes.push(`Pushed ${headSha(wf.root).slice(0, 8)} and marked PR #${prOf(wf)} ready.`)
  apply(wf, to, 'finishedReview', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedChecks(wf: Workflow, config: Config) {
  moveFor(wf, config, 'finishedChecks')
  const checks = greenOrFail(wf)
  const smoke = needsSmoke(wf.mode as any, changedPaths(wf), checks.names, (wf.changeTypes ?? []) as any)
  const to = moveFor(wf, config, 'finishedChecks', { smoke })
  wf.evidence = { ...wf.evidence, checks: { sha: headSha(wf.root), text: `green: ${checks.green.join(', ') || 'none ran'}` } }
  const notes = [`Checks are green on ${headSha(wf.root).slice(0, 8)}: ${checks.green.join(', ') || 'none ran'}.`]
  apply(wf, to, 'finishedChecks', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedSmoke(wf: Workflow, config: Config, args: Args) {
  const to = moveFor(wf, config, 'finishedSmoke')
  const required = MACHINES[wf.mode as 'light'].alwaysSmoke || requiredSmokeTypes((wf.changeTypes ?? []) as any).length > 0
  const sha = headSha(wf.root)
  if (!args.report && !args.skipped) throw new Fail(2, 'ndev-flow: finishedSmoke needs --report <what you tested, with the URL> or --skipped <reason>.')
  if (args.skipped && required) throw new Fail(2, 'ndev-flow: this change requires its smoke test, and only a human can skip it, with ndev-flow skip --reason <reason>.')
  comment(wf, prOf(wf), args.report ? `Smoke test of ${sha}\n\n${args.report}` : `Smoke test of ${sha} skipped: ${args.skipped}`)
  wf.evidence = { ...wf.evidence, smoke: { sha, text: args.report || `skipped: ${args.skipped}` } }
  const notes = ['The smoke report is on the PR.']
  apply(wf, to, 'finishedSmoke', notes)
  save(wf)
  report(wf, config, notes)
}

type Comment = { id: number; body: string | null; user: { login: string; type?: string } | null; created_at?: string; submitted_at?: string }
function newFeedback(wf: Workflow, pr: Pr, after?: number): string[] {
  const all = gh(wf, ['feedback', String(wf.issue), String(pr.number)]).split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line) as Comment
    } catch {
      throw new Fail(1, `ndev-flow: gh.sh feedback printed a line that is not JSON: ${line.slice(0, 200)}`)
    }
  })
  const isPipeline = (c: Comment) => /<!-- work-heavy-auto|^\*\*work-heavy-auto|^\*\*Smoke tested|^\s*<!--\s*[a-z][\w:-]*/i.test(c.body ?? '')
  const acked = new Set(all.filter(isPipeline).flatMap(c => [...(c.body ?? '').matchAll(/ack:([\d,]+)/g)].flatMap(m => m[1]!.split(','))))
  let since = Math.max(Date.parse(pr.created_at), after ?? 0)
  if (after === undefined) {
    const last = git(wf.root, 'log', '-1', '--format=%cI', pr.head.sha)
    if (last.status !== 0) throw new Fail(1, `ndev-flow: git log could not read the PR head ${pr.head.sha.slice(0, 8)} in ${wf.root}: ${said(last)}. Repair: git pull --rebase origin ${pr.head.ref}.`)
    since = Math.max(since, Date.parse(last.stdout.trim()))
  }
  return all
    .filter(c => !isPipeline(c) && c.user?.type !== 'Bot' && !c.user?.login.endsWith('[bot]'))
    .filter(c => (c.body ?? '').trim() !== '')
    .filter(c => !acked.has(String(c.id)) && Date.parse(c.created_at ?? c.submitted_at ?? '') > since)
    .map(c => `#${c.id} from ${c.user?.login ?? 'unknown'}: ${(c.body ?? '').slice(0, 200)}`)
}

const CLOSING = '\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+(?:(?:[\\w.-]+\\/[\\w.-]+)?#|https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/issues\\/)'
const hasIssueRef = (body: string, n: number) => new RegExp(`${CLOSING}${n}\\b`, 'i').test(body)

function doneProblems(wf: Workflow, sha: string, pr: Pr): { problems: string[]; feedback: string[] } {
  const problems: string[] = []
  const status = git(wf.root, 'status', '--porcelain=v1', '--untracked-files=all')
  if (status.status !== 0) throw new Fail(1, `git status exited ${status.status} in ${wf.root}: ${said(status)}`)
  const dirty = status.stdout.split('\n').filter(Boolean).map(l => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
  if (dirty.length) problems.push(`The tree is not clean: ${dirty.join(', ')}.`)
  if (git(wf.root, 'rev-parse', `origin/${wf.branch}`).stdout.trim() !== sha) problems.push(`HEAD ${sha.slice(0, 8)} is not pushed to origin/${wf.branch}. Run ndev-flow checkpoint.`)
  const listed = new Set((wf.migrations ?? []).map((m: { path: string }) => m.path))
  const unlisted = changedPaths(wf).filter(f => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(f) && !listed.has(f))
  if (unlisted.length) problems.push(`Nothing will run these migration files after the merge: ${unlisted.join(', ')}. Repair: run ndev-flow addMigration --name <name>, move the SQL into the file it makes, and delete the old file.`)
  const stash = git(wf.root, 'stash', 'list').stdout
  if (stash.includes(`on ${wf.branch}:`) || stash.includes(`On ${wf.branch}:`)) problems.push(`A stash of ${wf.branch} remains. Apply or drop it.`)
  const humanSkip = wf.evidence?.checks?.byHuman && wf.evidence.checks.sha === sha
  if (!humanSkip) {
    const checks = readChecks(wf, sha)
    if (checks.red.length) problems.push(`Red checks on HEAD: ${checks.red.join(', ')}.`)
    if (checks.pending.length) problems.push(`Pending checks on HEAD: ${checks.pending.join(', ')}. Wait with one blocking call: ${WAIT_PR} ${pr.number} --skip-success --json.`)
  }
  if (wf.evidence?.checks?.sha !== sha) problems.push('finishedChecks has no record for HEAD. Run ndev-flow finishedChecks.')
  if (wf.evidence?.smoke && wf.evidence.smoke.sha !== sha) problems.push(`The smoke evidence is for ${String(wf.evidence.smoke.sha).slice(0, 8)}, not HEAD.`)
  for (const m of wf.migrations ?? []) {
    const size = git(wf.root, 'cat-file', '-s', `HEAD:${m.path}`).stdout.trim()
    if (size === '') problems.push(`The migration ${m.path} is not committed. Run ndev-flow checkpoint.`)
    else if (size === '0') problems.push(`The migration ${m.path} is empty. Write its SQL and run ndev-flow checkpoint.`)
  }
  if (pr.state !== 'open') problems.push(`PR #${pr.number} is closed with no merge. Repair: gh pr reopen ${pr.number} --repo ${wf.repo}.`)
  if (pr.draft) problems.push(`PR #${pr.number} is still a draft. Repair: gh pr ready ${pr.number} --repo ${wf.repo}.`)
  if (pr.state === 'open' && pr.mergeable === false) problems.push(`PR #${pr.number} has conflicts with ${wf.base}. Merge ${wf.base} in and run ndev-flow checkpoint.`)
  if (pr.state === 'open' && pr.mergeable === null) problems.push(`GitHub has not finished computing whether PR #${pr.number} can merge. Run ndev-flow done again.`)
  if (pr.head.sha !== sha) problems.push(`PR #${pr.number} is at ${pr.head.sha.slice(0, 8)}, not HEAD ${sha.slice(0, 8)}. Repair: git pull --rebase origin ${wf.branch} when the PR is ahead; push HEAD when it is ahead.`)
  for (const f of (wf.followUps ?? []).filter((x: { mode: string }) => x.mode === 'this_agent')) {
    if (!hasIssueRef(pr.body ?? '', f.issue)) problems.push(`The PR body has lost "Closes #${f.issue}". Put it back: this PR carries that issue.`)
  }
  return { problems, feedback: newFeedback(wf, pr, wf.feedbackAt ?? 0) }
}

function done(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const extra: Record<string, unknown> = {}
  const noChange = BEFORE_REVIEW.includes(wf.state as any)
  if (MERGEABLE_BEFORE_DONE.includes(wf.state as any) && wf.prs[0]) extra.prMerged = !!readPr(wf, wf.prs[0]).merged
  if (noChange) {
    const issue = ghJson<{ state: string }>(wf.root, wf.repo, ['issue-read', String(wf.issue)])
    extra.noChange = issue.state === 'closed' && changedPaths(wf).length === 0
  }
  const to = moveFor(wf, config, 'done', extra)
  const remembered = args.remembered?.trim() || wf.hooks?.remember?.result || ''
  if (!remembered) throw new Fail(2, 'ndev-flow: the remember step has no result. Update the docs and the wiki, then run ndev-flow done with --remembered: what you recorded, or "nothing: <reason>".')
  if (!maySkipReview(config.projectLevel as any) && /^skipped\b/i.test(remembered)) throw new Fail(2, 'ndev-flow: a formal_project does not skip the remember step. Do the step and run ndev-flow done again.')
  wf.hooks = { ...wf.hooks, remember: { firedAt: wf.hooks?.remember?.firedAt ?? now(), result: remembered.slice(0, 2000) } }
  const notes: string[] = []
  const n = wf.prs[0]
  if (!noChange && !extra.prMerged && n && !wf.direct) {
    const sha = headSha(wf.root)
    const pr = readPr(wf, n)
    if (pr.merged) extra.prMerged = true
    else {
      const { problems, feedback } = doneProblems(wf, sha, pr)
      if (feedback.length) {
        apply(wf, moveFor(wf, config, 'done', { feedback: true }), 'done', notes)
        save(wf)
        return report(wf, config, [`Not done: this feedback has no answer:\n${feedback.join('\n')}\nndev-flow cannot tell your own note from a request by the human, because both use one GitHub login. If a comment asks for no change, run ndev-flow comment --message "ack:<its id>", then ndev-flow finishedRevision.`, ...problems.map(p => `Also: ${p}`)])
      }
      if (problems.length) throw new Fail(1, `Not done. Fix each of these, then run ndev-flow done again:\n- ${problems.join('\n- ')}`)
      notes.push(`Comment: ${comment(wf, n, `ndev-flow done: ${message}`)}`)
      if (mayMerge(config.projectLevel as any)) {
        if (wf.migrations?.length) notes.push(`This PR has ${wf.migrations.length} migration(s), so done did not merge it. This project level lets you merge: load the ndev-merge skill now and follow it for PR #${n}.`)
        else {
          const script = process.env.NDEV_FLOW_MERGE || `${HOME}/scripts/workflow/merge.sh`
          const r = run('bash', [script, String(n), '--repo', wf.repo], { cwd: wf.root, timeout: 300_000 })
          if (r.status !== 0) throw new Fail(1, `Not done: ${script} exited ${r.status} for PR #${n}: ${said(r)}`)
          wf.merged = true
          notes.push(`PR #${n} is merged.`)
        }
      }
    }
  }
  wf.doneMessage = message
  if (extra.prMerged) wf.merged = true
  if (extra.noChange) wf.closedNoChange = true
  apply(wf, to, 'done', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedRevision(wf: Workflow, config: Config) {
  const to = moveFor(wf, config, 'finishedRevision')
  if (wf.prs[0]) {
    const feedback = newFeedback(wf, readPr(wf, wf.prs[0]))
    if (feedback.length) throw new Fail(1, `Refused: this feedback has no answer. Push a commit that answers it, or run ndev-flow comment --message "ack:<id>":\n${feedback.join('\n')}`)
  }
  wf.feedbackAt = now()
  const notes: string[] = []
  apply(wf, to, 'finishedRevision', notes)
  save(wf)
  report(wf, config, notes)
}

function simpleMove(tool: string) {
  return (wf: Workflow, config: Config) => {
    const notes: string[] = []
    apply(wf, moveFor(wf, config, tool), tool, notes)
    save(wf)
    report(wf, config, notes)
  }
}

function interview(wf: Workflow, config: Config, args: Args) {
  if (Object.keys(args).some(k => k !== 'issue')) throw new Fail(2, `ndev-flow: this harness has no interview pane. Instead, ask the questions in the chat (${PROFILE.askHuman ?? 'ask the human in the chat and end your turn'}), then run ndev-flow interview with no flags to go on.`)
  const to = moveFor(wf, config, 'interview')
  const notes: string[] = []
  if (to.state === 'developing' || to.state === 'planning') runBaseCheck(wf, notes)
  apply(wf, to, 'interview', notes)
  save(wf)
  report(wf, config, notes)
}

function finishedInterview(wf: Workflow, config: Config) {
  if (!['developing', 'planning', 'hardening'].includes(wf.state)) throw new Fail(1, `Refused: finishedInterview is not valid in the state "${wf.state}". Nothing changed.`)
  const notes: string[] = []
  if (!baseCheckScript(wf.mode as any)) notes.push(`Mode ${wf.mode} has no base check.`)
  else runBaseCheck(wf, notes)
  save(wf)
  report(wf, config, notes)
}

function finishedPlan(wf: Workflow, config: Config, args: Args) {
  const file = need(args, 'file')
  const to = moveFor(wf, config, 'finishedPlan')
  const text = readFileSync(file, 'utf8')
  if (!/Test entry point:/i.test(text)) throw new Fail(2, `ndev-flow: the plan ${file} has no "Test entry point:" line. Repair: add one, then run the command again.`)
  gh(wf, ['pr-edit', String(prOf(wf)), '--body-file', writeTemp(wf, 'pr-body.md', `${text.trimEnd()}\n\nCloses #${wf.issue}\n`)])
  const notes = [`The plan is in the body of ${prUrl(wf)}.`]
  if (to.state === 'blocked') wf.blocked = { message: `Sign off the plan in ${prUrl(wf)}, then run ndev-flow unblocked --message go.`, at: now(), group: 'plan' }
  if (to.state === 'blocked') notes.push(wf.blocked.message)
  apply(wf, to, 'finishedPlan', notes)
  save(wf)
  report(wf, config, notes)
}

function blocked(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const to = moveFor(wf, config, 'blocked')
  wf.blocked = { message, at: now(), group: 'agent' }
  const notes = [`Blocked: ${message}`]
  apply(wf, to, 'blocked', notes)
  save(wf)
  report(wf, config, notes)
}

function unblocked(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const to = moveFor(wf, config, 'unblocked')
  delete wf.blocked
  const notes = [`Unblocked: ${message}`]
  apply(wf, to, 'unblocked', notes)
  save(wf)
  report(wf, config, notes)
}

function followUp(wf: Workflow, config: Config, args: Args) {
  const mode = need(args, 'mode')
  const message = need(args, 'message')
  const tool = { issue_only: 'followUpIssue', this_agent: 'followUpThisAgent' }[mode]
  if (!tool) throw new Fail(2, `ndev-flow: followUp --mode ${mode} needs the Claude plugin. Instead, use --mode issue_only, then start that issue in its own worktree and session with ndev-flow started.`)
  const to = moveFor(wf, config, tool)
  const carrier = mode === 'this_agent' ? prOf(wf) : undefined
  const [title = '', ...rest] = message.split('\n')
  const body = writeTemp(wf, 'follow-up.md', `${rest.join('\n').trim()}\n\nFound while working on #${wf.issue}.\n`)
  const made = ghJson<{ number: number; url: string }>(wf.root, wf.repo, ['issue-new', '--title', title.trim(), '--body-file', body])
  wf.followUps = [...(wf.followUps ?? []), { hash: String(Date.now()), mode, issue: made.number, title: title.trim() }]
  const notes = [`Filed #${made.number}: ${made.url}`]
  apply(wf, to, tool, notes)
  save(wf)
  if (carrier) {
    try {
      const body = readPr(wf, carrier).body ?? ''
      gh(wf, ['pr-edit', String(carrier), '--body-file', writeTemp(wf, 'pr-body.md', `${body.trimEnd()}\n\nCloses #${made.number}\n`)])
    } catch (error) {
      throw new Fail(1, `ndev-flow: filed #${made.number} for this PR, but its body was not changed: ${(error as Error).message}\nRepair: add "Closes #${made.number}" to the body of PR #${carrier}. Do not run followUp again.`)
    }
    notes.push(`PR #${carrier} now closes #${made.number}.`)
  }
  report(wf, config, notes)
}

function setSteering(wf: Workflow, config: Config, args: Args) {
  if (need(args, 'steering') !== 'auto') throw new Fail(2, 'ndev-flow: an agent can only set --steering auto. Only a human sets it back, with ndev-flow steering --steering interactive.')
  const reason = need(args, 'reason')
  const to = moveFor(wf, config, 'setAuto')
  wf.steering = 'auto'
  if (wf.prs[0]) comment(wf, wf.prs[0], `Steering set to auto: ${reason}`)
  const notes = [`Steering is auto: ${reason}`]
  apply(wf, to, 'setAuto', notes)
  save(wf)
  report(wf, config, notes)
}

function humanMove(wf: Workflow, config: Config, verb: string, to: Position, reason: string) {
  const from = wf.state
  const notes = [verb === 'skip' ? `Skipped ${from}: ${reason}` : `Moved by the human from ${from} to ${to.state}.`]
  const sha = headSha(wf.root)
  if (from === 'reviewing' && !['developing', 'planning', 'reviewing'].includes(to.state)) {
    if (wf.prs[0]) {
      const pr = readPr(wf, wf.prs[0])
      if (pr.draft) gh(wf, ['pr-ready', String(pr.number)])
    }
    if (git(wf.root, 'rev-parse', `origin/${wf.branch}`).stdout.trim() !== sha) notes.push(`A commit is held and not pushed. Repair: git push -u origin HEAD:refs/heads/${wf.branch}.`)
  }
  if (from === 'setup' && verb === 'skip') wf.noChecks = true
  if ((from === 'ci' && verb === 'skip') || (verb === 'goto' && ['finishing', 'smoke', 'done'].includes(to.state) && wf.evidence?.checks?.sha !== sha)) {
    wf.evidence = { ...wf.evidence, checks: { sha, text: `skipped by the human: ${reason}`, byHuman: true } }
  }
  if (from === 'smoke' && verb === 'skip') wf.evidence = { ...wf.evidence, smoke: { sha, text: `skipped by the human: ${reason}` } }
  delete wf.blocked
  wf.attempts = 0
  wf.nudges = { count: 0 }
  apply(wf, to, verb, notes)
  save(wf)
  report(wf, config, notes)
}

function skip(wf: Workflow, config: Config, args: Args) {
  const reason = need(args, 'reason')
  const to = afterSkip({ state: wf.state as any, previous: wf.previous as any }, wf.mode as any, wf.steering as any)
  if ('refused' in to) throw new Fail(1, rewrite(to.refused, wf))
  humanMove(wf, config, 'skip', to, reason)
}

function goto(wf: Workflow, config: Config, args: Args) {
  const state = need(args, 'state')
  if (!GOTO.includes(state)) throw new Fail(2, `ndev-flow: goto does not move to "${state}". The states it moves to are ${GOTO.join(', ')}.`)
  humanMove(wf, config, 'goto', { state }, args.reason?.trim() || `moved to ${state}`)
}

function setMode(wf: Workflow, config: Config, args: Args) {
  const mode = need(args, 'mode')
  if (!(mode in MACHINES)) throw new Fail(2, `ndev-flow: "${mode}" is not a mode. The modes are ${Object.keys(MACHINES).join(', ')}.`)
  wf.mode = mode
  save(wf)
  report(wf, config, [`Mode is ${mode}.`])
}

function setHumanSteering(wf: Workflow, config: Config, args: Args) {
  const steering = need(args, 'steering')
  if (steering !== 'auto' && steering !== 'interactive') throw new Fail(2, `ndev-flow: "${steering}" is not a steering. Use auto or interactive.`)
  wf.steering = steering
  save(wf)
  report(wf, config, [`Steering is ${steering}.`])
}

function commentCommand(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const n = Number(args.pr ?? args.on ?? wf.prs[0] ?? wf.issue)
  console.log(comment(wf, n, message))
}

function addMigration(wf: Workflow, config: Config, args: Args) {
  const name = need(args, 'name')
  if (!/^[a-z0-9_]+$/.test(name)) throw new Fail(2, `ndev-flow: the migration name "${name}" must hold only lower-case letters, digits and underscores.`)
  const workdir = join(wf.root, args.workdir ?? '')
  if (!existsSync(join(workdir, 'supabase/config.toml'))) throw new Fail(2, `ndev-flow: ${workdir}/supabase/config.toml does not exist. Repair: pass --workdir <the folder that holds supabase/>.`)
  const dir = join(workdir, 'supabase/migrations')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const newest = readdirSync(dir).map(f => /^(\d{14})_/.exec(f)?.[1]).filter((s): s is string => !!s).sort().pop()
  const version = newest && newest >= stamp ? String(BigInt(newest) + 1n) : stamp
  const path = join(dir, `${version}_${name}.sql`)
  writeFileSync(path, '')
  wf.migrations = [...(wf.migrations ?? []), { name, path: path.slice(wf.root.length + 1) }]
  if (wf.prs[0]) comment(wf, wf.prs[0], `Migration to run after the merge: ${path.slice(wf.root.length + 1)}`)
  save(wf)
  report(wf, config, [`Created ${path}. Write the SQL in it and commit it with ndev-flow checkpoint.`])
}

function requestSecret(root: string, args: Args) {
  const name = need(args, 'name')
  const files = [join(root, '.neil-dev.env'), join(root, '.env'), join(homedir(), '.zshrc'), join(homedir(), '.bashrc')]
  const pattern = new RegExp(`^\\s*(export\\s+)?${name.replace(/[^\w]/g, '')}=`)
  for (const file of files) {
    if (!existsSync(file)) continue
    const line = readFileSync(file, 'utf8').split('\n').findIndex(l => pattern.test(l))
    if (line >= 0) return console.log(`${name} is set in ${file}:${line + 1}`)
  }
  throw new Fail(1, `ndev-flow: ${name} is not set in ${files.join(', ')}. Repair: ask the human to add it to ${files[0]}, which must be git-ignored.`)
}

const CLAUDE_ONLY: Record<string, string> = {
  screenshot: 'Instead, take the screenshots with the browser tool of this harness, or with npx playwright screenshot <url> <file>.',
  iNeedA: `Instead, read ${HOME}/kb/ui-components.md and the brand guide of the project.`,
  reportWorkflowBug: 'Instead, tell the human what ndev-flow did wrong, with the command and its output.',
  hotfix: 'Instead, file the fix with ndev-flow followUp --mode issue_only, and start it in its own worktree with ndev-flow started.',
  create: 'Instead, file the issue with ndev-flow followUp --mode issue_only, or with gh.sh issue-new.',
  off: 'Instead, stop calling ndev-flow for this issue. The record stays in the issue file.',
  wait: `Instead, run the blocking helper for what you wait on: ${WAIT_PR} <pr> --skip-success --json, or ${WAIT_PID} <pid>.`,
  epic: 'Instead, run each sub-issue as its own issue with ndev-flow started, in its own worktree.',
}
function claudeOnly(command: string): string | undefined {
  if (CLAUDE_ONLY[command]) return CLAUDE_ONLY[command]
  if (command.startsWith('waitFor')) return CLAUDE_ONLY.wait
  if (command.startsWith('epic')) return CLAUDE_ONLY.epic
  return undefined
}

const HELP = `ndev-flow: the ndev workflow for ${PROFILE.name}. It keeps the state of each issue in .neil-dev.issue-<n>.json, as the ndev plugin does.
Modes: ${Object.keys(MACHINES).join(', ')}. Flags have the form --name value; --files and --change-types take comma lists.

Agent commands:
  started --issue <n> --short-name <a-b> [--mode light|heavy|hack] [--take-over true]   start or resume; opens the draft PR
  status                                         the state and the next step
  interview                                      end the interview and go on (ask in the chat first)
  finishedInterview                              run the base check before any code
  finishedPlan --file <plan.md>                  heavy: put the plan in the PR body
  checkpoint --message <m> --files <a,b> [--change-types <t,..>]   checks, commit, push
  finishedHacking                                hack: the human agrees that the hack works
  finishedDevelopment --message <m> --files <a,b> [--body-file <f>] [--hardening <t>]   commit, start the review and the dead-code sweep
  finishedReview --review <r> --deadcode <d> --remembered <w>   pre-ready check, push, mark the PR ready
  finishedChecks                                 read the checks of HEAD
  finishedSmoke --report <r> | --skipped <reason>
  finishedRevision
  done --message <summary> [--remembered <w>]
  blocked --message <what the human must do>
  unblocked --message <what changed>
  followUp --mode issue_only|this_agent --message <title\\nbody>
  comment --message <m> [--on <issue or PR>]
  addMigration --name <name> [--workdir <dir>]
  requestSecret --name <NAME>                    where a secret is set; never its value
  setSteering --steering auto --reason <why no human can answer>

Human commands:
  skip --reason <r>     go on past the current phase
  goto --state <s> [--reason <r>]   move the workflow
  mode --mode <m>       change the mode
  steering --steering auto|interactive

Every command but started, requestSecret and help takes --issue <n> when the worktree holds more than one workflow.`

const ISSUE_COMMANDS: Record<string, (wf: Workflow, config: Config, args: Args) => void> = {
  status: (wf, config) => report(wf, config, []),
  interview,
  finishedInterview,
  finishedPlan,
  checkpoint,
  finishedHacking: simpleMove('finishedHacking'),
  finishedDevelopment,
  finishedReview,
  finishedChecks,
  finishedSmoke,
  finishedRevision,
  done,
  blocked,
  unblocked,
  followUp,
  comment: commentCommand,
  addMigration,
  setSteering,
  skip,
  goto,
  mode: setMode,
  steering: setHumanSteering,
}

function main(argv: string[]) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help') return console.log(HELP)
  const instead = claudeOnly(command)
  if (instead) throw new Fail(2, `ndev-flow: ${command} needs the Claude plugin, so this harness does not have it. ${instead}`)
  if (command !== 'started' && command !== 'requestSecret' && !ISSUE_COMMANDS[command]) throw new Fail(2, `ndev-flow: "${command}" is not a command. Repair: run ndev-flow help.`)
  const args = parseArgs(rest)
  const root = topLevel()
  if (command === 'requestSecret') return requestSecret(root, args)
  const config = readConfig(root)
  if (command === 'started') return started(root, config, args)
  const wf = load(root, args)
  const elsewhere = command === 'status' ? undefined : ownedElsewhere(wf)
  if (elsewhere) throw new Fail(1, elsewhere)
  ISSUE_COMMANDS[command]!(wf, config, args)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (error instanceof Fail) {
    console.error(error.message)
    process.exit(error.code)
  }
  throw error
}
