#!/usr/bin/env python3
"""Dump a GitHub issue or PR to one markdown file + download its images.

Collapses an issue (or PR) — title, metadata, body, every comment, and for a PR
the diff — into a single markdown file, and downloads every inline / attached
image into a sibling `images/` dir (rewriting the markdown links to point at the
local copies). Then it prints the two paths so the *calling LLM* can Read the
markdown and view the images, instead of paying to page through `gh` output and
un-viewable attachment URLs.

    dump.py issue <n> [--out DIR] [--repo OWNER/REPO]
    dump.py pr    <n> [--out DIR] [--repo OWNER/REPO]

Only declared images are downloaded — markdown `![](url)` and HTML `<img src>`.
Other attachments (PDF/zip/…) stay as links in the markdown, not downloaded.
Used by the `github` skill — see skills/github/SKILL.md in this plugin.
"""
import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse



logger = logging.getLogger(__name__)


def _env():
    # GH_USE_KEYRING=1 drops GITHUB_TOKEN so the gh keyring login is used (see lib.sh).
    e = dict(os.environ)
    if e.get("GH_USE_KEYRING") == "1":
        e.pop("GITHUB_TOKEN", None)
    # The IDE forces colour for interactive tools. gh's captured JSON and diff
    # must stay plain, without changing the calling terminal's environment.
    e.pop("FORCE_COLOR", None)
    e.pop("CLICOLOR_FORCE", None)
    e["NO_COLOR"] = "1"
    return e


GH_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gh.sh")


def gh_json(args, repo=None):
    """Run a gh.sh command (the gh command first, REST when it fails) and return its output."""
    env = _env()
    if repo:
        env["GH_REPO"] = repo
    r = subprocess.run(["bash", GH_SH, *args], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        sys.exit(f"gh.sh {' '.join(args)} failed ({r.returncode}): {r.stderr.strip()}\n"
                 "Repair: check the number and run 'gh auth status'; pass --repo OWNER/REPO if needed.")
    return r.stdout


def default_repo():
    if os.environ.get("GH_REPO"):
        return os.environ["GH_REPO"]
    return json.loads(gh_json(["repo"]))["repo"]


def gh_token():
    r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, env=_env())
    return r.stdout.strip()


IMG_MD = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)")
IMG_HTML = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.I)

IGNORED_HOST_SUFFIXES = (
    "shields.io",
    "badgen.net",
    "badge.fury.io",
    "codecov.io",
    "coveralls.io",
    "snyk.io",
    "sonarcloud.io",
    "david-dm.org",
    "nodei.co",
    "gravatar.com",
    "avatars.githubusercontent.com",
    "blacksmith.sh",
    "vercel.sh",
    "codacy.com",
    "fossa.com",
)

BOT_LOGINS = {
    "vercel",
    "codesmith",
    "blacksmith",
    "github-actions",
    "codecov",
    "dependabot",
    "renovate",
    "snyk-bot",
    "linear",
    "netlify",
}


def is_bot_author(author):
    if not author:
        return False
    login = author.get("login", "") if isinstance(author, dict) else str(author)
    login_clean = login.lower().removeprefix("@")
    if login_clean.endswith("[bot]") or login_clean.endswith("-bot"):
        return True
    return login_clean in BOT_LOGINS


def is_ignored_image(url):
    try:
        p = urllib.parse.urlparse(url)
    except ValueError as exc:
        # Treated as ignorable, so the image is silently left out of the dump.
        print(f"WARNING: cannot parse image URL {url!r}, it is skipped — {exc}",
              file=sys.stderr)
        return True
    host = (p.hostname or "").lower()
    path = (p.path or "").lower()
    query = (p.query or "").lower()

    if any(host == s or host.endswith("." + s) for s in IGNORED_HOST_SUFFIXES):
        return True

    # Vercel static assets, status icons, avatar API
    if host in {"vercel.com", "www.vercel.com"}:
        if path.startswith("/static/") or path.startswith("/api/"):
            return True

    # Avatars from any provider
    if "avatar" in path or "avatar" in query:
        return True

    # Badges & status shields
    if path.endswith(".svg") and "badge" in path:
        return True
    if "/badge/" in path or "/badges/" in path:
        return True
    if "badge" in path and any(k in path for k in ("shield", "workflow", "status", "build")):
        return True

    # Generic placeholders
    if "placeholder" in path:
        return True

    return False


