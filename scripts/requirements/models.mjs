import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../ndev/common.mjs";
import { declaresValue, indexTree, mutantRefusal, parseJson } from "./model-tree.mjs";

const MODELS = "docs/formal/models";
const QUINT = "node_modules/.bin/quint";
const INSTALL = "npm install --save-dev @informalsystems/quint (or npm install, when package.json already pins it)";
const TIME_LIMIT = "NDEV_QUINT_TIMEOUT_MS";
const FORMAT = "kb/requirements.md, section \"Model manifests\"";
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const LINES = /^L([1-9]\d*)-L([1-9]\d*)$/;
const PIN = /^([0-9a-f]{12})@[0-9a-f]{40,64}$/;
const NOT_CODE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g;
const TRACE_LENGTH = /^Trace length statistics: max=(\d+)/m;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isName = (value) => typeof value === "string" && IDENTIFIER.test(value);
const counted = (number, one, many = `${one}s`) => `${number} ${number === 1 ? one : many}`;
const declared = (text, keyword) => [...text.replace(NOT_CODE, " ").matchAll(new RegExp(`(?<![\\w.])${keyword}\\s+([A-Za-z_]\\w*)`, "g"))].map((match) => match[1]);
const hash = (lines) => createHash("sha256").update(lines.map((line) => line.trimEnd()).join("\n")).digest("hex").slice(0, 12);
const range = (ref) => ref.lines.match(LINES).slice(1).map(Number);
const quoted = (output) => (output ? `\n  Quint output:\n${output.split("\n").map((line) => `    ${line}`).join("\n")}` : "");

function onlyRoot(command, options) {
  const unknown = Object.keys(options).filter((name) => name !== "root");
  if (unknown.length) throw new CliError(2, `${command} does not take --${unknown[0]}. Its only option is --root <dir>.`);
}

const within = (folder, full) => {
  const rel = path.relative(folder, full);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function projectFile(root, given) {
  const full = path.resolve(root, given);
  if (!existsSync(full)) return { error: within(root, full) ? `${given} does not exist.` : `${given} is outside the project.` };
  const real = realpathSync(full);
  if (!within(root, real)) return { error: `${given} is outside the project, or is a link that leads outside the project.` };
  if (!statSync(real).isFile()) return { error: `${given} is not a file.` };
  return { real, full: within(root, full) ? full : real };
}

export function utf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
    return undefined;
  }
}

