import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_QUINT } from "./fake-quint.mjs";

const NDEV = path.join(import.meta.dirname, "..", "..", "..", "bin", "ndev");
const MODELS = "docs/formal/models";
const MANIFEST = `${MODELS}/counter.json`;
const MODEL = `${MODELS}/counter.qnt`;
const TEST_MODEL = `${MODELS}/counter_test.qnt`;
const RECORD = "docs/formal/requirements/0001-the-count-stays-bounded.md";
const CODE = "src/counter.ts";

const MODEL_TEXT = `module counter {
  // action ghostInComment = true
  /* action ghostInBlock = true */
  pure val note = "action ghostInString = //"
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
const CODE_TEXT = "export let n = 0;\nexport function inc() {\n  if (n < 3) n += 1;\n}\n";
const recordText = ({ status = "Accepted", model = [`${MODEL}#bounded`] } = {}) =>
  `---\nid: REQ-0001\ntitle: The count stays bounded\nstatus: ${status}\n${model.length ? `model:\n${model.map((m) => `  - ${m}`).join("\n")}\n` : ""}---\n\n## Statement\n\nThe count stays at 3 or less.\n`;
const manifest = () => ({
  model: "counter.qnt",
  requirements: ["REQ-0001"],
  assumptions: ["one writer"],
  bounds: { steps: 20, samples: 100, seed: "0x1", limits: ["one counter"] },
  invariants: ["bounded"],
  witnesses: ["full"],
  mutants: [{ invariant: "bounded", find: "n < 3", replace: "n < 5", why: "the limit in the guard is wrong" }],
  actions: { init: { none: "the start state" }, inc: { code: [{ file: CODE, lines: "L2-L4" }] }, step: { none: "the choice of the next action" } },
});

