#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(SITE_ROOT, "out");
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

if (!fs.existsSync(OUT_DIR)) {
  console.error("Missing out/ directory. Run `npm run build` first.");
  process.exit(1);
}

if (!fs.existsSync(path.join(OUT_DIR, ".nojekyll"))) {
  console.error("Missing out/.nojekyll (required for GitHub Pages to serve _next/).");
  process.exit(1);
}

if (!fs.existsSync(path.join(OUT_DIR, "search-index.json"))) {
  console.error("Missing out/search-index.json.");
  process.exit(1);
}

function walkHtml(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, acc);
    else if (entry.name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

const htmlFiles = walkHtml(OUT_DIR);
const broken = [];

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  const relFile = path.relative(OUT_DIR, file);
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rawHref = m[1];
    if (
      !rawHref ||
      rawHref.startsWith("http://") ||
      rawHref.startsWith("https://") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("#") ||
      rawHref.startsWith("data:")
    ) {
      continue;
    }

    const [hrefPath] = rawHref.split(/[?#]/);
    if (!hrefPath.startsWith("/")) continue;

    let localPath = hrefPath;
    if (BASE_PATH) {
      if (localPath === BASE_PATH || localPath === `${BASE_PATH}/`) {
        localPath = "/";
      } else if (localPath.startsWith(`${BASE_PATH}/`)) {
        localPath = localPath.slice(BASE_PATH.length);
      } else {
        broken.push(`${relFile}: href="${rawHref}" is missing basePath "${BASE_PATH}"`);
        continue;
      }
    }

    const candidates = [
      path.join(OUT_DIR, localPath),
      path.join(OUT_DIR, localPath, "index.html"),
      path.join(OUT_DIR, `${localPath.replace(/\/$/, "")}.html`),
    ];
    const exists = candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!exists) {
      broken.push(`${relFile}: broken internal link "${rawHref}"`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Found ${broken.length} broken link(s) in out/:`);
  for (const line of broken.slice(0, 40)) {
    console.error(`  - ${line}`);
  }
  process.exit(1);
}

console.log(`Verified ${htmlFiles.length} HTML files in out/ (basePath="${BASE_PATH || "/"}"): 0 broken internal links.`);
