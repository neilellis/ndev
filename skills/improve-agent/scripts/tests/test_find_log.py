"""Check log selection through the standalone command. Run: python3 tests/test_find_log.py"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "find_log.py"


def git(*args: str) -> None:
    subprocess.run(["git", *args], check=True, capture_output=True)


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)


class FindLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.outside = root
        self.repo = root / "repo"
        self.external = root / "external"
        git("init", "-q", str(self.repo))
        git("-C", str(self.repo), "-c", "user.name=Test", "-c", "user.email=test@example.test",
            "commit", "-qm", "init", "--allow-empty")
        for name in ("old", "new"):
            git("-C", str(self.repo), "worktree", "add", "-q", "--detach", str(self.repo / ".worktrees" / name))
        git("-C", str(self.repo), "worktree", "add", "-q", "--detach", str(self.external))
        for path, size, mtime in (
            (self.repo / ".worktrees/old/runs/old/.log/judge.log", 900, 1),
            (self.repo / ".worktrees/old/runs/old/.log/reviewer.log", 900, 2),
            (self.repo / ".worktrees/new/runs/a/.log/judge.log", 20, 3),
            (self.external / "runs/b/judge.log", 4, 4),
            (self.repo / "runs/base/.log/judge.log", 2, 2),
            (self.repo / "runs/empty/judge.log", 0, 9),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x" * size)
            os.utime(path, ns=(mtime * 1_000_000_000, mtime * 1_000_000_000))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_newest_non_empty_log_wins_across_worktrees(self) -> None:
        result = run("judge", "--repo", str(self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        selected = json.loads(result.stdout)
        self.assertEqual(selected["relative_path"], "runs/b/judge.log")
        self.assertEqual(Path(selected["worktree"]), self.external.resolve())
        # Nested worktree logs are counted once, under their own worktree.
        self.assertEqual(selected["matching_nonempty_logs"], 4)

    def test_other_agent_is_selected_by_name(self) -> None:
        result = run("reviewer", "--repo", str(self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["relative_path"], "runs/old/.log/reviewer.log")

    def test_explicit_worktree_does_not_widen(self) -> None:
        missing = run("reviewer", "--repo", str(self.repo), "--worktree", str(self.repo / ".worktrees/new"))
        self.assertEqual(missing.returncode, 1)
        self.assertIn("No non-empty log for agent 'reviewer'", missing.stderr)
        base = run("judge", "--repo", str(self.repo), "--worktree", str(self.repo))
        self.assertEqual(base.returncode, 0, base.stderr)
        self.assertEqual(json.loads(base.stdout)["relative_path"], "runs/base/.log/judge.log")

    def test_pattern_limits_the_layout(self) -> None:
        result = run("judge", "--repo", str(self.repo), "--pattern", "runs/*/.log/{agent}.log")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["relative_path"], "runs/a/.log/judge.log")

    def test_pattern_without_agent_is_refused(self) -> None:
        result = run("judge", "--repo", str(self.repo), "--pattern", "**/*.log")
        self.assertEqual(result.returncode, 2)
        self.assertIn("{agent}", result.stderr)

    def test_unregistered_worktree_fails(self) -> None:
        result = run("judge", "--repo", str(self.repo), "--worktree", str(self.outside))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("Not a registered worktree", result.stderr)

    def test_not_a_repo_fails(self) -> None:
        plain = self.outside / "plain"
        plain.mkdir()
        result = run("judge", "--repo", str(plain))
        self.assertEqual(result.returncode, 2)
        self.assertIn("git worktree list failed", result.stderr)

    def test_invalid_agent_fails(self) -> None:
        result = run("../judge", "--repo", str(self.repo))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("agent", result.stderr)


if __name__ == "__main__":
    unittest.main()
