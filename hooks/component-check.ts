// After a component file is written or edited, asks the agent to check the change against the
// component map in kb/ui-components.md, so it uses a rich component and not the most basic solution.
// It asks once for each file in a session. It reads tool calls only: a file changed through Bash is not seen.
import type { Register } from 'claude-code'

type On = Parameters<Register>[0]

const COMPONENT = /\.(tsx|jsx|vue|svelte)$/
const NOT_COMPONENT = /\.(test|spec|stories|cy|e2e)\.[^/]+$|\/(node_modules|__tests__)\//

export const isComponent = (file: string) => COMPONENT.test(file) && !NOT_COMPONENT.test(file)

export const checkText = (file: string, catalogue: string) =>
  `You changed the UI file ${file}. Check it against the "Component map" section of ${catalogue} (read that section only if it is not in your context). For each control or pattern in your change, find its row. If you used the most basic solution (a plain element, a hand-built control, or a simple component) where a row or the project's own design system gives a richer one that improves this interaction, change to the richer one now and follow the rules in that file for the install and the source comment. Do not add a component only for decoration. If the basic solution is right, keep it and say why in one line in your reply. If the change adds no control or pattern, do nothing more.`

// The files asked about in this session; a new session, such as after /clear, asks again.
const asked = new Set<string>()

export const startComponentCheck = () => asked.clear()

export const componentCheck = (on: On) => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const file = (e as { file_path?: unknown }).file_path
      if (ran.deny !== undefined || ran.isError === true || typeof file !== 'string') return ran
      if (!isComponent(file) || asked.has(file)) return ran
      asked.add(file)
      return { ...ran, context: [...(ran.context ?? []), checkText(file, `${$.plugin.root}/kb/ui-components.md`)] }
    })
  }
}
