#!/usr/bin/env node
// Preflight link check: crawl every page of a site with linkinator and report broken links.
//
// Usage (run in the project root, where linkinator is installed):
//   node <this folder>/links.mjs <url> [--live <live site url>]
//
// Works on a local server, a Vercel preview (set VERCEL_AUTOMATION_BYPASS_SECRET) or the live site.
// Visits every page on the site: every page listed in <url>/sitemap.xml and every page reachable by
// following links from them. Checks every link and image on those pages, including links to other sites.
// With --live (or SITE_CHECK_LIVE_URL), addresses on the live host (as the sitemap often lists them)
// are checked on the site under test instead.
// Sites that turn checkers away (401, 403, 429, 999) are listed as warnings, not failures.
//
// Exit codes: 0 no broken links, 1 broken links found, 2 the check could not run.
import { BOT_BLOCK_CODES, bypassHeaders, liveAddressPattern, loadFromProject, summary } from "./site-check-lib.mjs";

const USAGE = "usage: links.mjs <url> [--live <live site url>]";

function parseArgs(argv, env) {
  const options = { base: "", live: env.SITE_CHECK_LIVE_URL ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--live") options.live = argv[++i] ?? "";
    else if (!options.base) options.base = arg;
    else throw new Error(`unknown argument '${arg}'; ${USAGE}`);
  }
  if (!options.base) throw new Error(USAGE);
  return options;
}

async function main() {
  const { base, live } = parseArgs(process.argv.slice(2), process.env);
  const { LinkState, check } = loadFromProject("linkinator", process.cwd());
  const origin = new URL(base).origin;
  const statusCodes = Object.fromEntries(BOT_BLOCK_CODES.map((code) => [String(code), "warn"]));
  const common = { concurrency: 20, timeout: 20000, retryErrors: true, retryErrorsCount: 2, statusCodes };
  const rewrite = live ? [{ pattern: liveAddressPattern(live), replacement: origin }] : [];
  const site = { recurse: true, sitemap: true, urlRewriteExpressions: rewrite };
  const headers = bypassHeaders(process.env);
  const skipNonWeb = (link) => link.startsWith("mailto:") || link.startsWith("tel:");
  let result;
  if (Object.keys(headers).length) {
    // linkinator sends headers with every request, so keep the bypass secret on the site under test:
    // crawl the site with it, then check links to other sites in a second pass without it.
    const crawled = await check({ ...common, ...site, path: base, headers, linksToSkip: async (link) => skipNonWeb(link) || !link.startsWith(origin) });
    const external = [...new Set(crawled.links.filter((link) => link.state === LinkState.SKIPPED && /^https?:/.test(link.url)).map((link) => link.url))];
    const outside = external.length ? await check({ ...common, path: external, recurse: false }) : { links: [] };
    const parents = new Map(crawled.links.filter((link) => link.state === LinkState.SKIPPED).map((link) => [link.url, link.parent]));
    result = { links: [...crawled.links.filter((link) => link.state !== LinkState.SKIPPED), ...outside.links.map((link) => ({ ...link, parent: link.parent ?? parents.get(link.url) }))] };
  } else {
    result = await check({ ...common, ...site, path: base, linksToSkip: async (link) => skipNonWeb(link) });
  }
  const pages = new Set(result.links.filter((link) => link.url.startsWith(origin)).map((link) => link.url));
  const problems = result.links
    .filter((link) => link.state === LinkState.BROKEN)
    .map((link) => `${link.url} (${link.status || "no response"}) linked from ${link.parent ?? "the start page"}`);
  const warnings = result.links
    .filter((link) => link.state !== LinkState.BROKEN && BOT_BLOCK_CODES.includes(link.status ?? 0))
    .map((link) => `${link.url} (${link.status})`);
  console.log(summary({ tool: "link check", base, checked: `${result.links.length} links across ${pages.size} site addresses`, problems, warnings }));
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`The link check could not run: ${error.exitCode === 2 ? error.message : (error.stack ?? error.message)}`);
  process.exit(2);
});
