#!/usr/bin/env node
// Provenance for documentation videos: hash each documentation page and diagram a video cites, map
// each one to its scenes, and report what changed since the last review.
//
// Usage (paths are relative to the repository root, `git rev-parse --show-toplevel`):
//   node sources-manifest.mjs write  <content.json> [--manifest <path>]
//   node sources-manifest.mjs status <content.json> [--manifest <path>]
//   node sources-manifest.mjs review <content.json> --page <path>... --integrity <text> --readability <text> [--manifest <path>]
//
// content.json: { "id": "...", "scenes": [{ "id": "s00", "sources": ["docs/page.mdx"], "visual": { "diagram": "diagrams/x.html" } }] }
// The manifest defaults to manifest.json beside content.json.
// write   snapshots content.json and every cited file, and records the git HEAD as sourceRevision.
// status  exits 1 and lists each changed, missing or remapped dependency with its scenes.
// review  records a source-only review of changed pages: it updates only those page hashes and
//         appends the two review conclusions. Use it only after you read each page and every scene that cites it.
// Exit codes: 0 current or written; 1 stale; 2 bad input.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const fail = (message, code = 2) => {
  console.error(`sources-manifest: ${message}`);
  process.exit(code);
};

function root() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return fail(`${process.cwd()} is not a git checkout. Run from the repository that holds the video.`);
  }
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function parse(argv) {
  const [command, content, ...rest] = argv;
  const options = { command, content, manifest: "", pages: [], integrity: "", readability: "" };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => rest[++i] ?? fail(`${arg} needs a value`);
    if (arg === "--manifest") options.manifest = value();
    else if (arg === "--page") options.pages.push(value());
    else if (arg === "--integrity") options.integrity = value();
    else if (arg === "--readability") options.readability = value();
    else fail(`unknown argument '${arg}'`);
  }
  return options;
}

/** Each cited file, with the scenes that cite it. */
export function dependencies(content) {
  if (!Array.isArray(content.scenes) || !content.scenes.length) throw new Error("content.json has no scenes");
  const deps = new Map();
  for (const scene of content.scenes) {
    if (!scene.id) throw new Error("a scene has no id");
    const files = [...(scene.sources ?? []), ...(scene.visual?.diagram ? [scene.visual.diagram] : [])];
    if (!scene.sources?.length) throw new Error(`scene ${scene.id} cites no sources`);
    for (const file of files) deps.set(file, [...(deps.get(file) ?? []), scene.id]);
  }
  return deps;
}

/** Compare a manifest with the current files. Returns a list of { file, reason, scenes }. */
export function compare(manifest, content, contentHash, hashOf) {
  const problems = [];
  if (manifest.content.sha256 !== contentHash) problems.push({ file: manifest.content.path, reason: "content changed", scenes: ["all"] });
  const deps = dependencies(content);
  for (const [file, scenes] of deps) {
    const entry = manifest.sources[file];
    const hash = hashOf(file);
    if (!entry) problems.push({ file, reason: "not in the manifest", scenes });
    else if (hash === null) problems.push({ file, reason: "missing", scenes });
    else if (entry.sha256 !== hash) problems.push({ file, reason: "changed", scenes });
    else if (entry.scenes.join() !== scenes.join()) problems.push({ file, reason: "cited by different scenes", scenes });
  }
  for (const file of Object.keys(manifest.sources)) if (!deps.has(file)) problems.push({ file, reason: "no longer cited", scenes: manifest.sources[file].scenes });
  return problems;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (!options.command || ["-h", "--help"].includes(options.command)) {
    console.log(readFileSync(import.meta.filename, "utf8").split("\n").slice(1, 18).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (!["write", "status", "review"].includes(options.command)) fail(`unknown command '${options.command}'. Use write, status or review.`);
  if (!options.content) fail("name the video's content.json");
  const top = root();
  const abs = (file) => path.join(top, file);
  const contentPath = path.relative(top, path.resolve(options.content));
  if (!existsSync(abs(contentPath))) fail(`content file not found: ${contentPath}`);
  const manifestPath = options.manifest ? path.resolve(options.manifest) : path.join(path.dirname(abs(contentPath)), "manifest.json");
  let content;
  try {
    content = JSON.parse(readFileSync(abs(contentPath), "utf8"));
  } catch (error) {
    fail(`cannot read ${contentPath}: ${error.message}`);
  }
  const hashOf = (file) => (existsSync(abs(file)) ? sha(abs(file)) : null);
  let deps;
  try {
    deps = dependencies(content);
  } catch (error) {
    fail(`${contentPath}: ${error.message}`);
  }

  if (options.command === "write") {
    const sources = {};
    for (const [file, scenes] of deps) {
      const hash = hashOf(file);
      if (hash === null) fail(`${contentPath} cites a missing file: ${file}. Fix the citation or restore the file.`);
      sources[file] = { sha256: hash, scenes };
    }
    let sourceRevision = "";
    try {
      sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: top, encoding: "utf8" }).trim();
    } catch {
      sourceRevision = "(no commits)";
    }
    const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    const manifest = { video: content.id ?? "", sourceRevision, content: { path: contentPath, sha256: sha(abs(contentPath)) }, sources, reviews: previous.reviews ?? [] };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Wrote ${path.relative(top, manifestPath)}: ${deps.size} cited files, revision ${sourceRevision}.`);
    return;
  }

  if (!existsSync(manifestPath)) fail(`no manifest at ${path.relative(top, manifestPath)}. Run: node sources-manifest.mjs write ${contentPath}`, 1);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (options.command === "status") {
    const problems = compare(manifest, content, sha(abs(contentPath)), hashOf);
    if (!problems.length) {
      console.log(`${contentPath}: current (${deps.size} cited files).`);
      return;
    }
    for (const problem of problems) console.log(`${problem.file}: ${problem.reason} (scenes ${problem.scenes.join(", ")})`);
    console.error(`sources-manifest: ${problems.length} stale dependencies. Review each changed page and its scenes, then run 'review' (meaning unchanged) or edit the content and run 'write'.`);
    process.exit(1);
  }

  if (!options.pages.length) fail("review needs at least one --page");
  if (!options.integrity.trim() || !options.readability.trim()) fail("review needs both --integrity and --readability conclusions");
  const changes = [];
  for (const page of options.pages) {
    const entry = manifest.sources[page];
    if (!entry) fail(`${page} is not in the manifest. A new citation changes the content: run 'write' after you review it.`);
    const hash = hashOf(page);
    if (hash === null) fail(`${page} is missing. Fix the citation in ${contentPath}.`);
    changes.push({ page, from: entry.sha256, to: hash, scenes: entry.scenes });
    entry.sha256 = hash;
  }
  manifest.reviews.push({ at: new Date().toISOString(), kind: "source-only", changes, integrity: options.integrity, readability: options.readability });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Recorded a source-only review of ${changes.length} pages in ${path.relative(top, manifestPath)}.`);
}

if (import.meta.filename === process.argv[1] || import.meta.filename === path.resolve(process.argv[1] ?? "")) main();
