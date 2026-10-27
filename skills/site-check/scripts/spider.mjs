#!/usr/bin/env node
// Browser spider: walk a random sample of up to 20 pages in Chrome with Crawlee and report errors.
//
// Usage (run in the project root, where @crawlee/puppeteer and puppeteer-core are installed):
//   node <this folder>/spider.mjs <url> [--branch <name>] [--limit <n>] [--live <live site url>]
//
// Starts at <url>, then picks from the pages in <url>/sitemap.xml and same-site links in a random order seeded from the branch name, so each
// branch samples different pages but the same branch repeats its sample. On each page it records:
// a failed page load (4xx or 5xx), uncaught JavaScript errors, console errors, failed requests,
// and links on the page to same-site addresses that return 4xx or 5xx.
// Works on a local server, a Vercel preview (set VERCEL_AUTOMATION_BYPASS_SECRET) or the live site.
// With --live (or SITE_CHECK_LIVE_URL), live addresses in the sitemap move onto the site under test.
//
// Exit codes: 0 no problems, 1 problems found, 2 the spider could not run.
/* global fetch, AbortSignal */
import { spawnSync } from "node:child_process";
import {
  SPIDER_PAGE_LIMIT,
  bypassHeaders,
  findChrome,
  installCommand,
  isPageProblem,
  liveAddressPattern,
  loadFromProject,
  seedFromBranch,
  seededRandom,
  shuffle,
  sitemapPages,
  summary,
  walkableLinks,
} from "./site-check-lib.mjs";

const USAGE = "usage: spider.mjs <url> [--branch <name>] [--limit <n>] [--live <live site url>]";

function parseArgs(argv, env) {
  const options = { base: "", branch: "", limit: SPIDER_PAGE_LIMIT, live: env.SITE_CHECK_LIVE_URL ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--branch") options.branch = argv[++i] ?? "";
    else if (arg === "--live") options.live = argv[++i] ?? "";
    else if (arg === "--limit") options.limit = Number(argv[++i]);
    else if (!options.base) options.base = arg;
    else throw new Error(`unknown argument '${arg}'; ${USAGE}`);
  }
  if (!options.base) throw new Error(USAGE);
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be a positive whole number");
  return options;
}

