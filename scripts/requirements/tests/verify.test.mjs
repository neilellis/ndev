import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_QUINT } from "./fake-quint.mjs";

const NDEV = path.join(import.meta.dirname, "..", "..", "..", "bin", "ndev");
const RECORDS = "docs/formal/requirements";
const RECORD = `${RECORDS}/0001-the-count-stays-bounded.md`;
const VERIFICATION = "docs/formal/verification/REQ-0001.json";
const MODELS = "docs/formal/models";
const MANIFEST = `${MODELS}/counter.json`;
const MODEL = `${MODELS}/counter.qnt`;
const TEST_MODEL = `${MODELS}/counter_test.qnt`;
const CODE = "src/counter.ts";
const MODEL_CODE = "src/limit.ts";
const CHECK = "tests/counter.check.mjs";
const STATEMENT = "The count stays at 3 or less.";

const CODE_TEXT = "export let n = 0;\nexport function inc() {\n  if (n < 3) n += 1;\n}\n";
const CHECK_TEXT = `console.log("ran 1 test: the count stays bounded");\n`;
const MODEL_TEXT = `module counter {
  var n: int
  action init = n' = 0
  action inc = all { n < 3, n' = n + 1 }
  action step = inc
  val bounded = n <= 3
  val full = n == 3
}
`;
const TEST_TEXT = `module counter_test {
  import counter.* from "./counter"
  run countsTest = pass
}
`;
const manifest = () => ({
  model: "counter.qnt",
  requirements: ["REQ-0001"],
  assumptions: ["one writer"],
  bounds: { steps: 20, samples: 100, seed: "0x1", limits: [] },
  invariants: ["bounded"],
  witnesses: ["full"],
  mutants: [{ invariant: "bounded", find: "n < 3", replace: "n < 5", why: "the limit in the guard is wrong" }],
  actions: { init: { none: "the start state" }, inc: { code: [{ file: MODEL_CODE, lines: "L1-L1" }] }, step: { none: "the next action" } },
});
const recordText = ({ id = "REQ-0001", status = "Accepted", files = [CODE], models = [], statement = STATEMENT } = {}) =>
  `---\nid: ${id}\ntitle: The count stays bounded\nstatus: ${status}\n${models.length ? `model:\n${models.map((m) => `  - ${m}`).join("\n")}\n` : ""}---\n\n## Statement\n\n${statement}\n\n## Explanation\n\nSECRET EXPLANATION\n\n## Trace\n\n${files.map((f) => `- File: ${f}`).join("\n")}\n\n## Notes\n\nSECRET NOTES\n`;
const checkEntry = (extra = {}) => ({ name: "counter", run: ["node", CHECK], files: [CHECK], proof: "ran [1-9]\\d* test", ...extra });
const verification = (extra = {}) => ({ requirement: "REQ-0001", checks: [checkEntry()], ...extra });

const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const get = (root, rel) => readFileSync(path.join(root, rel), "utf8");
const json = (root, rel) => JSON.parse(get(root, rel));
const putJson = (root, rel, value) => put(root, rel, `${JSON.stringify(value, null, 2)}\n`);
const change = (root, rel, edit) => {
  const value = json(root, rel);
  edit(value);
  putJson(root, rel, value);
};
const rewrite = (root, rel, from, to) => {
  const text = get(root, rel);
  assert.ok(text.includes(from), `${rel} does not hold ${from}`);
  put(root, rel, text.replace(from, to));
};
const git = (root, ...args) => {
  const out = spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};
