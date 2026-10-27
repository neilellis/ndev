// This film's own animation, beyond the data-* cues the runtime reads.
// Add to Film.tl with times from Film.at(), or push a renderer: Film.renderers.push((t) => { ... }).
// Never use timers, Date.now(), Math.random() or CSS transitions: every frame must depend only on t.
(() => {
  const { tl, T } = window.Film;
  // Example: a slow push-in on scene 0's picture.
  tl.fromTo("#s0 .picture", { scale: 1 }, { scale: 1.04, duration: T.scenes[0].duration, ease: "none" }, T.scenes[0].start);
})();
