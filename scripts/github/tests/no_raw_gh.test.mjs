// Guard: code reaches GitHub only through scripts/github/gh.sh (the gh command first, REST when it fails).
// A raw `gh ...` call in code under hooks/, scripts/ or skills/ is a finding unless it is in EXCEPTIONS.
// Prompt text (SKILL.md and other markdown) and tests are not scanned.
//
// Proof both ways: a temp file with a raw call must produce a finding, a clean temp file must not,
// and the scan must have read many files (an empty scan would pass for the wrong reason).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCAN_DIRS = ["hooks", "scripts", "skills"];
const CODE = /\.(sh|py|mjs|js|ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", "__pycache__"]);
const ALLOWED_FILES = new Set(["scripts/github/gh.sh", "scripts/github/lib.sh"]);
const MIN_FILES = 40;

// A raw call is gh in command position in shell (after a line start, a pipe, `$(`, `&&`, `then` and so on),
// or gh as the program in a spawn or subprocess list in any other language. Message text that mentions
// "gh pr ready" is not a call, so a bare `gh` after a space inside a string does not count.
const SUB = "(?:api|pr|issue|run|repo|release|auth|search|label|workflow|project|status|browse|variable|secret|cache|gist|ruleset)";
const SHELL_RAW = new RegExp(`(?:^|[;&|(]|\\$\\(|\\b(?:if|then|do|else)\\s+!?|\\|\\||&&)\\s*(?:env\\s+-u\\s+\\w+\\s+)?(?:gh|GH)\\s+${SUB}\\b`);
const SPAWN_RAW = [/["']gh["']\s*,/, /["']gh["']\s*\]/, /\b(?:spawnSync|spawn|execFileSync|execFile|run|must)\(\s*["']gh["']/];

// Each exception names a file, a pattern that the offending line must contain, and the reason.
const EXCEPTIONS = [
  { file: "skills/cut-release/scripts/release.py", pattern: /"gh", \*args|\["gh", "release"|\["gh", "run", "watch"/, reason: "release *, run list and run watch have no gh.sh route" },
  { file: "skills/milestone-release/scripts/gh_release.sh", pattern: /\bGH\s+release\b|GH "\$\{args\[@\]\}"/, reason: "gh release view/edit/create have no gh.sh route" },
  { file: "skills/finish/scripts/finish.mjs", pattern: /"gh", \["run", "view"/, reason: "gh run view --log-failed has no REST equivalent" },
  { file: "skills/video-finish/scripts/finish.mjs", pattern: /"gh", \["run", "view"|gh run view/, reason: "gh run view --log-failed has no REST equivalent" },
  { file: "hooks/fix-all-prs.tsx", pattern: /\['gh', 'pr', 'view', String\(r\.number\), '--web'\]/, reason: "gh pr view --web opens the browser; gh.sh has no route for it. The hooks are another owner's files, left as they are" },
  { file: "hooks/triage.tsx", pattern: /\['gh', 'pr', 'view', String\(g\.pr\), '--repo', v\.repo!, '--web'\]/, reason: "gh pr view --web opens the browser; gh.sh has no route for it. The hooks are another owner's files, left as they are" },
  { file: "scripts/ndev/epic.mjs", pattern: /checked\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/ndev/fix-prs.mjs", pattern: /(?:json|checked)\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/ndev/project.mjs", pattern: /checked\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/ndev/triage.mjs", pattern: /checked\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/ndev/waits.mjs", pattern: /remoteJson\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/ndev/watch.mjs", pattern: /checked\('gh'/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "skills/multi-epic-triage/scripts/apply_triage.py", pattern: /subprocess\.run\(\["gh", \*args\]/, reason: "the ndev CLI module calls gh directly through its own checked helper and reports the failure with a repair; moving it to gh.sh is tracked in issue #192" },
  { file: "scripts/github/dump.py", pattern: /"gh", "auth", "token"/, reason: "gh auth * is a listed exception; it reads the token to fetch images" },
];

function isComment(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function findRaw(file, text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (isComment(line)) return;
    if (/command\s+-v\s+gh\b/.test(line)) return;
    const raw = file.endsWith(".sh") ? SHELL_RAW.test(line) : SPAWN_RAW.some((re) => re.test(line));
    if (raw) hits.push({ file, line: i + 1, text: line.trim() });
  });
  return hits;
}

function excepted(hit) {
  return EXCEPTIONS.some((e) => e.file === hit.file && e.pattern.test(hit.text));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (CODE.test(name)) out.push(full);
  }
  return out;
}

function scan() {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const hits = [];
  let read = 0;
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    if (ALLOWED_FILES.has(rel)) continue;
    read += 1;
    hits.push(...findRaw(rel, readFileSync(full, "utf8")));
  }
  return { read, hits };
}

test("the scan reads many files", () => {
  const { read } = scan();
  assert.ok(read >= MIN_FILES, `the scan read only ${read} files (expected at least ${MIN_FILES}); a broken walk would pass for the wrong reason`);
});

test("no raw gh call outside gh.sh, lib.sh and the listed exceptions", () => {
  const { hits } = scan();
  const bad = hits.filter((h) => !excepted(h));
  assert.deepEqual(
    bad.map((h) => `${h.file}:${h.line}: ${h.text}`),
    [],
    "Route these through scripts/github/gh.sh (add a command there if none fits), or add an entry with a reason to EXCEPTIONS in this test.",
  );
});

test("every exception still matches a line (a stale exception hides nothing)", () => {
  const { hits } = scan();
  for (const e of EXCEPTIONS) {
    assert.ok(hits.some((h) => h.file === e.file && e.pattern.test(h.text)), `exception for ${e.file} matches no line any more; remove it (${e.reason})`);
  }
});

test("a raw gh call in a temp file is a finding, a gh.sh call is not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "no-raw-gh-"));
  try {
    const samples = {
      "a.sh": 'x=$(gh api repos/o/r)\n',
      "b.sh": 'GH pr view 3\n',
      "c.py": 'subprocess.run(["gh", "pr", "list"])\n',
      "d.mjs": 'run("gh", ["pr", "view"]);\n',
      "e.sh": 'if ! out=$(GH api -X POST repos/o/r); then\n',
    };
    for (const [name, text] of Object.entries(samples)) {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      assert.equal(findRaw(name, readFileSync(file, "utf8")).length, 1, `${name} should be a finding`);
    }
    const clean = ['die 1 "Repair: gh pr ready 4"', '"$GHSH" pr-read 3', "command -v gh >/dev/null", "# gh pr view is the old way", 'bash gh.sh api repos/o/r', 'echo "gh.sh failed"'].join("\n");
    assert.deepEqual(findRaw("clean.sh", clean), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
