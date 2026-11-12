// Run: node --test skills/modern-web-guidance/scripts/tests/sync.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { summary, transform } from '../sync.mjs'

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUIDES = join(SKILL, 'guides')
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith('.md') ? [join(dir, n)] : []))
const ids = new Map([['dialog', 'ui-components/dialog.md'], ['forms', 'forms/forms.md']])
const opts = { rel: 'forms/switch.md', up: 'skills/modern-web-guidance/guides/forms/switch.md', commit: 'abc', ids }

test('a named cross-reference becomes one relative link', () => {
  const { text, missing } = transform('# T\n\nSee `dialog` (via `npx -y modern-web-guidance@latest retrieve "dialog"`).', opts)
  assert.match(text, /See \[`dialog`\]\(\.\.\/ui-components\/dialog\.md\)\./)
  assert.deepEqual(missing, [])
})

test('a list of ids becomes a list of links, and an unknown id is reported', () => {
  const { text, missing } = transform('# T\n\nRead (via `npx -y modern-web-guidance@latest retrieve "forms,nope"`).', opts)
  assert.match(text, /\(see \[`forms`\]\(forms\.md\), `nope`\)/)
  assert.deepEqual(missing, ['nope'])
})

test('the source line and the ndev note go directly after the title', () => {
  const { text } = transform('# Switch\n\nBody.', { ...opts, note: 'Use the shadcn switch.' })
  const lines = text.split('\n')
  assert.equal(lines[0], '# Switch')
  assert.match(lines[2], /^> Source: .*blob\/abc\/skills\/modern-web-guidance\/guides\/forms\/switch\.md.*the ndev note below comes first\.$/)
  assert.equal(lines[4], '> **ndev:** Use the shadcn switch.')
})

test('the summary skips code and lists', () => {
  assert.deepEqual(summary('# Title\n\n```js\nx\n```\n\n- item\n\nFirst sentence. Second.'), { title: 'Title', line: 'First sentence.' })
})

test('the committed copy: each guide has a source line and no upstream retrieve command', () => {
  const bad = walk(GUIDES).filter((f) => {
    const t = readFileSync(f, 'utf8')
    return !t.includes('> Source: [skills/') || t.includes('modern-web-guidance@latest retrieve')
  })
  assert.deepEqual(bad, [])
})

test('the committed copy: each relative link to a guide resolves', () => {
  const broken = walk(GUIDES).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/\]\(((?!https?:)[^)#\s]+\.md)(#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((p) => !existsSync(resolve(dirname(f), p)))
      .map((p) => `${f}: ${p}`))
  assert.deepEqual(broken, [])
})

test('the committed copy: each overlay is in its guide, so the sync ran after the last overlay change', () => {
  const files = walk(GUIDES)
  const stale = readdirSync(join(SKILL, 'overlays')).filter((n) => {
    const id = basename(n, '.md')
    const [dir, file] = id.startsWith('chrome-extensions--') ? ['chrome-extensions', id.slice(19)] : [null, id]
    const guide = files.find((f) => basename(f, '.md') === file && (dir ? f.includes(`/${dir}/`) : !f.includes('/chrome-extensions/references/')))
    const note = readFileSync(join(SKILL, 'overlays', n), 'utf8').trim().split('\n')[0]
    return !guide || !readFileSync(guide, 'utf8').includes(`> **ndev:** ${note}`)
  })
  assert.deepEqual(stale, [])
})