function linesOf(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function codeFile(root, ref) {
  if (path.isAbsolute(ref.file)) return { error: `${ref.file} is outside the project: give a path from the project root.` };
  const found = projectFile(root, ref.file);
  if (found.error) return found;
  if (found.real !== path.resolve(root, ref.file)) return { error: `${ref.file} is a link, or is behind a link, and leads to ${path.relative(root, found.real)}. A pin must hold a file that the commit holds, so cite that file.` };
  const text = utf8(readFileSync(found.real));
  if (text === undefined) return { error: `${ref.file} is not valid UTF-8, so a change in it can be hidden. Save it as UTF-8.` };
  return { ...found, lines: linesOf(text) };
}

export function shapeProblems(manifest, stem) {
  const problems = [];
  const keys = (object, where, required, optional = []) => {
    for (const key of required) if (!Object.hasOwn(object, key)) problems.push(`${where}the key "${key}" is missing.`);
    for (const key of Object.keys(object)) if (!required.includes(key) && !optional.includes(key)) problems.push(`${where}"${key}" is not a key. The keys are ${[...required, ...optional].join(", ")}.`);
  };
  const list = (key, valid, what, { empty = false } = {}) => {
    const value = manifest[key];
    if (value === undefined) return;
    if (!Array.isArray(value) || (!empty && !value.length) || !value.every(valid) || new Set(value).size !== value.length) problems.push(`"${key}" must be a list of ${empty ? "" : "one or more "}${what}, each given once.`);
  };
  if (!isObject(manifest)) return ["the manifest is not a JSON object."];
  keys(manifest, "", ["model", "requirements", "assumptions", "bounds", "invariants", "witnesses", "mutants", "actions"], ["module"]);
  if (manifest.model !== undefined && manifest.model !== `${stem}.qnt`) problems.push(`"model" is ${JSON.stringify(manifest.model)}. A manifest is beside its model and has its name: "model" must be "${stem}.qnt".`);
  if (manifest.module !== undefined && !isName(manifest.module)) problems.push(`"module" must be the name of a module.`);
  list("requirements", (item) => /^REQ-\d{4}$/.test(item), "record identifiers (REQ-NNNN)");
  list("assumptions", isText, "texts");
  list("invariants", isName, "val names");
  list("witnesses", isName, "val names", { empty: true });
  const { bounds, mutants, actions } = manifest;
  if (bounds !== undefined) {
    if (!isObject(bounds)) problems.push(`"bounds" must be an object.`);
    else {
      keys(bounds, "bounds: ", ["steps", "samples", "seed", "limits"]);
      for (const key of ["steps", "samples"]) if (bounds[key] !== undefined && !(Number.isSafeInteger(bounds[key]) && bounds[key] > 0)) problems.push(`bounds: "${key}" must be a whole number above 0.`);
      if (bounds.seed !== undefined && !(typeof bounds.seed === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(bounds.seed))) problems.push(`bounds: "seed" must be a number in a string, such as "0x1".`);
      if (bounds.limits !== undefined && !(Array.isArray(bounds.limits) && bounds.limits.every(isText))) problems.push(`bounds: "limits" must be a list of texts.`);
    }
  }
  if (mutants !== undefined) {
    if (!Array.isArray(mutants)) problems.push(`"mutants" must be a list.`);
    else mutants.forEach((mutant, index) => {
      const where = `mutants[${index}]: `;
      if (!isObject(mutant)) return problems.push(`${where}must be an object.`);
      keys(mutant, where, ["invariant", "find", "replace", "why"]);
      if (mutant.invariant !== undefined && !(Array.isArray(manifest.invariants) && manifest.invariants.includes(mutant.invariant))) problems.push(`${where}"invariant" is ${JSON.stringify(mutant.invariant)}, which is not in "invariants".`);
      if (mutant.find !== undefined && !(typeof mutant.find === "string" && mutant.find !== "")) problems.push(`${where}"find" must be text of the model.`);
      if (mutant.replace !== undefined && typeof mutant.replace !== "string") problems.push(`${where}"replace" must be text.`);
      if (mutant.why !== undefined && !isText(mutant.why)) problems.push(`${where}"why" must say which fault the mutant copies.`);
    });
  }
  if (actions !== undefined) {
    if (!isObject(actions)) problems.push(`"actions" must be an object.`);
    else for (const [name, action] of Object.entries(actions)) {
      const where = `actions.${name}`;
      const shape = isObject(action) ? Object.keys(action).join() : "";
      if (shape === "none") {
        if (!isText(action.none)) problems.push(`${where}: "none" must say why no code stands behind the action.`);
      } else if (shape !== "code" || !Array.isArray(action.code) || !action.code.length) problems.push(`${where}: give either "code", a list of one or more code references, or "none", the reason why no code stands behind it.`);
      else action.code.forEach((ref, index) => {
        const at = `${where}.code[${index}]: `;
        if (!isObject(ref)) return problems.push(`${at}must be an object.`);
        keys(ref, at, ["file", "lines"], ["pin"]);
        if (ref.file !== undefined && !isText(ref.file)) problems.push(`${at}"file" must be a path from the project root.`);
        const [, first, last] = (typeof ref.lines === "string" && ref.lines.match(LINES)) || [];
        if (ref.lines !== undefined && !(first && Number(last) >= Number(first))) problems.push(`${at}"lines" must have the form L<first>-L<last>.`);
      });
    }
  }
  return problems;
}

function load(root, given) {
  const found = projectFile(root, given);
  if (found.error) return { rel: given, problems: [`${given}: ${found.error} Repair: name a manifest inside the project.`] };
  const rel = path.relative(root, found.full);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(found.real, "utf8"));
  } catch (error) {
    return { rel, problems: [`${rel}: not valid JSON: ${error.message}. Repair: correct the file (${FORMAT}).`] };
  }
  const problems = shapeProblems(manifest, path.basename(rel, ".json")).map((problem) => `${rel}: ${problem} Repair: correct the manifest (${FORMAT}).`);
  return { rel, full: found.full, manifest, problems };
}

function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return /^[._]/.test(entry.name) ? [] : walk(full);
    return [full];
  }).sort();
}

const directManifests = (root) => walk(path.join(root, MODELS)).filter((full) => full.endsWith(".json") && path.dirname(full) === path.join(root, MODELS)).map((full) => path.relative(root, full));

