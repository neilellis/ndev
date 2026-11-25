import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const bundled = existsSync(join(HERE, 'profile.json'))
const workflowModules = bundled ? join(HERE, 'workflow') : resolve(HERE, '../../../hooks/workflow')
const { BEFORE_REVIEW, MACHINES, MERGEABLE_BEFORE_DONE, afterSkip, afterStarted, afterTool, baseCheckScript, hooksFiredBy, mayMerge, maySkipReview, needsSmoke, nextStep, orcaView } = await import(join(workflowModules, 'machine.ts'))
const { CHANGE_TYPES, inferChangeTypes, isDocsOnly, isWebPath, requiredSmokeTypes, reviewerBrief } = await import(join(workflowModules, 'change-types.ts'))
const { RECORDS_DIR, citedIds, issueRecordNotes, planLine, recordFileOf, summarise, traceProblems, verificationProblems } = await import(join(workflowModules, 'records.ts'))
const { harnessSession } = await import(join(workflowModules, 'session.ts'))

class Fail extends Error {
  code: number
  repair?: string
  details?: Record<string, unknown>
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const standalone = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
const publicCli = bundled ? undefined : await import('./public.ts')
const epicCli = bundled ? undefined : await import('../../ndev/epic.mjs')
const hooksCli = bundled ? undefined : await import('../../ndev/hooks.mjs')
const sourceRoot = resolve(HERE, '../../..')
const PROFILE = bundled ? JSON.parse(readFileSync(join(HERE, 'profile.json'), 'utf8')) : { name: 'ndev', home: sourceRoot, skillsDir: join(sourceRoot, 'skills'), agentsDir: join(sourceRoot, 'agents') }
const HOME: string = PROFILE.home
const FLOW = standalone ? `${HOME}/bin/ndev-flow` : 'ndev flow'
const CHECK_DIR = 'scripts/ndev/workflow'
const CHECKS = ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh']
const CHECK_MAX_MS = 60 * 60_000
const CHECK_WAIT_SECONDS = 30
const RUN_CHECK = `${HOME}/scripts/workflow/run-check.sh`
const waitChecks = (pr: number | string) => standalone ? `gh pr checks ${pr} --watch --interval 60` : `ndev wait checks ${pr}`
const WAIT_PID = `${HOME}/scripts/work/wait_for_process_end.sh`
const now = () => Date.now()
const OWNER_LIVE_MS = 10 * 60_000
const GOTO = ['setup', 'interviewing', 'planning', 'developing', 'hardening', 'reviewing', 'ci', 'smoke', 'finishing', 'revising', 'done']
const MARK = '<!-- ndev-flow -->'
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

type Run = { status: number; stdout: string; stderr: string }
function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeout?: number } = {}): Run {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: 'utf8', timeout: opts.timeout, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { status: r.error.code === 'ETIMEDOUT' ? 124 : 127, stdout: r.stdout || '', stderr: [r.stderr, r.error.message].filter(Boolean).join('\n') }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
function runBounded(script: string, args: string[], cwd: string, env: Record<string, string>, runDir: string, label: string, capMs: number): Run {
  const started = run('bash', [RUN_CHECK, 'start', runDir, script, ...args], { cwd, env })
  const pid = started.stdout.trim()
  if (started.status !== 0 || !/^\d+$/.test(pid)) throw new Fail(1, `${label} did not start (run-check.sh start exited ${started.status}): ${said(started)}`)
  const begun = now()
  writeFileSync(join(runDir, 'progress.json.tmp'), JSON.stringify({ label, pid: Number(pid), startedAt: begun, limitMs: capMs }))
  renameSync(join(runDir, 'progress.json.tmp'), join(runDir, 'progress.json'))
  const deadline = begun + capMs
  const progressSeconds = Math.max(1, Math.round(envMs('NDEV_FLOW_PROGRESS_MS', CHECK_WAIT_SECONDS * 1000) / 1000))
  let exit: number | undefined
  let stoppedAfterCap = false
  for (;;) {
    const left = deadline - now()
    if (left <= 0) {
      const stop = run('bash', [RUN_CHECK, 'stop', pid])
      if (stop.status !== 0) throw new Fail(1, `run-check.sh stop ${pid} exited ${stop.status} after ${label} ran ${capMs} ms: ${said(stop)}`)
      stoppedAfterCap = true
      break
    }
    const waited = run('bash', [RUN_CHECK, 'wait', runDir, pid, String(Math.max(1, Math.min(progressSeconds, Math.ceil(left / 1000))))])
    if (waited.status === 0) {
      exit = Number(waited.stdout.trim())
      break
    }
    if (waited.status !== 124) throw new Fail(1, `run-check.sh wait ${runDir} ${pid} exited ${waited.status} for ${label}: ${said(waited)}`)
    process.stderr.write(`ndev flow: ${label} still runs after ${span(now() - begun)} of at most ${span(capMs)}.\n`)
  }
  const out = run('bash', [RUN_CHECK, 'out', runDir]).stdout
  const err = run('bash', [RUN_CHECK, 'err', runDir]).stdout
  if (stoppedAfterCap) return { status: 124, stdout: out, stderr: `${err}\n${label} was still running after ${capMs} ms, the most that a check may run, so it was stopped (exit 124).` }
  if (exit === undefined || !Number.isInteger(exit)) throw new Fail(1, `${label} left no readable exit code in ${runDir}/exit.`)
  return { status: exit, stdout: out, stderr: err }
}
const span = (ms: number) => ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`
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
const list = (value?: string) => value?.startsWith('\0') ? value.slice(1).split('\0') : (value ?? '').split(',').map(s => s.trim()).filter(Boolean)

function topLevel(cwd = process.cwd()): string {
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
  if (args.pr) {
    const matches = held.filter(n => readRecord(root, n)?.prs?.includes(Number(args.pr)))
    if (matches.length === 1) return matches[0]!
    if (!matches.length) throw new Fail(2, `PR #${args.pr} has no workflow in ${root}.`)
    throw new Fail(2, `PR #${args.pr} holds issues ${matches.join(', ')}. Choose --issue <n>.`)
  }
  const owned = held.filter(n => readRecord(root, n)?.owner?.session === session())
  if (owned.length === 1) return owned[0]!
  if (held.length === 1) return held[0]!
  if (!held.length) throw new Fail(2, `ndev-flow: no workflow in ${root}. Repair: run ndev-flow started --issue <n> --short-name <two-to-five-words>.`)
  throw new Fail(2, `ndev-flow: ${root} holds the workflows of issues ${held.map(n => `#${n}`).join(', ')}. Repair: add --issue <n>.`)
}
function load(root: string, args: Args): Workflow {
  if (!standalone) {
    const records = publicCli!.readWorkflowRecords(root) as Workflow[]
    const shared = records.filter(record => record.pr)
    if (args.pr) {
      const byPr = shared.find(record => record.pr === Number(args.pr))
      if (byPr) return byPr
    } else if (args.issue) {
      const snapshot = readRecord(root, Number(args.issue))
      const byIssue = shared.find(record => record.pr === snapshot?.prs?.[0] && (record.issue === Number(args.issue) || record.issues?.includes(Number(args.issue))))
      if (byIssue && snapshot?.state === 'developed') return byIssue
    } else {
      const active = records.filter(record => !(record.pr && record.off && records.some(snapshot => !snapshot.pr && snapshot.prs?.[0] !== record.pr && (snapshot.issue === record.issue || record.issues?.includes(snapshot.issue)))))
        .filter(record => record.pr || record.state !== 'developed' || !shared.some(pr => pr.pr === record.prs?.[0] && (pr.issue === record.issue || pr.issues?.includes(record.issue))))
      const owned = active.filter(record => record.owner?.session === session())
      if (owned.length === 1) return owned[0]!
      if (active.length === 1) return active[0]!
    }
  }
  const n = findIssue(root, args)
  const wf = readRecord(root, n)
  if (!wf) throw new Fail(2, `ndev-flow: issue #${n} has no workflow in ${root}. Repair: run ndev-flow started --issue ${n} --short-name <two-to-five-words>.`)
  return wf
}
const session = () => standalone ? `ndev-flow:${PROFILE.name}` : harnessSession(process.env) || `ndev-terminal:${process.ppid}`
function ownedElsewhere(wf: Workflow): string | undefined {
  const owner = wf.owner
  if (!owner || owner.session === session() || typeof owner.at !== 'number' || now() - owner.at >= OWNER_LIVE_MS) return undefined
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
  if (r.status !== 0) throw new Fail(1, `ndev-flow: gh.sh ${args.slice(0, 2).join(' ')} exited ${r.status}: ${said(r)}`)
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
type Pr = { number: number; state: string; merged?: boolean; draft?: boolean; mergeable?: boolean | null; body?: string | null; created_at: string; base?: { ref: string }; head: { sha: string; ref: string; crossRepository?: boolean } }
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
  wf.owner = { session: session(), at: now() }
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
  const r = runBounded(script, args, wf.root, env, join(dir, `ndev-${check}.run`), path, envMs('NDEV_FLOW_CHECK_MAX_MS', CHECK_MAX_MS))
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
  const names = files.map(file => relative(wf.root, resolve(wf.root, file)))
  if (names.some(name => name === '..' || name.startsWith('../'))) throw new Fail(2, `Paths must belong to ${wf.root}: ${files.join(', ')}.`)
  const staged = git(wf.root, 'diff', '--cached', '--name-only', '--no-renames', '-z')
  if (staged.status !== 0) throw new Fail(1, `git diff --cached exited ${staged.status}: ${said(staged)}`)
  const other = staged.stdout.split('\0').filter(path => path && !names.some(name => !name || path === name || path.startsWith(name + '/')))
  if (other.length) throw new Fail(1, `Checkpoint would include other staged paths: ${other.join(', ')}. Repair: name those paths or unstage them before retrying.`)
  const known = (...args: string[]) => {
    const r = git(wf.root, '--literal-pathspecs', ...args)
    if (r.status !== 0) throw new Fail(1, `git ${args.join(' ')} exited ${r.status}: ${said(r)}`)
    return r.stdout.trim() !== ''
  }
  const toAdd = names.filter(name => existsSync(join(wf.root, name)) || known('ls-files', '--', name || '.'))
  const unknown = names.filter(name => !toAdd.includes(name) && !known('log', '-1', '--format=%H', 'HEAD', '--', name))
  if (unknown.length) throw new Fail(1, `ndev-flow: ${unknown.join(', ')} is not in the worktree, the index or the history of ${wf.branch}. Nothing was committed. Repair: name only paths that this change adds, edits, deletes or renames.`)
  if (toAdd.length) gitOk(wf.root, '--literal-pathspecs', 'add', '-A', '--', ...toAdd.map(name => name || '.'))
  const changed = git(wf.root, 'diff', '--cached', '--quiet')
  if (changed.status > 1) throw new Fail(1, `git diff --cached exited ${changed.status}: ${said(changed)}`)
  return changed.status === 1 || git(wf.root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0
}
function commit(wf: Workflow, message: string, op: string, empty = false) {
  const r = git(wf.root, 'commit', ...(empty ? ['--allow-empty'] : []), '-m', message, '--trailer', `Ndev-Op: ${op}`)
  if (r.status !== 0) throw new Fail(1, `git commit exited ${r.status}: ${said(r)}. Nothing was pushed.`)
}
function push(wf: Workflow, retryRebase = false, source = 'HEAD', options: string[] = []): string | undefined {
  const ref = `refs/heads/${wf.branch}`
  const pushArgs = ['origin', `${source}:${ref}`]
  const push = (options: string[]) => run('git', ['push', '-u', ...options, ...pushArgs], { cwd: wf.root, timeout: 300_000 })
  const result = push(options)
  if (result.status === 0) return
  const problem = `git push to origin ${wf.branch} exited ${result.status}: ${said(result)}`
  if (!retryRebase || wf.branch === wf.base || !/\[rejected\].*\((non-fast-forward|fetch first)\)/.test(result.stderr)) {
    throw new Fail(1, `${problem}. Repair: resolve the push error and retry. The commit is local.`)
  }
  gitOk(wf.root, 'fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*')
  const advertised = gitOk(wf.root, 'ls-remote', '--heads', 'origin').split('\n').filter(Boolean).map(line => line.split('\t'))
  const expected = advertised.find(([, name]) => name === ref)?.[0]
  if (!expected) throw new Fail(1, `${problem}. Remote ${ref} disappeared after the push. The local commit was kept.`)
  const others = advertised.filter(([, name]) => name !== ref).map(([sha]) => sha!)
  const only = gitOk(wf.root, 'rev-list', expected, '--not', 'HEAD', ...others).split('\n').filter(Boolean)
  const matches = new Set(gitOk(wf.root, 'cherry', 'HEAD', expected).split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)))
  const missing = only.filter(sha => !matches.has(sha))
  if (missing.length) {
    const commits = gitOk(wf.root, 'log', '--no-walk', '--format=%H %s', ...missing)
    throw new Fail(1, `${problem}. Remote commits would be lost:\n${commits}\nRepair: git pull --rebase origin ${wf.branch}, then retry the checkpoint. The commit is local.`)
  }
  const forced = push([`--force-with-lease=${ref}:${expected}`])
  if (forced.status !== 0) throw new Fail(1, `git push --force-with-lease of ${wf.branch} (expected ${expected}) exited ${forced.status}: ${said(forced)}. The commit is local. Repair: retry the checkpoint to inspect the new remote head.`)
  return `Updated ${wf.branch} with a lease on ${expected}; ${only.length} remote-only commits matched patches in HEAD.`
}
const opId = (wf: Workflow, tool: string) => `${tool}-${wf.issue}-${randomUUID()}`
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
  const scripts = join(PROFILE.skillsDir, bundled ? 'ndev-deadcode' : 'deadcode', 'scripts')
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

function scanLoweredBar(wf: Workflow): string {
  const script = join(PROFILE.skillsDir, bundled ? 'ndev-adversarial-review' : 'adversarial-review', 'scripts', 'lowered-bar.mjs')
  const r = run(process.execPath, [script, `origin/${wf.base}`], { cwd: wf.root, timeout: 120_000 })
  const out = `${r.stdout}\n${r.stderr}`.trim()
  if (r.status === 0) return out
  if (r.status === 1 && r.stdout.trim() && !r.stderr.trim()) return `Lowered-bar scan:\n${out}`
  return `Lowered-bar scan did not measure: it exited ${r.status}. This is not a pass. Run node ${script} origin/${wf.base} in the worktree and check the diff by hand.\n${out}`
}

