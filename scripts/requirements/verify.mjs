import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "../ndev/common.mjs";
import { git, modelRunner, runGit, shapeProblems, utf8 } from "./models.mjs";
import { importSources } from "./quint-imports.mjs";

const FOLDER = "docs/formal/verification";
const MODELS = "docs/formal/models";
const VERDICTS = ["no-counter-example", "counter-example"];
const STATES = ["violated", "stale", "unverified"];
const SCRIPT = "ndev requirements";
const TIME_LIMIT = "NDEV_CHECK_TIMEOUT_MS";
const FORMAT = "kb/requirements.md, section \"Verification\"";
const REPORT = "ndev-requirements-verification";
const COMMIT_FIRST = "Repair: commit the covered files and the verification file (or restore them), and run the command again. If git status shows nothing, look for assume-unchanged or skip-worktree (git ls-files -v), a clean filter or a line-ending setting.";
const refuse = (message) => new CliError(1, message);
const usage = (message) => new CliError(2, message);

const insideProject = (rel) => !path.posix.isAbsolute(rel) && ![".", ".."].includes(path.posix.normalize(rel).split("/")[0]);

function onlyOptions(command, options, allowed) {
  const unknown = Object.keys(options).find((name) => !["root", ...allowed].includes(name));
  if (unknown) throw usage(`${command} does not take --${unknown}. Its options are ${["root", ...allowed].map((name) => `--${name}`).join(", ")}.`);
}

function statOf(full) {
  try {
    return lstatSync(full);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    return undefined;
  }
}

function onDisk(root, rel) {
  const full = path.join(root, rel);
  const stat = statOf(full);
  if (stat?.isSymbolicLink()) throw refuse(`${rel} is a symlink, so what runs or is judged is not the file that the commit holds. Repair: replace it with a regular file, or link the real file.`);
  if (stat && realpathSync(full) !== full) throw refuse(`${rel} is behind a symlink, so what runs or is judged is not the file that the commit holds. Repair: name the real path, or replace the link with a folder.`);
  return stat?.isFile() ? readFileSync(full) : undefined;
}

function indexFiles(root) {
  return git(root, ["ls-files", "-z"], "run the command in a git repository.").split("\0").filter(Boolean);
}

const verificationRel = (id) => `${FOLDER}/${id}.json`;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const counted = (number, one) => `${number} ${one}${number === 1 ? "" : "s"}`;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isTexts = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");
const rejudge = (id) => `Repair: run ${SCRIPT} verify-brief ${id}, give the brief to a fresh agent, and record its answer with ${SCRIPT} verify-judge ${id} (the requirements-verify skill). Then commit ${verificationRel(id)}.`;
const said = (output) => (output ? `\n${output.split("\n").map((line) => `    ${line}`).join("\n")}` : " (no output)");

function snapshot(root, commit) {
  const listed = git(root, ["ls-tree", "-r", "-z", commit], "name a commit of this repository.");
  const tree = new Map(listed.split("\0").filter(Boolean).map((line) => {
    const [meta, rel] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    const [mode, type, oid] = meta.split(" ");
    return [rel, { mode, type, oid }];
  }));
  const blobs = new Map();
  const blob = (rel) => {
    const entry = tree.get(rel);
    if (!entry || entry.type !== "blob") return undefined;
    if (!blobs.has(rel)) {
      const out = runGit(root, ["cat-file", "blob", `${commit}:./${rel}`]);
      if (out.failure) throw new CliError(1, `${out.failure}. Repair: repair the repository and run the command again.`);
      blobs.set(rel, out.bytes);
    }
    return blobs.get(rel);
  };
  const bytes = (rel) => {
    if (tree.get(rel)?.mode === "120000") throw refuse(`${rel} is a symlink in commit ${commit}, so the commit does not hold what runs or is judged. Repair: replace it with a regular file, or link the real file.`);
    return blob(rel);
  };
  const linkText = (rel) => (tree.get(rel)?.mode === "120000" ? utf8(blob(rel)) : undefined);
  const text = (rel) => {
    const found = bytes(rel);
    return found === undefined ? undefined : utf8(found);
  };
  const checkedOut = (rel) => {
    const out = runGit(root, ["cat-file", "--filters", `${commit}:./${rel}`]);
    if (out.failure) throw new CliError(1, `${out.failure}. Repair: repair the repository and run the command again.`);
    return out.bytes;
  };
  return { root, commit, tree, bytes, text, linkText, checkedOut };
}

const headCommit = (root) => git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "run the command in a git repository that has a commit.").trim();

const recordPaths = (snap, project) => [...snap.tree.keys()].filter((rel) => project.folders.includes(path.posix.dirname(rel)) && project.name.test(path.posix.basename(rel))).sort();

function recordsIn(snap, project) {
  return recordPaths(snap, project).map((rel) => {
    const text = snap.text(rel);
    if (text === undefined) throw refuse(`${rel} in commit ${snap.commit} is not a UTF-8 file. Repair: save the record as UTF-8, and commit it.`);
    return project.parse(rel, text);
  });
}

function committedRecords(snap, project) {
  if (![...snap.tree.keys()].some((rel) => project.folders.some((folder) => rel.startsWith(`${folder}/`)))) throw refuse(`there are no records in ${project.folders[0]} in commit ${snap.commit}, so nothing can be verified. Repair: run the command in the project that holds the records (--root <dir>), and commit them.`);
  const records = recordsIn(snap, project);
  const misnamed = [...snap.tree.keys()].filter((rel) => project.folders.includes(path.posix.dirname(rel)) && rel.endsWith(".md") && path.posix.basename(rel) !== "README.md" && !project.name.test(path.posix.basename(rel)));
  const problems = misnamed.map((rel) => `${rel} is not named as a record (NNNN-words.md), so it would be left out. Repair: rename it with git mv to the name of a record, or move it out of ${path.posix.dirname(rel)}.`);
  problems.push(...records.flatMap((record) => {
    if (!record.front.data) return [`${record.rel}: the record has no valid front matter, so its status is unknown.`];
    return project.status.test(record.status ?? "") ? [] : [`${record.rel}: status "${record.status ?? ""}" is not a status of a record.`];
  }));
  for (const id of new Set(records.map((record) => record.id))) {
    const same = records.filter((record) => record.id === id);
    if (same.length > 1) problems.push(`${id} is the identifier of more than one record: ${same.map((record) => record.rel).join(", ")}.`);
  }
  if (problems.length) throw refuse([...problems, `Repair: run ${SCRIPT} check, correct each record, and commit.`].join("\n"));
  return records;
}

