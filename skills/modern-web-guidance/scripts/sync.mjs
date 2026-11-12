#!/usr/bin/env node
// Copy the guides of GoogleChrome/modern-web-guidance into this skill, with the ndev changes.
//
//   node sync.mjs <upstream checkout> [--commit <sha>]
//
// The upstream text stays as it is, with three changes, which the Apache-2.0 licence requires us to state in each file:
//   1. A source line after the title names the upstream file and commit.
//   2. An ndev note from overlays/<id>.md goes after the source line, when one exists.
//   3. Each `(via \`npx -y modern-web-guidance@latest retrieve "<id>"\`)` becomes a relative link to the local copy.
// The script writes guides/ and index.md again from nothing. It fails, and writes nothing, when an overlay
// names a guide that does not exist or a cross-reference names an unknown guide.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync, renameSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/GoogleChrome/modern-web-guidance'
const RETRIEVE = /(`([^`\n]+)` )?\(via `npx -y modern-web-guidance@latest retrieve "([^"]+)"`\)/g

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.md') ? [path] : []
  })

// Each upstream file and the local path it goes to, relative to guides/.
export function plan(upstream) {
  const mwg = join(upstream, 'skills', 'modern-web-guidance', 'guides')
  const ext = join(upstream, 'skills', 'chrome-extensions')
  const files = walk(mwg).map((src) => ({ src, rel: relative(mwg, src), up: relative(upstream, src) }))
  if (existsSync(ext)) {
    files.push({ src: join(ext, 'SKILL.md'), rel: 'chrome-extensions/chrome-extensions.md', up: 'skills/chrome-extensions/SKILL.md' })
    for (const src of walk(join(ext, 'references'))) files.push({ src, rel: join('chrome-extensions', relative(ext, src)), up: relative(upstream, src) })
  }
  return files.map((f) => ({ ...f, id: basename(f.rel, '.md') }))
}

// The guide id that a cross-reference names resolves to the modern-web-guidance copy first.
export function idMap(files) {
  const map = new Map()
  for (const f of files) if (!map.has(f.id) || !f.rel.startsWith('chrome-extensions/')) map.set(f.id, f.rel)
  return map
}

export function transform(text, { rel, up, commit, note, ids }) {
  const missing = []
  const linked = text.replace(RETRIEVE, (_, named, name, list) => {
    const want = list.split(',').map((id) => id.trim())
    const link = (id) => {
      if (!ids.has(id)) { missing.push(id); return `\`${id}\`` }
      return `[\`${id}\`](${relative(dirname(rel), ids.get(id))})`
    }
    // `dialog` (via … retrieve "dialog") becomes [`dialog`](../ui-components/dialog.md).
    if (named && want.length === 1 && name === want[0]) return link(want[0])
    return `${named ?? ''}(see ${want.map(link).join(', ')})`
  })
  const source = `> Source: [${up}](${REPO}/blob/${commit}/${up}), Apache-2.0. Changed for ndev: cross-references point to the local copies${note ? '; the ndev note below comes first' : ''}.`
  const block = note ? `${source}\n\n> **ndev:** ${note.trim().split('\n').join('\n> ')}\n` : `${source}\n`
  const lines = linked.split('\n')
  const title = lines.findIndex((l) => l.startsWith('# '))
  const at = title === -1 ? 0 : title + 1
  return { text: [...lines.slice(0, at), '', block, ...lines.slice(at)].join('\n').replace(/\n{3,}/g, '\n\n'), missing }
}

// The title and first sentence of a guide, for the index.
export function summary(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
  const title = (body.match(/^# (.+)$/m) || [, ''])[1].trim()
  const para = body.split('\n\n').map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('>') && !p.startsWith('```') && !p.startsWith('<') && !p.startsWith('|') && !p.startsWith('-') && !p.startsWith('*') && !p.includes('```') && !p.endsWith(':')) || ''
  const first = para.replace(/\s+/g, ' ').match(/^.*?[.!?](\s|$)/)
  return { title, line: (first ? first[0] : para).trim().slice(0, 220) }
}

function main() {
  const args = process.argv.slice(2)
  const upstream = args[0]
  if (!upstream || !existsSync(join(upstream, 'skills', 'modern-web-guidance', 'guides'))) {
    console.error('usage: node sync.mjs <modern-web-guidance checkout> [--commit <sha>]')
    process.exit(2)
  }
  const ci = args.indexOf('--commit')
  const commit = ci > -1 ? args[ci + 1] : execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const files = plan(upstream)
  const ids = idMap(files)
  const overlayDir = join(SKILL, 'overlays')
  const overlays = new Map(existsSync(overlayDir) ? readdirSync(overlayDir).filter((n) => n.endsWith('.md')).map((n) => [basename(n, '.md'), readFileSync(join(overlayDir, n), 'utf8')]) : [])
  // An overlay is named after the guide id. A Chrome extension reference uses chrome-extensions--<id>, because
  // two of its ids (icons, prompt-api) are also modern-web-guidance ids.
  const keyOf = (f) => (f.rel.startsWith('chrome-extensions/') && f.id !== 'chrome-extensions' ? `chrome-extensions--${f.id}` : f.id)
  const keys = new Set(files.map(keyOf))
  const unknown = [...overlays.keys()].filter((id) => !keys.has(id))
  const out = []
  const missing = []
  for (const f of files) {
    const note = overlays.get(keyOf(f))
    const r = transform(readFileSync(f.src, 'utf8'), { ...f, commit, note, ids })
    missing.push(...r.missing.map((id) => `${f.rel}: ${id}`))
    out.push({ ...f, text: r.text, note: Boolean(note), ...summary(readFileSync(f.src, 'utf8')) })
  }
  if (unknown.length || missing.length) {
    for (const id of unknown) console.error(`overlay for an unknown guide: overlays/${id}.md`)
    for (const m of missing) console.error(`unknown cross-reference: ${m}`)
    process.exit(1)
  }
  const tmp = join(SKILL, 'guides.tmp')
  rmSync(tmp, { recursive: true, force: true })
  for (const f of out) {
    mkdirSync(dirname(join(tmp, f.rel)), { recursive: true })
    writeFileSync(join(tmp, f.rel), f.text)
  }
  rmSync(join(SKILL, 'guides'), { recursive: true, force: true })
  renameSync(tmp, join(SKILL, 'guides'))
  cpSync(join(upstream, 'LICENSE'), join(SKILL, 'LICENSE'))

  const byCat = new Map()
  for (const f of out) {
    const cat = f.rel.split('/')[0]
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(f)
  }
  const rows = [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([cat, fs]) => [
    `## ${cat}`, '', '| Guide | ndev note | What it covers |', '|---|---|---|',
    ...fs.sort((a, b) => a.rel.localeCompare(b.rel)).map((f) => `| [${f.id}](guides/${f.rel}) | ${f.note ? 'yes' : ''} | ${(f.title + ': ' + f.line).replace(/\|/g, '\\|')} |`), '',
  ])
  writeFileSync(join(SKILL, 'index.md'), [
    '# Modern Web Guidance index', '',
    `Generated by \`scripts/sync.mjs\` from [GoogleChrome/modern-web-guidance](${REPO}) at \`${commit}\`. Do not edit by hand: change an overlay and run the script again.`, '',
    `${out.length} guides. "ndev note" means the guide starts with an ndev note that changes how it applies here. Read the note first.`, '',
    ...rows,
  ].join('\n'))
  console.log(`${out.length} guides, ${out.filter((f) => f.note).length} with an ndev note, from ${commit}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
