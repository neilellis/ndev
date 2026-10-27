// Generates one narration clip per scene, then word timings for captions.
// Usage: node scripts/video-kit/voice.mjs [--voice <id>] [scene...]   (no scenes = all; no voice = the main cut)
// Speech: the configured model (HeyGen Voice 1 by default) through OpenRouter. Word timings: OpenAI Whisper.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { loadConfig, voiceFrom, files, readScript } from "./config.mjs";
import { spoken } from "./captions.mjs";

const config = loadConfig();
const lines = readScript(config);
const speechKey = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
if (!speechKey) throw new Error("OPENROUTER_API_KEY (or OPEN_ROUTER_API_KEY) is not set, so no new speech can be made. Ask for it to be set in the agent environment.");
const whisperKey = process.env.OPENAI_API_KEY;
if (!whisperKey) throw new Error("OPENAI_API_KEY is not set, so no word timings can be made. Ask for it to be set in the agent environment.");

const RATE = 44100; // HeyGen returns 16-bit mono PCM at this rate

const voice = voiceFrom(config, process.argv);
const argv = process.argv.slice(2);
const only = argv.filter((a, i) => a !== "--voice" && argv[i - 1] !== "--voice").map(Number);
for (const n of only) if (!Number.isInteger(n) || !(n in lines)) throw new Error(`Scene ${n} is not in ${config.script}, which has scenes 0 to ${lines.length - 1}`);
const outDir = files(config, voice).vo;
fs.mkdirSync(outDir, { recursive: true });

async function api(url, key, init) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } });
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res;
}

for (const [i, text] of lines.entries()) {
  if (only.length && !only.includes(i)) continue;
  const mp3 = path.join(outDir, `s${i}.mp3`);
  const speech = await api("https://openrouter.ai/api/v1/audio/speech", speechKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, voice, input: spoken(text, config.pronounce), response_format: "pcm" }),
  });
  const type = speech.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/pcm") || !type.includes(`rate=${RATE}`) || !type.includes("channels=1")) throw new Error(`${voice} scene ${i}: unexpected speech format "${type}"`);
  const pcm = path.join(outDir, `s${i}.pcm`);
  fs.writeFileSync(pcm, Buffer.from(await speech.arrayBuffer()));
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", pcm, "-c:a", "libmp3lame", "-b:a", "192k", mp3]);
  fs.rmSync(pcm);

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(mp3)]), `s${i}.mp3`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const words = (await (await api("https://api.openai.com/v1/audio/transcriptions", whisperKey, { method: "POST", body: form })).json()).words;
  if (!words?.length) throw new Error(`${voice} scene ${i}: Whisper returned no word timings for ${path.relative(config.root, mp3)}; run the voice command for this scene again`);

  const duration = Number(
    execFileSync(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString().trim(),
  );
  fs.writeFileSync(path.join(outDir, `s${i}.json`), JSON.stringify({ text, voice, duration, words }, null, 1));
  console.log(`${voice} scene ${i}: ${duration.toFixed(2)}s, ${words.length} words`);
}
