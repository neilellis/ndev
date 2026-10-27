// The podcast effect: makes the synthetic voices sound like a person recorded on a podcast mic.
// 1. Humanise each clip: every pause inside it is randomly lengthened or shortened by up to
//    PAUSE_JITTER, and every run of words between pauses is sped up or slowed down by up to
//    SPEECH_JITTER at the same pitch. Each edited piece fades in and out over FADE so no cut clicks.
// 2. When the narration is mixed, ROOM_TONE lays a faint drifting brown noise under the voice,
//    then PODCAST treats the whole track like a close-miked podcast recording.
// The randomness is seeded from the voice, the scene and its text, so every build is identical.
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

export const RATE = 48000;
export const PAUSE_JITTER = 0.2;
export const SPEECH_JITTER = 0.1;
export const FADE = 0.006; // seconds
// A pause is a stretch quieter than SILENCE_DB lasting at least MIN_PAUSE seconds.
export const SILENCE_DB = -45;
export const MIN_PAUSE = 0.045;

// Trim rumble, add warmth, cut boxiness, lift presence, soften sibilance, then compress.
export const PODCAST = [
  "highpass=f=95",
  "equalizer=f=150:t=q:w=0.9:g=6.5",
  "equalizer=f=380:t=q:w=1.1:g=-6",
  "equalizer=f=3000:t=q:w=1.3:g=5.5",
  "highshelf=f=8500:g=-3.5",
  "deesser=i=0.6",
  "acompressor=threshold=-26dB:ratio=6:attack=5:release=100:makeup=7",
].join(",");
// Then the track is levelled to TARGET_LUFS with one fixed gain, measured over the whole track
// first, so the room tone in the long silent end is never pumped up.
export const TARGET_LUFS = -16;
export const LOUDNESS = `I=${TARGET_LUFS}:TP=-1.5:LRA=11`;
// Brown noise about 56 dB below the voice once PODCAST has run, so the pauses are never digitally
// silent. Its level drifts on three unrelated slow waves.
export const ROOM_TONE =
  "anoisesrc=color=brown:amplitude=0.0019:seed=7:sample_rate=48000,highpass=f=40," +
  "volume='0.55+0.25*sin(2*PI*t*0.071)+0.15*sin(2*PI*t*0.23+1.7)+0.05*sin(2*PI*t*0.61+0.4)':eval=frame";

export function rng(text) {
  let seed = 0;
  for (const c of text) seed = (Math.imul(seed, 31) + c.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The pauses inside a clip, as [start, end] sample indices. Silence at the very start and end is
// not a pause between words, so it is left alone.
export function findPauses(samples) {
  const win = Math.round(RATE * 0.005), limit = 32768 * 10 ** (SILENCE_DB / 20), min = Math.round(RATE * MIN_PAUSE);
  const runs = [];
  let from = -1;
  for (let i = 0; i < samples.length; i += win) {
    let e = 0;
    const end = Math.min(i + win, samples.length);
    for (let j = i; j < end; j++) e += samples[j] * samples[j];
    const quiet = Math.sqrt(e / (end - i)) < limit;
    if (quiet && from < 0) from = i;
    if (!quiet && from >= 0) {
      if (i - from >= min) runs.push([from, i]);
      from = -1;
    }
  }
  return runs.filter(([s]) => s > 0);
}

// The edit plan: alternating speech and pause pieces covering the whole clip, each with the
// length it will have afterwards.
export function plan(samples, rand) {
  const jitter = (range) => 1 + (rand() * 2 - 1) * range;
  const pieces = [];
  let at = 0;
  const speech = (to) => {
    if (to <= at) return;
    const tempo = jitter(SPEECH_JITTER);
    pieces.push({ kind: "speech", from: at, to, tempo, length: Math.round((to - at) / tempo) });
  };
  for (const [s, e] of findPauses(samples)) {
    speech(s);
    const scale = jitter(PAUSE_JITTER);
    pieces.push({ kind: "pause", from: s, to: e, scale, length: Math.round((e - s) * scale) });
    at = e;
  }
  speech(samples.length);
  let out = 0;
  for (const p of pieces) (p.at = out), (out += p.length);
  return pieces;
}

// Where a moment of the original clip (in seconds) falls in the humanised clip.
export function mapTime(pieces, t) {
  const x = t * RATE;
  const p = pieces.find((q) => x < q.to) ?? pieces.at(-1);
  const f = Math.min(1, Math.max(0, (x - p.from) / (p.to - p.from)));
  return (p.at + f * p.length) / RATE;
}

function fade(piece) {
  const n = Math.min(Math.round(FADE * RATE), piece.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
    piece[i] = Math.round(piece[i] * g);
    piece[piece.length - 1 - i] = Math.round(piece[piece.length - 1 - i] * g);
  }
  return piece;
}

// A pause keeps its first and last halves, so the breath into and out of it stays; a longer
// pause gets silence added in the middle, a shorter one loses its middle.
function pause(samples, p) {
  const src = samples.subarray(p.from, p.to), out = new Int16Array(p.length);
  const head = p.length >> 1;
  out.set(src.subarray(0, Math.min(head, src.length >> 1)));
  const tail = Math.min(p.length - head, src.length - (src.length >> 1));
  out.set(src.subarray(src.length - tail), p.length - tail);
  return out;
}

function stretch(samples, p) {
  const src = samples.subarray(p.from, p.to);
  const buf = execFileSync(ffmpeg, ["-v", "error", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", "-", "-af", `atempo=${p.tempo.toFixed(5)}`, "-f", "s16le", "-"], {
    input: Buffer.from(src.buffer, src.byteOffset, src.byteLength),
    maxBuffer: 1 << 28,
  });
  // atempo can be a few samples off; trim or pad to the planned length so the timings stay exact.
  const got = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), out = new Int16Array(p.length);
  out.set(got.subarray(0, p.length));
  return out;
}

export function decode(file) {
  const buf = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(RATE), "-"], { maxBuffer: 1 << 28 });
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
}

// Humanise a clip. Returns the new samples and the plan, for mapping its word timings.
export function humanise(samples, seed) {
  const pieces = plan(samples, rng(seed));
  const out = new Int16Array(pieces.reduce((n, p) => n + p.length, 0));
  for (const p of pieces) out.set(fade(p.kind === "pause" ? pause(samples, p) : stretch(samples, p)), p.at);
  return { samples: out, pieces };
}
