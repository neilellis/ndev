// After a component file is written or edited, asks the agent to check the change against the
// component map in kb/ui-components.md, so it uses a rich component and not the most basic solution.
// While a workflow runs, the reply of finishedDevelopment asks this for the review stage instead.
// It asks once for each file in a session. It reads tool calls only: a file changed through Bash is not seen.
import type { Register } from 'claude-code'

import type { LoadedConfig } from './config'
import { checkText, isComponent } from './component-files'
import { workflowListsComponents } from './workflow/tools'

export { checkText, isComponent } from './component-files'

type On = Parameters<Register>[0]

// The files asked about in this session; a new session, such as after /clear, asks again.
const asked = new Set<string>()

export const startComponentCheck = () => asked.clear()

export const componentCheck = (on: On, getProject: () => LoadedConfig | undefined = () => undefined) => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const file = (e as { file_path?: unknown }).file_path
      if (ran.deny !== undefined || ran.isError === true || typeof file !== 'string') return ran
      if (!isComponent(file) || asked.has(file)) return ran
      if (await workflowListsComponents($, getProject())) return ran
      asked.add(file)
      return { ...ran, context: [...(ran.context ?? []), checkText(file, `${$.plugin.root}/kb/ui-components.md`)] }
    })
  }
}
