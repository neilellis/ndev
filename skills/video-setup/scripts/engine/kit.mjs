// The kit's copy in a project: which files it owns, whether anyone edited them, and whether the
// plugin has a newer version. A project holds the engine in scripts/video-kit/, and
// kit.lock.json records a hash of each file. The kit's source is the video-setup skill's scripts/
// folder in the ndev plugin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const PLUGIN = "video-kit";
export const PLUGIN_ID = "ndev";
export const SKILL_PATH = "skills/video-setup/scripts";
export const ENV = "VIDEO_KIT_SOURCE";
export const ENGINE_DIR = "scripts/video-kit";
export const LOCK = `${ENGINE_DIR}/kit.lock.json`;
const REPAIR = "Run the video-setup skill to sync the kit again";

export const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Dotfiles such as .DS_Store are never part of the kit, on either side.
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? walk(f, base) : [path.relative(base, f)];
  });
}

// Every file the kit puts in a project, as project path → content, built from the kit's source.
export function expected(source) {
  const out = new Map();
  for (const f of walk(path.join(source, "engine"))) out.set(`${ENGINE_DIR}/${f}`, fs.readFileSync(path.join(source, "engine", f)));
  return out;
}

// Compares two "major.minor.patch" versions: negative, zero or positive.
export function compare(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const version = (source) => JSON.parse(fs.readFileSync(path.join(source, "kit.json"), "utf8")).version;

export function readLock(root) {
  const f = path.join(root, LOCK);
  if (!fs.existsSync(f)) throw new Error(`${LOCK} is missing, so the kit's files cannot be checked. ${REPAIR}.`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// Files the project changed or lost since the last sync. The kit is edited in the plugin, never in a project.
export function integrity(root) {
  const lock = readLock(root);
  const errors = [];
  for (const [f, hash] of Object.entries(lock.files)) {
    const file = path.join(root, f);
    if (!fs.existsSync(file)) errors.push(`${f} is missing. ${REPAIR}.`);
    else if (sha(fs.readFileSync(file)) !== hash) errors.push(`${f} was edited in this project. Make the change in the plugin (${PLUGIN_ID}, ${SKILL_PATH}/engine), then sync it here. ${REPAIR} to undo the local edit.`);
  }
  if (fs.existsSync(path.join(root, ENGINE_DIR))) {
    for (const f of walk(path.join(root, ENGINE_DIR)).map((f) => `${ENGINE_DIR}/${f}`)) {
      if (f !== LOCK && !(f in lock.files)) errors.push(`${f} is not part of the kit. Move project files out of ${ENGINE_DIR}.`);
    }
  }
  return { lock, errors };
}

// Differences between the project's copy and the kit's source.
export function staleness(root, source) {
  const lock = readLock(root);
  const want = expected(source);
  const errors = [];
  for (const [f, body] of want) if (lock.files[f] !== sha(body)) errors.push(`${f} ${f in lock.files ? "differs from" : "is missing from"} the plugin`);
  for (const f of Object.keys(lock.files)) if (!want.has(f)) errors.push(`${f} is no longer in the plugin`);
  if (!errors.length) return [];
  const newer = compare(lock.version, version(source)) > 0;
  const head = newer
    ? `The kit copy (${lock.version}) is newer than the plugin at ${source} (${version(source)}). Do not sync from it: update the plugin in Claude Code (/plugin), or set ${ENV} to the ${SKILL_PATH} folder of a current ${PLUGIN_ID} clone.`
    : `The kit copy (${lock.version}) differs from the plugin at ${source} (${version(source)}). ${REPAIR}:`;
  return [head, ...errors.map((e) => `  ${e}`)];
}

// Where the kit's source is on this machine: VIDEO_KIT_SOURCE, Claude Code's installed copy of the
// plugin, or its marketplace clone. Returns null when none is present, for example in CI.
export function findSource(root) {
  const looks = (dir) => dir && fs.existsSync(path.join(dir, "kit.json")) && fs.existsSync(path.join(dir, "engine/kit.mjs"));
  if (process.env[ENV]) {
    if (!looks(process.env[ENV])) throw new Error(`${ENV} is set to ${process.env[ENV]}, which has no kit.json and engine/kit.mjs. Set it to the ${SKILL_PATH} folder of a ${PLUGIN_ID} clone, or unset it.`);
    return { dir: process.env[ENV], via: ENV };
  }
  const plugins = path.join(os.homedir(), ".claude/plugins");
  const installed = path.join(plugins, "installed_plugins.json");
  if (fs.existsSync(installed)) {
    const all = JSON.parse(fs.readFileSync(installed, "utf8")).plugins ?? {};
    const entries = Object.entries(all).filter(([k]) => k.startsWith(`${PLUGIN_ID}@`)).flatMap(([, v]) => v);
    const pick = entries.find((e) => e.projectPath === root) ?? entries.find((e) => e.scope === "user") ?? entries[0];
    if (pick) {
      const dir = path.join(pick.installPath ?? "", SKILL_PATH);
      if (!looks(dir)) throw new Error(`Claude Code lists ${PLUGIN_ID} as installed at ${pick.installPath}, which is missing or has no ${SKILL_PATH}. Reinstall the plugin in Claude Code (/plugin), then run the check again.`);
      return { dir, via: `Claude Code plugin ${pick.version} at ${pick.installPath}` };
    }
  }
  const clone = path.join(plugins, "marketplaces", PLUGIN_ID, SKILL_PATH);
  if (looks(clone)) return { dir: clone, via: "Claude Code marketplace clone" };
  return null;
}
