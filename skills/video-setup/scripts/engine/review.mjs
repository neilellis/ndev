// Builds a review pack for the scenes being changed, so the user can follow the work as it happens.
// Usage: node scripts/video-kit/review.mjs 7 [3 credits ...]
//   out/review/scene-N-before-after.jpg  the approved still beside the current one
//   out/review/scene-N.mp4               the scene as it now plays, with narration
//   out/review/changes.md                narration and on-screen text, approved and now
// "Approved" is the committed out/stills and page on the review base (origin/main unless
// video.config.json sets review.base); "now" is the working tree.
// The clip uses the main cut's narration track as it stands, so rebuild the timeline first after narration edits.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";
import ffmpeg from "ffmpeg-static";
import { loadConfig, files, readScript } from "./config.mjs";

const config = loadConfig();
const root = config.root;
const BASE = config.review.base;
const FPS = 30;
const ids = process.argv.slice(2);
if (!ids.length || ids.some((id) => !/^(\d+|credits)$/.test(id))) throw new Error("usage: node scripts/video-kit/review.mjs <scene number|credits>...");

const main = files(config, config.voices[0].id);
const timeline = JSON.parse(fs.readFileSync(main.timeline, "utf8"));
// Paths from the repository root, so a video in a subfolder of a repository works too.
const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root }).toString().trim();
const approved = (f) => execFileSync("git", ["show", `${BASE}:${prefix}${f}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const span = (id) => {
  if (id === "credits") {
    if (!timeline.credits.duration) throw new Error("This video has no credits page (creditsHold is 0)");
    return { start: timeline.credits.start, end: timeline.total };
  }
  const scene = timeline.scenes[Number(id)];
  if (!scene) throw new Error(`scene ${id} is not in ${path.relative(root, main.timeline)}`);
  return { start: scene.start, end: scene.start + scene.duration };
};

const section = (html, id) => {
  const key = id === "credits" ? "credits" : `s${id}`;
  const open = html.search(new RegExp(`<section class="(?:scene|post)[^"]*" id="${key}"`));
  if (open < 0) return "";
  const next = html.indexOf("<section", open + 1);
  return html.slice(open, next < 0 ? html.length : next);
};
const visibleText = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<\/(p|h\d|li|div|dt|dd)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const out = path.join(root, "out/review");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Narration and on-screen text, approved and now.
const linesBefore = JSON.parse(approved(config.script).toString());
const linesNow = readScript(config);
const htmlBefore = approved(config.page).toString();
const htmlNow = fs.readFileSync(path.join(root, config.page), "utf8");
const report = ["# Changes for review", ""];
for (const id of ids) {
  const { start } = span(id);
  report.push(`## ${id === "credits" ? "Credits page" : `Scene ${id}`} (from ${start.toFixed(1)} s)`, "");
  if (id !== "credits") {
    const [before, now] = [linesBefore[Number(id)] ?? "(new scene)", linesNow[Number(id)]];
    report.push(before === now ? `Narration (unchanged): ${now}` : `Narration before: ${before}\n\nNarration now: ${now}`, "");
  }
  const [textBefore, textNow] = [visibleText(section(htmlBefore, id)), visibleText(section(htmlNow, id))];
  if (textBefore.join("\n") === textNow.join("\n")) report.push(`On-screen text (unchanged): ${textNow.join(" / ") || "none"}`, "");
  else report.push(`On-screen text before: ${textBefore.join(" / ") || "none"}`, "", `On-screen text now: ${textNow.join(" / ") || "none"}`, "");
}
fs.writeFileSync(path.join(out, "changes.md"), report.join("\n"));
console.log(path.join(out, "changes.md"));

const browser = await chromium.launch({ channel: "chrome", args: ["--allow-file-access-from-files", "--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("requestfailed", (r) => errors.push(`Could not load ${decodeURI(r.url())}: ${r.failure()?.errorText}`));
await page.goto("file://" + path.join(root, config.page));
await page.evaluate(() => window.ready);
if (errors.length) throw new Error("Page errors:\n" + errors.join("\n"));

const font = config.review.font ? `fontfile=${config.review.font}:` : "";
for (const id of ids) {
  const { start, end } = span(id);

  // Before and after, side by side. Scene stills are taken at 85 % of the scene.
  const now = path.join(out, `scene-${id}-now.png`);
  await page.evaluate((t) => window.seek(t), id === "credits" ? start + 2 : start + (end - start) * 0.85);
  await page.screenshot({ path: now });
  const compare = path.join(out, `scene-${id}-before-after.jpg`);
  // The credits page and a new scene have no approved still, so the pack shows the current frame alone.
  const approvedStill = `out/stills/scene-${id}.png`;
  const hasApproved = id !== "credits" && execFileSync("git", ["ls-tree", "--name-only", "--full-tree", BASE, prefix + approvedStill], { cwd: root }).toString().trim() !== "";
  const before = hasApproved ? path.join(out, `scene-${id}-before.png`) : null;
  if (before) fs.writeFileSync(before, approved(approvedStill));
  const label = (text) => `drawtext=${font}text='${text}':x=24:y=20:fontsize=40:fontcolor=white:box=1:boxcolor=0x222222@0.85:boxborderw=12`;
  const filter = before
    ? `[0]scale=960:540,${label("Approved")}[a];[1]scale=960:540,${label("Now")}[b];[a][b]hstack`
    : `[0]scale=960:540,${label("Now")}`;
  execFileSync(ffmpeg, ["-v", "error", "-y", ...(before ? ["-i", before] : []), "-i", now, "-filter_complex", filter, "-frames:v", "1", compare], { cwd: root });
  if (before) fs.rmSync(before);
  console.log(compare);

  // The scene as it now plays, with narration.
  const clip = path.join(out, `scene-${id}.mp4`);
  const enc = spawn(ffmpeg, [
    "-v", "error", "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-ss", start.toFixed(3), "-t", (end - start).toFixed(3), "-i", main.narration,
    "-vf", "scale=1280:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k", "-shortest", clip,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => enc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} while encoding ${path.relative(root, clip)}`)))));
  for (let f = Math.round(start * FPS); f < Math.round(end * FPS); f++) {
    await page.evaluate((t) => window.seek(t), f / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 90 });
    if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
  }
  enc.stdin.end();
  await done;
  console.log(clip);
}
if (errors.length) throw new Error("Page errors:\n" + errors.join("\n"));
await browser.close();
