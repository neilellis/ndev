# ndev

The software factory: one place for the development procedures that repeat in every project.
It is a Claude Code plugin. It holds the methodology, the workflow skills, the subagents and a
knowledge base. A project enables the plugin and gets all of them.

## What is in it

| Path | Contents |
|---|---|
| `kb/` | The methodology as a knowledge base. Start at [`kb/README.md`](kb/README.md). Core beliefs are in [`kb/core-beliefs.md`](kb/core-beliefs.md). |
| `skills/` | Workflow skills. A helper that only one skill uses stays in that skill's `scripts/` folder. |
| `scripts/` | Shared helper scripts that skills, agents and hooks call, grouped by area (`github/`, `board/`, `work/`, `docs/`, `wiki/`, `walk-doc/`). See [`scripts/README.md`](scripts/README.md). |
| `agents/` | Subagent definitions for board work, implementation, planning and review. |
| `templates/` | A starter `CLAUDE.md`, a starter LLM wiki, and the brand site that `/brand create` copies. |
| `kb/hooks/` | Reusable hook scripts and a pre-push hook to copy into a project. |

## Skills

Each skill is `ndev:<name>`. The table shows the first sentence of each skill's description; the skill's `SKILL.md` has the rest.

| Skill | What it does |
|---|---|
| `adversarial-review` | Run an independent adversarial review of a pull request: a fresh agent gets only the diff and the quoted plan row, runs six checks and tries to break the… |
| `archify` | Create polished, validated architecture, workflow, sequence, data-flow, and lifecycle/state diagrams as explorable standalone HTML with inline SVG,… |
| `are-we-done` | Check whether the current work is actually finished. |
| `ast-grep` | Search the codebase by parsed code shape. |
| `brand` | `/brand create` makes a full brand guide and design system site from the project and the plugin's defaults, in `apps/brand` or as a standalone app. `/brand check` reports where the project breaks its brand. `/brand apply` fixes it. |
| `clean-reader` | Review supplied documentation or video narration as a first-time reader, in a fresh Codex process that cannot read the application source. |
| `command-reuse` | Reuse tested commands for local checks, saved logs, PR waits, and session audits. |
| `copy` | Write or review user-visible copy: interface text, labels, errors, empty states, glossary definitions and accessible text. |
| `cut-release` | Cut a tagged GitHub release from the default branch. |
| `database` | Review schema changes, foreign keys, deletion behaviour and database integrity in the repository. |
| `deadcode` | Find unused Python and TypeScript names introduced by the current branch. |
| `dev-wiki` | Read and grow the living development wiki at ~/dev-wiki. |
| `diagram-design` | Create architecture, architecture delta, IT current-state, flowchart, sequence, state machine, ER/data model, timeline, swimlane, quadrant, radar/spider,… |
| `doc-coverage` | Audit gaps in project documentation by concept and audience, and refresh the project's documentation coverage report. |
| `docs` | Locate and maintain project documentation, wiki knowledge and human-facing explainers. |
| `docs-legibility` | Check and fix user-facing docs pages so a new reader understands them: plain English, short sentences, no unnecessary jargon, each necessary technical term… |
| `docs-sync` | Bring user-facing docs pages back in line with code or wiki changes, using a docs map in page front matter. |
| `docs-team` | Coordinate a hierarchy of agents (coordinator, unit leads, module writers, a diagram pass and fresh evaluators) that writes and audits a user-facing… |
| `finish` | Push the current change in a website or app project and keep fixing its pull request until it is green and ready for approval, with preview links to each changed page. |
| `fix-all-prs` | Fix and merge every outstanding open pull request one at a time, oldest first, working with the agents that already worked on each pull request. |
| `fix-ci` | Fix failed checks and merge conflicts on the associated pull request until its current revision is green and mergeable. |
| `for-codex` | Make this plugin's skills available to the OpenAI Codex CLI in one project, with symlinks into the Codex-only folder <project>/.codex/skills/. |
| `forget` | Remove documentation and memory claims that code proves false after a feature, path, decision or command is removed, renamed or superseded. |
| `github` | Operate GitHub issues, pull requests, checks, milestones, Actions runs and an optional project board through compact helper scripts. |
| `goal-work` | Work every open GitHub issue that matches a condition the user gives, through grouped, mergeable pull requests, with the user reviewing the plan and the… |
| `green-merge-open-prs` | Green and merge each eligible open pull request in number order, one at a time, into origin/main. |
| `harness-sync` | Compare the Claude and Codex harness trees and reconcile a difference between them, before or after any change that copies one skill tree onto the other. |
| `hotfix` | Do the requested work directly on the main branch in the main checkout, with no worktree and no pull request, then push to origin main. |
| `hyperfine` | Benchmark and compare command durations when a speed claim or before/after measurement is needed. |
| `i` | Alias of issue: create a GitHub issue from a description and put it in Backlog on the project board with its fields filled in. |
| `i-have-adhd` | Load before writing any reply to the user. |
| `implement-spec` | Implement a provided specification and its linked tickets on one branch and in one pull request. |
| `improve-agent` | Analyse an automated agent's run log and produce an evidence-based improvement plan for its prompt, skill, tools and guards. |
| `infographic` | Create raster infographic images with bundled layout and visual-style references. |
| `issue` | Create a GitHub issue from a short description, add it to the project board in Backlog, and fill in the issue and board fields that the description… |
| `milestone-release` | Publish a GitHub release from committed milestone release notes when the user explicitly asks to cut or publish it. |
| `milestone-release-notes` | Produce stakeholder-facing release notes for a GitHub milestone by reading all included issues and merged PRs. |
| `mobile-testing` | Capture and inspect the web app with Playwright mobile device emulation. |
| `motion` | Add animation and meaningful delight to a React or Next.js site: CSS first, then Motion, with library verdicts and reduced-motion support. |
| `perf-review` | Review a specified file or directory for performance risks in algorithms, I/O, allocations, database access and connection use. |
| `pick-up-prs` | Survey open pull requests, identify unfinished or blocked work, and continue each safely from its existing branch/worktree. |
| `project-analysis` | Perform a scored, evidence-backed architecture and product health review of the repository and append the run to the project's ratings file. |
| `publish` | Merge the current change's pull request in a website or app project and confirm the live site. |
| `r` | Alias of remember: record durable, non-obvious lessons from the session. |
| `react-grab` | Continuously receive React Grab selections and act on their attached user instructions when a watch loop is requested. |
| `remember` | Record durable, non-obvious lessons from the session in the correct project wiki, skill, guide or memory home. |
| `report-work-done` | Summarize what actually shipped by reading merged pull requests in a requested time window, optionally filtered by author. |
| `reset` | Close the current feature work, save it as a PR, remove its worktree, and freshen the base checkout; use --discard only to abandon a dead end. |
| `resolving-merge-conflicts` | Use when you need to resolve an in-progress git merge/rebase conflict. |
| `responsive-check` | Check a website's layout on phones, tablets and desktops, in light and dark mode, and report each defect with its element. Also maintains the breakpoint and layout rules on the brand site. |
| `retro` | Review a completed coding session and identify improvements to navigation, checks, standards, instructions, information access and tool economy. |
| `site-check` | Check a local, preview or live website for broken links, missing pages, server errors and JavaScript errors. |
| `testing` | Apply the testing taxonomy and verification rules across Python and TypeScript, including guard integrity and minimal live-system tests. |
| `ux-principles` | Apply the project's UX guidance to navigation, disclosure, touch, accessibility and feedback decisions. |
| `video-docs` | Keep documentation videos true to the documentation they cite: trace each scene to its source pages, detect stale sources, choose the smallest rebuild,… |
| `video-explainer` | Write and review an explainer video of 2 to 5 minutes that shows how something works and why it matters, with diagrams first. |
| `video-finish` | Push the current video change and keep fixing its pull request until it is green and mergeable, ready for approval, with preview links to each changed scene. |
| `video-how-to` | Write and review a how-to video that shows one task from start to a result the viewer can check, with the real product on screen. |
| `video-images` | Find, add, credit or remove the images in a video: product assets, diagrams and Unsplash photography with its credits. |
| `video-marketing` | Write and review a marketing film of about 60 seconds that tells a prospective client why to talk to you. |
| `video-narration` | Write or change a video's narration, voices, pronunciation, pacing or captions, then regenerate and check the voice. |
| `video-podcast-effect` | Explain or change the podcast effect that makes the synthetic narration sound like a person on a podcast mic: pause and pace jitter, room tone, EQ,… |
| `video-publish` | Merge the current video change's pull request and confirm the production deployment plays the video. |
| `video-render-review` | Render a video's stills and MP4, inspect them, show the user before-and-after comparisons and clips after each round of edits, and verify the final files. |
| `video-scenes` | Change what a video shows: layout, on-screen text, animation, colours, word cues, or adding, removing and reordering scenes on the film page. |
| `video-setup` | Set up the video kit in a project, start a new narrated video, update a project to the plugin's kit, or check that a project's copy of the kit is current. |
| `video-types` | Choose the type of a narrated video (how-to, explainer or marketing) and apply the rules every type shares. |
| `video-workflow` | Make any change to a narrated video built with the video kit, from the request to an approved pull request: classify the change, branch, edit, rebuild only… |
| `what-do-you-need` | State exactly what input or approval you need from the user as clear, numbered questions with brief background. |
| `wiki-lint` | Verify wiki structure, source citations and behavioural claims against the current repository, then repair documented drift. |
| `work-heavy` | The interactive heavyweight development skill (heavy mode). |
| `work-heavy-auto` | The non-interactive heavyweight development skill (heavy mode, auto steering). |
| `work-interactive` | Design an underspecified feature with the user, resolve assumptions and test entry points, then implement it or publish vertical-slice issues. |
| `work-light` | The interactive lightweight development skill (light mode, the default). |
| `work-light-auto` | The non-interactive lightweight development skill (light mode, auto steering). |

