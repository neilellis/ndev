import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d[\w.-]*$/

function unpinned(text) {
  return text.split('\n').flatMap((line, index) => {
    const found = line.match(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/)
    if (!found || found[1].startsWith('./') || PINNED.test(found[1])) return []
    return [`line ${index + 1}: ${found[1]}`]
  })
}

test('the pin check refuses a short SHA, a tag and a SHA without its version', () => {
  const text = [
    '      - uses: actions/setup-node@949feb2413d645899dcd2491c4babbbce0c15c1 # v6',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '        uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4',
    '      - uses: ./local-action',
  ].join('\n')
  assert.deepEqual(unpinned(text), [
    'line 1: actions/setup-node@949feb2413d645899dcd2491c4babbbce0c15c1 # v6',
    'line 2: actions/checkout@v4',
    'line 3: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  ])
})

test('every workflow action is pinned to a full commit SHA with its release tag', () => {
  const files = readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))
  assert.ok(files.length, `No workflow file in ${WORKFLOWS}`)
  const problems = files.flatMap(name => unpinned(readFileSync(join(WORKFLOWS, name), 'utf8')).map(problem => `.github/workflows/${name} ${problem}`))
  assert.deepEqual(problems, [], `Pin each action to the 40-character commit SHA of a release tag, with the tag as a comment (uses: owner/repo@<sha> # vN). Find the SHA with: gh api repos/<owner>/<repo>/git/ref/tags/<tag>\n${problems.join('\n')}`)
})
