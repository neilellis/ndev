// The outside world of the workflow tools: git, GitHub, Orca, the check scripts and the notification.
import type { EngineInterface } from 'claude-code'
import { CHANGE_TYPES, inferChangeTypes, type ChangeType } from './change-types'
import { checkLog, outputCut } from './check-log'
import { withStep } from './progress'
import { loadConfigAt } from '../config'
import { parseEnvFile } from './secrets'

export const CHECKS = ['fast-checks.sh', 'pre-commit-check.sh', 'pre-push-check.sh', 'pre-ready-check.sh'] as const
export type Check = (typeof CHECKS)[number]
export const CHECK_DIR = 'scripts/ndev/workflow'
export const MARKER = '<!-- work-heavy-auto:workflow -->'

// A refusal: nothing changed or the tool stopped here, and the message says why and what to do.
export class Refuse extends Error {}
// A check script that stopped a tool, with its parts for a caller that words the failure in another way.
export class CheckFailed extends Refuse {
  constructor(message: string, readonly detail: { path: string; exitCode: number; log: string; output: string }) {
    super(message)
  }
}

export type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export const said = (r: Ran) => (r.stderr.trim() || r.stdout.trim() || 'no output').slice(-1500)

// A command that cannot start (not on PATH) is a failed result with its reason, not a throw.
export async function run($: EngineInterface, argv: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string }): Promise<Ran> {
  try {
    return await $.process.run(argv, { timeoutMs: 60_000, ...opts })
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: `${argv[0]} did not run: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function must($: EngineInterface, argv: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string }): Promise<string> {
  const r = await run($, argv, opts)
  if (r.exitCode !== 0) throw new Refuse(`${argv.slice(0, 3).join(' ')} exited ${r.exitCode} in ${opts.cwd}: ${said(r)}`)
  return r.stdout.trim()
}

export function git(root: string, $: EngineInterface, ...args: string[]) {
  return run($, ['git', ...args], { cwd: root })
}
export function gitOut(root: string, $: EngineInterface, ...args: string[]) {
  return must($, ['git', ...args], { cwd: root })
}
export function head(root: string, $: EngineInterface) {
  return gitOut(root, $, 'rev-parse', 'HEAD')
}

// Each GitHub call goes through scripts/github/gh.sh: the gh command first, then REST. Both routes
// print the REST shape, one JSON object per line.
export function gh($: EngineInterface, root: string, repo: string, args: string[]) {
  return must($, ['bash', `${$.plugin.root}/scripts/github/gh.sh`, ...args], { cwd: root, env: { GH_REPO: repo } })
}
export async function ghLines<T>($: EngineInterface, root: string, repo: string, args: string[]): Promise<T[]> {
  const out = await gh($, root, repo, args)
  try {
    return out.split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
  } catch (error) {
    throw new Error(`gh.sh ${args[0]} printed no JSON (${String(error).slice(0, 120)}): ${out.slice(0, 200)}`)
  }
}
export async function ghOne<T>($: EngineInterface, root: string, repo: string, args: string[]): Promise<T> {
  const [first] = await ghLines<T>($, root, repo, args)
  if (first === undefined) throw new Error(`gh.sh ${args.join(' ')} printed nothing.`)
  return first
}

export type Paths = { gitDir: string; main: string; isMain: boolean }
export async function paths($: EngineInterface, root: string): Promise<Paths> {
  const [gitDir, common] = (await gitOut(root, $, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')).split('\n')
  return { gitDir: gitDir!, main: common!.replace(/\/\.git\/?$/, ''), isMain: gitDir === common }
}

// The path of each changed file: "XY path", or "XY old -> new" for a rename.
export async function porcelain($: EngineInterface, root: string) {
  // Not through must, which trims: the first line's leading space is part of its status column.
  // All untracked files, one line each: the default shows one line for a folder, and a caller compares file names.
  const r = await run($, ['git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })
  if (r.exitCode !== 0) throw new Refuse(`git status exited ${r.exitCode} in ${root}: ${said(r)}`)
  return r.stdout.split('\n').filter(Boolean)
}
export const changedPaths = (lines: string[]) => lines.map(l => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))

// ---- the check scripts ----
export async function missingChecks($: EngineInterface, root: string): Promise<string[]> {
  const missing: string[] = []
  for (const c of CHECKS) {
    const r = await run($, ['test', '-x', `${root}/${CHECK_DIR}/${c}`], { cwd: root })
    if (r.exitCode !== 0) missing.push(`${CHECK_DIR}/${c}`)
  }
  return missing
}

// The host stops one process after 10 minutes, and a full check on a loaded machine can run for longer.
// So run-check.sh starts the check detached, and each wait for it is one process shorter than that limit.
export const CHECK_MAX_MS = 60 * 60_000
const WAIT_PART_S = 540
async function runLong($: EngineInterface, root: string, dir: string, script: string, args: string[], env: Record<string, string>): Promise<Ran & { stoppedAfterMs?: number }> {
  const runner = `${$.plugin.root}/scripts/workflow/run-check.sh`
  const started = await run($, ['bash', runner, 'start', dir, script, ...args], { cwd: root, env, timeoutMs: 30_000 })
  const pid = started.stdout.trim()
  if (started.exitCode !== 0 || !/^\d+$/.test(pid)) return { exitCode: started.exitCode || 1, stdout: '', stderr: `run-check.sh did not start ${script} (exit ${started.exitCode}): ${said(started)}` }
  const at = await $.clock.now()
  let exitCode: number | undefined
  let stoppedAfterMs: number | undefined
  while (exitCode === undefined) {
    const left = CHECK_MAX_MS - ((await $.clock.now()) - at)
    if (left <= 0) {
      stoppedAfterMs = CHECK_MAX_MS - left
      const stop = await run($, ['bash', runner, 'stop', pid], { cwd: root, timeoutMs: 30_000 })
      if (stop.exitCode !== 0) $.ui.log(`ndev: run-check.sh stop ${pid} exited ${stop.exitCode}: ${said(stop)}`, { to: 'debug' })
      exitCode = 124
      break
    }
    const secs = Math.max(1, Math.min(WAIT_PART_S, Math.ceil(left / 1000)))
    const waited = await run($, ['bash', runner, 'wait', dir, pid, String(secs)], { cwd: root, timeoutMs: (secs + 30) * 1000 })
    if (waited.exitCode === 124) continue
    if (waited.exitCode !== 0 || !/^\d+$/.test(waited.stdout.trim())) {
      await run($, ['bash', runner, 'stop', pid], { cwd: root, timeoutMs: 30_000 })
      return { exitCode: waited.exitCode || 1, stdout: '', stderr: `run-check.sh wait ${dir} ${pid} exited ${waited.exitCode}, so the check (pid ${pid}) was stopped: ${said(waited)}` }
    }
    exitCode = Number(waited.stdout.trim())
  }
  // cat through the host keeps the first 4 MiB of each stream and says when it cut, as a direct run did.
  const out = await run($, ['bash', runner, 'out', dir], { cwd: root, timeoutMs: 60_000 })
  const err = await run($, ['bash', runner, 'err', dir], { cwd: root, timeoutMs: 60_000 })
  const stderr = stoppedAfterMs === undefined ? err.stdout : `${err.stdout}\n[stopped by the tool after ${Math.round(stoppedAfterMs / 60_000)} minutes]`
  return { exitCode, stdout: out.stdout, stderr, isStdoutTruncated: out.isStdoutTruncated, isStderrTruncated: err.isStdoutTruncated, ...(stoppedAfterMs === undefined ? {} : { stoppedAfterMs }) }
}

// The keys of the worktree's .neil-dev.env that checkEnv in .neil-dev.json names, such as the URL of a local
// test database, as CI sets them. The other keys stay out, as they can be credentials for hosted services
// (fcc-proto's FALKORDB_URL for kb:publish made its tests write to the hosted graph server); withheld names them.
async function projectEnv($: EngineInterface, root: string, path: string): Promise<{ env: Record<string, string>; withheld: string[] }> {
  const file = `${root}/.neil-dev.env`
  const named = (await loadConfigAt($, root)).config.checkEnv ?? []
  let values: Record<string, string> = {}
  try {
    if (await $.fs.exists(file)) values = parseEnvFile(await $.fs.read(file), file)
  } catch (e) {
    throw new Refuse(`${path} did not run: ${e instanceof Error ? e.message : String(e)} Nothing was pushed. Then call the tool again.`)
  }
  const missing = named.filter(k => !(k in values))
  if (missing.length) throw new Refuse(`${path} did not run: checkEnv in ${root}/.neil-dev.json names ${missing.join(', ')}, which ${file} does not set. Nothing was pushed. Repair: node ${$.plugin.root}/scripts/env/neil-dev-env.mjs init ${missing.map(k => `--key ${k}`).join(' ')}, or take the name out of checkEnv. Then call the tool again.`)
  return { env: Object.fromEntries(named.map(k => [k, values[k] as string])), withheld: Object.keys(values).filter(k => !named.includes(k)) }
}

// Runs a check script. The engine runs git with the repository's hooks off, so these are the hooks.
// When the base branch has the script, its version runs, so a branch cannot pass by editing its own
// check. The branch's change is measured from the merge base (three dots): a script that only the base
// moved on is not the branch's change. The return value notes a script that the base does not have, or that the branch changed.
// NDEV_MERGE_BASE is the merge base that the commit will have. While a merge is in progress the checks
// run before its commit, so HEAD is still the commit before the merge, and `git merge-base HEAD
// origin/<base>` gives the old base: what the base brought in would count as the branch's.
// NDEV_CHANGE_TYPES: the branch's change types, comma-separated, so that a check can choose its tests: those
// declared or recorded, and those of each path in the index that differs from the merge base (a check
// before a commit runs before the commit is made). Unset when the paths cannot be read, or no type
// applies: the script then reads its own diff.
async function changeTypesEnv($: EngineInterface, root: string, base: string, mergeBase: string, declared: readonly ChangeType[]): Promise<{ value?: string; note?: string }> {
  if (!mergeBase) return { note: `NDEV_CHANGE_TYPES was not set: there is no merge base with origin/${base}, so the check scripts read their own diff. Repair: git fetch origin ${base}.` }
  const r = await git(root, $, 'diff', '--cached', '--name-only', '--no-renames', mergeBase)
  if (r.exitCode !== 0) return { note: `NDEV_CHANGE_TYPES was not set, so the check scripts read their own diff: git diff --cached --name-only --no-renames ${mergeBase.slice(0, 8)} exited ${r.exitCode}: ${said(r)}. Repair: git fetch origin ${base}.` }
  const inPaths = inferChangeTypes(r.stdout.split('\n').filter(Boolean))
  const types = CHANGE_TYPES.filter(t => declared.includes(t) || inPaths.includes(t))
  return types.length ? { value: types.join(',') } : {}
}

export async function runCheck($: EngineInterface, root: string, base: string, check: Check, args: string[] = [], declared: readonly ChangeType[] = []): Promise<string | undefined> {
  const path = `${CHECK_DIR}/${check}`
  const { gitDir } = await paths($, root)
  const onBase = (await git(root, $, 'cat-file', '-e', `origin/${base}:${path}`)).exitCode === 0
  let script = `${root}/${path}`
  let note: string | undefined = `${path} is not on ${base} yet, so a human must read it in this PR.`
  if (onBase) {
    script = `${gitDir}/ndev-${check}`
    await $.fs.write(script, await gitOut(root, $, 'show', `origin/${base}:${path}`))
    const changed = (await git(root, $, 'diff', '--quiet', `origin/${base}...HEAD`, '--', path)).exitCode !== 0
    note = changed ? `This branch changes ${path}. The tool ran the version on ${base}, and a human must read the change in this PR.` : undefined
  }
  const merging = (await git(root, $, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).exitCode === 0
  const mergeBase = merging ? await git(root, $, 'merge-base', `origin/${base}`, 'HEAD', 'MERGE_HEAD') : await git(root, $, 'merge-base', `origin/${base}`, 'HEAD')
  const baseSha = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : ''
  const types = await changeTypesEnv($, root, base, baseSha, declared)
  const project = await projectEnv($, root, path)
  const env: Record<string, string> = { ...project.env, ...(baseSha ? { NDEV_MERGE_BASE: baseSha } : {}), ...(types.value ? { NDEV_CHANGE_TYPES: types.value } : {}) }
  note = [note, types.note].filter(Boolean).join(' ') || undefined
  const before = (await porcelain($, root)).join('\n')
  const r = await withStep($, check, CHECK_MAX_MS, () => runLong($, root, `${gitDir}/ndev-${check}.run`, script, args, env))
  const log = `${gitDir}/ndev-${check}.log`
  await $.fs.write(log, checkLog(r, path))
  if (r.stoppedAfterMs !== undefined) {
    throw new CheckFailed(`${path} was still running after ${CHECK_MAX_MS / 60_000} minutes, the most that a check may run, so the tool stopped it. Nothing was pushed. Repair: make the check faster, or run bash ${path} in a terminal to see where it spends the time, then call the tool again. Its output up to the stop is in the log: ${log}`, { path, exitCode: r.exitCode, log, output: r.stderr.trim() })
  }
  if (r.exitCode !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n').slice(-4000)
    const cut = outputCut(r, path)
    const output = `${cut ? `${cut}\n` : ''}${tail}`
    const merge = merging ? ` A merge is in progress, so HEAD is the commit before the merge: a check that compares with \`git merge-base HEAD origin/${base}\` reads the old base. Repair: read the base from NDEV_MERGE_BASE=${env.NDEV_MERGE_BASE ?? '(git merge-base failed)'}, as ${base} merged in here.` : ''
    const withheld = project.withheld.length ? ` The check did not get ${project.withheld.join(', ')} from ${root}/.neil-dev.env: the checks get only the keys that checkEnv in .neil-dev.json names. If a test needs one, such as the URL of a local test database, name it there; never a key of a hosted service.` : ''
    throw new CheckFailed(`${path} exited ${r.exitCode}. Nothing was pushed.${merge}${withheld} Fix the cause and call the tool again. Log: ${log}\n${output}`, { path, exitCode: r.exitCode, log, output })
  }
  const after = (await porcelain($, root)).join('\n')
  if (after !== before) throw new CheckFailed(`${path} passed but changed the working tree. Name the changed files in the tool call and call it again:\n${after}`, { path, exitCode: 0, log, output: after })
  return note
}

// ---- GitHub reads ----
export type Pr = { number: number; state: string; merged?: boolean; draft: boolean; mergeable: boolean | null; mergeable_state?: string; body: string | null; created_at: string; head: { sha: string; ref: string }; merge_commit_sha?: string | null; base?: { ref: string } }
export function readPr($: EngineInterface, root: string, repo: string, n: number) {
  return ghOne<Pr>($, root, repo, ['pr-read', String(n)])
}

// GitHub calls are limited. Local git answers this question with no call at all.
export async function repoFromOrigin($: EngineInterface, root: string): Promise<string> {
  const url = await gitOut(root, $, 'remote', 'get-url', 'origin')
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/)
  if (!match) throw new Refuse(`Refused: the origin of ${root} is not a GitHub repository (${url}). Repair: set github.repo in .neil-dev.json with /dev setup.`)
  return match[1] as string
}
// From GitHub and not from refs/remotes/origin/HEAD: clone sets that ref once, and a fetch does not move it.
export async function defaultBranch($: EngineInterface, root: string, repo: string): Promise<string> {
  return (await ghOne<{ default_branch: string }>($, root, repo, ['default-branch'])).default_branch
}

export function markReady($: EngineInterface, root: string, repo: string, n: number) {
  return gh($, root, repo, ['pr-ready', String(n)])
}

export type Checks = { pending: string[]; red: string[]; green: string[]; skipped?: string[] }
// With the PR number this costs one gh call, because the PR rollup holds both kinds of check.
export async function readChecks($: EngineInterface, root: string, repo: string, sha: string, pr?: number): Promise<Checks> {
  const { check_runs: runs, statuses } = await ghOne<{ check_runs: { name: string; status: string; conclusion: string | null; started_at?: string | null }[]; statuses: { context: string; state: string }[] }>($, root, repo, ['commit-checks', sha, ...(pr ? ['--pr', String(pr)] : [])])
  const out: Checks = { pending: [], red: [], green: [] }
  // A concurrency group cancels the older run of a check when a newer one starts, and both stay listed.
  // Only the latest run of each name counts: the cancelled one is no failure.
  const latest = new Map<string, (typeof runs)[number]>()
  for (const c of runs) {
    const seen = latest.get(c.name)
    if (!seen || (c.started_at ?? '') >= (seen.started_at ?? '')) latest.set(c.name, c)
  }
  for (const c of latest.values()) {
    if (c.status !== 'completed') out.pending.push(c.name)
    else if (['success', 'skipped', 'neutral'].includes(c.conclusion ?? '')) {
      out.green.push(c.name)
      if (c.conclusion === 'skipped') out.skipped = [...(out.skipped ?? []), c.name]
    }
    else out.red.push(`${c.name} (${c.conclusion})`)
  }
  for (const s of statuses) {
    if (s.state === 'pending') out.pending.push(s.context)
    else if (s.state === 'success') out.green.push(s.context)
    else out.red.push(`${s.context} (${s.state})`)
  }
  // Just after a push GitHub lists no checks yet, so none is pending at first. A path filter can
  // mean that none ever comes, and external CI leaves no workflow folder, so each wait has a limit.
  if (out.pending.length + out.red.length + out.green.length === 0) {
    const workflows = (await git(root, $, 'ls-tree', '-d', 'HEAD', '.github/workflows')).stdout.trim() !== ''
    const limit = workflows ? 10 * 60_000 : 2 * 60_000
    const at = await git(root, $, 'log', '-1', '--format=%ct', sha)
    const age = (await $.clock.now()) - Number(at.stdout.trim()) * 1000
    if (at.exitCode !== 0 || age < limit) out.pending.push(`no check has started yet for this commit. If none has started ${limit / 60_000} minutes after the commit, this repository runs none for it`)
  }
  return out
}

// What the idle heartbeat wants to know, for as few GitHub calls as it can: one read of the PR. Only
// a state other than "clean" costs the extra read of the checks. `checks` lets a caller that needs
// them too spend no second read.
export type PrHealth = { number: number; merged: boolean; closed: boolean; problems: string[]; sha: string; checks?: Checks; seen: Record<string, string>; computing: boolean }
export async function readPrHealth($: EngineInterface, root: string, repo: string, n: number): Promise<PrHealth> {
  const pr = await readPr($, root, repo, n)
  const health: PrHealth = { number: n, merged: !!pr.merged, closed: pr.state !== 'open', problems: [], sha: pr.head.sha, seen: { state: pr.merged ? 'merged' : pr.state, draft: pr.draft ? 'yes' : 'no', mergeable: `${pr.mergeable === true ? 'yes' : pr.mergeable === false ? 'no' : 'unknown'}${pr.mergeable_state ? ` (${pr.mergeable_state})` : ''}` }, computing: pr.mergeable === null || pr.mergeable_state === 'unknown' }
  if (health.closed) return health
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') health.problems.push(`PR #${n} has merge conflicts with its base. Merge the base into the branch, resolve them (the ndev:resolving-merge-conflicts skill), and call checkpoint.`)
  if (pr.mergeable_state !== 'clean') {
    health.checks = await readChecks($, root, repo, pr.head.sha, n)
    const { red } = health.checks
    if (red.length) health.problems.push(`PR #${n} has failed checks on ${pr.head.sha.slice(0, 8)}: ${red.join(', ')}. Read their logs (the ndev:fix-ci skill), fix the cause, and call checkpoint.`)
  }
  return health
}

// Human feedback with no answer, by the rules of scripts/work/pr_feedback.sh. That script reads a
// board and a claude/issue-<n> branch, and neither exists for every workflow, so this reads by PR.
type Comment = { id: number; body: string | null; user: { login: string; type?: string } | null; created_at?: string; submitted_at?: string; state?: string }
// With `after`, a comment later than that time is new. Without it, a commit after a comment answers
// it, which is what finishedRevision needs to know.
export async function newFeedback($: EngineInterface, root: string, repo: string, issue: number, pr: Pr, after?: number): Promise<string[]> {
  const all = await ghLines<Comment>($, root, repo, ['feedback', String(issue), String(pr.number)])
  // A comment that opens with an HTML comment marker, such as <!-- visual-diff -->, is a report a script
  // posted (under the user's own login), not a request.
  const isPipeline = (c: Comment) => /<!-- work-heavy-auto|^\*\*work-heavy-auto|^\*\*Smoke tested|^\s*<!--\s*[a-z][\w:-]*/i.test(c.body ?? '')
  const acked = new Set(all.filter(isPipeline).flatMap(c => [...(c.body ?? '').matchAll(/ack:([\d,]+)/g)].flatMap(m => m[1]!.split(','))))
  let since = Math.max(Date.parse(pr.created_at), after ?? 0)
  if (after === undefined) {
    const last = await git(root, $, 'log', '-1', '--format=%cI', pr.head.sha)
    if (last.exitCode !== 0) throw new Error(`git log could not read the PR head ${pr.head.sha.slice(0, 8)} in ${root}: ${last.stderr.trim().slice(0, 200)}. Repair: git pull --rebase origin ${pr.head.ref}.`)
    since = Math.max(since, Date.parse(last.stdout.trim()))
  }
  return all
    .filter(c => !isPipeline(c) && c.user?.type !== 'Bot' && !c.user?.login.endsWith('[bot]'))
    .filter(c => (c.body ?? '').trim() !== '')
    .filter(c => !acked.has(String(c.id)) && Date.parse(c.created_at ?? c.submitted_at ?? '') > since)
    .map(c => `#${c.id} from ${c.user?.login ?? 'unknown'}: ${(c.body ?? '').slice(0, 200)}`)
}

export function comment($: EngineInterface, root: string, repo: string, n: number, body: string) {
  return gh($, root, repo, ['comment', String(n), '--body', body])
}

// ---- Orca and the notification: these report a problem and never stop a tool. ----
// By the folder: another repository can have the same branch, and then `branch:main` is ambiguous.
export async function orca($: EngineInterface, root: string, args: string[]): Promise<string | undefined> {
  const r = await run($, ['orca', 'worktree', 'set', '--worktree', `path:${root}`, ...args], { cwd: root, timeoutMs: 20_000 })
  return r.exitCode === 0 ? undefined : `orca worktree set exited ${r.exitCode}: ${said(r)}`
}

// Orca's Chat UI draws no pane and no toast, while a human reads and answers in the chat. Orca marks such a
// session with ORCA_STRUCTURED_SESSION ("a structured session has no pane"), and gives it ORCA_CHAT_SCRATCH_DIR.
export async function isOrcaChat($: EngineInterface): Promise<boolean> {
  const [marker, scratch] = await Promise.all([$.env.get('ORCA_STRUCTURED_SESSION'), $.env.get('ORCA_CHAT_SCRATCH_DIR')])
  return !!marker || !!scratch
}

export type Alert = { group: string; pid?: number; problem?: string }
export async function raiseAlert($: EngineInterface, root: string, issue: number, message: string, title = `ndev: #${issue} is blocked`): Promise<Alert> {
  const group = `ndev-${root.split('/').pop()}-${issue}`
  const r = await run($, ['bash', `${$.plugin.root}/scripts/workflow/notify.sh`, 'raise', '--group', group, '--title', title, '--message', message.slice(0, 200)], { cwd: root, timeoutMs: 20_000 })
  if (r.exitCode !== 0) return { group, problem: said(r) }
  return { group }
}

export async function withdrawAlert($: EngineInterface, root: string, alert: { group: string; pid?: number }): Promise<string | undefined> {
  const r = await run($, ['bash', `${$.plugin.root}/scripts/workflow/notify.sh`, 'withdraw', '--group', alert.group, ...(alert.pid ? ['--pid', String(alert.pid)] : [])], { cwd: root, timeoutMs: 20_000 })
  return r.exitCode === 0 ? undefined : `notify.sh withdraw exited ${r.exitCode}: ${said(r)}`
}
