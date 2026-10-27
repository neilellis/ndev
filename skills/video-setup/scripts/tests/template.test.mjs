// End to end: a new project made from templates/film, with synthetic voice clips, built by the
// kit's own timeline and stills commands. Guards the engine against changes that break a fresh project.
// It needs Google Chrome and a node_modules folder with gsap, ffmpeg-static, ffprobe-static and
// playwright-core: set VIDEO_KIT_NODE_MODULES to that folder (for example a video project's own).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const plugin = path.resolve(import.meta.dirname, "..");
const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/google/chrome/chrome", "/usr/bin/google-chrome"].some((f) => fs.existsSync(f));
const modules = process.env.VIDEO_KIT_NODE_MODULES || (fs.existsSync(path.join(plugin, "node_modules")) ? path.join(plugin, "node_modules") : null);
const skip = !chrome ? "Google Chrome is not installed, so the template cannot be rendered"
  : !modules ? "VIDEO_KIT_NODE_MODULES is not set and scripts/node_modules is absent, so the engine's packages cannot be loaded"
  : !fs.existsSync(path.join(modules, "ffmpeg-static")) ? `${modules} has no ffmpeg-static; set VIDEO_KIT_NODE_MODULES to a node_modules folder with the engine's packages`
  : false;
const ffmpeg = skip ? null : (await import(path.join(modules, "ffmpeg-static/index.js"))).default;

// A clip of tone bursts, one per word, with short pauses between them, and matching word timings.
function clip(dir, i, text) {
  const words = text.split(" ");
  const inputs = words.map((_, k) => `[a${k}]`).join("");
  const graph = words.map((_, k) => `sine=f=${180 + 20 * k}:d=0.32:r=24000,volume=0.4,apad=pad_dur=0.12[a${k}]`).join(";") + `;${inputs}concat=n=${words.length}:v=0:a=1,adelay=150[out]`;
  execFileSync(ffmpeg, ["-v", "error", "-y", "-filter_complex", graph, "-map", "[out]", "-ar", "24000", "-ac", "1", path.join(dir, `s${i}.mp3`)]);
  const timed = words.map((word, k) => ({ word, start: 0.15 + k * 0.44, end: 0.15 + k * 0.44 + 0.32 }));
  fs.writeFileSync(path.join(dir, `s${i}.json`), JSON.stringify({ text, voice: "tabitha", words: timed }));
}

describe("a new project from the template", { skip }, () => {
  it("builds a timeline and renders a still of every scene", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-template-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(process.execPath, [path.join(plugin, "sync.mjs"), root]);
    fs.cpSync(path.join(plugin, "templates/film"), path.join(root, "film"), { recursive: true });
    fs.symlinkSync(modules, path.join(root, "node_modules"));
    const lines = ["One idea per scene, said plainly.", "Light and dark scenes alternate."];
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts/vo.json"), JSON.stringify(lines));
    fs.writeFileSync(path.join(root, "video.config.json"), JSON.stringify({ type: "explainer", name: "sample", voices: [{ id: "tabitha" }], copy: ["film/index.html"] }));
    const vo = path.join(root, "audio/vo");
    fs.mkdirSync(vo, { recursive: true });
    lines.forEach((text, i) => clip(vo, i, text));

    const run = (script, ...args) => {
      const r = spawnSync(process.execPath, [path.join(root, "scripts/video-kit", script), ...args], { cwd: root, encoding: "utf8" });
      assert.equal(r.status, 0, `${script} failed:\n${r.stdout}\n${r.stderr}`);
      return r.stdout;
    };
    run("timeline.mjs");
    const timeline = JSON.parse(fs.readFileSync(path.join(root, "timeline.json"), "utf8"));
    assert.equal(timeline.scenes.length, 2);
    assert.ok(timeline.credits.duration > 0, "an explainer has a credits page");
    assert.ok(fs.statSync(path.join(root, "audio/narration.wav")).size > 0);
    assert.match(run("check.mjs"), /voices and timelines agree/);
    run("render.mjs", "--stills");
    for (const f of ["scene-0.png", "scene-1.png", "sheet.jpg"]) assert.ok(fs.existsSync(path.join(root, "out/stills", f)), `${f} was not rendered`);

    // A missing file fails the render and is named in the error.
    const page = path.join(root, "film/index.html");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace('<div class="picture"', '<img src="../assets/missing.png"><div class="picture"'));
    const r = spawnSync(process.execPath, [path.join(root, "scripts/video-kit/render.mjs"), "--stills"], { cwd: root, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /missing\.png/);
  });
});
