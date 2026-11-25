#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const USAGE = 'usage: lowered-bar.mjs <base-ref>   lists the lines of git diff <base-ref>...HEAD that lower the bar'
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/

const SKIP = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\s*\(/,
  /(?<![.\w])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.skip\s*\(/,
  /@unittest\.skip/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
  /\{\s*skip\s*:\s*(?:true|['"`])/,
  /#\[ignore\]/,
  /@(?:Disabled|Ignore)\b/,
]
const SUPPRESS = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|oxlint-disable|#\s*type:\s*ignore|#\s*noqa|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|\/\/\s*nolint|#\[allow\(|@SuppressWarnings|istanbul ignore|c8 ignore|v8 ignore|#\s*pragma:\s*no cover|NOSONAR|shellcheck disable/
const EMPTY_CATCH = [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/, /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/, /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/]
const OPEN_CATCH = [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/, /^\s*except\b[^:]*:\s*$/]
const CLOSE_CATCH = /^\s*(?:\}|pass|\.\.\.)\s*$/
const DELETED_TEST = /^\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|def test_)/
const ASSERTION = /\bassert\w*\b|\bexpect\s*\(/
const NUMBER = /([A-Za-z_][\w-]*)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/g
const LOWERED = [
  { key: /threshold|coverage|^(?:lines|branches|functions|statements)$/i, worse: (from, to) => to < from, label: 'lowered threshold' },
  { key: /timeout/i, worse: (from, to) => to > from, label: 'raised timeout' },
  { key: /retries|retry/i, worse: (from, to) => to > from, label: 'raised retries' },
]

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function parse(diff) {
  const files = []
  let file
  let hunk
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: / b\/(.*)$/.exec(line)?.[1] ?? '', deleted: false, hunks: [] }
      files.push(file)
      hunk = undefined
    } else if (!file) continue
    else if (!hunk && line.startsWith('deleted file mode')) file.deleted = true
    else if (!hunk && line.startsWith('--- a/')) file.path = line.slice(6)
    else if (!hunk && line.startsWith('+++ b/')) file.path = line.slice(6)
    else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!m) fail(`lowered-bar: cannot read the hunk header "${line}" in ${file.path}.`)
      hunk = { old: Number(m[1]), new: Number(m[2]), added: [], removed: [] }
      file.hunks.push(hunk)
    } else if (!hunk) continue
    else if (line.startsWith('+')) hunk.added.push({ line: hunk.new++, text: line.slice(1) })
    else if (line.startsWith('-')) hunk.removed.push({ line: hunk.old++, text: line.slice(1) })
    else if (line.startsWith(' ')) {
      hunk.old++
      hunk.new++
    }
  }
  return files
}

function numbers(text) {
  return [...text.matchAll(NUMBER)].map(m => ({ key: m[1], value: Number(m[2]) }))
}

function scanHunk(path, hunk, isTest) {
  const found = []
  const add = (line, kind, text) => found.push({ path, line, kind, text: text.trim() })
  hunk.added.forEach((entry, i) => {
    const next = hunk.added[i + 1]
    if (SKIP.some(re => re.test(entry.text))) add(entry.line, 'skipped or focused test', entry.text)
    if (SUPPRESS.test(entry.text)) add(entry.line, 'lint or type suppression', entry.text)
    const emptyOnOneLine = EMPTY_CATCH.some(re => re.test(entry.text))
    const emptyOverTwo = OPEN_CATCH.some(re => re.test(entry.text)) && next?.line === entry.line + 1 && CLOSE_CATCH.test(next.text)
    if (emptyOnOneLine || emptyOverTwo) add(entry.line, 'empty catch', entry.text)
  })
  if (isTest) {
    const kept = new Set(hunk.added.map(entry => entry.text.trim()))
    const removedAssertions = hunk.removed.filter(entry => ASSERTION.test(entry.text) && !kept.has(entry.text.trim()))
    const addedAssertions = hunk.added.filter(entry => ASSERTION.test(entry.text)).length
    const removedTests = hunk.removed.filter(entry => DELETED_TEST.test(entry.text) && !kept.has(entry.text.trim()))
    if (removedTests.length > hunk.added.filter(entry => DELETED_TEST.test(entry.text)).length) {
      for (const entry of removedTests) add(entry.line, 'deleted test', entry.text)
    }
    if (removedAssertions.length > addedAssertions) {
      for (const entry of removedAssertions) add(entry.line, 'deleted assertion', entry.text)
    }
  }
  const before = new Map()
  for (const entry of hunk.removed) for (const n of numbers(entry.text)) if (!before.has(n.key)) before.set(n.key, n.value)
  for (const entry of hunk.added) {
    for (const n of numbers(entry.text)) {
      const rule = LOWERED.find(r => r.key.test(n.key))
      const from = before.get(n.key)
      if (rule && from !== undefined && rule.worse(from, n.value)) add(entry.line, rule.label, `${n.key} ${from} -> ${n.value}`)
    }
  }
  return found
}

const base = process.argv[2]
if (!base || process.argv.length > 3) fail(USAGE)
const diff = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U0', `${base}...HEAD`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
if (diff.error) fail(`lowered-bar: git diff ${base}...HEAD could not start: ${diff.error.message}`)
if (diff.status !== 0) fail(`lowered-bar: git diff ${base}...HEAD exited ${diff.status}: ${diff.stderr.trim()}\nRepair: fetch the base (git fetch origin) or name a ref that exists.`)

const found = []
for (const file of parse(diff.stdout)) {
  if (!file.path) fail('lowered-bar: a file in the diff has no path. Run git diff by hand to see it.')
  if (PROSE.test(file.path)) continue
  const isTest = TEST_FILE.test(file.path)
  if (file.deleted && isTest) {
    found.push({ path: file.path, kind: 'deleted test file', text: '' })
    continue
  }
  for (const hunk of file.hunks) found.push(...scanHunk(file.path, hunk, isTest))
}

if (!found.length) {
  process.stdout.write(`Lowered-bar scan: found nothing against ${base}.\n`)
  process.exit(0)
}
const lines = found.map(f => (f.line === undefined ? `${f.path}: ${f.kind}` : `${f.path}:${f.line}: ${f.kind}: ${f.text}`))
process.stdout.write(`${lines.join('\n')}\nEach line above lowers the bar. Each one needs a stated reason in the code, the commit message or the PR body; a line without one is a review finding.\n`)
process.exit(1)
