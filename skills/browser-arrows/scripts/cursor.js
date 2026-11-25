// Draws an oversized red cursor, a click pulse and a fading red trail over every page,
// so a recorded video shows where each move and click happens. Injected as a Playwright
// init script; it reruns for each document. The overlay ignores pointer events and is
// hidden from assistive technology, so the page and its accessibility snapshot do not change.
(() => {
  if (window.__walkCursor) return;
  window.__walkCursor = true;
  const RED = '#ff1a1a';
  const TRAIL_MS = 600;
  const PULSE_MS = 300; // a brief mark; the walkArrow before the click shows where it goes
  const PULSE_KEY = '__walkCursorPulse';
  const STEP_PX = 6;
  const TOP = '2147483647';

  const start = () => {
    const root = document.documentElement;
    if (!root) return false;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('role', 'presentation');
    host.style.cssText = `position:fixed;inset:0;margin:0;padding:0;border:0;pointer-events:none;z-index:${TOP};contain:strict;`;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    const ctx = canvas.getContext('2d');

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '40');
    svg.setAttribute('height', '40');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.cssText = 'position:absolute;left:0;top:0;display:none;overflow:visible;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:transform;';
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M2 1 L2 19 L6.6 14.8 L9.8 22 L13 20.6 L9.9 13.6 L16 13.4 Z');
    arrow.setAttribute('fill', RED);
    arrow.setAttribute('stroke', '#ffffff');
    arrow.setAttribute('stroke-width', '1.2');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);

    host.append(canvas, svg);
    root.appendChild(host);

    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    let last = null;
    const trail = []; // {x, y, t}
    const pulses = []; // {x, y, t}
    // A click that opens a page restarts this script; finish its pulse on the new page.
    try {
      const saved = JSON.parse(sessionStorage.getItem(PULSE_KEY) || 'null');
      const age = saved ? Date.now() - saved.at : PULSE_MS;
      if (age < PULSE_MS) pulses.push({ x: saved.x, y: saved.y, t: performance.now() - age });
    } catch (error) {
      console.debug('walk cursor: no saved click pulse', error);
    }
    const addMove = (x, y) => {
      const now = performance.now();
      if (last) {
        const dx = x - last.x, dy = y - last.y;
        const n = Math.min(200, Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP_PX)));
        for (let i = 1; i <= n; i++) {
          trail.push({ x: last.x + (dx * i) / n, y: last.y + (dy * i) / n, t: now });
        }
      } else {
        trail.push({ x, y, t: now });
      }
      last = { x, y };
      svg.style.display = 'block';
      svg.style.transform = `translate(${x - 2}px, ${y - 1}px)`;
    };

    const onMove = (e) => addMove(e.clientX, e.clientY);
    const opts = { capture: true, passive: true };
    // A scroll moves the page under the last point, so a trail from it would cross content the
    // cursor never passed. A click on a target out of view scrolls first, then jumps the mouse.
    window.addEventListener('scroll', () => { last = null; }, opts);
    window.addEventListener('mousemove', onMove, opts);
    window.addEventListener('pointermove', onMove, opts);
    // A still shows the product alone: park() hides the pointer and its marks over the content
    // until the mouse moves again.
    window.walkCursor = {
      park() {
        last = null;
        trail.length = 0;
        pulses.length = 0;
        svg.style.display = 'none';
      },
    };
    window.addEventListener('mousedown', (e) => {
      addMove(e.clientX, e.clientY);
      pulses.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      try {
        sessionStorage.setItem(PULSE_KEY, JSON.stringify({ x: e.clientX, y: e.clientY, at: Date.now() }));
      } catch (error) {
        console.debug('walk cursor: click pulse not kept across pages', error);
      }
    }, opts);

    const frame = (now) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();
      ctx.lineCap = 'round';
      ctx.fillStyle = RED;
      for (const p of trail) {
        const a = 1 - (now - p.t) / TRAIL_MS;
        ctx.globalAlpha = Math.max(0, a) * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + 5 * a, 0, Math.PI * 2);
        ctx.fill();
      }
      while (pulses.length && now - pulses[0].t > PULSE_MS) pulses.shift();
      for (const p of pulses) {
        const k = (now - p.t) / PULSE_MS;
        // A filled dot marks the spot, and two rings spread from it, the second a beat later.
        ctx.globalAlpha = 0.45 * (1 - k);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = RED;
        for (const delay of [0, 0.3]) {
          const r = (k - delay) / (1 - delay);
          if (r <= 0) continue;
          ctx.globalAlpha = 1 - r;
          ctx.lineWidth = 6 * (1 - r) + 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 10 + 50 * r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return true;
  };

  if (!start()) {
    new MutationObserver((_, obs) => { if (start()) obs.disconnect(); })
      .observe(document, { childList: true });
  }
})();
