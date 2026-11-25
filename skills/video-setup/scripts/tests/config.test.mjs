// Tests for reading a project's video.config.json.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, files, voiceFrom, TYPES } from "../engine/config.mjs";

function project(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-config-"));
  fs.writeFileSync(path.join(dir, "video.config.json"), JSON.stringify(config));
  return dir;
}
const base = { type: "marketing", name: "film", voices: [{ id: "tabitha" }, { id: "gareth" }] };

describe("video.config.json", () => {
  it("takes its timing from the video type, with project overrides", () => {
    const c = loadConfig(project({ ...base, type: "how-to", timing: { tempo: 1.05 } }));
    assert.equal(c.timing.tempo, 1.05);
    assert.equal(c.timing.postWait, TYPES["how-to"].postWait);
  });

  it("names the main cut plainly and other voices with their id", () => {
    const c = loadConfig(project(base));
    assert.equal(path.basename(files(c, "tabitha").film), "film.mp4");
    assert.equal(path.basename(files(c, "gareth").narration), "narration-gareth.wav");
    assert.equal(path.relative(c.root, files(c, "gareth").timelineJs), path.join("film", "timeline-gareth.js"));
    assert.equal(voiceFrom(c, []), "tabitha");
    assert.throws(() => voiceFrom(c, ["--voice", "onyx"]), /Unknown voice "onyx"/);
  });

  it("rejects an unknown type, a missing file and an unknown timing setting", () => {
    assert.throws(() => loadConfig(project({ ...base, type: "advert" })), /"type" must be one of marketing, explainer, how-to/);
    assert.throws(() => loadConfig(project({ ...base, timing: { speed: 1 } })), /unknown timing setting "speed"/);
    assert.throws(() => loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "kit-none-"))), /video\.config\.json is missing/);
  });

  it("rejects misspelt keys, bad voices, non-numeric timing and broken JSON, naming each", () => {
    assert.throws(() => loadConfig(project({ ...base, pronunciation: {} })), /unknown setting "pronunciation"/);
    assert.throws(() => loadConfig(project({ ...base, captions: { maxword: 5 } })), /unknown captions setting "maxword"/);
    assert.throws(() => loadConfig(project({ ...base, voices: [{ id: "tabitha" }, { id: "tabitha" }] })), /voice "tabitha" is listed twice/);
    assert.throws(() => loadConfig(project({ ...base, voices: [{ label: "x" }] })), /each voice needs an "id"/);
    assert.throws(() => loadConfig(project({ ...base, timing: { tempo: "fast" } })), /timing setting "tempo" must be a number/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-bad-"));
    fs.writeFileSync(path.join(dir, "video.config.json"), "{ type: ");
    assert.throws(() => loadConfig(dir), /video\.config\.json is not valid JSON/);
  });
});
