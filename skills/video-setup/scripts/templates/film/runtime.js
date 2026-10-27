// The kit's film runtime. Every visual is a pure function of time, so any frame can be rendered at any t.
// It reads window.TIMELINE, builds a paused GSAP timeline from the page's data-* cues and the captions,
// and provides window.seek(t) and window.ready, which the kit's renderer uses.
// A project's own film.js runs after this file and may add to Film.tl or push a function onto
// Film.renderers; each renderer is called with t on every seek.
(() => {
  const T = window.TIMELINE;
  if (!T) throw new Error("window.TIMELINE is missing; build the timeline with node scripts/video-kit/timeline.mjs");
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (v) => 1 - Math.pow(1 - clamp(v), 3);
  const FADE = 0.55;

  // "s+0.3" = scene start + 0.3 s; "w:4:maps+0.2" = when the narrator says "maps" in scene 4.
  function at(spec, sceneIndex) {
    const scene = T.scenes[sceneIndex];
    let m = spec.match(/^s\+([\d.]+)$/);
    if (m) return scene.start + Number(m[1]);
    m = spec.match(/^w:(\d+):([a-z0-9-]+)(?:\+([\d.]+))?$/);
    if (m) {
      const w = T.words.find((x) => x.scene === Number(m[1]) && x.word === m[2]);
      if (!w) throw new Error(`No word "${m[2]}" in scene ${m[1]}`);
      return w.start + Number(m[3] || 0);
    }
    throw new Error(`Bad time spec: ${spec}`);
  }

  const tl = gsap.timeline({ paused: true });
  const scenes = $$(".scene");
  if (scenes.length !== T.scenes.length) throw new Error(`The page has ${scenes.length} scenes but the timeline has ${T.scenes.length}`);
  const post = $("#credits");
  const hasCredits = T.credits && T.credits.duration > 0;
  if (post && !hasCredits) throw new Error("The page has a credits page but the timeline gives it no time (creditsHold is 0)");
  const end = hasCredits ? T.credits.start : T.total;

  scenes.forEach((el, i) => {
    const s = T.scenes[i];
    el.style.zIndex = String(i + 1);
    tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: i === 0 ? 0.4 : FADE, ease: "power1.inOut" }, s.start);
    if (i < scenes.length - 1) tl.set(el, { opacity: 0 }, T.scenes[i + 1].start + FADE + 0.05);
    else if (hasCredits) tl.set(el, { opacity: 0 }, T.credits.start + FADE + 0.05);
    // The last scene holds until the credits page or the end, so its photo keeps drifting.
    const visible = i < scenes.length - 1 ? s.duration + FADE : end + FADE - s.start;

    $$("[data-kb]", el).forEach((img) => {
      const [a, b] = img.dataset.kb.split(" ").map(Number);
      tl.fromTo(img, { scale: a }, { scale: b, duration: visible, ease: "none" }, s.start);
    });
    $$("[data-in]", el).forEach((node) => {
      const isImg = node.tagName === "IMG";
      tl.fromTo(node, { opacity: 0, y: isImg ? 18 : 42 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, at(node.dataset.in, i));
    });
    $$("[data-shot]", el).forEach((node) => {
      tl.fromTo(node, { opacity: 0, scale: 1.035, y: 24 }, { opacity: 1, scale: 1, y: 0, duration: 0.8, ease: "power2.out" }, at(node.dataset.shot, i));
    });
    $$("[data-bar]", el).forEach((node) => {
      const [spec, pct] = node.dataset.bar.split(" ");
      tl.fromTo(node, { width: "0%" }, { width: `${Number(pct) * 100}%`, duration: 0.9, ease: "power2.out" }, at(spec, i) + 0.15);
    });
  });

  if (post) {
    post.style.zIndex = String(scenes.length + 1);
    tl.fromTo(post, { opacity: 0 }, { opacity: 1, duration: FADE, ease: "power1.inOut" }, T.credits.start);
    tl.to(post, { opacity: 0, duration: 0.6 }, T.total - 0.6);
    $$("[data-in]", post).forEach((node) => {
      const m = node.dataset.in.match(/^c\+([\d.]+)$/);
      if (!m) throw new Error(`Credits cues must be c+X, got ${node.dataset.in}`);
      tl.fromTo(node, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, T.credits.start + Number(m[1]));
    });
  }

  const capBox = $("#captions");
  if (!capBox) throw new Error('The page needs a <div id="captions"> for the burned-in captions');
  T.captions.forEach((c) => {
    const d = document.createElement("div");
    d.className = "cap";
    d.textContent = c.text;
    capBox.appendChild(d);
    tl.fromTo(d, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.12, ease: "power1.out" }, c.start);
    tl.to(d, { opacity: 0, duration: 0.12 }, c.end - 0.04);
  });

  const renderers = [];
  window.Film = { T, tl, at, $, $$, clamp, ease, renderers };
  window.seek = (t) => {
    tl.time(t, false);
    for (const r of renderers) r(t);
  };

  // Resolves once every font and image has loaded; rejects with the failed file's name.
  window.ready = Promise.all([
    document.fonts.ready,
    ...$$("img").map((im) => im.decode().catch(() => { throw new Error(`Image failed: ${im.src}`); })),
  ]).then(() => { window.seek(0); return true; });

  // Preview in a normal browser: ?t=12 freezes a frame, ?play plays in real time.
  const q = new URLSearchParams(location.search);
  if (q.has("t")) window.ready.then(() => window.seek(Number(q.get("t"))));
  if (q.has("play")) window.ready.then(() => { const t0 = performance.now(); const loop = () => { window.seek((performance.now() - t0) / 1000); requestAnimationFrame(loop); }; loop(); });
})();
