// Which files are components, and what to ask about them. The edit hook and the workflow's review stage share this.
const COMPONENT = /\.(tsx|jsx|vue|svelte)$/
const NOT_COMPONENT = /\.(test|spec|stories|cy|e2e)\.[^/]+$|\/(node_modules|__tests__)\//

export const isComponent = (file: string) => COMPONENT.test(file) && !NOT_COMPONENT.test(file)

const how = (catalogue: string) =>
  `Check it against the "Component map" section of ${catalogue} (read that section only if it is not in your context). For each control or pattern in your change, find its row. If you used the most basic solution (a plain element, a hand-built control, or a simple component) where a row or the project's own design system gives a richer one that improves this interaction, change to the richer one now and follow the rules in that file for the install and the source comment. Do not add a component only for decoration. If the basic solution is right, keep it and say why in one line in your reply. If the change adds no control or pattern, do nothing more.`

export const checkText = (file: string, catalogue: string) => `You changed the UI file ${file}. ${how(catalogue)}`

export const reviewText = (files: string[], catalogue: string) =>
  `This review must also check the changed UI files: ${files.join(', ')}. For each file: ${how(catalogue)}`