function inForceRecord(records, id, project) {
  const record = records.find((found) => found.id === id);
  if (!record) throw refuse(`${id} is not a record in ${project.folders.join(" or ")}. Repair: give the identifier of a committed record.`);
  if (!project.inForce(record)) throw refuse(`${id} is not in force: its status is ${record.status} (${record.rel}). Repair: name the record that is in force.`);
  return record;
}

function oneId(command, ids) {
  if (ids.length !== 1 || !/^REQ-\d{4}$/.test(ids[0])) throw usage(`${command} needs one <REQ-NNNN>.`);
  return ids[0];
}

function sameAsCommit(root, snap, rel) {
  const found = onDisk(root, rel);
  const held = snap.bytes(rel);
  if (found === undefined || held === undefined || !(found.equals(held) || found.equals(snap.checkedOut(rel)))) throw refuse(`${rel} on disk is not the file of commit ${snap.commit}. ${COMMIT_FIRST}`);
}

function sameLink(root, snap, rel) {
  const full = path.join(root, rel);
  const parent = path.dirname(full);
  const held = snap.linkText(rel);
  if (!statOf(full)?.isSymbolicLink() || readlinkSync(full) !== held || realpathSync(parent) !== parent) throw refuse(`${rel} on disk is not the symlink of commit ${snap.commit}, which points to ${held}. ${COMMIT_FIRST}`);
}

const verificationBody = ({ requirement, checks }) => JSON.stringify({ requirement, checks });

function sameChecks(root, snap, id) {
  const rel = verificationRel(id);
  const found = onDisk(root, rel);
  if (!snap.tree.has(rel)) return;
  const disk = verificationIn(found === undefined ? undefined : utf8(found) ?? "", id);
  const held = verificationIn(snap.text(rel) ?? "", id);
  if (!disk.value || !held.value || verificationBody(disk.value) !== verificationBody(held.value)) throw refuse([`"requirement" or "checks" of ${rel} on disk is not what commit ${snap.commit} holds.`, ...disk.problems, COMMIT_FIRST].join("\n"));
}

function assertOnDisk(root, snap, item, project, { whole }) {
  const { record } = item;
  sameAsCommit(root, snap, record.rel);
  if (whole && item.present) sameAsCommit(root, snap, verificationRel(record.id));
  else sameChecks(root, snap, record.id);
  for (const rel of item.named) onDisk(root, rel);
  for (const rel of item.absent) if (!snap.tree.has(rel) && statOf(path.join(root, rel))) throw refuse(`${rel} is on disk and not in commit ${snap.commit}, and a linked model imports it. ${COMMIT_FIRST}`);
  for (const { rel, link } of item.files) (link ? sameLink : sameAsCommit)(root, snap, rel);
  const patterns = project.filePatterns(record).map(({ regex }) => regex).filter(Boolean);
  for (const rel of indexFiles(root)) if (!snap.tree.has(rel) && !rel.startsWith(`${FOLDER}/`) && patterns.some((regex) => regex.test(rel))) throw refuse(`${rel} is a tracked file that is not in commit ${snap.commit}, and a "- File:" line of ${record.id} matches it. ${COMMIT_FIRST}`);
  if (whole) for (const { model } of item.models) if (!snap.tree.has(testOf(model)) && statOf(path.join(root, testOf(model)))) throw refuse(`${testOf(model)} is on disk and not in commit ${snap.commit}, and the model check would run it. ${COMMIT_FIRST}`);
}

function assertModelInputs(root, snap, items, records) {
  if (!items.some((item) => item.models.length)) return;
  const inModels = [...snap.tree].filter(([rel, { mode, type }]) => rel.startsWith(`${MODELS}/`) && type === "blob" && mode !== "120000").map(([rel]) => rel);
  for (const rel of [...inModels, ...records.map((record) => record.rel)]) sameAsCommit(root, snap, rel);
}

function parsedJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error.message };
  }
}

function compiled(proof) {
  try {
    return { regex: new RegExp(proof, "m") };
  } catch (error) {
    return { error: error.message };
  }
}

function shapeOfVerification(value, id) {
  if (!isObject(value)) return { body: ["the file is not a JSON object."], judged: [] };
  const body = [];
  const judged = [];
  let problems = body;
  const keys = (object, where, required, optional = []) => {
    for (const key of required) if (!Object.hasOwn(object, key)) problems.push(`${where}the key "${key}" is missing.`);
    for (const key of Object.keys(object)) if (!required.includes(key) && !optional.includes(key)) problems.push(`${where}"${key}" is not a key. The keys are ${[...required, ...optional].join(", ")}.`);
  };
  keys(value, "", ["requirement", "checks"], ["judgement"]);
  if (value.requirement !== undefined && value.requirement !== id) problems.push(`"requirement" is ${JSON.stringify(value.requirement)}. It must be "${id}", the name of the file.`);
  if (value.checks !== undefined && !Array.isArray(value.checks)) problems.push(`"checks" must be a list.`);
  else (value.checks ?? []).forEach((check, index) => {
    const where = `checks[${index}]: `;
    if (!isObject(check)) return problems.push(`${where}must be an object.`);
    keys(check, where, ["name", "run", "files", "proof"]);
    if (check.name !== undefined && !isText(check.name)) problems.push(`${where}"name" must be text.`);
    if (check.run !== undefined && !(Array.isArray(check.run) && isText(check.run[0]) && check.run.every((item) => typeof item === "string"))) problems.push(`${where}"run" must be a list: the program, then its arguments. No shell reads it.`);
    if (check.files !== undefined && !isTexts(check.files)) problems.push(`${where}"files" must be a list of one or more test files.`);
    if (check.proof !== undefined && !isText(check.proof)) problems.push(`${where}"proof" must be a regular expression.`);
    else if (check.proof !== undefined) {
      const { regex, error } = compiled(check.proof);
      if (error) problems.push(`${where}"proof" is not a valid regular expression: ${error}.`);
      else if (regex.test("")) problems.push(`${where}"proof" ${JSON.stringify(check.proof)} matches empty output, so it cannot show that a test ran.`);
    }
    if (isTexts(check.files)) for (const rel of check.files) if (!insideProject(rel)) problems.push(`${where}"${rel}" is not a path inside the project. Give a path from the project root.`);
  });
  const names = Array.isArray(value.checks) ? value.checks.map((check) => check?.name).filter(isText) : [];
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index))) problems.push(`"${name}" is the name of more than one check. Give each check its own name.`);
  const { judgement } = value;
  problems = judged;
  if (judgement !== undefined) {
    if (!isObject(judgement)) problems.push(`"judgement" must be an object.`);
    else {
      keys(judgement, "judgement: ", ["verdict", "by", "evidence", "commit", "covers"], ["overrules"]);
      if (!VERDICTS.includes(judgement.verdict)) problems.push(`judgement: "verdict" must be ${VERDICTS.join(" or ")}.`);
      for (const key of ["by", "evidence", "commit"]) if (!isText(judgement[key])) problems.push(`judgement: "${key}" must be text.`);
      if (!isObject(judgement.covers)) problems.push(`judgement: "covers" must be an object.`);
      const { overrules } = judgement;
      if (overrules !== undefined) {
        if (!isObject(overrules)) problems.push(`judgement: "overrules" must be an object.`);
        else {
          keys(overrules, "judgement: overrules: ", ["by", "evidence", "commit", "reason"]);
          for (const key of ["by", "evidence", "commit", "reason"]) if (!isText(overrules[key])) problems.push(`judgement: overrules: "${key}" must be text.`);
        }
        if (judgement.verdict !== "no-counter-example") problems.push(`judgement: only a no-counter-example has "overrules".`);
      }
    }
  }
  return { body, judged };
}

