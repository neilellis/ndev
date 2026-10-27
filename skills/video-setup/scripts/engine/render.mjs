// Renders the film frame by frame in headless Chrome and encodes it with the narration.
// Usage: node scripts/video-kit/render.mjs                 → out/<name>.mp4 (the main cut)
//        node scripts/video-kit/render.mjs --voice <id>    → out/<name>-<id>.mp4
//        node scripts/video-kit/render.mjs --all           → every voice's film
//        node scripts/video-kit/render.mjs --stills        → out/stills/scene-N.png shortly after each scene's last word, plus sheet.jpg
//        node scripts/video-kit/render.mjs --stills 3,10.5 → out/stills/t-3.00.png etc. at those times
// The page must set window.ready (a promise that resolves when assets have loaded) and
// window.seek(t), which draws the frame at t seconds. ?voice=<id> selects a voice's timeline.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import ffmpeg from "ffmpeg-static";
import { loadConfig, voiceFrom, files } from "./config.mjs";

const config = loadConfig();
const FPS = 30;
if (process.argv.includes("--all")) {
  for (const v of config.voices) execFileSync(process.execPath, [import.meta.filename, "--voice", v.id], { stdio: "inherit" });
  process.exit(0);
}
const voice = voiceFrom(config, process.argv);
const paths = files(config, voice);
const timeline = JSON.parse(fs.readFileSync(paths.timeline, "utf8"));
const stillsArg = process.argv.indexOf("--stills");
const custom = stillsArg > -1 && process.argv[stillsArg + 1] && !process.argv[stillsArg + 1].startsWith("--");
const stills =
  stillsArg === -1 ? null
  : custom ? process.argv[stillsArg + 1].split(",").map((t) => ({ t: Number(t), name: `t-${Number(t).toFixed(2)}` }))
  : timeline.scenes.map((s) => {
      // Shortly after the scene's last spoken word, once everything it cues is on screen.
      const last = Math.max(...timeline.words.filter((w) => w.scene === s.index).map((w) => w.start));
      return { t: Math.min(last + 0.6, s.start + s.duration - 0.2), name: `scene-${s.index}` };
    });

const browser = await chromium.launch({ channel: "chrome", args: ["--allow-file-access-from-files", "--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("requestfailed", (r) => errors.push(`Could not load ${decodeURI(r.url())}: ${r.failure()?.errorText}`));
await page.goto("file://" + path.join(config.root, config.page) + (voice === config.voices[0].id ? "" : `?voice=${voice}`));
await page.evaluate(() => window.ready);
if (errors.length) throw new Error("Page errors:\n" + errors.join("\n"));

const outDir = path.join(config.root, "out");
fs.mkdirSync(path.join(outDir, "stills"), { recursive: true });

if (stills) {
  const files = [];
  for (const { t, name } of stills) {
    await page.evaluate((t) => window.seek(t), t);
    const file = path.join(outDir, "stills", `${name}.png`);
    await page.screenshot({ path: file });
    files.push(file);
    console.log(file);
  }
  // Contact sheet: three across, for reviewing every still at once.
  const n = files.length, cols = Math.min(3, n), rows = Math.ceil(n / 3);
  const layout = files.map((_, i) => `${(i % 3) * 960}_${Math.floor(i / 3) * 540}`).join("|");
  const scaled = files.map((_, i) => `[${i}]scale=960:540[v${i}]`).join(";");
  const sheet = path.join(outDir, "stills", "sheet.jpg");
  const filter = n === 1 ? "[0]scale=960:540" : `${scaled};${files.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=white`;
  execFileSync(ffmpeg, ["-v", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", filter, "-frames:v", "1", "-s", `${cols * 960}x${rows * 540}`, sheet]);
  console.log(sheet);
} else {
  const frames = Math.ceil(timeline.total * FPS);
  const out = paths.film;
  const enc = spawn(ffmpeg, [
    "-v", "error", "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-i", paths.narration,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "192k", "-shortest", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} while encoding ${path.relative(config.root, out)}`)))));
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 95 });
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames}`);
  }
  enc.stdin.end();
  await done;
  console.log(out);
}
if (errors.length) throw new Error("Page errors:\n" + errors.join("\n"));
await browser.close();