def clean_markdown_text(text):
    if not text:
        return ""
    # Strip codesmith and known bot footer blocks
    text = re.sub(
        r"<!--\s*codesmith:footer\s*-->.*?<!--\s*/codesmith:footer\s*-->",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    text = re.sub(
        r"<!--\s*(?:codesmith|blacksmith|vercel|github-actions)[^>]*-->.*?<!--\s*/(?:codesmith|blacksmith|vercel|github-actions)[^>]*-->",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    text = re.sub(r"<!--\s*codesmith:[^>]*-->", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<!--\s*/codesmith:[^>]*-->", "", text, flags=re.IGNORECASE)

    # Strip Blacksmith / Codesmith / Vercel action links, SVGs and badges
    text = re.sub(
        r"<a\s+href=[\"']https://(?:app|backend)\.blacksmith\.sh/[^\"']*[\"'][^>]*>.*?</a>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    text = re.sub(
        r"<a\s+href=[\"']https://vercel\.com/(?:vercel-agent/)?request-review[^\"']*[\"'][^>]*>.*?</a>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    text = re.sub(
        r"<picture>.*?https://(?:pr-comments-assets\.blacksmith\.sh|agents-vade-review\.vercel\.sh)[^>]*</picture>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    text = re.sub(r"<sup>\s*Need help on this PR\?.*?</sup>", "", text, flags=re.DOTALL | re.IGNORECASE)

    # Strip [vc]: #... lines
    text = re.sub(r"\[vc\]:\s*#[^\r\n]+", "", text)

    # Strip redundant trailing horizontal rules and multiple blank lines
    text = re.sub(r"(\r?\n\s*---\s*)+\Z", "", text)
    text = re.sub(r"(\r?\n\s*---\s*){2,}", "\n---\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_noise_comment(author, body):
    if not author:
        return False
    login = author.get("login", "") if isinstance(author, dict) else str(author)
    login_clean = login.lower().removeprefix("@")

    # Noise bot accounts whose automated comments provide no review/task substance
    if login_clean in {"vercel", "codesmith", "blacksmith", "codecov", "snyk-bot", "netlify"}:
        return True

    # General bot check for deployment/CI summaries
    if login_clean.endswith("[bot]") or login_clean.endswith("-bot"):
        if "[vc]: #" in body or "Skipped Deployments" in body or "vercel.link/github-learn-more" in body:
            return True
        if "The latest updates on your projects" in body:
            return True
        cleaned = clean_markdown_text(body)
        if not cleaned:
            return True

    return False


def find_images(text):
    text = clean_markdown_text(text or "")
    seen, urls = set(), []
    for m in list(IMG_MD.finditer(text)) + list(IMG_HTML.finditer(text)):
        u = m.group(1)
        if u.startswith("http") and not is_ignored_image(u) and u not in seen:
            seen.add(u)
            urls.append(u)
    return urls


_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"BM", "bmp"),
]


def sniff(path):
    """Return a file extension if `path` is really an image, else None (e.g. an
    HTML login page or a 404 body that curl still wrote)."""
    with open(path, "rb") as f:
        head = f.read(64)
    for sig, ext in _MAGIC:
        if head.startswith(sig):
            return ext
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    s = head.lstrip()[:5].lower()
    if s.startswith(b"<?xml") or s.startswith(b"<svg"):
        return "svg"
    return None


def download(url, dest, token):
    # curl sends auth to github.com on the first hop and strips it on the
    # cross-host redirect to the signed S3 URL — exactly what private
    # user-attachments need. --fail turns a 4xx/5xx into a non-zero exit.
    cmd = ["curl", "-sSL", "--fail", "--max-time", "60"]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    cmd += [url, "-o", dest]
    return subprocess.run(cmd, capture_output=True, text=True).returncode == 0


def out_dir(kind, n, explicit):
    logger.debug("Choosing an output directory for %s %s", kind, n)
    if explicit:
        os.makedirs(explicit, exist_ok=True)
        return explicit
    base = os.environ.get("CLAUDE_JOB_DIR")  # bg jobs: keep temp off shared /tmp
    base = os.path.join(base, "tmp") if base else None
    if base:
        os.makedirs(base, exist_ok=True)
    return tempfile.mkdtemp(prefix=f"gh-{kind}-{n}-", dir=base)


class Images:
    """Downloads images on demand, rewrites text to local paths, tracks results."""

    def __init__(self, dest, token):
        self.dir = os.path.join(dest, "images")
        self.token = token
        self.n = 0
        self.saved = []   # (localname, url, origin)
        self.failed = []  # (url, origin)

    def process(self, text, origin):
        urls = find_images(text)
        logger.info("Downloading %d images found in %s", len(urls), origin)
        for url in urls:
            self.n += 1
            tmp = os.path.join(self.dir, f".tmp-{self.n}")
            os.makedirs(self.dir, exist_ok=True)
            ext = sniff(tmp) if download(url, tmp, self.token) else None
            if ext:
                name = f"{self.n:02d}-{origin}.{ext}"
                os.replace(tmp, os.path.join(self.dir, name))
                self.saved.append((name, url, origin))
                text = text.replace(url, f"images/{name}")
            else:
                if os.path.exists(tmp):
                    os.remove(tmp)
                self.failed.append((url, origin))
        return text


def _person(d):
    return "@" + d["login"] if d and d.get("login") else "(unknown)"


def _meta_lines(d, kind):
    labels = ", ".join(label["name"] for label in d.get("labels", [])) or "—"
    assignees = ", ".join(_person(a) for a in d.get("assignees", [])) or "—"
    ms = (d.get("milestone") or {})
    return [
        f"- **{kind} URL:** {d.get('url')}",
        f"- **State:** {d.get('state')}",
        f"- **Author:** {_person(d.get('author'))}",
        f"- **Assignees:** {assignees}",
        f"- **Labels:** {labels}",
        f"- **Milestone:** {ms.get('title') or '—'}",
        f"- **Created:** {d.get('createdAt')}",
        f"- **Updated:** {d.get('updatedAt')}",
    ]


def build_markdown(d, kind, imgs, diff=None):
    n, title = d["number"], d["title"]
    raw_body = d.get("body") or "_(no description)_"
    cleaned_body = clean_markdown_text(raw_body)
    body = imgs.process(cleaned_body or "_(no description)_", "body")
    out = [f"# {kind} #{n}: {title}", "", *_meta_lines(d, kind), "", "---", "",
           "## Description", "", body, ""]
    raw_comments = d.get("comments", []) or []
    comments = [c for c in raw_comments if not is_noise_comment(c.get("author"), c.get("body") or "")]
    out += ["---", "", f"## Comments ({len(comments)})", ""]
    for i, c in enumerate(comments, 1):
        author = c.get("author")
        c_body = clean_markdown_text(c.get("body") or "")
        if not c_body:
            continue
        if is_bot_author(author):
            ctext = c_body
        else:
            ctext = imgs.process(c_body, f"comment{i}")
        out += [f"### {_person(author)} — {c.get('createdAt')}", "", ctext, ""]
    if diff is not None:
        out += ["---", "", "## Diff", "", "```diff", diff.rstrip(), "```", ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("kind", choices=["issue", "pr"])
    ap.add_argument("number", type=int)
    ap.add_argument("--out", help="output dir (default: a fresh temp dir)")
    ap.add_argument("--repo", help="OWNER/REPO (default: GH_REPO, else the current checkout)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    a.repo = a.repo or default_repo()
    logger.info("Reading %s %d from %s", a.kind, a.number, a.repo)

    fields = "number,title,state,author,assignees,labels,milestone,createdAt,updatedAt,url,body,comments"
    view = "issue" if a.kind == "issue" else "pr"
    data = json.loads(gh_json(["view-json", view, str(a.number), "--fields", fields], a.repo))

    diff = None
    if a.kind == "pr":
        diff = gh_json(["pr-diff", str(a.number)], a.repo)

    dest = out_dir(a.kind, a.number, a.out)
    imgs = Images(dest, gh_token())
    md = build_markdown(data, "PR" if a.kind == "pr" else "Issue", imgs, diff)

    md_path = os.path.join(dest, f"{a.kind}-{a.number}.md")
    with open(md_path, "w") as f:
        f.write(md)

    print(f"MARKDOWN: {md_path}")
    print(f"IMAGES_DIR: {imgs.dir}  ({len(imgs.saved)} saved, {len(imgs.failed)} failed)")
    for name, url, origin in imgs.saved:
        print(f"  saved  images/{name}  <- {url}  ({origin})")
    for url, origin in imgs.failed:
        print(f"  FAILED {url}  ({origin}) — not an image or unreachable")


if __name__ == "__main__":
    main()