Shared scripts that the skills call are in `scripts/` (see `scripts/README.md`).

## Modes: light or heavy, interactive or auto

The plugin's hooks module adds two switches to each session. The status line shows them, for
example `dev: light · interactive`. The plugin adds a short section to the system prompt, so
Claude follows the selected workflow.

| Command | Values | Default | Effect |
|---|---|---|---|
| `/dev mode` | `light`, `heavy` | `light` | `light` uses the `work-light` skill for everyday coding: one owner, test first, a worktree, one PR. `heavy` uses the `work-heavy` skill for multi-step, cross-cutting or high-risk changes: a plan, staged verification and an independent review. |
| `/dev steering` | `interactive`, `auto` | `interactive` | `interactive`: a human steers. Claude confirms scope, asks about decisions that are the human's, and reports at checkpoints. `auto`: nobody steers. Claude chooses sensible defaults, records its assumptions in the PR, and stops only at a hard blocker. |

A command with no value toggles the switch. The older names `/dev-mode`, `/dev-steering` and
`/dev-setup` still work.

`/dev` lists the plugin's commands and shows the project's current settings. In a project that
has not answered the set-up questions yet, `/dev` runs the set-up dialog first. `/dev help`
always shows the help. `/dev setup` asks all the set-up questions again (the same as
`/dev-setup`).

