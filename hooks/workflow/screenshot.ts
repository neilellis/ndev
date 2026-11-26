// The screenshot tool: one page at each viewport and colour scheme, through Orca's built-in browser.
// Orca keeps each image in a temporary folder for a day, so the tool copies it under the git folder of
// the worktree: this keeps it out of each commit and keeps the tree clean. It makes no GitHub call.
import type { EngineInterface } from 'claude-code'

import { SCREENSHOT_SCHEMES, SCREENSHOT_VIEWPORTS } from './change-types'
import { INNER_SCROLL_PROBE } from './screenshot-scroll'
import { Refuse, head, must, paths, run, said } from './effects'

const REPAIR = 'Repair: start Orca with `orca open`, then call screenshot again. Without Orca, use the matrix script of the ndev:responsive-check skill.'
const VIEWPORT = /^(\d{2,5})x(\d{2,5})$/
const WAIT_LIMIT_SECONDS = 60
const PAGE_STEP = 0.8
const PAGE_STEP_LIMIT = 40
const FULL_PAGE_ORCA = '1.4.274'
const LOADING_IMAGES = `(async () => { const loading = () => [...document.images].filter(image => !image.complete && image.getClientRects().length).length; const end = Date.now() + 10000; while (loading() && Date.now() < end) await new Promise(done => setTimeout(done, 100)); return JSON.stringify(loading()) })()`
const LOGIN_PAGE = /^https?:\/\/(?:[^/?#]*\.)?(?:login|signin|accounts|auth|sso)\.|\/(?:login|log-in|signin|sign-in|sso|auth)(?=[/?#]|$)/i

type Args = Record<string, unknown>
type Shot = { view: string; scheme: string; file: string }
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

async function scrollPage($: EngineInterface, root: string, page: string, top: number): Promise<{ y: number; height: number; total: number }> {
  const answer = await pageValue($, root, page, `(async () => { scrollTo({ top: ${top}, behavior: 'instant' }); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); return JSON.stringify([scrollY, innerHeight, document.documentElement.scrollHeight]) })()`)
  let measured: unknown
  try {
    measured = JSON.parse(answer)
  } catch {
    measured = undefined
  }
  if (!Array.isArray(measured) || measured.length !== 3 || !measured.every(n => typeof n === 'number')) throw new Refuse(`The page did not give its scroll position: it answered ${answer.slice(0, 200)}. No image of it was saved. ${REPAIR}`)
  const [y, height, total] = measured as [number, number, number]
  return { y, height, total }
}

async function innerScroller($: EngineInterface, root: string, page: string): Promise<{ element: string; height: number; total: number } | undefined> {
  const answer = await pageValue($, root, page, INNER_SCROLL_PROBE)
  const invalid = () => new Refuse(`Orca returned invalid inner-scroll measurements for page ${page}: ${answer.slice(0, 200)}. No image of it was saved.`)
  let measured: unknown
  try {
    measured = JSON.parse(answer)
  } catch {
    throw invalid()
  }
  if (measured === null) return undefined
  if (typeof measured !== 'object' || Array.isArray(measured)) throw invalid()
  const value = measured as Record<string, unknown>
  if (typeof value.element !== 'string' || !value.element || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0 || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total <= value.height) throw invalid()
  return { element: value.element, height: value.height, total: value.total }
}

async function copyShot($: EngineInterface, root: string, shot: Record<string, unknown>, url: string, view: string, file: string): Promise<void> {
  if (typeof shot.path !== 'string') throw new Refuse(`The Orca capture gave no file path for ${url} at ${view}: ${JSON.stringify(shot).slice(0, 200)}. The Orca version may differ from what this tool expects.`)
  const copied = await run($, ['cp', shot.path, file], { cwd: root })
  if (copied.exitCode !== 0) throw new Refuse(`cp ${shot.path} ${file} exited ${copied.exitCode}: ${said(copied)}`)
}

// Orca's full-screenshot does not scroll, so content that loads on scroll stays unloaded without this pass (issue #31).
async function walkPage($: EngineInterface, root: string, page: string, base: string): Promise<string[]> {
  const warnings = new Set<string>()
  let top = 0
  let last = -1
  for (let step = 1; ; step++) {
    const { y, height, total } = await scrollPage($, root, page, top)
    const inner = await innerScroller($, root, page)
    if (inner) warnings.add(`${base}: ${inner.element} scrolls inside the page (${inner.height} px pane, ${inner.total} px content). Only its visible portion was captured, so this image is not the whole page.`)
    if (y + height >= total - 1) break
    if (y <= last) {
      warnings.add(`${base}: the page stopped at ${y + height} px of ${total} px and would not scroll on, so content below may not have loaded and the image may not be the whole page. Its content may scroll inside an element and not in the page.`)
      break
    }
    if (step === PAGE_STEP_LIMIT) {
      warnings.add(`${base}: the scroll pass ended at its limit of ${PAGE_STEP_LIMIT} steps, at ${y + height} px of ${total} px, so content below may not have loaded and inner panes there were not checked.`)
      break
    }
    last = y
    top = y + Math.floor(height * PAGE_STEP)
  }
  await scrollPage($, root, page, 0)
  return [...warnings]
}

async function settleImages($: EngineInterface, root: string, page: string, base: string): Promise<string[]> {
  const answer = await pageValue($, root, page, LOADING_IMAGES)
  if (!/^\d+$/.test(answer)) throw new Refuse(`The page did not say how many images are still loading: it answered ${answer.slice(0, 200)}. No image of it was saved. ${REPAIR}`)
  return answer === '0' ? [] : [`${base}: ${answer} image(s) were still loading after 10 s, so the image may show them blank.`]
}

function refuseWrappingOrca(version: unknown): void {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) && version.localeCompare(FULL_PAGE_ORCA, 'en', { numeric: true }) >= 0) return
  throw new Refuse(`Refused: fullPage needs Orca ${FULL_PAGE_ORCA} or later, and orca status says ${JSON.stringify(version)}. An earlier Orca can repeat the top of the page in a full-page image of the right size. No tab was opened. Repair: update Orca, or call screenshot without fullPage.`)
}