const commit = (root) => {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change", "--allow-empty");
  return git(root, "rev-parse", "HEAD");
};
const run = (root, args, env = {}) => {
  const out = spawnSync(NDEV, ["requirements", ...args, "--root", root], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const passes = (out) => assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
const fails = (out, ...patterns) => {
  assert.equal(out.status, 1, `status ${out.status}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
  for (const pattern of patterns) assert.match(out.stderr, pattern);
};
const outsideFile = (text) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "verify-outside-")), "file.txt");
  writeFileSync(file, text);
  return file;
};
const EVIDENCE = "I tried 4 increments. The count stayed at 3.\n";
const judge = (root, { id = "REQ-0001", sha = git(root, "rev-parse", "HEAD"), verdict = "no-counter-example", by = "a fresh agent", evidence = outsideFile(EVIDENCE), overrule } = {}) =>
  run(root, ["verify-judge", id, "--commit", sha, "--verdict", verdict, "--by", by, "--evidence", evidence, ...(overrule === undefined ? [] : ["--overrule", overrule])]);
const DECIDER = "the product owner";
const deprecated = (root, id = "REQ-0001", by) => {
  const rel = id === "REQ-0001" ? RECORD : `${RECORDS}/${id.slice(4)}-other.md`;
  if (!get(root, rel).includes("## Log")) put(root, rel, `${get(root, rel)}\n## Log\n\n- 2026-01-01: Created.\n`);
  return passes(run(root, ["deprecate", id, "--reason", "no longer needed", "--decided-by", DECIDER, ...(by ? ["--by", by] : [])]));
};
const judged = (root, options) => {
  passes(judge(root, options));
  commit(root);
  return root;
};
const verify = (root, ...args) => run(root, ["verify", ...(args.length ? args : ["REQ-0001"])]);
const state = (out, name, ...patterns) => {
  assert.equal(out.status, name === "verified" ? 0 : 1, `status ${out.status}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
  const text = name === "verified" ? out.stdout : out.stderr;
  assert.match(text, new RegExp(`REQ-0001: ${name}$`, "m"));
  for (const pattern of patterns) assert.match(text, pattern);
};

function project({ model = false, files, verificationValue = verification() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-test-"));
  put(root, RECORD, recordText({ files, models: model ? [`${MODEL}#bounded`] : [] }));
  put(root, CODE, CODE_TEXT);
  put(root, CHECK, CHECK_TEXT);
  if (model) {
    put(root, MODEL, MODEL_TEXT);
    put(root, TEST_MODEL, TEST_TEXT);
    put(root, MODEL_CODE, "export const LIMIT = 3;\n");
    putJson(root, MANIFEST, manifest());
  }
  if (verificationValue) putJson(root, VERIFICATION, verificationValue);
  put(root, "node_modules/.bin/quint", FAKE_QUINT);
  chmodSync(path.join(root, "node_modules/.bin/quint"), 0o755);
  put(root, ".gitignore", "node_modules\nignored/\n");
  git(root, "init", "-q");
  commit(root);
  if (model) {
    passes(run(root, ["model-pin", MANIFEST]));
    commit(root);
  }
  return root;
}
const verified = (options) => judged(project(options));

describe("verify-brief", () => {
  it("prints the Statement, the commit and the linked files, and nothing else about the implementation", () => {
    const root = verified({ model: true });
    const out = run(root, ["verify-brief", "REQ-0001"]);
    passes(out);
    assert.equal(out.stdout, [
      "Requirement: REQ-0001",
      `Commit: ${git(root, "rev-parse", "HEAD")}`,
      "",
      "Statement:",
      STATEMENT,
      "",
      "Linked files:",
      `- code: ${CODE}`,
      `- model: ${MODEL}`,
      `- model manifest: ${MANIFEST}`,
      `- model test: ${TEST_MODEL}`,
      `- code that the model cites: ${MODEL_CODE}`,
      `- check test: ${CHECK}`,
      "",
      "Checks:",
      `- counter: run ["node","${CHECK}"]; proof "ran [1-9]\\\\d* test"`,
      "",
    ].join("\n"));
  });
});

describe("verify-judge", () => {
  it("writes only the judgement key, with a digest of each thing that it covers", () => {
    const root = project({ model: true });
    const sha = git(root, "rev-parse", "HEAD");
    const before = json(root, VERIFICATION);
    passes(judge(root, { evidence: outsideFile("The guard stops the count at 3.\n") }));
    const { judgement, ...rest } = json(root, VERIFICATION);
    assert.deepEqual(rest, before);
    assert.deepEqual(Object.keys(judgement), ["verdict", "by", "evidence", "commit", "covers"]);
    assert.deepEqual([judgement.verdict, judgement.by, judgement.evidence, judgement.commit], ["no-counter-example", "a fresh agent", "The guard stops the count at 3.\n", sha]);
    assert.deepEqual(Object.keys(judgement.covers).sort(), [`check test ${CHECK}`, "checks", `code ${CODE}`, `code that the model cites ${MODEL_CODE}`, "model list", `model ${MODEL}`, `model manifest ${MANIFEST}`, `model test ${TEST_MODEL}`, "statement"].sort());
    assert.equal(judgement.covers[`code ${CODE}`], "sha256:" + spawnSync("shasum", ["-a", "256", path.join(root, CODE)], { encoding: "utf8" }).stdout.split(" ")[0]);
  });
});

describe("verify states", () => {
  it("gives verified for a current judgement, a passing check and a passing model", () => {
    const root = verified({ model: true });
    state(verify(root), "verified", new RegExp(git(root, "rev-parse", "HEAD")));
  });

  it("gives violated when a linked check fails, with the full output of the check", () => {
    const root = project();
    put(root, CHECK, `console.log("first line of the output");\nfor (let i = 0; i < 400; i++) console.log("line " + i);\nconsole.error("last line on stderr");\nprocess.exit(7);\n`);
    commit(root);
    judged(root);
    state(verify(root), "violated", /check "counter" exited 7/, /first line of the output/, /line 399/, /last line on stderr/, /Repair:/);
  });

  it("gives violated when a linked model violates an invariant", () => {
    const root = project({ model: true });
    rewrite(root, MODEL, "n < 3", "n < 5");
    change(root, MANIFEST, (m) => { m.mutants[0] = { ...m.mutants[0], find: "n < 5", replace: "n < 7" }; });
    commit(root);
    judged(root);
    state(verify(root), "violated", /counter\.json: invariant "bounded" is violated/, /Repair:/);
  });

  it("gives violated for a current counter-example, with its evidence", () => {
    const root = judged(project(), { verdict: "counter-example", evidence: outsideFile("Two writers reach 4.\n") });
    state(verify(root), "violated", /counter-example/, /Two writers reach 4\./, /a fresh agent/, /Repair:/);
  });

  const staleCases = [
    ["the Statement changed", (root) => rewrite(root, RECORD, STATEMENT, "The count stays at 2 or less."), /statement changed/],
    ["a linked file changed", (root) => rewrite(root, CODE, "n += 1", "n += 2"), /code src\/counter\.ts changed/],
    ["a linked file was added", (root) => { put(root, "src/more.ts", "export {};\n"); rewrite(root, RECORD, `- File: ${CODE}`, `- File: ${CODE}\n- File: src/more.ts`); }, /code src\/more\.ts is new/],
    ["a linked file was removed from the record", (root) => rewrite(root, RECORD, `- File: ${CODE}`, "- File: tests/**"), /code src\/counter\.ts is no longer covered/],
    ["the checks list changed", (root) => change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; }), /checks changed/],
    ["a check test file changed", (root) => put(root, CHECK, `${CHECK_TEXT}\n`), /check test tests\/counter\.check\.mjs changed/],
  ];
  for (const [name, edit, pattern] of staleCases) it(`gives stale when ${name}`, () => {
    const root = verified();
    edit(root);
    commit(root);
    state(verify(root), "stale", pattern, /Repair:.*verify-brief REQ-0001/);
  });

  const modelStale = [
    ["the model", MODEL, /model docs\/formal\/models\/counter\.qnt changed/],
    ["the model test", TEST_MODEL, /model test .*counter_test\.qnt changed/],
    ["the manifest", MANIFEST, /model manifest .*counter\.json changed/],
  ];
  for (const [name, rel, pattern] of modelStale) it(`gives stale when ${name} changed`, () => {
    const root = verified({ model: true });
    put(root, rel, `${get(root, rel)}\n`);
    commit(root);
    state(verify(root), "stale", pattern);
  });

  it("gives stale when a model has drifted", () => {
    const root = project({ model: true });
    put(root, MODEL_CODE, "export const LIMIT = 4;\n");
    commit(root);
    judged(root);
    state(verify(root), "stale", /drift: the cited lines do not match the pin/, /model-pin/);
  });

  const unverifiedCases = [
    ["there is no verification file", () => project({ verificationValue: null }), /no verification file docs\/formal\/verification\/REQ-0001\.json/],
    ["there is no judgement", () => project(), /no judgement/],
    ["there is no linked code", () => judged(project({ files: [] })), /no linked code/],
    ["there is no check and no model", () => judged(project({ verificationValue: verification({ checks: [] }) })), /no check and no model/],
    ["the output of a check does not match proof", () => judged(project({ verificationValue: verification({ checks: [checkEntry({ proof: "ran 9 tests" })] }) })), /check "counter".*does not match its proof/s],
    ["a listed model has no manifest", () => { const root = project({ model: true }); rmSync(path.join(root, MANIFEST)); commit(root); return judged(root); }, /counter\.qnt has no manifest/],
    ["the manifest does not list the property", () => { const root = project({ model: true }); rewrite(root, RECORD, "#bounded", "#absent"); commit(root); return judged(root); }, /does not list the property "absent"/],
    ["the manifest does not list the requirement", () => { const root = project({ model: true }); put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002", models: [MODEL] })); change(root, MANIFEST, (m) => { m.requirements = ["REQ-0002"]; }); commit(root); return judged(root); }, /"requirements" of .*counter\.json does not list REQ-0001/],
    ["a model check fails for another reason", () => { const root = project({ model: true }); change(root, MANIFEST, (m) => { m.mutants = []; }); commit(root); return judged(root); }, /invariant "bounded" has no mutant/],
    ["a File line matches no tracked file", () => judged(project({ files: [CODE, "src/gone.ts"] })), /"- File: src\/gone\.ts" matches no tracked file/],
  ];
  for (const [name, setup, pattern] of unverifiedCases) it(`gives unverified when ${name}`, () => {
    state(verify(setup()), "unverified", pattern, /Repair:/);
  });

  it("puts violated before stale, and keeps each reason", () => {
    const root = verified();
    put(root, CHECK, "process.exit(1);\n");
    commit(root);
    state(verify(root), "violated", /check "counter" exited 1/, /check test tests\/counter\.check\.mjs changed/);
  });

  it("puts stale before unverified", () => {
    const root = verified();
    change(root, VERIFICATION, (v) => { v.checks[0].proof = "never printed"; });
    commit(root);
    state(verify(root), "stale", /checks changed/, /does not match its proof/);
  });

  it("does not call an old counter-example violated: it is stale", () => {
    const root = judged(project(), { verdict: "counter-example" });
    rewrite(root, CODE, "n < 3", "n < 2");
    commit(root);
    state(verify(root), "stale", /counter-example/);
  });

  it("exits 1 when one of the selected requirements is not verified", () => {
    const root = verified();
    put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002" }));
    commit(root);
    fails(verify(root, "--all"), /REQ-0001: verified$/m, /REQ-0002: unverified$/m);
  });
});

describe("verification file", () => {
  const cases = [
    ["an unknown key", (v) => { v.result = "verified"; }, /"result" is not a key/],
    ["a missing key", (v) => { delete v.checks; }, /the key "checks" is missing/],
    ["another requirement id", (v) => { v.requirement = "REQ-0002"; }, /"requirement" is "REQ-0002".*REQ-0001/],
    ["an unknown check key", (v) => { v.checks[0].shell = true; }, /checks\[0\]: "shell" is not a key/],
    ["a missing check key", (v) => { delete v.checks[0].proof; }, /checks\[0\]: the key "proof" is missing/],
    ["an invalid proof", (v) => { v.checks[0].proof = "ran ("; }, /checks\[0\]: "proof" is not a valid regular expression/],
    ["a proof that matches no output at all", (v) => { v.checks[0].proof = "x*"; }, /checks\[0\]: "proof".*matches empty output/],
    ["two checks with one name", (v) => { v.checks.push({ ...v.checks[0] }); }, /"counter" is the name of more than one check/],
    ["a run that is a shell line", (v) => { v.checks[0].run = `node ${CHECK}`; }, /checks\[0\]: "run" must be a list/],
    ["a test file outside the project", (v) => { v.checks[0].files = ["../outside.mjs"]; }, /checks\[0\]: "\.\.\/outside\.mjs" is not a path inside the project/],
    ["an absolute test file", (v) => { v.checks[0].files = ["/etc/hosts"]; }, /checks\[0\]: "\/etc\/hosts" is not a path inside the project/],
    ["a judgement with an unknown key", (v) => { v.judgement.score = 1; }, /judgement: "score" is not a key/],
  ];
  for (const [name, edit, pattern] of cases) it(`is never verified with ${name}`, () => {
    const root = verified();
    change(root, VERIFICATION, edit);
    commit(root);
    state(verify(root), "unverified", /docs\/formal\/verification\/REQ-0001\.json/, pattern, /Repair:/);
  });

  it("is never verified when it is not JSON", () => {
    const root = verified();
    put(root, VERIFICATION, "{");
    commit(root);
    state(verify(root), "unverified", /REQ-0001\.json: not valid JSON/, /Repair:/);
  });
});

describe("verify selection", () => {
  const usage = (out, pattern) => {
    assert.equal(out.status, 2, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
    assert.match(out.stderr, pattern);
  };
  for (const [name, args] of [["nothing", []], ["an id and --all", ["REQ-0001", "--all"]], ["--all and --base", ["--all", "--base", "HEAD"]], ["an id and --base", ["REQ-0001", "--base", "HEAD"]]]) it(`refuses ${name}`, () => {
    usage(run(verified(), ["verify", ...args]), /exactly one of/);
  });

  it("refuses an option it does not know", () => {
    usage(run(verified(), ["verify", "--all", "--repo", "o/r"]), /--repo/);
  });

  it("refuses an id with no record", () => {
    fails(verify(verified(), "REQ-0009"), /REQ-0009 is not a record/);
  });

  it("refuses a record that is not in force", () => {
    const root = verified();
    put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002", status: "Rejected" }));
    commit(root);
    fails(verify(root, "REQ-0002"), /REQ-0002 is not in force.*Rejected/);
    passes(verify(root, "--all"));
  });

  it("does not pass --all when no record is in force", () => {
    const root = project();
    put(root, RECORD, recordText({ status: "Rejected" }));
    commit(root);
    fails(verify(root, "--all"), /no record is in force.*1 record/);
  });

  it("does not pass with no records folder", () => {
    const root = verified();
    rmSync(path.join(root, RECORDS), { recursive: true });
    commit(root);
    fails(verify(root, "--all"), /no records in docs\/formal\/requirements/);
  });

  for (const [name, text, pattern] of [
    ["a record with no front matter", `## Statement\n\nx\n`, /0002-other\.md.*front matter/],
    ["a record with an unknown status", recordText({ id: "REQ-0002", status: "Acepted" }), /0002-other\.md.*status "Acepted"/],
  ]) it(`does not leave out ${name} from --all in silence`, () => {
    const root = verified();
    put(root, `${RECORDS}/0002-other.md`, text);
    commit(root);
    fails(verify(root, "--all"), pattern, /ndev requirements check/);
  });

  it("refuses two records with one id", () => {
    const root = verified();
    put(root, `${RECORDS}/0001-other.md`, recordText());
    commit(root);
    fails(verify(root), /REQ-0001.*more than one record/);
  });
});

describe("verify: the results belong to a commit", () => {
  for (const [name, edit] of [
    ["a changed file", (root) => rewrite(root, CODE, "n < 3", "n < 4")],
    ["an untracked file", (root) => put(root, "notes.txt", "x\n")],
    ["a staged file", (root) => { put(root, "notes.txt", "x\n"); git(root, "add", "notes.txt"); }],
    ["an untracked file that the git settings hide", (root) => { git(root, "config", "status.showUntrackedFiles", "no"); put(root, "notes.txt", "x\n"); }],
  ]) it(`refuses a worktree with ${name}`, () => {
    const root = verified();
    edit(root);
    fails(verify(root), /the worktree has changes/, /Repair: commit/);
  });

  it("accepts ignored files", () => {
    const root = verified();
    put(root, "ignored/cache.txt", "x\n");
    passes(verify(root));
  });

  const hidden = [
    ["assume-unchanged", (root, rel) => git(root, "update-index", "--assume-unchanged", rel)],
    ["skip-worktree", (root, rel) => git(root, "update-index", "--skip-worktree", rel)],
  ];
  for (const [flag, hide] of hidden) for (const rel of [CODE, CHECK, RECORD, VERIFICATION]) it(`refuses ${rel} that differs from the commit behind ${flag}`, () => {
    const root = verified();
    hide(root, rel);
    put(root, rel, `${get(root, rel)}\n`);
    fails(verify(root), new RegExp(`${rel.replaceAll(".", "\\.")} on disk is not the file of commit`), /Repair:/);
  });

  it("refuses a covered file that skip-worktree removed from disk", () => {
    const root = verified();
    git(root, "update-index", "--skip-worktree", CODE);
    rmSync(path.join(root, CODE));
    fails(verify(root), /src\/counter\.ts on disk is not the file of commit/);
  });

  it("refuses a covered file that a clean filter changes when git commits it", () => {
    const root = project();
    git(root, "config", "filter.three.clean", "sed s/9/3/g");
    put(root, ".gitattributes", "*.ts filter=three\n");
    commit(root);
    rewrite(root, CODE, "n < 3", "n < 9");
    fails(judge(root), /src\/counter\.ts on disk is not the file of commit/);
    assert.equal(git(root, "status", "--porcelain"), "");
    fails(verify(root), /src\/counter\.ts on disk is not the file of commit/);
  });

  it("refuses a file of the models folder that differs behind assume-unchanged", () => {
    const root = project({ model: true });
    put(root, `${MODELS}/lib.qnt`, "module lib {\n}\n");
    commit(root);
    judged(root);
    passes(verify(root));
    git(root, "update-index", "--assume-unchanged", `${MODELS}/lib.qnt`);
    put(root, `${MODELS}/lib.qnt`, "module lib {\n  val x = 1\n}\n");
    fails(verify(root), /models\/lib\.qnt on disk is not the file of commit/);
  });

  for (const rel of [CODE, CHECK, VERIFICATION, RECORD]) it(`refuses ${rel} when it is a symlink`, () => {
    const root = verified();
    const other = outsideFile(get(root, rel));
    rmSync(path.join(root, rel));
    symlinkSync(other, path.join(root, rel));
    commit(root);
    fails(verify(root), new RegExp(`${rel.replaceAll(".", "\\.")} is a symlink`), /Repair:/);
  });

  it("refuses a covered file behind a symlinked folder", () => {
    const root = project({ verificationValue: verification({ checks: [checkEntry({ run: ["node", "linked/counter.check.mjs"], files: ["linked/counter.check.mjs"] })] }) });
    symlinkSync("tests", path.join(root, "linked"));
    commit(root);
    fails(verify(root), /linked\/counter\.check\.mjs is behind a symlink/);
  });

  it("refuses a symlink retarget that git status does not show", () => {
    const root = verified();
    const other = outsideFile(CODE_TEXT);
    git(root, "update-index", "--assume-unchanged", CODE);
    rmSync(path.join(root, CODE));
    symlinkSync(other, path.join(root, CODE));
    fails(verify(root), /src\/counter\.ts is a symlink/);
  });

  const during = (script) => {
    const root = project();
    put(root, CHECK, `import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\n${script}\nconsole.log("ran 1 test");\n`);
    commit(root);
    return judged(root);
  };

  it("fails when HEAD changes during the run", () => {
    const root = during(`spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "during", "--allow-empty"]);`);
    const before = git(root, "rev-parse", "HEAD");
    fails(verify(root), new RegExp(`HEAD changed during the run, from ${before}`), /Repair:/);
  });

  it("fails when a covered file changes during the run", () => {
    fails(verify(during(`writeFileSync("src/counter.ts", "changed\\n");`)), /src\/counter\.ts on disk is not the file of commit/, /during the run/);
  });

  it("fails when a covered file is added during the run", () => {
    const root = during(`writeFileSync("src/more.ts", "x\\n");\nspawnSync("git", ["add", "src/more.ts"]);`);
    rewrite(root, RECORD, `- File: ${CODE}`, "- File: src/*.ts");
    commit(root);
    judged(root);
    fails(verify(root), /src\/more\.ts.*not in commit/, /during the run/);
  });

  it("runs a check with no shell, from the project root", () => {
    const root = project({ verificationValue: verification({ checks: [checkEntry({ run: ["node", "-e", "console.log('ran 1 test', process.argv[1], process.cwd())", "$HOME;exit 1", CHECK], proof: "ran 1 test \\$HOME;exit 1 .*verify-test-" })] }) });
    passes(verify(judged(root)));
  });

  it("stops when a check cannot start, and gives no state", () => {
    const root = judged(project({ verificationValue: verification({ checks: [checkEntry({ run: ["ndev-no-such-program", CHECK] })] }) }));
    const out = verify(root);
    fails(out, /REQ-0001: check "counter" could not start/, /ndev-no-such-program/, /Repair:/);
    assert.doesNotMatch(out.stderr, /REQ-0001: (verified|unverified|violated|stale)/);
  });

  it("stops when a check does not finish in time, with its output", () => {
    const root = project();
    put(root, CHECK, `console.log("ran 1 test, then waited");\nsetTimeout(() => {}, 60000);\n`);
    commit(root);
    const out = run(judged(root), ["verify", "REQ-0001"], { NDEV_CHECK_TIMEOUT_MS: "1500" });
    fails(out, /check "counter" did not finish in 1500 ms/, /then waited/, /NDEV_CHECK_TIMEOUT_MS/);
  });

  it("stops when a check ends on a signal", () => {
    const root = project();
    put(root, CHECK, `console.log("ran 1 test");\nprocess.kill(process.pid, "SIGTERM");\n`);
    commit(root);
    fails(verify(judged(root)), /check "counter" ended on signal SIGTERM/);
  });

  for (const value of ["", "0", "-1", "1.5", "10s"]) it(`refuses the time limit ${JSON.stringify(value)}`, () => {
    fails(run(verified(), ["verify", "REQ-0001"], { NDEV_CHECK_TIMEOUT_MS: value }), /NDEV_CHECK_TIMEOUT_MS is/, /Repair:/);
  });

  it("stops when Quint does not finish, and gives no state", () => {
    const root = project({ model: true });
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // HANG\n");
    commit(root);
    const out = run(judged(root), ["verify", "REQ-0001"], { NDEV_QUINT_TIMEOUT_MS: "1500" });
    fails(out, /Quint timed out after 1500 ms/);
    assert.doesNotMatch(out.stderr, /REQ-0001: (verified|unverified|violated|stale)/);
  });
});

describe("verify --report", () => {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const target = () => path.join(mkdtempSync(path.join(tmpdir(), "verify-report-")), "out", "report.json");

  it("gives the commit and, for each requirement, its state, reasons, checks and models", () => {
    const root = verified({ model: true });
    const report = target();
    passes(verify(root, "REQ-0001", "--report", report));
    assert.deepEqual(read(report), {
      kind: "ndev-requirements-verification",
      commit: git(root, "rev-parse", "HEAD"),
      requirements: [{ id: "REQ-0001", state: "verified", reasons: [], checks: [{ name: "counter", run: ["node", CHECK], exit: 0 }], models: [{ model: MODEL, manifest: MANIFEST, result: "passed", problems: [] }] }],
    });
  });

  it("is written for a failing result", () => {
    const root = project({ model: true });
    rewrite(root, MODEL, "n < 3", "n < 5");
    change(root, MANIFEST, (m) => { m.mutants[0] = { ...m.mutants[0], find: "n < 5", replace: "n < 7" }; });
    put(root, CHECK, "process.exit(3);\n");
    commit(root);
    const report = target();
    fails(verify(judged(root), "REQ-0001", "--report", report), /REQ-0001: violated/);
    const [result] = read(report).requirements;
    assert.equal(result.state, "violated");
    assert.equal(result.checks[0].exit, 3);
    assert.equal(result.models[0].result, "violated");
    assert.ok(result.reasons.length >= 2);
  });

  it("may be an untracked file of the project, and a second run replaces it", () => {
    const root = verified();
    passes(verify(root, "REQ-0001", "--report", "report.json"));
    passes(verify(root, "REQ-0001", "--report", "report.json"));
    assert.equal(read(path.join(root, "report.json")).commit, git(root, "rev-parse", "HEAD"));
  });

  for (const [name, args] of [["an unknown id", ["REQ-0009"]], ["a bad base", ["--base", "no-such-ref"]], ["no selection", []]]) it(`does not leave the report of an earlier run after ${name}`, () => {
    const root = verified();
    const report = target();
    passes(verify(root, "REQ-0001", "--report", report));
    assert.equal(existsSync(report), true);
    assert.notEqual(run(root, ["verify", ...args, "--report", report]).status, 0);
    assert.equal(existsSync(report), false);
  });

  it("refuses a tracked file, and keeps it", () => {
    const root = verified();
    put(root, "old.json", `{"kind":"ndev-requirements-verification"}\n`);
    commit(root);
    fails(verify(root, "REQ-0001", "--report", "old.json"), /old\.json is a tracked file/);
    assert.equal(existsSync(path.join(root, "old.json")), true);
    fails(verify(root, "REQ-0001", "--report", CODE), /src\/counter\.ts is a tracked file/);
    assert.equal(get(root, CODE), CODE_TEXT);
  });

  it("refuses a tracked file through a link to its folder", () => {
    const root = verified();
    const link = path.join(mkdtempSync(path.join(tmpdir(), "verify-link-")), "src");
    symlinkSync(path.join(root, "src"), link);
    fails(verify(root, "REQ-0001", "--report", path.join(link, "counter.ts")), /is a tracked file/);
  });

  it("does not delete or overwrite a file that is not a report", () => {
    const root = verified();
    put(root, "work.ts", "my new code\n");
    fails(verify(root, "REQ-0001", "--report", "work.ts"), /work\.ts exists and is not a report/);
    assert.equal(get(root, "work.ts"), "my new code\n");
  });

  it("refuses a report that is a symlink or a folder", () => {
    const root = verified();
    const link = path.join(mkdtempSync(path.join(tmpdir(), "verify-link-")), "report.json");
    symlinkSync(path.join(root, CODE), link);
    fails(verify(root, "REQ-0001", "--report", link), /report\.json is not a file/);
    fails(verify(root, "REQ-0001", "--report", "src"), /src is not a file/);
    assert.equal(get(root, CODE), CODE_TEXT);
  });
});

describe("verify-brief refuses", () => {
  const brief = (root, id = "REQ-0001") => run(root, ["verify-brief", id]);

  it("an unknown id and a record that is not in force", () => {
    const root = project();
    fails(brief(root, "REQ-0009"), /REQ-0009 is not a record/);
    put(root, RECORD, recordText({ status: "Retired" }));
    commit(root);
    fails(brief(root), /REQ-0001 is not in force/);
  });

  it("anything but one id", () => {
    assert.equal(run(project(), ["verify-brief"]).status, 2);
  });

  it("a requirement with no committed verification file, and says what to commit", () => {
    const root = project({ verificationValue: null });
    fails(brief(root), /REQ-0001\.json is not in the commit/, /Repair: write it.*commit/);
    putJson(root, VERIFICATION, verification());
    fails(brief(root), /REQ-0001\.json is not in the commit/);
    commit(root);
    passes(brief(root));
  });

  it("an invalid verification file and a covered file that is not tracked", () => {
    const root = project({ verificationValue: verification({ checks: [checkEntry({ files: ["tests/absent.mjs"] })] }) });
    fails(brief(root), /tests\/absent\.mjs is not a tracked file/, /Repair:/);
  });

  it("a covered file with a change that is not committed", () => {
    const root = project();
    rewrite(root, CODE, "n < 3", "n < 4");
    fails(brief(root), /src\/counter\.ts on disk is not the file of commit/, /commit/);
  });

  it("checks on disk that are not the committed checks", () => {
    const root = project();
    change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; });
    fails(brief(root), /"checks" of docs\/formal\/verification\/REQ-0001\.json on disk/, /commit/);
  });

  it("does not show a verdict, even when a File line matches the verification files", () => {
    const root = judged(project({ files: [CODE, "docs/formal/**"] }), { by: "EARLIER JUDGE" });
    const out = brief(root);
    passes(out);
    assert.doesNotMatch(out.stdout, /verification\/|EARLIER|0001-the-count/);
  });
});

describe("verify-judge refuses", () => {
  const unchanged = (root, out, ...patterns) => {
    fails(out, ...patterns);
    assert.equal(json(root, VERIFICATION).judgement, undefined);
  };

  it("an empty evidence file", () => {
    const root = project();
    unchanged(root, judge(root, { evidence: outsideFile(" \n\n") }), /the evidence file .* is empty/);
  });

  it("an evidence file that does not exist", () => {
    const root = project();
    unchanged(root, judge(root, { evidence: "/no/such/evidence.txt" }), /evidence.*\/no\/such\/evidence\.txt/);
  });

  it("an unknown verdict", () => {
    const root = project();
    const out = judge(root, { verdict: "verified" });
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /"verified".*no-counter-example or counter-example/);
  });

  for (const missing of ["--commit", "--verdict", "--by", "--evidence"]) it(`a call with no ${missing}`, () => {
    const root = project();
    const all = { "--commit": "HEAD", "--verdict": "counter-example", "--by": "a", "--evidence": outsideFile("x\n") };
    const out = run(root, ["verify-judge", "REQ-0001", ...Object.entries(all).filter(([key]) => key !== missing).flat()]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, new RegExp(missing));
  });

  it("an empty --by", () => {
    const root = project();
    assert.equal(judge(root, { by: "  " }).status, 2);
  });

  it("a commit that is not a commit of the repository", () => {
    const root = project();
    unchanged(root, judge(root, { sha: "0123456789012345678901234567890123456789" }), /0123456789012345678901234567890123456789 is not a commit/);
    unchanged(root, judge(root, { sha: git(root, "rev-parse", "HEAD^{tree}") }), /is not a commit/);
    unchanged(root, judge(root, { sha: "--all" }), /is not a commit/);
  });

  it("records the full commit id, and accepts a later commit that changes nothing covered", () => {
    const root = project();
    const sha = git(root, "rev-parse", "HEAD");
    put(root, "README.md", "x\n");
    commit(root);
    passes(judge(root, { sha: sha.slice(0, 10) }));
    assert.equal(json(root, VERIFICATION).judgement.commit, sha);
  });

  const since = [
    ["a changed file", (root) => rewrite(root, CODE, "n < 3", "n < 4"), /code src\/counter\.ts changed/],
    ["an added file", (root) => put(root, "src/more.ts", "x\n"), /code src\/more\.ts is new/],
    ["a removed file", (root) => rmSync(path.join(root, "src/spare.ts")), /code src\/spare\.ts is no longer covered/],
    ["a changed Statement", (root) => rewrite(root, RECORD, STATEMENT, "Another."), /statement changed/],
    ["changed checks", (root) => change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; }), /checks changed/],
  ];
  for (const [name, edit, pattern] of since) it(`${name} between the commit of the brief and HEAD`, () => {
    const root = project({ files: ["src/*.ts"] });
    put(root, "src/spare.ts", "x\n");
    const sha = commit(root);
    edit(root);
    commit(root);
    unchanged(root, judge(root, { sha }), pattern, /Repair:.*verify-brief/);
  });

  for (const [name, edit, pattern] of [
    ["a changed file", (root) => rewrite(root, CODE, "n < 3", "n < 4"), /src\/counter\.ts on disk/],
    ["a removed file", (root) => rmSync(path.join(root, CODE)), /src\/counter\.ts on disk/],
    ["an added file", (root) => { put(root, "src/more.ts", "x\n"); git(root, "add", "src/more.ts"); }, /src\/more\.ts.*not in commit/],
    ["a changed Statement", (root) => rewrite(root, RECORD, STATEMENT, "Another."), /0001-the-count-stays-bounded\.md on disk/],
    ["changed checks", (root) => change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; }), /"checks" of .* on disk/],
  ]) it(`${name} in the working folder`, () => {
    const root = project({ files: ["src/*.ts"] });
    edit(root);
    unchanged(root, judge(root), pattern, /Repair:/);
  });

  it("a covered file that is not tracked", () => {
    const root = project({ verificationValue: verification({ checks: [checkEntry({ files: ["tests/absent.mjs"] })] }) });
    unchanged(root, judge(root), /tests\/absent\.mjs is not a tracked file/);
  });

  it("nothing when only the judgement on disk is new: a second judgement replaces the first", () => {
    const root = project();
    passes(judge(root));
    passes(judge(root, { verdict: "counter-example" }));
    assert.equal(json(root, VERIFICATION).judgement.verdict, "counter-example");
  });
});

