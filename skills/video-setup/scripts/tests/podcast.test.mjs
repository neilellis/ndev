// Tests for the podcast effect's humanising step. They need ffmpeg-static where the engine can
// import it: link a node_modules folder with the engine's packages at scripts/node_modules.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
let engine = null;
try {
  engine = await import("../engine/podcast.mjs");
} catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
const skip = !engine && "ffmpeg-static cannot be imported from engine/; link a node_modules folder with the engine's packages at scripts/node_modules";
const { RATE = 44100, PAUSE_JITTER, SPEECH_JITTER, findPauses, plan, mapTime, humanise, rng } = engine ?? {};

// Tone and silence in turn: 0.3 s speech, 0.2 s pause, 0.3 s speech, 0.1 s pause, 0.3 s speech, 0.2 s tail.
const layout = [["tone", 0.3], ["quiet", 0.2], ["tone", 0.3], ["quiet", 0.1], ["tone", 0.3], ["quiet", 0.2]];
function clip() {
  const out = new Int16Array(Math.round(layout.reduce((n, [, d]) => n + d, 0) * RATE));
  let at = 0;
  for (const [kind, d] of layout) {
    const n = Math.round(d * RATE);
    if (kind === "tone") for (let i = 0; i < n; i++) out[at + i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    at += n;
  }
  return out;
}
const near = (a, b, tol = 0.006) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

describe("podcast effect", { skip }, () => {
  it("finds the pauses between words but not the trailing silence", () => {
    const pauses = findPauses(clip()).map(([s, e]) => [s / RATE, e / RATE]);
    assert.equal(pauses.length, 2);
    near(pauses[0][0], 0.3); near(pauses[0][1], 0.5);
    near(pauses[1][0], 0.8); near(pauses[1][1], 0.9);
  });

  it("keeps every change within its range, over many seeds", () => {
    for (let k = 0; k < 200; k++) {
      for (const p of plan(clip(), rng(`seed ${k}`))) {
        const change = p.kind === "pause" ? p.scale : p.tempo;
        const range = p.kind === "pause" ? PAUSE_JITTER : SPEECH_JITTER;
        assert.ok(Math.abs(change - 1) <= range, `${p.kind} changed by ${change}`);
      }
    }
  });

  it("gives the same result for the same seed and a different one for another", () => {
    const a = plan(clip(), rng("tabitha 0")), b = plan(clip(), rng("tabitha 0")), c = plan(clip(), rng("gareth 0"));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });

  it("maps word times onto the humanised clip", () => {
    const { samples, pieces } = humanise(clip(), "tabitha 1");
    assert.equal(samples.length, pieces.reduce((n, p) => n + p.length, 0));
    assert.equal(mapTime(pieces, 0), 0);
    near(mapTime(pieces, 0.3), pieces[1].at / RATE, 1 / RATE);
    near(mapTime(pieces, 1.4), samples.length / RATE, 1 / RATE);
    let last = -1;
    for (let t = 0; t <= 1.4; t += 0.01) {
      const m = mapTime(pieces, t);
      assert.ok(m >= last, `time went backwards at ${t}`);
      last = m;
    }
  });

  it("puts the speech where the plan says, with the pauses still quiet", () => {
    const { samples, pieces } = humanise(clip(), "gareth 2");
    for (const p of pieces.filter((q) => q.kind === "pause")) {
      const mid = samples.subarray(p.at + 300, p.at + p.length - 300);
      assert.ok(mid.every((v) => v === 0), "a pause contains sound");
    }
    const speech = pieces[0];
    const middle = samples.subarray(speech.at + 600, speech.at + speech.length - 600);
    assert.ok(middle.some((v) => Math.abs(v) > 4000), "speech went missing");
  });
});
