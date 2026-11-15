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
| `harness-sync` | Compare the Claude and Codex harness trees and reconcile a difference between them, before or after any change that copies one skill tree onto the other. |
| `hotfix` | Do the requested work directly on the main branch in the main checkout, with no worktree and no pull request, then push to origin main. |
| `hyperfine` | Benchmark and compare command durations when a speed claim or before/after measurement is needed. |
| `i` | Alias of issue: create a GitHub issue from a description and put it in Backlog on the project board with its fields filled in. |
| `i-have-adhd` | Load before writing any reply to the user. |
| `interview` | Settle the decisions of an issue with the human, in the interview pane, before the plan or the code. |
| `implement-spec` | Implement a provided specification and its linked tickets on one branch and in one pull request. |
| `improve-agent` | Analyse an automated agent's run log and produce an evidence-based improvement plan for its prompt, skill, tools and guards. |
| `infographic` | Create raster infographic images with bundled layout and visual-style references. |
| `issue` | Create a GitHub issue from a short description, add it to the project board in Backlog, and fill in the issue and board fields that the description… |
| `milestone-release` | Publish a GitHub release from committed milestone release notes when the user explicitly asks to cut or publish it. |
| `milestone-release-notes` | Produce stakeholder-facing release notes for a GitHub milestone by reading all included issues and merged PRs. |
| `mobile-testing` | Capture and inspect the web app with Playwright mobile device emulation. |
| `modern-web-guidance` | Find and apply the modern web platform guide for an HTML, CSS or client-side JavaScript task: dialogs, popovers, menus, forms, select, tables, dark mode, colour, typography, layout, container queries, view transitions,… |
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
| `second-opinion` | Get an independent second opinion on a design, plan or piece of code from another agent, usually Codex, through Orca orchestration. |
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
| `epic-plan` | Plan an epic as its coordinator: frame, research with helpers, write the spec, settle the decisions, get a spec review, slice into sub-issues. Started by `/flow epic`. |
| `epic-coordinate` | Coordinate an epic: an implementer and then a reviewer per sub-issue as Orca workers, rule on findings, verify, merge. |

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

`/dev triage start [--dry-run] [--codex] [--open] [--batch <size>|--sequential] [--since <n>] [--reverse] [--bugs-only] [--mine] [--remote [<server>]] [--hint "<text>"]` groups the open issues and makes this session the
coordinator of one Orca worker for each group. Each worker takes its group through the workflow on
one pull request, and asks the coordinator when it needs a decision. `--codex` starts Codex workers
in place of Claude workers, `--open` takes every open issue and not only the board's, `--batch <size>` (default 5) runs that many workers at once and starts the next batch only when the last one has ended, in the order the coordinator chooses, and `--sequential` is `--batch 1`: one pull request at a time. `--since <n>` takes only the issues with a number above `<n>`. `--reverse` works the newest issues first. `--bugs-only` groups only the bugs: it labels them `bug`, labels an enhancement `enhancement` and a speculative proposal `proposed`, and leaves out human actions and other issues. `--mine` takes only the issues you opened (`author:@me`; on a board, the cards whose author is your gh login). `--remote [<server>]` makes each workspace and runs each worker on a saved Orca server: the one named, else the one `/dev remote` set for this project, else the only one Orca has; the server needs the plugin and the project's credentials file, and it does not work with `--codex`. `--hint "<text>"` gives the coordinator your own steer, such as `--hint "close outdated/superseded issues"`. `/dev triage clean [--since <n>] [--reverse] [--mine] [--hint "<text>"]` only closes issues: the model checks each open issue against the code and the later pull requests, finds the ones a merged pull request fixed but left open, and closes those that are done, outdated or superseded once you confirm them. `/dev triage launch`, `refresh` and
`reset` launch a dry run, read the triage back from Orca, and clear it. `/dev triage` is the one triage command, and `/dev help`
lists each option. The guide is [kb/workflow.md](kb/workflow.md).

