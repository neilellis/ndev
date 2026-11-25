import fs from "node:fs";
import path from "node:path";

export interface QuintTransition {
  from: string;
  to: string;
  label: string;
}

export interface QuintInvariant {
  name: string;
  kind: "safety" | "finding";
  expression: string;
}

export interface QuintDiagram {
  id: string;
  title: string;
  description: string;
  mermaid: string;
  states: string[];
  transitions: QuintTransition[];
}

export interface QuintModelDoc {
  slug: string;
  moduleName: string;
  sourcePath: string;
  instances: { name: string; params: string }[];
  stateSets: Record<string, string[]>;
  variables: { name: string; type: string }[];
  invariants: QuintInvariant[];
  witnesses: string[];
  diagrams: QuintDiagram[];
}

function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

function extractBalancedBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1);
}

function parseStringLiterals(expr: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function parseStateSets(clean: string): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  const re = /^\s*(?:pure\s+)?val\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Set|List)\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const values = parseStringLiterals(m[2]);
    if (values.length > 0) sets[m[1]] = values;
  }
  return sets;
}

function parseVariables(clean: string): { name: string; type: string }[] {
  const vars: { name: string; type: string }[] = [];
  const re = /^\s*var\s+([a-zA-Z0-9_]+)\s*:\s*([^\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    vars.push({ name: m[1], type: m[2].trim() });
  }
  return vars;
}

function parseInstances(clean: string, mainModule: string): { name: string; params: string }[] {
  const instances: { name: string; params: string }[] = [];
  const re = /module\s+([a-zA-Z0-9_]+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const modName = m[1];
    if (modName === mainModule) continue;
    const body = m[2];
    const imp = new RegExp(`import\\s+${mainModule}\\(([^)]+)\\)`).exec(body);
    if (imp) {
      instances.push({
        name: modName,
        params: imp[1].replace(/\s+/g, " ").trim(),
      });
    }
  }
  return instances;
}

function parseNamedVals(clean: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\s*(?:pure\s+)?val\s+([a-zA-Z0-9_]+)(?:\s*:\s*[^=]+)?\s*=\s*(.*)$/.exec(lines[i]);
    if (!header) continue;
    const name = header[1];
    let expr = header[2].trim();
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      !/^\s*(?:pure\s+)?(?:val|def|action|type|var|const|module)\b/.test(lines[j]) &&
      lines[j].trim() !== "}"
    ) {
      expr += " " + lines[j].trim();
      j += 1;
    }
    map.set(name, expr.replace(/\s+/g, " ").trim());
  }
  return map;
}

function parseGroupMembers(clean: string, groupName: string): string[] {
  const re = new RegExp(`val\\s+${groupName}(?:\\s*:\\s*bool)?\\s*=\\s*and\\s*\\{`);
  const match = re.exec(clean);
  if (!match) return [];
  const openBrace = clean.indexOf("{", match.index);
  const block = extractBalancedBlock(clean, openBrace);
  return block
    .split(/[\n,]/)
    .map((token) => token.trim())
    .filter((token) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token));
}

function parseWitnesses(clean: string): string[] {
  const witnesses: string[] = [];
  const re = /^\s*val\s+(w[A-Z][a-zA-Z0-9_]*)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    witnesses.push(m[1]);
  }
  return witnesses;
}

interface ParsedAction {
  name: string;
  body: string;
}

function parseActions(clean: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*action\s+([a-zA-Z0-9_]+)(?:\([^)]*\))?(?:\s*:\s*bool)?\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const parts: string[] = [m[2]];
    let braceDepth = (m[2].match(/\{/g) || []).length - (m[2].match(/\}/g) || []).length;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (
        braceDepth <= 0 &&
        parts.join("\n").includes("{") &&
        (line.trim() === "" ||
          /^\s{0,2}(?:pure\s+)?(?:val|def|action|type|var|const|module|\})/.test(line))
      ) {
        break;
      }
      parts.push(line);
      braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      j += 1;
    }
    actions.push({ name, body: parts.join("\n") });
  }
  return actions;
}

