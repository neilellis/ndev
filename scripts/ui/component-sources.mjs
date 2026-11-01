#!/usr/bin/env node
// component-sources.mjs — fail on a UI component file that does not name its approved source.
//
//   node component-sources.mjs [--catalogue <kb/ui-components.md>] <dir|file>...
//
// Each component file (.tsx .ts .jsx .js, not a test) must have, in its first 15 lines, one of:
//   // From <approved source> <registry item> (<registry URL>), <YYYY-MM-DD>. [Changed for <project>: ...]
//   // Own component: <why no row of the component map fits>.
// The approved sources and their hosts come from the "Approved sources" table of the catalogue.
// Exit codes: 0 = every file names an approved source, 1 = a file does not, 2 = bad arguments or a missing path.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HEAD_LINES = 15
const CODE = /\.(tsx|ts|jsx|js)$/
const TEST = /\.(test|spec)\.[jt]sx?$/

function fail(msg) {
  console.error(`component-sources: ${msg}`)
  process.exit(2)
}

// name (lower case) -> { name, hosts: Set }
export function approvedSources(markdown) {
  const start = markdown.indexOf('## Approved sources')
  if (start < 0) throw new Error('the catalogue has no "## Approved sources" section')
  const rest = markdown.slice(start + 1)
  const end = rest.search(/\n#{2,3} /)
  const section = end < 0 ? rest : rest.slice(0, end)
  const sources = new Map()
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Source |')) continue
    const name = line.split('|')[1].trim()
    const hosts = new Set([...line.matchAll(/https?:\/\/([^/)\s`]+)/g)].map((m) => m[1].replace(/^www\./, '')))
    sources.set(name.replace(/\s*\(.*\)$/, '').toLowerCase(), { name, hosts })
  }
  if (sources.size === 0) throw new Error('the "Approved sources" table has no rows')
  return sources
}

// Returns null when the file is fine, else the reason.
export function checkFile(text, sources) {
  const head = text.split('\n').slice(0, HEAD_LINES).map((l) => l.replace(/^\s*(\/\/|\/\*+|\*)\s?/, ''))
  if (head.some((l) => /^Own component: \S.{8,}/.test(l))) return null
  if (head.some((l) => /^Own component:?\s*$/.test(l))) return '"Own component:" needs the reason no component map row fits'
  const line = head.find((l) => /^From \S/.test(l))
  if (!line) return 'no "From <source> <item> (<url>), <date>." or "Own component: <reason>." line in the first 15 lines'
  const m = line.match(/^From (.+?) \((https?:\/\/[^)\s]+)\),? (\d{4}-\d{2}-\d{2})/)
  if (!m) return `the From line needs "<source> <item> (<registry URL>), <YYYY-MM-DD>": "${line.trim()}"`
  const named = m[1].toLowerCase()
  const match = [...sources.keys()].filter((k) => named.startsWith(k + ' ')).sort((a, b) => b.length - a.length)[0]
  if (!match) return `"${m[1]}" does not start with an approved source and an item name`
  const host = new URL(m[2]).host.replace(/^www\./, '')
  const { name, hosts } = sources.get(match)
  if (![...hosts].some((h) => host === h || host.endsWith('.' + h))) {
    return `the URL host ${host} is not a host of ${name} (${[...hosts].join(', ')})`
  }
  return null
}

function files(path) {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => {
    const p = join(path, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p)
    return CODE.test(e.name) && !TEST.test(e.name) ? [p] : []
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  let catalogue = join(HERE, '..', '..', 'kb', 'ui-components.md')
  const i = args.indexOf('--catalogue')
  if (i >= 0) {
    catalogue = args[i + 1]
    args.splice(i, 2)
  }
  if (!catalogue || !existsSync(catalogue)) fail(`the catalogue is missing: ${catalogue}`)
  if (args.length === 0) fail('give one or more component folders or files, for example src/components/ui')
  const missing = args.filter((a) => !existsSync(a))
  if (missing.length) fail(`these paths do not exist: ${missing.join(', ')}`)
  let sources
  try {
    sources = approvedSources(readFileSync(catalogue, 'utf8'))
  } catch (e) {
    fail(`${catalogue}: ${e.message}`)
  }
  const all = args.flatMap(files)
  const bad = all.map((f) => [f, checkFile(readFileSync(f, 'utf8'), sources)]).filter(([, r]) => r)
  for (const [f, r] of bad) console.error(`${relative(process.cwd(), f)}: ${r}`)
  if (bad.length) {
    console.error(`\n${bad.length} of ${all.length} component files do not name an approved source.`)
    console.error('Repair: add "// From <source> <item> (<registry URL>), <YYYY-MM-DD>." or "// Own component: <reason>." at the top.')
    console.error(`Approved sources: ${[...sources.values()].map((s) => s.name).join('; ')}. See ${catalogue}.`)
    process.exit(1)
  }
  console.log(`component-sources: ${all.length} component files, each names an approved source.`)
}