`/dev remote <server>` saves which of Orca's saved servers this project uses as its remote machine. It takes a server's name, its id or the start of its id, and refuses one that Orca does not have, with the list of saved servers. Orca names the saved server of a recipe `<recipe id> VM <id>`, so the recipe id alone also names it, as in `/dev remote dev-build`; when several saved servers have that short name, it refuses and lists them. When no saved server matches and the `orca.yaml` of the project's primary checkout has an `environmentRecipes` entry with that id, the refusal says so and gives the one repair: in the Orca app, New workspace, then Run on, then the recipe's display name. Orca saves the server only then; its CLI cannot. With no such recipe, the refusal also says how to make one. `/dev remote` shows the saved server and whether Orca still has it. `/dev remote list` lists Orca's saved servers and marks the saved one. `/dev remote off` clears the setting. `list`, `off`, `create`, `remove` and `import` are subcommands, never server names: save a server with one of those names by its id. The setting does not make a triage remote by itself: only `--remote` does. An epic uses it the same way, and only when asked: `mcp__ndev__epicStarted` with `remote: true` (or a server's name) starts the workers of new sub-issues on the server with `orca orchestration worker-start --on <server id>`, and `remote: false` goes back to this machine ([The epic workflow](kb/workflow.md#the-epic-workflow)). The setting is in `~/.config/ndev/remote.json`, keyed by the project's GitHub repository (the project folder when it has none). It is this machine's setting, because a saved server is an entry in this machine's Orca, so it never goes into `.neil-dev.json`. Every checkout and worktree of the project shares it. A saved server that Orca no longer has is an error that names `/dev remote <server>` and `/dev remote off`. Nothing switches to another server.

`/dev remote create <name>` and `/dev remote remove <name>` make and delete a Hetzner Cloud server that Orca uses as an SSH host. They need `hcloud`, and a named hcloud context: `--context <context>` the first time, which the plugin then keeps for that name. The context is the Hetzner project that pays. The active context and `HCLOUD_CONTEXT` are never used, every hcloud call runs with `HCLOUD_TOKEN` removed, and the plugin never asks for a token.

- **`remove`** shuts the server down, takes a snapshot, and waits until the snapshot is `available`. Only then does it delete the server, and after that the older snapshot of the name, so one snapshot is kept. If the snapshot fails or does not become available, it deletes nothing and names the server id, hcloud's output and the repair. `--forget` also deletes the snapshot, the floating IP and the firewall, after a second confirmation. For a server that `import` handed over, `remove` first connects over SSH as `root` (at the server's own address, else at the remote's floating IP while it is assigned to the server) with the host key that import recorded as the only known host key and `StrictHostKeyChecking=yes`, so the server must prove that it holds that key; `ssh-keyscan` is not used here, because it only reads a public key that any machine can show. If the server does not prove the key, or the SSH sign-in does not finish, it refuses before the question and before any shutdown, snapshot or delete, and names the server, the address, the saved fingerprint, ssh's exit code and output and the repair.
- **`create`** restores the snapshot of the name. With no snapshot it builds from the Ubuntu 24.04 base image (packages, Docker, the user `orca`, key-only SSH) and says that the host set-up (sign-ins, the clone) is still to do. `--type <server type>` sets the type; the default is the type that `remove` recorded, else `cx33`. A type whose disk is smaller than the snapshot's disk is refused with both sizes. `--location` and `--ssh-key` are the other options.
- **The address** of a remote is a floating IPv4, so it stays the same when the server is made again or changes type. `remove` unassigns it and keeps it (Hetzner charges for it while it exists), and `create` assigns it to the new server. On the server, the address is set with `ip addr add <floating ip> dev eth0`, which holds until the next restart; `create` also writes Hetzner's netplan file `/etc/netplan/60-floating-ip.yaml` at the first build, so the snapshot carries it. `create` then checks that SSH answers on the floating address with the host key that the first build recorded. A host key is never trusted on first use. `--floating-ip <name or id>` takes a floating IP that exists.
- **Labels.** Everything the commands make carries `managed-by=ndev` and `ndev-name=<name>`. They refuse a server, snapshot, floating IP or firewall without both labels. The refusal names the labels and `/dev remote import <hetzner-id> --context <context>`, which hands a hand-made server over. It names the `hcloud ... add-label` command where import does not apply: a snapshot, a floating IP or firewall with no server, and a firewall that other servers share. `create` and `remove` never add the labels themselves.
- **`import <hetzner-id> --context <context>`** hands a server that was made by hand to `create` and `remove`. The id is the server's number in `hcloud server list`, and the context is always named. The remote takes the server's Hetzner name, because `create` and `remove` find a server by that name; `--name` with another name is refused with the rename command. It adds the two labels to the server, to each firewall applied to it and to its floating IPv4, keeps every label that is there, and records the remote in `~/.config/ndev/remote.json`. It creates, deletes, resizes and reassigns nothing. A second import of the same server changes nothing and says so.
  - It refuses, with the id and a repair command: an id that is not a server of that context; a server that is not running; a resource that carries `ndev-name` of another remote or `managed-by` of another tool; a firewall that is also applied to another server or by a label selector (it names the others); a firewall named `<name>-ssh` or a floating IP named `<name>` that is not on the server and has no labels; more than one floating IPv4 on the server, until `--floating-ip <name or id>` names the remote's address; and a record of that name on this machine with another context, floating IP or host key.
  - With no floating IPv4 it still imports, and says that `remove` then keeps no address and `create` makes a new floating IPv4. The question also shows what an earlier remote of the name left (a labelled floating IP or snapshot, which `create` and `remove` take as this remote's), and a firewall on the server that is not named `<name>-ssh`, which `create` and `remove` do not use, with the rename command.
  - **The host key.** An imported server has no first-boot key, so import reads the ed25519 key that the remote's address presents (`ssh-keyscan`; the server's own address when it has no floating IP), shows its SHA256 fingerprint in the confirmation question, and records it only on yes. That question is the one moment trust is given. When `~/.ssh/known_hosts` holds another ed25519 key for the address, import refuses and shows both fingerprints. `--yes` confirms only a key that `known_hosts` or the record already holds: it never gives trust to a key that no person has seen. `remove` checks the server against this key before its snapshot.
  - **Limit.** The server was not built by `scripts/remote/root-setup.sh`, so a restore is only as good as its own cloud-init setting: by default cloud-init makes new host keys on a restored server, and `create` then refuses the new key. Import prints the one-line cloud-init setting that keeps the keys. `create` also signs in by key as `root` at the server's own address and as `orca` at the floating address.
- **Confirmation.** Each command shows the server type, the monthly prices, the location, the hcloud context and what it deletes, and asks. With no one to answer (a `-p` run), it refuses. `--yes` confirms on the command line; for `import` only when this machine already holds the host key.
- **Orca.** Orca's CLI cannot save an SSH host as a server (`orca environment add` takes only the pairing code of a running Orca server). `create` therefore prints the manual step (an `environmentRecipes` entry, then New workspace → Run on in the Orca app) and leaves the `/dev remote` setting as it is. When Orca has a saved server named `<name>` or `<name> VM <id>`, `create` saves it as this project's `/dev remote`.

`/dev remote resize [<type>]` changes the Hetzner server type of the box under this project's Orca server (`hooks/remote-resize.ts`). With no type, it lists the types that the box can change to and recommends the next size up of the same family, and changes nothing. With a type, it does these steps:

1. **Find the box.** The SSH host comes from Orca's record of the server (`orca-ephemeral-vm-runtimes.json`), or from `--ssh <user@host>`. Over SSH it reads the Hetzner instance id from the metadata service, and finds that id in `hcloud --context <context> server list`. The hcloud context is `--context <context>`, else `remote.hcloudContext` in `.neil-dev.json`. With neither, the command stops and names the key. It never uses the active context.
   It then finds the workers on the box. The Orca server's own records, Run by Run, show each worker that runs there. This machine's records, Run by Run, show the Run that dispatched each one. Each Run is named, because a `worker-list` with no `--run` shows only the Run that the terminal is bound to. A worker that is still starting, or that no Run of this machine dispatched, stops the command before any change.
2. **Show and confirm.** It shows the current type and the new type (vCPU, memory, disk and the monthly price), and the workers it pauses. A person must confirm, or `--yes` on the command line. It refuses a type of another architecture, a type with a smaller disk, a deprecated type, and a type that is not sold in the box's location.
3. **Pause the workers.** It sends each live Orca worker on the server a message: commit the work in progress, write a handoff of 15 lines or fewer to `~/handoff/<issue>.md` on the box, end the file with `paused <dispatch id>`, reply and stop. It reads the handoff files over SSH, not the mailbox, because the mail of a remote worker can arrive on either Orca. After 15 minutes it stops, names each worker that did not pause, and changes nothing on Hetzner.
4. **Resize.** `server shutdown --wait`; if that fails, `server poweroff`, with a `WARNING` in the result. Then `server change-type --keep-disk`, `server poweron`, and a wait for SSH and for Orca to answer for the server.
5. **Start the workers again.** Each starts with `orca orchestration worker-start --on <server> --worktree id:<worktree id>`, with the same agent, model and effort, and its first brief plus "Resume from ~/handoff/<issue>.md". The selector is `id:`, not `path:`: Orca gives each remote worker's worktree as `<repo id>::<path on the box>`, and `id:` takes that value as it is. A `path:` selector is read against the folders of this machine. Each restart is a new Task in the same Run, not `--task <old> --retry-of <old dispatch>`: Orca takes `--retry-of` only for a failed or stopped attempt, and the old one is neither. The result gives each old and new task id, because a coordinator that follows task ids, such as `/dev triage`, does not see the new Task. The receipt of `worker-start` decides, not its exit code.

Each failure names the step, the command, its exit code and output, the repair, and what the earlier steps did. When the box is off or paused, the failure also gives the `worker-start` command for each worker. Options: `--context`, `--server <Orca server>` (else the project's `/dev remote`), `--ssh`, `--agent <agent>` (for a worker whose agent Orca does not record) and `--yes`.

## Per-project settings: `.neil-dev.json`

All the plugin's settings for a project live in one file at the project root, checked in with
the project. Every key is optional:

```json
{
  "mode": "light",
  "steering": "interactive",
  "github": { "repo": "acme/app", "board": { "owner": "acme", "number": 3 } },
  "branding": { "site": "https://brand.example", "name": "Acme", "guide": "https://brand.example/guide", "path": "apps/brand" },
  "quality": { },
  "projectLevel": "small_project",
  "worktreeStacks": { "onSessionEnd": "stop-and-delete" },
  "remote": { "hcloudContext": "orca-dev" },
  "services": { "supabase": { "url": "https://supabase.com/dashboard/project/<ref>" }, "vercel": { "url": "https://vercel.com/<team>/<project>" } }
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
- `services` names the project's web consoles, each as `{ "url": "https://..." }` (http or https only). `/view` shows them as clickable links. Take the values from the CLIs: the Supabase ref from `supabase projects list`, the Vercel team slug and project name from `vercel teams ls` and `.vercel/project.json`.
- `remote.hcloudContext` names the hcloud context (`hcloud context list`) of the Hetzner project that holds the box under the project's Orca server. `/dev remote resize` uses it. The plugin never uses the active context.
- `worktreeStacks.onSessionEnd` sets what happens to the docker stacks that a worktree lists in
  `.neil-dev.worktree.json` (`resources.docker`) when a session in that worktree ends (see
  "Worktree resources" below):
  - `stop-and-delete` (the default): stop each stack and delete its data
    (`supabase stop --no-backup`).
  - `stop-keep-data`: stop each stack and keep its data volumes (`supabase stop`).
  - `keep-running`: do not stop the stacks. A message lists the stacks that are left running.

  This setting does not apply to dev servers. The hook stops the listed dev servers at each
  session end.

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

The workflow check scripts (`scripts/ndev/workflow/*.sh`) get only the keys that `checkEnv` in `.neil-dev.json` names, such as `"checkEnv": ["TEST_DATABASE_URL"]`. With no `checkEnv` they get none. Name only keys for local test services, never the credentials of a hosted service: a test that finds such a key runs against the hosted service. A named key that the file does not set stops the check, and a failed check lists the keys it did not get.

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

A running loop checks GitHub every 15 minutes (see [GitHub quota](#github-quota)), so a pushed fix can wait that long before the loop sees it. `/fix-prs status` reads at once.

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

## Worktree resources: .neil-dev.worktree.json

Many worktrees each start their own local stack (for example a Supabase stack with the worktree's
own project id) and their own dev servers. When nobody stops them, Docker fills up, ports stay
taken, and a new stack or server fails to start. So each git worktree lists the resources it
started in `.neil-dev.worktree.json`, in the worktree's own folder (never only in the main
checkout).

A linked worktree also keeps its own development mode and steering there, under an optional
`"settings": { "mode": "heavy", "steering": "auto" }`. They win over `.neil-dev.json`, and
`/dev mode` and `/dev steering` save to this file in a linked worktree, so a setting for one task
never reaches the committed project file. The main checkout keeps no such file, so there they are
still saved to `.neil-dev.json`.

```json
{
  "version": 2,
  "resources": {
    "docker": [
      { "kind": "supabase", "projectId": "fcc-211", "workdir": "/repo/.claude/worktrees/fix-211",
        "cliVersion": "2.122.0", "addedAt": "2026-10-30T10:00:00.000Z" }
    ],
    "dev-servers": {
      "docs": { "pid": 48213, "port": 3000, "command": "node /repo/node_modules/.bin/next dev",
                "cwd": "/repo/.claude/worktrees/fix-211/apps/docs", "started": "2026-10-30T10:05:12.000Z" }
    }
  }
}
```

- `resources.docker` is a list of docker stacks.
- `resources.dev-servers` is a map. Each key is a name for what the server shows, for example
  `docs` or `ui`. The script reads `command` (the full command line) and `started` from `ps` when
  it records the server.
- A failed stop adds `lastStop` to its entry.
- The script refuses a file with an unknown key, at any level, and names the key. It changes and
  stops nothing.
- The script refuses a version 1 file (`{ "version": 1, "stacks": [...] }`) and names the repair:
  `worktree-env.sh migrate --worktree <dir>`. The migrate command moves the stacks to
  `resources.docker`.

`scripts/work/worktree-env.sh` owns the file:

| Command | What it does |
|---|---|
| `add-stack --kind supabase --project-id <id> --cli-version <x.y.z> [--workdir <dir>] [--worktree <dir>]` | Records a stack. `--workdir` is the folder you ran `supabase start` in (default: the current folder). The same id again replaces the entry. |
| `remove-stack --kind supabase --project-id <id> [--worktree <dir>]` | Removes a stack entry, for a stack that you stopped yourself. |
| `add-dev-server --name <name> --pid <pid> --port <port> [--cwd <dir>] [--worktree <dir>]` | Records a running dev server under `<name>`. `--cwd` is the folder the server runs in (default: the current folder). The same name again replaces the entry. |
| `remove-dev-server --name <name> [--worktree <dir>]` | Removes a dev-server entry, for a server that you stopped yourself. It stops nothing. |
| `list [--json] [--worktree <dir>]` | Shows the entries. |
| `stop-all [--on-end stop-and-delete\|stop-keep-data\|keep-running] [--worktree <dir>] [--background [--log <file>]]` | Stops each listed dev server. Then it stops each listed stack with `npx -y supabase@<cliVersion> stop --project-id <id>` (plus `--no-backup` for `stop-and-delete`), in its workdir. With `keep-running` it stops only the dev servers. |
| `migrate [--worktree <dir>]` | Rewrites a version 1 file as version 2. A version 2 file stays as it is. |
| `init [--worktree <dir>]` | Creates an empty record when a linked worktree has none. It never changes an existing file, and creates nothing in the main checkout. The ndev hook runs it at session start and when `/view` opens. |
| `set-setting --key mode\|steering --value <value> [--worktree <dir>]` | Saves the development mode or steering of this worktree under `"settings"` (see below). It refuses in the main checkout. |

| Exit code | Meaning |
|---|---|
| 0 | Done. |
| 1 | A stop failed. Its entry stays. |
| 2 | A usage error, a file that does not parse, a version 1 file, an unknown shape, a pid that does not run, or a lock that another command holds too long. |
| 3 | Refused: the main checkout, a file that is not git-ignored, or a project id or pid that another worktree lists. |
| 4 | The stack or the dev server is not listed. |

To record a dev server, start it in the background and record its pid at once:

```bash
pnpm --dir apps/docs dev --port 3000 > /tmp/docs-dev.log 2>&1 &
"${CLAUDE_PLUGIN_ROOT}/scripts/work/worktree-env.sh" add-dev-server --name docs --pid $! --port 3000 --cwd apps/docs
```

- The file must be git-ignored. `add-stack` and `add-dev-server` refuse when it is not, and name the repair:
  add the line `.neil-dev.worktree.json` to `.gitignore` (or to the git common dir's
  `info/exclude`). The plugin does not edit `.gitignore`.
  `set-workflow` adds the line to `info/exclude` itself, so the workflow tools start in any project.
  It still refuses a record that git tracks, or a `.gitignore` that un-ignores it.
- `add-stack` and `add-dev-server` refuse in the main checkout: the record belongs to a linked
  worktree.
- `add-stack` refuses a project id that another worktree of the repository lists. Two worktrees
  with one project id share its containers, so a stop from one stops the other's stack. The
  message names that worktree and the repair: give this worktree its own `project_id`.
- `add-dev-server` refuses a pid that does not run, and a pid that another worktree lists. The
  message names that worktree and its `remove-dev-server` command.
- `stop-all` stops a dev server only while its pid runs the recorded command from the recorded
  start time (within 5 s). The system can give the pid of a server that ended to a new process,
  and that process is never killed. A mismatch keeps the entry with `lastStop`, prints the
  recorded and the actual command, and names the repair: find the server by its port with
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`, then run `remove-dev-server`. The exit code is 1.
- A server that changes its process title after it starts does not match its record, so it is
  never killed. Stop it by its port, then run `remove-dev-server`.
- `stop-all` sends SIGTERM to the server's process group when the server leads one. It also
  signals each child process of the server, and their children. It finds them before it sends a
  signal, so they also stop when the server does not lead a group (for example `pnpm dev &` in a
  script). After 10 s (`NDEV_DEV_SERVER_STOP_TIMEOUT_S`) it sends SIGKILL to each process that
  still runs.
- When the server's pid no longer runs but processes of its group still run, `stop-all` stops that
  group. When nothing of it runs, the server has already ended: its entry goes, and the log says so.
- When a signal fails, the stored repair is `stop-all --on-end keep-running` (which checks the pid
  again), then the `lsof` search by port. It is never a bare `kill` of the pid, because a later
  session can find that pid given to another process.
- Each change to the file holds a lock, `<git dir>/ndev-worktree.lock`, so two commands do not
  overwrite each other. A lock whose process is gone is taken over. A command waits at most 10 s
  (`NDEV_WORKTREE_LOCK_WAIT_MS`), then exits 2 and names the lock to remove.
- When a session ends in a worktree, `hooks/worktree-stacks.ts` runs
  `worktree-env.sh stop-all --background` with the policy from `.neil-dev.json`
  (`worktreeStacks.onSessionEnd`). The stop runs detached, so a slow `supabase stop` does not
  hold up the exit. It logs to `<git common dir>/ndev-worktree-stop/<worktree name>.log`, so the
  log stays when the worktree is removed. Each run ends its log with its exit code.
- `stop-all --background` reads the file before it detaches. A bad file exits 2 at once, so the
  hook shows the error, not only the log.
- The dev servers stop at each session end. With `keep-running` the hook runs `stop-all` with
  `--on-end keep-running`, which stops only the dev servers.
- The hook acts only on the session's own worktree, and only on the resources its file lists.
- A `/clear` or a resume stops nothing: the process goes on in the same worktree.
- An entry goes only after its stack or server stopped. A failed stop keeps the entry and records
  `lastStop` (the command, the output and the repair command; for a stack also the exit code and
  the last 40 lines of output). The next session in that worktree shows it in a message and tells
  the agent the repair.
- An entry goes only if it is the same entry the stop read (for a stack the same `addedAt`, for a
  dev server the same pid and `started`). If a new session records it again while an old stop
  runs, the new entry stays.
- At session start, the agent is also told which stacks and dev servers the file still lists, with
  the `stop-all` command. A task that uses one leaves it listed.
- If `.neil-dev.json` has an error, the hook stops the dev servers but not the stacks. A message
  names the error and the repair command.
- If `.neil-dev.worktree.json` is version 1 or has an unknown shape, the hook stops nothing. The
  session-start message and the session-end message name the problem and the repair. For version 1
  the repair is `migrate`.

Run the hooks module's tests with `claude plugin test .`, and the script's tests with
`node --test scripts/work/tests/worktree_env.test.mjs`.

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

## ndev view: /view

`/view` opens a pane for the project (`hooks/view.tsx`). The pane has no background of its own. If a workflow runs, the pane draws it as a chain of boxes: ✔ passed, ● current, ▲ blocked, ○ to come, – skipped. It refreshes every 5 s and has
`r` for a refresh by hand. It shows only the worktree the session is in (the main checkout is read
only as the source for **Copy from main**):

- The ndev files: `.neil-dev.json`, `.neil-dev.env`, `.neil-dev.worktree.json` and any other
  `.neil-dev*` file. A missing `.neil-dev.json` or `.neil-dev.env` has **Create** and, in a linked
  worktree, **Copy from main**. Neither overwrites a file. `.neil-dev.env` is written only where
  git ignores it. The work is done by `scripts/work/ndev-files.sh`
  (`list --json`, `create`, `copy`; test: `node --test scripts/work/tests/ndev_files.test.mjs`).
- Every field of the worktree file and of each `.neil-dev.issue-<id>.json`, with the lead issue of
  each PR. A field that the pane does not know still shows, and secrets are masked. Each issue, PR,
  check, branch, commit, file, folder and URL is a link. A workflow that needs you is at the top.
  `hooks/view-layout.ts` lays out the rows and `hooks/view.tsx` draws them.
- The resources in `.neil-dev.worktree.json` (version 2), with live status from
  `worktree-env.sh list --json --live`: a dev server is running while its pid still runs the
  recorded command; a docker stack is running while `docker ps` shows its containers (`?` and
  docker's message when docker does not answer).
- Controls. **Stop** needs two presses within 5 s. A docker stack offers **Stop, keep data** and
  **Stop and delete data**. Each worktree has **Stop all, keep data** and **Stop all and delete
  data**. A running dev server has **Open** (`http://localhost:<port>`). **Copy port** and
  **Copy command** copy the recorded values.

A worktree whose folder or `.git` is gone shows the problem and `git worktree prune` as the
repair; it does not hide the list. A failed action shows its exit code and the script's own message in the pane.
`worktree-env.sh stop` stops one resource: `--name <dev server>`, or `--kind supabase
--project-id <id> [--on-end stop-and-delete|stop-keep-data]`.

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

## The workflow: /flow

The `mcp__ndev__*` workflow tools keep an agent on one issue from `started` to `done`. Each tool records the state in `.neil-dev.issue-<id>.json`, does the commit, push or mark-ready step, and returns the next step. The `review` and `remember` stage hooks fire when the state changes. When a turn ends and the work is not finished, the plugin prompts the agent again. After 20 minutes with no activity, it compacts the session, reads the PR status and prompts again. `blocked` sends a notification that stays until you dismiss it.

The guide, with the flow chart, is [kb/workflow.md](kb/workflow.md). To show it in a session, type `/flow guide`. `/flow` also shows the status, skips a phase, goes to a state, ends a block and turns the workflow off. `/unblock <message>` gives the agent your answer and ends a block or a wait. It runs at once, also during a turn.

A session that starts with no issue asks for the issue, a new issue, or no workflow. `iNeedA(kind, description)` gives guidance on a `react-component`, `library`, `brand-style` or `animation`. `reportWorkflowBug(title, details)` starts an Orca agent that fixes a fault of the plugin on its `main`. Each skill and agent names the tools that it needs.

Each issue can have its own mode and steering. The agent chooses heavy or light in `started` or `create`, and `/flow mode` and `/flow steering` set one issue. A PR follows the strictest of its issues. `/view` shows the state, and what each tool waits for.

`checkpoint` and `finishedDevelopment` take an optional `changeTypes` list (`web`, `backend`, `database`, `docs`, `tests`, `config`). The review instructions change with the types that accumulate. `screenshot(url)` takes images of a page in the Orca browser for a web change. See [Change types](kb/workflow.md#change-types).

In an Orca workspace, the workflow also sets the workspace name to `<issue>-<shortName>` (`<PR>-<shortName>` once a PR is added), the board status, a comment with the state, and the unread dot when a human must act.

While a workflow runs, it does the work of the edited-file guards, the precheck reminder, the component check and the ingest after a push, so those hooks stand aside. A project keeps its checks in `scripts/ndev/workflow/`: `fast-checks.sh`, `pre-commit-check.sh`, `pre-push-check.sh` and `pre-ready-check.sh`. `/ndev:merge` merges a PR and runs its Supabase migrations.

## Component check

`hooks/component-check.ts` runs in every project and needs no setting. After a successful Edit or Write of a `.tsx`, `.jsx`, `.vue` or `.svelte` file, it asks the agent to check the change against the component map in [`kb/ui-components.md`](kb/ui-components.md). The agent then changes to a richer component where one improves the interaction, or says in one line why the basic solution is right.

While a workflow runs, this hook stands aside, and `finishedDevelopment` lists the changed UI files for the review. The hook asks once for each file in a session and never blocks. It skips tests, stories and `node_modules`. A new session, such as after `/clear`, asks again. It does not see a file changed through Bash.

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

## GitHub quota

All of the plugin reaches GitHub through `scripts/github/gh.sh`: the `gh` command first, and REST when it fails. `gh` commands spend GraphQL points and `gh api` spends REST calls, so one route still answers when the other is used up. The Projects v2 board uses GraphQL, which has no REST API.

Background work is held to a budget, because each session of the plugin runs its timers:

- `/fix-prs` makes no GitHub call in a session that did not start the loop. It reads when a person asks.
- A running `/fix-prs` loop checks GitHub every 15 minutes, and reads only its current pull request (2 calls). A whole-queue read is one call. A person's request and a `blocked` report read at once. Set `NDEV_PR_CHECK_MS` to change the time.
- `/dev triage` hears its workers through Orca's inbox. Its safety-net timer runs every 15 minutes. While it runs, every 10 minutes it reads the open PR of each group (2 calls each), and sends the worker a message when the PR conflicts, is behind, or has a failing check (the same fault on the same head at most once per 30 minutes).
