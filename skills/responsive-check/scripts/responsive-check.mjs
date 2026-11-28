#!/usr/bin/env node
// Checks pages across a matrix of viewports (phones, tablets, desktops, each in its real engine)
// and colour schemes (light, dark). Writes report.json, progress.json (read live by the ndev
// pane) and screenshots to --out, and prints a summary. Usage: responsive-check.mjs --help
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { probe } from './probes.mjs'
import { USAGE, UsageError, cellsFor, findingsFor, parseArgs, shotFor, stateDir, statusOf, viewportsFor, writeJson } from './responsive-lib.mjs'

function die(message, fix) {
  console.error(`responsive-check: ${message}${fix ? `\nfix: ${fix}` : ''}`)
  process.exit(2)
}

let o
try {
  o = parseArgs(process.argv.slice(2))
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`responsive-check: ${e.message}\n\n${USAGE}`)
    process.exit(2)
  }
  throw e
}
if (o.isHelp) {
  console.log(USAGE)
  process.exit(0)
}

const webDir = resolve(o.webDir ?? process.env.WEB_DIR ?? process.cwd())
let pw
for (const name of ['playwright', '@playwright/test']) {
  try {
    pw = createRequire(join(webDir, 'package.json'))(name)
    break
  } catch {
    // try the next package name
  }
}
if (!pw) die(`no playwright in ${webDir}`, `npm i -D playwright in the web app (or pass --web-dir), then npx playwright install chromium webkit`)

let viewports
try {
  viewports = viewportsFor(o, pw.devices)
} catch (e) {
  if (e instanceof UsageError) die(e.message)
  throw e
}

const out = resolve(o.out)
const progressPath = join(out, 'progress.json')
const cells = cellsFor(o.routes, viewports, o.schemes).map((c) => ({ ...c, status: 'pending', errors: 0, warnings: 0 }))
const progress = {
  state: 'running',
  startedAt: Date.now(),
  updatedAt: Date.now(),
  base: o.base,
  out,
  routes: o.routes,
  viewports: viewports.map((v) => ({ name: v.name, short: v.short, width: v.width, height: v.height, engine: v.engine })),
  schemes: o.schemes,
  cells,
}
const save = () => {
  progress.updatedAt = Date.now()
  writeJson(progressPath, progress)
}
save()
writeJson(join(stateDir(), 'latest.json'), { progress: progressPath, cwd: process.cwd(), startedAt: progress.startedAt })

const urlOf = (route) => (/^https?:/.test(route) ? route : `${o.base}${route}`)
try {
  const res = await fetch(urlOf(o.routes[0]), { redirect: 'follow' })
  if (!res.ok && res.status !== 404) die(`${urlOf(o.routes[0])} answered ${res.status}`, 'check that the site is running and --base is right')
} catch (e) {
  progress.state = 'failed'
  progress.error = `${o.base} is not reachable: ${e.cause?.code ?? e.message}`
  save()
  die(progress.error, 'start the site (for example pnpm dev) or fix --base')
}

const browsers = {}
async function browserFor(engine) {
  if (!browsers[engine]) {
    try {
      browsers[engine] = await pw[engine].launch()
    } catch (e) {
      progress.state = 'failed'
      progress.error = `cannot start ${engine}: ${e.message.split('\n')[0]}`
      save()
      die(progress.error, `npx --prefix ${webDir} playwright install ${engine} (or --engine chromium to run every row in Chromium)`)
    }
  }
  return browsers[engine]
}

const report = { base: o.base, startedAt: progress.startedAt, options: { target: o.target, targetWarn: o.targetWarn, schemes: o.schemes }, notes: [], cells: [] }
const noDark = new Set()

for (const v of viewports) {
  const browser = await browserFor(v.engine)
  for (const scheme of o.schemes) {
    // One context per viewport and scheme: device metrics and colour scheme are fixed per context.
    const context = await browser.newContext({ ...v.options, colorScheme: scheme, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      for (const route of o.routes) {
        const cell = cells.find((c) => c.route === route && c.viewport === v.name && c.scheme === scheme)
        cell.status = 'running'
        save()
        const entry = { route, viewport: v.name, scheme, engine: v.engine, findings: [] }
        try {
          const res = await page.goto(urlOf(route), { waitUntil: 'networkidle', timeout: 30000 })
          if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`)
          await page.evaluate(() => document.fonts.ready)
          const raw = await page.evaluate(probe, { target: o.target })
          if (!raw.hasDark) noDark.add(route)
          entry.measured = { width: raw.clientWidth, innerWidth: raw.innerWidth, scrollWidth: raw.scrollWidth }
          entry.findings = findingsFor(raw, v, o)
          if (o.hasShots) {
            const shot = shotFor(o, out, route, v, scheme)
            entry.screenshot = shot.path
            await page.screenshot({ path: shot.path, fullPage: o.isFullPage, ...shot.options })
          }
          cell.status = statusOf(entry.findings)
        } catch (e) {
          entry.error = e.message.split('\n')[0]
          cell.status = 'failed'
          cell.error = entry.error
        }
        cell.errors = entry.findings.filter((x) => x.severity === 'error').length
        cell.warnings = entry.findings.filter((x) => x.severity === 'warning').length
        cell.top = entry.findings[0] ? `${entry.findings[0].check} ${entry.findings[0].selector}` : undefined
        report.cells.push(entry)
        save()
      }
    } finally {
      await context.close()
    }
  }
}
for (const b of Object.values(browsers)) await b.close()

for (const route of noDark) report.notes.push(`${route}: no dark scheme (no prefers-color-scheme: dark rule and no color-scheme: dark), so the dark cells show the light design`)
const failed = report.cells.filter((c) => c.error)
const errors = report.cells.flatMap((c) => c.findings).filter((x) => x.severity === 'error')
const warnings = report.cells.flatMap((c) => c.findings).filter((x) => x.severity === 'warning')
report.summary = { cells: report.cells.length, failed: failed.length, errors: errors.length, warnings: warnings.length }
writeJson(join(out, 'report.json'), report)
progress.state = 'done'
progress.summary = report.summary
progress.report = join(out, 'report.json')
save()

// Summary: one line per cell with problems, then the totals.
const mark = { ok: 'ok  ', warn: 'warn', error: 'FAIL', failed: 'DEAD' }
for (const c of cells) {
  if (c.status === 'ok') continue
  console.log(`${mark[c.status]} ${c.route} ${c.viewport} ${c.scheme}: ${c.error ?? `${c.errors} errors, ${c.warnings} warnings; first: ${c.top}`}`)
}
for (const n of report.notes) console.log(`note ${n}`)
console.log(`${report.summary.cells} cells: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.failed} failed. Report: ${join(out, 'report.json')}`)
process.exit(failed.length || errors.length ? 1 : 0)
