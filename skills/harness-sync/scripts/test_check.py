"""Tests for check.py. Run: python3 -m unittest test_check (from this folder)."""

from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

import check


def write(root: Path, rel: str, text: str = "") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(root: Path) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = check.main(["check.py", str(root)])
    return code, out.getvalue(), err.getvalue()


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for tree in (".claude/skills", ".agents/skills"):
            write(self.root, f"{tree}/alpha/SKILL.md", "---\nname: alpha\n---\nbody\n")
        write(self.root, "CLAUDE.md", "Load `alpha` first.\n")
        write(self.root, "AGENTS.md", "Load `alpha` first.\n")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_agreeing_trees_pass(self) -> None:
        code, out, _ = run(self.root)
        self.assertEqual(code, 0, out)
        self.assertIn("1 skills compared", out)

    def test_skill_in_one_tree_only_is_a_difference(self) -> None:
        write(self.root, ".claude/skills/beta/SKILL.md", "---\nname: beta\n---\n")
        code, out, _ = run(self.root)
        self.assertEqual(code, 1)
        self.assertIn("beta: in .claude/skills, not in .agents/skills", out)

    def test_policy_in_one_notation_only_is_a_difference(self) -> None:
        write(self.root, ".agents/skills/alpha/agents/openai.yaml",
              "policy:\n  allow_implicit_invocation: false\n")
        code, out, _ = run(self.root)
        self.assertEqual(code, 1)
        self.assertIn("alpha: Codex refuses it, Claude does not", out)
        write(self.root, ".claude/skills/alpha/SKILL.md",
              "---\nname: alpha\ndisable-model-invocation: true\n---\n")
        self.assertEqual(run(self.root)[0], 0)

    def test_instruction_files_name_different_skills(self) -> None:
        write(self.root, "AGENTS.md", "No skills named here. `not-a-skill` is code.\n")
        code, out, _ = run(self.root)
        self.assertEqual(code, 1)
        self.assertIn("alpha: named in CLAUDE.md, not in AGENTS.md", out)
        self.assertNotIn("not-a-skill", out)

    def test_claude_md_that_imports_agents_md_agrees(self) -> None:
        write(self.root, "CLAUDE.md", "@AGENTS.md\n")
        write(self.root, "AGENTS.md", "Load `alpha`.\n")
        self.assertEqual(run(self.root)[0], 0)

    def test_agents_absent_on_both_sides_agree(self) -> None:
        self.assertEqual(run(self.root)[0], 0)

    def test_agent_on_one_side_only_is_a_difference(self) -> None:
        write(self.root, ".claude/agents/reviewer.md", "x")
        code, out, _ = run(self.root)
        self.assertEqual(code, 1)
        self.assertIn("reviewer: .claude/agents/reviewer.md has no .codex/agents/reviewer.toml", out)

    def test_unfetched_submodule_cannot_compare(self) -> None:
        (self.root / ".claude/agents").mkdir(parents=True)
        write(self.root, ".codex/agents/reviewer.toml", "x")
        write(self.root, ".gitmodules", '[submodule "a"]\n\tpath = .claude/agents\n')
        code, _, err = run(self.root)
        self.assertEqual(code, 2)
        self.assertIn("git -C", err)
        self.assertIn("submodule update --init .claude/agents", err)

    def test_missing_skill_tree_cannot_compare(self) -> None:
        for path in sorted((self.root / ".agents").rglob("*"), reverse=True):
            path.unlink() if path.is_file() else path.rmdir()
        code, _, err = run(self.root)
        self.assertEqual(code, 2)
        self.assertIn(".agents/skills", err)

    def test_empty_skill_tree_cannot_compare(self) -> None:
        (self.root / ".agents/skills/alpha/SKILL.md").unlink()
        self.assertEqual(run(self.root)[0], 2)

    def test_missing_repo_cannot_compare(self) -> None:
        self.assertEqual(run(self.root / "nope")[0], 2)


if __name__ == "__main__":
    unittest.main()
