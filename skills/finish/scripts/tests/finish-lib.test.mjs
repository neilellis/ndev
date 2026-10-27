// Tests for the /finish decision logic. Run with `node --test tests/*.test.mjs`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROUNDS, checkPage, evaluate, failureSignature, firstErrorLine, nextRound, pagesForFiles, previewLinks, readyMessage } from "../finish-lib.mjs";

const head = "abc123";
const green = {
  state: "OPEN",
  isDraft: true,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: head,
  statusCheckRollup: [
    { __typename: "CheckRun", name: "checks", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/x/actions/runs/1/job/2" },
    { __typename: "StatusContext", context: "Preview", state: "SUCCESS", targetUrl: "https://deploy.example.com/x" },
  ],
};
const ready = { state: "success", url: "https://preview.example.com" };

describe("finish evaluate", () => {
  it("is ready only when checks pass, GitHub says mergeable and clean, and the preview is ready", () => {
    assert.equal(evaluate(green, head, ready).outcome, "ready");
  });

  it("asks for a fix when a check failed, with its run link", () => {
    const pr = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "FAILURE" }] };
    const verdict = evaluate(pr, head, ready);
    assert.equal(verdict.outcome, "fix");
    assert.match(verdict.failed[0].link, /\/actions\/runs\/1\//);
  });

  it("treats cancelled, skipped and missing checks as not passed", () => {
    const cancelled = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "CANCELLED" }] };
    assert.equal(evaluate(cancelled, head, ready).outcome, "fix");
    const skipped = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "SKIPPED" }] };
    assert.equal(evaluate(skipped, head, ready).outcome, "fix");
    assert.equal(evaluate({ ...green, statusCheckRollup: [] }, head, ready).outcome, "wait");
  });

  it("asks for a fix on a merge conflict or a failed preview build", () => {
    assert.equal(evaluate({ ...green, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, head, ready).outcome, "fix");
    const failedPreview = evaluate(green, head, { state: "failure", url: "https://p.example.com" });
    assert.equal(failedPreview.outcome, "fix");
    assert.equal(failedPreview.failed[0].link, "https://p.example.com");
  });

  it("waits while checks run, mergeability is unknown or the preview is building", () => {
    const running = { ...green, statusCheckRollup: [{ __typename: "CheckRun", name: "checks", status: "IN_PROGRESS", conclusion: "" }] };
    assert.equal(evaluate(running, head, ready).outcome, "wait");
    assert.equal(evaluate({ ...green, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, head, ready).outcome, "wait");
    assert.equal(evaluate(green, head, { state: "pending", url: "" }).outcome, "wait");
    assert.equal(evaluate(green, head, null).outcome, "wait");
  });

  it("stops when the pull request is closed, someone else pushed, or GitHub blocks the merge", () => {
    assert.equal(evaluate({ ...green, state: "MERGED" }, head, ready).outcome, "blocked");
    assert.equal(evaluate(green, "other", ready).outcome, "blocked");
    assert.equal(evaluate({ ...green, mergeStateStatus: "BLOCKED" }, head, ready).outcome, "blocked");
  });
});

describe("finish round limits", () => {
  it("stops when the same failure repeats", () => {
    const first = nextRound(undefined, "checks: Type error: x");
    assert.equal(first.stop, false);
    assert.equal(nextRound(first.state, "checks: Type error: x").stop, true);
    assert.equal(nextRound(first.state, "checks: Lint error: y").stop, false);
  });

  it(`stops after ${MAX_ROUNDS} rounds`, () => {
    let state;
    for (let round = 1; round < MAX_ROUNDS; round++) {
      const next = nextRound(state, `failure ${round}`);
      assert.equal(next.stop, false);
      state = next.state;
    }
    assert.equal(nextRound(state, "another failure").stop, true);
  });

  it("fingerprints failures by check and first error line, ignoring timestamps", () => {
    const a = firstErrorLine("checks\tbuild\t2026-10-13T12:00:01.123Z Type error: bad prop\nmore");
    const b = firstErrorLine("checks\tbuild\t2026-10-13T13:30:09.999Z Type error: bad prop");
    assert.equal(a, b);
    assert.equal(failureSignature([{ name: "checks", state: "failed", link: "", error: a }]), `checks: ${a}`);
  });
});

describe("finish changed pages", () => {
  it("maps Next.js app router pages to their routes, without route groups", () => {
    assert.deepEqual(
      pagesForFiles(["app/page.tsx", "app/about/page.tsx", "app/(marketing)/pricing/page.mdx", "src/app/blog/news/page.jsx", "app/(site)/page.ts"]),
      ["/", "/about", "/blog/news", "/pricing"],
    );
  });

  it("skips app routes that have no single URL or are not pages", () => {
    assert.deepEqual(
      pagesForFiles([
        "app/blog/[slug]/page.tsx",
        "app/@modal/login/page.tsx",
        "app/_private/page.tsx",
        "app/about/layout.tsx",
        "app/api/route.ts",
        "app/about/page.module.css",
      ]),
      ["/login"],
    );
  });

  it("maps pages router files to their routes, without API routes or special files", () => {
    assert.deepEqual(
      pagesForFiles([
        "pages/index.tsx",
        "pages/about.js",
        "pages/blog/index.mdx",
        "src/pages/team/people.tsx",
        "pages/api/hello.ts",
        "pages/_app.tsx",
        "pages/_document.tsx",
        "pages/posts/[id].tsx",
      ]),
      ["/", "/about", "/blog", "/team/people"],
    );
  });

  it("finds no pages for other files", () => {
    assert.deepEqual(pagesForFiles(["components/Header.tsx", "content/home.ts", "styles/site.css", "README.md", "lib/app/page.tsx"]), []);
  });

  it("accepts only site paths that start with /", () => {
    assert.equal(checkPage("/about"), "/about");
    assert.equal(checkPage("/"), "/");
    assert.throws(() => checkPage("about"), /--page/);
    assert.throws(() => checkPage("https://example.com/about"), /--page/);
    assert.throws(() => checkPage(""), /--page/);
    assert.throws(() => checkPage("/a b"), /--page/);
  });
});

describe("finish report", () => {
  it("links each changed page on the preview, or the home page when none changed", () => {
    assert.deepEqual(previewLinks("https://p.example.com/", ["/", "/about"]), ["https://p.example.com/", "https://p.example.com/about"]);
    assert.deepEqual(previewLinks("https://p.example.com", []), ["https://p.example.com/"]);
  });

  it("gives plain links to the pull request and each preview page", () => {
    const text = readyMessage({ prUrl: "https://github.com/pr/1", previewUrl: "https://p.example.com", pages: ["/pricing"], markedReady: true });
    assert.match(text, /Pull request: https:\/\/github\.com\/pr\/1/);
    assert.match(text, /- https:\/\/p\.example\.com\/pricing/);
    assert.match(text, /out of draft/);
    assert.match(text, /\/publish/);
    assert.doesNotMatch(text, /film|scene/i);
  });
});