function dedupeTransitions(transitions: QuintTransition[]): QuintTransition[] {
  const seen = new Map<string, string[]>();
  const ordered: { from: string; to: string }[] = [];
  for (const t of transitions) {
    const key = `${t.from}-->${t.to}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, [t.label]);
      ordered.push({ from: t.from, to: t.to });
    } else if (!existing.includes(t.label)) {
      existing.push(t.label);
    }
  }
  return ordered.map(({ from, to }) => ({
    from,
    to,
    label: (seen.get(`${from}-->${to}`) ?? []).join(" / "),
  }));
}

function mermaidStateId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function renderStateDiagram(
  states: string[],
  transitions: QuintTransition[],
  options: {
    startStates?: string[];
    endStates?: string[];
    classes?: Record<string, string[]>;
  } = {},
): string {
  const lines: string[] = ["stateDiagram-v2"];
  const allNames = new Set<string>(states);
  for (const s of options.startStates ?? []) allNames.add(s);
  for (const e of options.endStates ?? []) allNames.add(e);
  for (const t of transitions) {
    allNames.add(t.from);
    allNames.add(t.to);
  }
  for (const name of allNames) {
    const id = mermaidStateId(name);
    if (id !== name) {
      lines.push(`    state "${name}" as ${id}`);
    }
  }
  for (const s of options.startStates ?? []) {
    lines.push(`    [*] --> ${mermaidStateId(s)}`);
  }
  for (const t of dedupeTransitions(transitions)) {
    const cleanLabel = t.label.replace(/:/g, " -");
    lines.push(`    ${mermaidStateId(t.from)} --> ${mermaidStateId(t.to)}: ${cleanLabel}`);
  }
  for (const e of options.endStates ?? []) {
    lines.push(`    ${mermaidStateId(e)} --> [*]`);
  }

  const classPalette: Record<string, string> = {
    start: "fill:#475569,stroke:#94a3b8,color:#ffffff",
    work: "fill:#1d4ed8,stroke:#93c5fd,color:#ffffff",
    verify: "fill:#0f766e,stroke:#5eead4,color:#ffffff",
    revise: "fill:#b45309,stroke:#fcd34d,color:#ffffff",
    done: "fill:#15803d,stroke:#86efac,color:#ffffff",
    hold: "fill:#6d28d9,stroke:#c4b5fd,color:#ffffff",
    stop: "fill:#b91c1c,stroke:#fca5a5,color:#ffffff",
  };

  const usedClasses = Object.entries(options.classes ?? {}).filter(([, list]) => list.length > 0);
  if (usedClasses.length > 0) {
    lines.push("");
    for (const [cls] of usedClasses) {
      const style = classPalette[cls];
      if (style) lines.push(`    classDef ${cls} ${style}`);
    }
    for (const [cls, list] of usedClasses) {
      const present = list.filter((s) => states.includes(s)).map(mermaidStateId);
      if (present.length > 0) {
        lines.push(`    class ${present.join(",")} ${cls}`);
      }
    }
  }
  return lines.join("\n");
}

function extractEpicDiagrams(
  clean: string,
  stateSets: Record<string, string[]>,
  actions: ParsedAction[],
): QuintDiagram[] {
  const diagrams: QuintDiagram[] = [];

  // 1. Epic phase progression directly from PHASES + finishPhase guards
  const phases = stateSets.PHASES;
  if (phases && phases.length > 1) {
    const finishAction = actions.find((a) => a.name === "finishPhase")?.body ?? "";
    const guardMap = new Map<string, string>();
    const guardRe = /phase\s*!=\s*"([^"]+)"\s+or\s+([^\n,]+)/g;
    let gm: RegExpExecArray | null;
    while ((gm = guardRe.exec(finishAction)) !== null) {
      const rawGuard = gm[2].trim().replace(/,$/, "");
      let readable = rawGuard;
      if (rawGuard.includes("issues.get(i) == \"open\"")) readable = "all sub-issues open";
      else if (rawGuard.includes("debts.open == 0")) readable = "open debt = 0, all merged";
      else if (rawGuard.includes("merged(i)")) readable = "all sub-issues merged";
      guardMap.set(gm[1], readable);
    }

    const phaseTransitions: QuintTransition[] = [];
    for (let i = 0; i < phases.length - 1; i += 1) {
      const from = phases[i];
      const to = phases[i + 1];
      const guard = guardMap.get(from);
      phaseTransitions.push({
        from,
        to,
        label: guard ? `finishPhase (${guard})` : "finishPhase",
      });
    }

    diagrams.push({
      id: "epic-phases",
      title: "Epic phase progression",
      description:
        "Derived directly from `PHASES` and `action finishPhase` in `models/workflow/epic_workflow.qnt`. An epic reaches `done` only through `closing` with zero open debt and every sub-issue merged.",
      states: phases,
      transitions: phaseTransitions,
      mermaid: renderStateDiagram(phases, phaseTransitions, {
        startStates: [phases[0]],
        endStates: [phases[phases.length - 1]],
        classes: {
          start: ["framing", "researching"],
          work: ["specifying", "deciding", "spec-review", "slicing", "coordinating"],
          verify: ["closing"],
          done: ["done"],
        },
      }),
    });
  }

  // 2. Sub-issue lifecycle directly from actions that mutate `subs`
  const subStates = new Set<string>();
  const subTransitions: QuintTransition[] = [];

  const unslicedMatch = /val\s+UNSLICED[^=]*=\s*\{[^}]*state:\s*"([^"]+)"/.exec(clean);
  const initialSub = unslicedMatch ? unslicedMatch[1] : "unsliced";
  subStates.add(initialSub);

  const finishBody = actions.find((a) => a.name === "finishPhase")?.body ?? "";
  const sliceTarget = /phase\s*==\s*"slicing"[^}]*state:\s*"([^"]+)"/.exec(finishBody);
  if (sliceTarget) {
    subStates.add(sliceTarget[1]);
    subTransitions.push({
      from: initialSub,
      to: sliceTarget[1],
      label: "finishPhase (slicing)",
    });
  }

  for (const act of actions) {
    const targetMatch = /state:\s*"([^"]+)"/.exec(act.body);
    if (!targetMatch) continue;
    const target = targetMatch[1];
    if (act.name === "finishPhase") continue;

    const exactSource = /s\.state\s*==\s*"([^"]+)"/.exec(act.body);
    if (exactSource) {
      subStates.add(exactSource[1]);
      subStates.add(target);
      let label = act.name;
      if (act.name === "start") label = "start (inFlight < PARALLEL)";
      else if (act.name === "verify") label = "verify (base=main, clean, green/skipped)";
      else if (act.name === "toFixing") label = "toFixing (rounds++)";
      subTransitions.push({ from: exactSource[1], to: target, label });
    } else if (act.name === "recordMerged") {
      subStates.add(target);
      subTransitions.push({ from: "verified", to: target, label: "recordMerged (PR merged)" });
      subTransitions.push({
        from: "reviewing",
        to: target,
        label: "recordMerged (early, +debt)",
      });
      subTransitions.push({
        from: "fixing",
        to: target,
        label: "recordMerged (early, +debt)",
      });
    } else if (act.name === "block") {
      subStates.add(target);
      for (const active of ["waiting", "implementing", "reviewing", "fixing", "verified"]) {
        if (subStates.has(active)) {
          subTransitions.push({ from: active, to: target, label: "block" });
        }
      }
    }
  }

  const unblockAct = actions.find((a) => a.name === "unblock");
  if (unblockAct && subStates.has("blocked")) {
    subTransitions.push({
      from: "blocked",
      to: "implementing",
      label: "unblock (restores previous state)",
    });
  }

  const subStateList = Array.from(subStates);
  if (subTransitions.length > 0) {
    diagrams.push({
      id: "epic-sub-issues",
      title: "Epic sub-issue lifecycle",
      description:
        "Derived directly from the `subs` state guards and transitions in `models/workflow/epic_workflow.qnt`. Stacked children start on an open pushed blocker PR and must retarget to `main` before `verify`.",
      states: subStateList,
      transitions: subTransitions,
      mermaid: renderStateDiagram(subStateList, subTransitions, {
        startStates: [initialSub],
        endStates: subStates.has("merged") ? ["merged"] : [],
        classes: {
          start: ["unsliced", "waiting"],
          work: ["implementing"],
          verify: ["reviewing", "verified"],
          revise: ["fixing"],
          done: ["merged"],
          stop: ["blocked"],
        },
      }),
    });
  }

  return diagrams;
}

function extractIssueWorkflowDiagrams(
  clean: string,
  stateSets: Record<string, string[]>,
): QuintDiagram[] {
  const gotoStates = stateSets.GOTO ?? [];
  const heldStates = stateSets.HELD ?? [];
  const allStates = Array.from(new Set([...gotoStates, ...heldStates]));

  const transitions: QuintTransition[] = [];

  // Parse startedWith entry transitions from firstState / startedWith
  if (/action\s+startedWith/.test(clean)) {
    transitions.push({ from: "setup", to: "interviewing", label: "started (interactive, light/heavy)" });
    transitions.push({ from: "setup", to: "planning", label: "started (auto, heavy)" });
    transitions.push({ from: "setup", to: "developing", label: "started (auto light / hack)" });
  }

  // Parse pure def frontMove branches
  const frontMoveStart = clean.indexOf("pure def frontMove");
  const afterToolStart = clean.indexOf("pure def afterTool");
  if (frontMoveStart !== -1 && afterToolStart !== -1) {
    const frontBody = clean.slice(frontMoveStart, afterToolStart);
    if (/state == "interviewing" and tool == "interview"/.test(frontBody)) {
      transitions.push({ from: "interviewing", to: "planning", label: "interview (heavy)" });
      transitions.push({ from: "interviewing", to: "developing", label: "interview (light)" });
    }
    if (/state == "planning" and tool == "finishedPlan"/.test(frontBody)) {
      transitions.push({ from: "planning", to: "developing", label: "finishedPlan" });
      transitions.push({ from: "planning", to: "blocked", label: "finishedPlan (needs sign-off)" });
    }
    if (/state == "developing" and tool == "finishedDevelopment"/.test(frontBody)) {
      transitions.push({ from: "developing", to: "reviewing", label: "finishedDevelopment (light/heavy)" });
    }
    if (/state == "developing" and tool == "finishedHacking"/.test(frontBody)) {
      transitions.push({ from: "developing", to: "hardening", label: "finishedHacking (hack)" });
    }
    if (/state == "hardening" and tool == "finishedDevelopment"/.test(frontBody)) {
      transitions.push({ from: "hardening", to: "reviewing", label: "finishedDevelopment" });
    }
  }

  // Parse pure def afterTool branches
  const skipTargetStart = clean.indexOf("pure def skipTarget");
  if (afterToolStart !== -1) {
    const afterBody =
      skipTargetStart !== -1 ? clean.slice(afterToolStart, skipTargetStart) : clean.slice(afterToolStart);

    if (/tool == "finishedReview" and state == "reviewing"/.test(afterBody)) {
      transitions.push({ from: "reviewing", to: "ci", label: "finishedReview" });
    }
    if (/tool == "finishedChecks"/.test(afterBody)) {
      transitions.push({ from: "ci", to: "smoke", label: "finishedChecks (smoke due)" });
      transitions.push({ from: "ci", to: "finishing", label: "finishedChecks (no smoke)" });
    }
    if (/tool == "finishedSmoke" and state == "smoke"/.test(afterBody)) {
      transitions.push({ from: "smoke", to: "finishing", label: "finishedSmoke" });
    }
    if (/tool == "finishedRevision" and state == "revising"/.test(afterBody)) {
      transitions.push({ from: "revising", to: "ci", label: "finishedRevision" });
    }
    if (/tool == "done" and state == "finishing"/.test(afterBody)) {
      transitions.push({ from: "finishing", to: "done", label: "done (clean)" });
      transitions.push({ from: "finishing", to: "revising", label: "done (feedback)" });
    }
    if (/state == "done" and f\.prOpen/.test(afterBody)) {
      transitions.push({ from: "done", to: "ci", label: "checkpoint (PR open)" });
    }
    if (/state == "smoke" or state == "finishing"/.test(afterBody)) {
      transitions.push({ from: "smoke", to: "ci", label: "checkpoint (code change)" });
      transitions.push({ from: "finishing", to: "ci", label: "checkpoint (code change)" });
    }
    if (/tool == "followUpThisAgent"/.test(afterBody)) {
      transitions.push({ from: "reviewing", to: "developing", label: "followUpThisAgent" });
      transitions.push({ from: "ci", to: "developing", label: "followUpThisAgent" });
    }
    if (/tool == "unblocked"/.test(afterBody)) {
      transitions.push({ from: "blocked", to: "developing", label: "unblocked (restores previous)" });
    }
    if (/tool == "waitEnded"/.test(afterBody)) {
      transitions.push({ from: "wait", to: "ci", label: "waitEnded (restores previous)" });
    }
  }

  if (/action\s+startedAfterDone/.test(clean)) {
    transitions.push({ from: "done", to: "revising", label: "revisit / startedAfterDone (feedback or conflict)" });
  }

  if (/tool == "blocked" or tool == "wait"/.test(clean)) {
    transitions.push({ from: "ci", to: "wait", label: "wait (from any active state)" });
  }

  const coreDiagram: QuintDiagram = {
    id: "issue-workflow",
    title: "Issue workflow state machine",
    description:
      "Derived directly from `startedWith`, `frontMove`, `afterTool` and `startedAfterDone` in `models/workflow/issue_workflow.qnt`. Covers `light`, `heavy` and `hack` modes.",
    states: allStates,
    transitions,
    mermaid: renderStateDiagram(allStates, transitions, {
      startStates: ["setup"],
      endStates: ["done"],
      classes: {
        start: ["setup"],
        work: ["interviewing", "planning", "developing", "hardening"],
        verify: ["reviewing", "ci", "smoke", "finishing"],
        revise: ["revising"],
        done: ["done"],
        stop: ["blocked"],
        hold: ["wait"],
      },
    }),
  };

  // Mode-specific simplified diagrams extracted from the same transition set
  const modeDiagrams: QuintDiagram[] = [];
  const modes = stateSets.MODES ?? [];
  if (modes.includes("light") && modes.includes("heavy") && modes.includes("hack")) {
    const lightTransitions = transitions.filter(
      (t) =>
        t.from !== "planning" &&
        t.to !== "planning" &&
        t.from !== "hardening" &&
        t.to !== "hardening" &&
        !(t.label.includes("heavy") && !t.label.includes("light")) &&
        !(t.label.includes("hack") && !t.label.includes("light")),
    );
    modeDiagrams.push({
      id: "issue-workflow-light",
      title: "Light mode path",
      description:
        "Verified by the `lightNeverPlans` invariant in module `light`: skips `planning` and `hardening`.",
      states: allStates.filter((s) => s !== "planning" && s !== "hardening"),
      transitions: lightTransitions,
      mermaid: renderStateDiagram(
        allStates.filter((s) => s !== "planning" && s !== "hardening"),
        lightTransitions,
        {
          startStates: ["setup"],
          endStates: ["done"],
          classes: {
            start: ["setup"],
            work: ["interviewing", "developing"],
            verify: ["reviewing", "ci", "smoke", "finishing"],
            revise: ["revising"],
            done: ["done"],
            stop: ["blocked"],
            hold: ["wait"],
          },
        },
      ),
    });
  }

  return [coreDiagram, ...modeDiagrams];
}

export function parseQuintModel(source: string, sourcePath: string): QuintModelDoc {
  const clean = stripComments(source);
  const modMatch = /^\s*module\s+([a-zA-Z0-9_]+)\s*\{/m.exec(clean);
  const moduleName = modMatch ? modMatch[1] : path.basename(sourcePath, ".qnt");
  const slug = moduleName.replace(/_/g, "-");

  const stateSets = parseStateSets(clean);
  const variables = parseVariables(clean);
  const instances = parseInstances(clean, moduleName);
  const namedVals = parseNamedVals(clean);
  const actions = parseActions(clean);

  const safetyNames = parseGroupMembers(clean, "safety");
  const findingNames = parseGroupMembers(clean, "findings");
  const invariants: QuintInvariant[] = [
    ...safetyNames.map((name) => ({
      name,
      kind: "safety" as const,
      expression: namedVals.get(name) ?? name,
    })),
    ...findingNames.map((name) => ({
      name,
      kind: "finding" as const,
      expression: namedVals.get(name) ?? name,
    })),
  ];

  const witnesses = parseWitnesses(clean);

  const diagrams: QuintDiagram[] = [];
  if (stateSets.PHASES) {
    diagrams.push(...extractEpicDiagrams(clean, stateSets, actions));
  }
  if (clean.includes("pure def afterTool") || clean.includes("pure def frontMove")) {
    diagrams.push(...extractIssueWorkflowDiagrams(clean, stateSets));
  }

  return {
    slug,
    moduleName,
    sourcePath,
    instances,
    stateSets,
    variables,
    invariants,
    witnesses,
    diagrams,
  };
}

export function loadQuintModels(repoRoot: string): QuintModelDoc[] {
  const workflowDir = path.join(repoRoot, "models", "workflow");
  if (!fs.existsSync(workflowDir)) return [];
  const files = fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith(".qnt") && !name.endsWith("_test.qnt"))
    .sort();

  return files.map((file) => {
    const abs = path.join(workflowDir, file);
    const rel = path.posix.join("models", "workflow", file);
    return parseQuintModel(fs.readFileSync(abs, "utf8"), rel);
  });
}
