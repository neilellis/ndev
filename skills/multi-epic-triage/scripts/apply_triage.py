#!/usr/bin/env python3
import argparse, json, subprocess, sys
from pathlib import Path

FATES = {"COMPLETED": ("completed", "completed"), "WONTFIX": ("not planned", "wontfix"),
         "SUPERSEDED": ("not planned", "superseded"), "DUPLICATE": ("duplicate", "duplicate")}


def load(d):
    ns = {}
    for f in ("plan.py", "notes.py"):
        p = d / f
        if p.exists():
            exec(p.read_text(), ns)
    return ns


def gh(args, dry):
    if dry:
        print("DRY gh", " ".join(args))
        return ""
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"FAILED gh {' '.join(args[:3])}: exit {r.returncode}: {r.stderr.strip()}")
    return r.stdout


def close(repo, d, ns, dry):
    log = (d / "close-log.txt").open("a")
    for name, (reason, _) in FATES.items():
        for n, why in ns.get(name, {}).items():
            gh(["issue", "close", str(n), "-R", repo, "--reason", reason, "--comment", why], dry)
            log.write(f"OK close {n} {name}\n")


def notes(repo, d, ns, dry):
    for n, text in ns.get("NOTES", {}).items():
        gh(["issue", "comment", str(n), "-R", repo, "--body", text], dry)


def issue_id(repo, n):
    return json.loads(gh(["api", f"repos/{repo}/issues/{n}"], False))["id"]


def epics(repo, d, ns, dry):
    path = d / "epics.json"
    E = json.loads(path.read_text())
    for e in E.values():
        if not e.get("num"):
            body = f"Area epic. Blast radius: {e['radius']}"
            out = gh(["issue", "create", "-R", repo, "--title", f"Epic: {e['name']}", "--body", body, "--label", "epic"], dry)
            e["num"] = int(out.strip().rsplit("/", 1)[-1]) if out else None
        for k in e["kids"] if isinstance(e["kids"], list) else []:
            if isinstance(k, int) and e["num"]:
                sid = "<id>" if dry else issue_id(repo, k)
                gh(["api", "-X", "POST", f"repos/{repo}/issues/{e['num']}/sub_issues",
                    "-F", f"sub_issue_id={sid}", "-F", "replace_parent=true"], dry)
    if not dry:
        path.write_text(json.dumps(E, indent=1))


def labels(repo, d, ns, dry):
    for n, kind in ns.get("T", {}).items():
        labs = [kind] + [fate for name, (_, fate) in FATES.items() if n in ns.get(name, {})]
        gh(["issue", "edit", str(n), "-R", repo, "--add-label", ",".join(labs)], dry)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("action", choices=["close", "notes", "epics", "labels"])
    a.add_argument("--repo", required=True)
    a.add_argument("--dir", default=".triage")
    a.add_argument("--dry-run", action="store_true")
    o = a.parse_args()
    d = Path(o.dir)
    globals()[o.action](o.repo, d, load(d), o.dry_run)


if __name__ == "__main__":
    main()
