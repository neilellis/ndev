// The screenshot tool: one page at each viewport and colour scheme, through Orca's built-in browser.
// Orca keeps each image in a temporary folder for a day, so the tool copies it under the git folder of
// the worktree: this keeps it out of each commit and keeps the tree clean. It makes no GitHub call.
import type { EngineInterface } from 'claude-code'

import { SCREENSHOT_SCHEMES, SCREENSHOT_VIEWPORTS } from './change-types'
import { Refuse, head, must, paths, run, said } from './effects'

const REPAIR = 'Repair: start Orca with `orca open`, then call screenshot again. Without Orca, use the matrix script of the ndev:responsive-check skill.'
const VIEWPORT = /^(\d{2,5})x(\d{2,5})$/
const WAIT_LIMIT_SECONDS = 60
const LOGIN_PAGE = /^https?:\/\/(?:[^/?#]*\.)?(?:login|signin|accounts|auth|sso)\.|\/(?:login|log-in|signin|sign-in|sso|auth)(?=[/?#]|$)/i

type Args = Record<string, unknown>
type Asked = { url: string; viewports: string[]; schemes: string[]; fullPage: boolean; waitMs: number }
class LoginPage extends Refuse {}

// The query does not count: a page can name the login page in ?next= and not be it.
const isLoginPage = (url: string) => LOGIN_PAGE.test(url.split(/[?#]/)[0]!)

function textList(args: Args, key: string, fallback: readonly string[], valid: (item: string) => boolean, want: string): string[] {
  const value = args[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string' && valid(item))) throw new Refuse(`Refused: ${key} is ${JSON.stringify(value)}. Use a list of ${want}, or leave it out for ${fallback.join(', ')}. No tab was opened.`)
  return value as string[]
}

function parseArgs(args: Args): Asked {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (!/^https?:\/\/[^/]/i.test(url)) throw new Refuse(`Refused: url is ${JSON.stringify(args.url)}. Give a full http or https URL, such as http://localhost:3000/cart. No tab was opened.`)
  const seconds = args.waitSeconds ?? 0
  if (typeof seconds !== 'number' || !(seconds >= 0 && seconds <= WAIT_LIMIT_SECONDS)) throw new Refuse(`Refused: waitSeconds is ${JSON.stringify(seconds)}. Give a number from 0 to ${WAIT_LIMIT_SECONDS}. No tab was opened.`)
  return {
    url,
    viewports: textList(args, 'viewports', SCREENSHOT_VIEWPORTS, item => VIEWPORT.test(item), 'sizes such as 390x844'),
    schemes: textList(args, 'schemes', SCREENSHOT_SCHEMES, item => (SCREENSHOT_SCHEMES as readonly string[]).includes(item), SCREENSHOT_SCHEMES.join(' or ')),
    fullPage: args.fullPage === true,
    waitMs: Math.round(seconds * 1000),
  }
}

const slugOf = (url: string) => {
  const slug = url.replace(/^https?:\/\//i, '').replace(/#.*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80)
  return /^[^/]*\/?$/.test(url.replace(/^https?:\/\//i, '')) ? `${slug}-home` : slug
}

// One browser command. A failure names the command, Orca's code and message, and the repair.
async function browser($: EngineInterface, root: string, argv: string[]): Promise<Record<string, unknown>> {
  const name = `orca ${argv.filter(a => !a.startsWith('--')).slice(0, argv[0] === 'tab' ? 2 : 1).join(' ')}`
  const r = await run($, ['orca', ...argv, '--json'], { cwd: root })
  let reply: { ok?: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } } = {}
  try {
    reply = JSON.parse(r.stdout) as typeof reply
  } catch {
    if (r.exitCode === 0) throw new Refuse(`${name} answered with text that is not JSON: ${r.stdout.slice(0, 200)}. The Orca version may differ from what this tool expects. ${REPAIR}`)
  }
  if (r.exitCode !== 0 || reply.ok === false) throw new Refuse(`${name} exited ${r.exitCode}${reply.error?.code ? ` (${reply.error.code})` : ''}: ${reply.error?.message ?? said(r)}. ${REPAIR}`)
  return reply.result ?? {}
}

async function pageValue($: EngineInterface, root: string, page: string, expression: string): Promise<string> {
  return String((await browser($, root, ['eval', '--expression', expression, '--page', page])).result)
}

async function shootEach($: EngineInterface, root: string, page: string, asked: Asked, folder: string): Promise<string[]> {
  await browser($, root, ['wait', '--load', 'load', '--page', page])
  if (asked.waitMs) await browser($, root, ['wait', '--timeout', String(asked.waitMs), '--page', page])
  const landed = await pageValue($, root, page, 'location.href')
  if (isLoginPage(landed) && !isLoginPage(asked.url)) throw new LoginPage(`${asked.url} went to the login page ${landed}, so no image was saved. The tab stays open in Orca for the human, page ${page}. Repair: ask the human to sign in once in that tab (call blocked if nothing else can go on), then call screenshot again and close that tab with orca tab close --page ${page}.`)
  const files: string[] = []
  for (const scheme of asked.schemes) {
    await browser($, root, ['exec', '--page', page, '--command', `set media ${scheme}`])
    const dark = await pageValue($, root, page, "matchMedia('(prefers-color-scheme: dark)').matches")
    if (dark !== String(scheme === 'dark')) throw new Refuse(`Orca did not apply the ${scheme} scheme to ${asked.url}: the page says that dark is ${dark}. No image of it was saved. ${REPAIR}`)
    for (const view of asked.viewports) {
      const [, width, height] = VIEWPORT.exec(view)!
      await browser($, root, ['viewport', '--width', width!, '--height', height!, '--page', page])
      const seen = await pageValue($, root, page, 'window.innerWidth')
      if (seen !== width) throw new Refuse(`Orca did not apply the viewport ${view} to ${asked.url}: the page is ${seen} wide, not ${width}. No image of it was saved. ${REPAIR}`)
      const shot = await browser($, root, asked.fullPage ? ['full-screenshot', '--page', page] : ['screenshot', '--page', page, '--format', 'png'])
      if (typeof shot.path !== 'string') throw new Refuse(`orca screenshot gave no file path for ${asked.url} at ${view}: ${JSON.stringify(shot).slice(0, 200)}. The Orca version may differ from what this tool expects.`)
      const file = `${folder}/${slugOf(asked.url)}-${view}-${scheme}.png`
      const copied = await run($, ['cp', shot.path, file], { cwd: root })
      if (copied.exitCode !== 0) throw new Refuse(`cp ${shot.path} ${file} exited ${copied.exitCode}: ${said(copied)}`)
      files.push(file)
    }
  }
  return files
}

// Undefined when the tab closed. A tab that stays open is a fault for the human to see, so it is named.
async function closeTab($: EngineInterface, root: string, page: string): Promise<string | undefined> {
  try {
    await browser($, root, ['tab', 'close', '--page', page])
    return undefined
  } catch (error) {
    return `The tab did not close: ${error instanceof Error ? error.message : String(error)} Repair: orca tab close --page ${page}.`
  }
}

export async function takeScreenshots($: EngineInterface, root: string, args: Args): Promise<string> {
  const asked = parseArgs(args)
  const status = await browser($, root, ['status'])
  if ((status.runtime as { reachable?: boolean } | undefined)?.reachable !== true) throw new Refuse(`Orca is not running: orca status says that its runtime is not reachable (${JSON.stringify(status).slice(0, 200)}). ${REPAIR}`)
  const sha = (await head(root, $)).slice(0, 8)
  const folder = `${(await paths($, root)).gitDir}/ndev-screenshots/${sha}`
  await must($, ['mkdir', '-p', folder], { cwd: root })
  const page = (await browser($, root, ['tab', 'create', '--url', asked.url])).browserPageId
  if (typeof page !== 'string') throw new Refuse(`orca tab create gave no browserPageId for ${asked.url}. The Orca version may differ from what this tool expects.`)
  let files: string[]
  try {
    files = await shootEach($, root, page, asked, folder)
  } catch (error) {
    if (error instanceof LoginPage) throw error
    const problem = await closeTab($, root, page)
    if (problem) throw new Refuse(`${error instanceof Error ? error.message : String(error)} ${problem}`)
    throw error
  }
  const problem = await closeTab($, root, page)
  return [
    `Saved ${files.length} image${files.length === 1 ? '' : 's'} of ${asked.url} at commit ${sha}. Read each file and look for a defect. The images stay on this machine under the git folder: they are in no commit and do not reach the PR, so say what you saw in your result.`,
    ...files,
    problem ?? '',
  ].filter(Boolean).join('\n')
}