function currentBranch(env) {
  if (env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
  const git = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" });
  if (git.status !== 0 || !git.stdout.trim()) throw new Error("cannot tell the branch; pass --branch");
  return git.stdout.trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const loaded = {};
  const missing = [];
  for (const name of ["@crawlee/puppeteer", "puppeteer-core"]) {
    try {
      loaded[name] = loadFromProject(name, process.cwd());
    } catch (error) {
      if (error.exitCode !== 2) throw error;
      missing.push(name);
    }
  }
  if (missing.length) {
    const error = new Error(`${missing.join(" and ")} not installed in ${process.cwd()}. Run: ${installCommand(missing)}`);
    error.exitCode = 2;
    throw error;
  }
  const { Configuration, PuppeteerCrawler } = loaded["@crawlee/puppeteer"];
  const puppeteerModule = loaded["puppeteer-core"];
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const branch = options.branch || currentBranch(process.env);
  const origin = new URL(options.base).origin;
  const random = seededRandom(seedFromBranch(branch));
  const headers = bypassHeaders(process.env);
  const chromePath = findChrome();
  if (!chromePath) {
    const reason = process.env.CHROME_PATH ? `CHROME_PATH (${process.env.CHROME_PATH}) does not exist` : "no Chrome or Chromium found";
    throw new Error(`${reason}; install Chrome or set CHROME_PATH to its executable`);
  }

  const problems = [];
  const visited = [];
  const linkStatus = new Map();
  const events = new WeakMap();

  async function statusOf(url) {
    if (!linkStatus.has(url)) {
      let status = 0;
      try {
        status = (await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(20000) })).status;
      } catch {
        status = 0;
      }
      linkStatus.set(url, status);
    }
    return linkStatus.get(url);
  }

  const crawler = new PuppeteerCrawler(
    {
      launchContext: {
        launcher: puppeteer,
        launchOptions: { executablePath: chromePath, headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] },
      },
      browserPoolOptions: { useFingerprints: false },
      maxRequestsPerCrawl: options.limit,
      // One page at a time keeps the random sample the same for a branch.
      maxConcurrency: 1,
      maxRequestRetries: 1,
      navigationTimeoutSecs: 45,
      requestHandlerTimeoutSecs: 120,
      preNavigationHooks: [
        async ({ page }, gotoOptions) => {
          const seen = [];
          events.set(page, seen);
          page.on("pageerror", (error) => seen.push({ kind: "pageerror", text: error.message }));
          page.on("console", (message) => {
            if (message.type() === "error") seen.push({ kind: "console", text: message.text() });
          });
          page.on("requestfailed", (request) => seen.push({ kind: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}` }));
          page.on("response", (response) => {
            if (!response.request().isNavigationRequest()) seen.push({ kind: "response", status: response.status(), text: response.url() });
          });
          if (Object.keys(headers).length) {
            // Send the bypass secret to the site under test only, never to other sites.
            await page.setRequestInterception(true);
            page.on("request", (request) => {
              const sameSite = request.url().startsWith(origin);
              request.continue(sameSite ? { headers: { ...request.headers(), ...headers } } : undefined);
            });
          }
          gotoOptions.waitUntil = "networkidle2";
        },
      ],
      async requestHandler({ page, request, response }) {
        const url = request.loadedUrl ?? request.url;
        visited.push(url);
        const status = response?.status() ?? 0;
        if (status >= 400) problems.push(`${url} returned ${status}`);
        for (const event of (events.get(page) ?? []).filter(isPageProblem)) {
          const label = { pageerror: "JavaScript error", console: "console error", requestfailed: "request failed", response: `request returned ${event.status}` }[event.kind];
          problems.push(`${url}: ${label}: ${event.text.slice(0, 300)}`);
        }
        const hrefs = await page.$$eval("a[href]", (anchors) => anchors.map((anchor) => anchor.href));
        const links = walkableLinks(hrefs, origin);
        for (const link of links) {
          const linkCode = await statusOf(link);
          if (linkCode === 0 || linkCode >= 400) problems.push(`${url} links to ${link}, which returned ${linkCode || "no response"}`);
        }
        const next = shuffle(links, random).filter((link) => linkStatus.get(link) < 400 && linkStatus.get(link) > 0);
        for (const link of next) await crawler.addRequests([{ url: link }], { forefront: random() < 0.5 });
      },
      failedRequestHandler({ request }, error) {
        problems.push(`${request.url} could not be loaded: ${error.message.split("\n")[0]}`);
      },
    },
    new Configuration({ persistStorage: false, purgeOnStart: true }),
  );

  const sitemap = await fetch(new URL("/sitemap.xml", origin), { headers, signal: AbortSignal.timeout(20000) });
  if (!sitemap.ok) throw new Error(`${new URL("/sitemap.xml", origin)} returned ${sitemap.status}`);
  const livePattern = options.live ? liveAddressPattern(options.live) : undefined;
  const sitemapLinks = shuffle(sitemapPages(await sitemap.text(), origin, livePattern), random);

  console.log(`Walking up to ${options.limit} pages of ${options.base} in Chrome, in a random order for branch ${branch}.`);
  await crawler.addRequests([options.base]);
  await crawler.addRequests(sitemapLinks.map((url) => ({ url })));
  await crawler.run();
  console.log(`Pages visited:\n${visited.map((url) => `- ${url}`).join("\n")}`);
  console.log(summary({ tool: "browser spider", base: options.base, checked: `${visited.length} pages`, problems: [...new Set(problems)], warnings: [] }));
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`The browser spider could not run: ${error.exitCode === 2 ? error.message : (error.stack ?? error.message)}`);
  process.exit(2);
});