describe("verify --base", () => {
  const based = (options) => {
    const root = verified(options);
    return { root, base: git(root, "rev-parse", "HEAD") };
  };
  const since = (root, base, ...args) => run(root, ["verify", "--base", base, ...args]);
  const untouched = (out) => {
    passes(out);
    assert.match(out.stdout, /the changes touch no requirement.*1 record searched/);
  };

  it("says that nothing is touched, with the number of records that it searched", () => {
    const { root, base } = based();
    put(root, "README.md", "x\n");
    commit(root);
    untouched(since(root, base));
  });

  const touched = [
    ["a linked file", (root) => rewrite(root, CODE, "n < 3", "n < 4")],
    ["a check test file", (root) => put(root, CHECK, `${CHECK_TEXT}\n`)],
    ["the record file", (root) => put(root, RECORD, `${get(root, RECORD)}\nMore.\n`)],
    ["the verification file", (root) => change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; })],
    ["the model", (root) => put(root, MODEL, `${get(root, MODEL)}\n`)],
    ["the model test", (root) => put(root, TEST_MODEL, `${get(root, TEST_MODEL)}\n`)],
    ["the manifest", (root) => put(root, MANIFEST, `${get(root, MANIFEST)}\n`)],
    ["code that the manifest cites", (root) => put(root, MODEL_CODE, "export const LIMIT = 3;\nexport const MORE = 1;\n")],
  ];
  for (const [name, edit] of touched) it(`selects a requirement when ${name} changed`, () => {
    const { root, base } = based({ model: true });
    edit(root);
    commit(root);
    assert.match(since(root, base).stdout + since(root, base).stderr, /^REQ-0001: \w+$/m);
  });

  const removed = [
    ["a File line, and the file changes", (root) => { rewrite(root, RECORD, `- File: ${CODE}`, "- File: tests/**"); }, undefined],
    ["a File line only", (root) => rewrite(root, RECORD, `- File: ${CODE}`, "- File: tests/**"), undefined],
    ["a linked file that it deletes", (root) => rmSync(path.join(root, CODE)), undefined],
    ["a linked file that it renames", (root) => git(root, "mv", CODE, "lib.ts"), undefined],
  ];
  for (const [name, edit] of removed) it(`selects a requirement when the change removes ${name}`, () => {
    const { root, base } = based();
    edit(root);
    commit(root);
    assert.match(since(root, base).stderr, /^REQ-0001: stale$/m);
  });

  const baseOnly = [
    ["the model from the model list, and changes the model", { model: true }, (root) => { rewrite(root, RECORD, `model:\n  - ${MODEL}#bounded\n`, ""); }],
    ["the check from the verification file, and its test file", {}, (root) => { rmSync(path.join(root, CHECK)); change(root, VERIFICATION, (v) => { v.checks = []; }); }],
  ];
  for (const [name, options, edit] of baseOnly) it(`selects a requirement when the change removes ${name}`, () => {
    const { root, base } = based(options);
    edit(root);
    commit(root);
    assert.match(since(root, base).stderr, /^REQ-0001: stale$/m);
  });

  const twoSteps = [
    ["a File line that only the base has", {}, (root) => rewrite(root, RECORD, `- File: ${CODE}`, "- File: tests/**"), CODE],
    ["cited code that only the base manifest has", { model: true }, (root) => change(root, MANIFEST, (m) => { m.actions.inc = { none: "no code" }; }), MODEL_CODE],
    ["a test file that only the base verification file has", {}, (root) => change(root, VERIFICATION, (v) => { v.checks = []; }), CHECK],
  ];
  for (const [name, options, unlink, file] of twoSteps) it(`reads ${name}`, () => {
    const { root, base } = based(options);
    unlink(root);
    put(root, file, `${get(root, file)}\n`);
    commit(root);
    assert.match(since(root, base).stderr, /^REQ-0001: stale$/m);
  });

  it("starts at the merge base, not at the tip of the base branch", () => {
    const { root } = based();
    git(root, "checkout", "-qb", "feature");
    put(root, "README.md", "x\n");
    commit(root);
    git(root, "checkout", "-qb", "main-moved", "HEAD~1");
    rewrite(root, CODE, "n < 3", "n < 4");
    commit(root);
    git(root, "checkout", "-q", "feature");
    untouched(since(root, "main-moved"));
  });

  it("names a requirement that the change deprecates, and does not fail for that alone", () => {
    const { root, base } = based();
    deprecated(root);
    commit(root);
    const report = path.join(mkdtempSync(path.join(tmpdir(), "verify-report-")), "report.json");
    const out = since(root, base, "--report", report);
    passes(out);
    assert.match(out.stdout, /Not verified: REQ-0001: it was in force at the base, and its status is Retired \(docs\/formal\/deprecated\/0001/);
    const value = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(value.base, { ref: base, mergeBase: base });
    assert.deepEqual(value.requirements, []);
    assert.equal(value.notVerified[0].id, "REQ-0001");
  });

  it("fails when the change deletes a record that was in force", () => {
    const { root, base } = based();
    put(root, `${RECORDS}/README.md`, "records\n");
    rmSync(path.join(root, RECORD));
    commit(root);
    fails(since(root, base), /Not verified: REQ-0001: it was in force at the base, and the commit has no record/, /ndev requirements deprecate/);
  });

  it("selects only what the change touches", () => {
    const root = verified();
    put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002", files: ["src/other.ts"] }));
    put(root, "src/other.ts", "x\n");
    const base = commit(root);
    rewrite(root, CODE, "n < 3", "n < 4");
    commit(root);
    const out = since(root, base);
    fails(out, /REQ-0001: stale/);
    assert.doesNotMatch(out.stderr, /REQ-0002/);
  });

  it("selects a requirement whose links it cannot read", () => {
    const root = project({ model: true });
    put(root, MANIFEST, "{");
    const base = commit(root);
    put(root, "README.md", "x\n");
    commit(root);
    fails(since(root, base), /REQ-0001: unverified/, /not valid JSON/);
  });

  for (const ref of ["no-such-ref", "--all", ""]) it(`refuses the base ${JSON.stringify(ref)}`, () => {
    const out = run(verified(), ["verify", "--base", ref]);
    assert.notEqual(out.status, 0, out.stdout);
    assert.match(out.stderr, /--base/);
  });

  it("refuses a base with no common history", () => {
    const root = verified();
    const orphan = git(root, "commit-tree", "HEAD^{tree}", "-m", "orphan");
    fails(run(root, ["verify", "--base", orphan]), /no merge base/);
  });

  it("does not pass with no records folder", () => {
    const { root, base } = based();
    rmSync(path.join(root, RECORDS), { recursive: true });
    commit(root);
    fails(since(root, base), /no records in docs\/formal\/requirements/);
  });
});

