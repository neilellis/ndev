import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const REPOSITORY = path.join(import.meta.dirname, "..", "..", "..");

function realQuint() {
  const local = path.join(REPOSITORY, "node_modules", ".bin", "quint");
  const quint = existsSync(local) ? local : "quint";
  const out = spawnSync(quint, ["--version"], { encoding: "utf8" });
  assert.equal(out.stdout?.trim(), "0.34.0", `These tests use the parser of the real Quint 0.34.0. "${quint} --version" exited ${out.status}: ${out.error?.message ?? out.stdout + out.stderr}. Repair: run npm install in ${REPOSITORY}.`);
  return quint === "quint" ? spawnSync("which", ["quint"], { encoding: "utf8" }).stdout.trim() : quint;
}

export const FAKE_QUINT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const [command, file] = args;
const option = (name) => args.find((a) => a.startsWith("--" + name + "="))?.slice(name.length + 3);
const text = fs.readFileSync(file, "utf8");
if (process.env.FAKE_QUINT_LOG) fs.appendFileSync(process.env.FAKE_QUINT_LOG, JSON.stringify({ args, cwd: process.cwd(), text }) + "\\n");
if (command === "parse") {
  const real = spawnSync(${JSON.stringify(realQuint())}, args, { stdio: "inherit" });
  process.exit(real.status ?? 70);
}
const end = (status, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout + "\\n");
  if (stderr) process.stderr.write(stderr + "\\n");
  process.exit(status);
};
for (const [, name] of text.matchAll(/from "\\.\\/(\\w+)"/g)) if (!fs.existsSync(path.join(path.dirname(path.resolve(file)), name + ".qnt"))) end(1, "", "error: [QNT013] module " + name + " not found\\nerror: typechecking failed");
if (command !== "typecheck" && text.includes("HANG")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
if (text.includes("TYPE_ERROR")) end(1, "", "Trying to unify int and str in " + file + "\\nerror: typechecking failed");
if (command === "typecheck") end(0);
if (command === "run") {
  const given = option("invariant");
  const negated = /^not\\((\\w+)\\)$/.exec(given);
  const name = negated ? negated[1] : given;
  const strip = (source) => source.replace(/\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*/g, " ");
  const code = strip(text);
  const imported = [...text.matchAll(/from "\\.\\/(\\w+)"/g)].map(([, sibling]) => strip(fs.readFileSync(path.join(path.dirname(path.resolve(file)), sibling + ".qnt"), "utf8")));
  const found = name === "true" ? [] : new RegExp("val " + name + " = n (<=|==) (\\\\w+)").exec(code);
  if (!found) end(1, "", "error: [QNT404] Name '" + name + "' not found (given with --invariant)\\nerror: Argument error");
  if (text.includes("SILENT")) end(0, "Use --seed=0x1 to reproduce.");
  if (text.includes("RUNTIME")) end(1, "[error] Runtime error (4ms).", "error: Runtime error");
  const guard = Number(/n < (\\d+)/.exec(code)[1]);
  const bound = /^\\d+$/.test(found[2]) ? Number(found[2]) : Number(new RegExp("pure val " + found[2] + " = (\\\\d+)").exec([code, ...imported].join("\\n"))?.[1]);
  const truth = name === "true" || (found[1] === "<=" ? guard <= bound : guard >= bound);
  if (truth !== Boolean(negated)) {
    const length = text.includes("NOINIT") ? 0 : text.includes("STILL") ? 1 : text.includes("TWOSTATES") ? 2 : guard + 1;
    end(0, "[ok] No violation found (1ms at 1 traces/second).\\nChecked invariants: " + given + (text.includes("NOSTATS") ? "" : "\\nTrace length statistics: max=" + length + ", min=" + length + ", average=" + length + ".00"));
  }
  end(1, "[violation] Found an issue (1ms).", "error: Invariant violated");
}
if (command === "test") {
  const body = text.split(/^module /m).find((part) => part.startsWith(option("main") + " ")) ?? "";
  const results = [...body.matchAll(/run \\w+Test = (\\w+)/g)].map((m) => m[1]);
  if (body.includes("QUIET")) end(0, "  0 passing (1ms)");
  if (!results.length) end(1, "", "error: no tests matched --match 'Test$'.");
  if (results.includes("fail")) end(1, "  1 failed", "error: Tests failed");
  end(0, "\\n  " + results.length + " passing (3ms)");
}
end(1, "", "error: unknown command " + command);
`;