const put = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const get = (root, rel) => readFileSync(path.join(root, rel), "utf8");
const readManifest = (root, rel = MANIFEST) => JSON.parse(get(root, rel));
const writeManifest = (root, value, rel = MANIFEST) => put(root, rel, `${JSON.stringify(value, null, 2)}\n`);
const change = (root, edit, rel = MANIFEST) => {
  const value = readManifest(root, rel);
  edit(value);
  writeManifest(root, value, rel);
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
  git(root, "commit", "-qm", "change");
};
const run = (root, args, env = {}) => {
  const out = spawnSync(NDEV, ["requirements", ...args, "--root", root], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const check = (root, ...args) => run(root, ["model-check", ...args]);
const pin = (root, ...args) => run(root, ["model-pin", ...args]);

function unpinned() {
  const root = mkdtempSync(path.join(tmpdir(), "models-test-"));
  put(root, MODEL, MODEL_TEXT);
  put(root, TEST_MODEL, TEST_TEXT);
  put(root, RECORD, recordText());
  put(root, CODE, CODE_TEXT);
  writeManifest(root, manifest());
  put(root, "node_modules/.bin/quint", FAKE_QUINT);
  chmodSync(path.join(root, "node_modules/.bin/quint"), 0o755);
  put(root, ".gitignore", "node_modules\n");
  git(root, "init", "-q");
  commit(root);
  return root;
}

function pinned() {
  const root = unpinned();
  const out = pin(root, MANIFEST);
  assert.equal(out.status, 0, out.stderr);
  return root;
}

const fails = (out, ...patterns) => {
  assert.equal(out.status, 1, `status ${out.status}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
  for (const pattern of patterns) assert.match(out.stderr, pattern);
};
const passes = (out) => assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);

describe("model-check", () => {
  it("passes a complete model, and says the counts, the bounds and that the search is not a proof", () => {
    const root = pinned();
    const out = check(root);
    passes(out);
    assert.match(out.stdout, /1 invariant, 1 mutant, 1 witness/);
    assert.match(out.stdout, /counter\.json: .*steps 20, samples 100, seed 0x1/);
    assert.match(out.stdout, /one counter/);
    assert.match(out.stdout, /bounded random search, not an exhaustive proof/);
    assert.doesNotMatch(out.stdout, /[Nn]ot checked/);
  });

  it("runs Quint with the typescript backend and the bounds of the manifest, and runs the tests as the formal check does", () => {
    const root = pinned();
    const log = path.join(root, "node_modules/quint.log");
    passes(run(root, ["model-check", MANIFEST], { FAKE_QUINT_LOG: log }));
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const invariant = calls.find((c) => c.args.includes("--invariant=bounded"));
    assert.deepEqual(invariant.args, ["run", "counter.qnt", "--backend=typescript", "--main=counter", "--invariant=bounded", "--max-samples=100", "--max-steps=20", "--seed=0x1"]);
    assert.ok(calls.some((c) => c.args.includes("--invariant=not(full)")));
    assert.deepEqual(calls.find((c) => c.args[0] === "test").args, ["test", "counter_test.qnt", "--backend=typescript", "--main=counter_test", "--match", "Test$"]);
  });

  it("passes the module of the manifest to each run of the model", () => {
    const root = pinned();
    change(root, (m) => { m.module = "counter"; });
    const log = path.join(root, "node_modules/quint.log");
    passes(run(root, ["model-check"], { FAKE_QUINT_LOG: log }));
    const runs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((c) => c.args[0] === "run");
    assert.equal(runs.length, 3);
    for (const call of runs) assert.ok(call.args.includes("--main=counter"), call.args.join(" "));
  });

  it("runs a mutant on a copy that holds the sibling models, keeps the project files and removes the copy", () => {
    const root = pinned();
    put(root, `${MODELS}/lib.qnt`, "module lib {\n}\n");
    rewrite(root, MODEL, "module counter {\n", 'module counter {\n  import lib.* from "./lib"\n');
    const temp = mkdtempSync(path.join(tmpdir(), "models-tmp-"));
    const log = path.join(root, "node_modules/quint.log");
    const before = get(root, MODEL);
    const out = run(root, ["model-check"], { TMPDIR: temp, FAKE_QUINT_LOG: log });
    passes(out);
    assert.equal(get(root, MODEL), before);
    assert.deepEqual(readdirSync(temp), []);
    assert.ok(readFileSync(log, "utf8").trim().split("\n").some((line) => JSON.parse(line).cwd.includes(path.basename(temp))));
    assert.match(out.stdout, /Not checked: docs\/formal\/models\/lib\.qnt \(no manifest\)/);
  });

  it("does not write through a model that is a link", () => {
    const root = pinned();
    put(root, "specs/counter.qnt", MODEL_TEXT);
    rmSync(path.join(root, MODEL));
    symlinkSync(path.join(root, "specs/counter.qnt"), path.join(root, MODEL));
    passes(check(root));
    assert.equal(get(root, "specs/counter.qnt"), MODEL_TEXT);
  });

  const nested = (root) => {
    put(root, `${MODELS}/lib.qnt`, "module lib {\n}\n");
    put(root, `${MODELS}/sub/counter.qnt`, MODEL_TEXT.replace("module counter {\n", 'module counter {\n  import lib.* from "./../lib"\n'));
    writeManifest(root, readManifest(root), `${MODELS}/sub/counter.json`);
    put(root, RECORD, recordText({ model: [MODEL, `${MODELS}/sub/counter.qnt`] }));
    return `${MODELS}/sub/counter.json`;
  };

  it("copies the whole models folder for a mutant of a model in a subfolder", () => {
    const root = pinned();
    const log = path.join(root, "node_modules/quint.log");
    passes(run(root, ["model-check", nested(root)], { FAKE_QUINT_LOG: log }));
    const copies = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).cwd).filter((cwd) => cwd.includes("ndev-model-mutant-"));
    assert.ok(copies.length > 0 && copies.every((cwd) => /ndev-model-mutant-\w+\/sub$/.test(cwd)), copies.join());
  });

  it("says that a manifest in a subfolder was not checked unless it is named", () => {
    const root = pinned();
    nested(root);
    const out = check(root);
    passes(out);
    assert.match(out.stdout, /Not checked: docs\/formal\/models\/sub\/counter\.qnt \(name docs\/formal\/models\/sub\/counter\.json to check it\)/);
  });

  it("refuses a mutant when the folder of the model is a link inside the models folder", () => {
    const root = pinned();
    for (const file of ["counter.qnt", "counter.json"]) put(root, `specs/${file}`, get(root, `${MODELS}/${file}`));
    symlinkSync(path.join(root, "specs"), path.join(root, `${MODELS}/linked`));
    put(root, RECORD, recordText({ model: [MODEL, "specs/counter.qnt", `${MODELS}/linked/counter.qnt`] }));
    fails(check(root, `${MODELS}/linked/counter.json`), /linked\/counter\.json: mutants\[0\]/, /behind a link/);
    assert.equal(get(root, "specs/counter.qnt"), MODEL_TEXT);
  });

  it("keeps the name of a model when the models folder is a link inside the project", () => {
    const root = pinned();
    mkdirSync(path.join(root, "specs"));
    for (const file of ["counter.qnt", "counter_test.qnt", "counter.json"]) put(root, `specs/${file}`, get(root, `${MODELS}/${file}`));
    rmSync(path.join(root, MODELS), { recursive: true });
    symlinkSync(path.join(root, "specs"), path.join(root, MODELS));
    passes(check(root, MANIFEST));
    assert.equal(get(root, "specs/counter.qnt"), MODEL_TEXT);
  });

  it("fails with no manifest, and lists each model without one", () => {
    const root = pinned();
    rmSync(path.join(root, MANIFEST));
    fails(check(root), /no manifest in docs\/formal\/models/, /nothing was checked/, /Not checked: docs\/formal\/models\/counter\.qnt \(no manifest\)/);
  });

  it("fails in a project with no models folder", () => {
    const root = pinned();
    rmSync(path.join(root, MODELS), { recursive: true });
    fails(check(root), /nothing was checked/);
  });

  it("refuses a manifest that does not exist", () => {
    fails(check(pinned(), `${MODELS}/absent.json`), /absent\.json/, /does not exist/);
  });

  it("refuses a manifest path that leaves the project", () => {
    const root = pinned();
    const other = pinned();
    fails(check(root, path.join(other, MANIFEST)), /outside the project/);
    symlinkSync(path.join(other, MANIFEST), path.join(root, `${MODELS}/linked.json`));
    fails(check(root, `${MODELS}/linked.json`), /linked\.json/, /outside the project/);
  });

  it("refuses an option it does not know", () => {
    const out = run(pinned(), ["model-check", "--quick", MANIFEST]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /--quick/);
  });

  it("gives the result as JSON", () => {
    const out = run(pinned(), ["model-check", "--json"]);
    passes(out);
    const { ok, result } = JSON.parse(out.stdout);
    assert.equal(ok, true);
    assert.deepEqual([result.invariants, result.mutants, result.witnesses], [1, 1, 1]);
    assert.match(result.text, /not an exhaustive proof/);
  });

  it("is in the help", () => {
    const out = spawnSync(NDEV, ["requirements", "--help"], { encoding: "utf8" });
    assert.match(out.stdout, /ndev requirements model-check \[<manifest>\.\.\.\]/);
    assert.match(out.stdout, /ndev requirements model-pin <manifest>\.\.\./);
  });
});

describe("model-check 1: the manifest is complete, with no unknown key", () => {
  const cases = [
    ["a missing key", (m) => { delete m.assumptions; }, /"assumptions"/],
    ["an unknown key", (m) => { m.invariant = []; }, /"invariant" is not a key/],
    ["no requirement", (m) => { m.requirements = []; }, /"requirements"/],
    ["no assumption", (m) => { m.assumptions = []; }, /"assumptions"/],
    ["no invariant", (m) => { m.invariants = []; m.mutants = []; }, /"invariants"/],
    ["a missing witness list", (m) => { delete m.witnesses; }, /"witnesses"/],
    ["an invariant that is not a name", (m) => { m.invariants = ["bounded and full"]; }, /"invariants"/],
    ["a model name that is not the name of the manifest", (m) => { m.model = "other.qnt"; }, /"model".*counter\.qnt/],
    ["a bounds key that is missing", (m) => { delete m.bounds.seed; }, /bounds.*"seed"/],
    ["an unknown bounds key", (m) => { m.bounds.depth = 3; }, /bounds.*"depth"/],
    ["no samples", (m) => { m.bounds.samples = 0; }, /bounds.*"samples"/],
    ["an unknown mutant key", (m) => { m.mutants[0].note = "x"; }, /mutants\[0\].*"note"/],
    ["a mutant with no reason", (m) => { delete m.mutants[0].why; }, /mutants\[0\].*"why"/],
    ["a mutant of an invariant that is not listed", (m) => { m.mutants.push({ ...m.mutants[0], invariant: "other" }); }, /mutants\[1\].*other/],
    ["an action with no code and no reason", (m) => { m.actions.init = {}; }, /actions\.init/],
    ["an action with code and a reason", (m) => { m.actions.inc.none = "x"; }, /actions\.inc/],
    ["an action with an empty code list", (m) => { m.actions.inc = { code: [] }; }, /actions\.inc/],
    ["an unknown code key", (m) => { m.actions.inc.code[0].commit = "x"; }, /actions\.inc\.code\[0\].*"commit"/],
    ["lines that are not a range", (m) => { m.actions.inc.code[0].lines = "2-4"; }, /actions\.inc\.code\[0\].*"lines"/],
  ];
  for (const [name, edit, pattern] of cases) it(`fails ${name}`, () => {
    const root = pinned();
    passes(check(root));
    change(root, edit);
    fails(check(root), /docs\/formal\/models\/counter\.json/, pattern, /Repair|kb\/requirements\.md/);
  });

  it("fails a manifest that is not JSON", () => {
    const root = pinned();
    put(root, MANIFEST, "{");
    fails(check(root), /counter\.json/, /not valid JSON/);
  });

  it("fails a manifest whose model does not exist", () => {
    const root = pinned();
    rmSync(path.join(root, MODEL));
    fails(check(root), /counter\.json/, /counter\.qnt does not exist/);
  });
});

describe("model-check 2: each requirement is a record in force that names the model", () => {
  it("passes a Proposed record that names the model without a part", () => {
    const root = pinned();
    put(root, RECORD, recordText({ status: "Proposed", model: [MODEL] }));
    passes(check(root));
  });

  it("fails a requirement with no record", () => {
    const root = pinned();
    change(root, (m) => { m.requirements.push("REQ-0009"); });
    fails(check(root), /counter\.json/, /REQ-0009 is not a record/);
  });

  it("fails a record that is not in force", () => {
    const root = pinned();
    put(root, RECORD, recordText({ status: "Rejected" }));
    fails(check(root), /counter\.json/, /REQ-0001 is not in force.*Rejected/);
  });

  it("fails a record whose model list does not name the model", () => {
    const root = pinned();
    put(root, RECORD, recordText({ model: [`${MODELS}/other.qnt`] }));
    fails(check(root), /counter\.json/, /REQ-0001.*does not name docs\/formal\/models\/counter\.qnt/, /ndev requirements model REQ-0001 docs\/formal\/models\/counter\.qnt/);
  });
});

describe("model-check 3: the actions of the manifest are the actions of the model", () => {
  it("fails an action of the model that the manifest does not list", () => {
    const root = pinned();
    rewrite(root, MODEL, "  action step = inc\n", "  action step = inc\n  action reset(to: int) = n' = to\n");
    fails(check(root), /counter\.json/, /action "reset".*not in "actions"/);
  });

  it("fails an action of the manifest that the model does not declare", () => {
    const root = pinned();
    change(root, (m) => { m.actions.ghostInComment = { none: "x" }; });
    fails(check(root), /counter\.json/, /"actions" names "ghostInComment".*does not declare/);
  });
});

describe("model-check 4: drift", () => {
  const inc = (m) => m.actions.inc.code[0];

  it("fails a code reference with no pin", () => {
    const root = pinned();
    change(root, (m) => { delete inc(m).pin; });
    fails(check(root), /counter\.json/, /action "inc".*src\/counter\.ts L2-L4.*no pin/, /ndev requirements model-pin docs\/formal\/models\/counter\.json/);
  });

  it("fails cited lines that changed", () => {
    const root = pinned();
    rewrite(root, CODE, "n < 3", "n < 4");
    fails(check(root), /counter\.json/, /action "inc".*src\/counter\.ts L2-L4.*do not match the pin/, /model-pin/);
  });

  it("passes a change outside the cited lines", () => {
    const root = pinned();
    rewrite(root, CODE, "export function inc() {\n  if (n < 3) n += 1;\n}\n", "export function inc() {\n  if (n < 3) n += 1;\n}\nexport const more = 1;\n");
    passes(check(root));
  });

  it("gives the new line numbers when the cited lines moved", () => {
    const root = pinned();
    put(root, CODE, `// one\n// two\n${CODE_TEXT}`);
    fails(check(root), /action "inc"/, /now at L4-L6/);
  });

  it("fails a pin that is not a pin", () => {
    const root = pinned();
    change(root, (m) => { inc(m).pin = "checked"; });
    fails(check(root), /action "inc".*pin "checked"/, /model-pin/);
  });

  for (const value of [null, 7, ["0123456789ab@0123456789012345678901234567890123456789"]]) it(`fails a pin that is ${JSON.stringify(value)}, with its repair`, () => {
    const root = pinned();
    change(root, (m) => { inc(m).pin = value; });
    fails(check(root), /counter\.json: action "inc".*is not a pin that model-pin wrote/, /model-pin/);
  });

  it("fails a code file that does not exist", () => {
    const root = pinned();
    rmSync(path.join(root, CODE));
    fails(check(root), /action "inc".*src\/counter\.ts does not exist/);
  });

  it("fails a range past the end of the file", () => {
    const root = pinned();
    put(root, CODE, "export let n = 0;\n");
    fails(check(root), /action "inc".*L2-L4.*1 line/);
  });

  for (const file of ["../outside.ts", "/etc/hosts", "src/../../outside.ts"]) it(`refuses the code file ${file}`, () => {
    const root = pinned();
    change(root, (m) => { inc(m).file = file; });
    fails(check(root), /counter\.json/, /outside the project/);
  });

  it("refuses a code file that is a link out of the project", () => {
    const root = pinned();
    const other = pinned();
    rmSync(path.join(root, CODE));
    symlinkSync(path.join(other, CODE), path.join(root, CODE));
    fails(check(root), /action "inc"/, /outside the project/);
  });
});