describe("verify: output and help", () => {
  it("gives the result as JSON", () => {
    const out = run(verified(), ["verify", "--all", "--json"]);
    passes(out);
    const { ok, result } = JSON.parse(out.stdout);
    assert.equal(ok, true);
    assert.equal(result.requirements[0].state, "verified");
  });

  it("is in the help", () => {
    const out = spawnSync(NDEV, ["requirements", "--help"], { encoding: "utf8" });
    assert.match(out.stdout, /ndev requirements verify-brief <REQ-NNNN>/);
    assert.match(out.stdout, /ndev requirements verify-judge <REQ-NNNN> --commit <sha>/);
    assert.match(out.stdout, /ndev requirements verify \(<REQ-NNNN>\.\.\. \| --all \| --base <git ref>\) \[--report <file>\]/);
  });
});

describe("verify: nothing is left out in silence", () => {
  it("does not drop a File line match that is a submodule", () => {
    const root = project({ files: [CODE, "vendor/lib"] });
    const sha = git(root, "rev-parse", "HEAD");
    mkdirSync(path.join(root, "vendor/lib"), { recursive: true });
    git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`);
    git(root, "commit", "-qm", "submodule");
    state(verify(root), "unverified", /vendor\/lib is not a file in the commit/);
  });

  it("refuses another record that differs behind assume-unchanged when a model check reads it", () => {
    const root = project({ model: true });
    const other = `${RECORDS}/0002-other.md`;
    put(root, other, recordText({ id: "REQ-0002", status: "Rejected", models: [MODEL] }));
    change(root, MANIFEST, (m) => { m.requirements.push("REQ-0002"); });
    commit(root);
    judged(root);
    state(verify(root), "unverified", /REQ-0002 is not in force/);
    git(root, "update-index", "--assume-unchanged", other);
    rewrite(root, other, "status: Rejected", "status: Accepted");
    fails(verify(root), /0002-other\.md on disk is not the file of commit/);
  });

  it("refuses a model test file that the commit does not hold", () => {
    const root = project({ model: true });
    git(root, "rm", "-q", "--cached", TEST_MODEL);
    put(root, ".gitignore", `node_modules\nignored/\n${TEST_MODEL}\n`);
    commit(root);
    judged(root);
    fails(verify(root), /counter_test\.qnt is on disk and not in commit/, /Repair:/);
  });

  it("selects and verifies a requirement when only the base held a symlinked verification file", () => {
    const root = project();
    const held = get(root, VERIFICATION);
    rmSync(path.join(root, VERIFICATION));
    symlinkSync("/nowhere.json", path.join(root, VERIFICATION));
    const base = commit(root);
    rmSync(path.join(root, VERIFICATION));
    put(root, VERIFICATION, held);
    commit(root);
    judged(root);
    const out = run(root, ["verify", "--base", base]);
    passes(out);
    assert.match(out.stdout, /^REQ-0001: verified$/m);
  });

  it("tells how to replace a judgement that is not valid", () => {
    const root = verified();
    change(root, VERIFICATION, (v) => { v.judgement.verdict = "pass"; });
    commit(root);
    state(verify(root), "unverified", /remove the "judgement" key.*verify-judge/);
  });
});

const LIMITS = `${MODELS}/limits.qnt`;
const DEEP = "specs/base.qnt";
const INNER = `${MODELS}/lib/inner.qnt`;
const limitsText = (source) => `module limits {\n  import base.* from "${source}"\n  pure val MAX = 3\n}\n`;
const IMPORT = `  import limits.* from "./limits"\n`;

function importing({ edit, deep = DEEP, source = "../../../specs/base" } = {}) {
  const root = project({ model: true });
  put(root, deep, "module base {\n  pure val ONE = 1\n}\n");
  put(root, LIMITS, limitsText(source));
  rewrite(root, MODEL, "module counter {\n", `module counter {\n${IMPORT}`);
  rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= MAX");
  edit?.(root);
  commit(root);
  return root;
}
const inside = { deep: INNER, source: "./lib/inner" };
const checkedAt = (root) => {
  const base = judged(root) && git(root, "rev-parse", "HEAD");
  return { root, base };
};

describe("verify: the files that a linked model imports", () => {
  it("are in the brief and the judgement, also through other imports and outside the models folder", () => {
    const root = importing();
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, new RegExp(`^- model import: ${LIMITS}$`, "m"));
    assert.match(brief.stdout, new RegExp(`^- model import: ${DEEP}$`, "m"));
    judged(root);
    const { covers } = json(root, VERIFICATION).judgement;
    assert.ok(covers[`model import ${LIMITS}`] && covers[`model import ${DEEP}`], Object.keys(covers).join());
  });

  it("can give verified", () => {
    const root = importing(inside);
    judged(root);
    state(verify(root), "verified");
    assert.ok(json(root, VERIFICATION).judgement.covers[`model import ${INNER}`]);
  });

  it("select their requirement with --base, and the invariant that they break is found", () => {
    const { root, base } = checkedAt(importing());
    rewrite(root, LIMITS, "MAX = 3", "MAX = 2");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: violated$/m, /model import docs\/formal\/models\/limits\.qnt changed/);
  });

  it("select their requirement with --base through a second import", () => {
    const { root, base } = checkedAt(importing());
    rewrite(root, DEEP, "ONE = 1", "ONE = 2");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: stale$/m, /model import specs\/base\.qnt changed/);
  });

  it("come also from the model test file", () => {
    const { root, base } = checkedAt(importing({ edit: (r) => { put(r, "specs/helper.qnt", "module helper {\n  pure val H = 1\n}\n"); rewrite(r, TEST_MODEL, "module counter_test {\n", 'module counter_test {\n  import helper.* from "../../../specs/helper"\n'); } }));
    rewrite(root, "specs/helper.qnt", "H = 1", "H = 2");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: stale$/m, /model import specs\/helper\.qnt changed/);
  });

  it("do not include an import in a comment or a name in a string", () => {
    const root = importing({ ...inside, edit: (r) => rewrite(r, MODEL, IMPORT, `${IMPORT}  // import a.* from "gone/absent1"\n  /* import b.* from "gone/absent2" */\n  /// from "gone/absent3" /*\n  pure val text = "import c.* from ./absent4 // /*"\n  pure val from = 1\n`) });
    judged(root);
    state(verify(root), "verified");
    assert.deepEqual(Object.keys(json(root, VERIFICATION).judgement.covers).filter((key) => key.startsWith("model import")).sort(), [`model import ${INNER}`, `model import ${LIMITS}`]);
  });

  it("are read as Quint reads strings: a backslash does not escape the quote", () => {
    const root = importing({ edit: (r) => rewrite(r, MODEL, IMPORT, `  pure val s = "a\\"\n${IMPORT}`) });
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, new RegExp(`^- model import: ${LIMITS}$`, "m"));
  });

  for (const [name, edit] of [
    ["has comments between from and the string", (r) => rewrite(r, MODEL, IMPORT, '  import limits.* from // one\n  /* two */ "./limits"\n')],
    ["follows a first line that starts with #! and opens a comment", (r) => put(r, MODEL, `#!/usr/bin/env quint /*\n${get(r, MODEL)}`)],
  ]) it(`are found when the import ${name}`, () => {
    const brief = run(importing({ edit }), ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, new RegExp(`^- model import: ${LIMITS}$`, "m"));
  });

  const unresolved = [
    ["an import of a file that does not exist", (r) => rewrite(r, DEEP, "module base {\n", 'module base {\n  import gone.* from "./gone"\n'), /specs\/base\.qnt imports "\.\/gone".*specs\/gone\.qnt is not a file in the commit/],
    ["an import that leaves the project", (r) => rewrite(r, DEEP, "module base {\n", 'module base {\n  import far.* from "../../far-away"\n'), /specs\/base\.qnt imports "\.\.\/\.\.\/far-away".*leaves the project/],
    ["an import in a file with a lone carriage return", (r) => rewrite(r, DEEP, "module base {\n", "module base {\n  // one\r  // two\n"), /specs\/base\.qnt.*cannot be read reliably.*carriage return/],
    ["a comment that does not end", (r) => rewrite(r, DEEP, "module base {\n", "module base {\n  /* open\n"), /specs\/base\.qnt.*cannot be read reliably.*comment/],
    ["a string that does not end", (r) => rewrite(r, DEEP, "module base {\n", 'module base {\n  pure val s = "open\n'), /specs\/base\.qnt.*cannot be read reliably.*string/],
  ];
  for (const [name, edit, pattern] of unresolved) {
    it(`stop the brief and the judge at ${name}`, () => {
      const root = importing({ edit });
      fails(run(root, ["verify-brief", "REQ-0001"]), pattern, /Repair:/);
      fails(judge(root), pattern);
    });
    it(`never give verified with ${name}`, () => {
      const root = importing();
      judged(root);
      edit(root);
      commit(root);
      const out = verify(root);
      fails(out, pattern);
      assert.doesNotMatch(out.stdout + out.stderr, /REQ-0001: verified/);
    });
    it(`select the requirement with --base when the base and HEAD hold ${name}`, () => {
      const root = importing({ edit });
      const base = git(root, "rev-parse", "HEAD");
      put(root, "README.md", "x\n");
      commit(root);
      fails(run(root, ["verify", "--base", base]), /^REQ-0001: unverified$/m, pattern);
    });
  }

  it("refuse an import that is a symlink", () => {
    const root = importing();
    judged(root);
    const other = outsideFile(get(root, DEEP));
    rmSync(path.join(root, DEEP));
    symlinkSync(other, path.join(root, DEEP));
    commit(root);
    fails(verify(root), /specs\/base\.qnt is a symlink/);
  });

  for (const rel of [LIMITS, DEEP]) it(`refuse ${rel} on disk when the commit does not hold it`, () => {
    const root = importing();
    judged(root);
    git(root, "rm", "-q", "--cached", rel);
    put(root, ".gitignore", `node_modules\nignored/\n${rel}\n`);
    commit(root);
    const pattern = new RegExp(`${rel.replaceAll(".", "\\.")} is on disk and not in commit`);
    fails(verify(root), pattern, /Repair:/);
    fails(run(root, ["verify-brief", "REQ-0001"]), pattern);
    fails(judge(root), pattern);
  });

  it("refuse one that differs behind assume-unchanged outside the models folder", () => {
    const root = importing();
    judged(root);
    git(root, "update-index", "--assume-unchanged", DEEP);
    rewrite(root, DEEP, "ONE = 1", "ONE = 5");
    fails(verify(root), /specs\/base\.qnt on disk is not the file of commit/);
  });
});