function verificationIn(text, id) {
  const rel = verificationRel(id);
  if (text === undefined) return { problems: [] };
  const { value, error } = parsedJson(text);
  const { body, judged } = error ? { body: [`not valid JSON: ${error}.`], judged: [] } : shapeOfVerification(value, id);
  const usable = judged.length ? { requirement: value.requirement, checks: value.checks } : value;
  return { value: body.length ? undefined : usable, problems: [...body, ...judged].map((problem) => `${rel}: ${problem} Repair: correct the file (${FORMAT}). Only verify-judge writes "judgement": to replace a bad one, remove the "judgement" key, commit, and judge again with verify-judge.`) };
}

const codeOfManifest = (manifest) => Object.values(manifest.actions).flatMap(({ code = [] }) => code.map((ref) => path.posix.normalize(ref.file)));
const modelFile = (entry) => entry.split("#")[0];
const manifestOf = (model) => model.replace(/\.qnt$/, ".json");
const testOf = (model) => model.replace(/\.qnt$/, "_test.qnt");

const isLink = (snap, rel) => snap.tree.get(rel)?.mode === "120000";

function importClosure(snap, starts) {
  const seen = new Set(starts);
  const queue = starts.filter((rel) => snap.tree.has(rel));
  const imports = [];
  const absent = [];
  const problems = [];
  const unknown = (rel, why) => problems.push(`${rel} cannot be read reliably: ${why}, so the files that it imports are not known. Repair: correct ${rel}, and commit it.`);
  for (const importer of queue) {
    if (isLink(snap, importer)) {
      unknown(importer, "it is a symlink");
      continue;
    }
    const text = snap.text(importer);
    const { sources, problem } = text === undefined ? { problem: "it is not a UTF-8 file" } : importSources(text);
    if (problem) unknown(importer, problem);
    for (const source of sources ?? []) {
      const target = path.posix.join(path.posix.dirname(importer), `${source}.qnt`);
      const wrong = (why) => problems.push(`${importer} imports ${JSON.stringify(source)}, ${why} Repair: import a file that the commit holds, or commit it.`);
      if (!insideProject(target)) wrong("which leaves the project.");
      else if (snap.tree.get(target)?.type !== "blob") {
        absent.push(target);
        wrong(`and ${target} is not a file in the commit.`);
      } else if (!seen.has(target)) {
        seen.add(target);
        imports.push(target);
        queue.push(target);
      }
    }
  }
  return { imports, absent, problems };
}

const under = (snap, folder) => [...snap.tree].filter(([rel, { type }]) => type === "blob" && (!folder || rel.startsWith(`${folder}/`))).map(([rel]) => rel);
const isFolder = (snap, rel) => !rel || [...snap.tree.keys()].some((key) => key.startsWith(`${rel}/`));
const asListed = (rel) => path.posix.normalize(rel).replace(/\/+$/, "").replace(/^\.$/, "");

function walked(snap, given) {
  const at = [];
  for (const part of given.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!at.length) return undefined;
      at.pop();
      continue;
    }
    at.push(part);
    if (isLink(snap, at.join("/"))) return { link: at.join("/") };
    if (snap.tree.get(at.join("/"))?.type === "commit") return { gitlink: at.join("/") };
  }
  return { rel: at.join("/") };
}

