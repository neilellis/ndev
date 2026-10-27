// Tests for the /finish decision logic. Run with `node --test tests/*.test.mjs`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROUNDS,
  evaluate,
  failureSignature,
  filmSections,
  firstErrorLine,
  nextRound,
  previewLinks,
  readyMessage,
  scenesForChanges,
} from "../finish-lib.mjs";

const expect = (actual) => ({
  toBe: (expected) => assert.equal(actual, expected),
  toEqual: (expected) => assert.deepEqual(actual, expected),
  toContain: (part) => assert.ok(actual.includes(part), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(part)}`),
  not: { toContain: (part) => assert.ok(!actual.includes(part), `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(part)}`) },
});

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
  it("is ready only when checks pass, GitHub says mergeable and clean, and the preview is Ready", () => {
    expect(evaluate(green, head, ready).outcome).toBe("ready");
  });

  it("asks for a fix when a check failed, with its run link", () => {
    const pr = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "FAILURE" }] };
    const verdict = evaluate(pr, head, ready);
    expect(verdict.outcome).toBe("fix");
    expect(verdict.failed[0].link).toContain("/actions/runs/1/");
  });

  it("treats cancelled, skipped and missing checks as not passed", () => {
    const cancelled = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "CANCELLED" }] };
    expect(evaluate(cancelled, head, ready).outcome).toBe("fix");
    const skipped = { ...green, statusCheckRollup: [{ ...green.statusCheckRollup[0], conclusion: "SKIPPED" }] };
    expect(evaluate(skipped, head, ready).outcome).toBe("fix");
    expect(evaluate({ ...green, statusCheckRollup: [] }, head, ready).outcome).toBe("wait");
  });

  it("asks for a fix on a merge conflict or a failed preview build", () => {
    expect(evaluate({ ...green, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, head, ready).outcome).toBe("fix");
    expect(evaluate(green, head, { state: "failure", url: "" }).outcome).toBe("fix");
  });

  it("waits while checks run, mergeability is unknown or the preview is building", () => {
    const running = { ...green, statusCheckRollup: [{ __typename: "CheckRun", name: "checks", status: "IN_PROGRESS", conclusion: "" }] };
    expect(evaluate(running, head, ready).outcome).toBe("wait");
    expect(evaluate({ ...green, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, head, ready).outcome).toBe("wait");
    expect(evaluate(green, head, { state: "pending", url: "" }).outcome).toBe("wait");
    expect(evaluate(green, head, null).outcome).toBe("wait");
  });

  it("stops when the pull request is closed, someone else pushed, or GitHub blocks the merge", () => {
    expect(evaluate({ ...green, state: "MERGED" }, head, ready).outcome).toBe("blocked");
    expect(evaluate(green, "other", ready).outcome).toBe("blocked");
    expect(evaluate({ ...green, mergeStateStatus: "BLOCKED" }, head, ready).outcome).toBe("blocked");
  });
});

describe("finish round limits", () => {
  it("stops when the same failure repeats", () => {
    const first = nextRound(undefined, "checks: Type error: x");
    expect(first.stop).toBe(false);
    expect(nextRound(first.state, "checks: Type error: x").stop).toBe(true);
    expect(nextRound(first.state, "checks: Lint error: y").stop).toBe(false);
  });

  it(`stops after ${MAX_ROUNDS} rounds`, () => {
    let state = undefined;
    for (let round = 1; round < MAX_ROUNDS; round++) {
      const next = nextRound(state, `failure ${round}`);
      expect(next.stop).toBe(false);
      state = next.state;
    }
    expect(nextRound(state, "another failure").stop).toBe(true);
  });

  it("fingerprints failures by check and first error line, ignoring timestamps", () => {
    const a = firstErrorLine("checks\tbuild\t2026-10-13T12:00:01.123Z Type error: bad prop\nmore");
    const b = firstErrorLine("checks\tbuild\t2026-10-13T13:30:09.999Z Type error: bad prop");
    expect(a).toBe(b);
    expect(failureSignature([{ name: "checks", state: "failed", link: "", error: a }])).toBe(`checks: ${a}`);
  });
});

const film = (photo, credit) => `<head></head>
<section class="scene dark" id="s0">
  <img class="photo" src="../assets/photos/a.jpg" alt="">
</section>
<section class="scene" id="s1">
  <img class="photo" src="../assets/photos/${photo}" alt="">
</section>
<section class="post" id="credits">
  <p>${credit}</p>
</section>
</body>`;
const timeline = { scenes: [{ start: 0 }, { start: 6.607 }, { start: 14.721 }], credits: { start: 94.511 } };

describe("finish report", () => {
  it("splits the film into scenes and the credits page", () => {
    expect([...filmSections(film("b.jpg", "x")).keys()]).toEqual(["0", "1", "credits"]);
  });

  it("finds the scenes a change affects from the markup, the voice and the photo credits", () => {
    expect(scenesForChanges(["film/index.html", "out/stills/scene-0.png"], film("b.jpg", "x"), film("c.jpg", "x"))).toEqual(["1"]);
    expect(scenesForChanges(["film/index.html"], film("b.jpg", "x"), film("b.jpg", "y"))).toEqual(["credits"]);
    expect(scenesForChanges(["audio/vo/s2.mp3", "audio/vo/s2.json", "assets/photos/CREDITS.md", "audio/vo/s0.json"], "", "")).toEqual(["0", "2", "credits"]);
    expect(scenesForChanges(["scripts/precheck.sh", "film/film.js"], film("b.jpg", "x"), film("b.jpg", "x"))).toEqual([]);
  });

  it("links the film at each scene's start and the scene's still", () => {
    expect(previewLinks("https://p.example.com/", ["1", "credits"], timeline)).toEqual([
      { label: "Scene 1, at 0:06", links: ["https://p.example.com/?t=6", "https://p.example.com/#scene-1"] },
      { label: "Credits page, at 1:34", links: ["https://p.example.com/?t=94"] },
    ]);
  });

  it("links the viewing page when no scene changed, and rejects an unknown scene", () => {
    expect(previewLinks("https://p.example.com", [], timeline)).toEqual([{ label: "The film", links: ["https://p.example.com/"] }]);
    assert.throws(() => previewLinks("https://p.example.com", ["9"], timeline), /scene 9/);
  });

  it("gives plain links to the pull request and the preview", () => {
    const text = readyMessage({ prUrl: "https://github.com/pr/1", previewUrl: "https://p.example.com", scenes: ["2"], timeline, markedReady: true });
    expect(text).toContain("Pull request: https://github.com/pr/1");
    expect(text).toContain("- Scene 2, at 0:14:");
    expect(text).toContain("  https://p.example.com/?t=14");
    expect(text).toContain("out of draft");
    expect(text).toContain("/publish");
  });
});