describe("verify --base: the records that a shared manifest names", () => {
  const OTHER = `${RECORDS}/0002-other.md`;
  const shared = () => checkedAt((() => {
    const root = project({ model: true });
    put(root, OTHER, recordText({ id: "REQ-0002", models: [MODEL], files: ["src/other.ts"] }));
    put(root, "src/other.ts", "x\n");
    change(root, MANIFEST, (m) => { m.requirements.push("REQ-0002"); });
    commit(root);
    return root;
  })());

  it("select it when another of them is retired", () => {
    const { root, base } = shared();
    mkdirSync(path.join(root, "docs/formal/deprecated"));
    git(root, "mv", OTHER, "docs/formal/deprecated/0002-other.md");
    rewrite(root, "docs/formal/deprecated/0002-other.md", "status: Accepted", "status: Retired");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: unverified$/m, /REQ-0002 is not in force/);
  });

  it("select it when the model list of another of them changes", () => {
    const { root, base } = shared();
    rewrite(root, OTHER, `model:\n  - ${MODEL}\n`, "");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: unverified$/m);
  });
});

describe("verify --base: a requirement that stops being in force", () => {
  const MOVED = "docs/formal/deprecated/0001-the-count-stays-bounded.md";
  const leaving = ({ move, status }) => {
    const { root, base } = checkedAt(project());
    if (move) {
      mkdirSync(path.join(root, "docs/formal/deprecated"));
      git(root, "mv", RECORD, MOVED);
    }
    rewrite(root, move ? MOVED : RECORD, "status: Accepted", `status: ${status}`);
    commit(root);
    return run(root, ["verify", "--base", base]);
  };
  for (const [name, options] of [
    ["is changed to Rejected", { status: "Rejected" }],
    ["is Retired and not moved", { status: "Retired" }],
    ["is Superseded and not moved", { status: "Superseded by 0002" }],
    ["is moved with the status Rejected", { move: true, status: "Rejected" }],
  ]) it(`fails when it ${name}`, () => {
    fails(leaving(options), /Not verified: REQ-0001: it was in force at the base/, /Repair:.*ndev requirements deprecate REQ-0001/);
  });

  it("fails when it is moved as Retired with no human who decided it", () => {
    fails(leaving({ move: true, status: "Retired" }), /Not verified: REQ-0001: .*"decided_by"/, /Repair:.*ndev requirements deprecate/);
  });

  it("fails when it is moved as Superseded by a record that does not exist", () => {
    const { root, base } = checkedAt(project());
    mkdirSync(path.join(root, "docs/formal/deprecated"));
    git(root, "mv", RECORD, MOVED);
    rewrite(root, MOVED, "status: Accepted", `status: Superseded by 0002\ndecided_by: ${DECIDER}\nsuperseded_by: ${RECORDS}/0002-other.md`);
    commit(root);
    fails(run(root, ["verify", "--base", base]), /Not verified: REQ-0001: .*superseded_by.*0002-other\.md.*no record/, /Repair:/);
  });

  it("passes when it is retired with ndev requirements deprecate", () => {
    const { root, base } = checkedAt(project());
    deprecated(root);
    commit(root);
    const out = run(root, ["verify", "--base", base]);
    passes(out);
    assert.match(out.stdout, /Not verified: REQ-0001: .*Retired/);
  });

  it("passes when a newer record supersedes it with ndev requirements deprecate", () => {
    const { root, base } = checkedAt(project());
    put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002", status: "Proposed" }));
    commit(root);
    deprecated(root, "REQ-0001", "REQ-0002");
    commit(root);
    const out = run(root, ["verify", "--base", base]);
    assert.match(out.stdout + out.stderr, /Not verified: REQ-0001: .*Superseded by 0002/);
    assert.doesNotMatch(out.stdout + out.stderr, /Not verified: REQ-0001: .*Repair/);
  });
});