describe("model-check 5: typecheck and tests", () => {
  it("passes a model with no test file", () => {
    const root = pinned();
    rmSync(path.join(root, TEST_MODEL));
    passes(check(root));
  });

  it("fails a model that does not typecheck, with Quint's output", () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // TYPE_ERROR\n");
    fails(check(root), /counter\.json/, /counter\.qnt does not typecheck/, /Trying to unify/, /error: typechecking failed/, /Repair/);
  });

  it("fails a test that fails", () => {
    const root = pinned();
    rewrite(root, TEST_MODEL, "countsTest = pass", "countsTest = fail");
    fails(check(root), /counter\.json/, /counter_test\.qnt module counter_test.*failed/, /error: Tests failed/);
  });

  it("fails a test file in which Quint finds no test", () => {
    const root = pinned();
    rewrite(root, TEST_MODEL, "countsTest", "countsCheck");
    fails(check(root), /counter_test\.qnt/, /no tests matched/);
  });

  it("fails a test run that exits 0 and ran no test", () => {
    const root = pinned();
    rewrite(root, TEST_MODEL, "run countsTest = pass", "// QUIET");
    fails(check(root), /counter_test\.qnt/, /no test ran/, /0 passing/);
  });

  it("fails a test file with no module", () => {
    const root = pinned();
    put(root, TEST_MODEL, "// module commented {\n");
    fails(check(root), /counter_test\.qnt/, /no module/);
  });
});

