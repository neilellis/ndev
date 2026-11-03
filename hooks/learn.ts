// After each push that lands, asks for the dev-wiki ingest: the session's reusable development,
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

export const ingestText = (background: boolean) =>
  background
    ? `A push is running in the background. When it finishes with exit 0, ${INGEST}`
    : `A push just landed. Before you go on, ${INGEST}`

export const isPush = (command: string) => {
  const code = shellCode(command)
  return [...code.matchAll(PUSH)].some(m => !DRY_RUN.test(code.slice(m.index).split(/[;&|\n]/)[0] ?? ''))
}

// While a workflow runs, its finishing step asks for the ingest instead.
export const learnAfterPush = (on: On, getProject: () => LoadedConfig | undefined = () => undefined) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = String((e as { command?: unknown }).command ?? '')
    if (ran.deny !== undefined || ran.isError === true || !isPush(command)) return ran
    if (await workflowOwnsChecks($, getProject())) return ran
    const background = (e as { run_in_background?: unknown }).run_in_background === true
    return { ...ran, context: [...(ran.context ?? []), ingestText(background)] }
  })
}
