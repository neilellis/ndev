// An arrow with a sign, drawn into the page so a recorded video shows the reader
// what to look at next. Injected as a Playwright init script beside cursor.js; it adds
// window.walkArrow and draws nothing until it is called. It does inside a web page what the
// macOS tool bigarrow (github.com/franzenzenhofer/big-arrow-on-the-screen, MIT) does on a
// screen. The code is written from bigarrow's documented behaviour, not copied from it.
//
//   walkArrow.point('text=AI agents', { text: 'Open AI agents' })
//   walkArrow.point('#login-viewer', { text: 'Your login', size: 'L', highlight: 'box' })
//   walkArrow.point({ x: 760, y: 500 }, { text: 'Here', duration: 3000 })
//   walkArrow.point('text=Save', { role: 'button', text: 'Paste {{482913}} here', from: 'right',
//                                  shape: 'zigzag', color: 'green', border: 'white-black' })
//   const id = walkArrow.point('text=Allow', { text: 'Click Allow', untilClick: true })
//   await walkArrow.wait(id)    // { id, reason: 'click' }
//   walkArrow.card({ title: 'Sign in', rows: [{ label: 'User', value: 'ana' }] })
//   walkArrow.magnify('#email', { text: 'Your email' })   // enlarges the field while typing
//   walkArrow.stop()            // removes everything; stop(id), stop('last'), stop({ group })
//
// Targets
//   'css selector'     the first match (with role: the first match that has that role)
//   'text=<label>'     the smallest visible element whose text, aria-label, title, placeholder,
//                      alt or button value is exactly <label>
//   an Element, { x, y }, { x, y, w, h } (a rect, boxed by default), 'mouse' (follows the
//   pointer), 'viewport' (the visible page; anchor picks a spot in it)
//
// point(target, options) → id. Options, with defaults:
//   text ''              the sign; {{value}} shows value on a code chip (display only)
//   look 'calm'          'calm': thin lines, muted colours, a plain sign with a soft shadow,
//                        a short draw-on and two small pulses, then still. 'bold': bigarrow's
//                        thick, saturated, bouncing look. card and magnify take it too
//   color 'red'          red orange yellow green teal blue purple pink black white (each look
//                        has its own shade of these), or any CSS colour
//   size 'M'             'S' | 'M' | 'L'
//   shape 'bend'         'bend' | 'straight' | 'zigzag' | 'spiral' (loops once round the sign)
//   highlight 'ring'     'ring' | 'box' | 'none' round the target. style 'arrow' | 'ring' | 'box'
//                        is the same choice in bigarrow's words ('arrow' means no outline)
//   corners 'round'      'round' | 'sharp', for the sign and the box
//   border 'shadow'      'shadow' (border and drop shadow) | 'white-black' | 'black'
//   borderColor, textColor, edgeColor, closeColor, closeXColor   readable defaults from color
//   from 'auto'          the sign's side: auto, top, top-right, right, bottom-right, bottom,
//                        bottom-left, left, top-left. Another side when it does not fit; signs
//                        of several arrows keep out of each other's way
//   anchor 'center'      the spot the tip points at: center, title, top, top-right, ... top-left
//   role ''              only match elements with this ARIA role (explicit or implicit)
//   coords 'viewport'    'page' reads { x, y } and rects as document coordinates
//   duration 0           ms before it removes itself; 0 keeps it until stop
//   untilClick false     removes it when the target is clicked
//   untilAnyClick false  removes it on the next click anywhere
//   closeButton false    an X in the sign; a click on the sign removes the arrow, and the click
//                        still reaches the page underneath
//   scroll false         scrolls the target into view first
//   follow false         finds a string target again every 250 ms, so it survives re-renders;
//                        without follow, a target that leaves the document removes the arrow
//   hideCovered true     fades out while the target is covered or out of view
//   animate 'auto'       true | 'reduced' | false; 'auto' follows prefers-reduced-motion
//   say false, voice ''  speaks the sign with speechSynthesis
//   group ''             a name for stop({ group })
//
// card(options) → id: a display-only cue card. { title, note (**bold** allowed), rows, color,
// from 'top-right' (a corner, top or bottom), duration, group, animate, look }. A row is
// { label, value } with optional secret (shown as dots) or code (monospace),
// { label, progress: 0..1 } or { checklist: [{ label, done }] }. Any row may add
// point: target and text: it draws an arrow that ends with the card.
//
// magnify(target, options) → id: a magnifier for a text field (input, textarea or
// contenteditable). A panel beside the field shows its text, placeholder and caret enlarged,
// joined to the field by a beam, and follows every keystroke so a recording can be read.
// { text (a caption), scale 3 (1.5 to 6), color, from 'auto' | 'top' | 'bottom', duration,
// untilBlur (ends when the field loses focus), group, animate, look }. Password fields show dots.
// An error inside it is logged with console.debug and rejects wait(id); it is not swallowed.
//
// stop(which) → the number removed. wait(id) → a Promise of { id, reason }, where reason is
// timeout, click, any-click, close, blur, stop or gone. active() → live ids. info(id) and
// plan(target, options) (a dry run that draws nothing) → { target, tip, tail, sign, from,
// hidden }. elements({ role }) → the labelled elements 'text=' can match. doctor() → viewport,
// motion, speech and live ids. demo() → a Promise; shows an arrow, a ring and a box in turn.
//
// Errors name the target and location.href and carry code 'BAD_INPUT' or 'NOT_FOUND'. Called
// before the document exists, point, card and magnify wait for it and return the id at once; a later
// error is logged and rejects wait(id). The overlay ignores pointer events, takes no focus and
// is hidden from assistive technology, so the page does not change.
(() => {
  if (window.walkArrow) return;
  const TOP = '2147483647';
  const NS = 'http://www.w3.org/2000/svg';
  // Line widths are px. halo and haloCasing are the outline's colour and edge strokes, haloPad
  // its distance from the target, gap the space between the outline and the tip, tailGap the
  // space between the sign and the shaft. A pulse lasts pulse ms and swells the head by beat.
  const LOOKS = {
    calm: {
      sizes: {
        S: { stroke: 3, length: 90, font: 12, sign: 220 },
        M: { stroke: 4, length: 120, font: 13, sign: 260 },
        L: { stroke: 5.5, length: 160, font: 15, sign: 300 },
      },
      colors: {
        red: '#c8443a', orange: '#cf7a2e', yellow: '#e2b53e', green: '#2f8f5b', teal: '#2a8a82',
        blue: '#3a68c9', purple: '#6c58b5', pink: '#c24f80', black: '#1c1c1f', white: '#ffffff',
      },
      weight: 500, padY: 5, padX: 10, radius: 6, ring: 1, signShadow: '0 2px 6px rgba(0,0,0,.18)',
      casing: 3, head: 3.6, headEdge: 1.5, halo: 2, haloCasing: 5, haloPad: 4, gap: 3, tailGap: 6,
      shadow: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.25))', drawMs: 320, bob: 0, pulse: 600, beat: 0.05, pulses: 2,
    },
    bold: {
      sizes: {
        S: { stroke: 6, length: 110, font: 13, sign: 220 },
        M: { stroke: 9, length: 160, font: 15, sign: 260 },
        L: { stroke: 12, length: 220, font: 18, sign: 320 },
      },
      colors: {
        red: '#ff1a1a', orange: '#ff8a1c', yellow: '#ffd41f', green: '#1faa4f', teal: '#0fa9a1',
        blue: '#1f6fff', purple: '#8b3dff', pink: '#ff2e7e', black: '#1c1c1f', white: '#ffffff',
      },
      weight: 600, padY: 8, padX: 12, radius: 8, ring: 2, signShadow: '0 3px 8px rgba(0,0,0,.35)',
      casing: 5, head: 3.2, headEdge: 2.5, halo: 4, haloCasing: 8, haloPad: 8, gap: 6, tailGap: 10,
      shadow: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))', drawMs: 420, bob: 5, pulse: 900, beat: 0.06, pulses: Infinity,
    },
  };
  const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
  const DARK = '#1c1c1f';
  const D = Math.SQRT1_2;
  const SIDES = {
    top: [0, -1], 'top-right': [D, -D], right: [1, 0], 'bottom-right': [D, D],
    bottom: [0, 1], 'bottom-left': [-D, D], left: [-1, 0], 'top-left': [-D, -D],
  };
  const DEFAULTS = {
    text: '', color: 'red', size: 'M', shape: 'bend', style: undefined, highlight: 'ring',
    corners: 'round', border: 'shadow', borderColor: undefined, textColor: undefined,
    edgeColor: undefined, closeColor: undefined, closeXColor: undefined, from: 'auto',
    anchor: 'center', role: '', coords: 'viewport', duration: 0, untilClick: false,
    untilAnyClick: false, closeButton: false, scroll: false, follow: false, hideCovered: true,
    animate: 'auto', say: false, voice: '', group: '', look: 'calm',
  };
  const ENUMS = {
    look: Object.keys(LOOKS), size: ['S', 'M', 'L'], shape: ['bend', 'straight', 'zigzag', 'spiral'],
    style: [undefined, 'arrow', 'ring', 'box'], highlight: ['ring', 'box', 'none'],
    corners: ['round', 'sharp'], border: ['shadow', 'white-black', 'black'],
    from: ['auto', ...Object.keys(SIDES)], anchor: ['center', 'title', ...Object.keys(SIDES)],
    coords: ['viewport', 'page'], animate: ['auto', true, false, 'reduced'],
  };
  const CARD_DEFAULTS = { title: '', note: '', rows: [], color: 'red', from: 'top-right', duration: 0, group: '', animate: 'auto', look: 'calm' };
  const CARD_SIDES = ['top-left', 'top', 'top-right', 'bottom-left', 'bottom', 'bottom-right'];
  const FADE_MS = 200;
  const arrows = new Map();
  const cards = new Map();
  const lenses = new Map();
  const pending = new Set();
  const results = new Map();
  let host = null;
  let svg = null;
  let raf = 0;
  let nextId = 1;
  let pointer = null;
  let probe = null;

  const fail = (code, msg) => Object.assign(new Error(`walkArrow: ${msg}`), { code });
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ease = (t) => 1 - (1 - clamp(t, 0, 1)) ** 3;

  const onPointer = (e) => { pointer = { x: e.clientX, y: e.clientY }; };
  window.addEventListener('mousemove', onPointer, { capture: true, passive: true });
  window.addEventListener('pointermove', onPointer, { capture: true, passive: true });

  // wait(id) reads these: one settled promise per id, the oldest dropped past 200
  const result = (id) => {
    let r = results.get(id);
    if (!r) {
      r = {};
      r.promise = new Promise((res, rej) => { r.resolve = res; r.reject = rej; });
      r.promise.catch(() => {}); // the rejection is reported by console.error where it happens
      results.set(id, r);
      if (results.size > 200) results.delete(results.keys().next().value);
    }
    return r;
  };

  // Runs fn once the document exists; a string target also waits for the parsed DOM.
  const whenReady = (id, needsDom, fn) => {
    const run = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      try { fn(); } catch (e) { console.error(e); result(id).reject(e); }
    };
    const afterRoot = () => {
      if (needsDom && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
      else run();
    };
    pending.add(id);
    new MutationObserver((_, obs) => { if (document.documentElement) { obs.disconnect(); afterRoot(); } })
      .observe(document, { childList: true });
  };

  // ---- colours and text ----

  const parseColor = (c, name, look) => {
    if (typeof c !== 'string' || !c.trim()) throw fail('BAD_INPUT', `${name} is a colour name or CSS colour; got ${String(c)} on ${location.href}`);
    const COLORS = LOOKS[look].colors;
    const preset = COLORS[c.trim().toLowerCase()];
    if (preset) return preset;
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#010203';
    probe.fillStyle = c;
    const first = probe.fillStyle;
    probe.fillStyle = '#040506';
    probe.fillStyle = c;
    if (probe.fillStyle !== first) throw fail('BAD_INPUT', `${name} ${c} is not a colour; use ${Object.keys(COLORS).join(', ')} or any CSS colour (on ${location.href})`);
    return first;
  };

  const luma = (c) => {
    const [r, g, b] = c[0] === '#'
      ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
      : c.match(/[\d.]+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  const parseText = (text) => {
    if (typeof text !== 'string') throw fail('BAD_INPUT', `text is a string; got ${String(text)} on ${location.href}`);
    const parts = [];
    const re = /\{\{(.*?)\}\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[1].trim()) throw fail('BAD_INPUT', `empty {{}} in the sign "${text}" on ${location.href}`);
      parts.push({ text: text.slice(last, m.index) }, { value: m[1] });
      last = re.lastIndex;
    }
    parts.push({ text: text.slice(last) });
    for (const p of parts) {
      if (p.text && /\{\{|\}\}/.test(p.text)) throw fail('BAD_INPUT', `unbalanced {{ or }} in the sign "${text}" on ${location.href}`);
    }
    return parts.filter((p) => p.value || p.text);
  };

  const motion = (animate) => (animate === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full')
    : animate === true ? 'full' : animate === false ? 'off' : 'reduced');

  const normalise = (opts) => {
    if (!opts || typeof opts !== 'object') throw fail('BAD_INPUT', `options are an object; got ${String(opts)} on ${location.href}`);
    for (const k of Object.keys(opts)) {
      if (!(k in DEFAULTS)) throw fail('BAD_INPUT', `unknown option ${k} on ${location.href}; known: ${Object.keys(DEFAULTS).join(', ')}`);
    }
    if (opts.style !== undefined && opts.highlight !== undefined) throw fail('BAD_INPUT', `give style or highlight, not both (on ${location.href})`);
    const o = { ...DEFAULTS, ...opts };
    for (const [k, allowed] of Object.entries(ENUMS)) {
      if (!allowed.includes(o[k])) throw fail('BAD_INPUT', `${k} is ${allowed.filter((v) => v !== undefined).join(', ')}; got ${o[k]} (on ${location.href})`);
    }
    if (!(Number.isFinite(o.duration) && o.duration >= 0)) throw fail('BAD_INPUT', `duration is ms >= 0; got ${o.duration} (on ${location.href})`);
    if (o.style) o.highlight = o.style === 'arrow' ? 'none' : o.style;
    o.explicitMark = opts.style !== undefined || opts.highlight !== undefined;
    o.L = LOOKS[o.look];
    o.color = parseColor(o.color, 'color', o.look);
    const light = luma(o.color) > 0.6;
    o.textColor = o.textColor === undefined ? (light ? DARK : '#ffffff') : parseColor(o.textColor, 'textColor', o.look);
    const autoBorder = o.borderColor === undefined;
    o.borderColor = autoBorder ? (light ? DARK : '#ffffff') : parseColor(o.borderColor, 'borderColor', o.look);
    o.edgeColor = o.edgeColor === undefined ? (o.border === 'black' && luma(o.color) < 0.2 ? '#ffffff' : '#000000') : parseColor(o.edgeColor, 'edgeColor', o.look);
    const autoClose = o.closeColor === undefined;
    o.closeColor = autoClose ? o.borderColor : parseColor(o.closeColor, 'closeColor', o.look);
    o.closeXColor = o.closeXColor !== undefined ? parseColor(o.closeXColor, 'closeXColor', o.look)
      : autoClose ? o.color : (luma(o.closeColor) > 0.6 ? DARK : '#ffffff');
    o.parts = parseText(o.text);
    o.plain = o.parts.map((p) => p.value || p.text).join('');
    o.mode = motion(o.animate);
    if (o.say) {
      if (!window.speechSynthesis) throw fail('BAD_INPUT', `say needs speechSynthesis, which ${location.href} does not have`);
      if (o.voice) {
        const voices = speechSynthesis.getVoices();
        o.voiceObj = voices.find((v) => v.name === o.voice);
        if (!o.voiceObj) throw fail('BAD_INPUT', `no voice ${o.voice} on ${location.href}; voices: ${voices.map((v) => v.name).join(', ') || 'none'}`);
      }
    }
    return o;
  };

  // ---- targets ----

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.localName;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      return type === 'hidden' ? '' : 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return {
      textarea: 'textbox', select: 'combobox', li: 'listitem', ul: 'list', ol: 'list', img: 'img',
      nav: 'navigation', td: 'cell', th: 'columnheader', table: 'table', dialog: 'dialog',
      main: 'main', form: 'form',
    }[tag] || '';
  };

  const labelsOf = (el) => [
    el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'),
    el.getAttribute('placeholder'), el.getAttribute('alt'),
    el.localName === 'input' && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '',
  ].map(norm).filter(Boolean);

  const CANDIDATES = 'a, button, input, textarea, select, img, [role], [aria-label], [title], [placeholder], summary, label, h1, h2, h3, h4, h5, h6, li, td, th, span, div, p';

  const findByText = (text, role) => {
    const want = norm(text);
    let best = null;
    for (const el of document.querySelectorAll(CANDIDATES)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (role && roleOf(el) !== role) continue;
      if (!labelsOf(el).includes(want)) continue;
      if (!best || r.width * r.height < best.r.width * best.r.height) best = { el, r };
    }
    return best && best.el;
  };

  const lookup = (target, o) => {
    if (target.startsWith('text=')) return findByText(target.slice(5), o.role);
    try {
      if (!o.role) return document.querySelector(target);
      return [...document.querySelectorAll(target)].find((el) => roleOf(el) === o.role) || null;
    } catch (e) {
      throw fail('BAD_INPUT', `${target} is not a CSS selector (on ${location.href}): ${e.message}`);
    }
  };

  const resolve = (target, o) => {
    if (target instanceof Element) {
      if (o.role && roleOf(target) !== o.role) throw fail('NOT_FOUND', `the element given has role ${roleOf(target) || 'none'}, not ${o.role} (on ${location.href})`);
      return { kind: 'el', el: target };
    }
    if (target === 'mouse') {
      if (!pointer) throw fail('NOT_FOUND', `no pointer position on ${location.href} yet; move the mouse first or point at { x, y }`);
      return { kind: 'mouse' };
    }
    if (target === 'viewport') return { kind: 'viewport' };
    if (target && typeof target === 'object' && Number.isFinite(target.x) && Number.isFinite(target.y)) {
      if (!('w' in target) && !('h' in target)) return { kind: 'point', x: target.x, y: target.y };
      if (!(target.w > 0 && target.h > 0)) throw fail('BAD_INPUT', `a rect needs w > 0 and h > 0; got ${JSON.stringify(target)} on ${location.href}`);
      return { kind: 'rect', x: target.x, y: target.y, w: target.w, h: target.h };
    }
    if (typeof target !== 'string') {
      throw fail('BAD_INPUT', `a target is a selector, 'text=...', an Element, { x, y }, { x, y, w, h }, 'mouse' or 'viewport'; got ${String(target)} on ${location.href}`);
    }
    const el = lookup(target, o);
    if (!el) throw fail('NOT_FOUND', `nothing on ${location.href} matches ${target}${o.role ? ` with role ${o.role}` : ''}`);
    return { kind: 'el', el };
  };

  const rectOf = (a) => {
    const s = a.src;
    if (s.kind === 'el') {
      const r = s.el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    if (s.kind === 'viewport') return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    if (s.kind === 'mouse') return { x: pointer.x, y: pointer.y, w: 0, h: 0 };
    const page = a.o.coords === 'page';
    return { x: s.x - (page ? window.scrollX : 0), y: s.y - (page ? window.scrollY : 0), w: s.w || 0, h: s.h || 0 };
  };

  // The point the tip aims at, and the rect the arrow keeps clear of.
  const focusOf = (a, r) => {
    const anchor = a.o.anchor;
    const viewport = a.src.kind === 'viewport';
    let mark = r;
    if (!r.w && a.o.explicitMark && a.o.highlight !== 'none') mark = { x: r.x - 20, y: r.y - 20, w: 40, h: 40 };
    if (anchor === 'center' && !viewport) return { x: r.x + r.w / 2, y: r.y + r.h / 2, mark, halo: mark.w ? mark : null };
    const inset = Math.min(16, r.w / 4, r.h / 4);
    const [sx, sy] = anchor === 'center' ? [0, 0] : anchor === 'title' ? [0, -1] : SIDES[anchor].map(Math.sign);
    const x = r.x + r.w / 2 + sx * (r.w / 2 - inset);
    const y = anchor === 'title' ? r.y + Math.min(20, r.h / 4) : r.y + r.h / 2 + sy * (r.h / 2 - inset);
    return { x, y, mark: { x, y, w: 0, h: 0 }, halo: viewport ? null : r.w ? r : null };
  };

  const within = (node, root) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === root) return true;
    return false;
  };

  // A target counts as shown when any of five points inside it hits the target or a child of
  // it, looking inside open shadow roots. An ancestor on top means the target is clipped.
  const shown = (a, r) => {
    if (a.src.kind !== 'el' || !a.o.hideCovered) return true;
    const el = a.src.el;
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
      const x = r.x + r.w * fx;
      const y = r.y + r.h * fy;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (hit && within(hit, el)) return true;
    }
    return false;
  };

  // ---- layout ----

  const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
  const overlap = (p, q) => area({
    w: Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x),
    h: Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y),
  });
  const grow = (r, by) => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

  const loopRoom = (a) => (a.o.shape === 'spiral' ? a.size.stroke * 4.2 : 0);

  // The outline's padding: the look's, narrowed so two outlines on neighbouring targets do not
  // run into each other. Between targets a few px apart it goes below zero, onto the target's edge.
  const padFor = (a, m) => {
    const L = a.o.L;
    const base = a.o.highlight === 'none' ? L.haloPad / 2 : L.haloPad;
    if (a.o.highlight === 'none' || !m.w) return base;
    let pad = base;
    for (const b of arrows.values()) {
      if (b === a || !b.mark || !b.mark.w || b.o.highlight === 'none' || !b.visible) continue;
      const gx = Math.max(b.mark.x - (m.x + m.w), m.x - (b.mark.x + b.mark.w), 0);
      const gy = Math.max(b.mark.y - (m.y + m.h), m.y - (b.mark.y + b.mark.h), 0);
      const dist = Math.hypot(gx, gy);
      if (!dist) continue; // one target inside or across the other: narrowing would not help
      const edges = (L.haloCasing + b.o.L.haloCasing) / 2 + 2;
      pad = Math.min(pad, Math.max(-L.haloCasing / 2, (dist - edges) / 2));
    }
    return pad;
  };

  // How far from the focus, along u, the tip sits: the outline drawn round the target is cast
  // as a rounded rect, and the tip stops a fixed gap outside it, so the head meets a ring or a
  // box at the same distance from any side.
  const reachOut = (a, f, u) => {
    const L = a.o.L;
    const m = f.mark;
    if (!m.w && !m.h) return L.gap + 6;
    const pad = a.pad;
    const bx = m.w / 2 + pad;
    const by = m.h / 2 + pad;
    const hl = a.o.highlight;
    const rr = Math.min(bx, by, hl === 'ring' ? Math.min(m.w, m.h) / 2 + pad : hl === 'box' && a.o.corners === 'round' ? 6 : 0);
    const off = (hl === 'none' ? 0 : L.haloCasing / 2) + L.gap;
    const sdf = (t) => {
      const qx = Math.abs(u.x * t) - bx + rr;
      const qy = Math.abs(u.y * t) - by + rr;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
    };
    let lo = 0;
    let hi = Math.hypot(bx, by) + off + 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (sdf(mid) < off) lo = mid; else hi = mid;
    }
    return hi;
  };

  const geometry = (a, f, u, bob) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const edge = reachOut(a, f, u) + bob;
    const tip = { x: f.x + u.x * edge, y: f.y + u.y * edge };
    const M = 14;
    const reach = { x: f.x + u.x * (edge + a.size.length), y: f.y + u.y * (edge + a.size.length) };
    const tail = { x: clamp(reach.x, M, W - M), y: clamp(reach.y, M, H - M) };
    const sw = a.sw;
    const sh = a.sh;
    const support = Math.abs(u.x) * sw / 2 + Math.abs(u.y) * sh / 2;
    const away = support + a.o.L.tailGap + loopRoom(a);
    const sign = { x: tail.x + u.x * away - sw / 2, y: tail.y + u.y * away - sh / 2, w: sw, h: sh };
    return { tip, tail, reach, sign, pad: a.pad };
  };

  // Where a line from the middle of the sign to the tip leaves the sign, `by` px out: the tail,
  // once the sign has been moved to fit the screen. Null when the tip is that close to the sign.
  const exitOf = (s, to, by) => {
    const c = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const dx = to.x - c.x;
    const dy = to.y - c.y;
    const t = Math.min(dx ? (s.w / 2 + by) / Math.abs(dx) : Infinity, dy ? (s.h / 2 + by) / Math.abs(dy) : Infinity);
    return t < 0.8 ? { x: c.x + dx * t, y: c.y + dy * t } : null;
  };

  const inside = (p, r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

  // Picks the sign's side: the preferred side unless it does not fit, clear of the target,
  // of the signs already placed this frame, of the other arrows' targets and shafts, and steady
  // from frame to frame.
  const place = (a, f, placed) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let cx = W / 2 - f.x;
    let cy = H / 2 - f.y;
    const d = Math.hypot(cx, cy);
    if (d < 40) { cx = 0.6; cy = 0.8; } else { cx /= d; cy /= d; }
    const candidates = Object.entries(SIDES).map(([key, [x, y]]) => [key, { x, y }]);
    if (a.o.from === 'auto') candidates.unshift(['centre', { x: cx, y: cy }]);
    const inner = { x: 8, y: 8, w: W - 16, h: H - 16 };
    const others = [...arrows.values()].filter((x) => x !== a && x.markBox && x.visible);
    let best = null;
    for (const [key, u] of candidates) {
      const g = geometry(a, f, u, 0);
      const room = grow(g.sign, loopRoom(a));
      let s = a.sw ? (area(room) - overlap(room, inner)) * 50 : 0;
      if (!a.sw && (g.reach.x < 0 || g.reach.y < 0 || g.reach.x > W || g.reach.y > H)) s += 1e5;
      for (const q of placed) s += overlap(room, q) * 5;
      for (const b of others) {
        s += overlap(room, b.markBox) * 5;
        for (let k = 0.1; k < 1; k += 0.1) {
          if (inside({ x: g.tail.x + (g.tip.x - g.tail.x) * k, y: g.tail.y + (g.tip.y - g.tail.y) * k }, b.markBox)) s += 3000;
        }
        if (a.sw && b.pts) {
          const clear = grow(room, b.size.stroke / 2 + 4);
          for (const p of b.pts) if (inside(p, clear)) s += 600;
        }
      }
      s += overlap(room, grow(f.mark, g.pad)) * 5;
      if (a.o.from === 'auto') s -= (u.x * cx + u.y * cy) * 120 + (key === 'centre' ? 20 : 0);
      else if (key === a.o.from) s -= 400;
      if (key === a.dir) s -= 40;
      if (!best || s < best.s) best = { key, u, s };
    }
    a.dir = best.key;
    return best.u;
  };

  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
  const poly = (pts) => `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;

  // The shaft from the sign to just short of the tip, the direction the head points, and points
  // along it that other signs keep clear of.
  const shaft = (a, g, headLen) => {
    const { tail: T, tip: P } = g;
    const stroke = a.size.stroke;
    const shape = a.o.shape;
    const len = Math.hypot(P.x - T.x, P.y - T.y);
    const c = unit(P.x - T.x, P.y - T.y);
    const endOf = (t) => ({ x: P.x - t.x * headLen * 0.7, y: P.y - t.y * headLen * 0.7 });
    if (shape === 'zigzag') {
      const lead = stroke * 2;
      const run = headLen * 1.2;
      const mid = len - lead - run - headLen * 0.7;
      const end = endOf(c);
      if (mid < stroke * 6) return { d: poly([T, end]), t: c, pts: [T, end] };
      const n = Math.min(9, Math.max(3, Math.round(mid / (stroke * 6)) | 1));
      const swing = stroke * 2.2;
      const pts = [T, { x: T.x + c.x * lead, y: T.y + c.y * lead }];
      for (let i = 1; i < n; i++) {
        const s = lead + (mid * i) / n;
        const side = i % 2 ? 1 : -1;
        pts.push({ x: T.x + c.x * s - c.y * swing * side, y: T.y + c.y * s + c.x * swing * side });
      }
      pts.push({ x: T.x + c.x * (lead + mid), y: T.y + c.y * (lead + mid) }, end);
      return { d: poly(pts), t: c, pts };
    }
    if (shape === 'spiral') {
      const s = g.sign;
      const gap = stroke * 1.6;
      const room = loopRoom(a) - gap;
      const S = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
      const ax = s.w / 2 + gap || 18;
      const ay = s.h / 2 + gap || 18;
      const t0 = Math.atan2((T.y - S.y) / ay, (T.x - S.x) / ax);
      const pts = [];
      const N = 48;
      for (let i = 0; i <= N; i++) {
        const k = i / N;
        const th = t0 + k * Math.PI * 2 * 0.94;
        pts.push({ x: S.x + Math.cos(th) * (ax + room * k), y: S.y + Math.sin(th) * (ay + room * k) });
      }
      const last = pts[pts.length - 1];
      const t = unit(P.x - last.x, P.y - last.y);
      pts.push(endOf(t));
      return { d: poly(pts), t, pts };
    }
    const bend = shape === 'bend' ? 0.28 : 0;
    const qx = (T.x + P.x) / 2 + c.y * len * bend;
    const qy = (T.y + P.y) / 2 - c.x * len * bend;
    const t = unit(P.x - qx, P.y - qy);
    const end = endOf(t);
    const pts = [];
    for (let k = 0; k <= 1.001; k += 0.1) {
      const i = 1 - k;
      pts.push({ x: i * i * T.x + 2 * i * k * qx + k * k * end.x, y: i * i * T.y + 2 * i * k * qy + k * k * end.y });
    }
    return { d: `M${T.x},${T.y} Q${qx},${qy} ${end.x},${end.y}`, t, pts };
  };

  // ---- drawing ----

  const ensureHost = () => {
    if (host && host.isConnected) return;
    const fresh = !host;
    if (fresh) {
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('role', 'presentation');
      host.style.cssText = `position:fixed;inset:0;margin:0;padding:0;border:0;pointer-events:none;z-index:${TOP};overflow:hidden;`;
      svg = document.createElementNS(NS, 'svg');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;';
      host.appendChild(svg);
    }
    document.documentElement.appendChild(host);
  };

  const node = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  const glyph = (paths, color, px) => {
    const s = node('svg', { viewBox: '0 0 24 24', width: px, height: px, fill: 'none', stroke: color, 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    s.style.cssText = 'flex:none;display:block;';
    for (const d of paths) s.appendChild(node('path', { d }));
    return s;
  };

  const signShadow = (o) => {
    const L = o.L;
    if (o.border === 'shadow') return `0 0 0 ${L.ring}px ${o.borderColor},${L.signShadow}`;
    if (o.border === 'white-black') return `0 0 0 ${L.ring}px ${o.borderColor},0 0 0 ${L.ring + 1}px ${o.edgeColor}`;
    return `0 0 0 1px ${o.edgeColor}`;
  };

  const makeSign = (o, size) => {
    const L = o.L;
    const calm = o.look === 'calm';
    const sign = document.createElement('div');
    for (const p of o.parts) {
      if (p.text) { sign.append(p.text); continue; }
      const chip = document.createElement('span');
      chip.style.cssText = `display:inline-flex;align-items:center;gap:5px;margin:0 2px;padding:0 ${calm ? 6 : 7}px;border-radius:${calm ? 4 : 5}px;background:${o.borderColor};color:${o.color};font:${calm ? 600 : 700} 0.95em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;vertical-align:baseline;`;
      chip.append(p.value, glyph(['M9 9h10v10H9z', 'M5 15V5h10'], o.color, '0.9em'));
      sign.appendChild(chip);
    }
    const close = calm ? 18 : 22;
    if (o.closeButton) {
      const x = document.createElement('span');
      x.style.cssText = `position:absolute;right:${calm ? 6 : 8}px;top:50%;width:${close}px;height:${close}px;margin-top:-${close / 2}px;border-radius:50%;background:${o.closeColor};display:flex;align-items:center;justify-content:center;`;
      x.appendChild(glyph(['M7 7l10 10', 'M17 7L7 17'], o.closeXColor, close - 8));
      sign.appendChild(x);
    }
    const right = o.closeButton ? close + L.padX + (calm ? 4 : 6) : L.padX;
    sign.style.cssText = `position:absolute;left:0;top:0;max-width:${size.sign}px;padding:${L.padY}px ${right}px ${L.padY}px ${L.padX}px;border-radius:${o.corners === 'round' ? L.radius : 0}px;background:${o.color};color:${o.textColor};font:${L.weight} ${size.font}px/1.35 ${FONT};box-shadow:${signShadow(o)};white-space:normal;transform-origin:50% 50%;`;
    return sign;
  };

  // A damped spring from `from` to 1, t in ms.
  const spring = (t, from) => (t <= 0 ? from : 1 - (1 - from) * Math.exp(-t / 110) * Math.cos(t / 55));

  // How far into the look's pulses the arrow is, in pulses; past the last, it holds still.
  const beatAt = (a, age) => (age - a.o.L.drawMs * 0.8 - (a.o.L.bob ? 584 : 220)) / a.o.L.pulse;

  // Opacity: a fade in when the arrow starts, and a fade out and back while its target is hidden.
  const fadeTo = (a, now, age) => {
    const mode = a.o.mode;
    const dt = now - (a.last || now);
    a.last = now;
    const want = a.visible ? 1 : 0;
    a.shownA = mode === 'off' ? want : a.shownA + (want - a.shownA) * Math.min(1, dt / 120);
    const enter = mode === 'off' ? 1 : Math.min(1, age / (mode === 'full' ? 180 : FADE_MS));
    a.g.style.opacity = String(a.shownA * (mode === 'reduced' ? enter : 1));
    if (a.sign) a.sign.style.opacity = String(a.shownA * enter);
  };

  const draw = (a, now, placed) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const L = a.o.L;
    const r = rectOf(a);
    const f = focusOf(a, r);
    const age = now - a.born;
    a.visible = !a.lost && shown(a, r);
    if (!a.visible && a.geo) {
      // Out of sight, it fades where the reader last saw it rather than chase the hidden target.
      fadeTo(a, now, age);
      a.geo = { ...a.geo, target: r, hidden: true };
      return;
    }
    if (a.sign) { a.sw = a.sign.offsetWidth; a.sh = a.sign.offsetHeight; }
    a.pad = padFor(a, f.mark);
    const u = place(a, f, placed);
    const mode = a.o.mode;
    const g = geometry(a, f, u, !L.bob ? 0 : mode === 'full' ? L.bob + L.bob * Math.sin(age / 190) : L.bob);
    const sign = {
      ...g.sign,
      x: Math.round(clamp(g.sign.x, 8, W - g.sign.w - 8)),
      y: Math.round(clamp(g.sign.y, 8, H - g.sign.h - 8)),
    };
    g.sign = sign;
    if (a.sign && !loopRoom(a)) g.tail = exitOf(sign, g.tip, L.tailGap) || g.tail;
    if (a.sign && a.visible) placed.push(grow(sign, loopRoom(a)));
    const headLen0 = a.size.stroke * L.head;
    const { d, t, pts } = shaft(a, g, headLen0);
    a.pts = pts;
    for (const p of a.paths) p.setAttribute('d', d);
    const drawn = mode !== 'full' ? 1 : L.bob ? Math.min(1, age / L.drawMs) : ease(age / L.drawMs);
    const total = a.line.getTotalLength() + 2;
    for (const p of a.paths) {
      p.setAttribute('stroke-dasharray', String(total));
      p.setAttribute('stroke-dashoffset', String(total * (1 - drawn)));
    }
    const k = beatAt(a, age);
    const pulsing = mode === 'full' && k >= 0 && k < L.pulses;
    let hs = 1;
    if (mode === 'full') {
      const start = L.drawMs * 0.8;
      if (age < start) hs = 0;
      else if (k < 0) hs = L.bob ? spring(age - start, 0.2) : 0.6 + 0.4 * ease((age - start) / 220);
      else if (pulsing) hs = 1 + L.beat * (1 - Math.cos(k * Math.PI * 2));
    }
    const headLen = headLen0 * hs;
    const bx = g.tip.x - t.x * headLen;
    const by = g.tip.y - t.y * headLen;
    const wing = headLen * 0.62;
    const head = `M${g.tip.x},${g.tip.y} L${bx - t.y * wing},${by + t.x * wing} L${bx + t.y * wing},${by - t.x * wing} Z`;
    for (const h of a.heads) h.setAttribute('d', head);
    for (const h of a.heads) h.style.opacity = hs > 0 ? '1' : '0';
    if (a.halos.length && f.halo) {
      const h = f.halo;
      const round = a.o.highlight === 'ring' ? Math.min(h.w, h.h) / 2 + g.pad : a.o.corners === 'round' ? 6 : 0;
      for (const n of a.halos) {
        n.setAttribute('x', h.x - g.pad);
        n.setAttribute('y', h.y - g.pad);
        n.setAttribute('width', h.w + g.pad * 2);
        n.setAttribute('height', h.h + g.pad * 2);
        n.setAttribute('rx', round);
      }
      const glow = !pulsing ? 1 : L.bob ? 0.55 + 0.45 * Math.sin(age / 260) ** 2 : 1 - 0.15 * (1 - Math.cos(k * Math.PI * 2));
      a.halos[a.halos.length - 1].style.opacity = String(glow);
    }
    for (const n of a.halos) n.style.display = f.halo ? '' : 'none';
    fadeTo(a, now, age);
    if (a.sign) {
      const s = mode !== 'full' ? 1 : L.bob ? spring(age, 0.8) : 0.96 + 0.04 * ease(age / 200);
      a.sign.style.transform = `translate(${sign.x}px, ${sign.y}px)${s === 1 ? '' : ` scale(${s})`}`;
    }
    a.mark = f.mark;
    a.markBox = grow(f.mark, g.pad);
    a.geo = { target: r, tip: g.tip, tail: g.tail, sign: a.sign ? sign : null, from: a.dir, hidden: !a.visible };
  };

  const frame = (now) => {
    raf = 0;
    if (!arrows.size && !lenses.size) return;
    if (!host.isConnected) ensureHost();
    const placed = [];
    for (const [id, a] of [...arrows]) {
      if (a.o.follow && typeof a.target === 'string') {
        if (now - a.lastFollow > 250) {
          a.lastFollow = now;
          const el = lookup(a.target, a.o);
          a.lost = !el;
          if (el && el !== a.src.el) a.src = { kind: 'el', el };
        }
      } else if (a.src.kind === 'el' && !a.src.el.isConnected) {
        end(id, 'gone');
        continue;
      }
      draw(a, now, placed);
    }
    for (const [id, l] of [...lenses]) {
      if (!l.el.isConnected) { end(id, 'gone'); continue; }
      try { drawLens(l, now); } catch (e) { end(id, 'error', e); }
    }
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  const build = (id, target, opts) => {
    const o = normalise(opts);
    const L = o.L;
    const src = resolve(target, o);
    if (src.kind === 'rect' && !o.explicitMark) o.highlight = 'box';
    if (o.scroll && src.kind === 'el') src.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ensureHost();
    const size = L.sizes[o.size];
    const g = node('g', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' });
    const halos = [];
    const paths = [];
    const heads = [];
    if (o.highlight !== 'none') {
      halos.push(node('rect', { stroke: o.border === 'black' ? o.edgeColor : o.borderColor, 'stroke-width': o.border === 'black' ? L.halo + 2 : L.haloCasing }));
      halos.push(node('rect', { stroke: o.color, 'stroke-width': L.halo }));
    }
    if (o.border === 'white-black') {
      paths.push(node('path', { stroke: o.edgeColor, 'stroke-width': size.stroke + L.casing + 2 }));
      heads.push(node('path', { fill: o.edgeColor, stroke: o.edgeColor, 'stroke-width': L.headEdge + 3 }));
    }
    if (o.border === 'black') paths.push(node('path', { stroke: o.edgeColor, 'stroke-width': size.stroke + 2 }));
    else paths.push(node('path', { stroke: o.borderColor, 'stroke-width': size.stroke + L.casing }));
    const line = node('path', { stroke: o.color, 'stroke-width': size.stroke });
    paths.push(line);
    heads.push(node('path', o.border === 'black'
      ? { fill: o.color, stroke: o.edgeColor, 'stroke-width': L.headEdge - 1 }
      : { fill: o.color, stroke: o.borderColor, 'stroke-width': L.headEdge }));
    g.append(...halos, ...paths, ...heads);
    if (o.border === 'shadow') g.style.filter = L.shadow;
    let sign = null;
    if (o.text) {
      sign = makeSign(o, size);
      sign.style.opacity = '0';
      host.appendChild(sign);
    }
    const a = {
      id, target, src, o, size, g, halos, paths, line, heads, sign, born: performance.now(),
      sw: sign ? sign.offsetWidth : 0, sh: sign ? sign.offsetHeight : 0, dir: '', pad: 0, mark: null, pts: null,
      visible: true, shownA: 0, lost: false, lastFollow: 0, timer: 0, listeners: [], geo: null,
    };
    a.pad = padFor(a, { w: 0 });
    return a;
  };

  const create = (id, target, opts) => {
    const a = build(id, target, opts);
    const o = a.o;
    svg.appendChild(a.g);
    if (o.duration > 0) a.timer = setTimeout(() => end(id, 'timeout'), o.duration);
    const listen = (fn) => { window.addEventListener('click', fn, true); a.listeners.push(fn); };
    if (o.untilClick && a.src.kind === 'el') listen((e) => { if (within(e.target, a.src.el)) end(id, 'click'); });
    if (o.untilAnyClick) listen(() => end(id, 'any-click'));
    if (o.closeButton && a.sign) {
      listen((e) => {
        const s = a.sign.getBoundingClientRect();
        if (e.clientX >= s.left && e.clientX <= s.right && e.clientY >= s.top && e.clientY <= s.bottom) end(id, 'close');
      });
    }
    if (o.say) {
      const u = new SpeechSynthesisUtterance(o.plain);
      if (o.voiceObj) u.voice = o.voiceObj;
      speechSynthesis.speak(u);
    }
    arrows.set(id, a);
    kick();
  };

  // ---- cards ----

  const richText = (el, text) => {
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        el.appendChild(b);
      } else if (part) el.append(part);
    });
  };

  const makeCard = (id, opts) => {
    if (!opts || typeof opts !== 'object') throw fail('BAD_INPUT', `card options are an object; got ${String(opts)} on ${location.href}`);
    for (const k of Object.keys(opts)) {
      if (!(k in CARD_DEFAULTS)) throw fail('BAD_INPUT', `unknown card option ${k} on ${location.href}; known: ${Object.keys(CARD_DEFAULTS).join(', ')}`);
    }
    const o = { ...CARD_DEFAULTS, ...opts };
    if (!CARD_SIDES.includes(o.from)) throw fail('BAD_INPUT', `card from is ${CARD_SIDES.join(', ')}; got ${o.from} (on ${location.href})`);
    if (!Array.isArray(o.rows)) throw fail('BAD_INPUT', `card rows is an array; got ${String(o.rows)} on ${location.href}`);
    if (!o.title && !o.note && !o.rows.length) throw fail('BAD_INPUT', `a card needs a title, a note or rows (on ${location.href})`);
    if (!ENUMS.animate.includes(o.animate)) throw fail('BAD_INPUT', `card animate is auto, true, false or reduced; got ${o.animate} (on ${location.href})`);
    if (!ENUMS.look.includes(o.look)) throw fail('BAD_INPUT', `card look is ${ENUMS.look.join(' or ')}; got ${o.look} (on ${location.href})`);
    const color = parseColor(o.color, 'color', o.look);
    const children = [];
    try {
      o.rows.forEach((row, i) => {
        if (!row || typeof row !== 'object') throw fail('BAD_INPUT', `card row ${i} is an object; got ${String(row)} on ${location.href}`);
        if (row.point !== undefined) children.push(point(row.point, { text: row.text || '', color, group: o.group, look: o.look }));
      });
    } catch (e) {
      for (const c of children) end(c, 'stop');
      throw e;
    }
    ensureHost();
    const card = document.createElement('div');
    const [vert, horiz] = o.from.includes('-') ? o.from.split('-') : [o.from, 'centre'];
    const x = horiz === 'left' ? 'left:16px;' : horiz === 'right' ? 'right:16px;' : 'left:50%;margin-left:-160px;';
    const calm = o.look === 'calm';
    card.style.cssText = `position:absolute;${vert}:16px;${x}width:320px;box-sizing:border-box;border-radius:${calm ? 10 : 12}px;background:#fff;color:${DARK};${calm
      ? `padding:12px 14px 14px;border-top:3px solid ${color};box-shadow:0 0 0 1px rgba(0,0,0,.07),0 4px 14px rgba(0,0,0,.14);font:14px/1.45 ${FONT};`
      : `padding:14px 16px 16px;border-top:6px solid ${color};box-shadow:0 0 0 1px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.28);font:14px/1.4 ${FONT};`}`;
    const add = (tag, css, text) => {
      const n = document.createElement(tag);
      n.style.cssText = css;
      if (text !== undefined) richText(n, String(text));
      return n;
    };
    if (o.title) card.appendChild(add('div', calm ? 'font-weight:600;font-size:15px;margin-bottom:2px;' : 'font-weight:700;font-size:16px;margin-bottom:4px;', o.title));
    if (o.note) card.appendChild(add('div', 'color:#55555c;font-size:13px;margin-bottom:8px;', o.note));
    o.rows.forEach((row, i) => {
      const line = add('div', 'display:flex;align-items:center;gap:8px;margin-top:8px;');
      if (Array.isArray(row.checklist)) {
        const list = add('div', 'display:flex;flex-direction:column;gap:6px;width:100%;');
        for (const item of row.checklist) {
          const it = add('div', 'display:flex;align-items:center;gap:8px;');
          const box = add('span', `flex:none;width:16px;height:16px;border-radius:4px;border:2px solid ${color};background:${item.done ? color : '#fff'};display:flex;align-items:center;justify-content:center;`);
          if (item.done) box.appendChild(glyph(['M5 12l5 5L19 7'], '#fff', 12));
          it.append(box, add('span', item.done ? 'color:#55555c;' : '', item.label || ''));
          list.appendChild(it);
        }
        line.appendChild(list);
      } else if (row.progress !== undefined) {
        if (!(Number.isFinite(row.progress) && row.progress >= 0 && row.progress <= 1)) throw fail('BAD_INPUT', `card row ${i} progress is 0..1; got ${row.progress} (on ${location.href})`);
        const wrap = add('div', 'width:100%;');
        wrap.appendChild(add('div', 'display:flex;justify-content:space-between;font-size:13px;color:#55555c;', `${row.label || ''}`));
        wrap.firstChild.appendChild(add('span', '', `${Math.round(row.progress * 100)}%`));
        const bar = add('div', 'height:8px;border-radius:4px;background:#e8e8ec;margin-top:4px;overflow:hidden;');
        bar.appendChild(add('div', `height:100%;width:${row.progress * 100}%;background:${color};`));
        wrap.appendChild(bar);
        line.appendChild(wrap);
      } else {
        if (row.label) line.appendChild(add('span', 'flex:none;min-width:80px;color:#55555c;font-size:13px;', row.label));
        if (row.value !== undefined) {
          const shown = row.secret ? '•'.repeat(Math.min(12, Math.max(6, String(row.value).length))) : String(row.value);
          const mono = row.code || row.secret;
          const v = add('span', `flex:1;min-width:0;overflow-wrap:anywhere;padding:3px 8px;border-radius:6px;background:#f1f1f4;${mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' : 'font-weight:600;'}`);
          v.textContent = shown;
          line.appendChild(v);
        } else if (!row.label && row.point === undefined) {
          throw fail('BAD_INPUT', `card row ${i} needs label, value, progress, checklist or point (on ${location.href})`);
        }
      }
      if (line.childNodes.length) card.appendChild(line);
    });
    const mode = motion(o.animate);
    host.appendChild(card);
    if (mode !== 'off') {
      card.animate(mode === 'full'
        ? [{ opacity: 0, transform: `translateY(${(vert === 'top' ? -1 : 1) * (calm ? 6 : 10)}px)` }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0 }, { opacity: 1 }], { duration: calm ? 200 : 220, easing: 'ease-out' });
    }
    const c = { id, el: card, o: { ...o, mode }, children, timer: 0 };
    if (o.duration > 0) c.timer = setTimeout(() => end(id, 'timeout'), o.duration);
    cards.set(id, c);
  };

  // ---- magnifier ----

  const MAG_DEFAULTS = { text: '', scale: 3, color: 'red', from: 'auto', duration: 0, untilBlur: false, group: '', animate: 'auto', look: 'calm' };
  const NOT_TEXT = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden'];
  const isField = (el) => el.localName === 'textarea' || el.isContentEditable || (el.localName === 'input' && !NOT_TEXT.includes(el.type));

  const makeLens = (id, target, opts) => {
    if (!opts || typeof opts !== 'object') throw fail('BAD_INPUT', `magnify options are an object; got ${String(opts)} on ${location.href}`);
    for (const k of Object.keys(opts)) {
      if (!(k in MAG_DEFAULTS)) throw fail('BAD_INPUT', `unknown magnify option ${k} on ${location.href}; known: ${Object.keys(MAG_DEFAULTS).join(', ')}`);
    }
    const o = { ...MAG_DEFAULTS, ...opts };
    if (!(Number.isFinite(o.scale) && o.scale >= 1.5 && o.scale <= 6)) throw fail('BAD_INPUT', `magnify scale is 1.5 to 6; got ${o.scale} (on ${location.href})`);
    if (!['auto', 'top', 'bottom'].includes(o.from)) throw fail('BAD_INPUT', `magnify from is auto, top or bottom; got ${o.from} (on ${location.href})`);
    if (!(Number.isFinite(o.duration) && o.duration >= 0)) throw fail('BAD_INPUT', `duration is ms >= 0; got ${o.duration} (on ${location.href})`);
    if (!ENUMS.animate.includes(o.animate)) throw fail('BAD_INPUT', `magnify animate is auto, true, false or reduced; got ${o.animate} (on ${location.href})`);
    if (!ENUMS.look.includes(o.look)) throw fail('BAD_INPUT', `magnify look is ${ENUMS.look.join(' or ')}; got ${o.look} (on ${location.href})`);
    if (typeof o.text !== 'string') throw fail('BAD_INPUT', `magnify text is a string; got ${String(o.text)} on ${location.href}`);
    o.color = parseColor(o.color, 'color', o.look);
    o.mode = motion(o.animate);
    const src = resolve(target, { role: '' });
    if (src.kind !== 'el' || !isField(src.el)) {
      const what = src.kind === 'el' ? `<${src.el.localName}${src.el.type ? ` type=${src.el.type}` : ''}>` : `a ${src.kind}`;
      throw fail('BAD_INPUT', `magnify needs a text field (input, textarea or contenteditable); ${String(target)} on ${location.href} is ${what}`);
    }
    ensureHost();
    const el = src.el;
    const panel = document.createElement('div');
    const calm = o.look === 'calm';
    panel.style.cssText = `position:absolute;left:0;top:0;box-sizing:border-box;padding:10px 12px 12px;border-radius:${calm ? 10 : 12}px;background:#fff;border:${calm ? 2 : 3}px solid ${o.color};box-shadow:${calm ? '0 4px 14px rgba(0,0,0,.16)' : '0 8px 24px rgba(0,0,0,.3)'};opacity:0;transform-origin:50% 0;`;
    if (o.text) {
      const caption = document.createElement('div');
      caption.style.cssText = `margin:-2px 0 6px;color:${o.color};font:${calm ? 600 : 700} 13px/1.3 ${FONT};`;
      caption.textContent = o.text;
      panel.appendChild(caption);
    }
    const field = document.createElement('div');
    field.style.cssText = 'position:relative;overflow:hidden;box-sizing:border-box;border:1px solid #b8b8c0;border-radius:6px;padding:0.25em 0.45em;line-height:1.3;';
    const line = document.createElement('div');
    line.style.whiteSpace = el.localName === 'input' ? 'pre' : 'pre-wrap';
    field.appendChild(line);
    panel.appendChild(field);
    host.appendChild(panel);
    const g = node('g', { fill: 'none' });
    const beam = node('path', calm
      ? { fill: o.color, 'fill-opacity': 0.07, stroke: o.color, 'stroke-opacity': 0.4, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }
      : { fill: o.color, 'fill-opacity': 0.12, stroke: o.color, 'stroke-opacity': 0.55, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    const ring = node('rect', { stroke: o.color, 'stroke-width': calm ? 2 : 3, rx: 6 });
    g.append(beam, ring);
    svg.appendChild(g);
    const l = { id, el, o, panel, field, line, g, beam, ring, born: performance.now(), key: '', timer: 0, off: null, geo: null };
    if (o.duration > 0) l.timer = setTimeout(() => end(id, 'timeout'), o.duration);
    if (o.untilBlur) {
      const onBlur = () => end(id, 'blur');
      el.addEventListener('blur', onBlur);
      l.off = () => el.removeEventListener('blur', onBlur);
    }
    lenses.set(id, l);
    kick();
  };

  // Copies the field's text, placeholder and caret into the panel when any of them change,
  // then places the panel below the field (or above, when it does not fit) with a beam between.
  const drawLens = (l, now) => {
    const { el, o, panel, field, line } = l;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const raw = el.isContentEditable ? el.innerText : el.value;
    const value = el.type === 'password' ? '•'.repeat(raw.length) : raw;
    const focused = el.getRootNode().activeElement === el;
    const caretAt = el.isContentEditable || typeof el.selectionEnd !== 'number' ? value.length : el.selectionEnd;
    const pw = Math.min(W - 32, Math.max(320, r.width * o.scale + 30));
    const key = [value, caretAt, focused, pw, el.placeholder, cs.fontSize].join('|');
    if (key !== l.key) {
      l.key = key;
      const bg = cs.backgroundColor;
      field.style.font = `${cs.fontStyle} ${cs.fontWeight} ${(parseFloat(cs.fontSize) || 15) * o.scale}px/1.3 ${cs.fontFamily}`;
      field.style.color = cs.color;
      field.style.background = !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' ? '#fff' : bg;
      field.style.maxHeight = el.localName === 'input' ? '' : `calc(3.9em + 0.5em + 2px)`;
      line.textContent = '';
      const caret = document.createElement('span');
      caret.style.cssText = `display:inline-block;width:${Math.max(2, o.scale)}px;height:1.15em;margin:0 -1px;vertical-align:-0.2em;background:${o.color};visibility:${focused ? 'visible' : 'hidden'};`;
      if (!value && el.placeholder) {
        const ph = document.createElement('span');
        ph.style.color = '#9a9aa2';
        ph.textContent = el.placeholder;
        line.append(caret, ph);
      } else {
        line.append(value.slice(0, caretAt), caret, value.slice(caretAt));
      }
      if (focused && o.mode === 'full') caret.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 530, iterations: Infinity, direction: 'alternate', easing: 'steps(1, end)', delay: 530 });
      panel.style.width = `${pw}px`;
      if (el.localName === 'input') field.scrollLeft = Math.max(0, caret.offsetLeft - field.clientWidth + caret.offsetWidth * 4 + 24);
      else field.scrollTop = Math.max(0, caret.offsetTop + caret.offsetHeight - field.clientHeight + 8);
    }
    const ph = panel.offsetHeight;
    const gap = 28;
    const below = r.bottom + gap + ph <= H - 8;
    const above = r.top - gap - ph >= 8;
    const side = o.from === 'top' ? (above || !below ? 'top' : 'bottom') : (below || !above ? 'bottom' : 'top');
    const x = Math.round(clamp(r.left + r.width / 2 - pw / 2, 16, W - pw - 16));
    const y = Math.round(side === 'bottom' ? Math.min(r.bottom + gap, H - ph - 8) : Math.max(r.top - gap - ph, 8));
    const age = now - l.born;
    const s = o.mode !== 'full' ? 1 : o.look === 'bold' ? spring(age, 0.85) : 0.97 + 0.03 * ease(age / 200);
    panel.style.transformOrigin = side === 'bottom' ? '50% 0' : '50% 100%';
    panel.style.transform = `translate(${x}px, ${y}px)${s === 1 ? '' : ` scale(${s})`}`;
    const inView = r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
    const fade = o.mode === 'off' ? 1 : Math.min(1, age / 180);
    panel.style.opacity = String(inView ? fade : 0);
    l.g.style.opacity = String(inView ? fade : 0);
    for (const [k, v] of Object.entries({ x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 })) l.ring.setAttribute(k, v);
    const fy = side === 'bottom' ? r.bottom + 4 : r.top - 4;
    const py = side === 'bottom' ? y : y + ph;
    l.beam.setAttribute('d', `M${r.left - 4},${fy} L${r.right + 4},${fy} L${x + pw - 12},${py} L${x + 12},${py} Z`);
    l.geo = { target: { x: r.left, y: r.top, w: r.width, h: r.height }, panel: { x, y, w: pw, h: ph }, from: side, hidden: !inView, shown: value };
  };

  // ---- the API ----

  const fadeOut = (els, mode) => {
    if (mode === 'off') { for (const e of els) e.remove(); return; }
    for (const e of els) e.style.transition = `opacity ${FADE_MS}ms ease-out`;
    for (const e of els) e.style.opacity = '0';
    setTimeout(() => { for (const e of els) e.remove(); }, FADE_MS + 20);
  };

  // Ends an arrow, card or magnifier. With an error, it logs it and rejects wait(id) instead.
  const end = (id, reason, error) => {
    const a = arrows.get(id);
    const c = cards.get(id);
    const l = lenses.get(id);
    if (pending.has(id)) pending.delete(id);
    else if (!a && !c && !l) return false;
    if (a) {
      arrows.delete(id);
      clearTimeout(a.timer);
      for (const fn of a.listeners) window.removeEventListener('click', fn, true);
      fadeOut(a.sign ? [a.g, a.sign] : [a.g], a.o.mode);
    }
    if (c) {
      cards.delete(id);
      clearTimeout(c.timer);
      for (const child of c.children) end(child, reason);
      fadeOut([c.el], c.o.mode);
    }
    if (l) {
      lenses.delete(id);
      clearTimeout(l.timer);
      if (l.off) l.off();
      fadeOut([l.panel, l.g], l.o.mode);
    }
    if (error) {
      console.debug(`walkArrow: ${id} on ${location.href} stopped by an error`, error);
      result(id).reject(error);
    } else result(id).resolve({ id, reason });
    return true;
  };

  const live = () => [...pending, ...arrows.keys(), ...cards.keys(), ...lenses.keys()].sort((x, y) => x - y);

  const point = (target, opts = {}) => {
    const id = nextId++;
    result(id);
    if (document.documentElement) create(id, target, opts);
    else whenReady(id, typeof target === 'string', () => create(id, target, opts));
    return id;
  };

  const magnify = (target, opts = {}) => {
    const id = nextId++;
    result(id);
    if (document.documentElement) makeLens(id, target, opts);
    else whenReady(id, typeof target === 'string', () => makeLens(id, target, opts));
    return id;
  };

  const card = (opts = {}) => {
    const id = nextId++;
    result(id);
    if (document.documentElement) makeCard(id, opts);
    else whenReady(id, (opts.rows || []).some((r) => r && typeof r.point === 'string'), () => makeCard(id, opts));
    return id;
  };

  const stop = (which) => {
    let ids;
    if (which === undefined) ids = live();
    else if (which === 'last') ids = live().slice(-1);
    else if (typeof which === 'number') ids = [which];
    else if (which && typeof which === 'object' && typeof which.group === 'string') {
      ids = [...arrows.values(), ...cards.values(), ...lenses.values()].filter((x) => x.o.group === which.group).map((x) => x.id);
    } else throw fail('BAD_INPUT', `stop takes nothing, an id, 'last' or { group }; got ${String(which)} on ${location.href}`);
    return ids.filter((id) => end(id, 'stop')).length;
  };

  const wait = (id) => {
    const r = results.get(id);
    if (!r) return Promise.reject(fail('NOT_FOUND', `no arrow or card ${id} on ${location.href}; live: ${live().join(', ') || 'none'}`));
    return r.promise;
  };

  const round = (v) => (v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' ? Math.round(x) : round(x)]))
    : v);

  const info = (id) => {
    const l = lenses.get(id);
    if (l) {
      if (!l.geo) drawLens(l, performance.now());
      return round({ id, ...l.geo });
    }
    const a = arrows.get(id);
    if (!a) throw fail('NOT_FOUND', `no live arrow ${id} on ${location.href}; live: ${live().join(', ') || 'none'}`);
    if (!a.geo) draw(a, performance.now(), []);
    return round({ id, ...a.geo });
  };

  const plan = (target, opts = {}) => {
    const a = build(0, target, opts);
    try {
      if (a.sign) a.sign.style.visibility = 'hidden';
      const r = rectOf(a);
      const f = focusOf(a, r);
      const placed = [...arrows.values()].filter((x) => x.geo && x.geo.sign).map((x) => grow(x.geo.sign, loopRoom(x)));
      const u = place(a, f, placed);
      const g = geometry(a, f, u, a.o.L.bob);
      const W = window.innerWidth;
      const H = window.innerHeight;
      const sign = a.sign ? { ...g.sign, x: clamp(g.sign.x, 8, W - g.sign.w - 8), y: clamp(g.sign.y, 8, H - g.sign.h - 8) } : null;
      if (sign && !loopRoom(a)) g.tail = exitOf(sign, g.tip, a.o.L.tailGap) || g.tail;
      return round({ target: r, tip: g.tip, tail: g.tail, sign, from: a.dir, hidden: !shown(a, r) });
    } finally {
      if (a.sign) a.sign.remove();
    }
  };

  const elements = (opts = {}) => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(CANDIDATES)) {
      const role = roleOf(el);
      if (!role || (opts.role && role !== opts.role)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
      const label = norm(el.getAttribute('aria-label')) || labelsOf(el)[0];
      if (!label || label.length > 80 || seen.has(`${role}|${label}`)) continue;
      seen.add(`${role}|${label}`);
      out.push(round({ target: `text=${label}`, label, role, x: r.left, y: r.top, w: r.width, h: r.height }));
    }
    return out;
  };

  const doctor = () => ({
    href: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    readyState: document.readyState,
    reducedMotion: !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
    speech: !!window.speechSynthesis,
    voices: window.speechSynthesis ? speechSynthesis.getVoices().length : 0,
    pointer,
    arrows: [...arrows.keys()],
    cards: [...cards.keys()],
    lenses: [...lenses.keys()],
    pending: [...pending],
  });

  const demo = async () => {
    const pick = [...document.querySelectorAll('button, a[href], input, [role=button]')]
      .find((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && r.top >= 0 && r.bottom <= window.innerHeight; });
    const target = pick || 'viewport';
    const steps = [
      [target, { text: 'An arrow with a sign', style: 'arrow', duration: 2200 }],
      [pointer ? 'mouse' : target, { text: 'A ring', style: 'ring', shape: 'straight', color: 'blue', duration: 2200 }],
      [target, { text: 'A box', style: 'box', corners: 'sharp', color: 'green', duration: 2200 }],
    ];
    for (const [t, o] of steps) await wait(point(t, o));
  };

  window.walkArrow = { point, card, magnify, stop, wait, active: live, info, plan, elements, doctor, demo, version: 2 };
})();
