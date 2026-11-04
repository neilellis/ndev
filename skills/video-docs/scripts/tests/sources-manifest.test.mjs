import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compare, dependencies } from "../sources-manifest.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "sources-manifest.mjs");
const content = { id: "demo", scenes: [{ id: "s00", sources: ["docs/a.md"] }, { id: "s01", sources: ["docs/a.md", "docs/b.md"], visual: { diagram: "diagrams/d.html" } }] };

describe("dependencies", () => {
  it("maps each cited file to its scenes", () => {
    assert.deepEqual([...dependencies(content)], [["docs/a.md", ["s00", "s01"]], ["docs/b.md", ["s01"]], ["diagrams/d.html", ["s01"]]]);
  });
  it("refuses a scene without sources", () => {
    assert.throws(() => dependencies({ scenes: [{ id: "s00" }] }), /s00 cites no sources/);
  });
});

describe("compare", () => {
  const manifest = { content: { path: "c.json", sha256: "c" }, sources: { "docs/a.md": { sha256: "a", scenes: ["s00", "s01"] }, "docs/b.md": { sha256: "b", scenes: ["s01"] }, "diagrams/d.html": { sha256: "d", scenes: ["s01"] } } };
  const hashes = { "docs/a.md": "a", "docs/b.md": "b", "diagrams/d.html": "d" };
  it("is empty when nothing changed", () => {
    assert.deepEqual(compare(manifest, content, "c", (f) => hashes[f] ?? null), []);
  });
  it("names a changed page with its scenes", () => {
    assert.deepEqual(compare(manifest, content, "c", (f) => (f === "docs/b.md" ? "x" : hashes[f])), [{ file: "docs/b.md", reason: "changed", scenes: ["s01"] }]);
  });
  it("names a missing page and a content change", () => {
    const problems = compare(manifest, content, "z", (f) => (f === "docs/a.md" ? null : hashes[f]));
    assert.deepEqual(problems.map((p) => p.reason), ["content changed", "missing"]);
  });
});

describe("command line", () => {
  it("writes, goes stale, and records a source-only review", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "srcman-"));
    const git = (...args) => execFileSync("git", args, { cwd: dir });
    git("init", "-q");
    mkdirSync(path.join(dir, "docs"));
    mkdirSync(path.join(dir, "diagrams"));
    mkdirSync(path.join(dir, "video"));
    writeFileSync(path.join(dir, "docs/a.md"), "a");
    writeFileSync(path.join(dir, "docs/b.md"), "b");
    writeFileSync(path.join(dir, "diagrams/d.html"), "d");
    writeFileSync(path.join(dir, "video/content.json"), JSON.stringify(content));
    const run = (...args) => spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(run("write", "video/content.json").status, 0);
    assert.equal(run("status", "video/content.json").status, 0);
    writeFileSync(path.join(dir, "docs/b.md"), "b2");
    const stale = run("status", "video/content.json");
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /docs\/b\.md: changed \(scenes s01\)/);
    assert.equal(run("review", "video/content.json", "--page", "docs/b.md", "--integrity", "ok").status, 2);
    assert.equal(run("review", "video/content.json", "--page", "docs/b.md", "--integrity", "true to page", "--readability", "clear").status, 0);
    assert.equal(run("status", "video/content.json").status, 0);
  });
});

describe("the command line", () => {
  it("runs when its path goes through a symbolic link", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-link-"));
    const link = path.join(dir, "link");
    symlinkSync(path.dirname(SCRIPT), link);
    const run = spawnSync("node", [path.join(link, "sources-manifest.mjs"), "--help"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Provenance for documentation videos/);
  });
});
