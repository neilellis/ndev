// Pure helpers for responsive-check.mjs: the matrix, arguments, findings rules, contrast
// maths and the progress file the ndev pane reads. No browser here, so node --test covers it.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The default matrix. `device` names a Playwright descriptor (its engine, DPR, touch and
// user agent); a `width` row is a desktop Chromium window. The phone list starts at 320,
// the WCAG 1.4.10 reflow width.
export const VIEWPORTS = [
  { name: 'iPhone SE', short: 'SE', device: 'iPhone SE' },
  { name: 'iPhone 15 Pro', short: '15 Pro', device: 'iPhone 15 Pro' },
  { name: 'Pixel 7', short: 'Pixel', device: 'Pixel 7' },
  { name: 'iPad Mini', short: 'iPad', device: 'iPad Mini' },
  { name: 'iPad Pro 11 landscape', short: 'iPad Pro', device: 'iPad Pro 11 landscape' },
  { name: 'Laptop', short: 'Laptop', width: 1280, height: 800 },
  { name: 'Desktop', short: 'Desktop', width: 1920, height: 1080 },
]

export const SCHEMES = ['light', 'dark']

export const USAGE = `usage: responsive-check.mjs --base <url> [route ...]
  --base <url>         site root, for example http://localhost:3000 (required)
  --out <dir>          report folder (default .responsive-check)
  --only <names>       comma list of viewport names to keep, for example "iPhone SE,iPad Mini"
  --widths <list>      extra desktop Chromium widths, for example 360,1024
  --viewports <list>   Chromium windows in place of the default rows, for example phone:390x844,desktop:1440x900
  --scale <n>          device scale of every row, for example 1 for small screenshots
  --jpeg <quality>     JPEG screenshots at this quality from 1 to 100 (default PNG)
  --schemes <list>     light,dark (default both)
  --engine <name>      force one engine for every row: chromium or webkit
  --target <px>        smallest touch target before an error (default 24, WCAG 2.5.8 AA)
  --target-warn <px>   smallest touch target before a warning (default 44, WCAG 2.5.5 AAA and Apple)
  --full-page          full-page screenshots (default: the first screen)
  --no-shots           no screenshots
  --web-dir <dir>      folder that installs playwright (default $WEB_DIR, then the working folder)
Exit 0: no errors. 1: errors found, or a cell failed. 2: cannot run (the message names the fix).`

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { routes: [], out: '.responsive-check', schemes: [...SCHEMES], target: 24, targetWarn: 44, isFullPage: false, hasShots: true, widths: [] }
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') o.base = value(++i, a).replace(/\/+$/, '')
    else if (a === '--out') o.out = value(++i, a)
    else if (a === '--only') o.only = value(++i, a).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--widths') o.widths = value(++i, a).split(',').map(Number)
    else if (a === '--viewports') o.viewports = value(++i, a).split(',').map((s) => s.trim()).filter(Boolean).map(windowRow)
    else if (a === '--scale') o.scale = Number(value(++i, a))
    else if (a === '--jpeg') o.jpeg = Number(value(++i, a))
    else if (a === '--schemes') o.schemes = value(++i, a).split(',').map((s) => s.trim())
    else if (a === '--engine') o.engine = value(++i, a)
    else if (a === '--target') o.target = Number(value(++i, a))
    else if (a === '--target-warn') o.targetWarn = Number(value(++i, a))
    else if (a === '--web-dir') o.webDir = value(++i, a)
    else if (a === '--full-page') o.isFullPage = true
    else if (a === '--no-shots') o.hasShots = false
    else if (a === '--help' || a === '-h') o.isHelp = true
    else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`)
    else o.routes.push(a.startsWith('/') || /^https?:/.test(a) ? a : `/${a}`)
  }
  if (o.isHelp) return o
  if (!o.base) throw new UsageError('no --base. fix: pass --base http://localhost:3000 (start the site first)')
  if (!/^https?:\/\//.test(o.base)) throw new UsageError(`--base ${o.base} is not an http(s) URL`)
  if (o.routes.length === 0) o.routes.push('/')
  for (const s of o.schemes) if (!SCHEMES.includes(s)) throw new UsageError(`--schemes: ${s} is not light or dark`)
  for (const w of o.widths) if (!Number.isInteger(w) || w < 200) throw new UsageError(`--widths: ${w} is not a width in px of 200 or more`)
  if (o.scale !== undefined && !(o.scale > 0)) throw new UsageError(`--scale ${o.scale} is not a device scale above 0`)
  if (o.jpeg !== undefined && !(Number.isInteger(o.jpeg) && o.jpeg >= 1 && o.jpeg <= 100)) throw new UsageError(`--jpeg ${o.jpeg} is not a quality from 1 to 100`)
  if (o.engine && !['chromium', 'webkit'].includes(o.engine)) throw new UsageError(`--engine ${o.engine}: use chromium or webkit`)
  if (!(o.target > 0) || !(o.targetWarn >= o.target)) throw new UsageError('--target must be above 0 and --target-warn at least --target')
  return o
}

function windowRow(text) {
  const match = text.match(/^([^:]+):(\d+)x(\d+)$/)
  if (!match || Number(match[2]) < 1 || Number(match[3]) < 1) throw new UsageError(`--viewports: ${text} is not name:WIDTHxHEIGHT, such as phone:390x844`)
  return { name: match[1], short: match[1], width: Number(match[2]), height: Number(match[3]) }
}

// The viewport rows this run uses, resolved against Playwright's device table.
export function viewportsFor(o, devices) {
  let rows = [...(o.viewports ?? VIEWPORTS), ...o.widths.map((w) => ({ name: `${w}px`, short: `${w}`, width: w, height: 900 }))]
  if (o.only) {
    const unknown = o.only.filter((n) => !rows.some((r) => r.name === n))
    if (unknown.length) throw new UsageError(`--only: no viewport named ${unknown.join(', ')}. Names: ${rows.map((r) => r.name).join(', ')}`)
    rows = rows.filter((r) => o.only.includes(r.name))
  }
  return rows.map((r) => {
    const scale = o.scale === undefined ? {} : { deviceScaleFactor: o.scale }
    if (!r.device) return { ...r, engine: o.engine ?? 'chromium', isMobile: false, options: { viewport: { width: r.width, height: r.height }, ...scale } }
    const d = devices[r.device]
    if (!d) throw new UsageError(`this Playwright has no device "${r.device}". fix: update playwright in the web folder`)
    return { ...r, width: d.viewport.width, height: d.viewport.height, engine: o.engine ?? d.defaultBrowserType, isMobile: !!d.isMobile, options: { ...d, ...scale } }
  })
}

export function shotFor(o, out, route, v, scheme) {
  const type = o.jpeg === undefined ? 'png' : 'jpeg'
  return { path: join(out, 'shots', slug(route), `${slug(v.name)}-${scheme}.${type === 'png' ? 'png' : 'jpg'}`), options: type === 'png' ? { type } : { type, quality: o.jpeg } }
}

export function cellsFor(routes, viewports, schemes) {
  return routes.flatMap((route) => viewports.flatMap((v) => schemes.map((scheme) => ({ route, viewport: v.name, scheme }))))
}

// Viewport meta rules: no meta lays a phone page out at 980px; blocking zoom fails WCAG 1.4.4.
export function viewportMetaFindings(content) {
  if (content == null) return [{ check: 'viewport-meta', severity: 'error', selector: 'head', detail: 'no <meta name="viewport">: phones lay the page out at 980px and shrink it. fix: <meta name="viewport" content="width=device-width, initial-scale=1">' }]
  const parts = Object.fromEntries(content.split(',').map((p) => p.split('=').map((s) => s.trim().toLowerCase())))
  const out = []
  if (parts.width !== 'device-width') out.push({ check: 'viewport-meta', severity: 'error', selector: 'meta[name=viewport]', detail: `width=${parts.width ?? '(none)'}: use width=device-width` })
  if (parts['user-scalable'] === 'no' || parts['user-scalable'] === '0') out.push({ check: 'viewport-meta', severity: 'error', selector: 'meta[name=viewport]', detail: 'user-scalable=no blocks zoom (WCAG 1.4.4). fix: remove it' })
  if (parts['maximum-scale'] !== undefined && Number(parts['maximum-scale']) < 2) out.push({ check: 'viewport-meta', severity: 'error', selector: 'meta[name=viewport]', detail: `maximum-scale=${parts['maximum-scale']} blocks zoom (WCAG 1.4.4). fix: remove it` })
  return out
}

// WCAG relative luminance and contrast ratio of [r, g, b] in 0..255.
export function luminance([r, g, b]) {
  const c = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

export function contrastRatio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// Turns one cell's raw probe result into findings. `raw` is what probes.mjs returns.
export function findingsFor(raw, v, o) {
  const f = []
  if (raw.scrollWidth > raw.clientWidth + 1) {
    const by = raw.scrollWidth - raw.clientWidth
    const culprits = raw.overflow.length ? raw.overflow : [{ selector: 'html', right: raw.scrollWidth }]
    for (const c of culprits.slice(0, 5)) f.push({ check: 'overflow', severity: 'error', selector: c.selector, detail: `the page scrolls sideways by ${by}px; this element ends at ${c.right}px of ${raw.clientWidth}px` })
  }
  if (v.isMobile) f.push(...viewportMetaFindings(raw.viewportMeta))
  for (const t of raw.targets) {
    const small = Math.min(t.width, t.height)
    if (small < o.target && !t.isSpaced) f.push({ check: 'target-size', severity: 'error', selector: t.selector, detail: `${t.width}x${t.height}px touch target, under ${o.target}px with another target within reach (WCAG 2.5.8)` })
    else if (v.isMobile && small < o.targetWarn) f.push({ check: 'target-size', severity: 'warning', selector: t.selector, detail: `${t.width}x${t.height}px touch target, under ${o.targetWarn}px (WCAG 2.5.5, Apple HIG)` })
  }
  if (v.isMobile) {
    for (const i of raw.inputs) if (i.fontSize < 16) f.push({ check: 'input-zoom', severity: 'warning', selector: i.selector, detail: `${i.fontSize}px text in a form field: iOS Safari zooms in on focus. fix: font-size: 16px or more` })
    for (const r of raw.vh) f.push({ check: 'vh-units', severity: 'warning', selector: r.selector, detail: `${r.property}: ${r.value} is taller than the visible area under mobile browser bars. fix: use svh or dvh, with vh as the fallback` })
    for (const t of raw.smallText.slice(0, 5)) f.push({ check: 'text-size', severity: 'warning', selector: t.selector, detail: `${t.fontSize}px text is hard to read on a phone (12px or more)` })
  }
  for (const c of raw.contrast) {
    const need = c.isLarge ? 3 : 4.5
    const ratio = contrastRatio(c.fg, c.bg)
    if (ratio < need) f.push({ check: 'contrast', severity: 'error', selector: c.selector, detail: `contrast ${ratio.toFixed(2)}:1, under ${need}:1 (WCAG 1.4.3); text rgb(${c.fg.join(',')}) on rgb(${c.bg.join(',')})` })
  }
  return dedupe(f)
}

function dedupe(findings) {
  const seen = new Set()
  return findings.filter((x) => {
    const k = `${x.check} ${x.selector} ${x.detail}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function statusOf(findings) {
  if (findings.some((x) => x.severity === 'error')) return 'error'
  if (findings.length) return 'warn'
  return 'ok'
}

export function slug(text) {
  return text.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'
}

// Where the pane looks for the newest run: a pointer file naming the run's progress.json.
export function stateDir(env = process.env) {
  return env.RESPONSIVE_CHECK_STATE_DIR || join(homedir(), '.cache', 'ndev', 'responsive-check')
}

// Writes JSON whole: the pane never reads a half-written file.
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}