describe("verify: a judgement that is not valid", () => {
  const broken = (checkText) => {
    const root = project();
    if (checkText) put(root, CHECK, checkText);
    commit(root);
    judged(root);
    change(root, VERIFICATION, (v) => { v.judgement.verdict = "pass"; });
    commit(root);
    return root;
  };

  it("does not hide a check that fails", () => {
    const root = broken("process.exit(4);\n");
    const report = path.join(mkdtempSync(path.join(tmpdir(), "verify-report-")), "report.json");
    state(verify(root, "REQ-0001", "--report", report), "violated", /check "counter" exited 4/, /judgement: "verdict" must be/);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).requirements[0].checks[0].exit, 4);
  });

  it("gives unverified when the checks pass", () => {
    const out = verify(broken());
    state(out, "unverified", /judgement: "verdict" must be/);
    assert.doesNotMatch(out.stderr, /there is no judgement/);
  });

  it("keeps the checks under the checks of the file on disk", () => {
    const root = broken();
    git(root, "update-index", "--assume-unchanged", VERIFICATION);
    change(root, VERIFICATION, (v) => { v.checks[0].proof = "ran"; });
    fails(verify(root), /REQ-0001\.json on disk is not the file of commit/);
  });
});

describe("verify-judge: a current counter-example stands", () => {
  const REFUSED = [/a current counter-example/, /Repair:.*change the code or ask the human.*verify-judge REQ-0001 --overrule/];
  const countered = () => judged(project(), { verdict: "counter-example", by: "first judge" });
  const kept = (root, out) => {
    fails(out, ...REFUSED, /first judge/);
  };

  it("against a second judge on unchanged covered content", () => {
    const root = countered();
    kept(root, judge(root));
    assert.equal(json(root, VERIFICATION).judgement.verdict, "counter-example");
  });

  it("also before it is committed", () => {
    const root = project();
    passes(judge(root, { verdict: "counter-example", by: "first judge" }));
    kept(root, judge(root));
    assert.equal(json(root, VERIFICATION).judgement.verdict, "counter-example");
  });

  it("also when the key is removed and not committed", () => {
    const root = countered();
    change(root, VERIFICATION, (v) => { delete v.judgement; });
    kept(root, judge(root));
  });

  it("also after a commit that changes nothing covered", () => {
    const root = countered();
    put(root, "README.md", "x\n");
    commit(root);
    kept(root, judge(root));
  });

  it("until a commit removes the judgement key", () => {
    const root = countered();
    change(root, VERIFICATION, (v) => { delete v.judgement; });
    commit(root);
    passes(judge(root));
  });

  it("but a stale one can be replaced", () => {
    const root = countered();
    rewrite(root, CODE, "n += 1", "n++");
    commit(root);
    passes(judge(root));
    assert.equal(json(root, VERIFICATION).judgement.verdict, "no-counter-example");
  });

  it("and another counter-example can replace it", () => {
    const root = countered();
    passes(judge(root, { verdict: "counter-example", by: "second judge" }));
  });
});

describe("verify: only real drift is stale", () => {
  const inc = (m) => m.actions.inc.code[0];
  const after = (edit) => {
    const root = project({ model: true });
    edit(root);
    commit(root);
    return verify(judged(root));
  };
  for (const [name, edit, pattern] of [
    ["a reference with no pin", (root) => change(root, MANIFEST, (m) => { delete inc(m).pin; }), /no pin/],
    ["a pin that is not a pin", (root) => change(root, MANIFEST, (m) => { inc(m).pin = "checked"; }), /is not a pin that model-pin wrote/],
    ["a cited file that is not UTF-8", (root) => writeFileSync(path.join(root, MODEL_CODE), Buffer.from([0xff, 0xfe, 0x0a])), /is not valid UTF-8/],
  ]) it(`gives unverified for ${name}`, () => {
    state(after(edit), "unverified", pattern, /model-pin/);
  });

  it("gives stale for pinned lines past the end of the file", () => {
    state(after((root) => change(root, MANIFEST, (m) => { inc(m).lines = "L8-L9"; })), "stale", /drift: lines L8-L9/);
  });
});

describe("verify --base: a record at the base that cannot be read", () => {
  const damaged = (damage) => {
    const root = project();
    const held = get(root, RECORD);
    damage(root, held);
    const base = commit(root);
    rmSync(path.join(root, RECORD));
    put(root, RECORD, held);
    commit(root);
    return { root, base, held };
  };
  const cases = [
    ["is not UTF-8", (root) => writeFileSync(path.join(root, RECORD), Buffer.from([0xff, 0xfe, 0x0a]))],
    ["is a symlink", (root) => { rmSync(path.join(root, RECORD)); symlinkSync("/nowhere.md", path.join(root, RECORD)); }],
    ["has no front matter", (root) => put(root, RECORD, "## Statement\n\nx\n")],
  ];
  for (const [name, damage] of cases) {
    it(`does not block the repair of a record that ${name}, and selects its requirement`, () => {
      const { root, base } = damaged(damage);
      judged(root);
      const out = run(root, ["verify", "--base", base]);
      passes(out);
      assert.match(out.stdout, /^REQ-0001: verified$/m);
    });

    it(`fails when the repair of a record that ${name} leaves it not in force`, () => {
      const { root, base } = damaged(damage);
      rewrite(root, RECORD, "status: Accepted", "status: Rejected");
      commit(root);
      fails(run(root, ["verify", "--base", base]), /Not verified: REQ-0001: .*base cannot be read/, /Repair:/);
    });

    it(`fails when a record that ${name} has no record with its number at HEAD`, () => {
      const { root, base } = damaged(damage);
      rmSync(path.join(root, RECORD));
      put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002" }));
      commit(root);
      fails(run(root, ["verify", "--base", base]), /Not verified: REQ-0001: .*base cannot be read.*no record/, /Repair:/);
    });
  }
});

describe("verify --report: a command line that cannot be read", () => {
  for (const [name, args] of [["--base has no value after it", (r) => ["--report", r, "--base"]], ["--base takes the --report option as its value", (r) => ["--base", "--report", r]]]) it(`leaves no earlier report when ${name}`, () => {
    const root = verified();
    const report = path.join(mkdtempSync(path.join(tmpdir(), "verify-report-")), "report.json");
    passes(verify(root, "REQ-0001", "--report", report));
    assert.equal(existsSync(report), true);
    const out = spawnSync(NDEV, ["requirements", "verify", "--root", root, ...args(report)], { encoding: "utf8" });
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /--base needs a value/);
    assert.equal(existsSync(report), false);
  });

  it("keeps a file that is not a report", () => {
    const root = verified();
    const file = outsideFile("my work\n");
    const out = spawnSync(NDEV, ["requirements", "verify", "--root", root, "--report", file, "--base"], { encoding: "utf8" });
    assert.notEqual(out.status, 0);
    assert.equal(readFileSync(file, "utf8"), "my work\n");
  });

  it("does not remove a report for another command", () => {
    const root = verified();
    const report = outsideFile(`{"kind":"ndev-requirements-verification"}\n`);
    assert.equal(spawnSync(NDEV, ["requirements", "check", "--root", root, "--report", report, "--base"], { encoding: "utf8" }).status, 2);
    assert.equal(existsSync(report), true);
  });
});

describe("verify: a requirement with no Statement", () => {
  for (const [name, edit] of [
    ["no Statement section", (text) => text.replace(`## Statement\n\n${STATEMENT}\n\n`, "")],
    ["an empty Statement", (text) => text.replace(`## Statement\n\n${STATEMENT}\n`, "## Statement\n")],
  ]) {
    it(`stops the brief and the judge with ${name}`, () => {
      const root = project();
      put(root, RECORD, edit(get(root, RECORD)));
      commit(root);
      fails(run(root, ["verify-brief", "REQ-0001"]), /REQ-0001 has no Statement/, /Repair:/);
      fails(judge(root), /REQ-0001 has no Statement/);
    });

    it(`never gives verified with ${name}, also with a judgement that matches it`, () => {
      const root = verified();
      put(root, RECORD, edit(get(root, RECORD)));
      change(root, VERIFICATION, (v) => { v.judgement.covers.statement = `sha256:${createHash("sha256").update("").digest("hex")}`; });
      commit(root);
      state(verify(root), "unverified", /REQ-0001 has no Statement/, /Repair:/);
    });
  }
});