## Per-project settings: `.neil-dev.json`

All the plugin's settings for a project live in one file at the project root, checked in with
the project. Every key is optional:

```json
{
  "mode": "light",
  "steering": "interactive",
  "github": { "repo": "acme/app", "board": { "owner": "acme", "number": 3 } },
  "branding": { "site": "https://brand.example", "name": "Acme", "guide": "https://brand.example/guide", "path": "apps/brand" },
  "quality": { }
}
```

- `mode` and `steering` set the switches at session start. With no file, a session starts at
  `light · interactive`. `/dev mode` and `/dev steering` write the new value back to the file;
  commit it to share it.
- `github` holds the project's GitHub repository and Projects v2 board, so no skill or script
  looks them up again. `null` means "none" (`"repo": null`, or `"board": null`). When a session
  starts in a project that has no `github` key, or no board, a set-up dialog asks for the
  missing values. It offers the git origin and the owner's boards. Choose an option, or type an
  answer under Other. An exact answer (`owner/name`, `3`, `owner/3`) is saved at once. A free
  answer ("the roadmap board") goes to an agent, which finds the value with `gh` and writes the
  key. "Ask me later" saves nothing, and the next session asks again. Run `/dev setup` (or `/dev-setup`) to answer
  all the questions again. With no one to ask (a non-interactive run), a message names
  `/dev-setup`. The scripts in `scripts/github/` and `scripts/board/` read these values. A value
  that is already in the environment (`GH_REPO`, `GH_PROJECT_OWNER`, `GH_PROJECT_NUMBER`) wins.
- `branding` names the brand that the docs, diagram, copy and video skills apply. With no
  `branding`, those skills do no branding and do not mention it. `path` is the brand site's source folder, which `/brand check` and `/brand apply` read.
- `quality` turns on the quality-control hooks one by one (see [`kb/hooks/README.md`](kb/hooks/README.md)).
  A hook that is not listed does not run.

The plugin checks the file at session start. A bad value or an unknown key shows a message that
names the file and the problem, and the file then has no effect until it is fixed. The plugin
does not write to a file that has an error.


The two switches pick the development skill:

| | interactive (a human steers) | auto (nobody steers) |
|---|---|---|
| **light** | `work-light` | `work-light-auto` |
| **heavy** | `work-heavy` | `work-heavy-auto` |

