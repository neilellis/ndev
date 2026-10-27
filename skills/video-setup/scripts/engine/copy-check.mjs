#!/usr/bin/env node
// Checks the video's text with Vale. Run it in the video's folder. It checks the paths listed
// under "copy" in video.config.json.
// Usage: node scripts/video-kit/copy-check.mjs [--settings <URL or path of a vale.ini>]
// The Vale settings come from, in order: --settings, the VALE_SETTINGS environment variable, or
// the .vale.ini in the video's folder. There is no default. A URL is downloaded into .vale.ini,
// marked with a first line that names the URL; a .vale.ini without that mark is never replaced.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node scripts/video-kit/copy-check.mjs [--settings <URL or path of a vale.ini>]\nWithout --settings it uses VALE_SETTINGS, then the .vale.ini in the video's folder.");
  process.exit(0);
}
const at = argv.indexOf("--settings");
if (at !== -1 && !argv[at + 1]) throw new Error("--settings needs a URL or a path to a vale.ini");
const config = loadConfig();
const root = config.root;
if (!config.copy.length) throw new Error(`video.config.json lists no "copy" paths to check; add the page, the script and the instructions`);
const missing = config.copy.filter((p) => !existsSync(join(root, p)));
if (missing.length) throw new Error(`video.config.json lists copy paths that do not exist: ${missing.join(", ")}`);

try {
  execFileSync("vale", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("Vale is not installed. Install it from https://vale.sh/docs/install, then run the copy check again.");
}

const local = join(root, ".vale.ini");
const MARK = "# Downloaded by the video kit's copy check from ";
const source = at !== -1 ? argv[at + 1] : process.env.VALE_SETTINGS || null;
let ini;
if (source && /^https?:\/\//.test(source)) {
  if (existsSync(local) && !readFileSync(local, "utf8").startsWith(MARK)) {
    throw new Error(`${local} is the project's own Vale settings, so the copy check will not replace it with ${source}. Pass --settings ${local}, or move that file away.`);
  }
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Could not download the Vale settings: ${source} returned ${res.status}`);
  writeFileSync(local, `${MARK}${source}\n${await res.text()}`);
  ini = local;
} else if (source) {
  ini = resolve(source);
  if (!existsSync(ini)) throw new Error(`The Vale settings ${ini} do not exist. Pass --settings with a URL or a path to a vale.ini.`);
} else if (existsSync(local)) {
  ini = local;
} else {
  throw new Error(`No Vale settings: pass --settings <URL or path>, set VALE_SETTINGS, or add a .vale.ini to ${root}.`);
}

const run = (args) => execFileSync("vale", [`--config=${ini}`, ...args], { cwd: root, stdio: "inherit" });
run(["sync"]);
// Vale exits non-zero only on errors. Rules at warning or suggestion level are reported without
// failing, so the check fails on broken settings, broken files or error-level findings.
run(["--no-wrap", ...config.copy]);
