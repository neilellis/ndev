#!/usr/bin/env node
// mobile-shots.mjs — capture mobile-viewport screenshots of a web app with
// Playwright device emulation (correct viewport width, DPR, mobile UA, touch).
//
// WHY Playwright and not browser-control tools: a browser extension can often not
// change the CSS layout viewport (window resize and zoom leave window.innerWidth
// unchanged), so it cannot emulate a device. Playwright device descriptors can.
//
// Usage:
//   WEB_DIR=<dir with @playwright/test> node mobile-shots.mjs --base URL
//       [--device NAME] [--out DIR] [--routes-file FILE.json] [route ...]
//
// Each route yields TWO PNGs: <name>-full.png (fullPage) and <name>-fold.png
// (above-the-fold, viewport crop). One log line per shot with the measured vw.
// Exit: 0 = every route captured; 1 = at least one route failed; 2 = could not run.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function die(message, fix) {
  console.error(`mobile-shots: ${message}`);
  if (fix) console.error(`  fix: ${fix}`);
  process.exit(2);
}

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { routes: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') opt.base = argv[++i];
  else if (a === '--device') opt.device = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--routes-file') opt.routesFile = argv[++i];
  else if (a === '--help' || a === '-h') opt.help = true;
  else opt.routes.push(a);
}

if (opt.help) {
  console.log(
    'WEB_DIR=<dir> node mobile-shots.mjs --base URL [--device NAME] [--out DIR] [--routes-file FILE.json] [route ...]',
  );
  process.exit(0);
}

const BASE = opt.base || process.env.BASE;
if (!BASE) die('no --base URL given, so there is no site to capture.', 'pass --base http://localhost:3000 (or set BASE)');
const DEVICE = opt.device || process.env.DEVICE || 'iPhone 13';
const OUT = opt.out || process.env.OUT || join(tmpdir(), 'mobile-shots');

// Routes: CLI args win; else --routes-file (JSON array of strings or {path,name});
// else a sensible default set.
let routes = opt.routes.map((path) => ({ path }));
if (routes.length === 0 && opt.routesFile) {
  routes = JSON.parse(readFileSync(opt.routesFile, 'utf8')).map((r) =>
    typeof r === 'string' ? { path: r } : r,
  );
}
if (routes.length === 0) routes = [{ path: '/' }];

// Playwright is resolved from the project that installs it (WEB_DIR), not globally.
const WEB_DIR = resolve(process.env.WEB_DIR || process.cwd());
let chromium, devices;
try {
  ({ chromium, devices } = createRequire(join(WEB_DIR, 'package.json'))('@playwright/test'));
} catch (e) {
  die(`cannot load @playwright/test from ${WEB_DIR}: ${e.message.split('\n')[0]}`,
    'set WEB_DIR to the package that depends on @playwright/test, or run: pnpm add -D @playwright/test && pnpm exec playwright install chromium');
}
console.info('Resolved Playwright from ' + WEB_DIR);

const device = devices[DEVICE];
if (!device) {
  console.error(
    `Unknown device "${DEVICE}". Try one of: ${Object.keys(devices)
      .filter((d) => /iPhone|Pixel|Galaxy/.test(d))
      .join(', ')}`,
  );
  process.exit(2);
}

// slugify a route into a filename stem: '/' -> 'home', '/council/123' -> 'council-123'
function slug(path) {
  const s = path.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  const clean = s.replace(/^\/|\/$/g, '').replace(/[^\w.-]+/g, '-');
  return clean || 'home';
}

mkdirSync(OUT, { recursive: true });

// NOTE: devices['iPhone 13'].defaultBrowserType is 'webkit'; we intentionally launch
// chromium and spread the descriptor for viewport/UA/DPR/touch — this matches Chrome
// DevTools "device mode", which is what a reviewer eyeballs.
const browser = await chromium.launch();
const context = await browser.newContext({ ...device });
const page = await context.newPage();

console.log(`base=${BASE} device=${DEVICE} out=${OUT}`);

const failed = [];
for (const { path, name } of routes) {
  const url = path.startsWith('http') ? path : BASE + path;
  const stem = name || slug(path);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    console.error(`goto FAIL ${url}: ${e.message}`);
    failed.push(url);
    continue;
  }
  await page.waitForTimeout(800);
  const vw = await page.evaluate(() => window.innerWidth);
  await page.screenshot({ path: join(OUT, `${stem}-full.png`), fullPage: true });
  await page.screenshot({ path: join(OUT, `${stem}-fold.png`), fullPage: false });
  console.log(`shot ${stem} vw=${vw} <- ${url}`);
}

await browser.close();
console.log(`done -> ${OUT}`);
if (failed.length) {
  console.error(`mobile-shots: ${failed.length} of ${routes.length} route(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