The `-auto` skills deliver issues from the GitHub board's Ready column (or one issue with
`--issue <n>`) through isolated PRs, and never merge. In auto steering, a task given straight in
the prompt with no issue follows the interactive skill's method without stopping to ask.
Older names: `work-light` was `light-work`, `work-heavy` was `work`, `work-light-auto` was
`work-ready-simple` and `work-heavy-auto` was `work-ready`.

## Private credentials: `.neil-dev.env`

The private keys for ndev skills go in `.neil-dev.env` at the project root. The file is git-ignored and has mode 600, with one `KEY=VALUE` on each line. A file that other users can read is refused.

| Key | Used for |
|---|---|
| `OPENROUTER_API_KEY` (or `OPEN_ROUTER_API_KEY`) | Speech for narration (video-narration, video-setup) |
| `OPENAI_API_KEY` | Word timings for narration (video-narration, video-setup) |
| `UNSPLASH_ACCESS_KEY` | Photographs (video-images, video-setup) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Protected Vercel previews (site-check) |
| Any key a project adds | For example the logins a walk-doc reader may use (walk-doc's `valuesFile` and `valueKeys`) |

`scripts/env/neil-dev-env.mjs` owns the file:

- `init [--key NAME]...` creates the file, or adds to it. It reads the exports in `~/.zshrc` as text and never runs it. It keeps the values already in the file and lists the keys that are missing.
- `status [--json]` and `check NAME...` report key names, never values.
- `import <file>` adds the `KEY=VALUE` lines of another file, such as a skill's older credentials file, without printing a value. It refuses a key that already has another value, and leaves the other file in place.
- `run --need A,B -- <command>` runs the command with the file's keys in its environment.

The file belongs to the main checkout. In a worktree, the first look for the file copies it from the main checkout, but only when git ignores the name there. `init` in a worktree first moves keys added to the copy into the main checkout file. It refuses when a key has a different value in the two files. A project that does not ignore `.neil-dev.env` gets no file: add the name to `.gitignore`, or to `info/exclude` in the git common folder.

At session start the plugin looks for the file and tells the agent where it is and which key names it sets. If the project has no file, the plugin asks once whether to create it from `~/.zshrc`. The agent never prints, reads or searches for a key.

## The pull request loop: /fix-prs

A second hooks module, `hooks/fix-all-prs.tsx`, runs the `fix-all-prs` method as a loop. It works
the open pull requests of the current repository one at a time, oldest first, and shows the queue
and each pull request's checks in a pane.

| Command | Effect |
| --- | --- |
| `/fix-prs start [--no-merge]` | Start the loop. `--no-merge` records a green pull request as ready and leaves the merge to a human. |
| `/fix-prs status` | Show where the loop is. |
| `/fix-prs pause`, `/fix-prs resume` | Stop and continue the loop. |
| `/fix-prs skip <pr>`, `/fix-prs retry <pr>` | Leave out a pull request, or put a blocked one back in the queue. |

The loop first asks the agent that owns a pull request to fix it. It looks for the owner in this
order:

- an agent named after the pull request (`pr-<n>`, `issue-<k>`);
- the listed session that signed its commits;
- the listed session in an Orca workspace of the pull request.

When no owner is found, or the owner is no longer listed, the loop starts a Claude agent in Orca
with the fix brief. It uses the pull request's Orca workspace, else a new `pr-<n>` workspace. A main
checkout is never the pull request's workspace. The loop asks the agent once a listed session runs
in that workspace. Until then it asks no other owner, so two agents never fix one branch. When the
agent is not listed within 30 minutes, or Orca cannot start an agent, the loop records the pull
request as blocked. The record gives Orca's output and the repair. When Orca cannot list its
workspaces, no agent starts: a session in one of them can own the pull request.

When an owner does not answer or is blocked, the loop gives the pull request to this session's
model. When the agents cannot be listed, the model gets it too, and no agent starts in Orca. An
owner found later then takes it over, and the loop tells the model to stop. The model reports the
result with the `report` tool (`mcp__ndev__report`): `pushed`, or `blocked` with the reason. The
tool refuses a report when the pull request is not with the model.

## Worktree init: scripts/init-project.sh

At session start, `hooks/init-project.ts` looks for `.ndev-inited` at the git root. When it is
absent (a new worktree or clone), the hook runs `scripts/init-project.sh`, which builds the project
from source. When the script exits 0, the hook writes `.ndev-inited`.

- `.ndev-inited` must be git-ignored. If it is not, the script does not run and a toast names the
  repair: `echo .ndev-inited >> .gitignore`.
- If the script does not exist, the agent is told to write it, run it and commit it.
- If the script fails, the agent gets the exit code and the last 40 lines of output, and finishes
  with `bash scripts/init-project.sh && touch .ndev-inited`.
- The build runs in the background for at most 10 minutes. A longer build fails with a timeout and
  the agent must run the script.
- Outside a git repository the hook does nothing.

Run the hooks module's tests with `claude plugin test .`.

## Docs walk-through: /walk-doc

A third hooks module, `hooks/walk-doc/`, tests a set of docs by using them. `/walk-doc <page>`
starts the docs dev server and a fresh reader agent (`ndev:walk`). The reader follows each step
on the rendered pages and records each command and browser step. When it gets stuck, it reports
an `OMISSION`, `BUG`, `INCORRECT` or `BLOCKED` finding to the main agent. The main agent fixes the
docs or the product on the current branch, then tells the reader to continue or start again.

A project turns it on with `.walk-doc.json` at the repository root. The file names the dev server
command, the content folder, the paths the reader may not read, the finish commands, how the docs
embed media and how to file an issue. Without the file, `/walk-doc` does nothing and tells you what
to write. A missing required key stops the walk and names the key, the file and an example value.
The keys and the loop are in [`hooks/walk-doc/README.md`](hooks/walk-doc/README.md).

## Responsive matrix: /responsive-matrix

A fourth hooks module, `hooks/responsive-check.tsx`, shows the `responsive-check` skill's run in a
pane. When a Bash call runs `responsive-check.mjs`, the pane opens and follows the run: a progress
bar, the counts, the cell in progress, and a grid with one row for each viewport and a light and a
dark cell for each route. When the run ends, it shows the verdict and the findings that occur in the
most cells. `/responsive-matrix` opens the pane again with the newest run. `o` opens the screenshot
folder.

The runner writes `progress.json` in its `--out` folder and a pointer to it in
`~/.cache/ndev/responsive-check/latest.json`. The pane reads these two files. It does not show a
run that started before the Bash call.

## The living wiki: ~/dev-wiki

The plugin learns while you use it. The first session that starts with the plugin creates
`~/dev-wiki` from the plugin's `kb/`, as a local git repository.

- At the start of development work, Claude reads the `~/dev-wiki/wiki.md` index once.
- When Claude learns a reusable lesson, the `dev-wiki` skill records it in the page that owns the
  topic, writes one `.log/` file and commits it. Such a lesson is a correction, a non-obvious
  cause, a guard that lied, or a procedure written twice.
- When a prompt looks like a correction ("no, don't…", "from now on…"), the plugin reminds Claude
  to record the lesson.
- After each push that lands, a hook asks Claude for the ingest: it reviews the session since the
  last ingest and records each development, design or copywriting lesson that holds outside the
  project and its domain.
- `/learn` asks for a review of the whole session.
- A lesson that holds in two or more repositories goes back into `kb/` through a PR on this
  repository. A human merges it.

A project or domain fact goes to that project's wiki (the `remember` skill), not to `~/dev-wiki`.

## Install in a project

Add this to the project's `.claude/settings.json`. Everyone who opens the project gets a prompt to
install the plugin.

```json
{
  "extraKnownMarketplaces": {
    "ndev": {
      "source": { "source": "github", "repo": "neilellis/ndev" }
    }
  },
  "enabledPlugins": {
    "ndev@ndev": true
  }
}
```

Or install it by hand:

```
/plugin marketplace add neilellis/ndev
/plugin install ndev@ndev
```

The plugin was called `neil-development` before version 0.6.0, and its marketplace was called
`neil-development` before version 0.7.1. To move an existing install, run
`/plugin uninstall ndev@neil-development` (or `neil-development@neil-development`), then the two
commands above, and change `enabledPlugins` in your settings to `"ndev@ndev": true`.

Plugin skills are namespaced, for example `/ndev:work-light`. A project skill with the
same name stays separate. Delete the project copy when the plugin version replaces it.

The repository is private. To install it, you must have read access on GitHub and a working
`gh auth login` or Git credential on your computer.

## Companion plugins

The skills refer to these. Install them as well:

- `mattpocock-skills` (from `claude-plugins-official`): `tdd`, `diagnosing-bugs`, `code-review`,
  `codebase-design`, `domain-modeling`, `grilling`, `prototype`, `research`, `pr`.
- `simple-english`: the ASD-STE100 writing rules that all prose follows.
- `orca-cli`: worktrees, terminals and agent handoff in Orca.

## Change the factory

1. Make the change on a branch and open a PR.
2. Write project-neutral text. A fact about one project goes in that project's wiki.
3. Bump `version` in `.claude-plugin/plugin.json`.
4. Run `claude plugin validate .` before you push.