describe("verify --base: a current counter-example at the merge base", () => {
  const countered = () => {
    const root = judged(project(), { verdict: "counter-example", by: "first judge" });
    return { root, base: git(root, "rev-parse", "HEAD") };
  };
  const STANDS = /the merge base holds a current counter-example by first judge/;
  const REASON = "the human read the case: the Statement allows it";

  for (const [name, edit] of [
    ["a commit that removes the judgement, then a new judgement", (root) => {
      change(root, VERIFICATION, (v) => { delete v.judgement; });
      commit(root);
      passes(judge(root));
    }],
    ["a verdict changed by hand", (root) => change(root, VERIFICATION, (v) => { v.judgement.verdict = "no-counter-example"; })],
    ["a commit that only removes the judgement", (root) => change(root, VERIFICATION, (v) => { delete v.judgement; })],
    ["a hand-written overrules that does not copy the counter-example", (root) => change(root, VERIFICATION, (v) => {
      v.judgement.verdict = "no-counter-example";
      v.judgement.overrules = { by: "first judge", evidence: "something else\n", reason: REASON };
    })],
  ]) it(`is not replaced by ${name}`, () => {
    const { root, base } = countered();
    edit(root);
    commit(root);
    state(run(root, ["verify", "--base", base]), "violated", STANDS, /Repair:.*--overrule/);
  });

  it("can be overruled with verify-judge --overrule, which copies it into the judgement", () => {
    const { root, base } = countered();
    passes(judge(root, { by: "a second judge", overrule: REASON }));
    const { judgement } = json(root, VERIFICATION);
    assert.equal(judgement.verdict, "no-counter-example");
    assert.deepEqual(judgement.overrules, { by: "first judge", evidence: EVIDENCE, commit: JSON.parse(git(root, "show", `${base}:${VERIFICATION}`)).judgement.commit, reason: REASON });
    commit(root);
    const out = run(root, ["verify", "--base", base]);
    passes(out);
    assert.match(out.stdout, /^REQ-0001: verified$/m);
  });

  it("no longer holds when the covered content changes", () => {
    const { root, base } = countered();
    rewrite(root, CODE, "n += 1", "n++");
    commit(root);
    judged(root);
    passes(run(root, ["verify", "--base", base]));
  });
});

describe("verify-judge --overrule", () => {
  it("is refused when there is no current counter-example", () => {
    const root = project();
    fails(judge(root, { overrule: "no reason" }), /no current counter-example to overrule/);
    assert.equal(json(root, VERIFICATION).judgement, undefined);
  });

  it("is refused with the verdict counter-example", () => {
    const root = judged(project(), { verdict: "counter-example", by: "first judge" });
    const out = judge(root, { verdict: "counter-example", overrule: "no reason" });
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /--overrule/);
  });

  it("is refused with an empty reason", () => {
    const root = judged(project(), { verdict: "counter-example", by: "first judge" });
    assert.equal(judge(root, { overrule: " " }).status, 2);
  });
});

describe("verify: a clone that checkout converts", () => {
  it("is not refused when .gitattributes asks for CRLF line ends", () => {
    const root = project();
    put(root, ".gitattributes", "*.ts text eol=crlf\n");
    commit(root);
    judged(root);
    state(verify(root), "verified");
    const clone = path.join(mkdtempSync(path.join(tmpdir(), "verify-clone-")), "clone");
    assert.equal(spawnSync("git", ["clone", "-q", root, clone]).status, 0);
    assert.match(get(clone, CODE), /\r\n/);
    assert.equal(git(clone, "status", "--porcelain"), "");
    state(verify(clone), "verified");
  });

  it("still refuses a file that a clean filter changes, with CRLF line ends", () => {
    const root = project();
    put(root, ".gitattributes", "*.ts text eol=crlf filter=three\n");
    commit(root);
    judged(root);
    git(root, "config", "filter.three.clean", "sed s/9/3/g");
    rewrite(root, CODE, "n < 3", "n < 9");
    fails(verify(root), /src\/counter\.ts on disk is not the file of commit/);
  });
});

describe("verify: the records folders hold only records", () => {
  for (const args of [["--all"], ["--base", "HEAD~1"]]) it(`fails ${args[0]} for a file whose name is not the name of a record`, () => {
    const root = verified();
    put(root, `${RECORDS}/0002_other.md`, recordText({ id: "REQ-0002" }));
    commit(root);
    fails(run(root, ["verify", ...args]), /docs\/formal\/requirements\/0002_other\.md is not named as a record/, /Repair:/);
  });

  it("accepts a README", () => {
    const root = verified();
    put(root, `${RECORDS}/README.md`, "records\n");
    commit(root);
    passes(run(root, ["verify", "--all"]));
  });
});

describe("verify: a linked file that is a symlink", () => {
  it("gives only its requirement unverified, and stops its brief", () => {
    const root = project({ files: ["src/*"] });
    symlinkSync("counter.ts", path.join(root, "src/link.ts"));
    put(root, `${RECORDS}/0002-other.md`, recordText({ id: "REQ-0002", files: ["lib/other.ts"] }));
    put(root, "lib/other.ts", "x\n");
    commit(root);
    const out = run(root, ["verify", "--all"]);
    fails(out, /^REQ-0001: unverified$/m, /src\/link\.ts is a symlink in commit/, /Repair:/, /^REQ-0002: unverified$/m);
    fails(run(root, ["verify-brief", "REQ-0001"]), /src\/link\.ts is a symlink in commit/);
  });
});

describe("verify: .gitattributes changes what a check runs", () => {
  it("is covered when it is in the root or in a folder above a covered file", () => {
    const root = project();
    put(root, ".gitattributes", "*.ts text\n");
    put(root, "tests/.gitattributes", "*.mjs text\n");
    put(root, "other/.gitattributes", "*.md text\n");
    commit(root);
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, /^- git attributes: \.gitattributes$/m);
    assert.match(brief.stdout, /^- git attributes: tests\/\.gitattributes$/m);
    assert.doesNotMatch(brief.stdout, /other\/\.gitattributes/);
  });

  for (const rel of [".gitattributes", "tests/.gitattributes"]) it(`selects the requirement when a change adds ${rel}`, () => {
    const root = verified();
    const base = git(root, "rev-parse", "HEAD");
    put(root, rel, `${path.posix.basename(CHECK)} ident\n`);
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: stale$/m, new RegExp(`git attributes ${rel.replace(".", "\\.")} is new`));
  });

  it("does not select the requirement for .gitattributes in another folder", () => {
    const root = verified();
    const base = git(root, "rev-parse", "HEAD");
    put(root, "other/.gitattributes", "* ident\n");
    commit(root);
    const out = run(root, ["verify", "--base", base]);
    passes(out);
    assert.match(out.stdout, /touch no requirement/);
  });
});

describe("verify-judge --base: a counter-example at the merge base", () => {
  const REASON = "the human read the case: the Statement allows it";
  const reverted = () => {
    const root = judged(project(), { verdict: "counter-example", by: "first judge" });
    const base = git(root, "rev-parse", "HEAD");
    rewrite(root, CODE, "n += 1", "n++");
    commit(root);
    judged(root);
    rewrite(root, CODE, "n++", "n += 1");
    commit(root);
    return { root, base };
  };

  it("refuses a plain pass over it while its covered content is the same", () => {
    const { root, base } = reverted();
    fails(run(root, ["verify-judge", "REQ-0001", "--commit", git(root, "rev-parse", "HEAD"), "--verdict", "no-counter-example", "--by", "a judge", "--evidence", outsideFile(EVIDENCE), "--base", base]), /current counter-example at the merge base/, /--overrule/);
  });

  it("keeps the plain pass without --base", () => {
    passes(judge(reverted().root));
  });

  it("overrules it with --overrule, and verify --base accepts that", () => {
    const { root, base } = reverted();
    passes(run(root, ["verify-judge", "REQ-0001", "--commit", git(root, "rev-parse", "HEAD"), "--verdict", "no-counter-example", "--by", "a judge", "--evidence", outsideFile(EVIDENCE), "--base", base, "--overrule", REASON]));
    assert.deepEqual(json(root, VERIFICATION).judgement.overrules, { by: "first judge", evidence: EVIDENCE, commit: JSON.parse(git(root, "show", `${base}:${VERIFICATION}`)).judgement.commit, reason: REASON });
    commit(root);
    passes(run(root, ["verify", "--base", base]));
  });

  it("is not answered by overrules with another commit", () => {
    const { root, base } = reverted();
    change(root, VERIFICATION, (v) => { v.judgement.overrules = { by: "first judge", evidence: EVIDENCE, commit: git(root, "rev-parse", "HEAD"), reason: REASON }; });
    commit(root);
    state(run(root, ["verify", "--base", base]), "violated", /merge base holds a current counter-example/, new RegExp(`verify-judge REQ-0001 --base ${base} --overrule`));
  });
});

describe("verify --report: an option that is not known", () => {
  it("keeps the earlier report", () => {
    const root = verified();
    const report = path.join(mkdtempSync(path.join(tmpdir(), "verify-report-")), "report.json");
    passes(verify(root, "REQ-0001", "--report", report));
    const out = verify(root, "REQ-0001", "--report", report, "--bogus", "x");
    assert.equal(out.status, 2, out.stderr);
    assert.equal(existsSync(report), true);
  });
});

