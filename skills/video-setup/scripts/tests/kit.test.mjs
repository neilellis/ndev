// Tests for copying the kit into a project and detecting edited or stale copies.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { integrity, staleness, expected, LOCK, PLUGIN } from "../engine/kit.mjs";

const plugin = path.resolve(import.meta.dirname, "..");
const sync = (...args) => spawnSync(process.execPath, [path.join(plugin, "sync.mjs"), ...args], { encoding: "utf8" });
let project;

// A copy of the plugin's source that a test can change, to stand for a newer plugin.
function sourceCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-source-"));
  fs.cpSync(path.join(plugin, "engine"), path.join(dir, "engine"), { recursive: true });
  fs.copyFileSync(path.join(plugin, "kit.json"), path.join(dir, "kit.json"));
  return dir;
}

describe("kit sync", () => {
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "kit-project-"));
    execFileSync("git", ["init", "-q"], { cwd: project });
    const r = sync(project);
    assert.equal(r.status, 0, r.stderr);
  });

  it("copies every engine file and nothing else", () => {
    const want = expected(plugin);
    for (const f of want.keys()) assert.ok(fs.existsSync(path.join(project, f)), `${f} was not copied`);
    assert.ok(fs.existsSync(path.join(project, "scripts/video-kit/timeline.mjs")));
    assert.ok([...want.keys()].every((f) => f.startsWith("scripts/video-kit/")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, LOCK), "utf8")).plugin, PLUGIN);
  });

  it("passes the check when nothing changed", () => {
    assert.deepEqual(integrity(project).errors, []);
    assert.deepEqual(staleness(project, plugin), []);
    const r = sync(project, "--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("fails the check when a project edits a kit file, and names the file and the repair", () => {
    fs.appendFileSync(path.join(project, "scripts/video-kit/podcast.mjs"), "\n// local tweak\n");
    const { errors } = integrity(project);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /scripts\/video-kit\/podcast\.mjs was edited in this project/);
    assert.match(errors[0], /sync the kit again/);
    assert.equal(sync(project, "--check").status, 1);
  });

  it("fails the check when a project adds its own file to the kit folder", () => {
    fs.writeFileSync(path.join(project, "scripts/video-kit/extra.mjs"), "");
    assert.match(integrity(project).errors.join("\n"), /extra\.mjs is not part of the kit/);
  });

  it("reports a copy that is behind the plugin, file by file", () => {
    const newer = sourceCopy();
    fs.appendFileSync(path.join(newer, "engine/podcast.mjs"), "\n// newer\n");
    fs.writeFileSync(path.join(newer, "engine/added.mjs"), "");
    const errors = staleness(project, newer);
    assert.match(errors[0], /differs from the plugin at .*Run the video-setup skill/);
    assert.ok(errors.some((e) => /podcast\.mjs differs from the plugin/.test(e)));
    assert.ok(errors.some((e) => /added\.mjs is missing from the plugin/.test(e)));
  });

  it("refuses to overwrite a local edit unless told to discard it", () => {
    fs.appendFileSync(path.join(project, "scripts/video-kit/podcast.mjs"), "\n// local tweak\n");
    const r = sync(project);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scripts\/video-kit\/podcast\.mjs/);
    assert.equal(sync(project, "--discard-local-edits").status, 0);
    assert.deepEqual(integrity(project).errors, []);
  });

  it("removes files the plugin dropped", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(project, LOCK), "utf8"));
    const gone = "scripts/video-kit/old.mjs";
    fs.writeFileSync(path.join(project, gone), "");
    lock.files[gone] = "0";
    fs.writeFileSync(path.join(project, LOCK), JSON.stringify(lock));
    // The old file was "edited" relative to its fake hash, so discard explicitly.
    assert.equal(sync(project, "--discard-local-edits").status, 0);
    assert.ok(!fs.existsSync(path.join(project, gone)));
  });

  it("refuses an unknown flag instead of syncing", () => {
    fs.appendFileSync(path.join(project, "scripts/video-kit/podcast.mjs"), "");
    const r = sync(project, "--chek");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option "--chek"/);
  });

  it("ignores dotfiles such as .DS_Store on both sides", () => {
    fs.writeFileSync(path.join(project, "scripts/video-kit/.DS_Store"), "x");
    assert.deepEqual(integrity(project).errors, []);
    const src = sourceCopy();
    fs.writeFileSync(path.join(src, "engine/.DS_Store"), "x");
    assert.ok(![...expected(src).keys()].some((f) => f.includes(".DS_Store")));
  });

  it("says when the project's kit is newer than the plugin, and never suggests a downgrade", () => {
    const older = sourceCopy();
    const lock = JSON.parse(fs.readFileSync(path.join(project, LOCK), "utf8"));
    lock.version = "9.0.0";
    fs.writeFileSync(path.join(project, LOCK), JSON.stringify(lock));
    fs.appendFileSync(path.join(older, "engine/podcast.mjs"), "\n// older\n");
    const errors = staleness(project, older);
    assert.match(errors[0], /newer than the plugin at .*\(\d+\.\d+\.\d+\)/);
    assert.match(errors[0], /update the plugin/);
    assert.doesNotMatch(errors[0], /sync the kit again/);
  });

  it("fails when Claude Code lists the plugin but its install is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kit-home-"));
    fs.mkdirSync(path.join(home, ".claude/plugins"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { ["neil-development@neil-development"]: [{ scope: "user", installPath: path.join(home, "gone"), version: "0.1.0" }] } }));
    const r = spawnSync(process.execPath, ["-e", `import("${path.join(plugin, "engine/kit.mjs")}").then((k) => k.findSource("${project}"))`], { env: { ...process.env, HOME: home, VIDEO_KIT_SOURCE: "" }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /installed at .*gone.*which is missing/);
  });
});
