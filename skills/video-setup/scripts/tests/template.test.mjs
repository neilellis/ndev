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
  it("builds a timeline, renders a still of every scene and draws arrow cues", async () => {
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

    // An arrow cue: arrow.js points at the spot from the cue word to the end of its scene. The cue
    // is on "dark", after scene 0 has faded out, so the stills below differ only in the arrow.
    const page = path.join(root, "film/index.html");
    const html = fs.readFileSync(page, "utf8");
    const spot = (sign, word = "dark") => `<span class="spot" style="left: 300px; top: 700px; width: 200px; height: 80px" data-arrow="w:1:${word}" data-sign="${sign}"></span>\n</section>\n\n<!-- Delete the credits`;
    fs.writeFileSync(page, html.replace("</section>\n\n<!-- Delete the credits", spot("Light scenes")));
    run("render.mjs", "--stills");
    const cue = timeline.words.find((w) => w.scene === 1 && w.word === "dark").start;
    const { chromium } = await import(path.join(modules, "playwright-core/index.mjs"));
    const browser = await chromium.launch({ channel: "chrome", args: ["--allow-file-access-from-files"] });
    try {
      const view = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const arrowsAt = async (t) => {
        await view.goto(`file://${page}?t=${t}`);
        await view.evaluate(() => window.ready);
        await view.evaluate(() => new Promise(requestAnimationFrame));
        return view.evaluate(() => window.walkArrow.active().map((id) => window.walkArrow.info(id).target));
      };
      assert.deepEqual(await arrowsAt(cue - 0.3), [], "no arrow before its cue word");
      assert.deepEqual(await arrowsAt(cue + 0.5), [{ x: 300, y: 700, w: 200, h: 80 }], "the arrow points at the spot after its cue word");
      assert.deepEqual(await arrowsAt(timeline.credits.start + 0.5), [], "the arrow ends with its scene");
    } finally {
      await browser.close();
    }
    // A still depends only on its time, whatever was rendered before it. Chrome dithers gradients,
    // so two renders of one frame can differ by 1 in a channel; an arrow differs by far more.
    const rgb = (f) => execFileSync(ffmpeg, ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
    const at = (cue + 0.05).toFixed(2), still = path.join(root, `out/stills/t-${at}.png`);
    run("render.mjs", "--stills", at);
    const alone = rgb(still);
    run("render.mjs", "--stills", `${(cue + 1).toFixed(2)},${at}`);
    const after = rgb(still);
    let worst = 0;
    for (let i = 0; i < alone.length; i++) worst = Math.max(worst, Math.abs(alone[i] - after[i]));
    assert.ok(worst <= 2, `a still after a later still differs from the same still alone by ${worst} in a channel`);
    run("render.mjs");
    assert.ok(fs.statSync(path.join(root, "out/sample.mp4")).size > 0);

    // A cue on an element with no size fails the render, naming the scene and the cue.
    fs.writeFileSync(page, html.replace("</section>\n\n<!-- Delete the credits", `<span class="spot" data-arrow="w:1:light" data-sign="Light scenes"></span>\n</section>\n\n<!-- Delete the credits`));
    const empty = spawnSync(process.execPath, [path.join(root, "scripts/video-kit/render.mjs"), "--stills"], { cwd: root, encoding: "utf8" });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /scene 1 arrow "w:1:light" points at an element with no size/);

    // A sign longer than 40 characters fails the render, naming the scene and the cue.
    fs.writeFileSync(page, html.replace("</section>\n\n<!-- Delete the credits", spot("A sign that runs on far past the forty-character limit")));
    const long = spawnSync(process.execPath, [path.join(root, "scripts/video-kit/render.mjs"), "--stills"], { cwd: root, encoding: "utf8" });
    assert.notEqual(long.status, 0);
    assert.match(long.stderr, /scene 1 arrow "w:1:dark" needs a sign of 1 to 40 characters/);

    // Two arrows closer than the draw time fail the render, naming the later cue.
    fs.writeFileSync(page, html.replace("</section>\n\n<!-- Delete the credits", spot("Light scenes", "light").replace("</section>", `<span class="spot" data-arrow="w:1:and" data-sign="And"></span>\n</section>`)));
    const close = spawnSync(process.execPath, [path.join(root, "scripts/video-kit/render.mjs"), "--stills"], { cwd: root, encoding: "utf8" });
    assert.notEqual(close.status, 0);
    assert.match(close.stderr, /scene 1 arrow "w:1:light" at [\d.]+ s has 0\.\d+ s before the next arrow; it needs 1\.8 s to draw/);

    // A missing file fails the render and is named in the error.
    fs.writeFileSync(page, html.replace('<div class="picture"', '<img src="../assets/missing.png"><div class="picture"'));
    const r = spawnSync(process.execPath, [path.join(root, "scripts/video-kit/render.mjs"), "--stills"], { cwd: root, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /missing\.png/);
  });
});
