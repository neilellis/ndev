// The outside world of the workflow tools: git, GitHub, Orca, the check scripts and the notification.
import type { EngineInterface } from 'claude-code'
import { checkLog, outputCut } from './check-log'
import { withStep } from './progress'

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

// Runs a check script. The engine runs git with the repository's hooks off, so these are the hooks.
// When the base branch has the script, its version runs, so a branch cannot pass by editing its own
// check. The return value notes a script that the base does not have, or that the branch changed.
export async function runCheck($: EngineInterface, root: string, base: string, check: Check, args: string[] = []): Promise<string | undefined> {
  const path = `${CHECK_DIR}/${check}`
  const { gitDir } = await paths($, root)
  const onBase = (await git(root, $, 'cat-file', '-e', `origin/${base}:${path}`)).exitCode === 0
  let script = `${root}/${path}`
  let note: string | undefined = `${path} is not on ${base} yet, so a human must read it in this PR.`
  if (onBase) {
    script = `${gitDir}/ndev-${check}`
    await $.fs.write(script, await gitOut(root, $, 'show', `origin/${base}:${path}`))
    const changed = (await git(root, $, 'diff', '--quiet', `origin/${base}`, '--', path)).exitCode !== 0
    note = changed ? `This branch changes ${path}. The tool ran the version on ${base}, and a human must read the change in this PR.` : undefined
  }
  const before = (await porcelain($, root)).join('\n')
  const r = await withStep($, check, 600_000, () => run($, ['bash', script, ...args], { cwd: root, timeoutMs: 600_000 }))
  const log = `${gitDir}/ndev-${check}.log`
  await $.fs.write(log, checkLog(r, path))
  if (r.exitCode !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-20).join('\n').slice(-4000)
    const cut = outputCut(r, path)
    const output = `${cut ? `${cut}\n` : ''}${tail}`
    throw new CheckFailed(`${path} exited ${r.exitCode} (a run longer than 10 minutes is stopped). Nothing was pushed. Fix the cause and call the tool again. Log: ${log}\n${output}`, { path, exitCode: r.exitCode, log, output })
  }
  const after = (await porcelain($, root)).join('\n')
  if (after !== before) throw new CheckFailed(`${path} passed but changed the working tree. Name the changed files in the tool call and call it again:\n${after}`, { path, exitCode: 0, log, output: after })
  return note
}

// ---- GitHub reads ----
export type Pr = { number: number; state: string; merged?: boolean; draft: boolean; mergeable: boolean | null; mergeable_state?: string; body: string | null; created_at: string; head: { sha: string; ref: string } }
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

export type Checks = { pending: string[]; red: string[]; green: string[] }
// With the PR number this costs one gh call, because the PR rollup holds both kinds of check.
export async function readChecks($: EngineInterface, root: string, repo: string, sha: string, pr?: number): Promise<Checks> {
  const { check_runs: runs, statuses } = await ghOne<{ check_runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[] }>($, root, repo, ['commit-checks', sha, ...(pr ? ['--pr', String(pr)] : [])])
  const out: Checks = { pending: [], red: [], green: [] }
  for (const c of runs) {
    if (c.status !== 'completed') out.pending.push(c.name)
    else if (['success', 'skipped', 'neutral'].includes(c.conclusion ?? '')) out.green.push(c.name)
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

export type Alert = { group: string; pid?: number; problem?: string }
export async function raiseAlert($: EngineInterface, root: string, issue: number, message: string, title = `ndev: #${issue} is blocked`): Promise<Alert> {
  const group = `ndev-${root.split('/').pop()}-${issue}`
  const { gitDir } = await paths($, root)
  const terminal = String((await $.env.get('ORCA_TERMINAL_HANDLE')) ?? '')
  const r = await run($, ['bash', `${$.plugin.root}/scripts/workflow/notify.sh`, 'raise', '--group', group, '--title', title, '--message', message.slice(0, 200), '--terminal', terminal, '--log', `${gitDir}/ndev-notify.log`], { cwd: root, timeoutMs: 20_000 })
  if (r.exitCode !== 0) return { group, problem: said(r) }
  return { group, pid: Number(r.stdout.trim()) || undefined }
}

export async function withdrawAlert($: EngineInterface, root: string, alert: { group: string; pid?: number }): Promise<string | undefined> {
  const r = await run($, ['bash', `${$.plugin.root}/scripts/workflow/notify.sh`, 'withdraw', '--group', alert.group, ...(alert.pid ? ['--pid', String(alert.pid)] : [])], { cwd: root, timeoutMs: 20_000 })
  return r.exitCode === 0 ? undefined : `notify.sh withdraw exited ${r.exitCode}: ${said(r)}`
}
