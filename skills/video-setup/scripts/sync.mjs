#!/usr/bin/env node
// Copies the kit's engine into a project's scripts/video-kit/ and records a hash of every file
// in kit.lock.json.
// Usage: node sync.mjs <project>                          copy the kit in
//        node sync.mjs <project> --check                  fail if the copy is edited or behind this plugin
//        node sync.mjs <project> --discard-local-edits    replace kit files edited in the project
import fs from "node:fs";
import path from "node:path";
import { expected, integrity, staleness, sha, version, LOCK, PLUGIN } from "./engine/kit.mjs";

const source = import.meta.dirname;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node sync.mjs <project folder> [--check | --discard-local-edits]");
  process.exit(0);
}
const OPTIONS = ["--check", "--discard-local-edits"];
for (const a of args) if (a.startsWith("--") && !OPTIONS.includes(a)) throw new Error(`unknown option "${a}"; the options are ${OPTIONS.join(", ")}`);
const target = args.find((a) => !a.startsWith("--"));
if (!target) throw new Error("usage: node sync.mjs <project folder> [--check | --discard-local-edits]");
const root = path.resolve(target);
if (!fs.existsSync(path.join(root, ".git"))) throw new Error(`${root} is not the top of a git repository; sync the kit into the repository's top folder`);

if (args.includes("--check")) {
  const { errors } = integrity(root);
  errors.push(...staleness(root, source));
  if (errors.length) {
    for (const e of errors) console.error(`${PLUGIN}: ${e}`);
    process.exit(1);
  }
  console.log(`${PLUGIN}: ${root} has the current kit (${version(source)})`);
  process.exit(0);
}

const want = expected(source);
const old = fs.existsSync(path.join(root, LOCK)) ? JSON.parse(fs.readFileSync(path.join(root, LOCK), "utf8")) : { files: {} };
// Refuse to overwrite a local edit silently: it must move into the plugin first, or be discarded on purpose.
const edited = Object.entries(old.files).filter(([f, h]) => fs.existsSync(path.join(root, f)) && sha(fs.readFileSync(path.join(root, f))) !== h).map(([f]) => f);
if (edited.length && !args.includes("--discard-local-edits")) {
  throw new Error(`These kit files were edited in the project:\n  ${edited.join("\n  ")}\nMove the change into the plugin, or run again with --discard-local-edits to replace them.`);
}
for (const f of Object.keys(old.files)) if (!want.has(f)) fs.rmSync(path.join(root, f), { force: true });
for (const [f, body] of want) {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), body);
}
const files = Object.fromEntries([...want].map(([f, body]) => [f, sha(body)]).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(root, LOCK), JSON.stringify({ plugin: PLUGIN, version: version(source), files }, null, 1) + "\n");
console.log(`${PLUGIN} ${version(source)}: ${want.size} files synced into ${root}`);
