// What kind of work a change holds, with no side effects. The workflow keeps these in its record, and
// the review, the smoke stage and the evidence all read the one notion of a web file and a document here.
export const CHANGE_TYPES = ['web', 'backend', 'database', 'docs', 'tests', 'config'] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]

export const SCREENSHOT_VIEWPORTS = ['390x844', '820x1180', '1440x900'] as const
export const SCREENSHOT_SCHEMES = ['light', 'dark'] as const

const DOCS_FILE = /\.(md|mdx|txt|rst)$/
const WEB_FILE = /\.(tsx|jsx|css|scss|html|vue|svelte)$/
const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|cypress)\/|\.(test|spec|stories|cy|e2e)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/
const DATABASE_FILE = /(^|\/)migrations?\/|\.sql$|\.prisma$/
const CONFIG_FILE = /(^|\/)\.[^/]+(\/|$)|\.(json|ya?ml|toml|ini|lock)$|(^|\/)(Dockerfile[^/]*|Makefile|[^/]*\.config\.[^/]+)$/

export const isDocsPath = (path: string) => DOCS_FILE.test(path)
// A test or a story does not change what a person sees, so it is not a web change.
export const isWebPath = (path: string) => WEB_FILE.test(path) && !TEST_FILE.test(path)

function typeOf(path: string): ChangeType {
  if (isDocsPath(path)) return 'docs'
  if (TEST_FILE.test(path)) return 'tests'
  if (isWebPath(path)) return 'web'
  if (DATABASE_FILE.test(path)) return 'database'
  return CONFIG_FILE.test(path) ? 'config' : 'backend'
}

export function inferChangeTypes(paths: readonly string[]): ChangeType[] {
  const found = new Set(paths.map(typeOf))
  return CHANGE_TYPES.filter(type => found.has(type))
}

// No known type is not documents only: the full review is the safe side.
export const isDocsOnly = (types: readonly ChangeType[]) => types.length > 0 && types.every(type => type === 'docs')

const NEXT_PAGE = /(?:^|\/)app\/(?:(.*)\/)?page\.[jt]sx$/
const SVELTE_PAGE = /(?:^|\/)routes\/(?:(.*)\/)?\+page\.svelte$/
const PAGES_FILE = /(?:^|\/)pages\/(.+)\.(?:[jt]sx|vue|svelte)$/

function routeOf(file: string): string | undefined {
  const folder = NEXT_PAGE.exec(file) ?? SVELTE_PAGE.exec(file)
  if (folder) return `/${(folder[1] ?? '').replace(/\([^)]*\)\/?/g, '').replace(/\/$/, '')}`
  const page = PAGES_FILE.exec(file)?.[1]
  if (!page || /^api\/|(^|\/)_/.test(page)) return undefined
  return `/${page.replace(/(^|\/)index$/, '')}`
}

// The routes of the changed page files. Another web file shows on pages that only the agent can name.
export function pagesOf(files: readonly string[]): string[] {
  return [...new Set(files.map(routeOf).filter((route): route is string => route !== undefined))]
}

const SHOWN = 12
const some = (items: readonly string[]) => items.slice(0, SHOWN).join(', ') + (items.length > SHOWN ? ` and ${items.length - SHOWN} more` : '')

// What the agent must show: each changed route, and each page that holds another changed web file.
function targets(files: readonly string[]): string {
  const pages = pagesOf(files)
  const others = files.filter(file => routeOf(file) === undefined)
  const parts = [pages.length ? `the pages ${some(pages)}` : '', others.length ? `each page that shows ${some(others)}` : ''].filter(Boolean)
  return parts.join(', and ') || 'each page that the change affects'
}

const views = `${SCREENSHOT_VIEWPORTS.join(', ')}, each in ${SCREENSHOT_SCHEMES.join(' and ')}`

export const reviewWebStep = (files: readonly string[]) =>
  `Screenshots: this change is a web change and the commit is not pushed, so no preview shows it. Start the dev server of the project in this worktree, and call the screenshot tool (mcp__ndev__screenshot) with the local URL of ${targets(files)}. By default it takes ${views}. Read each image and look for a defect. If the change touches a shared layout, a theme or a stylesheet, also load the ndev:responsive-check skill and run its matrix. Say which pages you looked at and what you saw in the review result.`

export const smokeWebStep = (files: readonly string[]) =>
  `Screenshots: call the screenshot tool (mcp__ndev__screenshot) with the preview URL of ${targets(files)}. By default it takes ${views}. Read each image. The images stay on this machine and do not reach the PR, so say in the report which pages you looked at and what you saw.`

export const REVIEW_DATABASE_STEP = 'Database: apply each new migration to a local database and run the tests against it. If a migration must run after the merge, list it with addMigration.'

export const REVIEW_DOCS_ONLY_STEP = 'Review of documents only: your last commit is not pushed yet, because it is reviewed first. The plugin started the ndev:diff-reviewer agent with a short brief: do not start another, and do not wait with a helper, because its answer comes to you. Meanwhile, run the remember hook: load the ndev:remember skill and record what this work taught in the project wiki. When the answer comes, fix what it found with checkpoint, which holds those commits too. Then call finishedReview with the review result, with deadcode as "none: documents only", and with remembered as what you recorded or "nothing: <reason>".'

const BRIEFS: Record<ChangeType, string> = {
  web: 'Web: check the layout at narrow widths, the light and dark themes, keyboard use, focus, labels, contrast, and the loading, empty and error states. Look for a fixed width or a colour that does not come from the theme.',
  backend: 'Backend: check the error paths, input validation, authorisation, concurrency, and compatibility with each current caller of a changed interface.',
  database: 'Database: check each migration for locks on large tables, the order against the deployed code, the way back, the indexes, and row-level security on each new table.',
  docs: 'Docs: check each changed claim against the code in this diff.',
  tests: 'Tests: check that each new test fails when the defect returns, that no assertion was weakened, removed or skipped, and that only external boundaries are mocked.',
  config: 'Config: check the effect on the checks, the build and the deployment, each new dependency, and that no secret and no turned-off check is in the diff.',
}

// The lines for the reviewer's prompt, in the order of the list of types.
export function reviewerBrief(types: readonly ChangeType[]): string[] {
  if (isDocsOnly(types)) return ['This change holds documents only. Keep the review short: check each claim, each link and each command against the code, and read the prose. Do not search the code for other defects.']
  return CHANGE_TYPES.filter(type => types.includes(type)).map(type => BRIEFS[type])
}