describe("model-check 6: each invariant holds on the model", () => {
  it("fails a violated invariant, with Quint's output", () => {
    const root = pinned();
    rewrite(root, MODEL, "n < 3", "n < 5");
    change(root, (m) => { m.mutants[0] = { ...m.mutants[0], find: "n < 5", replace: "n < 7" }; });
    fails(check(root), /counter\.json/, /invariant "bounded" is violated/, /\[violation\]/, /error: Invariant violated/, /Repair/);
  });

  it("does not read an exit of 0 without the ok line as a pass", () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // SILENT\n");
    fails(check(root), /invariant "bounded" was not checked/, /exit 0/, /to reproduce/);
  });

  it("does not call a run-time error a violation", () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // RUNTIME\n");
    const out = check(root);
    fails(out, /invariant "bounded" was not checked/, /error: Runtime error/);
    assert.doesNotMatch(out.stderr, /"bounded" is violated/);
  });

  for (const [name, marker, states] of [["a step that can never fire", "STILL", 1], ["an init that is false", "NOINIT", 0]]) it(`does not pass an invariant of a model with ${name}`, () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", `  var n: int // ${marker}\n`);
    fails(check(root), /counter\.json: invariant "bounded" was not checked/, /the model never moved/, new RegExp(`${states} state`), /\[ok\] No violation found/, /Repair/);
  });

  it("does not pass an invariant when Quint prints no trace length", () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // NOSTATS\n");
    fails(check(root), /counter\.json: invariant "bounded" was not checked/, /printed no trace length statistics/, /Repair/);
  });

  it("passes a model whose longest trace has two states", () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // TWOSTATES\n");
    passes(check(root));
  });
});

describe("model-check 7: each invariant has a mutant that violates it", () => {
  const mutant = (root, edit) => change(root, (m) => edit(m.mutants[0]));

  it("fails an invariant with no mutant", () => {
    const root = pinned();
    change(root, (m) => { m.mutants = []; });
    fails(check(root), /counter\.json/, /invariant "bounded" has no mutant/, /Repair/);
  });

  it("fails a mutant text that is not in the model", () => {
    const root = pinned();
    mutant(root, (m) => { m.find = "n < 99"; });
    fails(check(root), /mutants\[0\].*"bounded"/, /occurs 0 times/);
  });

  it("fails a mutant text that is in the model twice", () => {
    const root = pinned();
    mutant(root, (m) => { m.find = "n' = "; });
    fails(check(root), /mutants\[0\]/, /occurs 2 times/);
  });

  it("puts the replacement in as it is written", () => {
    const root = pinned();
    const log = path.join(root, "node_modules/quint.log");
    mutant(root, (m) => { m.replace = "n < 5 /* $& $1 */"; });
    passes(run(root, ["model-check"], { FAKE_QUINT_LOG: log }));
    assert.ok(readFileSync(log, "utf8").trim().split("\n").some((line) => JSON.parse(line).text.includes("all { n < 5 /* $& $1 */, n")));
  });

  it("fails a mutant that does not typecheck", () => {
    const root = pinned();
    mutant(root, (m) => { m.replace = "n < 5 /* TYPE_ERROR */"; });
    fails(check(root), /mutants\[0\].*"bounded"/, /does not typecheck/, /error: typechecking failed/, /Repair/);
  });

  it("fails a mutant that Quint cannot parse", () => {
    const root = pinned();
    mutant(root, (m) => { m.replace = "n < 5 (("; });
    fails(check(root), /mutants\[0\].*"bounded"/, /could not parse/, /Repair/);
  });

  it("fails a mutant that survives", () => {
    const root = pinned();
    mutant(root, (m) => { m.replace = "n < 2"; });
    fails(check(root), /mutants\[0\].*"bounded"/, /did not violate/, /\[ok\] No violation found/, /Repair/);
  });

  for (const [name, replace, output] of [["breaks at run time", "n < 5 /* RUNTIME */", /error: Runtime error/], ["exits 0 with no ok line", "n < 5 /* SILENT */", /to reproduce/]]) it(`does not count a mutant that ${name} as caught`, () => {
    const root = pinned();
    mutant(root, (m) => { m.replace = replace; });
    fails(check(root), /mutants\[0\].*"bounded"/, /is not a proof/, output);
  });

  it("checks each mutant of an invariant", () => {
    const root = pinned();
    change(root, (m) => { m.mutants.push({ ...m.mutants[0], replace: "n < 2" }); });
    fails(check(root), /mutants\[1\].*"bounded"/, /did not violate/);
  });
});

