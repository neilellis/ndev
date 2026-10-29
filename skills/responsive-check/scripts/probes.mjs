// The measurement that runs inside the page. Playwright serialises this function, so it must
// use nothing from outside its own body. It returns raw numbers; responsive-lib.mjs judges them.
export function probe({ target = 24 } = {}) {
  const root = document.documentElement
  const clientWidth = root.clientWidth
  const scrollWidth = root.scrollWidth
  const MAX = 600

  const selectorOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`
    const parts = []
    for (let e = el; e && e !== root && parts.length < 3; e = e.parentElement) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break }
      const cls = [...e.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('')
      const same = e.parentElement ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName) : []
      const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''
      parts.unshift(`${e.tagName.toLowerCase()}${cls}${cls ? '' : nth}`)
    }
    return parts.join(' > ')
  }

  const isShown = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    // Wholly left of or above the page, as a skip link waits until it has focus.
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    }
    return true
  }

  // An element inside a sideways scroller or a clipped box does not widen the page.
  const isClipped = (el) => {
    for (let e = el.parentElement; e && e !== root && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
    }
    return false
  }

  const all = [...document.body.querySelectorAll('*')]

  // An element widens the page when it ends past the viewport but not past the page's own width:
  // one that ends past scrollWidth is clipped somewhere, whatever its styles say.
  const widens = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.right + scrollX > clientWidth + 1 && r.right + scrollX <= scrollWidth + 1
  }
  const culprits = (isStyleChecked) => {
    const found = []
    for (const el of all) {
      if (found.length >= 20) break
      if (!widens(el) || (isStyleChecked && isClipped(el))) continue
      // Keep the deepest culprits: skip an element whose child also widens the page.
      if ([...el.children].some(widens)) continue
      found.push({ selector: selectorOf(el), right: Math.round(el.getBoundingClientRect().right + scrollX) })
    }
    return found
  }
  let overflow = []
  if (scrollWidth > clientWidth + 1) {
    overflow = culprits(true)
    // An absolute element escapes a clip outside its containing block, which isClipped cannot see.
    if (!overflow.length) overflow = culprits(false)
  }

  const TARGET = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [onclick]'
  const targets = []
  for (const el of document.querySelectorAll(TARGET)) {
    if (targets.length >= MAX || !isShown(el)) continue
    const s = getComputedStyle(el)
    // WCAG 2.5.8 exempts a link inside a sentence.
    if (el.tagName === 'A' && s.display === 'inline' && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim())) continue
    const r = el.getBoundingClientRect()
    targets.push({ selector: selectorOf(el), width: Math.round(r.width), height: Math.round(r.height), rect: r })
  }
  // WCAG 2.5.8 spacing exception: a circle of `target` px centred on an undersized target must not
  // touch another target, nor the circle of another undersized target. `isSpaced` says it does not.
  const isSmall = (t) => t.width < target || t.height < target
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2]
  for (const t of targets) {
    if (!isSmall(t)) continue
    const [x, y] = centre(t.rect)
    t.isSpaced = targets.every((u) => {
      if (u === t) return true
      const dx = Math.max(u.rect.left - x, 0, x - u.rect.right)
      const dy = Math.max(u.rect.top - y, 0, y - u.rect.bottom)
      if (Math.hypot(dx, dy) < target / 2) return false
      const [ux, uy] = centre(u.rect)
      return !isSmall(u) || Math.hypot(ux - x, uy - y) >= target
    })
  }
  for (const t of targets) delete t.rect

  const inputs = []
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')) {
    if (!isShown(el)) continue
    inputs.push({ selector: selectorOf(el), fontSize: Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 })
  }

  // Height rules in plain vh, read from same-origin style sheets.
  const vh = []
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !rule.selectorText) walk(rule.cssRules)
      if (!rule.style || !rule.selectorText) continue
      for (const property of ['height', 'min-height', 'max-height']) {
        const value = rule.style.getPropertyValue(property)
        if (/(^|[\s(])\d*\.?\d+vh\b/.test(value)) vh.push({ selector: rule.selectorText, property, value })
      }
    }
  }
  let hasDark = !!document.querySelector('meta[name=color-scheme][content*=dark]') || /dark/.test(getComputedStyle(root).colorScheme)
  const scanDark = (rules) => {
    for (const rule of rules) {
      if (rule.media && /prefers-color-scheme:\s*dark/.test(rule.media.mediaText)) hasDark = true
      if (rule.cssRules) scanDark(rule.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules)
      scanDark(sheet.cssRules)
    } catch {
      // A cross-origin sheet has no readable rules.
    }
  }

  // Any CSS colour to [r, g, b, a] through a canvas, so oklch(), color() and named colours all work.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const cache = new Map()
  const rgba = (css) => {
    if (cache.has(css)) return cache.get(css)
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    const v = [r, g, b, a / 255]
    cache.set(css, v)
    return v
  }
  const over = (top, under) => {
    const a = top[3]
    return [0, 1, 2].map((i) => Math.round(top[i] * a + under[i] * (1 - a)))
  }
  const canvasColour = () => {
    const scheme = getComputedStyle(root).colorScheme
    return matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(scheme) ? [18, 18, 18] : [255, 255, 255]
  }
  // The colour behind an element: its own and its ancestors' backgrounds, composited.
  // null when a background image is in the way, so the contrast is unknown.
  const backgroundOf = (el) => {
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.backgroundImage !== 'none') return null
      const c = rgba(s.backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let bg = canvasColour()
    for (const c of layers.reverse()) bg = over(c, bg)
    return bg
  }

  const contrast = []
  const smallText = []
  for (const el of all) {
    if (contrast.length >= MAX) break
    if (!(el instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(el.tagName)) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    if (!isShown(el)) continue
    const s = getComputedStyle(el)
    const size = parseFloat(s.fontSize)
    if (size < 12) smallText.push({ selector: selectorOf(el), fontSize: size })
    const bg = backgroundOf(el)
    if (!bg) continue
    const fg = over(rgba(s.color), bg)
    contrast.push({ selector: selectorOf(el), fg, bg, isLarge: size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) })
  }

  return {
    clientWidth,
    innerWidth,
    scrollWidth,
    viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
    hasDark,
    overflow,
    targets,
    inputs,
    vh,
    smallText,
    contrast,
  }
}
