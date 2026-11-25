// A project's video settings, read from video.config.json in the folder the command runs in.
// The video type (marketing, explainer or how-to) sets the defaults; the project file overrides them.
// The first voice is the main cut and keeps the plain file names; every other voice adds its id.
import fs from "node:fs";
import path from "node:path";

export const TYPES = {
  // A short marketing film: about 60 s of narration, an end card that holds, then a credits page.
  marketing: { tempo: 1.12, lead: 0.25, tail: 0.4, firstLead: 0.6, lastTail: 2.0, postWait: 30, creditsHold: 8, maxSeconds: 90 },
  // Marketing-docs: explains how something works, with a soft close. Two to five minutes.
  explainer: { tempo: 1.06, lead: 0.35, tail: 0.6, firstLead: 0.8, lastTail: 2.5, postWait: 5, creditsHold: 6, maxSeconds: 300 },
  // Documentation how-to: one task, step by step, at a pace the viewer can follow on screen.
  "how-to": { tempo: 1.0, lead: 0.4, tail: 0.8, firstLead: 0.8, lastTail: 2.0, postWait: 0, creditsHold: 0, maxSeconds: 1800 },
};

const TIMING = Object.keys(TYPES.marketing);
const KEYS = ["type", "name", "script", "page", "voices", "model", "pronounce", "captions", "timing", "review", "copy"];

export function loadConfig(root = process.cwd()) {
  const file = path.join(root, "video.config.json");
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. Run the kit's commands from the video project's folder, or set the project up with the video-setup skill.`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const where = `video.config.json`;
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) throw new Error(`${where}: unknown setting "${key}"; the settings are ${KEYS.join(", ")}`);
  for (const key of Object.keys(raw.captions ?? {})) if (!["maxWords", "written"].includes(key)) throw new Error(`${where}: unknown captions setting "${key}"; the settings are maxWords, written`);
  for (const key of Object.keys(raw.review ?? {})) if (!["base", "font"].includes(key)) throw new Error(`${where}: unknown review setting "${key}"; the settings are base, font`);
  if (!TYPES[raw.type]) throw new Error(`${where}: "type" must be one of ${Object.keys(TYPES).join(", ")}, not ${JSON.stringify(raw.type)}`);
  if (!raw.name || !/^[a-z0-9-]+$/.test(raw.name)) throw new Error(`${where}: "name" must be the film's file name in lower case, for example "product-explainer"`);
  if (!Array.isArray(raw.voices) || !raw.voices.length) throw new Error(`${where}: "voices" must list at least one voice, for example [{ "id": "tabitha", "label": "Tabitha (female)" }]`);
  const ids = new Set();
  for (const v of raw.voices) {
    if (!v || typeof v.id !== "string" || !/^[a-z0-9-]+$/.test(v.id)) throw new Error(`${where}: each voice needs an "id" in lower case, such as "tabitha"; got ${JSON.stringify(v)}`);
    if (ids.has(v.id)) throw new Error(`${where}: voice "${v.id}" is listed twice`);
    ids.add(v.id);
  }
  for (const [key, value] of Object.entries(raw.timing ?? {})) {
    if (!TIMING.includes(key)) throw new Error(`${where}: unknown timing setting "${key}"; the settings are ${TIMING.join(", ")}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${where}: timing setting "${key}" must be a number of zero or more, not ${JSON.stringify(value)}`);
  }
  return {
    root,
    type: raw.type,
    name: raw.name,
    script: raw.script ?? "scripts/vo.json",
    page: raw.page ?? "film/index.html",
    voices: raw.voices,
    model: raw.model ?? "heygen/heygen-voice-1",
    pronounce: raw.pronounce ?? {},
    captions: { maxWords: 7, written: {}, ...raw.captions },
    timing: { ...TYPES[raw.type], ...raw.timing },
    review: { base: "origin/main", font: null, ...raw.review },
    copy: raw.copy ?? [],
  };
}

export function voiceFrom(config, argv) {
  const at = argv.indexOf("--voice");
  const id = at === -1 ? config.voices[0].id : argv[at + 1];
  if (!config.voices.some((v) => v.id === id)) throw new Error(`Unknown voice "${id}"; the voices in video.config.json are ${config.voices.map((v) => v.id).join(", ")}`);
  return id;
}

export function files(config, id) {
  const tag = id === config.voices[0].id ? "" : `-${id}`;
  const at = (f) => path.join(config.root, f);
  return {
    vo: at(`audio/vo${tag}`),
    narration: at(`audio/narration${tag}.wav`),
    timeline: at(`timeline${tag}.json`),
    timelineJs: at(path.join(path.dirname(config.page), `timeline${tag}.js`)),
    film: at(`out/${config.name}${tag}.mp4`),
  };
}

export const readScript = (config) => JSON.parse(fs.readFileSync(path.join(config.root, config.script), "utf8"));