const GUARD = "n < 3, n' = n + 1 }\n  action step = inc\n  val bounded = n <= 3";

describe("model-check 7: a mutant breaks the system, not what checks it", () => {
  const BROKEN = (bound) => GUARD.replace("n < 3", "n < 5").replace("n <= 3", bound);
  const mutate = (root, find, replace) => change(root, (m) => { m.mutants[0] = { ...m.mutants[0], find, replace }; });
  const remodel = (root, from, to, find, replace) => {
    rewrite(root, MODEL, from, to);
    mutate(root, find, replace);
    return check(root);
  };
  const refused = (out, ...patterns) => {
    fails(out, /counter\.json: mutants\[0\] for invariant "bounded": the mutant is refused/, ...patterns, /Repair/);
  };

  it("refuses a mutant that rewrites its invariant", () => {
    const root = pinned();
    mutate(root, "val bounded = n <= 3", "val bounded = n <= 2");
    refused(check(root), /changes "bounded", which "invariants" or "witnesses" lists/);
  });

  it("refuses a mutant that breaks an action and also changes its invariant", () => {
    const root = pinned();
    mutate(root, GUARD, BROKEN("n <= 4"));
    refused(check(root), /changes "bounded", which "invariants" or "witnesses" lists/);
  });

  it("refuses a mutant that changes a witness", () => {
    const root = pinned();
    mutate(root, `${GUARD}\n  val full = n == 3`, `${GUARD.replace("n < 3", "n < 5")}\n  val full = n == 2`);
    refused(check(root), /changes "full", which "invariants" or "witnesses" lists/);
  });

  it("refuses a change inside a local value of an invariant", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and (\n    val inner = 1\n    inner > 0\n  )");
    mutate(root, `${GUARD} and (\n    val inner = 1`, `${GUARD.replace("n < 3", "n < 5")} and (\n    val inner = 2`);
    refused(check(root), /changes "bounded"/);
  });

  it("refuses a change to a definition that only an invariant uses", () => {
    const root = pinned();
    const out = remodel(root, "val bounded = n <= 3", "pure val cap = 3\n  val bounded = n <= cap", "pure val cap = 3", "pure val cap = 2");
    refused(out, /changes "cap", which only "invariants" or "witnesses" use/);
  });

  it("refuses a mutant that changes only a comment or the layout", () => {
    const root = pinned();
    mutate(root, "n < 3", "(n < 3 /* weaker */)");
    refused(check(root), /changes no definition/);
  });

  it("refuses a mutant that changes only a definition that init and step do not reach", () => {
    const root = pinned();
    const out = remodel(root, "  var n: int\n", "  var n: int\n  pure val spare = 1\n", "pure val spare = 1", "pure val spare = 2");
    refused(out, /changes no definition that "init" or "step" reaches/, /spare/);
  });

  for (const [name, find, replace, pattern] of [
    ["adds a definition", "n < 3, n' = n + 1 }", "n < 5, n' = n + 1 }\n  pure val extra = 1", /adds or removes definitions: adds extra/],
    ["renames a definition", "action inc = all { n < 3, n' = n + 1 }\n  action step = inc", "action up = all { n < 5, n' = n + 1 }\n  action step = up", /adds or removes definitions: adds up, removes inc/],
  ]) it(`refuses a mutant that ${name}`, () => {
    const root = pinned();
    mutate(root, find, replace);
    refused(check(root), pattern);
  });

  it("refuses a mutant that removes a definition", () => {
    const root = pinned();
    mutate(root, GUARD, "n < 5, n' = n + 1 }\n  action step = inc");
    refused(check(root), /adds or removes definitions: removes bounded/);
  });

  it("refuses a mutant that changes a declaration that is not a definition", () => {
    const root = pinned();
    const out = remodel(root, "  var n: int\n", "  var n: int\n  var other: int\n", "var other: int", "var other: str");
    refused(out, /cannot tell what the mutant reaches/, /import, instance, export, type, var, const or assume/);
  });

  it("refuses a mutant that changes which file an invariant takes a definition from", () => {
    const root = pinned();
    for (const [name, cap] of [["lib", 3], ["loose", 2]]) put(root, `${MODELS}/${name}.qnt`, `module ${name} {\n  pure val cap = ${cap}\n}\n`);
    rewrite(root, MODEL, "module counter {\n", 'module counter {\n  import lib.* from "./lib"\n');
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= cap");
    mutate(root, 'import lib.* from "./lib"', 'import loose.* from "./loose"');
    refused(check(root), /cannot tell what the mutant reaches/);
  });

  const instance = (root) => {
    rewrite(root, MODEL, "module counter {\n", "module scale {\n  const SIZE: int\n  pure val doubled = SIZE + SIZE\n}\nmodule counter {\n  pure val base = 1\n  import scale(SIZE = base).*\n");
    rewrite(root, MODEL, "action inc = all { n < 3,", "action inc = all { n < 3, doubled > 0,");
    change(root, (m) => { m.module = "counter"; });
  };

  it("refuses a change inside a module that has an instance", () => {
    const root = pinned();
    instance(root);
    mutate(root, "pure val doubled = SIZE + SIZE", "pure val doubled = SIZE");
    refused(check(root), /cannot tell what the mutant reaches/, /doubled.*instance/);
  });

  it("refuses a change to a definition that gives an instance its constant", () => {
    const root = pinned();
    instance(root);
    mutate(root, "pure val base = 1", "pure val base = 2");
    refused(check(root), /cannot tell what the mutant reaches/, /base.*instance/);
  });

  it("refuses a mutant when the main module does not declare init", () => {
    const root = pinned();
    rewrite(root, MODEL, "module counter {\n", 'module start {\n  var m: int\n  action init = m\' = 0\n}\nmodule counter {\n  import start.*\n');
    rewrite(root, MODEL, "  action init = n' = 0\n", "");
    change(root, (m) => { m.module = "counter"; delete m.actions.init; m.actions.init = { none: "x" }; });
    fails(check(root), /mutants\[0\]/, /cannot tell what the mutant reaches/, /"init"/);
  });

  it("fails a model that Quint reports parse errors for, and shows the errors", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and (\n    /// inner doc\n    val inner = 1\n    inner > 0\n  )");
    fails(check(root), /counter\.json: model: Quint could not parse/, /QNT000/, /Repair/);
  });

  it("takes a change to a definition that step reaches through other definitions", () => {
    const root = pinned();
    rewrite(root, MODEL, "action inc = all { n < 3,", "pure val limit = 3\n  def below(x: int): bool = x < limit\n  action inc = all { below(n), n < 3 or n >= 3,");
    mutate(root, "pure val limit = 3", "pure val limit = 4");
    const out = check(root);
    fails(out, /did not violate|is violated/);
    assert.doesNotMatch(out.stderr, /refused/);
  });

  it("takes a change to a definition that the actions and an invariant both use", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and same(n)");
    rewrite(root, MODEL, "action inc = all { n < 3,", "pure def same(x: int): bool = x == x\n  action inc = all { n < 3, same(n),");
    mutate(root, "pure def same(x: int): bool = x == x\n  action inc = all { n < 3,", "pure def same(x: int): bool = x >= x\n  action inc = all { n < 5,");
    passes(check(root));
  });

  it("refuses a change to a shared definition that the mutant stops the actions from using", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and same(n)");
    rewrite(root, MODEL, "action inc = all { n < 3,", "pure def same(x: int): bool = x == x\n  action inc = all { n < 3, same(n),");
    mutate(root, "pure def same(x: int): bool = x == x\n  action inc = all { n < 3, same(n),", "pure def same(x: int): bool = x >= x\n  action inc = all { n < 5,");
    refused(check(root), /changes "same", which only "invariants" or "witnesses" use/);
  });

  const shadowed = (root) => {
    rewrite(root, MODEL, "val bounded = n <= 3", "pure val cap = 3\n  val bounded = n <= cap");
    rewrite(root, MODEL, "action inc = all { n < 3, n' = n + 1 }", "action inc = {\n    val cap = 1\n    all { n < 3, n' = n + cap }\n  }");
  };

  it("takes a change to a local value of an action that has the name of a definition of an invariant", () => {
    const root = pinned();
    shadowed(root);
    mutate(root, "val cap = 1\n    all { n < 3,", "val cap = 2\n    all { n < 5,");
    passes(check(root));
  });

  it("does not take a local value of an action for the definition of an invariant with its name", () => {
    const root = pinned();
    shadowed(root);
    mutate(root, "pure val cap = 3", "pure val cap = 2");
    refused(check(root), /changes "cap", which only "invariants" or "witnesses" use/);
  });

  it("does not see a change in the names that Quint gives to tuple parameters and destructured values", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and Set((1, 2)).forall(((a, b)) => a < b)\n  pure val (low, high) = (1, 2)\n  pure val ordered = low < high");
    mutate(root, "n < 3, n' = n + 1", "n < 5, Set((3, 4)).forall(((c, d)) => c < d), n' = n + 1 + 0");
    passes(check(root));
  });

  it("sees a change in the last digit of a large number", () => {
    const root = pinned();
    rewrite(root, MODEL, "val bounded = n <= 3", "val bounded = n <= 3 and n < 100000000000000000001");
    mutate(root, `${GUARD} and n < 100000000000000000001`, `${GUARD.replace("n < 3", "n < 5")} and n < 100000000000000000002`);
    refused(check(root), /changes "bounded"/);
  });
});

