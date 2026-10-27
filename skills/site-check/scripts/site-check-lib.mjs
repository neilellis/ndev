// Helpers for links.mjs and spider.mjs. Tested in tests/site-check-lib.test.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/** Pages the CI spider visits at most. */
export const SPIDER_PAGE_LIMIT = 20;

/** The exact package versions the checks are written for. The target project installs them. */
export const PACKAGES = { linkinator: "8.1.0", "@crawlee/puppeteer": "3.18.2", "puppeteer-core": "25.12.0" };

/** The command that installs the named packages at their pinned versions. */
export function installCommand(names) {
  return `npm install --save-dev --save-exact ${names.map((name) => `${name}@${PACKAGES[name]}`).join(" ")}`;
}

/**
 * Load a package from the target project's node_modules (the plugin has none). A missing package
 * throws an error with exitCode 2 that names the install command. Other load errors are not hidden.
 */
export function loadFromProject(name, projectDir) {
  const require = createRequire(path.join(path.resolve(projectDir), "package.json"));
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    const missing = new Error(`${name} is not installed in ${path.resolve(projectDir)}. Run: ${installCommand([name])}`);
    missing.exitCode = 2;
    throw missing;
  }
  return require(resolved);
}

/**
 * A pattern for the live site's address, with or without www, as pages and the sitemap write it.
 * Matches move onto the site under test, so a local or preview check does not test the live site.
 */
export function liveAddressPattern(liveUrl) {
  let host;
  try {
    host = new URL(liveUrl).hostname.replace(/^www\./, "");
  } catch {
    throw new Error(`the live address '${liveUrl}' is not a URL; pass it as https://<host>/`);
  }
  return new RegExp(`^https?://(?:www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`);
}

/** Status codes sites use to turn away automated checkers. They are reported, not failed. */
export const BOT_BLOCK_CODES = [401, 403, 429, 999];

/** A 32-bit seed from a branch name (FNV-1a), so each branch samples its own pages. */
export function seedFromBranch(branch) {
  let hash = 0x811c9dc5;
  for (const char of branch) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A seeded random number generator (mulberry32) returning numbers in [0, 1). */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy of items (Fisher-Yates) using the given random function. */
export function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * The same-site pages worth walking from a page's links: http(s) on the start origin, without
 * fragments, and not files such as images or PDFs.
 */
export function walkableLinks(hrefs, origin) {
  const pages = new Set();
  for (const href of hrefs) {
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (/\.(?:pdf|png|jpe?g|gif|svg|webp|avif|ico|xml|txt|json|zip|mp4|webm)$/i.test(url.pathname)) continue;
    url.hash = "";
    pages.add(url.href);
  }
  return [...pages].sort();
}

/**
 * The page addresses in a sitemap on the site under test. If livePattern is given, live addresses
 * (as the sitemap often lists them) move onto the site under test first.
 */
export function sitemapPages(xml, origin, livePattern) {
  const locations = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => (livePattern ? match[1].replace(livePattern, origin) : match[1]));
  return walkableLinks(locations, origin);
}

/** Headers that open a protected Vercel deployment, when a bypass secret is configured. */
export function bypassHeaders(env) {
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" } : {};
}

/** Whether a page-level browser event is an error worth failing on. */
export function isPageProblem(event) {
  if (event.kind === "requestfailed") return !/ERR_ABORTED/.test(event.text);
  if (event.kind === "response") return event.status >= 400 && !BOT_BLOCK_CODES.includes(event.status);
  return event.kind === "pageerror" || event.kind === "console";
}

/** The plain-English summary shown to the user after a check. */
export function summary({ tool, base, checked, problems, warnings }) {
  const lines = [];
  if (!problems.length) lines.push(`The ${tool} found no problems on ${base} (${checked} checked).`);
  else {
    lines.push(`The ${tool} found ${problems.length} problem${problems.length === 1 ? "" : "s"} on ${base} (${checked} checked):`);
    for (const problem of problems) lines.push(`- ${problem}`);
  }
  if (warnings.length) {
    lines.push("These sites turned the checker away, so their links could not be checked:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

/** The path to Chrome or Chromium: CHROME_PATH, the usual install places, or a Playwright download. */
export function findChrome(env = process.env) {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  if (process.platform === "win32") {
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)) {
      const windows = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(windows)) return windows;
    }
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  const playwright = path.join(homedir(), ".cache", "ms-playwright");
  if (existsSync(playwright)) {
    for (const dir of readdirSync(playwright).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      const linux = path.join(playwright, dir, "chrome-linux", "chrome");
      if (existsSync(linux)) return linux;
    }
  }
  return null;
}
