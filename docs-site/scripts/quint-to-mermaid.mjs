#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");

// Lightweight CLI wrapper that prints Quint -> Mermaid output using Node's native TypeScript stripping.
const mod = await import(new URL("../lib/quint-to-mermaid.ts", import.meta.url));
const models = mod.loadQuintModels(REPO_ROOT);

for (const model of models) {
  console.log(`# ${model.moduleName} (${model.sourcePath})`);
  console.log(`Invariants: ${model.invariants.length}, Witnesses: ${model.witnesses.length}\n`);
  for (const d of model.diagrams) {
    console.log(`## ${d.title}`);
    console.log("```mermaid");
    console.log(d.mermaid);
    console.log("```\n");
  }
}