describe("model-check: each invariant and witness is a val of the main module", () => {
  const witness = (root, name) => {
    change(root, (m) => { m.witnesses = [name]; });
    return check(root);
  };
  const notDeclared = (kind, name) => new RegExp(`counter\\.json: ${kind} "${name}": module counter does not declare a val or pure val "${name}"`);

  it("fails a witness that is a literal", () => {
    fails(witness(pinned(), "true"), notDeclared("witness", "true"), /Repair/);
  });

  it("fails an invariant that no module declares", () => {
    const root = pinned();
    change(root, (m) => { m.invariants = ["missing"]; m.mutants[0].invariant = "missing"; });
    fails(check(root), notDeclared("invariant", "missing"));
  });

  for (const [what, declaration] of [["a def", "def other(x: int): bool = x > 0"], ["an action", "action other = n' = n"], ["a local value", "val holder = {\n    val other = true\n    other\n  }"]]) it(`fails a witness that is ${what}`, () => {
    const root = pinned();
    rewrite(root, MODEL, "  var n: int\n", `  var n: int\n  ${declaration}\n`);
    if (what === "an action") change(root, (m) => { m.actions.other = { none: "x" }; });
    fails(witness(root, "other"), notDeclared("witness", "other"));
  });

  it("fails a witness that another module declares", () => {
    const root = pinned();
    put(root, MODEL, `module aside {\n  pure val other = true\n}\n${MODEL_TEXT}`);
    change(root, (m) => { m.module = "counter"; });
    fails(witness(root, "other"), notDeclared("witness", "other"));
  });

  it("takes the module with the name of the file as the main module of a file with two modules", () => {
    const root = pinned();
    put(root, MODEL, `module aside {\n  pure val other = true\n}\n${MODEL_TEXT}`);
    passes(check(root));
  });

  it("takes the only module of a file as the main module", () => {
    const root = pinned();
    rewrite(root, MODEL, "module counter {", "module tally {");
    passes(check(root));
  });

  it("fails a module that the model does not declare", () => {
    const root = pinned();
    change(root, (m) => { m.module = "nomod"; });
    fails(check(root), /counter\.json: module: .*has no module "nomod"/);
  });
});

