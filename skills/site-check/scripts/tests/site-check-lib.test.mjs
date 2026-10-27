// Tests for site-check-lib.mjs. Run with `node --test tests/*.test.mjs` in skills/site-check/scripts/.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as lib from "../site-check-lib.mjs";

const pages = Array.from({ length: 12 }, (_, i) => `/page-${i}`);

describe("seeded page sampling", () => {
  it("repeats the same order for the same branch", () => {
    const first = lib.shuffle(pages, lib.seededRandom(lib.seedFromBranch("style/hero")));
    const again = lib.shuffle(pages, lib.seededRandom(lib.seedFromBranch("style/hero")));
    assert.deepEqual(again, first);
    assert.deepEqual([...first].sort(), [...pages].sort());
  });

  it("uses a different order on a different branch", () => {
    const one = lib.shuffle(pages, lib.seededRandom(lib.seedFromBranch("style/hero")));
    const other = lib.shuffle(pages, lib.seededRandom(lib.seedFromBranch("fix/footer")));
    assert.notDeepEqual(other, one);
  });

  it("returns numbers between 0 and 1", () => {
    const random = lib.seededRandom(lib.seedFromBranch("main"));
    for (let i = 0; i < 100; i++) {
      const value = random();
      assert.ok(value >= 0 && value < 1, `got ${value}`);
    }
  });
});

describe("walkable links", () => {
  it("keeps same-site pages without fragments and drops files and other sites", () => {
    const links = lib.walkableLinks(
      [
        "http://localhost:3123/about#top",
        "http://localhost:3123/about",
        "http://localhost:3123/assets/logo.png",
        "https://example.com/",
        "mailto:hello@example.com",
        "not a url",
      ],
      "http://localhost:3123",
    );
    assert.deepEqual(links, ["http://localhost:3123/about"]);
  });
});

describe("live address", () => {
  it("matches the live host with and without www, on http and https", () => {
    const pattern = lib.liveAddressPattern("https://example.org/");
    assert.ok(pattern.test("https://example.org/a"));
    assert.ok(pattern.test("http://www.example.org"));
    assert.ok(!pattern.test("https://example.org.evil.test/"));
    assert.ok(!pattern.test("https://other.test/"));
  });

  it("escapes dots in the host name", () => {
    assert.ok(!lib.liveAddressPattern("https://example.org").test("https://exampleXorg/"));
  });

  it("refuses an address that is not a URL, naming it", () => {
    assert.throws(() => lib.liveAddressPattern("example"), /example/);
  });

  it("moves live sitemap addresses onto the site under test", () => {
    const xml = "<urlset><url><loc>https://www.example.org/</loc></url><url><loc> https://example.org/blog </loc></url></urlset>";
    assert.deepEqual(lib.sitemapPages(xml, "http://localhost:3123", lib.liveAddressPattern("https://example.org")), [
      "http://localhost:3123/",
      "http://localhost:3123/blog",
    ]);
  });

  it("keeps sitemap addresses as they are when no live address is given", () => {
    const xml = "<urlset><url><loc>http://localhost:3123/a</loc></url><url><loc>https://example.org/b</loc></url></urlset>";
    assert.deepEqual(lib.sitemapPages(xml, "http://localhost:3123"), ["http://localhost:3123/a"]);
  });
});

describe("page problems", () => {
  it("fails on script errors, console errors, failed requests and error responses", () => {
    assert.equal(lib.isPageProblem({ kind: "pageerror", text: "boom" }), true);
    assert.equal(lib.isPageProblem({ kind: "console", text: "boom" }), true);
    assert.equal(lib.isPageProblem({ kind: "requestfailed", text: "/a.js net::ERR_CONNECTION_REFUSED" }), true);
    assert.equal(lib.isPageProblem({ kind: "response", status: 500, text: "/api" }), true);
    assert.equal(lib.isPageProblem({ kind: "response", status: 404, text: "/a.png" }), true);
  });

  it("ignores cancelled requests, successful responses and bot blocks", () => {
    assert.equal(lib.isPageProblem({ kind: "requestfailed", text: "/a.js net::ERR_ABORTED" }), false);
    assert.equal(lib.isPageProblem({ kind: "response", status: 200, text: "/a.js" }), false);
    assert.equal(lib.isPageProblem({ kind: "response", status: 429, text: "https://example.com" }), false);
  });
});

describe("bypass headers and summary", () => {
  it("adds the Vercel bypass header only when the secret is set", () => {
    assert.deepEqual(lib.bypassHeaders({}), {});
    assert.equal(lib.bypassHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: "s" })["x-vercel-protection-bypass"], "s");
  });

  it("lists problems and warnings in plain English", () => {
    assert.equal(
      lib.summary({ tool: "link check", base: "https://example.org/", checked: "3 links", problems: [], warnings: [] }),
      "The link check found no problems on https://example.org/ (3 links checked).",
    );
    const text = lib.summary({ tool: "browser spider", base: "x", checked: "2 pages", problems: ["a"], warnings: ["b"] });
    assert.match(text, /found 1 problem on x/);
    assert.match(text, /- a/);
    assert.match(text, /turned the checker away/);
  });
});

describe("packages from the project", () => {
  it("pins an exact version for each package the checks need", () => {
    for (const name of ["linkinator", "@crawlee/puppeteer", "puppeteer-core"]) {
      assert.match(lib.PACKAGES[name] ?? "", /^\d+\.\d+\.\d+$/, name);
    }
  });

  it("names the install command for missing packages", () => {
    assert.equal(
      lib.installCommand(["linkinator"]),
      `npm install --save-dev --save-exact linkinator@${lib.PACKAGES.linkinator}`,
    );
  });

  it("refuses a missing package with code 2 and the install command", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "site-check-empty-"));
    try {
      assert.throws(
        () => lib.loadFromProject("linkinator", empty),
        (error) => {
          assert.equal(error.exitCode, 2);
          assert.match(error.message, /linkinator is not installed/);
          assert.match(error.message, new RegExp(`npm install --save-dev --save-exact linkinator@${lib.PACKAGES.linkinator.replace(/\./g, "\\.")}`));
          return true;
        },
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("loads a package from the project's node_modules", () => {
    const project = mkdtempSync(path.join(tmpdir(), "site-check-project-"));
    try {
      const dir = path.join(project, "node_modules", "linkinator");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "linkinator", version: "0.0.0", main: "index.js" }));
      writeFileSync(path.join(dir, "index.js"), "exports.marker = 'from the project';");
      assert.equal(lib.loadFromProject("linkinator", project).marker, "from the project");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not hide an error inside an installed package", () => {
    const project = mkdtempSync(path.join(tmpdir(), "site-check-broken-"));
    try {
      const dir = path.join(project, "node_modules", "linkinator");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "linkinator", main: "index.js" }));
      writeFileSync(path.join(dir, "index.js"), "require('a-dependency-that-is-missing');");
      assert.throws(() => lib.loadFromProject("linkinator", project), /a-dependency-that-is-missing/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("Chrome", () => {
  it("returns null when CHROME_PATH names a file that does not exist", () => {
    assert.equal(lib.findChrome({ CHROME_PATH: "/no/such/chrome" }), null);
  });
});