const AXES: Record<string, string> = {
  review: 'Review the change for correctness, security and simplification.',
  standards: 'Axis: standards. Check that the change follows the documented standards of this repository (AGENTS.md, CLAUDE.md, CONTRIBUTING and the like).',
  specification: 'Axis: specification. Check that the change does what the issue asks, all of it and nothing else. When the plan has a "Requirements:" line, read each record that it names in docs/formal/requirements and check that the diff meets its Statement. When the plan has a "Model:" line, check that the PR body proves each new invariant with a mutant and each witness with a run that reaches it.',
}
function reviewerFile(): string | undefined {
  const dir = PROFILE.agentsDir
  if (!dir) return undefined
  return [join(dir, 'ndev-diff-reviewer.toml'), join(dir, 'ndev-diff-reviewer.md'), join(dir, 'diff-reviewer.md')].find(existsSync)
}
const MAX_REVIEW_ROUNDS = 3
function reviewRounds(wf: Workflow): number {
  if (typeof wf.reviewRounds === 'number') return wf.reviewRounds
  if (!wf.exportReview) return 0
  return 1 + wf.history.filter(({ tool, from, to }) => tool === 'checkpoint' && from === 'reviewing' && to === 'reviewing').length
}
const reviewLimitNotice = `The limit of ${MAX_REVIEW_ROUNDS} review rounds has been reached. No more reviews will start. Use ndev-flow finishedReview --waive-review "<reason>" for nitpicks after checking the current diff, or report any substantive blocker.`
function startReview(wf: Workflow): string[] {
  const sha = headSha(wf.root)
  if (wf.exportReview?.sha === sha) return []
  const rounds = reviewRounds(wf)
  if (rounds >= MAX_REVIEW_ROUNDS) {
    wf.reviewRounds = rounds
    wf.deadcode = { sha, results: sweepDeadCode(wf) }
    return [reviewLimitNotice, sweepText(wf.deadcode.results), scanLoweredBar(wf)]
  }
  const lowered = scanLoweredBar(wf)
  const issue = ghJson<{ title: string; body: string | null }>(wf.root, wf.repo, ['issue-read', String(wf.issue)])
  const axes = MACHINES[wf.mode as 'light'].twoAxisReview ? ['standards', 'specification'] : ['review']
  const dir = gitDir(wf.root)
  const reviewer = reviewerFile()
  const runs = axes.map(axis => {
    const brief = join(dir, `ndev-review-${wf.issue}-${axis}.md`)
    const out = join(dir, `ndev-review-${wf.issue}-${axis}.out.md`)
    const log = join(dir, `ndev-review-${wf.issue}-${axis}.log`)
    rmSync(out, { force: true })
    writeFileSync(brief, [
      `# Review of issue #${wf.issue}: ${issue.title}`,
      'You are an independent reviewer. Read only: do not edit, commit or push. Report Critical and Important findings, each with file:line, the failure and the fix. If you find none, say so.',
      `Worktree: ${wf.root}`,
      `The change: run git diff origin/${wf.base}...HEAD in the worktree. HEAD is ${sha}, and its last commit is not pushed yet.`,
      AXES[axis],
      lowered,
      ...(axis === 'specification' ? [] : [
        `North Star: Check the diff against origin/${wf.base}:NORTH_STAR.md. Scan the headings and read only the sections that apply. Follow any sources the file gives priority.`,
        'If the diff adds, edits, or removes the file, check that change against owner approval. Use the base rules for the rest of the diff unless the owner approved a change to those rules.',
        'For a conflict, cite the section and the changed file and line. Record the sections you checked, no applicable sections, file absent, or an access failure. When the file is absent, use the remaining project guidance.',
      ]),
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
  wf.reviewRounds = rounds + 1
  wf.exportReview = { sha, at: now(), runs }
  if (!standalone) {
    wf.hooks = { ...wf.hooks, review: { firedAt: now() }, remember: { firedAt: now() } }
    if (inOrca()) ensureReviewWorkers(wf)
  }
  wf.deadcode = { sha, results: sweepDeadCode(wf) }
  return [sweepText(wf.deadcode.results), lowered]
}
function reviewText(wf: Workflow): string {
  const waiver = 'For nitpicks, you can use ndev-flow finishedReview --waive-review "<reason>". The pre-ready checks still run.'
  if (reviewRounds(wf) >= MAX_REVIEW_ROUNDS && wf.exportReview?.sha !== headSha(wf.root)) return reviewLimitNotice
  const runs: { axis: string; brief: string; out: string; log: string; pid?: number; agentId?: string; answer?: string }[] = wf.exportReview?.runs ?? []
  if (!runs.length) return `ndev-flow started no review. ${waiver}`
  if (!standalone && runs.some(r => 'dispatchId' in r)) return wf.exportReview.runs.map((r: {axis: string; dispatchId: string}) => `${r.axis} reviewer ${r.dispatchId}. Wait with ndev wait agent dispatch:${r.dispatchId} and read its report.`).join(' ') + ' ' + waiver
  if (!runs[0]!.pid) {
    const waiting = runs.filter(r => r.answer === undefined)
    const answers = runs.filter(r => r.answer !== undefined).map(r => `The ${r.axis === 'review' ? 'review' : `${r.axis} review`} by subagent ${r.agentId} has answered, and the record keeps it:\n${r.answer}\n`)
    const start = waiting.length ? `This harness has no review command, so ndev-flow wrote the brief${waiting.length > 1 ? 's' : ''} and started nothing: ${waiting.map(r => r.brief).join(', ')}. Give each brief to an independent reviewer (a subagent of this harness, or another agent) and keep the reports apart.` : ''
    return [...answers, start, waiver].filter(Boolean).join(' ')
  }
  const each = runs.map(r => `${r.axis === 'review' ? 'the review' : `the ${r.axis} review`} (pid ${r.pid}): wait with ${WAIT_PID} ${r.pid}, then read ${r.out} (log ${r.log})`).join('; ')
  return `ndev-flow started ${runs.length === 1 ? 'one independent review' : `the two-axis review, ${runs.length} reviewers`} with the review command of this harness: ${each}. Do not start another review.${runs.length > 1 ? ' Keep the reports apart.' : ''} The wait is one blocking call, not a loop. ${waiver}`
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
  const { check_runs: runs = [], statuses = [] } = ghJson<{ check_runs?: { name: string; status: string; conclusion: string | null; started_at?: string | null }[]; statuses?: { context: string; state: string }[] }>(wf.root, wf.repo, ['commit-checks', sha, ...(wf.direct ? [] : ['--pr', String(prOf(wf))])])
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
function greenOrFail(wf: Workflow, sha: string): Checks {
  const pushed = git(wf.root, 'rev-parse', `origin/${wf.branch}`)
  if (pushed.status !== 0 || pushed.stdout.trim() !== sha) throw new Fail(1, `HEAD ${sha.slice(0, 8)} is not pushed to origin/${wf.branch}, so no check runs on it. Repair: commit and push with ndev-flow checkpoint.`)
  const pr = wf.direct ? { mergeable: true } : readPr(wf, prOf(wf))
  if (!standalone && !wf.direct) confirmPrHead(wf, pr as Pr, sha)
  if (pr.mergeable === false) throw new Fail(1, `PR #${prOf(wf)} has merge conflicts with ${wf.base}. Merge origin/${wf.base} into the branch, resolve them (the ndev-resolving-merge-conflicts skill), and commit with ndev-flow checkpoint.`)
  const checks = readChecks(wf, sha)
  if (wf.direct && (checks.red.length || checks.pending.length)) throw new Fail(1, `Checks on ${sha} in ${wf.base}: ${[...checks.red, ...checks.pending].join(', ')}. Rerun ndev flow finished-checks when green.`)
  if (checks.red.length) throw new Fail(1, `Checks failed on ${sha.slice(0, 8)}: ${checks.red.join(', ')}. Fix each one and commit with ndev-flow checkpoint, then wait with ${waitChecks(prOf(wf))}.`)
  if (checks.pending.length) throw new Fail(1, `Checks still run on ${sha.slice(0, 8)}: ${checks.pending.join(', ')}. Wait with one blocking call: ${waitChecks(prOf(wf))}. Then run ndev-flow finishedChecks again.`)
  return checks
}
const changedPaths = (wf: Workflow) => git(wf.root, 'diff', '--name-only', `origin/${wf.base}...HEAD`).stdout.split('\n').filter(Boolean)

function rewrite(text: string, wf?: Workflow): string {
  const pr = wf?.prs?.[0] ?? '<pr>'
  return text
    .replace(/The plugin started [^:]+:[\s\S]*?because its answer comes to you\./, () => (wf ? reviewText(wf) : 'ndev-flow started the review.'))
    .replaceAll('The plugin ran the dead-code sweep', 'ndev-flow ran the dead-code sweep')
    .replaceAll('When the answer comes,', 'When the review ends,')
    .replace(/Do not run a wait helper: the workflow watches[^.]*\. If nothing else is open, end your turn\. When it prompts you,/, standalone ? `Nothing watches the checks for you in this harness. Wait for them with one blocking call: ${waitChecks(pr)}. It can return before the first check starts. ndev-flow finishedChecks reads the newest run of each check and says when to wait again. When it returns,` : `Wait for the checks with one blocking call: ${waitChecks(pr)}. It reads the newest run of each check, and exits 1 with the failed check and its log URL. When it returns,`)
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
    wf.off ? `Off for this issue: ${wf.off.reason}.` : '',
    wf.blocked?.message ? `Blocked: ${wf.blocked.message}` : '',
    `State: ${wf.state}${wf.previous ? ` (then ${wf.previous})` : ''}. Issue #${wf.issue}, mode ${wf.mode}, steering ${wf.steering}.`,
    wf.prs[0] ? `PR: ${prUrl(wf)}` : wf.prTitle ? 'PR: none yet. The first push opens the draft PR.' : '',
    ...notes.filter(Boolean),
    `Next: ${rewrite(nextStep(wf.state as any, facts(wf, config) as any), wf)}`,
    standalone ? `ndev-flow is ${FLOW}. Each tool named above is one of its commands: ndev-flow <tool> --name value. Run ndev-flow help for the flags.` : '',
  ]
  const text = lines.filter(Boolean).join('\n')
  return { root: wf.root, issue: wf.issue, state: wf.state, workflow: wf, notes, next: modernText(rewrite(nextStep(wf.state, facts(wf, config)), wf)), text: standalone ? text : modernText(text) }
}

function resolveRepo(root: string, config: Config): string {
  if (config.github?.repo) return config.github.repo
  if (process.env.GH_REPO) return process.env.GH_REPO
  return ghJson<{ repo: string }>(root, undefined, ['repo']).repo
}

function setUpPr(wf: Workflow, title: string) {
  if (wf.direct || wf.prs.length) return
  const open = ghRun(wf.root, wf.repo, ['pr-list', '--head', wf.branch, '--state', 'open']).split('\n').filter(Boolean).map(line => JSON.parse(line) as { number: number })
  if (open[0]) {
    wf.prs = [open[0].number]
    if (!standalone) {
      const pr = readPr(wf, open[0].number)
      if (pr.head.ref !== wf.branch || pr.state !== 'open') throw new Fail(1, `PR #${pr.number} is ${pr.state} on ${pr.head.ref}. Refusing to join it from ${wf.branch}.`)
      if (!hasIssueRef(pr.body ?? '', wf.issue) && !namesPart(pr.body ?? '', wf.issue)) gh(wf, ['pr-edit', String(pr.number), '--body-file', writeTemp(wf, 'pr-body.md', `${(pr.body || '').trimEnd()}\n\nCloses #${wf.issue}\n`)])
    }
    return
  }
  if (gitOk(wf.root, 'rev-list', '--count', `origin/${wf.base}..HEAD`) === '0') {
    wf.prTitle = title
    return
  }
  if (git(wf.root, 'rev-parse', `origin/${wf.branch}`).stdout.trim() !== headSha(wf.root)) {
    runCheck(wf, 'pre-push-check.sh', [], wf.changeTypes ?? [])
    push(wf)
  }
  const body = writeTemp(wf, 'pr-body.md', wf.prBody ?? `Plan incoming.\n\nCloses #${wf.issue}\n`)
  const made = ghRun(wf.root, wf.repo, ['pr-new', '--title', title, '--body-file', body, '--base', wf.base, '--head', wf.branch])
  const number = /\/pull\/(\d+)/.exec(made)?.[1]
  if (!number) throw new Fail(1, `ndev-flow: gh.sh pr-new printed no pull request URL: ${made.slice(0, 200)}`)
  wf.prs = [Number(number)]
  delete wf.prTitle
  delete wf.prBody
}

function openPendingPr(wf: Workflow) {
  if (!wf.prTitle || wf.prs.length) return
  setUpPr(wf, wf.prTitle)
  if (!wf.prs.length) throw new Fail(1, `Issue #${wf.issue} on ${wf.branch} has no commits beyond ${wf.base}. Repair: make a real change and run ndev flow checkpoint.`)
  save(wf)
}

function started(root: string, config: Config, args: Args) {
  if (config.workflow === false) throw new Fail(2, `ndev-flow: ${root}/.neil-dev.json sets "workflow": false, so this project works without the workflow. Repair: remove that key to use ndev-flow.`)
  const issue = findIssue(root, args)
  const notes: string[] = []
  let wf = readRecord(root, issue)
  if (wf) {
    wf.mode ??= config.mode ?? 'light'
    wf.steering ??= config.steering ?? 'interactive'
    const elsewhere = ownedElsewhere(wf)
    if (elsewhere && args['take-over'] !== 'true') throw new Fail(1, elsewhere)
    if (elsewhere) notes.push(`Took over from ${wf.owner.session}.`)
  }
  if (wf && wf.state !== 'setup') {
    if (!wf.prs.length && !wf.direct && wf.state !== 'done') {
      setUpPr(wf, ghJson<{ title: string }>(root, wf.repo, ['issue-read', String(issue)]).title)
      if (wf.prs.length) notes.push(`Opened ${prUrl(wf)}.`)
    }
    const pr = wf.state === 'done' && !wf.direct && wf.prs.length ? readPr(wf, prOf(wf)) : undefined
    const prConflict = pr?.state === 'open' && pr.mergeable === false
    if (prConflict) notes.push(`PR #${pr.number} has conflicts with ${wf.base}. Merge origin/${wf.base} into this branch, resolve the conflicts, and run ${FLOW} checkpoint.`)
    const to = afterStarted({ state: wf.state as any, previous: wf.previous as any }, { mode: wf.mode as any, steering: wf.steering as any, prConflict })
    if (to.state !== wf.state) apply(wf, to, 'started', notes)
    wf.owner = { session: session(), at: now() }
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
    if (branch === base && (standalone || config.projectLevel !== 'straw_man')) throw new Fail(2, `ndev-flow: ${root} is on the base branch ${base}, and each issue needs its own branch. Repair: git switch -c ${issue}-${shortName}`)
    wf = { issue, root, repo, base, branch, ...(branch === base ? { direct: true } : {}), prs: [], shortName, state: 'setup', owner: { session: session(), at: now() }, evidence: {}, attempts: 0, nudges: { count: 0 }, followUps: [], migrations: [], history: [], mode, steering }
  }
  const info = ghJson<{ title: string; state: string; body?: string }>(root, wf.repo, ['issue-read', String(issue)])
  if (info.state !== 'open') throw new Fail(1, `Issue #${issue} is ${info.state}. Reopen it before starting.`)
  notes.push(...issueRecords(root, issue, info.body ?? ''))
  const fetched = git(root, 'fetch', '-q', 'origin', wf.base)
  if (!standalone && fetched.status !== 0) throw new Fail(1, `git fetch origin ${wf.base} exited ${fetched.status}: ${said(fetched)}. Repair the remote and retry.`)
  if (fetched.status !== 0) notes.push(`git fetch origin ${wf.base} exited ${fetched.status}: ${said(fetched)}. The checks compare with an old base.`)
  const missing = CHECKS.filter(c => !existsSync(join(root, CHECK_DIR, c)))
  if (missing.length) {
    apply(wf, afterStarted(undefined, { mode: wf.mode as any, steering: wf.steering as any, scriptsMissing: true }), 'started', notes)
    save(wf)
    return report(wf, config, [`Missing check scripts in ${root}/${CHECK_DIR}: ${missing.join(', ')}. Start each from the template ${HOME}/scripts/workflow/fast-checks-template.sh.`])
  }
  if (!standalone) save(wf)
  setUpPr(wf, info.title)
  apply(wf, afterStarted(undefined, { mode: wf.mode as any, steering: wf.steering as any }), 'started', notes)
  save(wf)
  return report(wf, config, [`Issue #${issue}: ${info.title}`, ...notes])
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
  const branch = gitOk(wf.root, 'branch', '--show-current')
  const localBranch = wf.localBranch || wf.branch
  if (branch !== localBranch || (branch === wf.base && !wf.direct)) throw new Fail(1, `Checkpoint for #${wf.issue} expects ${localBranch}, found ${branch || 'detached HEAD'} (base ${wf.base}). Repair: git switch ${localBranch}.`)
  const op = wf.op?.tool === 'checkpoint' ? wf.op : { id: opId(wf, 'checkpoint'), tool: 'checkpoint' }
  wf.op = op
  save(wf)
  const held = gitOk(wf.root, 'log', '-1', '--format=%H', `--grep=^Ndev-Op: ${op.id}$`)
  const notes: string[] = []
  if (stage(wf, files)) {
    try {
      const note = runCheck(wf, 'fast-checks.sh', files, declared)
      if (note) notes.push(note)
    } catch (error) {
      if (!localOnly || !(error instanceof Fail) || error.name !== CHECK_FAILED) throw error
      notes.push(`Advice only, in this state: ${error.message}`)
    }
    if (!localOnly) {
      const note = runCheck(wf, 'pre-commit-check.sh', [], declared)
      if (note) notes.push(note)
    }
    commit(wf, message, op.id)
  } else {
    if (!held || held !== headSha(wf.root)) throw new Fail(1, `ndev-flow: ${files.join(', ')} hold no change to commit. Repair: name the changed files in --files.`)
    const dirty = gitOk(wf.root, 'diff', '--name-only')
    if (dirty) throw new Fail(1, `The worktree changed after commit ${held}: ${dirty}. Repair: name the changes before retrying.`)
    notes.push(`Resuming checkpoint of ${held}.`)
  }
  if (pushes) {
    const note = runCheck(wf, 'pre-push-check.sh', [], declared)
    if (note) notes.push(note)
    const lease = push(wf, true)
    if (lease) notes.push(lease)
    openPendingPr(wf)
    notes.push(`Committed and pushed ${headSha(wf.root).slice(0, 8)}.`)
  } else notes.push(`Committed ${headSha(wf.root).slice(0, 8)} on this computer only: in the state "${wf.state}" nothing is pushed.`)
  delete wf.op
  if (!standalone && wf.state === 'reviewing' && wf.exportReview?.sha !== headSha(wf.root)) notes.push(...startReview(wf))
  addTypes(wf, files, declared)
  apply(wf, to, 'checkpoint', notes)
  save(wf)
  return report(wf, config, notes)
}

function requireDevelopmentConfirmation(wf: Workflow, config: Config, args: Args) {
  if ((wf.steering ?? config.steering ?? 'interactive') === 'interactive' && !args['human-confirmation']?.trim()) {
    throw new Fail(1, `Issue #${wf.issue} needs human confirmation before final checks or review. Show a concrete development preview when relevant, ask whether the work is done, and keep developing if the human requests changes. Only after the human confirms, run ndev flow finished-development --issue ${wf.issue} --human-confirmation "<the human's confirmation>" with the changed files and commit message.`)
  }
}

function finishedDevelopment(wf: Workflow, config: Config, args: Args, member = false) {
  requireDevelopmentConfirmation(wf, config, args)
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
  if ((wf.steering ?? config.steering ?? 'interactive') === 'interactive') wf.developmentConfirmation = args['human-confirmation'].trim()
  addTypes(wf, files, declared)
  if (machine.hardens) runCheck(wf, 'pre-push-check.sh', [], declared)
  openPendingPr(wf)
  if (machine.gates && !wf.direct) {
    const gates = run('bash', [`${HOME}/scripts/work/gates.sh`, String(wf.issue), 'HEAD', String(prOf(wf))], { cwd: wf.root, env: { GH_REPO: wf.repo } })
    if (gates.status !== 0) throw new Fail(1, `gates.sh exited ${gates.status} for #${wf.issue}: ${said(gates)}\nThe commit is held here and not pushed. Add what is missing, then run ndev-flow finishedDevelopment again.`)
  }
  if (args['body-file'] && !wf.direct) {
    const text = standalone ? readFileSync(args['body-file'], 'utf8') : publicCli!.inputFile(args['body-file'])
    const body = hasIssueRef(text, wf.issue) || namesPart(text, wf.issue) ? text : `${text.trimEnd()}\n\nCloses #${wf.issue}\n`
    gh(wf, ['pr-edit', String(prOf(wf)), '--body-file', writeTemp(wf, 'pr-body.md', body)])
    notes.push('The PR body is updated.')
  }
  if (!wf.direct && wf.prs.length) {
    const traced = planTraceProblems(wf, readPr(wf, prOf(wf)).body ?? '')
    if (traced.length) throw new Fail(1, `ndev-flow: a record that this PR fulfils does not link it:\n- ${traced.join('\n- ')}\nThe commit is held here and not pushed. Run ndev-flow finishedDevelopment again with the record in --files.`)
  }
  if (args.hardening && !wf.direct) comment(wf, prOf(wf), `Hardening evidence:\n\n${args.hardening}`)
  apply(wf, member ? { state: 'developed' } : to, 'finishedDevelopment', notes)
  save(wf)
  return report(wf, config, notes)
}

function pushDraft(wf: Workflow, config: Config, args: Args) {
  const sha = need(args, 'sha')
  const review = need(args, 'review')
  if (wf.state !== 'reviewing' || wf.direct || wf.branch === wf.base || !wf.prs[0]) {
    throw new Fail(1, `Issue #${wf.issue} needs a draft PR in review. Run ndev flow status --issue ${wf.issue}.`)
  }
  const prNumber = prOf(wf)
  const assertDraft = () => {
    const pr = readPr(wf, prNumber)
    if (pr.state !== 'open' || pr.draft !== true || pr.head?.ref !== wf.branch || pr.head.crossRepository !== false) {
      throw new Fail(1, `Expected open draft PR #${prNumber} on this repository's ${wf.branch} branch. Check the PR and retry.`)
    }
    const fetchUrl = gitOk(wf.root, 'remote', 'get-url', '--all', 'origin')
    const pushUrl = gitOk(wf.root, 'remote', 'get-url', '--push', '--all', 'origin')
    if (!fetchUrl || fetchUrl.includes('\n') || fetchUrl !== pushUrl) {
      throw new Fail(1, 'Draft pushes require one matching fetch and push URL for origin. Check git remote get-url --push --all origin and fix the origin configuration.')
    }
    const originRepo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|ssh:\/\/git@ssh\.github\.com:443\/)([^/\s]+\/[^/\s]+)\/?$/i.exec(pushUrl)?.[1]?.replace(/\.git$/i, '')
    if (originRepo?.toLowerCase() !== wf.repo.toLowerCase()) {
      throw new Fail(1, `Origin must point to GitHub repository ${wf.repo} for draft PR #${prNumber}. Check git remote get-url --push origin and fix the origin configuration.`)
    }
    const ref = `refs/heads/${wf.branch}`
    const remote = gitOk(wf.root, 'ls-remote', '--refs', 'origin', ref)
    if (remote !== `${pr.head.sha}\t${ref}`) {
      throw new Fail(1, `Origin does not advertise the head of draft PR #${prNumber} (${pr.head.sha}). Check that origin points to ${wf.repo} and retry.`)
    }
  }
  const assertLocal = () => {
    if (sha !== headSha(wf.root) || gitOk(wf.root, 'branch', '--show-current') !== (wf.localBranch || wf.branch)) {
      throw new Fail(1, `Expected reviewed commit ${sha} at HEAD on ${wf.localBranch || wf.branch}. Check out the workflow branch and supply its full reviewed SHA.`)
    }
    if (gitOk(wf.root, 'status', '--porcelain', '--untracked-files=all')) {
      throw new Fail(1, `Issue #${wf.issue} needs a clean worktree to check the reviewed commit ${sha}. Save local changes separately before retrying.`)
    }
  }
  assertDraft()
  assertLocal()
  const path = `${CHECK_DIR}/pre-push-check.sh`
  if (wf.noChecks && !existsSync(join(wf.root, path))) {
    throw new Fail(1, `${path} is missing. Add the pre-push check before using push-draft.`)
  }
  const note = runCheck(wf, 'pre-push-check.sh', [], wf.changeTypes ?? [])
  assertDraft()
  assertLocal()
  push(wf, false, sha, ['--no-follow-tags', '--recurse-submodules=no'])
  return report(wf, config, [
    ...(note ? [note] : []),
    `Pushed reviewed commit ${sha} to draft PR #${prNumber} after the pre-push check. Review: ${review}`,
    'Run finished-review to apply the normal pre-ready gate and mark the PR ready.',
  ])
}

function finishedReview(wf: Workflow, config: Config, args: Args) {
  const waived = args['waive-review'] !== undefined
  if (waived && args.review !== undefined) throw new Fail(2, 'Choose either --review or --waive-review.')
  const review = waived ? `Independent review waived: ${need(args, 'waive-review')}` : need(args, 'review')
  const fields = { review, deadcode: need(args, 'deadcode'), remembered: need(args, 'remembered') }
  const to = moveFor(wf, config, 'finishedReview')
  const reviewed = headSha(wf.root)
  if (!waived && wf.exportReview?.sha && wf.exportReview.sha !== reviewed) {
    if (reviewRounds(wf) >= MAX_REVIEW_ROUNDS) throw new Fail(1, reviewLimitNotice)
    if (!standalone) throw new Fail(1, `Review covers ${wf.exportReview.sha}, but HEAD is ${reviewed}. Review the current commit before recording evidence or give a reason with --waive-review.`)
  }
  if (!waived && !standalone && wf.exportReview?.runs?.some((r: Record<string, unknown>) => r.dispatchId || r.starting)) {
    ensureReviewWorkers(wf)
    for (const reviewer of wf.exportReview.runs) {
      const receipt = orca(wf.root, reviewer.environment, ['orchestration', 'worker-show', '--dispatch', reviewer.dispatchId, '--full'])
      if (!['completed', 'done', 'settled', 'succeeded', 'finished'].includes(receipt.state)) throw new Fail(1, `Reviewer ${reviewer.dispatchId} is ${receipt.state}: ${receipt.lastError || receipt.recovery || 'wait with ndev wait agent dispatch:' + reviewer.dispatchId}.`)
    }
  }
  const alive = waived ? [] : reviewAlive(wf)
  if (alive.length) throw new Fail(1, `ndev-flow: the review still runs: ${alive.join(', ')}. Wait with ${WAIT_PID} <pid>, read its report, then run ndev-flow finishedReview again.`)
  if (!wf.direct) assertRemoteHeld(wf, reviewed)
  const notes: string[] = []
  const mergeBase = mergeBaseOf(wf)
  const receipt = wf.preReady
  let note: string | undefined
  if (receipt?.sha === reviewed && receipt.mergeBase === mergeBase && !git(wf.root, 'status', '--porcelain').stdout) {
    note = receipt.note
    notes.push(`pre-ready-check.sh already passed on ${reviewed.slice(0, 8)}, so it is not rerun.`)
  } else {
    note = runCheck(wf, 'pre-ready-check.sh', [], wf.changeTypes ?? [])
    if (!standalone) assertHead(wf, reviewed)
    wf.preReady = { sha: reviewed, mergeBase, at: now(), ...(note ? { note } : {}) }
    save(wf)
  }
  if (note) notes.push(note)
  push(wf)
  const sha = headSha(wf.root)
  if (!wf.direct) {
    if (!standalone) awaitPrHead(wf, sha)
    gh(wf, ['pr-ready', String(prOf(wf))])
  }
  const text = `review: ${fields.review}\ndeadcode: ${fields.deadcode}\nremembered: ${fields.remembered}`
  if (!wf.direct) comment(wf, prOf(wf), `Review of ${sha.slice(0, 8)}\n\n${text}`)
  if (!standalone) {
    assertHead(wf, reviewed)
    if (!wf.direct) confirmPrHead(wf, readPr(wf, prOf(wf)), reviewed)
  }
  delete wf.preReady
  wf.evidence = { ...wf.evidence, review: { sha, text } }
  const firedAt = now()
  wf.hooks = { ...wf.hooks, review: { firedAt: wf.hooks?.review?.firedAt ?? firedAt, result: fields.review.slice(0, 2000) }, remember: { firedAt: wf.hooks?.remember?.firedAt ?? firedAt, result: fields.remembered.slice(0, 2000) } }
  notes.push(wf.direct ? `Pushed ${sha} to ${wf.base}.` : `Pushed ${sha.slice(0, 8)} and marked PR #${prOf(wf)} ready.`)
  apply(wf, to, 'finishedReview', notes)
  save(wf)
  return report(wf, config, notes)
}

function finishedChecks(wf: Workflow, config: Config) {
  moveFor(wf, config, 'finishedChecks')
  const sha = headSha(wf.root)
  const checks = greenOrFail(wf, sha)
  const smoke = needsSmoke(wf.mode as any, changedPaths(wf), checks.names, (wf.changeTypes ?? []) as any)
  const to = moveFor(wf, config, 'finishedChecks', { smoke })
  if (!standalone) {
    assertHead(wf, sha)
    if (!wf.direct) confirmPrHead(wf, readPr(wf, prOf(wf)), sha)
  }
  wf.evidence = { ...wf.evidence, checks: { sha, text: `green: ${checks.green.join(', ') || 'none ran'}` } }
  const notes = [`Checks are green on ${sha.slice(0, 8)}: ${checks.green.join(', ') || 'none ran'}.`]
  apply(wf, to, 'finishedChecks', notes)
  save(wf)
  return report(wf, config, notes)
}

function finishedSmoke(wf: Workflow, config: Config, args: Args) {
  const to = moveFor(wf, config, 'finishedSmoke')
  const required = MACHINES[wf.mode as 'light'].alwaysSmoke || requiredSmokeTypes((wf.changeTypes ?? []) as any).length > 0
  const sha = headSha(wf.root)
  if (!args.report && !args.skipped) throw new Fail(2, 'ndev-flow: finishedSmoke needs --report <what you tested, with the URL> or --skipped <reason>.')
  if (args.skipped && required) throw new Fail(2, 'ndev-flow: this change requires its smoke test, and only a human can skip it, with ndev-flow skip --reason <reason>.')
  if (!standalone && !wf.direct) confirmPrHead(wf, readPr(wf, prOf(wf)), sha)
  comment(wf, wf.prs[0] || wf.issue, args.report ? `Smoke test of ${sha}\n\n${args.report}` : `Smoke test of ${sha} skipped: ${args.skipped}`)
  if (!standalone) {
    assertHead(wf, sha)
    if (!wf.direct) confirmPrHead(wf, readPr(wf, prOf(wf)), sha)
  }
  wf.evidence = { ...wf.evidence, smoke: { sha, text: args.report || `skipped: ${args.skipped}` } }
  const notes = ['The smoke report is on the PR.']
  apply(wf, to, 'finishedSmoke', notes)
  save(wf)
  return report(wf, config, notes)
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

const ISSUE_LINK = ':?\\s+(?:(?:[\\w.-]+\\/[\\w.-]+)?#|https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/issues\\/)'
const CLOSING = `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)${ISSUE_LINK}`
const PART = `\\b(?:part of|refs?)${ISSUE_LINK}`
const hasIssueRef = (body: string, n: number) => new RegExp(`${CLOSING}${n}\\b`, 'i').test(body)
const namesPart = (body: string, n: number) => new RegExp(`${PART}${n}\\b`, 'i').test(body)

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
  for (const branch of new Set([wf.branch, wf.localBranch].filter(Boolean))) {
    if (stash.includes(`on ${branch}:`) || stash.includes(`On ${branch}:`)) problems.push(`A stash of ${branch} remains. Apply or drop it.`)
  }
  const humanSkip = wf.evidence?.checks?.byHuman && wf.evidence.checks.sha === sha
  if (!humanSkip) {
    const checks = readChecks(wf, sha)
    if (checks.red.length) problems.push(`Red checks on HEAD: ${checks.red.join(', ')}.`)
    if (checks.pending.length) problems.push(`Pending checks on HEAD: ${checks.pending.join(', ')}. Wait with one blocking call: ${waitChecks(pr.number)}.`)
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
  problems.push(...planTraceProblems(wf, pr.body ?? '').map(p => `${p}.`))
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
  return report(wf, config, notes)
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
  return report(wf, config, notes)
}

function revisit(wf: Workflow, config: Config) {
  if (wf.state !== 'done' || wf.direct || wf.prsClosed) throw new Fail(1, `ndev-flow: revisit reads the open PR of a done workflow, and issue #${wf.issue} is in ${wf.state}${wf.direct ? ' with no PR' : wf.prsClosed ? ' with its PR closed' : ''}. Repair: run ndev-flow status.`)
  const n = prOf(wf)
  const pr = readPr(wf, n)
  if (pr.number !== n || !['open', 'closed'].includes(pr.state) || pr.merged !== undefined && typeof pr.merged !== 'boolean') throw new Fail(1, `ndev-flow: gh.sh pr-read ${n} returned PR #${pr.number} in state ${JSON.stringify(pr.state)}, merged=${JSON.stringify(pr.merged)}. Repair: inspect gh pr view ${n} --repo ${wf.repo}.`)
  if (pr.state !== 'open') {
    wf.prsClosed = true
    if (pr.merged) wf.merged = true
    save(wf)
    return { ...report(wf, config, [`PR #${n} is ${pr.merged ? 'merged' : 'closed with no merge'}, so its PR is read no more.`]), revisit: { pr: n, closed: true, merged: !!pr.merged, feedback: [], problems: [] } }
  }
  const feedback = newFeedback(wf, pr, wf.feedbackAt ?? 0)
  const prConflict = pr.mergeable === false
  const red = readChecks(wf, pr.head.sha).red
  const problems = [
    ...(prConflict ? [`PR #${n} has conflicts with ${wf.base}. Merge origin/${wf.base} into this branch, resolve the conflicts, and run ${FLOW} checkpoint.`] : []),
    ...(red.length ? [`Red checks on ${pr.head.sha.slice(0, 8)}: ${red.join(', ')}. Fix the cause and run ${FLOW} checkpoint.`] : []),
  ]
  const notes = [...(feedback.length ? [`New feedback:\n${feedback.join('\n')}`] : []), ...problems]
  const to = afterStarted({ state: wf.state as any, previous: wf.previous as any }, { mode: wf.mode as any, steering: wf.steering as any, feedback: feedback.length > 0, prConflict })
  if (to.state !== wf.state) {
    apply(wf, to, 'revisit', notes)
    save(wf)
  }
  return { ...report(wf, config, notes), revisit: { pr: n, closed: false, merged: false, feedback, problems } }
}

function simpleMove(tool: string) {
  return (wf: Workflow, config: Config) => {
    const notes: string[] = []
    apply(wf, moveFor(wf, config, tool), tool, notes)
    save(wf)
    return report(wf, config, notes)
  }
}

function interview(wf: Workflow, config: Config, args: Args) {
  if (Object.keys(args).some(k => k !== 'issue')) throw new Fail(2, `ndev-flow: this harness has no interview pane. Instead, ask the questions in the chat (${PROFILE.askHuman ?? 'ask the human in the chat and end your turn'}), then run ndev-flow interview with no flags to go on.`)
  const to = moveFor(wf, config, 'interview')
  const notes: string[] = []
  if (to.state === 'developing' || to.state === 'planning') runBaseCheck(wf, notes)
  apply(wf, to, 'interview', notes)
  save(wf)
  return report(wf, config, notes)
}

function finishedInterview(wf: Workflow, config: Config) {
  if (!['developing', 'planning', 'hardening'].includes(wf.state)) throw new Fail(1, `Refused: finishedInterview is not valid in the state "${wf.state}". Nothing changed.`)
  const notes: string[] = []
  if (!baseCheckScript(wf.mode as any)) notes.push(`Mode ${wf.mode} has no base check.`)
  else runBaseCheck(wf, notes)
  save(wf)
  return report(wf, config, notes)
}

function citedRecords(root: string, ids: string[]) {
  const dir = join(root, RECORDS_DIR)
  const files = existsSync(dir) ? readdirSync(dir) : []
  return ids.flatMap(id => {
    const file = recordFileOf(id, files)
    return file ? [summarise(file, readFileSync(join(dir, file), 'utf8'))] : []
  })
}

function issueRecords(root: string, issue: number, body: string): string[] {
  if (!existsSync(join(root, RECORDS_DIR))) return []
  const ids = citedIds(body)
  return issueRecordNotes(issue, ids, citedRecords(root, ids))
}

function planTraceProblems(wf: Workflow, body: string): string[] {
  const line = planLine(body, 'Requirements')
  return line ? traceProblems(citedRecords(wf.root, citedIds(line)), prUrl(wf)) : []
}

function planRecordProblems(root: string, text: string): string[] {
  const records = join(root, RECORDS_DIR)
  if (!existsSync(records)) return []
  const problems: string[] = []
  const requirements = planLine(text, 'Requirements')
  if (requirements === undefined) problems.push('it has no "Requirements:" line')
  else if (!requirements) problems.push('its "Requirements:" line is empty; write the value on the same line')
  else {
    const files = readdirSync(records)
    for (const id of citedIds(requirements)) {
      if (!recordFileOf(id, files)) problems.push(`${id} has no record in ${RECORDS_DIR}`)
    }
    problems.push(...verificationProblems(text, citedIds(requirements)))
  }
  const model = planLine(text, 'Model')
  if (model === undefined) problems.push('it has no "Model:" line')
  else {
    const none = /^none\b/i.test(model)
    const paths = none ? [] : model.match(/[^\s,;`()[\]"'|<>]+\.qnt\b/g) ?? []
    if (none ? !/^none\b\W*\w/i.test(model) : !paths.length) problems.push(`"Model: ${model || 'none'}" needs a reason: write "Model: none, <reason>", or name the .qnt files`)
    for (const path of paths) {
      if (path.startsWith('/') || path.split('/').includes('..')) problems.push(`the model ${path} is outside the worktree: name it relative to ${root}`)
      else if (!existsSync(join(root, path))) problems.push(`the model ${path} does not exist in ${root}`)
    }
  }
  return problems
}

function finishedPlan(wf: Workflow, config: Config, args: Args) {
  const file = need(args, 'file')
  const to = moveFor(wf, config, 'finishedPlan')
  const text = standalone ? readFileSync(file, 'utf8') : publicCli!.inputFile(file)
  if (!/Test entry point:/i.test(text)) throw new Fail(2, `ndev-flow: the plan ${file} has no "Test entry point:" line. Repair: add one, then run the command again.`)
  const recordProblems = planRecordProblems(wf.root, text)
  if (recordProblems.length) throw new Fail(2, `ndev-flow: the plan ${file} does not name its requirement records and model:\n${recordProblems.map(p => `- ${p}`).join('\n')}\nRepair: add "Requirements: REQ-NNNN, ..." (or "none, <reason>") and "Model: <path.qnt[#name]>, ..." (or "none, <reason>"), as kb/requirements.md "In the workflow" says. Then run the command again.`)
  const body = namesPart(text, wf.issue) ? `${text.trimEnd()}\n` : `${text.trimEnd()}\n\nCloses #${wf.issue}\n`
  if (!wf.direct && !wf.prs.length && !wf.prTitle) {
    setUpPr(wf, ghJson<{ title: string }>(wf.root, wf.repo, ['issue-read', String(wf.issue)]).title)
    save(wf)
  }
  if (wf.prTitle && !wf.prs.length) wf.prBody = body
  else gh(wf, ['pr-edit', String(prOf(wf)), '--body-file', writeTemp(wf, 'pr-body.md', body)])
  const location = wf.prs.length ? prUrl(wf) : file
  const notes = [`The plan is saved for the body of the draft PR: ${location}.`]
  if (to.state === 'blocked') wf.blocked = { message: `Sign off the plan in ${location}, then run ndev-flow unblocked --message go.`, at: now(), group: 'plan' }
  if (to.state === 'blocked') notes.push(wf.blocked.message)
  apply(wf, to, 'finishedPlan', notes)
  save(wf)
  return report(wf, config, notes)
}

function blocked(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const to = moveFor(wf, config, 'blocked')
  wf.blocked = { message, at: now(), group: 'agent' }
  const notes = [`Blocked: ${message}`]
  apply(wf, to, 'blocked', notes)
  save(wf)
  return report(wf, config, notes)
}

function unblocked(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const to = moveFor(wf, config, 'unblocked')
  delete wf.blocked
  const notes = [`Unblocked: ${message}`]
  apply(wf, to, 'unblocked', notes)
  save(wf)
  return report(wf, config, notes)
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
  return report(wf, config, notes)
}

function setSteering(wf: Workflow, config: Config, args: Args) {
  if (need(args, 'steering') !== 'auto') throw new Fail(2, 'ndev-flow: an agent can only set --steering auto. Only a human sets it back, with ndev-flow steering --steering interactive.')
  const reason = need(args, 'reason')
  const to = moveFor(wf, config, 'setAuto')
  wf.steering = 'auto'
  if (!standalone) comment(wf, wf.issue, `Steering set to auto: ${reason}`)
  if (wf.prs[0]) comment(wf, wf.prs[0], `Steering set to auto: ${reason}`)
  const notes = [`Steering is auto: ${reason}`]
  apply(wf, to, 'setAuto', notes)
  save(wf)
  return report(wf, config, notes)
}

function leaveInterviewFile(wf: Workflow, verb: string): string[] {
  const path = issueFile(wf.root, wf.issue)
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Fail(1, `ndev-flow: ${path} cannot be read (${(error as Error).message}). Nothing changed. Repair: fix the file, then run ${FLOW} ${verb} again.`)
  }
  if (raw.rounds?.length && raw.posted === false) throw new Fail(1, `ndev-flow: the interview answers of #${wf.issue} are not on GitHub ("posted": false in ${path}), so #${wf.issue} stays in "${wf.state}". Nothing changed. Repair: run /flow ${verb} in a Claude Code session on this worktree, which posts them first; or post them on #${wf.issue} with ${FLOW} comment, set "posted" to true in that file, and run ${FLOW} ${verb} again.`)
  if (!raw.chatRound) return []
  const { workflow, prs, chatRound, ...interview } = raw
  const r = run('bash', [`${HOME}/scripts/work/worktree-env.sh`, 'set-interview', '--worktree', wf.root], { cwd: wf.root, input: JSON.stringify(interview) })
  if (r.status !== 0) throw new Fail(1, `ndev-flow: the chat round "${chatRound.title}" of #${wf.issue} was not dropped: worktree-env.sh set-interview exited ${r.status}: ${said(r)}. Nothing changed. Repair: fix the cause, then run ${FLOW} ${verb} again.`)
  return [`The chat round "${chatRound.title}" had no answers, and it is dropped.`]
}

function humanMove(wf: Workflow, config: Config, verb: string, to: Position, reason: string) {
  const from = wf.state
  const left = to.state !== 'interviewing' && (from === 'interviewing' || (['blocked', 'wait'].includes(from) && wf.previous === 'interviewing')) ? leaveInterviewFile(wf, verb) : []
  const notes = [verb === 'skip' ? `Skipped ${from}: ${reason}` : `Moved by the human from ${from} to ${to.state}.`, ...left]
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
  if (wf.prs[0] && !wf.direct) {
    const what = verb === 'skip' ? `skip "${from}", at ${sha.slice(0, 8)}: ${reason}` : `goto "${to.state}" from "${from}", at ${sha.slice(0, 8)}: ${reason}`
    try { comment(wf, wf.prs[0], `The human ran ${FLOW} ${what}`) }
    catch (error) { notes.push(`PR #${wf.prs[0]} does not record this ${verb}: ${(error as Error).message}. Repair: post the reason on PR #${wf.prs[0]} with ${FLOW} comment.`) }
  }
  return report(wf, config, notes)
}

function skip(wf: Workflow, config: Config, args: Args) {
  const reason = need(args, 'reason')
  const to = afterSkip({ state: wf.state as any, previous: wf.previous as any }, wf.mode as any, wf.steering as any)
  if ('refused' in to) throw new Fail(1, rewrite(to.refused, wf))
  return humanMove(wf, config, 'skip', to, reason)
}

function gotoState(args: Args) {
  const state = need(args, 'state')
  if (!GOTO.includes(state)) throw new Fail(2, `ndev-flow: goto does not move to "${state}". The states it moves to are ${GOTO.join(', ')}.`)
  return state
}
function refuseUnchanged(wf: Workflow, key: 'state' | 'mode' | 'steering', value: string) {
  if (value === wf[key]) throw new Fail(1, `Issue #${wf.issue} is already ${key === 'state' ? `in the state "${value}"` : value}. Nothing changed.`)
}
function goto(wf: Workflow, config: Config, args: Args) {
  const state = gotoState(args)
  refuseUnchanged(wf, 'state', state)
  return humanMove(wf, config, 'goto', { state }, args.reason?.trim() || `moved to ${state}`)
}

function setMode(wf: Workflow, config: Config, args: Args) {
  const mode = need(args, 'mode')
  if (!(mode in MACHINES)) throw new Fail(2, `ndev-flow: "${mode}" is not a mode. The modes are ${Object.keys(MACHINES).join(', ')}.`)
  refuseUnchanged(wf, 'mode', mode)
  wf.mode = mode
  save(wf)
  return report(wf, config, [`Mode is ${mode}.`])
}

function setHumanSteering(wf: Workflow, config: Config, args: Args) {
  const steering = need(args, 'steering')
  if (steering !== 'auto' && steering !== 'interactive') throw new Fail(2, `ndev-flow: "${steering}" is not a steering. Use auto or interactive.`)
  refuseUnchanged(wf, 'steering', steering)
  wf.steering = steering
  save(wf)
  return report(wf, config, [`Steering is ${steering}.`])
}

function commentCommand(wf: Workflow, config: Config, args: Args) {
  const message = need(args, 'message')
  const n = Number(args.pr ?? args.on ?? wf.prs[0] ?? wf.issue)
  return { target: n, text: comment(wf, n, message) }
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
  return report(wf, config, [`Created ${path}. Write the SQL in it and commit it with ndev-flow checkpoint.`])
}

function requestSecret(root: string, args: Args) {
  const name = need(args, 'name')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Fail(2, `Invalid secret name: ${name}.`)
  if (!standalone) {
    const main = gitOk(root, 'worktree', 'list', '--porcelain', '-z').split('\0')[0]!.slice(9)
    const sources = publicCli!.secretFiles(root, main, homedir())
    for (const file of sources) {
      if (!existsSync(file)) continue
      const line = publicCli!.findInText(name, readFileSync(file, 'utf8'))
      if (line) return { name, file, line, text: `${name} is set in ${file}:${line}` }
    }
    throw new Fail(1, `${name} is absent from ${sources.join(', ')}. Ask the human to set it in ${sources[0]}.`)
  }
  const files = [join(root, '.neil-dev.env'), join(root, '.env'), join(homedir(), '.zshrc'), join(homedir(), '.bashrc')]
  const pattern = new RegExp(`^\\s*(export\\s+)?${name.replace(/[^\w]/g, '')}=`)
  for (const file of files) {
    if (!existsSync(file)) continue
    const line = readFileSync(file, 'utf8').split('\n').findIndex(l => pattern.test(l))
    if (line >= 0) return { name, file, line: line + 1, text: `${name} is set in ${file}:${line + 1}` }
  }
  throw new Fail(1, `ndev-flow: ${name} is not set in ${files.join(', ')}. Repair: ask the human to add it to ${files[0]}, which must be git-ignored.`)
}

const CLAUDE_ONLY: Record<string, string> = {
  screenshot: 'Instead, take the screenshots with the browser tool of this harness, or with npx playwright screenshot <url> <file>.',
  iNeedA: `Instead, read ${HOME}/kb/ui-components.md and the brand guide of the project.`,
  reportWorkflowBug: 'Instead, tell the human what ndev-flow did wrong, with the command and its output.',
  hotfix: 'Instead, file the fix with ndev-flow followUp --mode issue_only, and start it in its own worktree with ndev-flow started.',
  create: 'Instead, file the issue with ndev-flow followUp --mode issue_only.',
  off: 'Instead, stop calling ndev-flow for this issue. The record stays in the issue file.',
  wait: `Instead, run the blocking helper for what you wait on: ${waitChecks('<pr>')}, or ${WAIT_PID} <pid>.`,
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
  finishedDevelopment --message <m> --files <a,b> [--body-file <f>] [--hardening <t>] [--human-confirmation <text>]   commit, start the review and the dead-code sweep
  pushDraft --sha <full-reviewed-sha> --review <r>   checked push to the open draft, stay in review
  finishedReview (--review <r> | --waive-review <reason>) --deadcode <d> --remembered <w>   pre-ready check, push, mark the PR ready
  finishedChecks                                 read the checks of HEAD
  finishedSmoke --report <r> | --skipped <reason>
  finishedRevision
  revisit                                        done: read the open PR again for feedback, conflicts and red checks
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

const ISSUE_COMMANDS: Record<string, (wf: Workflow, config: Config, args: Args) => { text: string }> = {
  status: (wf, config) => report(wf, config, []),
  interview,
  finishedInterview,
  finishedPlan,
  checkpoint,
  finishedHacking: simpleMove('finishedHacking'),
  finishedDevelopment,
  finishedReview,
  pushDraft,
  finishedChecks,
  finishedSmoke,
  finishedRevision,
  revisit,
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
  if (!command || command === 'help' || command === '--help') return { text: HELP }
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
  return ISSUE_COMMANDS[command]!(wf, config, args)
}

if (standalone) try {
  console.log(main(process.argv.slice(2)).text)
} catch (error) {
  if (error instanceof Fail) {
    console.error(error.message)
    process.exit(error.code)
  }
  throw error
}

function modernText(text: string) {
  return text.replaceAll('ndev-flow', 'ndev flow')
    .replace(/\b(finished[A-Z]\w+|addMigration|requestSecret|followUp|setSteering)\b/g, word => word.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).replace('set-steering', 'steering'))
    .replace(/ndev flow started --issue (\S+)/g, 'ndev flow start $1')
    .replace(/ndev flow started\b/g, 'ndev flow start')
    .replace(/ndev flow skip --reason/g, 'ndev flow skip')
    .replace(/ndev flow goto --state/g, 'ndev flow goto')
    .replace(/ndev flow steering --steering/g, 'ndev flow steering')
    .replace(/ndev flow mode --mode/g, 'ndev flow mode')
    .replace(/ndev flow unblocked --message/g, 'ndev flow unblock')
    .replace(/--take-over true/g, '--take-over')
    .replace(/ndev flow unblocked\b/g, 'ndev flow unblock')
}
function assertHead(wf: Workflow, expected: string) {
  const actual = headSha(wf.root)
  if (actual !== expected) throw new Fail(1, `Issue #${wf.issue} changed from ${expected} to ${actual} while reading evidence. Repair: rerun the checks for the new head.`)
}
function confirmPrHead(wf: Workflow, pr: Pr, sha: string) {
  if (pr.head?.sha !== sha || pr.head?.ref !== wf.branch) throw new Fail(1, `PR #${pr.number} points to ${pr.head?.ref}@${pr.head?.sha}; expected ${wf.branch}@${sha}. Refresh the PR and retry on its current head.`)
}
function mergeBaseOf(wf: Workflow): string {
  const r = git(wf.root, 'merge-base', `origin/${wf.base}`, 'HEAD')
  return r.status === 0 ? r.stdout.trim() : ''
}
function assertRemoteHeld(wf: Workflow, head: string) {
  const ref = `refs/heads/${wf.branch}`
  const remote = gitOk(wf.root, 'ls-remote', '--heads', 'origin', ref).split('\t')[0]!
  if (!remote || remote === head) return
  if (git(wf.root, 'cat-file', '-e', `${remote}^{commit}`).status !== 0) gitOk(wf.root, 'fetch', '--no-tags', 'origin', ref)
  const held = git(wf.root, 'merge-base', '--is-ancestor', remote, head)
  if (held.status === 0) return
  if (held.status !== 1) throw new Fail(1, `git merge-base --is-ancestor ${remote} ${head} exited ${held.status}: ${said(held)}. Repair: git fetch origin ${wf.branch}, then retry.`)
  throw new Fail(1, `Remote ${wf.branch} is at ${remote}, and HEAD ${head} does not contain it, so a push would lose or reject commits. Repair: git pull --rebase origin ${wf.branch}, commit with ndev-flow checkpoint, and run the review again.`)
}
function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Fail(2, `ndev-flow: ${name} must be a whole number of milliseconds, not "${raw}".`)
  return Number(raw)
}
function awaitPrHead(wf: Workflow, sha: string) {
  const waitMs = envMs('NDEV_FLOW_PR_HEAD_WAIT_MS', 30_000)
  const pollMs = envMs('NDEV_FLOW_PR_HEAD_POLL_MS', 1_000)
  const deadline = Date.now() + waitMs
  for (;;) {
    const pr = readPr(wf, prOf(wf))
    if (pr.head?.sha === sha && pr.head?.ref === wf.branch) return pr
    if (pr.head?.ref !== wf.branch) confirmPrHead(wf, pr, sha)
    assertHead(wf, sha)
    if (Date.now() >= deadline) throw new Fail(1, `PR #${pr.number} still points to ${pr.head?.ref}@${pr.head?.sha} ${waitMs} ms after the push; expected ${wf.branch}@${sha}. The pre-ready check passed on ${sha.slice(0, 8)} and is kept. Repair: run ndev flow finished-review again with the same arguments once the PR shows ${sha.slice(0, 8)}.`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
  }
}
function orca(root: string, environment: string, args: string[]) {
  const result = run(process.env.ORCA_CLI_COMMAND || 'orca', [...args, ...(environment ? ['--environment', environment] : []), '--json'], { cwd: root, timeout: 120_000 })
  const prefix = `orca ${args.join(' ')} in ${root}`
  if (result.status !== 0) throw new Fail(1, `${prefix} exited ${result.status}: ${[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || 'no output'}`)
  let receipt
  try { receipt = JSON.parse(result.stdout) } catch { throw new Fail(1, `${prefix} printed invalid JSON: ${said(result)}`) }
  if (receipt.ok === false || receipt.error) throw new Fail(1, `${prefix} returned a failure: ${JSON.stringify(receipt.error || receipt)}`)
  return receipt.result ?? receipt
}
const orcaEnvironment = () => process.env.ORCA_ENVIRONMENT || (process.env.ORCA_PAIRING_CODE ? '' : 'local')
function inOrca() {
  return Boolean(process.env.ORCA_ENVIRONMENT || process.env.ORCA_TERMINAL_HANDLE || process.env.ORCA_PAIRING_CODE)
}
function syncWorkspace(wf: Workflow, notes: string[]) {
  const view = orcaView(wf)
  const args = ['worktree', 'set', '--worktree', `path:${wf.root}`, '--issue', String(wf.issue), '--comment', view.comment, '--workspace-status', view.status, view.attention ? '--unread' : '--read']
  if (view.name) args.push('--display-name', view.name)
  if (view.pr) args.push('--pr', String(view.pr))
  try { orca(wf.root, orcaEnvironment(), args) }
  catch (error) { notes.push(`Workspace update for #${wf.issue} failed: ${(error as Error).message}`) }
}
function repairOwner(wf: Workflow, args: Args) {
  const owner = wf.owner?.session
  if (!owner || owner === session()) return
  if (args['take-over'] !== 'true') throw new Fail(1, `Session ${owner} owns issue #${wf.issue} in ${wf.root}. Repair: after that owner has finished, run ndev flow repair --issue ${wf.issue} --pr ${args.pr} --take-over.`)
  const status = orca(wf.root, orcaEnvironment(), ['agent', 'show', owner])
  if (status.orcaSessionId !== owner || !Array.isArray(status.places) || !status.places.length || status.places.some((place: { state?: string }) => !['done', 'closed', 'exited'].includes(place.state || ''))) {
    throw new Fail(1, `Session ${owner} has not been confirmed finished for issue #${wf.issue}: ${JSON.stringify(status)}. Leave its work intact and retry after the owner finishes.`)
  }
}
function repairFlow(root: string, config: Config, args: Args) {
  const issue = Number(need(args, 'issue'))
  const number = Number(need(args, 'pr'))
  const repo = resolveRepo(root, config)
  const held = readRecord(root, issue)
  const records = publicCli!.readWorkflowRecords(root) as Workflow[]
  const shared = records.filter(wf => wf.pr && (wf.issue === issue || wf.issues?.includes(issue)))
  for (const prior of shared) {
    if (!prior.off) throw new Fail(1, `Issue #${issue} belongs to shared PR #${prior.pr}. Finish that shared workflow before repairing its association. Nothing was rebound.`)
    const pr = readPr(prior, prior.pr)
    if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) throw new Fail(1, `Shared PR #${prior.pr} in ${issueFile(root, prior.issue)} returned a non-object PR response: ${JSON.stringify(pr)}. Nothing was rebound.`)
    if (pr.number !== prior.pr || pr.merged !== undefined && typeof pr.merged !== 'boolean' || pr.merged !== true && pr.state !== 'closed') throw new Fail(1, `Shared PR #${prior.pr} is not confirmed closed or merged. Leave its association intact.`)
    repairOwner(prior, args)
  }
  if (held && (resolve(held.root) !== root || held.repo.toLowerCase() !== repo.toLowerCase() || held.pr || held.prs.length > 1 || held.op || held.state === 'wait')) {
    throw new Fail(1, `Issue #${issue} has a shared, pending, waiting or mismatched workflow in ${held.root}; repair it there after its operation finishes. Nothing was rebound.`)
  }
  const roots = gitOk(root, 'worktree', 'list', '--porcelain', '-z').split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  const elsewhere = roots.filter(path => path !== root).find(path => readRecord(path, issue))
  if (elsewhere) throw new Fail(1, `Issue #${issue} already has a workflow in ${elsewhere}. Nothing was copied or rebound. Repair: run ndev flow repair --issue ${issue} --pr ${number} from that worktree.`)
  if (held?.off) throw new Fail(1, `Workflow of #${issue} is off: ${held.off.reason}. Run ndev flow on --issue ${issue} before repairing it.`)
  if ((args.mode || held?.mode || config.mode) === 'hack' && (held?.steering || config.steering) === 'auto') throw new Fail(2, 'Hack mode cannot use auto steering.')
  if (held) repairOwner(held, args)
  const foreign = (publicCli!.effectiveWorkflowRecords(root) as Workflow[]).find(wf => wf.issue !== issue && !['done', 'setup'].includes(wf.state) && !wf.off)
  if (foreign) throw new Fail(1, `Issue #${foreign.issue} already uses ${root}. Finish that workflow before repairing #${issue}.`)
  const info = ghJson<{ title: string; state: string }>(root, repo, ['issue-read', String(issue)])
  if (info.state !== 'open') throw new Fail(1, `Issue #${issue} is ${info.state}; reopen it before repairing its PR association.`)
  const pr = ghJson<Pr>(root, repo, ['pr-read', String(number)])
  if (pr.number !== number || pr.state !== 'open' || pr.merged) throw new Fail(1, `PR #${number} is ${pr.state}${pr.merged ? ' (merged)' : ''}; repair needs an open PR.`)
  if (pr.head?.crossRepository !== false) throw new Fail(1, `PR #${number} must be a confirmed same-repository PR; fork or unknown heads cannot be rebound.`)
  const base = ghJson<{ default_branch: string }>(root, repo, ['default-branch']).default_branch
  const localBranch = gitOk(root, 'branch', '--show-current')
  if (!localBranch || localBranch === base || localBranch === pr.base?.ref || !pr.head.ref || pr.head.ref === base || pr.head.ref === pr.base?.ref) throw new Fail(1, `PR #${number} repair refuses a detached checkout or a base branch head (${localBranch}, ${pr.head.ref}).`)
  if (!pr.base?.ref || git(root, 'check-ref-format', '--branch', pr.head.ref).status !== 0 || git(root, 'check-ref-format', '--branch', pr.base.ref).status !== 0 || !/^[0-9a-f]{40}$/.test(pr.head.sha)) throw new Fail(1, `PR #${number} has an invalid head/base reference or commit: ${JSON.stringify(pr)}.`)
  const quotedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linked = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+(?:(?:${quotedRepo})?#${issue}\\b|https://github\\.com/${quotedRepo}/issues/${issue}\\b)`, 'i').test(pr.body || '')
  if (!linked) throw new Fail(1, `PR #${number} does not close issue #${issue}. Add the correct closing reference to that PR before repairing its association.`)
  const fetchUrl = gitOk(root, 'remote', 'get-url', '--all', 'origin')
  const pushUrl = gitOk(root, 'remote', 'get-url', '--push', '--all', 'origin')
  const originRepo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|ssh:\/\/git@ssh\.github\.com:443\/)([^/\s]+\/[^/\s]+)\/?$/i.exec(pushUrl)?.[1]?.replace(/\.git$/i, '')
  if (!fetchUrl || fetchUrl.includes('\n') || fetchUrl !== pushUrl || originRepo?.toLowerCase() !== repo.toLowerCase()) throw new Fail(1, `PR #${number} repair requires one matching origin fetch/push URL for ${repo}; found fetch=${fetchUrl}, push=${pushUrl}. Repair: inspect git remote get-url --all origin and git remote get-url --push --all origin.`)
  const sha = headSha(root)
  gitOk(root, 'fetch', '--no-tags', 'origin', `+refs/heads/${pr.head.ref}:refs/remotes/origin/${pr.head.ref}`)
  const remote = gitOk(root, 'rev-parse', `origin/${pr.head.ref}`)
  if (remote !== pr.head.sha) throw new Fail(1, `PR #${number} head ${pr.head.sha} differs from origin/${pr.head.ref}@${remote}. Refresh the PR and retry the repair.`)
  if (git(root, 'merge-base', '--is-ancestor', remote, sha).status !== 0) throw new Fail(1, `HEAD ${sha} is missing commits from PR #${number} on canonical branch ${pr.head.ref}@${remote}. Repair: git merge origin/${pr.head.ref}, resolve conflicts, then retry ndev flow repair --issue ${issue} --pr ${number}.`)
  if (held?.branch === pr.head.ref && held.base === pr.base.ref && (held.localBranch || held.branch) === localBranch && held.prs[0] === number && held.owner?.session === session() && held.lastRepair?.head === sha && held.lastRepair?.remote === remote) return report(held, config, ['Association already repaired; nothing changed.'])
  const wf: Workflow = held || { issue, root, repo, base: pr.base.ref, branch: localBranch, prs: [], state: (config.steering || 'interactive') === 'interactive' ? 'interviewing' : 'developing', mode: args.mode || config.mode || 'light', steering: config.steering || 'interactive', history: [], evidence: {}, followUps: [], migrations: [], attempts: 0, nudges: { count: 0 }, shortName: `repair-pr-${number}` }
  const previous = { branch: wf.branch, localBranch: wf.localBranch, base: wf.base, prs: wf.prs, state: wf.state }
  wf.branch = pr.head.ref
  wf.localBranch = localBranch
  if (wf.base !== pr.base.ref) delete wf.baseCheck
  wf.base = pr.base.ref
  wf.prs = [number]
  wf.owner = { session: session(), at: now() }
  wf.lastRepair = { ...previous, head: sha, remote, at: now() }
  wf.evidence = {}
  if (wf.direct) {
    delete wf.direct
    delete wf.noChecks
    delete wf.baseCheck
  }
  for (const key of ['exportReview', 'deadcode', 'hooks', 'reviewRounds', 'prTitle', 'prBody', 'doneWaitsFor']) delete wf[key]
  const phase = wf.state === 'blocked' ? wf.previous : wf.state
  if (!['setup', 'interviewing', 'planning', 'developing', 'hardening'].includes(phase || '')) {
    if (wf.state === 'blocked') wf.previous = 'developing'
    else wf.state = 'developing'
  }
  wf.history.push({ at: now(), tool: 'repair', from: previous.state, to: wf.state })
  assertHead(wf, sha)
  if (gitOk(root, 'branch', '--show-current') !== localBranch) throw new Fail(1, `The local branch changed during PR #${number} repair. Retry from the intended checkout.`)
  save(wf)
  publicCli!.bind(root, issue, session())
  const notes = [`Repaired issue #${issue} to PR #${number}. Local branch ${localBranch}; publish target HEAD:refs/heads/${pr.head.ref}. Existing files and local branch refs were preserved. Review, checks and smoke evidence must be renewed.`]
  if (inOrca()) syncWorkspace(wf, notes)
  return report(wf, config, notes)
}
function publicStart(root: string, config: Config, args: Args, hotfix: boolean) {
  const issue = findIssue(root, args)
  const roots = gitOk(root, 'worktree', 'list', '--porcelain', '-z').split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
  const existing = roots.find(path => existsSync(issueFile(path, issue)))
  const repo = resolveRepo(root, config)
  const info = ghJson<{title: string; state: string}>(root, repo, ['issue-read', String(issue)])
  if (!existing && info.state !== 'open') throw new Fail(1, `Issue #${issue} is ${info.state}. Reopen it before starting.`)
  const words = info.title.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 5) ?? []
  args['short-name'] ||= words.length > 1 ? words.join('-') : `issue-${issue}`
  checkSlug(args['short-name'])
  const base = ghJson<{default_branch: string}>(root, repo, ['default-branch']).default_branch
  const main = roots[0]!
  const branchHere = gitOk(root, 'branch', '--show-current')
  const name = `${issue}-${args['short-name']}`
  if (hotfix && config.projectLevel === 'straw_man') return { root: main, issue, base, direct: true, text: `Hotfix #${issue} uses ${main} on ${base}. Commit the named changes through the active workflow checkpoint.` }
  let target = existing || root
  if (!existing && config.projectLevel !== 'straw_man' && (hotfix || branchHere === base)) {
    const branch = `ndev/${name}`
    const already = roots.find(path => gitOk(path, 'branch', '--show-current') === branch)
    if (already) target = already
    else {
      const made = orca(root, orcaEnvironment(), ['worktree', 'create', '--repo', `path:${main}`, '--name', name, '--branch', branch, '--base-branch', `origin/${base}`, '--reference', `https://github.com/${repo}/issues/${issue}`])
      target = made.worktree?.path
      if (!target || !existsSync(target) || gitOk(target, 'rev-parse', '--path-format=absolute', '--git-common-dir') !== gitOk(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') || gitOk(target, 'branch', '--show-current') !== branch) throw new Fail(1, `Orca returned a worktree outside the requested repository or branch ${branch}: ${JSON.stringify(made)}. Inspect orca worktree list --json before retrying.`)
    }
  }
  if (hotfix) {
    const wf = readRecord(target, issue) || { issue, root: target, repo, base, branch: gitOk(target, 'branch', '--show-current'), shortName: args['short-name'], prs: [], state: 'developing', mode: 'light', steering: 'auto', history: [], evidence: {}, migrations: [], followUps: [], hotfix: true, baseCheck: { note: 'hotfix' } }
    if (!wf.prs.length) { save(wf); setUpPr(wf, info.title); save(wf) }
    return report(wf, config, [`Hotfix #${issue} uses its own worktree ${target}${wf.prs[0] ? ` and draft PR ${prUrl(wf)}` : ''}.`])
  }
  const held = publicCli!.effectiveWorkflowRecords(target) as Workflow[]
  const currentPr = readRecord(target, issue)?.prs?.[0]
  for (const carrier of held.filter(record => record.pr || record.prs?.length)) {
    const number = carrier.pr || carrier.prs[0]
    const associated = number === currentPr && (carrier.issue === issue || carrier.issues?.includes(issue))
    if (associated ? info.state !== 'open' : carrier.off || carrier.state === 'done') continue
    const path = issueFile(target, carrier.issue)
    let pr: Pr
    try { pr = readPr(carrier, number) }
    catch (error) { throw new Fail(1, `Cannot inspect Issue #${carrier.issue}, PR #${number}, record ${path}: ${(error as Error).message}. Repair: inspect that PR before retrying ndev flow start ${issue}.`) }
    if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) throw new Fail(1, `Issue #${carrier.issue}, PR #${number}, record ${path}: GitHub returned a non-object PR response: ${JSON.stringify(pr)}. Repair: inspect that PR before retrying.`)
    if (pr.number !== number || !['open', 'closed'].includes(pr.state) || pr.merged !== undefined && typeof pr.merged !== 'boolean') throw new Fail(1, `Issue #${carrier.issue}, PR #${number}, record ${path}: GitHub returned PR #${pr.number} in state ${JSON.stringify(pr.state)}. Repair: inspect that PR before retrying.`)
    if (pr.merged || pr.state === 'closed') {
      const sameIssue = carrier.issue === issue || carrier.issues?.includes(issue)
      const enable = !carrier.pr && carrier.off ? `ndev flow on --issue ${issue}, then ` : ''
      const disable = !sameIssue || carrier.pr && !carrier.off ? `ndev flow off --pr ${number}, then ` : ''
      const repair = sameIssue ? `${disable}${enable}ndev flow repair --issue ${issue} --pr <new-open-pr>` : `${disable}ndev flow start ${issue}`
      throw new Fail(1, `Issue #${carrier.issue} still has PR #${number} (${pr.merged ? 'merged' : 'closed'}) in ${path}. Nothing changed.${sameIssue ? ` Reopened issue #${issue} needs a new open PR that closes it before repairing the association.` : ''} Repair: run ${repair} in ${target}. The on/off commands require confirmation and preserve the record.`)
    }
  }
  if (!existing) {
    const foreign = held.filter(record => !record.off && record.state !== 'done').map(ownedElsewhere).find(Boolean)
    if (foreign) throw new Fail(1, foreign)
  }
  const result = started(target, config, args)
  publicCli!.bind(target, issue, session())
  if (inOrca() && !result.workflow.direct) {
    syncWorkspace(result.workflow, result.notes)
    return report(result.workflow, config, result.notes)
  }
  return result
}
function checkSlug(slug: string) {
  if (!/^[a-z0-9]+(-[a-z0-9]+){1,4}$/.test(slug) || slug.length > 40) throw new Fail(2, `Invalid short name "${slug}". Use two to five lower-case words joined by hyphens, up to 40 characters.`)
}
function createIssueOnce(root: string, repo: string, identity: string[], title: string, body: string) {
  const { record, path, recover } = publicCli!.issueRequest(root, repo, [...identity, title, body])
  if (record.issue) return record.issue
  const marker = `<!-- ndev-issue-request-${record.id} -->`
  const repair = `Rerun the same command to recover request ${record.id}. Inspect GitHub in ${repo} for ${marker} before clearing ${path}.`
  let issue: number
  if (recover) {
    const since = new Date(record.startedAt - 86_400_000).toISOString()
    const query = `.[] | select((.pull_request == null) and ((.body // "") | contains(${JSON.stringify(marker)}))) | .number`
    const out = ghRun(root, repo, ['api', '--paginate', `repos/${repo}/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`, '--jq', query])
    const matches = out.split('\n').filter(Boolean)
    if (matches.length !== 1) throw new Fail(1, `Issue creation is uncertain in ${repo}: ${matches.length} matching issues for request ${record.id}. Repair: ${repair}`)
    issue = Number(matches[0])
  } else {
    const file = join(gitDir(root), `ndev-issue-${record.id}.md`)
    writeFileSync(file, `${body.trimEnd()}\n\n${marker}\n`, { mode: 0o600, flag: 'wx' })
    try { issue = ghJson<{number: number}>(root, repo, ['issue-new', '--title', title, '--body-file', file]).number }
    catch (error) { throw new Fail(1, `${(error as Error).message}. Repair: ${repair}`) }
    finally { rmSync(file, { force: true }) }
  }
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Fail(1, `Invalid GitHub issue number ${issue} for request ${record.id}. Repair: ${repair}`)
  return publicCli!.rememberIssue(path, record.id, issue)
}
function issueFromDescription(root: string, repo: string, args: Args) {
  const description = args['description-file'] ? publicCli!.inputFile(args['description-file']).trim() : args.hotfix ? `Hotfix: ${args['short-name']!.replaceAll('-', ' ')}` : need(args, 'description-file')
  const [title, ...lines] = description.split('\n')
  if (!title) throw new Fail(2, 'The description needs an issue title on its first line.')
  return createIssueOnce(root, repo, [args.hotfix ? 'hotfix' : 'create', args['short-name']!], title, lines.join('\n').trim() || title)
}

export function runFlow(argv: string[], options: { json?: boolean } = {}): unknown {
  try { return dispatchFlow(argv, options) }
  catch (error) {
    if (!(error instanceof Error)) throw new Fail(1, String(error))
    const e = error as Fail
    if (typeof e.code !== 'number') throw new Fail(1, modernText(e.message))
    e.message = modernText(e.message)
    const repair = e.message.lastIndexOf('Repair: ')
    if (!e.repair && repair >= 0) {
      e.repair = e.message.slice(repair + 8).trim()
      e.message = e.message.slice(0, repair).trim()
    }
    throw e
  }
}
function dispatchFlow(argv: string[], options: { json?: boolean }) {
  const parsed = publicCli!.parse(argv)
  if (parsed.text) return { text: parsed.text }
  const { command, args, numbers } = parsed
  if (!command || !args) throw new Fail(2, 'Run ndev flow help.')
  if (command === 'guide') return { text: modernText(readFileSync(join(HOME, 'kb/workflow.md'), 'utf8')) }
  const here = topLevel(args.worktree || process.cwd())
  const scope = args.worktree || ['start', 'repair', 'create', 'hotfix', 'comment', 'request-secret'].includes(command) || args.project ? undefined : publicCli!.binding(here, session())
  const root = scope?.root || here
  if (scope && !args.issue && !args.pr) args.issue = String(scope.issue)
  if (command === 'request-secret') return requestSecret(root, args)
  const config = publicCli!.settings(root)
  if ((command === 'on' || command === 'off') && args.project) return publicCli!.projectSwitch(root, command === 'on', !!options.json)
  if (command === 'comment') {
    const target = Number(args.issue || args.pr)
    if (!target) throw new Fail(2, 'ndev flow comment needs --issue <n> or --pr <n>.')
    return { target, text: ghRun(root, resolveRepo(root, config), ['comment', String(target), '--body', `${MARK}\n${need(args, 'message')}`]) }
  }
  const epic = epicCli!.activeEpic(root, session())
  if (epic && !['status', 'guide', 'mode', 'steering'].includes(command)) throw new Fail(1, `Session ${session()} coordinates epic #${epic.epic}. Run ndev epic status. To resume issue work, use ndev epic off first.`)
  if (command === 'repair' || command === 'start' && args.pr) {
    if (config.workflow === false) throw new Fail(1, `Workflow is off in ${root}. Run ndev flow on --project.`)
    return publicCli!.repairLocked(root, Number(need(args, 'issue')), () => {
      const repaired = repairFlow(root, config, args)
      if (command === 'repair') return repaired
      const resumed = started(root, config, args)
      publicCli!.bind(root, resumed.issue, session())
      const notes = [...repaired.notes, ...resumed.notes]
      if (inOrca() && !resumed.workflow.direct) syncWorkspace(resumed.workflow, notes)
      return report(resumed.workflow, config, notes)
    })
  }
  if (['create', 'hotfix', 'start'].includes(command)) {
    if (config.workflow === false) throw new Fail(1, `Workflow is off in ${root}. Run ndev flow on --project.`)
    if ((args.mode || config.mode) === 'hack' && config.steering === 'auto') throw new Fail(2, 'Hack mode cannot use auto steering.')
    if (command !== 'start') checkSlug(need(args, 'short-name'))
    const made = !args.issue && command !== 'start'
    if (command === 'hotfix') args.hotfix = 'true'
    if (made) args.issue = String(issueFromDescription(root, resolveRepo(root, config), args))
    try { return publicStart(root, config, args, command === 'hotfix') }
    catch (error) {
      if (made) throw new Fail(1, `Filed #${args.issue}, but start failed: ${(error as Error).message}. Repair: ndev flow start ${args.issue} --short-name ${args['short-name']}.`)
      throw error
    }
  }
  if (command === 'finished-development') return developMembers(root, config, args, numbers || {})
  const wf = load(root, args)
  if (resolve(wf.root) !== root) throw new Fail(1, `The record of #${wf.issue} names ${wf.root}, but the worktree is ${root}. Repair the record before continuing.`)
  wf.mode ??= config.mode ?? 'light'
  wf.steering ??= config.steering ?? 'interactive'
  if (command === 'status') return statusReport(wf, config, scope, here)
  if (command === 'mode' && !args.mode || command === 'steering' && !args.steering) return report(wf, config, [])
  if (config.workflow === false && command !== 'on') throw new Fail(1, `Workflow is off in ${root}. Run ndev flow on --project.`)
  if (wf.off && command !== 'on' && command !== 'off') throw new Fail(1, `Workflow of #${wf.issue} is off: ${wf.off.reason}. Run ndev flow on.`)
  const elsewhere = ownedElsewhere(wf)
  if (elsewhere && command !== 'unblock') throw new Fail(1, elsewhere)
  if ((args.mode || wf.mode) === 'hack' && (args.steering || wf.steering) === 'auto') throw new Fail(2, 'Hack mode cannot use auto steering.')
  if (command === 'goto') refuseUnchanged(wf, 'state', gotoState(args))
  if (command === 'mode') refuseUnchanged(wf, 'mode', args.mode)
  if (command === 'steering' && !args.reason) refuseUnchanged(wf, 'steering', args.steering)
  if (command === 'skip' || command === 'goto' || command === 'on' || command === 'mode' || command === 'steering' && !args.reason) {
    const request = publicCli!.confirm(command, `#${wf.issue}`, wf.rev ?? 0, root, !!options.json)
    if (request) return request
  }
  if (command === 'on' || command === 'off') {
    if (command === 'off') wf.off = { at: now(), reason: args.reason || 'Disabled by the human.' }
    else delete wf.off
    save(wf)
    return report(wf, config, [`Workflow ${command} for #${wf.issue}.`])
  }
  if (command === 'interview') {
    if (wf.state !== 'interviewing') throw new Fail(1, `Issue #${wf.issue} is ${wf.state}. An interview needs state interviewing.`)
    const view = publicCli!.interviewRound(root, wf.issue, wf.mode as any, args)
    if (view) return { ...view, root, state: wf.state }
    return interview(wf, config, {})
  }
  if (command === 'unblock') args.message ||= 'Unblocked by the human.'
  if (command === 'skip') args.reason ||= 'Skipped by the human.'
  if (command === 'checkpoint' && wf.state === 'developing' && baseCheckScript(wf.mode) && !wf.baseCheck) throw new Fail(1, `Issue #${wf.issue} needs its base check before committing. Run ndev flow finished-interview.`)
  if (command === 'finished-smoke' && args.report && args.skipped) throw new Fail(2, 'Choose --report-file or --skipped.')
  if (command === 'follow-up') return publicFollowUp(wf, config, args, numbers?.['existing-issue'] || [])
  if (command === 'add-migration') return publicMigration(wf, config, args)
  const before = { ...wf }
  const camel = command.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
  const handler = command === 'unblock' ? unblocked : command === 'steering' && args.reason ? setSteering : ISSUE_COMMANDS[camel]
  if (!handler) throw new Fail(2, `Unknown flow command ${command}. Run ndev flow help.`)
  const result = handler(wf, config, args)
  if (inOrca() && !wf.direct && (before.state !== wf.state || !!before.off !== !!wf.off)) {
    const notes: string[] = []
    syncWorkspace(wf, notes)
    if (wf.state === 'blocked' || before.state === 'blocked') {
      const notify = wf.state === 'blocked' ? ['raise', '--title', `Issue #${wf.issue} is blocked`, '--message', wf.blocked.message] : ['withdraw']
      const alert = run('bash', [join(HOME, 'scripts/workflow/notify.sh'), ...notify, '--group', `ndev-${wf.issue}-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`], { cwd: root })
      if (alert.status !== 0) notes.push(`notify.sh ${notify[0]} exited ${alert.status} for #${wf.issue}: ${said(alert)}`)
    }
    if (notes.length) return { ...result, ...report(wf, config, [...((result as { notes?: string[] }).notes ?? []), ...notes]) }
  }
  if (command === 'finished-interview' && wf.baseCheck?.exitCode !== 0 && wf.baseCheck?.exitCode !== undefined) throw new Fail(1, wf.baseCheck.note)
  return result
}

function statusReport(wf: Workflow, config: Config, bound: { root: string; issue: number; session: string } | undefined, here: string) {
  const id = session()
  const watcher = hooksCli!.watcherStatus(here, id)
  const notes = [
    bound ? `Binding: session ${id} is bound to #${bound.issue} in ${bound.root}.` : `Binding: session ${id} has no binding, so this reads #${wf.issue} in ${wf.root}.`,
    (watcher.running ? `Watcher: running as PID ${watcher.pid} for session ${id}.` : `Watcher: not running for session ${id}.${watcher.startError ? ` Its last start failed: ${watcher.startError}` : ''}`)
      + (watcher.lastNotice ? ` Last notice at ${new Date(watcher.lastNotice.at).toISOString()} (${watcher.lastNotice.requestId ? `Orca request ${watcher.lastNotice.requestId}` : 'Orca returned no request id'}): ${watcher.lastNotice.message}` : ' It has sent no notice.'),
  ]
  return { ...report(wf, config, notes), binding: bound ? { session: bound.session, issue: bound.issue, root: bound.root } : null, watcher }
}

function publicFollowUp(wf: Workflow, config: Config, args: Args, existing: number[]) {
  const mode = need(args, 'mode')
  const message = need(args, 'message')
  if (!['this_agent', 'issue_only', 'worktree', 'subagent'].includes(mode)) throw new Fail(2, `Unknown follow-up mode ${mode}.`)
  if (existing.length && mode !== 'worktree') throw new Fail(2, '--existing-issue needs --mode worktree.')
  if (existing.includes(wf.issue)) throw new Fail(2, `#${wf.issue} cannot be its own follow-up.`)
  const tool = mode === 'this_agent' ? 'followUpThisAgent' : mode === 'issue_only' ? 'followUpIssue' : 'followUpOther'
  const to = moveFor(wf, config, tool)
  const hash = createHash('sha256').update(JSON.stringify([mode, message, existing])).digest('hex')
  const notes: string[] = []
  const [title, ...body] = message.split('\n')
  let entry = wf.followUps.find((item: {hash: string}) => item.hash === hash)
  if (entry?.complete) return report(wf, config, [`Follow-up #${entry.issue} is already recorded${entry.dispatchId ? ` as worker ${entry.dispatchId}` : ''}.`])
  if (mode === 'this_agent' && readPr(wf, prOf(wf)).state !== 'open') throw new Fail(1, `PR #${prOf(wf)} cannot carry a new issue because it is closed.`)
  if (!entry) {
    for (const id of existing) {
      const prior = wf.followUps.find((item: {dispatchId?: string; issues?: number[]; issue: number}) => item.dispatchId && (item.issues || [item.issue]).includes(id))
      if (prior) throw new Fail(1, `#${id} already belongs to worker ${prior.dispatchId}.`)
      const issue = ghJson<{state: string}>(wf.root, wf.repo, ['issue-read', String(id)])
      if (issue.state !== 'open') throw new Fail(1, `Follow-up issue #${id} is ${issue.state}.`)
    }
    const issue = existing[0] || createIssueOnce(wf.root, wf.repo, ['follow-up', String(wf.issue), mode], title!, `${body.join('\n')}\n\nFound while working on #${wf.issue}.`)
    entry = { hash, title, mode, issue, ...(existing.length ? { issues: existing } : {}) }
    wf.followUps.push(entry)
    save(wf)
  }
  const issues = entry.issues || [entry.issue]
  if (mode === 'this_agent') {
    const pr = readPr(wf, prOf(wf))
    gh(wf, ['subissues', 'link', String(wf.issue), String(entry.issue)])
    if (!hasIssueRef(pr.body || '', entry.issue)) gh(wf, ['pr-edit', String(pr.number), '--body-file', writeTemp(wf, 'pr-body.md', `${(pr.body || '').trimEnd()}\n\nCloses #${entry.issue}\n`)])
    if (!readRecord(wf.root, entry.issue)) save({ issue: entry.issue, root: wf.root, repo: wf.repo, base: wf.base, branch: wf.branch, ...(wf.localBranch ? { localBranch: wf.localBranch } : {}), prs: [pr.number], mode: wf.mode, steering: wf.steering, owner: wf.owner, state: 'developing', baseCheck: wf.baseCheck, evidence: {}, history: [], followUps: [], migrations: [] })
  }
  if ((mode === 'worktree' || mode === 'subagent') && !entry.dispatchId) {
    const main = gitOk(wf.root, 'worktree', 'list', '--porcelain', '-z').split('\0')[0]!.slice(9)
    const task = `Work on ${issues.map((id: number) => '#' + id).join(', ')} of ${wf.repo} together on one draft PR. Start each issue with ndev flow start in this workspace.\n\n${message}`
    const agent = process.env.NDEV_WORKER_AGENT || (process.env.CLAUDE_SESSION_ID ? 'claude' : 'codex')
    const slug = title!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 38) || 'follow-up'
    const worker = ['orchestration', 'worker-start', '--spec', task, '--task-title', title!, '--worktree', mode === 'subagent' ? 'new-child' : 'new-top-level', '--repo', `path:${main}`, '--name', `${entry.issue}-${slug}`, '--base-branch', `origin/${wf.base}`, '--agent', agent, '--full']
    dispatchWorker(wf, entry, worker, `follow-up #${entry.issue}`)
    notes.push(`Worker ${entry.dispatchId} in run ${entry.runId} carries ${issues.join(', ')}.`)
  }
  entry.complete = true
  notes.push(`Follow-up #${entry.issue}: ${title}.`)
  apply(wf, to, tool, notes)
  save(wf)
  return report(wf, config, notes)
}
function publicMigration(wf: Workflow, config: Config, args: Args) {
  const name = need(args, 'name')
  if (!/^[a-z0-9_]+$/.test(name)) throw new Fail(2, `Invalid migration name "${name}".`)
  if (wf.direct || !wf.prs[0] || ['setup', 'done', 'wait', 'blocked'].includes(wf.state)) throw new Fail(1, `#${wf.issue} cannot add a PR migration in ${wf.state}.`)
  const root = realpathSync(wf.root)
  const workdir = realpathSync(resolve(root, args.workdir || '.'))
  const under = (dir: string) => dir === root || dir.startsWith(root + '/')
  if (!under(workdir) || !existsSync(join(workdir, 'supabase/config.toml'))) throw new Fail(2, `Expected a Supabase workdir inside ${root}: ${workdir}`)
  const parent = realpathSync(join(workdir, 'supabase'))
  if (!under(parent)) throw new Fail(2, `Supabase directory escapes ${root}: ${parent}`)
  const dir = join(parent, 'migrations')
  mkdirSync(dir, { recursive: true })
  if (!under(realpathSync(dir))) throw new Fail(2, `Migration directory escapes ${root}: ${dir}`)
  if (args.adopt && args['new-version']) throw new Fail(2, `--adopt lists an existing file and --new-version moves a listed one. Repair: pass only one of them for ${name}.`)
  const sharing = (publicCli!.readWorkflowRecords(wf.root) as Workflow[]).filter(record => record.prs?.[0] === wf.prs[0])
  let entry = (wf.migrations || []).find((item: {name: string}) => item.name === name)
  if (args.adopt) {
    if (entry) throw new Fail(2, `Migration ${name} is already listed as ${entry.path} on #${wf.issue}. Repair: drop --adopt, or use --new-version to move it.`)
    const target = resolve(root, args.adopt)
    if (dirname(target) !== dir) throw new Fail(2, `Cannot adopt ${args.adopt}: it is not directly inside ${dir}. Repair: pass a path of the form ${relative(root, dir)}/<version>_${name}.sql.`)
    if (!existsSync(target)) throw new Fail(2, `Cannot adopt ${args.adopt}: ${target} does not exist. Repair: pass the path of the existing migration file, or leave out --adopt to create a new empty one.`)
    const stat = lstatSync(target)
    if (!stat.isFile()) throw new Fail(2, `Cannot adopt ${args.adopt}: ${target} is not a file.`)
    const adopted = relative(root, target)
    const holder = sharing.find(record => (record.migrations || []).some((item: {path: string}) => item.path === adopted))
    if (holder || wf.migrations?.some((item: {path: string}) => item.path === adopted)) throw new Fail(2, `Cannot adopt ${adopted}: it is already listed on #${holder?.issue ?? wf.issue}.`)
    if (!new RegExp(`^\\d{14}_${name}\\.sql$`).test(basename(target))) throw new Fail(2, `Cannot adopt ${adopted}: the file name does not match the migration name ${name}. Repair: pass --adopt with a file named <14-digit version>_${name}.sql, or use the name that the file already has.`)
    entry = { name, path: adopted }
    wf.migrations = [...(wf.migrations || []), entry]
    save(wf)
  } else if (!entry || args['new-version']) {
    const newest = readdirSync(dir).map(f => /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_/.exec(f)).filter(Boolean).map(m => Date.UTC(+m![1]!, +m![2]! - 1, +m![3]!, +m![4]!, +m![5]!, +m![6]!) + 1000)
    const version = new Date(Math.max(Date.now(), ...newest)).toISOString().replace(/\D/g, '').slice(0, 14)
    const path = join(dir, `${version}_${name}.sql`)
    if (args['new-version']) {
      if (!entry) throw new Fail(2, `Migration ${name} is not listed on #${wf.issue}.`)
      const old = realpathSync(join(root, entry.path))
      if (!under(old)) throw new Fail(1, `Migration path leaves the worktree: ${old}`)
      copyFileSync(old, path, constants.COPYFILE_EXCL)
      entry.previous = entry.path
      entry.path = relative(root, path)
    } else {
      writeFileSync(path, '', { flag: 'wx' })
      entry = { name, path: relative(root, path) }
      wf.migrations = [...(wf.migrations || []), entry]
    }
    save(wf)
  }
  if (!existsSync(join(root, entry.path))) throw new Fail(1, `Migration ${name} is missing. Restore ${entry.path} before retrying.`)
  const body = readPr(wf, prOf(wf)).body || ''
  const pattern = /<!-- ndev:migrations -->[\s\S]*?<!-- \/ndev:migrations -->/
  const inBody = [...(pattern.exec(body)?.[0] ?? '').matchAll(/^- `([^`]+)`$/gm)].map(m => m[1]!)
  const moved = entry.previous ? new Map([[entry.previous, entry.path]]) : new Map<string, string>()
  const paths = [...new Set([...inBody.map(path => moved.get(path) ?? path), ...sharing.flatMap(record => (record.migrations || []).map((m: {path: string}) => m.path)).filter(path => !moved.has(path)), ...wf.migrations.map((m: {path: string}) => m.path)])]
  const section = `<!-- ndev:migrations -->\n## Migrations to run after merge\n\n${paths.map(path => '- `' + path + '`').join('\n')}\n<!-- /ndev:migrations -->`
  const updated = pattern.test(body) ? body.replace(pattern, () => section) : body.trimEnd() + '\n\n' + section + '\n'
  if (body !== updated) gh(wf, ['pr-edit', String(prOf(wf)), '--body-file', writeTemp(wf, 'pr-body.md', updated)])
  return report(wf, config, [`Migration: ${entry.path}.${entry.previous ? ` The SQL was copied from ${entry.previous}. Remove the old version and checkpoint both paths.` : ''}`])
}

function developMembers(root: string, config: Config, args: Args, numbers: Record<string, number[]>) {
  const records = publicCli!.readWorkflowRecords(root) as Workflow[]
  const local = records.filter(record => !record.pr)
  const named = numbers.issue || []
  const prs = numbers.pr || []
  const lead = named.length ? local.find(record => record.issue === named[0]) : prs.length ? local.find(record => record.prs.includes(prs[0]!)) : load(root, args)
  if (!lead) throw new Fail(2, `No workflow in ${root} for ${named.length ? 'issue #' + named[0] : 'PR #' + prs[0]}.`)
  const pr = lead.prs[0]
  if (config.workflow === false) throw new Fail(1, `Workflow is off in ${root}. Run ndev flow on --project.`)
  if (prs.length && lead.direct) throw new Fail(2, `Issue #${lead.issue} works directly on ${lead.base} and has no PR.`)
  for (const number of prs) {
    const target = readPr(lead, number)
    if (target.head.ref !== lead.branch || target.state !== 'open') throw new Fail(1, `PR #${number} is ${target.state} on ${target.head.ref}. Expected an open PR on ${lead.branch}.`)
  }
  const targets = named.length ? named : [lead.issue]
  const selected = targets.map(n => {
    const wf = local.find(record => record.issue === n)
    if (!wf || wf.prs[0] !== pr || wf.branch !== lead.branch || wf.root !== root) throw new Fail(1, `#${n} does not share ${lead.branch} and PR #${pr} in ${root}.`)
    if (wf.off) throw new Fail(1, `Workflow of #${n} is off: ${wf.off.reason}.`)
    const other = ownedElsewhere(wf)
    if (other) throw new Fail(1, other)
    if (wf.state !== 'developed') {
      requireDevelopmentConfirmation(wf, config, args)
      moveFor(wf, config, 'finishedDevelopment')
      if (wf.state === 'developing' && baseCheckScript(wf.mode) && !wf.baseCheck) throw new Fail(1, `#${n} needs its base check. Run ndev flow finished-interview --issue ${n}.`)
      if (MACHINES[wf.mode].hardens && !args.hardening) throw new Fail(2, `#${n} needs --hardening evidence.`)
    }
    return wf
  })
  if (gitOk(root, 'branch', '--show-current') !== (lead.localBranch || lead.branch)) throw new Fail(1, `The workflow expects branch ${lead.localBranch || lead.branch}. Switch to it before committing.`)
  args.message ||= `Finish work on ${targets.map(n => '#' + n).join(', ')}`
  lead.prs = [...new Set([...lead.prs, ...prs])]
  const members = local.filter(record => record.prs[0] === pr && !record.direct)
  if (lead.direct || members.length < 2) return finishedDevelopment(lead, config, args)
  let committed = false
  const notes: string[] = []
  for (const wf of selected) {
    if (wf.state !== 'developed') {
      const result = finishedDevelopment(wf, config, committed ? { ...args, files: '', 'body-file': '' } : args, true)
      notes.push(...result.notes)
      committed = true
    }
  }
  const waiting = members.filter(record => !['done', 'developed'].includes(record.state))
  if (waiting.length) return report(lead, config, [...notes, `PR #${pr} waits for ${waiting.map(record => '#' + record.issue).join(', ')}.`])
  const existing = records.find(record => record.pr === pr)
  if (existing) return report(existing, config, notes)
  const issues = members.map(record => record.issue).sort((a, b) => a - b)
  const carrier = { ...lead, issue: issues[0]!, pr, issues, prs: [pr!], rev: undefined, state: lead.state, history: [], evidence: {}, changeTypes: [...new Set(members.flatMap(record => record.changeTypes || []))], migrations: [...new Map(members.flatMap(record => record.migrations || []).map(entry => [entry.path, entry])).values()], followUps: [...new Map(members.flatMap(record => record.followUps || []).map(entry => [entry.hash, entry])).values()] } as Workflow
  apply(carrier, { state: 'reviewing' }, 'finishedDevelopment', notes)
  save(carrier)
  return report(carrier, config, [...notes, `PR #${pr} carries ${issues.map(n => '#' + n).join(', ')} through review.`])
}

function dispatchWorker(wf: Workflow, entry: Record<string, any>, command: string[], label: string) {
  if (entry.dispatchId) return
  if (entry.starting && !entry.requestId) throw new Fail(1, `The previous start of ${label} has no confirmed outcome. Inspect orca orchestration worker-list --json before retrying.`)
  const environment = entry.environment ?? orcaEnvironment()
  if (entry.requestId) {
    const status = orca(wf.root, environment, ['orchestration', 'request-show', '--request', entry.requestId, '--full'])
    if ((status.state ?? status.status) === 'absent') throw new Fail(1, `Orca no longer has request ${entry.requestId} for ${label}. Inspect orca orchestration worker-list --json.`)
    command.push('--retry-request', entry.requestId)
  }
  entry.starting = true
  entry.environment = environment
  save(wf)
  try {
    const receipt = orca(wf.root, environment, command)
    entry.requestId = receipt.requestId || entry.requestId
    entry.runId = receipt.runId
    if (receipt.state !== 'ready' || !receipt.dispatchId) throw new Fail(1, `Orca did not start ${label}: ${JSON.stringify(receipt)}`)
    entry.dispatchId = receipt.dispatchId
    delete entry.starting
  } catch (error) {
    const id = /"requestId"\s*:\s*"([^"]+)"/.exec((error as Error).message)?.[1]
    if (id) entry.requestId = id
    save(wf)
    throw error
  }
  save(wf)
}
function ensureReviewWorkers(wf: Workflow) {
  const agent = process.env.NDEV_REVIEW_AGENT || (process.env.CLAUDECODE === '1' ? 'claude' : 'codex')
  const model = agent === 'claude' ? 'sonnet' : agent === 'codex' ? 'gpt-6.1-terra' : undefined
  for (const reviewer of wf.exportReview.runs) {
    const spec = readFileSync(reviewer.brief, 'utf8')
    const command = ['orchestration', 'worker-start', '--spec', spec, '--task-title', `Review #${wf.issue} (${reviewer.axis})`, '--worktree', `path:${wf.root}`, '--agent', agent, ...(model ? ['--model', model] : []), '--full']
    dispatchWorker(wf, reviewer, command, `review of #${wf.issue} (${reviewer.axis})`)
  }
}