describe("a model or a cited file that is not UTF-8", () => {
  const bytes = (root, rel, text) => writeFileSync(path.join(root, rel), Buffer.concat([Buffer.from(text), Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a])]));

  it("fails model-check and model-pin for the cited file", () => {
    const root = pinned();
    bytes(root, CODE, CODE_TEXT);
    commit(root);
    fails(check(root), /action "inc".*src\/counter\.ts is not valid UTF-8/);
    fails(pin(root, MANIFEST), /action "inc".*src\/counter\.ts is not valid UTF-8/);
  });

  it("fails model-check for the model", () => {
    const root = pinned();
    bytes(root, MODEL, MODEL_TEXT);
    fails(check(root), /counter\.json: model: .*counter\.qnt is not valid UTF-8/);
  });
});

describe("model-check 8: each witness is reached", () => {
  it("fails a witness that is never reached", () => {
    const root = pinned();
    rewrite(root, MODEL, "val full = n == 3", "val full = n == 9");
    fails(check(root), /counter\.json/, /witness "full" is not reached/, /\[ok\] No violation found/, /Repair/);
  });

  it("passes a manifest with no witness", () => {
    const root = pinned();
    change(root, (m) => { m.witnesses = []; });
    passes(check(root));
  });
});

describe("model-check: several failures and several manifests", () => {
  it("reports the failures of each manifest, and checks only the named ones", () => {
    const root = pinned();
    put(root, `${MODELS}/second.qnt`, MODEL_TEXT);
    writeManifest(root, { ...readManifest(root), model: "second.qnt" }, `${MODELS}/second.json`);
    rewrite(root, CODE, "n < 3", "n < 4");
    fails(check(root), /counter\.json.*do not match/s, /second\.json.*REQ-0001.*does not name/s);
    const one = check(root, MANIFEST);
    fails(one, /counter\.json/);
    assert.doesNotMatch(one.stderr, /second\.json/);
  });
});

describe("model-check: Quint itself", () => {
  const quint = "node_modules/.bin/quint";

  it("fails a project without Quint, with the install command", () => {
    const root = pinned();
    rmSync(path.join(root, quint));
    fails(check(root), /node_modules\/\.bin\/quint is missing/, /npm install --save-dev @informalsystems\/quint/);
  });

  it("fails a Quint that cannot start", () => {
    const root = pinned();
    chmodSync(path.join(root, quint), 0o644);
    fails(check(root), /counter\.json/, /Quint could not start/, /EACCES/);
  });

  it("fails a Quint that a signal ends", () => {
    const root = pinned();
    put(root, quint, "#!/bin/sh\nkill -TERM $$\n");
    fails(check(root), /counter\.json/, /SIGTERM/);
  });

  it("fails an invariant run that takes too long, and does not read it as a pass", () => {
    const root = pinned();
    rmSync(path.join(root, TEST_MODEL));
    rewrite(root, MODEL, "  var n: int\n", "  var n: int // HANG\n");
    fails(run(root, ["model-check"], { NDEV_QUINT_TIMEOUT_MS: "4000" }), /counter\.json/, /invariant "bounded".*timed out after 4000 ms/, /NDEV_QUINT_TIMEOUT_MS/);
  });

  it("fails a mutant run that takes too long, and does not read it as caught", () => {
    const root = pinned();
    change(root, (m) => { m.mutants[0].replace = "n < 5 /* HANG */"; });
    fails(run(root, ["model-check"], { NDEV_QUINT_TIMEOUT_MS: "4000" }), /mutants\[0\].*timed out after 4000 ms/);
  });

  it("keeps the failures found before Quint stopped, and removes the copy", () => {
    const root = pinned();
    rewrite(root, CODE, "n < 3", "n < 4");
    change(root, (m) => { m.mutants[0].replace = "n < 5 /* HANG */"; });
    const temp = mkdtempSync(path.join(tmpdir(), "models-tmp-"));
    fails(run(root, ["model-check"], { NDEV_QUINT_TIMEOUT_MS: "4000", TMPDIR: temp }), /do not match the pin/, /timed out/);
    assert.deepEqual(readdirSync(temp), []);
  });

  it("refuses a time limit that is not a number", () => {
    fails(run(pinned(), ["model-check"], { NDEV_QUINT_TIMEOUT_MS: "soon" }), /NDEV_QUINT_TIMEOUT_MS.*soon/);
  });
});

