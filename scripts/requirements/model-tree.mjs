const NOISE = new Set(["id", "depth", "doc"]);
const GENERATED = /^(quintTupledLambdaParam|quintDestructTemp|_undefinedDeclaration|__undefinedParam)\d+$/;
const DESTRUCTURED = /^quintDestructTemp\d+$/;
const LONG_NUMBER = /("value":\s*)(-?\d{16,})(?=\s*[,}\]])/g;
const VALUES = ["val", "pureval"];

export const parseJson = (text) => JSON.parse(text.replace(LONG_NUMBER, '$1"$2"'));

function visit(node, each) {
  if (node === null || typeof node !== "object") return;
  if (!Array.isArray(node)) each(node);
  for (const child of Object.values(node)) visit(child, each);
}

function renaming(fixed) {
  const seen = new Map();
  return (name) => {
    if (fixed.has(name)) return fixed.get(name);
    if (!GENERATED.test(name)) return name;
    if (!seen.has(name)) seen.set(name, `${name.replace(/\d+$/, "")}#${seen.size}`);
    return seen.get(name);
  };
}

function canonical(node, rename) {
  if (Array.isArray(node)) return node.map((child) => canonical(child, rename));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => !NOISE.has(key)).map(([key, child]) => [key, (key === "name" || key === "opcode") && typeof child === "string" ? rename(child) : canonical(child, rename)]));
}

function destructuredNames(definitions) {
  return new Map(definitions.filter((definition) => DESTRUCTURED.test(definition.name)).map((temp) => {
    const users = definitions.filter((definition) => {
      let uses = false;
      visit(definition.expr, (node) => { uses ||= node.name === temp.name || node.opcode === temp.name; });
      return uses;
    });
    return [temp.name, `destructured(${users.map((definition) => definition.name).sort().join(",")})`];
  }));
}

export function indexTree({ modules, table }) {
  const defs = new Map();
  const owners = new Map();
  const rest = [];
  const instantiated = new Set();
  const overrides = [];
  const trees = [];
  for (const { name: module, declarations } of modules) {
    const definitions = declarations.filter((declaration) => declaration.kind === "def");
    const fixed = destructuredNames(definitions);
    for (const declaration of declarations) {
      if (declaration.kind !== "def") {
        rest.push(`${module} ${JSON.stringify(canonical(declaration, renaming(fixed)))}`);
        if (declaration.kind === "instance") {
          instantiated.add(declaration.protoName);
          overrides.push(...declaration.overrides.map(([, expr]) => expr));
        }
        continue;
      }
      const key = `${module}::${fixed.get(declaration.name) ?? declaration.name}`;
      const body = JSON.stringify(canonical({ qualifier: declaration.qualifier, expr: declaration.expr }, renaming(fixed)));
      defs.set(key, { module, name: fixed.get(declaration.name) ?? declaration.name, qualifier: declaration.qualifier, body });
      owners.set(declaration.id, key);
      trees.push([key, declaration.expr]);
    }
  }
  const usedBy = (tree) => {
    const used = new Set();
    visit(tree, (node) => {
      const owner = owners.get(table[node.id]?.id);
      if (owner) used.add(owner);
    });
    return used;
  };
  for (const [key, tree] of trees) defs.get(key).uses = usedBy(tree);
  return { modules: new Set(modules.map((module) => module.name)), defs, rest: rest.sort(), instantiated, overridden: usedBy(overrides) };
}

function closure(index, roots) {
  const found = new Set();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    if (found.has(key) || !index.defs.has(key)) continue;
    found.add(key);
    queue.push(...index.defs.get(key).uses);
  }
  return found;
}

export const declaresValue = (index, main, name) => VALUES.includes(index.defs.get(`${main}::${name}`)?.qualifier);

export function mutantRefusal(before, after, main, listed) {
  const cannotTell = (why) => `cannot tell what the mutant reaches: ${why}.`;
  if (JSON.stringify(before.rest) !== JSON.stringify(after.rest)) return cannotTell("it changes a declaration that is not a definition (an import, instance, export, type, var, const or assume)");
  const label = (key) => (key.startsWith(`${main}::`) ? key.slice(main.length + 2) : key);
  const named = (keys) => keys.map(label).sort().join(", ");
  const added = [...after.defs.keys()].filter((key) => !before.defs.has(key));
  const removed = [...before.defs.keys()].filter((key) => !after.defs.has(key));
  if (added.length || removed.length) return `it adds or removes definitions: ${[added.length && `adds ${named(added)}`, removed.length && `removes ${named(removed)}`].filter(Boolean).join(", ")}.`;
  const changed = [...before.defs.keys()].filter((key) => before.defs.get(key).body !== after.defs.get(key).body);
  if (!changed.length) return "it changes no definition: only comments or layout are different.";
  const checks = listed.map((name) => `${main}::${name}`);
  const rewritten = changed.filter((key) => checks.includes(key));
  if (rewritten.length) return `it changes "${named(rewritten)}", which "invariants" or "witnesses" lists.`;
  const system = ["init", "step"].map((name) => `${main}::${name}`);
  const absent = system.filter((key) => !before.defs.has(key));
  if (absent.length) return cannotTell(`module ${main} does not itself declare "${named(absent)}"`);
  const copied = changed.filter((key) => before.instantiated.has(before.defs.get(key).module));
  if (copied.length) return cannotTell(`"${named(copied)}" is in a module that has an instance`);
  const givenToInstance = closure(before, before.overridden);
  const overriding = changed.filter((key) => givenToInstance.has(key));
  if (overriding.length) return cannotTell(`"${named(overriding)}" gives a value to an instance`);
  const reachedBefore = closure(before, system);
  const reachedAfter = closure(after, system);
  const checking = new Set([...closure(before, checks), ...closure(after, checks)]);
  const checkOnly = changed.filter((key) => checking.has(key) && !(reachedBefore.has(key) && reachedAfter.has(key)));
  if (checkOnly.length) return `it changes "${named(checkOnly)}", which only "invariants" or "witnesses" use, in the model or in the mutant.`;
  if (!changed.some((key) => reachedBefore.has(key))) return `it changes no definition that "init" or "step" reaches: it changes ${named(changed)}.`;
  return undefined;
}
