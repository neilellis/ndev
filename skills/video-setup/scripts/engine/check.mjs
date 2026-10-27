#!/usr/bin/env node
// Checks the kit copy and the video. Run it in the video's folder.
// 1. The kit files in this repository are unedited, and match the plugin when its source is on
//    this machine. In CI the plugin is usually absent; the check then says so and still passes.
// 2. The script, the generated voices, the timelines and the page's scenes agree. This catches
//    a narration edit that was committed without regenerating the voice.
import fs from "node:fs";
import path from "node:path";
import { integrity, staleness, findSource, PLUGIN } from "./kit.mjs";
import { loadConfig, files, readScript } from "./config.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const errors = [];
const notes = [];

const { lock, errors: edits } = integrity(repo);
errors.push(...edits);
const source = findSource(repo);
if (source) errors.push(...staleness(repo, source.dir));
else notes.push(`the plugin's source is not on this machine, so the kit (${lock.version}) was not compared with the latest plugin`);

const config = loadConfig();
if (path.relative(repo, config.root).startsWith("..")) throw new Error(`Run the check in the video's folder inside ${repo}; ${config.root} is outside it`);
const rel = (f) => path.relative(config.root, f);
const lines = readScript(config);
const scenes = [...fs.readFileSync(path.join(config.root, config.page), "utf8").matchAll(/<section class="scene[^"]*" id="s(\d+)"/g)].map((m) => Number(m[1]));
if (scenes.join() !== lines.map((_, i) => i).join()) errors.push(`${config.page} has scenes [${scenes}] but ${config.script} has ${lines.length} lines`);
const totals = [];
for (const { id } of config.voices) {
  const out = files(config, id);
  const voice = `node scripts/video-kit/voice.mjs --voice ${id}`;
  const timeline = `node scripts/video-kit/timeline.mjs --voice ${id}`;
  lines.forEach((text, i) => {
    const f = path.join(out.vo, `s${i}.json`);
    if (!fs.existsSync(f)) return errors.push(`${rel(f)} is missing; run ${voice} ${i}`);
    const clip = JSON.parse(fs.readFileSync(f, "utf8"));
    if (clip.text !== text) errors.push(`${id} scene ${i} narration changed but its voice was not regenerated; run ${voice} ${i}, then ${timeline}`);
    if (clip.voice !== id) errors.push(`${rel(f)} was spoken by ${clip.voice ?? "an older voice"}, not ${id}; run ${voice} ${i}`);
  });
  if (!fs.existsSync(out.timeline)) { errors.push(`${rel(out.timeline)} is missing; run ${timeline}`); continue; }
  const t = JSON.parse(fs.readFileSync(out.timeline, "utf8"));
  if (t.scenes.length !== lines.length) errors.push(`${rel(out.timeline)} is stale; run ${timeline}`);
  if (fs.readFileSync(out.timelineJs, "utf8") !== `window.TIMELINE = ${JSON.stringify(t)};\n`) errors.push(`${rel(out.timelineJs)} does not match ${rel(out.timeline)}; run ${timeline}`);
  totals.push(`${id} ${t.total}s`);
}

for (const n of notes) console.log(`${PLUGIN}: note: ${n}`);
if (errors.length) {
  for (const e of errors) console.error(`${PLUGIN}: ${e}`);
  process.exitCode = 1;
} else {
  console.log(`${PLUGIN}: kit ${lock.version} unedited${source ? ` and current (${source.via})` : ""}; ${config.type} video, ${lines.length} scenes, voices and timelines agree (${totals.join(", ")})`);
}