describe("verify: what a check runs is covered", () => {
  const REAL = "tests/real.mjs";
  const RUNNER = "tests/runner.mjs";
  const CASES = "tests/cases";
  const RUNNER_TEXT = 'import { readdirSync } from "node:fs";\nimport path from "node:path";\nconst dir = process.argv[2].endsWith("/") ? process.argv[2] : path.dirname(process.argv[2]);\nlet n = 0;\nfor (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) { await import(path.resolve(dir, f)); n++; }\nconsole.log(`ran ${n} test`);\n';
  const checking = (run, extra) => {
    const root = project();
    put(root, REAL, "export {};\n");
    put(root, RUNNER, RUNNER_TEXT);
    put(root, `${CASES}/a.mjs`, "export {};\n");
    extra?.(root);
    change(root, VERIFICATION, (v) => { v.checks[0].run = typeof run === "function" ? run(root) : run; });
    commit(root);
    return root;
  };
  const selects = (root, rel, text = "process.exit(1);\n") => {
    judged(root);
    state(verify(root), "verified");
    const base = git(root, "rev-parse", "HEAD");
    put(root, rel, text);
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: (violated|stale)$/m);
  };

  for (const [name, args, changed] of [
    ["the value after = in an option", ["node", `--import=./${REAL}`, CHECK], REAL],
    ["the value after the second =", ["env", `NODE_OPTIONS=--import=./${REAL}`, "node", CHECK], REAL],
    ["an absolute path inside the project", (root) => ["node", `--import=${realpathSync(root)}/${REAL}`, CHECK], REAL],
    ["the project root as .", ["node", CHECK, "."], REAL],
    ["a folder", ["node", RUNNER, `${CASES}/`], `${CASES}/b.mjs`],
    ["a glob that the program expands", ["node", RUNNER, `${CASES}/*.mjs`], `${CASES}/b.mjs`],
  ]) it(`covers ${name}, and selects the requirement on a change to it`, () => {
    const root = checking(args);
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, /^- run target: /m);
    selects(root, changed);
  });

  it("reads only the value after the second = when the first value is no path", () => {
    const root = checking(["env", `NODE_OPTIONS=--import=./${REAL}`, "node", CHECK]);
    assert.match(run(root, ["verify-brief", "REQ-0001"]).stdout, new RegExp(`^- run target: ${REAL}$`, "m"));
  });

  it("does not cover an absolute path outside the project", () => {
    const root = checking(["node", CHECK, outsideFile("x\n")]);
    assert.doesNotMatch(run(root, ["verify-brief", "REQ-0001"]).stdout, /^- run target: .*outside/m);
  });

  for (const [name, args, folder] of [["--test-reporter=spec with a tracked spec folder", ["node", CHECK, "--test-reporter=spec"], "spec"]]) it(`does not refuse ${name}`, () => {
    const root = checking(args, (r) => put(r, `${folder}/x.mjs`, "export {};\n"));
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, new RegExp(`^- run target: ${folder}/x\\.mjs$`, "m"));
  });

  for (const [name, args, extra] of [
    ["node --test with no path", ["node", "--test"]],
    ["npm test", ["npm", "test"]],
    ["npm test with a tracked test folder", ["npm", "test"], (r) => put(r, "test/x.mjs", "export {};\n")],
    ["make test with a tracked test folder", ["make", "test"], (r) => put(r, "test/x.mjs", "export {};\n")],
    ["sh -c with a tracked test folder", ["sh", "-c", "test"], (r) => put(r, "test/x.mjs", "export {};\n")],
  ]) it(`refuses ${name}, which names no tracked file`, () => {
    const root = checking(args, extra);
    const pattern = /check "counter" runs no tracked file or folder/;
    fails(run(root, ["verify-brief", "REQ-0001"]), pattern, /Repair: name the test files or folders in "run"/);
    fails(judge(root), pattern);
    const out = verify(root);
    fails(out, pattern);
    assert.doesNotMatch(out.stdout + out.stderr, /REQ-0001: verified/);
  });

  it("selects with --base a check that names no tracked file, for any change", () => {
    const root = checking(["node", "--test"]);
    const base = git(root, "rev-parse", "HEAD");
    put(root, "tests/other.test.mjs", "process.exit(1);\n");
    commit(root);
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: unverified$/m, /runs no tracked file or folder/);
  });

  it("refuses a path that goes through a symlink, also when .. leaves it again", () => {
    const root = checking(["sh", "tests/sub/../c.sh"], (r) => {
      put(r, "tests/c.sh", "echo ran 1 test\n");
      put(r, "elsewhere/inner/keep", "x\n");
      symlinkSync("../elsewhere/inner", path.join(r, "tests/sub"));
    });
    const pattern = /check "counter" runs tests\/sub\/\.\.\/c\.sh, and tests\/sub is a symlink in commit/;
    fails(run(root, ["verify-brief", "REQ-0001"]), pattern, /Repair: name the real path in "run" in docs\/formal\/verification\/REQ-0001\.json\./);
    fails(judge(root), pattern);
  });

  const nodeTest = (args, extra) => {
    const root = project();
    put(root, "tests/c.mjs", 'console.log("pass 1");\n');
    put(root, "tests/h.mjs", 'console.log("helper");\n');
    extra?.(root);
    change(root, VERIFICATION, (v) => { v.checks[0] = { ...v.checks[0], run: typeof args === "function" ? args(root) : args, files: ["tests/c.mjs"], proof: "pass [1-9]" }; });
    commit(root);
    return root;
  };
  const bothFail = (root, rel, text) => {
    if (judge(root).status === 0) commit(root);
    const base = git(root, "rev-parse", "HEAD");
    put(root, rel, text);
    commit(root);
    assert.equal(verify(root).status, 1, "verify REQ-0001 passes after the change");
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: (violated|stale|unverified)$/m);
  };
  const BROKEN = 'console.log("pass 1");\nprocess.exit(1);\n';

  for (const [name, pattern, why, extra, broken = "tests/h.mjs"] of [
    ["a character class", "tests/[h].mjs", "uses glob syntax that verify does not read"],
    ["a brace", "tests/{h,x}.mjs", "uses glob syntax that verify does not read"],
    ["a .. segment", "tests/../tests/h*.mjs", "has an empty, \\. or \\.\\. segment"],
    ["an empty segment", "tests//*.mjs", "has an empty, \\. or \\.\\. segment"],
    ["a ** that is not a whole segment", "tests/**.mjs", "has a \\*\\* that is not a whole segment"],
    ["a literal prefix through a tracked symlink", "tests/more/*.mjs", "tests/more is a symlink", (r) => { put(r, "extra/h.mjs", 'console.log("helper");\n'); symlinkSync("../extra", path.join(r, "tests/more")); }, "extra/h.mjs"],
    ["no match", "tests/none*.mjs", "a pattern that matches no tracked file"],
  ]) it(`refuses a glob with ${name}, so --base selects the requirement where verify fails`, () => {
    const root = nodeTest(["node", "--test", "tests/c.mjs", pattern], extra);
    fails(run(root, ["verify-brief", "REQ-0001"]), new RegExp(`check "counter" runs ${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, (and )?(it )?${why}.*Repair:`));
    bothFail(root, broken, BROKEN);
  });

  it("refuses npm test whose word test names a tracked folder, so --base selects the requirement where verify fails", () => {
    const root = nodeTest(["npm", "test", "--silent"], (r) => {
      put(r, "test/README.txt", "x\n");
      putJson(r, "package.json", { name: "p", private: true, scripts: { test: "node tests/c.mjs && node tests/h.mjs" } });
    });
    fails(run(root, ["verify-brief", "REQ-0001"]), /runs no tracked file or folder/);
    bothFail(root, "tests/h.mjs", BROKEN);
  });

  it("walks an absolute path with its .. through a tracked symlink, so --base selects the requirement where verify fails", () => {
    const root = nodeTest((r) => ["sh", `${realpathSync(r)}/lnk/../t2/h.sh`], (r) => {
      put(r, "sub/inner/keep", "x\n");
      put(r, "sub/t2/h.sh", "echo pass 1\n");
      put(r, "t2/h.sh", "echo pass 1\n");
      symlinkSync("sub/inner", path.join(r, "lnk"));
    });
    fails(run(root, ["verify-brief", "REQ-0001"]), /and lnk is a symlink in commit/);
    bothFail(root, "sub/t2/h.sh", "echo pass 1\nexit 1\n");
  });

  for (const [name, args, target, extra] of [
    ["go test ./...", ["go", "test", "./..."], CHECK],
    ["go test ./pkg/...", ["go", "test", "./pkg/..."], "pkg/x_test.go", (r) => put(r, "pkg/x_test.go", "package pkg\n")],
    ["a pytest node id", ["pytest", "tests/test_x.py::test_bound"], "tests/test_x.py", (r) => put(r, "tests/test_x.py", "def test_bound(): pass\n")],
    ["a file with a line", ["npx", "vitest", "run", "tests/h.mjs:3"], "tests/h.mjs"],
    ["a file with a line and a column", ["npx", "vitest", "run", "tests/h.mjs:3:5"], "tests/h.mjs"],
  ]) it(`reads ${name} as a run target`, () => {
    const root = nodeTest(args, extra);
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, new RegExp(`^- run target: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });

  it("refuses a submodule named in run", () => {
    const root = nodeTest(["node", "tests/c.mjs", "vendor/lib"]);
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},vendor/lib`);
    git(root, "commit", "-qm", "submodule");
    fails(run(root, ["verify-brief", "REQ-0001"]), /check "counter" runs vendor\/lib, and vendor\/lib is a submodule in commit .*Repair:/);
  });

  const gitlink = (root, rel, sha = git(root, "rev-parse", "HEAD")) => git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},${rel}`);
  const selectedAfter = (root, edit) => {
    if (judge(root).status === 0) commit(root);
    const base = git(root, "rev-parse", "HEAD");
    edit(root);
    git(root, "commit", "-qam", "bump", "--allow-empty");
    fails(run(root, ["verify", "--base", base]), /^REQ-0001: (violated|stale|unverified)$/m);
  };
  for (const [name, args] of [
    ["a pattern", ["node", "--test", "tests/c.mjs", "tests/**/*.test.mjs"]],
    ["a folder", ["node", "--test", "tests/"]],
  ]) it(`refuses a submodule inside ${name} in run, so --base selects the requirement when the submodule changes`, () => {
    const root = nodeTest(args, (r) => put(r, "tests/a.test.mjs", 'console.log("pass 1");\n'));
    gitlink(root, "tests/vend");
    git(root, "commit", "-qm", "submodule");
    fails(run(root, ["verify-brief", "REQ-0001"]), /check "counter" runs tests\/.*, and tests\/vend is a submodule in commit .*Repair:/);
    selectedAfter(root, (r) => gitlink(r, "tests/vend", git(r, "rev-parse", "HEAD~1")));
  });

  for (const [name, args, extra] of [
    ["a coverage glob after =", ["node", "--test", "--experimental-test-coverage", "--test-coverage-include=src/**", "tests/c.mjs"]],
    ["a test name regex after =", ["node", "--test", "--test-name-pattern=/bound.*/i", "tests/c.mjs"]],
    ["an argument with = whose whole text looks like a pattern in a tracked folder", ["node", "--test", "tests/c.mjs", "tests/report=*.json"]],
    ["a Go subtest regex", ["go", "test", "./pkg", "-run", "TestBound/case_.*"], (r) => put(r, "pkg/x_test.go", "package pkg\n")],
    ["a Go subtest regex after =", ["go", "test", "./pkg", "-run=TestBound/case_[0-9]+"], (r) => put(r, "pkg/x_test.go", "package pkg\n")],
  ]) it(`does not refuse ${name}`, () => passes(run(nodeTest(args, extra), ["verify-brief", "REQ-0001"])));

  it("refuses a pattern with no fixed folder that matches nothing", () => {
    fails(run(nodeTest(["node", "--test", "tests/c.mjs", "*/none*.mjs"]), ["verify-brief", "REQ-0001"]), /runs \*\/none\*\.mjs, a pattern that matches no tracked file/);
  });

  it("covers a symlink inside a run-target folder as its link text", () => {
    const root = nodeTest(["go", "test", "./..."], (r) => {
      put(r, "AGENTS.md", "x\n");
      symlinkSync("AGENTS.md", path.join(r, "CLAUDE.md"));
    });
    const brief = run(root, ["verify-brief", "REQ-0001"]);
    passes(brief);
    assert.match(brief.stdout, /^- run target: CLAUDE\.md$/m);
  });

  it("makes the judgement stale when the text of a symlink inside a run-target folder changes", () => {
    const root = checking(["node", CHECK, "."], (r) => {
      put(r, "AGENTS.md", "x\n");
      put(r, "README.md", "y\n");
      symlinkSync("AGENTS.md", path.join(r, "CLAUDE.md"));
    });
    judged(root);
    state(verify(root), "verified");
    rmSync(path.join(root, "CLAUDE.md"));
    symlinkSync("README.md", path.join(root, "CLAUDE.md"));
    commit(root);
    state(verify(root), "stale", /run target CLAUDE\.md changed/);
  });

  it("refuses a covered symlink whose text on disk is not the text of the commit", () => {
    const root = checking(["node", CHECK, "."], (r) => {
      put(r, "AGENTS.md", "x\n");
      put(r, "README.md", "y\n");
      symlinkSync("AGENTS.md", path.join(r, "CLAUDE.md"));
    });
    judged(root);
    rmSync(path.join(root, "CLAUDE.md"));
    symlinkSync("README.md", path.join(root, "CLAUDE.md"));
    fails(run(root, ["verify-brief", "REQ-0001"]), /CLAUDE\.md on disk is not the symlink of commit .*, which points to AGENTS\.md\./);
  });

  it("lists a folder in files, and covers each file in it", () => {
    const root = checking(["node", RUNNER, `${CASES}/`], (r) => change(r, VERIFICATION, (v) => { v.checks[0].files = [RUNNER, CASES]; }));
    judged(root);
    assert.ok(json(root, VERIFICATION).judgement.covers[`check test ${CASES}/a.mjs`]);
  });
});