const OWN_READERS = new Set(["npm", "npx", "yarn", "pnpm", "bun", "make", "just", "env"]);
const SHELLS = new Set(["sh", "bash"]);
const GLOB = /[*?]/;
const UNREAD_GLOB = /[[{]|[!+@]\(/;

function readsOwnWay(run) {
  const program = path.posix.basename(run[0] ?? "");
  return OWN_READERS.has(program) || (SHELLS.has(program) && run.includes("-c"));
}

const pathLike = (candidate) => candidate.includes("/") || /\.[A-Za-z0-9]+$/.test(candidate);

function runnerForm(given) {
  const plain = given.replace(/::.*$/s, "").replace(/:\d+(:\d+)?$/, "");
  if (plain === "..." || plain === "./...") return ".";
  return plain.endsWith("/...") ? plain.slice(0, -4) : plain;
}

function projectPath(snap, given) {
  if (!given) return undefined;
  if (!path.posix.isAbsolute(given)) return given;
  if (given === snap.root) return ".";
  return given.startsWith(`${snap.root}/`) ? given.slice(snap.root.length + 1) || "." : undefined;
}

function patternProblem(candidate, project) {
  if (UNREAD_GLOB.test(candidate)) return "it uses glob syntax that verify does not read";
  const segments = candidate.replace(/^(\.\/)+/, "").split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) return "it has an empty, . or .. segment";
  if (segments.some((part) => part.includes("**") && part !== "**")) return "it has a ** that is not a whole segment";
  return project.filePattern(segments.join("/")) ? undefined : "verify cannot read it";
}

const gitlinkUnder = (snap, folder) => [...snap.tree].find(([rel, { type }]) => type === "commit" && (!folder || rel.startsWith(`${folder}/`)))?.[0];
const isPattern = (text) => GLOB.test(text) || UNREAD_GLOB.test(text);

function ranTargets(snap, check, project) {
  const files = new Set();
  const folders = new Set();
  const refused = [];
  const own = readsOwnWay(check.run);
  const given = check.run.flatMap((arg) => (arg.includes("=") ? [...arg].flatMap((char, index) => (char === "=" ? [arg.slice(index + 1)] : [])) : [arg]));
  for (const arg of given) {
    const candidate = projectPath(snap, runnerForm(arg));
    if (candidate === undefined) continue;
    if (own && !pathLike(candidate)) continue;
    if (isPattern(candidate)) {
      const segments = candidate.replace(/^(\.\/)+/, "").split("/");
      const fixed = segments.slice(0, segments.findIndex(isPattern)).join("/");
      const prefix = walked(snap, fixed);
      if (prefix?.link !== undefined) refused.push({ arg, kind: "link", at: prefix.link });
      else if (prefix?.gitlink !== undefined) refused.push({ arg, kind: "gitlink", at: prefix.gitlink });
      if (!prefix || prefix.rel === undefined) continue;
      if (fixed ? snap.tree.get(prefix.rel)?.type === "blob" || !isFolder(snap, prefix.rel) : !candidate.includes("/")) continue;
      const why = patternProblem(candidate, project);
      if (why) {
        refused.push({ arg, kind: "syntax", why });
        continue;
      }
      const inside = gitlinkUnder(snap, prefix.rel);
      if (inside !== undefined) {
        refused.push({ arg, kind: "gitlink", at: inside });
        continue;
      }
      const regex = project.filePattern(segments.join("/"));
      const matched = under(snap, "").filter((rel) => regex.test(rel));
      if (!matched.length) refused.push({ arg, kind: "no match" });
      for (const rel of matched) files.add(rel);
      continue;
    }
    const found = walked(snap, candidate);
    if (!found) continue;
    if (found.link !== undefined) refused.push({ arg, kind: "link", at: found.link });
    else if (found.gitlink !== undefined) refused.push({ arg, kind: "gitlink", at: found.gitlink });
    else if (snap.tree.get(found.rel)?.type === "blob") files.add(found.rel);
    else if (isFolder(snap, found.rel)) {
      const inside = gitlinkUnder(snap, found.rel);
      if (inside !== undefined) refused.push({ arg, kind: "gitlink", at: inside });
      else folders.add(found.rel);
    }
  }
  return { files: [...files], folders: [...folders], refused };
}

function runTargets(snap, check, project) {
  const { files, folders, refused } = ranTargets(snap, check, project);
  return { refused, targets: [...new Set([...files, ...folders.flatMap((folder) => under(snap, folder))])].filter((rel) => !rel.startsWith(`${FOLDER}/`)) };
}

function runProblems(snap, check, project, file) {
  const { refused, targets } = runTargets(snap, check, project);
  const runs = (arg) => `check "${check.name}" runs ${arg}`;
  const text = {
    syntax: ({ arg, why }) => `${runs(arg)}, and ${why}, so the files it runs are not known. A pattern in "run" may use only *, ? and a whole-segment **. Repair: name the test files or folders in "run" in ${file}.`,
    "no match": ({ arg }) => `${runs(arg)}, a pattern that matches no tracked file in commit ${snap.commit}. Repair: commit the files it runs, or correct the pattern in "run" in ${file}.`,
    link: ({ arg, at }) => `${runs(arg)}, and ${at} is a symlink in commit ${snap.commit}, so the file that runs is not the file that is covered. Repair: name the real path in "run" in ${file}.`,
    gitlink: ({ arg, at }) => `${runs(arg)}, and ${at} is a submodule in commit ${snap.commit}, which holds no content here. Repair: name files of this repository in "run" in ${file}.`,
  };
  return [
    ...refused.map((item) => text[item.kind](item)),
    ...(refused.length || targets.length ? [] : [`${runs("no tracked file or folder")}: ${JSON.stringify(check.run)}. A runner that finds its own tests is not seen, so a change to them would not select the requirement or change the judgement. Repair: name the test files or folders in "run" in ${file}.`]),
  ];
}

function testFiles(snap, check) {
  return check.files.map(asListed).flatMap((rel) => (snap.tree.get(rel)?.type !== "blob" && rel && isFolder(snap, rel) ? under(snap, rel) : [rel]));
}

function ancestors(rel) {
  const parts = path.posix.dirname(rel).split("/").filter((part) => part !== ".");
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

const attributesFile = (folder) => (folder ? `${folder}/.gitattributes` : ".gitattributes");
const attributesOf = (snap, rel) => ancestors(rel).map(attributesFile).filter((file) => file !== rel && snap.tree.has(file));

function covered(snap, record, verification, project) {
  const covers = new Map();
  const files = [];
  const problems = [];
  const missing = [];
  const named = new Set();
  const absent = new Set();
  const add = (role, rel, asLink = false) => {
    if (!insideProject(rel)) return false;
    if (isLink(snap, rel) && asLink) {
      if (!covers.has(`${role} ${rel}`)) files.push({ role, rel, link: true });
      covers.set(`${role} ${rel}`, digest(snap.linkText(rel)));
      return true;
    }
    if (isLink(snap, rel)) {
      missing.push(`${rel} is a symlink in commit ${snap.commit}, so the commit does not hold what runs or is judged. Repair: replace it with a regular file, or link the real file in ${record.rel}.`);
      return undefined;
    }
    named.add(rel);
    const found = snap.bytes(rel);
    if (found === undefined) return false;
    if (!covers.has(`${role} ${rel}`)) files.push({ role, rel });
    covers.set(`${role} ${rel}`, digest(found));
    return true;
  };
  covers.set("statement", digest(record.sections.Statement ?? ""));
  if (!(record.sections.Statement ?? "").trim()) missing.push(`${record.id} has no Statement, so there is nothing to judge. Repair: write the "## Statement" section of ${record.rel}, which the human agrees to, and commit it.`);
  const linkable = (rel) => rel !== record.rel && !rel.startsWith(`${FOLDER}/`);
  let linkedCode = 0;
  for (const { raw, regex } of project.filePatterns(record)) {
    const matched = regex ? [...snap.tree.keys()].filter((rel) => regex.test(rel) && linkable(rel)).sort() : [];
    if (!matched.length) problems.push(`"- File: ${raw}" matches no tracked file. Repair: correct the line in ${record.rel}, or commit the file.`);
    for (const rel of matched) {
      const added = add("code", rel);
      if (added) linkedCode += 1;
      else if (added === false) problems.push(`"- File: ${raw}": ${rel} is not a file in the commit (a submodule holds no content here). Repair: name files of this repository in ${record.rel}.`);
    }
  }
  const entries = project.modelEntries(record);
  if (entries.length) covers.set("model list", digest(JSON.stringify([...entries].sort())));
  const models = [];
  for (const model of [...new Set(entries.map(modelFile))]) {
    const found = add("model", model);
    if (!found) {
      if (found === false) missing.push(`the model ${model} is not a tracked file. Repair: commit the model, or correct the "model" list of ${record.id}.`);
      continue;
    }
    const manifestRel = manifestOf(model);
    const listed = add("model manifest", manifestRel);
    if (!listed) {
      if (listed === false) problems.push(`the model ${model} has no manifest. Repair: write ${manifestRel} (the requirements-model skill), and commit it.`);
      continue;
    }
    add("model test", testOf(model));
    const closure = importClosure(snap, [model, testOf(model)]);
    for (const rel of closure.imports) add("model import", rel);
    for (const rel of closure.absent) absent.add(rel);
    missing.push(...closure.problems);
    const { value, error } = parsedJson(snap.text(manifestRel) ?? "");
    const readable = !error && !shapeProblems(value, path.posix.basename(model, ".qnt")).length;
    models.push({ model, manifestRel });
    if (!readable) continue;
    for (const rel of codeOfManifest(value)) if (!add("code that the model cites", rel)) missing.push(`${manifestRel} cites ${rel}, which is not a tracked file. Repair: correct "file" in the manifest, or commit the file.`);
    for (const name of entries.filter((entry) => modelFile(entry) === model && entry.includes("#")).map((entry) => entry.split("#")[1])) if (![...value.invariants, ...value.witnesses].includes(name)) problems.push(`${manifestRel} does not list the property "${name}" that the "model" list of ${record.id} names. Repair: add it to "invariants" or "witnesses", or correct the "model" list.`);
    if (!value.requirements.includes(record.id)) problems.push(`"requirements" of ${manifestRel} does not list ${record.id}. Repair: add it, or remove the model from the "model" list of ${record.id}.`);
  }
  if (verification) {
    covers.set("checks", digest(JSON.stringify(verification.checks.map(({ name, run, files: tests, proof }) => ({ name, run, files: tests, proof })))));
    for (const check of verification.checks) missing.push(...runProblems(snap, check, project, verificationRel(record.id)));
    for (const check of verification.checks) for (const rel of testFiles(snap, check)) if (add("check test", rel) === false) missing.push(`check "${check.name}": the test file ${rel} is not a tracked file. Repair: commit it, or correct "files".`);
    const tests = new Set(verification.checks.flatMap((check) => testFiles(snap, check)));
    for (const check of verification.checks) for (const rel of runTargets(snap, check, project).targets) if (!tests.has(rel)) add("run target", rel, true);
  }
  for (const rel of new Set(files.flatMap(({ rel }) => attributesOf(snap, rel)))) add("git attributes", rel);
  return { covers, files, named, absent, problems, missing: [...new Set(missing)], models, linkedCode };
}

function differences(before, now) {
  return [...new Set([...before.keys(), ...now.keys()])].flatMap((key) => {
    if (!before.has(key)) return [`${key} is new`];
    if (!now.has(key)) return [`${key} is no longer covered`];
    return before.get(key) === now.get(key) ? [] : [`${key} changed`];
  });
}

function subject(snap, record, project) {
  const rel = verificationRel(record.id);
  const present = snap.tree.has(rel);
  const read = verificationIn(present ? snap.text(rel) ?? "" : undefined, record.id);
  return { record, present, verification: read.value, invalid: read.problems, ...covered(snap, record, read.value, project) };
}

function brief(item, commit) {
  return [`Requirement: ${item.record.id}`, `Commit: ${commit}`, "", "Statement:", item.record.sections.Statement ?? "", "", "Linked files:", ...item.files.map(({ role, rel }) => `- ${role}: ${rel}`), "", ...(item.verification?.checks.length ? ["Checks:", ...item.verification.checks.map((check) => `- ${check.name}: run ${JSON.stringify(check.run)}; proof ${JSON.stringify(check.proof)}`), ""] : [])].join("\n");
}

function judgeable(root, id, project) {
  const snap = snapshot(root, headCommit(root));
  const item = subject(snap, inForceRecord(committedRecords(snap, project), id, project), project);
  const rel = verificationRel(id);
  if (!item.present) throw refuse(`${rel} is not in the commit ${snap.commit}. Repair: write it with "requirement" and "checks" (${FORMAT}), commit it with the files that it covers, and run the command again.`);
  assertOnDisk(root, snap, item, project, { whole: false });
  const problems = [...item.invalid, ...item.missing];
  if (problems.length) throw refuse([`${id} cannot be judged:`, ...problems].join("\n"));
  return { snap, item };
}

export function verifyBrief(from, ids, options, project) {
  onlyOptions("verify-brief", options, []);
  const id = oneId("verify-brief", ids);
  const { snap, item } = judgeable(realpathSync(from), id, project);
  return { text: brief(item, snap.commit), commit: snap.commit, requirement: id, files: item.files };
}

function evidenceIn(root, given) {
  const full = path.resolve(root, given);
  const stat = statOf(full);
  if (!stat) throw refuse(`the evidence file ${full} does not exist. Repair: write the evidence of the judge to a file, and name it with --evidence.`);
  const text = utf8(readFileSync(full));
  if (text === undefined) throw refuse(`the evidence file ${full} is not valid UTF-8. Repair: save it as UTF-8.`);
  if (!text.trim()) throw refuse(`the evidence file ${full} is empty. Repair: write what the judge tried and what it found.`);
  return text;
}

export function verifyJudge(from, ids, options, project) {
  onlyOptions("verify-judge", options, ["commit", "verdict", "by", "evidence", "overrule", "base"]);
  const id = oneId("verify-judge", ids);
  for (const name of ["commit", "verdict", "by", "evidence"]) if (!options[name]?.trim()) throw usage(`verify-judge needs --${name}, with a value.`);
  if (!VERDICTS.includes(options.verdict)) throw usage(`Unknown verdict "${options.verdict}": use ${VERDICTS.join(" or ")}.`);
  const overrule = options.overrule?.trim();
  if (options.overrule !== undefined && !overrule) throw usage(`--overrule needs the reason why the human rejects the counter-example.`);
  if (overrule && options.verdict !== "no-counter-example") throw usage(`--overrule records a no-counter-example over a current counter-example. It does not take --verdict ${options.verdict}.`);
  const root = realpathSync(from);
  const evidence = evidenceIn(root, options.evidence);
  const resolved = runGit(root, ["rev-parse", "--verify", "--end-of-options", `${options.commit}^{commit}`]);
  if (resolved.failure) throw refuse(`${options.commit} is not a commit of this repository: ${resolved.failure}. Repair: give the commit that verify-brief printed.`);
  const sha = resolved.bytes.toString().trim();
  const { snap, item } = judgeable(root, id, project);
  const then = snapshot(root, sha);
  const record = recordsIn(then, project).find((found) => found.id === id);
  const changed = record ? differences(subject(then, record, project).covers, item.covers) : [`${id} is not a record in that commit`];
  if (changed.length) throw refuse(`what the judgement covers differs between the commit of the brief ${sha} and HEAD ${snap.commit}: ${changed.join("; ")}. The judge did not see what is committed now. Repair: run ${SCRIPT} verify-brief ${id} again, and judge the new brief.`);
  const rel = verificationRel(id);
  const value = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  const current = (held) => held?.verdict === "counter-example" && isObject(held.covers) && !differences(new Map(Object.entries(held.covers)), item.covers).length;
  const atBase = options.base === undefined ? undefined : counterAt(snapshot(root, mergeBaseOf(root, options.base, snap.commit)), id);
  const standing = [atBase, item.verification.judgement, value.judgement].find(current);
  if (overrule && !standing) throw refuse(`${id}: there is no current counter-example to overrule in ${rel}. Repair: record the judgement without --overrule.`);
  if (standing && options.verdict !== "counter-example" && !overrule) throw refuse(`${id} has a current counter-example${standing === atBase ? " at the merge base" : ""} by ${standing.by} at ${standing.commit} in ${rel}. Nothing that it covers has changed, so ${options.verdict} is refused: a judge is not asked again until it passes. Repair: change the code or ask the human about the requirement. A human who rejects the counter-example records it with ${SCRIPT} verify-judge ${id}${options.base === undefined ? "" : ` --base ${options.base}`} --overrule "<reason>", and a reviewer reads it in the diff.`);
  value.judgement = { verdict: options.verdict, by: options.by.trim(), evidence, commit: sha, covers: Object.fromEntries(item.covers), ...(overrule ? { overrules: { by: standing.by, evidence: standing.evidence, commit: standing.commit, reason: overrule } } : {}) };
  writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
  return `${rel}: recorded ${options.verdict} by ${options.by.trim()} at ${sha}. Commit the file, then run ${SCRIPT} verify ${id}.\n`;
}

function checkTimeout() {
  const given = process.env[TIME_LIMIT] ?? "600000";
  if (!/^[1-9]\d*$/.test(given)) throw refuse(`${TIME_LIMIT} is "${given}". Repair: give a whole number of milliseconds above 0, or unset it.`);
  return Number(given);
}

function runCheck(root, id, check, timeout) {
  const out = spawnSync(check.run[0], check.run.slice(1), { cwd: root, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  const output = [out.stdout, out.stderr].map((text) => (text ?? "").trimEnd()).filter(Boolean).join("\n");
  const stop = (what, repair) => {
    throw refuse(`${id}: check "${check.name}" ${what} Command: ${JSON.stringify(check.run)}. This is not a pass, and no state was given. Repair: ${repair}\n  Output:${said(output)}`);
  };
  if (out.error?.code === "ETIMEDOUT") stop(`did not finish in ${timeout} ms.`, `make the check faster, or give more time with ${TIME_LIMIT}.`);
  if (out.error && !out.pid) stop(`could not start: ${out.error.message}.`, `install the program, or correct "run" in ${verificationRel(id)}.`);
  if (out.error) stop(`did not finish: ${out.error.message}.`, "remove the cause and run verify again.");
  if (out.signal) stop(`ended on signal ${out.signal}.`, "remove the cause and run verify again.");
  return { name: check.name, run: check.run, exit: out.status, output };
}

function judgedState(root, item, runModel, timeout) {
  const { record, verification } = item;
  const reasons = { violated: [], stale: [], unverified: [] };
  const id = record.id;
  const checks = [];
  const models = [];
  if (!item.present) reasons.unverified.push(`there is no verification file ${verificationRel(id)}. Repair: write it with "requirement" and "checks" (${FORMAT}), commit it, then judge the requirement.`);
  reasons.unverified.push(...item.invalid);
  reasons.unverified.push(...item.missing, ...item.problems);
  if (!item.linkedCode) reasons.unverified.push(`there is no linked code. Repair: add each file that implements ${id} with ${SCRIPT} file ${id} <path or pattern>, and commit the record.`);
  if (!verification?.checks.length && !item.models.length) reasons.unverified.push(`there is no check and no model. Repair: add a linked test to "checks" of ${verificationRel(id)}, or link a model.`);
  const judgement = verification?.judgement;
  if (verification && !judgement && !item.invalid.length) reasons.unverified.push(`there is no judgement. ${rejudge(id)}`);
  if (judgement) {
    const changed = differences(new Map(Object.entries(judgement.covers)), item.covers);
    const evidence = `${judgement.verdict} by ${judgement.by} at ${judgement.commit}. Evidence:${said(judgement.evidence.trimEnd())}`;
    if (changed.length) reasons.stale.push(`what the judgement covers has changed since ${evidence}\n  Changes: ${changed.join("; ")}.\n  ${rejudge(id)}`);
    else if (judgement.verdict === "counter-example") reasons.violated.push(`a current judgement is a ${evidence}\n  Repair: correct the code or ask the human to change the requirement. Then commit. ${rejudge(id)}`);
  }
  const counter = item.baseCounter;
  if (counter) reasons.violated.push(`the merge base holds a current counter-example by ${counter.by} at ${counter.commit}, and nothing that it covers has changed. This change removes or replaces it with no "overrules" that copies it. Evidence:${said(counter.evidence.trimEnd())}\n  Repair: change the code, or restore the counter-example. When a human rejects it, record a new judgement with ${SCRIPT} verify-judge ${id} --base ${item.baseRef} --overrule "<reason>".`);
  for (const check of verification?.checks ?? []) {
    const { output, ...result } = runCheck(root, id, check, timeout);
    checks.push(result);
    if (result.exit !== 0) reasons.violated.push(`check "${check.name}" exited ${result.exit}: ${JSON.stringify(check.run)}. Output:${said(output)}\n  Repair: correct the code or the test, commit, and run verify again.`);
    else if (!compiled(check.proof).regex.test(output)) reasons.unverified.push(`check "${check.name}" passed, and its output does not match its proof ${JSON.stringify(check.proof)}, so nothing shows that a test ran. Output:${said(output)}\n  Repair: run the linked tests in "run", or correct "proof".`);
  }
  for (const { model, manifestRel } of item.models) {
    const problems = runModel(manifestRel);
    const kinds = new Set(problems.map((problem) => problem.kind));
    models.push({ model, manifest: manifestRel, result: kinds.has("violated") ? "violated" : kinds.has("drift") ? "drift" : problems.length ? "failed" : "passed", problems: problems.map((problem) => problem.message) });
    for (const { kind, message } of problems) reasons[kind === "violated" ? "violated" : kind === "drift" ? "stale" : "unverified"].push(kind === "other" ? `model check: ${message}` : message);
  }
  const state = STATES.find((name) => reasons[name].length) ?? "verified";
  return { id, state, reasons: STATES.flatMap((name) => reasons[name]), checks, models };
}

function linksOf(snap, record, records, project) {
  const paths = new Set([record.rel, verificationRel(record.id)]);
  const folders = [];
  const patterns = project.filePatterns(record).map(({ regex }) => regex);
  let unreadable = patterns.some((regex) => !regex);
  for (const model of new Set(project.modelEntries(record).map(modelFile))) {
    const manifestRel = manifestOf(model);
    for (const rel of [model, manifestRel, testOf(model)]) paths.add(path.posix.normalize(rel));
    const closure = importClosure(snap, [model, testOf(model)]);
    for (const rel of closure.imports) paths.add(rel);
    if (closure.problems.length) unreadable = true;
    if (isLink(snap, manifestRel)) unreadable = true;
    if (!snap.tree.has(manifestRel) || isLink(snap, manifestRel)) continue;
    const { value, error } = parsedJson(snap.text(manifestRel) ?? "");
    if (error || shapeProblems(value, path.posix.basename(model, ".qnt")).length) {
      unreadable = true;
      continue;
    }
    for (const rel of codeOfManifest(value)) paths.add(rel);
    for (const named of records.filter((other) => value.requirements.includes(other.id))) paths.add(named.rel);
  }
  const rel = verificationRel(record.id);
  if (isLink(snap, rel)) unreadable = true;
  else if (snap.tree.has(rel)) {
    const { value, problems } = verificationIn(snap.text(rel) ?? "", record.id);
    if (problems.length) unreadable = true;
    for (const check of value?.checks ?? []) {
      const ran = ranTargets(snap, check, project);
      if (ran.refused.length || !(ran.files.length || ran.folders.length)) unreadable = true;
      for (const file of [...check.files.map(asListed), ...ran.files]) paths.add(file);
      folders.push(...check.files.map(asListed).filter((rel) => snap.tree.get(rel)?.type !== "blob"), ...ran.folders);
    }
  }
  const inFolder = (file) => folders.some((folder) => !folder || file.startsWith(`${folder}/`));
  const holds = (file) => paths.has(file) || inFolder(file) || patterns.some((regex) => regex?.test(file));
  const held = [...paths, ...[...snap.tree.keys()].filter(holds)];
  const attributed = new Set(held.flatMap(ancestors));
  return { unreadable, holds: (file) => holds(file) || (path.posix.basename(file) === ".gitattributes" && attributed.has(path.posix.dirname(file) === "." ? "" : path.posix.dirname(file))) };
}

function baseRecords(snap, project) {
  return recordPaths(snap, project).map((rel) => {
    const unread = (why) => ({ id: `REQ-${path.posix.basename(rel).slice(0, 4)}`, rel, why });
    if (isLink(snap, rel)) return unread("it is a symlink");
    const text = snap.text(rel);
    if (text === undefined) return unread("it is not a UTF-8 file");
    const record = project.parse(rel, text);
    return record.front.data && project.status.test(record.status ?? "") ? record : unread("it has no valid front matter and status");
  });
}

function mergeBaseOf(root, ref, commit) {
  const resolved = runGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (resolved.failure) throw refuse(`--base "${ref}" is not a commit: ${resolved.failure}. Repair: give a branch or a commit of this repository, and fetch the full history first.`);
  const found = runGit(root, ["merge-base", resolved.bytes.toString().trim(), commit]);
  if (found.failure) throw refuse(`--base "${ref}": no merge base with HEAD: ${found.failure}. Repair: fetch the full history (fetch-depth: 0 in actions/checkout), or give the right base.`);
  return found.bytes.toString().trim();
}

function counterAt(snap, id) {
  const rel = verificationRel(id);
  if (!snap.tree.has(rel) || isLink(snap, rel)) return undefined;
  const judgement = verificationIn(snap.text(rel) ?? "", id).value?.judgement;
  return judgement?.verdict === "counter-example" ? judgement : undefined;
}

const answers = (judgement, counter) => judgement?.verdict === "counter-example" || (judgement?.verdict === "no-counter-example" && ["by", "evidence", "commit"].every((key) => judgement.overrules?.[key] === counter[key]));

function deprecationProblem(now, records) {
  if (!String(now.data.decided_by ?? "").trim()) return `"decided_by" is empty, so no human is named who decided it`;
  const number = now.status.match(/^Superseded by (\d{4})$/)?.[1];
  if (!number) return undefined;
  const target = records.find((record) => record.rel === String(now.data.superseded_by ?? ""));
  if (!target) return `"superseded_by: ${now.data.superseded_by ?? ""}" names no record at HEAD`;
  return path.posix.basename(target.rel).startsWith(`${number}-`) ? undefined : `"superseded_by" names ${target.id}, and the status is ${now.status}`;
}

function leftForce(id, then, unread, now, records, project) {
  const had = unread ? `the record ${unread.rel} at the base cannot be read (${unread.why}), so it may have been in force` : "it was in force at the base";
  const retire = `deprecate it with ${SCRIPT} deprecate ${id} --reason "<why>" --decided-by "<name>"`;
  if (!now) return { id, why: `${had}, and the commit has no record of it. Repair: restore a record with its number (${then[0].rel}), and ${retire}, which keeps the record.`, failed: true };
  const moved = path.posix.dirname(now.rel) === project.folders[1] && project.gone.test(now.status);
  const invalid = moved && deprecationProblem(now, records);
  if (invalid) return { id, why: `${had}, and it is in ${project.folders[1]} with the status ${now.status} (${now.rel}), but ${invalid}. Repair: deprecate it with ${SCRIPT} deprecate, which records who decided it and the record that replaces it, or correct the record.`, failed: true };
  if (moved) return { id, why: `${had}, and its status is ${now.status} (${now.rel}), so it is not verified.`, failed: false };
  return { id, why: `${had}, and its status is ${now.status} (${now.rel}). Only a deprecated record is excused: in ${project.folders[1]}, with the status Retired or "Superseded by NNNN". Repair: put the record back in force, or ${retire} (the human decides this).`, failed: true };
}

function touchedSince(root, ref, snap, records, project) {
  const mergeBase = mergeBaseOf(root, ref, snap.commit);
  const changed = git(root, ["diff", "--no-renames", "--no-ext-diff", "--ignore-submodules=none", "--relative", "--name-only", "-z", mergeBase, snap.commit], "repair the repository and run the command again.").split("\0").filter(Boolean);
  const before = snapshot(root, mergeBase);
  const old = baseRecords(before, project);
  const ids = [...new Set([...old, ...records].map((record) => record.id))].sort();
  const selected = [];
  const notVerified = [];
  const standing = new Map();
  for (const id of ids) {
    const then = old.filter((record) => record.id === id);
    const now = records.find((record) => record.id === id);
    const unread = then.find((record) => record.why);
    if (now && project.inForce(now)) {
      const sides = [[snap, now, records], ...then.map((record) => [before, record, old])];
      const counter = counterAt(before, id);
      const held = counter && subject(snap, now, project);
      if (held && !differences(new Map(Object.entries(counter.covers)), held.covers).length && !answers(held.verification?.judgement, counter)) standing.set(id, counter);
      if (standing.has(id) || unread || sides.some(([at, record, others]) => {
        const links = linksOf(at, record, others, project);
        return links.unreadable || changed.some(links.holds);
      })) selected.push(now);
    } else if (unread || then.some(project.inForce)) notVerified.push(leftForce(id, then, unread, now, records, project));
  }
  return { base: { ref, mergeBase }, standing, selected, notVerified, searched: ids.length };
}

const lines = (result) => [`${result.id}: ${result.state}`, ...result.reasons.map((reason) => `  - ${reason}`)].join("\n");

function changes(root) {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], "run the command in a git repository.").trimEnd();
}

function resolvedParent(full) {
  const parent = path.dirname(full);
  return statOf(parent) ? path.join(realpathSync.native(parent), path.basename(full)) : path.join(resolvedParent(parent), path.basename(full));
}

function reportTarget(root, given) {
  const full = path.resolve(root, given);
  const stat = statOf(full);
  if (stat && !stat.isFile()) throw refuse(`the report ${given} is not a file: it is a folder or a link. Repair: name a new file.`);
  const rel = path.relative(root, resolvedParent(full));
  if (insideProject(rel) && git(root, ["--literal-pathspecs", "ls-files", "-z", "--", rel], "run the command in a git repository.")) throw refuse(`the report ${given} is a tracked file. verify does not change a tracked file. Repair: name a file that git does not track.`);
  if (!stat) return full;
  if (parsedJson(readFileSync(full, "utf8")).value?.kind !== REPORT) throw refuse(`the report ${given} exists and is not a report of verify, so verify does not delete or overwrite it. Repair: name a new file, or remove the file yourself.`);
  rmSync(full);
  return full;
}

export const discardReport = (from, given) => reportTarget(realpathSync(from), given);

function assertContent(root, snap, items, records, project) {
  for (const item of items) assertOnDisk(root, snap, item, project, { whole: true });
  assertModelInputs(root, snap, items, records);
}

function assertSettled(root, snap, items, records, project) {
  const now = headCommit(root);
  if (now !== snap.commit) throw refuse(`HEAD changed during the run, from ${snap.commit} to ${now}, so the results belong to no commit. Repair: run verify again, and make no commit while it runs.`);
  try {
    assertContent(root, snap, items, records, project);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw refuse(`covered content changed during the run, so the results belong to no commit: ${error.message}`);
  }
}

export function verify(from, ids, options, project) {
  const root = realpathSync(from);
  onlyOptions("verify", options, ["all", "base", "report"]);
  const report = options.report === undefined ? undefined : reportTarget(root, options.report);
  if ([ids.length > 0, Boolean(options.all), options.base !== undefined].filter(Boolean).length !== 1) throw usage("verify needs exactly one of <REQ-NNNN>..., --all or --base <git ref>.");
  const timeout = checkTimeout();
  const dirty = changes(root);
  if (dirty) throw refuse(`the worktree has changes, and the results of verify belong to a commit:\n${dirty}\nRepair: commit the changes, or remove them. Ignored files are accepted.`);
  const snap = snapshot(root, headCommit(root));
  const records = committedRecords(snap, project);
  const since = options.base === undefined ? undefined : touchedSince(root, options.base, snap, records, project);
  const chosen = since ? since.selected : options.all ? records.filter(project.inForce) : [...new Set(ids)].map((id) => inForceRecord(records, id, project));
  if (!since && !chosen.length) throw refuse(`no record is in force in commit ${snap.commit} (${counted(records.length, "record")} searched), so nothing was verified. Repair: verify a project that has a record in force.`);
  const items = chosen.map((record) => ({ ...subject(snap, record, project), baseCounter: since?.standing.get(record.id), baseRef: since?.base.ref }));
  assertContent(root, snap, items, records, project);
  let runner;
  const runs = new Map();
  const runModel = (manifestRel) => {
    runner ??= modelRunner(root, project.modelRecords);
    if (!runs.has(manifestRel)) runs.set(manifestRel, runner(manifestRel));
    return runs.get(manifestRel);
  };
  const results = items.map((item) => judgedState(root, item, runModel, timeout));
  assertSettled(root, snap, items, records, project);
  const notVerified = since?.notVerified.map(({ id, why }) => ({ id, why }));
  const summary = { commit: snap.commit, ...(since ? { base: since.base } : {}), requirements: results, ...(since ? { notVerified } : {}) };
  if (report) {
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, `${JSON.stringify({ kind: REPORT, ...summary }, null, 2)}\n`);
  }
  const text = [
    `verify at commit ${snap.commit}${since ? `, changes from ${since.base.mergeBase} (the merge base with ${since.base.ref})` : ""}`,
    ...(since && !chosen.length ? [`the changes touch no requirement in force to verify (${counted(since.searched, "record")} searched).`] : []),
    ...results.map(lines),
    ...(notVerified ?? []).map(({ id, why }) => `Not verified: ${id}: ${why}`),
  ].join("\n");
  if (results.some((result) => result.state !== "verified") || since?.notVerified.some((left) => left.failed)) throw refuse(text);
  return { text: `${text}\n`, ...summary };
}
