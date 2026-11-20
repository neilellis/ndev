import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { INNER_SCROLL_PROBE } from '../hooks/workflow/screenshot-scroll.ts'

function element(id, { tag = 'main', height = 500, total = 2000, box = {}, style = {}, parent = null } = {}) {
  const rect = { left: 0, top: 0, width: 600, height, ...box }
  return { id, tagName: tag.toUpperCase(), clientHeight: height, scrollHeight: total, parentElement: parent,
    style: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible', overflowX: 'visible', overflowY: 'auto', ...style },
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) }
}

function probe(nodes, root = element('root', { tag: 'html', height: 600, total: 600, box: { width: 800 } })) {
  return JSON.parse(runInNewContext(INNER_SCROLL_PROBE, {
    document: { scrollingElement: root, documentElement: root, querySelectorAll: () => [root, ...nodes] },
    getComputedStyle: node => node.style,
    innerWidth: 800, innerHeight: 600,
  }, { timeout: 1000 }))
}

test('inner scroll probe identifies a visible app-shell pane', () => {
  assert.deepEqual(probe([element('content')]), { element: 'main#content', height: 500, total: 2000 })
})

test('inner scroll probe chooses the largest visible scrolling pane', () => {
  assert.deepEqual(probe([element('sidebar', { tag: 'aside', box: { width: 100 } }), element('content', { box: { left: 150 } })]), { element: 'main#content', height: 500, total: 2000 })
})

test('inner scroll probe ignores content that fits and one-pixel rounding', () => {
  assert.equal(probe([element('fits', { total: 500 }), element('rounding', { total: 501 })]), null)
})

test('inner scroll probe ignores hidden and offscreen panes', () => {
  assert.equal(probe([element('hidden', { style: { visibility: 'hidden' } }), element('offscreen', { box: { left: 900 } })]), null)
})

test('inner scroll probe ignores transparent ancestors and zero-height panes', () => {
  const transparent = element('transparent', { total: 500, style: { opacity: '0' } })
  assert.equal(probe([transparent, element('content', { parent: transparent }), element('zero', { height: 0 })]), null)
})

test('inner scroll probe ignores the document scrolling element', () => {
  const root = element('root', { tag: 'html', height: 600, total: 2000 })
  assert.equal(probe([], root), null)
})

test('inner scroll probe ignores a horizontal-only pane', () => {
  assert.equal(probe([element('horizontal', { total: 500, style: { overflowX: 'auto', overflowY: 'hidden' } })]), null)
})

test('inner scroll probe excludes a pane fully clipped by an ancestor', () => {
  const clipped = element('clip', { height: 50, total: 50, box: { width: 100 }, style: { overflowX: 'hidden', overflowY: 'hidden' } })
  assert.equal(probe([clipped, element('content', { parent: clipped, box: { top: 200 } })]), null)
})

test('inner scroll probe includes a visible child overriding ancestor visibility', () => {
  const hidden = element('ancestor', { height: 600, total: 600, style: { visibility: 'hidden' } })
  assert.deepEqual(probe([hidden, element('content', { parent: hidden, style: { visibility: 'visible' } })]), { element: 'main#content', height: 500, total: 2000 })
})