describe("model-pin", () => {
  const pins = (root, rel = MANIFEST) => readManifest(root, rel).actions.inc.code[0].pin;

  it("writes the pin of each code reference, with the commit", () => {
    const root = unpinned();
    const out = pin(root, MANIFEST);
    passes(out);
    assert.match(pins(root), new RegExp(`^[0-9a-f]{12}@${git(root, "rev-parse", "HEAD")}$`));
    assert.match(out.stdout, /1 code reference/);
    passes(check(root));
  });

  it("does not need Quint", () => {
    const root = unpinned();
    rmSync(path.join(root, "node_modules"), { recursive: true });
    passes(pin(root, MANIFEST));
  });

  it("needs a manifest", () => {
    const out = pin(unpinned());
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /model-pin needs <manifest>/);
  });

  it("pins a file whose name holds a pattern character", () => {
    const root = unpinned();
    put(root, "src/[id].ts", CODE_TEXT);
    change(root, (m) => { m.actions.inc.code[0].file = "src/[id].ts"; });
    commit(root);
    passes(pin(root, MANIFEST));
    rewrite(root, "src/[id].ts", "n < 3", "n < 4");
    fails(pin(root, MANIFEST), /\[id\]\.ts.*do not match the commit/);
  });

  const hidden = (flag) => (root) => {
    git(root, "update-index", flag, CODE);
    rewrite(root, CODE, "n < 3", "n < 4");
  };
  for (const [name, edit] of [["that git is told to assume unchanged", hidden("--assume-unchanged")], ["that git is told to skip", hidden("--skip-worktree")]]) it(`refuses an uncommitted change to a file ${name}`, () => {
    const root = unpinned();
    edit(root);
    fails(pin(root, MANIFEST), /action "inc".*src\/counter\.ts L2-L4.*do not match the commit/, /Commit/);
    assert.equal(pins(root), undefined);
  });

  it("refuses lines that a clean filter changes before the commit", () => {
    const root = unpinned();
    git(root, "config", "filter.hide.clean", "sed 's/n < 4/n < 3/'");
    put(root, ".gitattributes", "*.ts filter=hide\n");
    rewrite(root, CODE, "n < 3", "n < 4");
    commit(root);
    assert.equal(git(root, "status", "--porcelain"), "");
    fails(pin(root, MANIFEST), /src\/counter\.ts L2-L4.*do not match the commit/);
  });

  it("refuses lines that the commit does not have, below lines that are not committed", () => {
    const root = unpinned();
    put(root, CODE, `// one\n// two\n${CODE_TEXT}`);
    change(root, (m) => { m.actions.inc.code[0].lines = "L5-L6"; });
    fails(pin(root, MANIFEST), /src\/counter\.ts L5-L6.*the commit has 4 lines/);
  });

  it("compares with the content of the commit, not with an object that replaces it", () => {
    const root = unpinned();
    const committed = git(root, "rev-parse", `HEAD:${CODE}`).trim();
    rewrite(root, CODE, "n < 3", "n < 4");
    git(root, "replace", committed, git(root, "hash-object", "-w", CODE).trim());
    fails(pin(root, MANIFEST), /src\/counter\.ts L2-L4.*do not match the commit/);
    assert.equal(pins(root), undefined);
  });

  const linked = (root) => {
    put(root, "src/other.ts", CODE_TEXT.replace("n < 3", "n < 9"));
    symlinkSync("counter.ts", path.join(root, "src/link.ts"));
    change(root, (m) => { m.actions.inc.code[0].file = "src/link.ts"; });
    commit(root);
  };

  it("refuses a cited link that points somewhere else without a commit", () => {
    const root = unpinned();
    linked(root);
    rmSync(path.join(root, "src/link.ts"));
    symlinkSync("other.ts", path.join(root, "src/link.ts"));
    fails(pin(root, MANIFEST), /action "inc".*src\/link\.ts is a link, or is behind a link/, /src\/other\.ts/);
    assert.equal(pins(root), undefined);
  });

  it("refuses a cited path behind a link, in model-pin and in model-check", () => {
    const root = pinned();
    symlinkSync("src", path.join(root, "alias"));
    change(root, (m) => { m.actions.inc.code[0].file = "alias/counter.ts"; });
    commit(root);
    fails(pin(root, MANIFEST), /alias\/counter\.ts is a link, or is behind a link/);
    fails(check(root), /alias\/counter\.ts is a link, or is behind a link/);
  });

  const refused = [
    ["a changed cited line", (root) => rewrite(root, CODE, "n < 3", "n < 4")],
    ["a staged cited line", (root) => { rewrite(root, CODE, "n < 3", "n < 4"); git(root, "add", CODE); }],
    ["a line removed from inside the cited lines", (root) => put(root, CODE, "export let n = 0;\nexport function inc() {\n}\nexport const next = 1;\n")],
    ["a line added inside the cited lines", (root) => rewrite(root, CODE, "  if (n < 3) n += 1;\n", "  if (n < 3) n += 1;\n  log();\n")],
  ];
  for (const [name, edit] of refused) it(`refuses ${name} until it is committed`, () => {
    const root = unpinned();
    edit(root);
    const before = get(root, MANIFEST);
    fails(pin(root, MANIFEST), /counter\.json/, /action "inc".*src\/counter\.ts L2-L4.*do not match the commit/, /Commit/);
    assert.equal(get(root, MANIFEST), before);
    commit(root);
    passes(pin(root, MANIFEST));
  });

  it("pins cited lines when only other lines have uncommitted changes", () => {
    const root = unpinned();
    rewrite(root, CODE, "export let n = 0;", "export let n = 1;");
    put(root, CODE, `${get(root, CODE)}export const more = 1;\n`);
    passes(pin(root, MANIFEST));
  });

  it("refuses a file that is not in the last commit", () => {
    const root = unpinned();
    put(root, "src/new.ts", CODE_TEXT);
    change(root, (m) => { m.actions.inc.code[0].file = "src/new.ts"; });
    fails(pin(root, MANIFEST), /src\/new\.ts.*not in the last commit/);
    commit(root);
    passes(pin(root, MANIFEST));
  });

  it("refuses a file that git reads as binary and that has uncommitted changes", () => {
    const root = unpinned();
    put(root, ".gitattributes", "*.ts -diff\n");
    commit(root);
    rewrite(root, CODE, "n < 3", "n < 4");
    fails(pin(root, MANIFEST), /do not match the commit/);
  });

  it("refuses a project that is not in git", () => {
    const root = unpinned();
    rmSync(path.join(root, ".git"), { recursive: true });
    fails(pin(root, MANIFEST), /git rev-parse/);
  });

  it("refuses lines that are not in the file", () => {
    const root = unpinned();
    change(root, (m) => { m.actions.inc.code[0].lines = "L2-L40"; });
    fails(pin(root, MANIFEST), /L2-L40.*4 lines/);
  });

  it("refuses a code file outside the project", () => {
    const root = unpinned();
    change(root, (m) => { m.actions.inc.code[0].file = "../outside.ts"; });
    fails(pin(root, MANIFEST), /outside the project/);
  });

  it("refuses a manifest that is not complete", () => {
    const root = unpinned();
    change(root, (m) => { delete m.bounds; });
    fails(pin(root, MANIFEST), /"bounds"/);
    assert.equal(pins(root), undefined);
  });

  it("writes no manifest when one reference is refused", () => {
    const root = unpinned();
    put(root, "src/other.ts", CODE_TEXT);
    const second = { ...manifest(), model: "second.qnt" };
    second.actions.inc.code[0].file = "src/other.ts";
    put(root, `${MODELS}/second.qnt`, MODEL_TEXT);
    writeManifest(root, second, `${MODELS}/second.json`);
    fails(pin(root, MANIFEST, `${MODELS}/second.json`), /second\.json/);
    assert.equal(pins(root), undefined);
    assert.equal(existsSync(path.join(root, MANIFEST)), true);
  });
});
