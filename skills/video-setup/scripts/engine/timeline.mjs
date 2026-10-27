// Builds the timeline (scene timings, captions and word cues) and the narration track for one voice.
// Usage: node scripts/video-kit/timeline.mjs [--voice <id>]   (no voice = the main cut)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { loadConfig, voiceFrom, files, readScript } from "./config.mjs";
import { wordTimes, chunk, written, cueWord } from "./captions.mjs";
import { RATE, PODCAST, LOUDNESS, TARGET_LUFS, ROOM_TONE, decode, humanise, mapTime } from "./podcast.mjs";

const config = loadConfig();
const voice = voiceFrom(config, process.argv);
const out = files(config, voice);
const { tempo: TEMPO, lead: LEAD, tail: TAIL, firstLead: FIRST_LEAD, lastTail: LAST_TAIL, postWait: POST_WAIT, creditsHold: CREDITS_HOLD, maxSeconds } = config.timing;
const rel = (f) => path.relative(config.root, f);

const lines = readScript(config);
const clips = lines.map((text, i) => {
  const f = path.join(out.vo, `s${i}.json`);
  if (!fs.existsSync(f)) throw new Error(`${rel(f)} is missing; run the voice command: node scripts/video-kit/voice.mjs --voice ${voice} ${i}`);
  const clip = JSON.parse(fs.readFileSync(f, "utf8"));
  if (clip.text !== text) throw new Error(`${voice} scene ${i}: the narration changed but its voice was not regenerated; run node scripts/video-kit/voice.mjs --voice ${voice} ${i}`);
  return clip;
});

// Podcast effect, step 1: vary each clip's pauses and phrase speeds, and move its word timings
// to match. The humanised clips are mixed below; see podcast.mjs.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "video-kit-timeline-"));
clips.forEach((clip, i) => {
  const { samples, pieces } = humanise(decode(path.join(out.vo, `s${i}.mp3`)), `${voice} ${i} ${clip.text}`);
  clip.audio = path.join(work, `s${i}.wav`);
  const raw = path.join(work, `s${i}.pcm`);
  fs.writeFileSync(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", raw, clip.audio]);
  clip.duration = samples.length / RATE;
  clip.words = clip.words.map((w) => ({ ...w, start: mapTime(pieces, w.start), end: mapTime(pieces, w.end) }));
});

let t = 0;
const scenes = [];
const captions = [];
const words = [];
clips.forEach((clip, i) => {
  const lead = i === 0 ? FIRST_LEAD : LEAD;
  const tail = i === clips.length - 1 ? LAST_TAIL : TAIL;
  // Trim trailing silence: end just after the last spoken word.
  const speech = Math.min(clip.duration, clip.words.at(-1).end + 0.2) / TEMPO;
  const start = t;
  const voiceAt = start + lead;
  const duration = lead + speech + tail;
  scenes.push({ index: i, start: +start.toFixed(3), duration: +duration.toFixed(3), voiceAt: +voiceAt.toFixed(3), speech: +speech.toFixed(3) });
  const timed = wordTimes(clip, TEMPO);
  for (const w of timed) words.push({ scene: i, word: cueWord(w.word), start: +(voiceAt + w.start).toFixed(3) });
  const groups = chunk(timed, config.captions.maxWords);
  groups.forEach((g, gi) => {
    const next = groups[gi + 1];
    captions.push({
      scene: i,
      text: written(g.map((w) => w.word).join(" "), config.captions.written),
      start: +(voiceAt + g[0].start).toFixed(3),
      end: +(next ? voiceAt + next[0].start : voiceAt + speech + 0.15).toFixed(3),
    });
  });
  t += duration;
});

for (const c of captions) if (!(c.end - c.start >= 0.3)) throw new Error(`${voice} scene ${c.scene}: caption "${c.text}" shows for ${(c.end - c.start).toFixed(2)}s; check the word timings in ${rel(out.vo)}/s${c.scene}.json`);

const filmEnd = +t.toFixed(3);
if (filmEnd > maxSeconds) throw new Error(`${voice}: the narration runs ${filmEnd}s, over the ${maxSeconds}s limit for a ${config.type} video. Shorten the script, or split it into more than one video.`);
const credits = { start: +(t + POST_WAIT).toFixed(3), duration: CREDITS_HOLD };
const total = +(credits.start + CREDITS_HOLD).toFixed(3);
const timeline = { total, filmEnd, credits, scenes, captions, words };
fs.writeFileSync(out.timeline, JSON.stringify(timeline, null, 1));
fs.writeFileSync(out.timelineJs, `window.TIMELINE = ${JSON.stringify(timeline)};\n`);

// Narration: speed each clip up, delay it to its slot and mix. Podcast effect, step 2: lay the
// room tone under the voice, then give the whole track the podcast sound.
// loudnorm prints its measurements at the info log level.
fs.mkdirSync(path.dirname(out.narration), { recursive: true });
const args = ["-hide_banner", "-nostats", "-v", "info", "-y"];
clips.forEach((clip) => args.push("-i", clip.audio));
args.push("-f", "lavfi", "-t", String(total), "-i", ROOM_TONE);
const filters = scenes.map((s, i) => `[${i}]atrim=0:${(s.speech * TEMPO).toFixed(3)},atempo=${TEMPO},adelay=${Math.round(s.voiceAt * 1000)}:all=1[a${i}]`);
filters.push(`${scenes.map((_, i) => `[a${i}]`).join("")}amix=inputs=${scenes.length}:normalize=0,apad=whole_dur=${total}[voice]`);
const mix = (level) => [...filters, `[voice][${clips.length}]amix=inputs=2:normalize=0:duration=first,${PODCAST},${level}[out]`].join(";");
// Measure the treated track's loudness, then level it with one fixed gain; the limiter catches
// the few peaks the gain pushes too high.
const probe = spawnSync(ffmpeg, [...args, "-filter_complex", mix(`loudnorm=${LOUDNESS}:print_format=json`), "-map", "[out]", "-f", "null", "-"], { encoding: "utf8" });
if (probe.status !== 0) throw new Error(`${voice}: measuring the narration loudness failed (ffmpeg exit ${probe.status}):\n${probe.stderr}`);
const json = (log) => JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1));
const m = json(probe.stderr);
const gain = TARGET_LUFS - Number(m.input_i);
if (!Number.isFinite(gain)) throw new Error(`${voice}: loudnorm reported no loudness for the narration:\n${probe.stderr.slice(-2000)}`);
const level = spawnSync(ffmpeg, [...args, "-filter_complex", mix(`volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:level=0,atrim=0:${total}`), "-map", "[out]", "-ar", "48000", "-c:a", "pcm_s16le", out.narration], { encoding: "utf8" });
if (level.status !== 0) throw new Error(`${voice}: mixing the narration failed (ffmpeg exit ${level.status}):\n${level.stderr}`);
fs.rmSync(work, { recursive: true });

console.log(`${voice}: film ${filmEnd}s, credits page at ${credits.start}s, total ${total}s`);
for (const s of scenes) console.log(`scene ${s.index}: ${s.start.toFixed(2)} → ${(s.start + s.duration).toFixed(2)}`);