// Files that are the same to the byte mean that the scheme changed nothing on the page.
async function sameInBothSchemes($: EngineInterface, root: string, shots: Shot[]): Promise<string[]> {
  const same: string[] = []
  const dark = shots.filter(shot => shot.scheme === 'dark')
  const light = shots.filter(shot => shot.scheme === 'light')
  for (const shot of dark) {
    const other = light.find(l => l.view === shot.view)
    if (!other) continue
    const compared = await run($, ['cmp', '-s', other.file, shot.file], { cwd: root })
    if (compared.exitCode > 1) throw new Refuse(`cmp ${other.file} ${shot.file} exited ${compared.exitCode}: ${said(compared)}`)
    if (compared.exitCode === 0) same.push(shot.file)
  }
  return same
}

async function pause($: EngineInterface, root: string, page: string, ms: number): Promise<void> {
  if (ms) await browser($, root, ['wait', '--timeout', String(ms), '--page', page])
}

async function shootEach($: EngineInterface, root: string, page: string, asked: Asked, folder: string): Promise<{ shots: Shot[]; warnings: string[] }> {
  await browser($, root, ['wait', '--load', 'load', '--page', page])
  await pause($, root, page, asked.waitMs)
  const landed = await pageValue($, root, page, 'location.href')
  if (isLoginPage(landed) && !isLoginPage(asked.url)) throw new LoginPage(`${asked.url} went to the login page ${landed}, so no image was saved. The tab stays open in Orca for the human, page ${page}. Repair: ask the human to sign in once in that tab (call blocked if nothing else can go on), then call screenshot again and close that tab with orca tab close --page ${page}.`)
  const shots: Shot[] = []
  const warnings: string[] = []
  for (const scheme of asked.schemes) {
    await browser($, root, ['exec', '--page', page, '--command', `set media ${scheme}`])
    const dark = await pageValue($, root, page, "matchMedia('(prefers-color-scheme: dark)').matches")
    if (dark !== String(scheme === 'dark')) throw new Refuse(`Orca did not apply the ${scheme} scheme to ${asked.url}: the page says that dark is ${dark}. No image of it was saved. ${REPAIR}`)
    for (const view of asked.viewports) {
      const [, width, height] = VIEWPORT.exec(view)!
      await browser($, root, ['viewport', '--width', width!, '--height', height!, '--page', page])
      const seen = await pageValue($, root, page, 'window.innerWidth')
      if (seen !== width) throw new Refuse(`Orca did not apply the viewport ${view} to ${asked.url}: the page is ${seen} wide, not ${width}. No image of it was saved. ${REPAIR}`)
      const base = `${folder}/${slugOf(asked.url)}-${view}-${scheme}`
      if (asked.fullPage) {
        warnings.push(...(await walkPage($, root, page, base)))
        await pause($, root, page, asked.waitMs)
        warnings.push(...(await settleImages($, root, page, base)))
      }
      await copyShot($, root, await browser($, root, [asked.fullPage ? 'full-screenshot' : 'screenshot', '--page', page, '--format', 'png']), asked.url, view, `${base}.png`)
      shots.push({ view, scheme, file: `${base}.png` })
    }
  }
  const same = await sameInBothSchemes($, root, shots)
  if (same.length) warnings.push(`the page did not change between light and dark, so these images are not a true dark view: ${same.join(', ')}. The page may ignore prefers-color-scheme and set its theme from a stored value or a class. Repair: find its theme key, then run orca storage local set --key <key> --value dark --page <page> in a tab of that site, and call screenshot again with schemes ["dark"]. The value stays in the Orca profile, so set it back after.`)
  return { shots, warnings }
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
  if (asked.fullPage) refuseWrappingOrca((status.runtime as { appVersion?: unknown }).appVersion)
  const sha = (await head(root, $)).slice(0, 8)
  const folder = `${(await paths($, root)).gitDir}/ndev-screenshots/${sha}`
  await must($, ['mkdir', '-p', folder], { cwd: root })
  const page = (await browser($, root, ['tab', 'create', '--url', asked.url])).browserPageId
  if (typeof page !== 'string') throw new Refuse(`orca tab create gave no browserPageId for ${asked.url}. The Orca version may differ from what this tool expects.`)
  let taken: { shots: Shot[]; warnings: string[] }
  try {
    taken = await shootEach($, root, page, asked, folder)
  } catch (error) {
    if (error instanceof LoginPage) throw error
    const problem = await closeTab($, root, page)
    if (problem) throw new Refuse(`${error instanceof Error ? error.message : String(error)} ${problem}`)
    throw error
  }
  const problem = await closeTab($, root, page)
  const files = taken.shots.map(shot => shot.file)
  return [
    `Saved ${files.length} image${files.length === 1 ? '' : 's'} of ${asked.url} at commit ${sha}. Read each file and look for a defect. The images stay on this machine under the git folder: they are in no commit and do not reach the PR, so say what you saw in your result.`,
    ...taken.warnings.map(warning => `WARNING: ${warning}`),
    ...files,
    problem ?? '',
  ].filter(Boolean).join('\n')
}