function uncheckedModels(root, checked) {
  return walk(path.join(root, MODELS)).filter((full) => full.endsWith(".qnt") && !full.endsWith("_test.qnt")).flatMap((full) => {
    const model = path.relative(root, full);
    const manifest = model.replace(/\.qnt$/, ".json");
    if (!existsSync(path.join(root, manifest))) return [{ model, reason: "no manifest" }];
    return checked && path.posix.dirname(manifest) !== MODELS && !checked.includes(manifest) ? [{ model, reason: `name ${manifest} to check it` }] : [];
  });
}

const uncheckedLines = (unchecked) => unchecked.map(({ model, reason }) => `Not checked: ${model} (${reason})`);

class Stopped extends Error {}

function quintRunner(root) {
  const binary = path.join(root, QUINT);
  if (!existsSync(binary)) throw new CliError(1, `${binary}: ${QUINT} is missing. Repair: in ${root}, run ${INSTALL}.`);
  const given = process.env[TIME_LIMIT] ?? "600000";
  if (!/^[1-9]\d*$/.test(given)) throw new CliError(1, `${TIME_LIMIT} is "${given}". Repair: give a whole number of milliseconds above 0, or unset it.`);
  const timeout = Number(given);
  return (item, cwd, args) => {
    const out = spawnSync(binary, args, { cwd, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
    const output = [out.stdout, out.stderr].map((text) => (text ?? "").trimEnd()).filter(Boolean).join("\n");
    const command = `quint ${args.join(" ")}`;
    const stop = (what, repair) => {
      throw new Stopped(`${item}: ${what} Command: ${command}. Nothing after this item was checked. Repair: ${repair}${quoted(output)}`);
    };
    if (out.error?.code === "ETIMEDOUT") stop(`Quint timed out after ${timeout} ms.`, `make the bounds smaller, or give more time with ${TIME_LIMIT}.`);
    if (out.error && out.pid === 0) stop(`Quint could not start: ${out.error.message}.`, `in ${root}, run ${INSTALL}.`);
    if (out.error) stop(`Quint did not finish: ${out.error.message}.`, "remove the cause and run the command again.");
    if (out.signal) stop(`Quint ended on signal ${out.signal}.`, "remove the cause and run the command again.");
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, output: `exit ${out.status}${output ? `\n${output}` : ""}` };
  };
}

function verdict({ status, stdout, stderr }) {
  if (status === 0 && /^\[ok\] No violation found/m.test(stdout)) return "holds";
  if (status === 1 && /^error: Invariant violated\s*$/m.test(stderr)) return "violated";
  return "unknown";
}

function parseModel(run, item, name, cwd) {
  const folder = mkdtempSync(path.join(tmpdir(), "ndev-model-parse-"));
  try {
    const target = path.join(folder, "parsed.json");
    const out = run(item, ["parse", name, `--out=${target}`], cwd);
    if (!existsSync(target)) return { output: out.output };
    let tree;
    try {
      tree = parseJson(readFileSync(target, "utf8"));
    } catch (error) {
      return { output: `${out.output}\nthe parse result is not readable JSON: ${error.message}` };
    }
    if (out.status !== 0 || !Array.isArray(tree.errors) || tree.errors.length || !Array.isArray(tree.modules) || !tree.table) return { output: [out.output, ...(tree.errors ?? []).map((problem) => problem.explanation)].join("\n") };
    return { index: indexTree(tree) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function requirementProblems(manifest, modelRel, records) {
  return manifest.requirements.flatMap((id) => {
    const record = records.find((r) => r.id === id);
    if (!record) return [`requirement ${id}: ${id} is not a record. Repair: correct "requirements", or write the record with ndev requirements new.`];
    if (!record.inForce) return [`requirement ${id}: ${id} is not in force: its status is ${record.status ?? "missing"}. Repair: remove it from "requirements", or name the record that is in force.`];
    if (!record.models.includes(modelRel)) return [`requirement ${id}: the "model" list of ${id} does not name ${modelRel}. Repair: cite ${id} in the model, then run ndev requirements model ${id} ${modelRel}.`];
    return [];
  });
}

function actionProblems(manifest, modelRel, text) {
  const actions = [...new Set(declared(text, "action"))];
  const listed = Object.keys(manifest.actions);
  return [
    ...actions.filter((name) => !listed.includes(name)).map((name) => `action "${name}": ${modelRel} declares the action "${name}", which is not in "actions". Repair: add it with its "code" references, or with "none" and the reason.`),
    ...listed.filter((name) => !actions.includes(name)).map((name) => `action "${name}": "actions" names "${name}", which ${modelRel} does not declare as an action. Repair: remove the entry, or correct its name.`),
  ];
}

const references = (manifest) => Object.entries(manifest.actions).flatMap(([action, { code = [] }]) => code.map((ref) => ({ action, ref })));

function rangeProblem(ref, lines) {
  return range(ref)[1] > lines.length ? `lines ${ref.lines} are not all in the file, which has ${counted(lines.length, "line")}.` : undefined;
}

function movedTo(lines, wanted, length) {
  return lines.flatMap((_, start) => (start + length <= lines.length && hash(lines.slice(start, start + length)) === wanted ? [`L${start + 1}-L${start + length}`] : []));
}

function driftProblems(root, manifest, manifestRel) {
  return references(manifest).flatMap(({ action, ref }) => {
    const item = `action "${action}", ${ref.file} ${ref.lines}`;
    const repair = `read the cited lines against the action "${action}", then run ndev requirements model-pin ${manifestRel}.`;
    const unproven = (message) => [{ kind: "other", message }];
    const found = codeFile(root, ref);
    if (found.error) return unproven(`${item}: ${found.error} Repair: correct "file", ${repair}`);
    const outOfRange = rangeProblem(ref, found.lines);
    if (ref.pin === undefined) return unproven(`${item}: ${outOfRange ?? "the reference has no pin."} Repair: ${outOfRange ? `correct "lines", ${repair}` : repair}`);
    const wanted = typeof ref.pin === "string" ? ref.pin.match(PIN)?.[1] : undefined;
    if (!wanted) return unproven(`${item}: pin ${JSON.stringify(ref.pin)} is not a pin that model-pin wrote. Repair: ${repair}`);
    const [first, last] = range(ref);
    if (!outOfRange && hash(found.lines.slice(first - 1, last)) === wanted) return [];
    const places = movedTo(found.lines, wanted, last - first + 1);
    const moved = places.length ? ` The same lines are now at ${places.join(" and ")}. Repair: set "lines" to the new place, ${repair}` : ` Repair: correct "lines" if the code moved, ${repair} If the code no longer does what the action says, change the model first.`;
    return [{ kind: "drift", message: `${item}: drift: ${outOfRange ?? "the cited lines do not match the pin."}${moved}` }];
  });
}

function occurrences(text, find) {
  let count = 0;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) count += 1;
  return count;
}

function mutantCopy(root, folder, name, mutate) {
  const models = path.join(root, MODELS);
  const base = existsSync(models) && within(models, folder) ? models : folder;
  const source = realpathSync(base);
  const copy = realpathSync(mkdtempSync(path.join(tmpdir(), "ndev-model-mutant-")));
  const remove = () => rmSync(copy, { recursive: true, force: true });
  try {
    cpSync(source, copy, { recursive: true, filter: (file) => !["node_modules", ".git"].includes(path.basename(file)) });
    const cwd = path.join(copy, path.relative(base, folder));
    if (!within(copy, realpathSync(cwd))) {
      remove();
      return { error: `the folder of the model is behind a link inside ${source}, so a mutant would change the project's own files. Repair: put the model in a real folder.` };
    }
    const target = path.join(cwd, name);
    rmSync(target);
    writeFileSync(target, mutate);
    return { cwd, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

function checkModel(root, { rel, full, manifest }, records, quint, report) {
  const fail = (message, kind = "other") => report(`${rel}: ${message}`, kind);
  const folder = path.dirname(full);
  const modelRel = path.posix.join(path.posix.dirname(rel), manifest.model);
  const model = projectFile(root, modelRel);
  if (model.error) return fail(`model: ${model.error} Repair: write the model beside the manifest.`);
  const text = utf8(readFileSync(model.real));
  if (text === undefined) return fail(`model: ${modelRel} is not valid UTF-8, so a change in it can be hidden. Repair: save the model as UTF-8.`);
  for (const problem of [...requirementProblems(manifest, modelRel, records), ...actionProblems(manifest, modelRel, text)]) fail(problem);
  for (const { message, kind } of driftProblems(root, manifest, rel)) fail(message, kind);

  const mutants = manifest.mutants.map((mutant, index) => ({ ...mutant, item: `mutants[${index}] for invariant "${mutant.invariant}"`, count: occurrences(text, mutant.find) }));
  for (const name of manifest.invariants) if (!mutants.some((mutant) => mutant.invariant === name)) fail(`invariant "${name}" has no mutant, so nothing shows that it can fail. Repair: add a mutant that breaks the property of "${name}".`);
  for (const { item, count } of mutants) if (count !== 1) fail(`${item}: the "find" text occurs ${count} times in ${modelRel}. It must occur exactly once. Repair: give model text that occurs once.`);

  const run = (item, args, cwd = folder) => quint(`${rel}: ${item}`, cwd, args);
  const typed = run("typecheck", ["typecheck", manifest.model]);
  if (typed.status !== 0) return fail(`typecheck: ${modelRel} does not typecheck, so its tests, invariants, mutants and witnesses were not run. Repair: correct the model.${quoted(typed.output)}`);

  let tests = 0;
  const testFile = manifest.model.replace(/\.qnt$/, "_test.qnt");
  const testRel = path.posix.join(path.posix.dirname(rel), testFile);
  if (existsSync(path.join(folder, testFile))) {
    const found = projectFile(root, testRel);
    const modules = found.error ? [] : declared(readFileSync(found.real, "utf8"), "module");
    if (!modules.length) fail(`tests: ${found.error ?? `${testRel} has no module, so no test ran.`} Repair: write the tests as runs with names that end in Test.`);
    for (const module of modules) {
      const out = run(`tests of module ${module}`, ["test", testFile, "--backend=typescript", `--main=${module}`, "--match", "Test$"]);
      const passed = Number([...out.stdout.matchAll(/^\s*(\d+) passing/gm)].at(-1)?.[1] ?? 0);
      if (out.status !== 0) fail(`tests: ${testRel} module ${module} failed. Repair: correct the model or the test.${quoted(out.output)}`);
      else if (!passed) fail(`tests: ${testRel} module ${module}: no test ran. Repair: write the tests as runs with names that end in Test.${quoted(out.output)}`);
      else tests += passed;
    }
  }

  const parsed = parseModel(run, "model", manifest.model, folder);
  if (!parsed.index) return fail(`model: Quint could not parse ${modelRel}, so its invariants, mutants and witnesses were not run. Repair: correct the model.${quoted(parsed.output)}`);
  const modules = declared(text, "module");
  const main = manifest.module ?? (modules.length === 1 ? modules[0] : path.basename(manifest.model, ".qnt"));
  if (!parsed.index.modules.has(main)) return fail(`module: ${modelRel} has no module "${main}", so its invariants, mutants and witnesses were not run. Repair: set "module" in the manifest to the module that declares "init", "step" and the invariants.`);
  const listed = [...manifest.invariants, ...manifest.witnesses];
  const checkable = (kind, names) => names.filter((name) => {
    if (declaresValue(parsed.index, main, name)) return true;
    fail(`${kind} "${name}": module ${main} does not declare a val or pure val "${name}", so it was not checked. Repair: declare it in module ${main}, or correct the name.`);
    return false;
  });
  const invariants = checkable("invariant", manifest.invariants);
  const witnesses = checkable("witness", manifest.witnesses);

  const { steps, samples, seed, limits } = manifest.bounds;
  const simulate = (item, invariant, cwd) => run(item, ["run", manifest.model, "--backend=typescript", `--main=${main}`, `--invariant=${invariant}`, `--max-samples=${samples}`, `--max-steps=${steps}`, `--seed=${seed}`], cwd);

  const unmoved = (stdout) => {
    const states = stdout.match(TRACE_LENGTH)?.[1];
    if (states === undefined) return "Quint printed no trace length statistics, so nothing shows that the model moved. Repair: use the Quint version that the project pins.";
    if (Number(states) < 2) return `the model never moved: the longest trace has ${counted(Number(states), "state")}, so "step" never fired. Repair: let "init" hold and let "step" fire after it.`;
    return undefined;
  };

  const proveMutant = (mutant, name) => {
    const at = text.indexOf(mutant.find);
    const copy = mutantCopy(root, folder, manifest.model, text.slice(0, at) + mutant.replace + text.slice(at + mutant.find.length));
    if (copy.error) return fail(`${mutant.item}: ${copy.error}`);
    try {
      const compiled = run(mutant.item, ["typecheck", manifest.model], copy.cwd);
      if (compiled.status !== 0) return fail(`${mutant.item}: the mutant does not typecheck, so it proves nothing. Repair: correct "replace". An import of the model must stay inside the folder that holds the models.${quoted(compiled.output)}`);
      const mutated = parseModel(run, mutant.item, manifest.model, copy.cwd);
      if (!mutated.index) return fail(`${mutant.item}: Quint could not parse the mutant, so it proves nothing. Repair: correct "replace".${quoted(mutated.output)}`);
      const refusal = mutantRefusal(parsed.index, mutated.index, main, listed);
      if (refusal) return fail(`${mutant.item}: the mutant is refused: ${refusal} Repair: change an action, a guard or a value that "init" or "step" uses, so that the system breaks and each invariant and witness stays as it is.`);
      const broken = simulate(mutant.item, name, copy.cwd);
      const result = verdict(broken);
      if (result === "holds") fail(`${mutant.item}: the mutant did not violate the invariant. Repair: strengthen the invariant, or let the model reach the fault within the bounds. Do not weaken the mutant.${quoted(broken.output)}`);
      if (result === "unknown") fail(`${mutant.item}: the mutant run is not a proof: only "error: Invariant violated" shows that the invariant caught the fault. Repair: correct "replace" so that the mutant runs.${quoted(broken.output)}`);
    } finally {
      copy.remove();
    }
  };

  for (const name of invariants) {
    const out = simulate(`invariant "${name}"`, name);
    const found = verdict(out);
    const still = found === "holds" ? unmoved(out.stdout) : undefined;
    if (found === "violated") fail(`invariant "${name}" is violated on ${modelRel}, so its mutants were not run. Repair: read the trace. Correct the model or the invariant. If the code has the same fault, report it as a bug.${quoted(out.output)}`, "violated");
    if (found === "unknown") fail(`invariant "${name}" was not checked, so its mutants were not run: Quint reported neither "[ok] No violation found" nor a violation. Repair: read Quint's output, and correct the model or the manifest.${quoted(out.output)}`);
    if (still) fail(`invariant "${name}" was not checked, so its mutants were not run: ${still}${quoted(out.output)}`);
    if (found !== "holds" || still) continue;
    for (const mutant of mutants.filter((m) => m.invariant === name && m.count === 1)) proveMutant(mutant, name);
  }

  for (const name of witnesses) {
    const out = simulate(`witness "${name}"`, `not(${name})`);
    const found = verdict(out);
    if (found === "holds") fail(`witness "${name}" is not reached within the bounds. Repair: let the model reach the state, or make the bounds larger.${quoted(out.output)}`);
    if (found === "unknown") fail(`witness "${name}" was not checked: Quint reported neither a violation of not(${name}) nor "[ok] No violation found". Repair: read Quint's output, and correct the model or the manifest.${quoted(out.output)}`);
  }

  return { manifest: rel, invariants: manifest.invariants.length, mutants: manifest.mutants.length, witnesses: manifest.witnesses.length, tests, bounds: { steps, samples, seed, limits } };
}

export function modelRunner(from, recordsOf) {
  const root = realpathSync(from);
  const quint = quintRunner(root);
  const records = recordsOf(root);
  return (manifestRel) => {
    const entry = load(root, manifestRel);
    if (entry.problems.length) return entry.problems.map((message) => ({ kind: "other", message }));
    const found = [];
    try {
      checkModel(root, entry, records, quint, (message, kind) => found.push({ kind, message }));
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      throw new CliError(1, [...found.map((problem) => problem.message), error.message].join("\n"));
    }
    return found;
  };
}

export function modelCheck(from, named, options, recordsOf) {
  onlyRoot("model-check", options);
  const root = realpathSync(from);
  const given = named.length ? named : directManifests(root);
  const loaded = given.map((name) => load(root, name));
  const checked = loaded.map(({ rel }) => rel);
  const unchecked = uncheckedModels(root, named.length ? undefined : checked);
  if (!loaded.length) throw new CliError(1, [`model-check: there is no manifest in ${MODELS}, so nothing was checked. Repair: write ${MODELS}/<name>.json beside <name>.qnt (${FORMAT}), or name a manifest.`, ...uncheckedLines(unchecked)].join("\n"));
  const quint = quintRunner(root);
  const records = recordsOf(root);
  const problems = [];
  const results = [];
  try {
    for (const entry of loaded) {
      if (entry.problems.length) problems.push(...entry.problems);
      else results.push(checkModel(root, entry, records, quint, (message) => problems.push(message)));
    }
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    throw new CliError(1, [...problems, error.message].join("\n"));
  }
  if (problems.length) throw new CliError(1, [...problems, ...uncheckedLines(unchecked), `model-check failed: ${counted(problems.length, "problem")}.`].join("\n"));
  const total = (key) => results.reduce((sum, result) => sum + result[key], 0);
  const counts = (of) => [counted(of("invariants"), "invariant"), counted(of("mutants"), "mutant"), counted(of("witnesses"), "witness", "witnesses"), counted(of("tests"), "test")].join(", ");
  const text = [
    `model-check passed ${counted(results.length, "manifest")}: ${counts(total)}.`,
    ...results.flatMap((result) => [
      `  ${result.manifest}: ${counts((key) => result[key])}; bounds: steps ${result.bounds.steps}, samples ${result.bounds.samples}, seed ${result.bounds.seed}`,
      ...result.bounds.limits.map((limit) => `    not covered: ${limit}`),
    ]),
    "This is a bounded random search, not an exhaustive proof.",
    ...uncheckedLines(unchecked),
  ].join("\n");
  return { text: `${text}\n`, invariants: total("invariants"), mutants: total("mutants"), witnesses: total("witnesses"), tests: total("tests"), manifests: results, unchecked };
}

export function runGit(root, args) {
  const out = spawnSync("git", ["-C", root, "--no-replace-objects", ...args], { maxBuffer: 64 * 1024 * 1024 });
  const failure = out.status === 0 ? undefined : `git ${args.join(" ")} in ${root} exited ${out.status}: ${out.stderr?.toString().trim() || out.error?.message}`;
  return { bytes: out.stdout, failure };
}

export function git(root, args, repair) {
  const { bytes, failure } = runGit(root, args);
  if (failure) throw new CliError(1, `${failure}. Repair: ${repair}`);
  return bytes.toString();
}

function notInCommit(root, commit, rel, found, [first, last]) {
  const blob = runGit(root, ["cat-file", "blob", `${commit}:./${rel}`]);
  if (blob.failure) return `${rel} is not in the last commit: ${blob.failure}.`;
  const text = utf8(blob.bytes);
  if (text === undefined) return `${rel} in the last commit is not valid UTF-8.`;
  const lines = linesOf(text);
  if (last > lines.length) return `lines L${first}-L${last} of ${rel} are not all in the last commit: the commit has ${counted(lines.length, "line")}.`;
  if (hash(lines.slice(first - 1, last)) !== hash(found.lines.slice(first - 1, last))) return "the cited lines do not match the commit: they have changes that are not committed, or git changes them when it commits them.";
  return undefined;
}

export function modelPin(from, named, options) {
  onlyRoot("model-pin", options);
  if (!named.length) throw new CliError(2, `model-pin needs <manifest>..., for example: model-pin ${MODELS}/<name>.json. Run it only after you read the cited code against each action.`);
  const root = realpathSync(from);
  const loaded = named.map((name) => load(root, name));
  const problems = loaded.flatMap((entry) => entry.problems);
  if (problems.length) throw new CliError(1, [...problems, "No pin was written."].join("\n"));
  const commit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "model-pin records the commit. Run it in a git repository that has a commit.").trim();
  let count = 0;
  for (const { rel, manifest } of loaded) {
    for (const { action, ref } of references(manifest)) {
      const fail = (what, repair) => problems.push(`${rel}: action "${action}", ${ref.file} ${ref.lines}: ${what} Repair: ${repair}`);
      const found = codeFile(root, ref);
      const wrong = found.error ?? rangeProblem(ref, found.lines);
      if (wrong) {
        fail(wrong, `correct "file" and "lines".`);
        continue;
      }
      const [first, last] = range(ref);
      const differs = notInCommit(root, commit, path.relative(root, found.real), found, [first, last]);
      if (differs) fail(differs, "Commit the code, read the cited lines against the action, then run model-pin again.");
      else {
        ref.pin = `${hash(found.lines.slice(first - 1, last))}@${commit}`;
        count += 1;
      }
    }
  }
  if (problems.length) throw new CliError(1, [...problems, "No pin was written."].join("\n"));
  for (const { full, manifest } of loaded) writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`);
  return { text: `Pinned ${counted(count, "code reference")} at ${commit} in ${loaded.map(({ rel }) => rel).join(", ")}.\n`, commit, references: count, manifests: loaded.map(({ rel }) => rel) };
}
