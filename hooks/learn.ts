// After each push that lands, as git records it, asks for the dev-wiki ingest: the session's reusable development,
// design and copywriting lessons go to ~/dev-wiki, the way a project wiki ingests on completion.
import type { Register } from 'claude-code'

import type { LoadedConfig } from './config'
import { shellCode } from './shell-code'
import { workflowOwnsChecks } from './workflow/tools'

type On = Parameters<Register>[0]

// `git push` (with options such as -C before it), or a push wrapper script such as push-checked.sh as the command.
const PUSH = /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--(?:git-dir|work-tree)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b|(?:^|[;&|(\n`]\s*|(?:^|\s)(?:(?:ba|z|da|k)?sh|source|\.)\s+)["']?(?:\S*\/)?push[\w-]*\.sh\b/g
const DRY_RUN = /\s--dry-run\b/

const INGEST =
  'run the dev-wiki ingest: load the `ndev:dev-wiki` skill and follow its "Ingest after a push" section. Review this session since the last ingest for development, design and copywriting lessons that hold outside this project and its domain, and record each one in ~/dev-wiki. A project or domain fact goes to the project wiki (the `remember` skill) instead. If there is no new lesson, say so in one line.'

export const ingestText = (landedOn?: string) =>
  landedOn === undefined
    ? `A push is running in the background. When it finishes with exit 0, ${INGEST}`
    : `A push just landed on ${landedOn}. Before you go on, ${INGEST}`

export const isPush = (command: string) => {
  const code = shellCode(command)
  return [...code.matchAll(PUSH)].some(m => !DRY_RUN.test(code.slice(m.index).split(/[;&|\n]/)[0] ?? ''))
}

const SAYS_PUSH = /push/i

// A ref name and its commit, for each remote-tracking ref. Outside a repository there are none to read.
const remoteRefs = async ($: Parameters<Parameters<On>[2]>[0], cwd: string) => {
  const ran = await $.process.run(['git', 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], { cwd, timeoutMs: 10000 })
  return ran.exitCode === 0 ? new Set(ran.stdout.split('\n').filter(line => line !== '')) : undefined
}

// Git records each push that lands in the reflog of the remote-tracking ref, and a fetch or a refused
// push does not write that entry. The command text and its exit status cannot say this: a grep can name
// a push, a script can hide one, and a later command in the call can set the exit status.
// Worktrees share refs/remotes, so the entry can also be the push of another worktree during this call.
// This call sent the commit only if HEAD contains it or the command names the branch.
// The answer is the ref, without refs/remotes/.
const pushLanded = async ($: Parameters<Parameters<On>[2]>[0], cwd: string, before: Set<string>, command: string) => {
  for (const line of (await remoteRefs($, cwd)) ?? []) {
    if (before.has(line)) continue
    const [ref, sha] = line.split(' ') as [string, string]
    const reflog = await $.process.run(['git', 'reflog', 'show', '-n', '1', '--format=%gs', ref], { cwd, timeoutMs: 10000 })
    if (!reflog.stdout.startsWith('update by push')) continue
    const short = ref.replace('refs/remotes/', '')
    if (command.includes(short.slice(short.indexOf('/') + 1))) return short
    const inHead = await $.process.run(['git', 'merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, timeoutMs: 10000 })
    if (inHead.exitCode === 0) return short
  }
  return undefined
}

// While a workflow runs, its finishing step asks for the ingest instead.
export const learnAfterPush = (on: On, getProject: () => LoadedConfig | undefined = () => undefined) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (!SAYS_PUSH.test(command)) return next(e)
    const background = (e as { run_in_background?: unknown }).run_in_background === true
    const cwd = await $.session.cwd()
    const before = background ? undefined : await remoteRefs($, cwd)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const landedOn = before === undefined ? undefined : await pushLanded($, cwd, before, command)
    const asks = background ? isPush(command) && ran.isError !== true : landedOn !== undefined
    if (!asks) return ran
    if (await workflowOwnsChecks($, getProject())) return ran
    return { ...ran, context: [...(ran.context ?? []), ingestText(landedOn)] }
  })
}
