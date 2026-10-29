# /walk-doc

`/walk-doc <path>` tests a set of docs by using them. A fresh Walk agent reads the rendered pages and follows each step as a reader with a laptop would. When it gets stuck, it reports to you (the main agent). You fix the docs or the product on the current branch, then tell it to carry on or start again.

## Use

```text
/walk-doc docs/content/install/quick-start.mdx             # one page
/walk-doc docs/content/install                             # a section, in sidebar order
/walk-doc http://localhost:3222/install/quick-start/       # a page URL
/walk-doc ask Please record the install step               # ask the reader for help without stopping it
/walk-doc restart -- and record the setup command          # a fresh reader now, told your note
/walk-doc tip The installer can reach the package registry # kept in .walk-doc.json; told to every reader
/walk-doc stop                                             # stop the walk, the dev server and its machines
```

Optional: `--persona "<who the reader is>"` sets who the Walk agent pretends to be for this walk. It overrides `persona` in `.walk-doc.json`.

Optional: `--re-record` asks every reader to record each recording on the page again: each GIF, each screenshot or image made from a video and each terminal cast, even one that still looks right. The reader sends each with `walk_record`, mode `REPLACE`, naming the path it replaces. A restarted reader is told the same. Example: `/walk-doc /manuals/operations/ --re-record`.

The walk starts the docs dev server on a free port. The pane shows its URL, so you can read the same pages the agent reads. Edits to the docs show up on the next page load.

## The loop

| The Walk agent sends | Meaning | What happens |
| --- | --- | --- |
| `OMISSION` | A step is missing, or the docs do not say how to do something. | The walk stops and the main agent hears. |
| `BUG` | The product does not work as the docs say it should. | The walk stops and the main agent hears. |
| `INCORRECT` | The docs and reality differ. | The walk stops and the main agent hears. |
| `BLOCKED` | Only a person can give what is needed. | The walk stops and the main agent hears. |
| `ENHANCE` | Something could be better. | The main agent hears at once; the walk goes on without waiting. |
| `RECORD` | A recording or screenshot is worth adding to the docs (`INSERT`), or should replace one there (`REPLACE`). | The main agent hears at once; the walk goes on without waiting. |

The main agent fixes the cause like a developer, as it happens: on the current branch, with no new branches, worktrees or PRs. A product fault is fixed in the product, never documented as a workaround. Only a fault it cannot fix now, and that the docs flow does not need, becomes an issue, filed with the `issues` command. It commits each fix as `walk-doc <CODE>: <what changed>`. Then it calls `walk_reply`:

- `CONTINUE` sends the note to the same Walk agent, which reloads the changed pages and retries the step.
- `RESTART` starts a fresh Walk agent in a new, empty workspace. The main agent can also send it while the reader is walking: the walking reader is told to stop, as with `/walk-doc restart`. A walk allows 20 restarts.

The main agent can also ask the Walk agent for help at any time with `walk_ask`, and you can with `/walk-doc ask <question>`: a recording of a step, a check, or what it sees. The Walk agent does it, sends any recording with `walk_record`, and answers with `walk_answer`. The answer reaches the main agent as a message. Both show in the pane as `ASK` and `ANSWER`, and in the report under "Questions to the reader".

An `ENHANCE` or `RECORD` note is answered with `walk_reply` action `NOTED` and `answers: <its number>`. The answer goes to the pane and the report; the Walk agent is not stopped or told.

## Recordings

Every Bash command of the Walk agent runs under `asciinema rec`. The walk saves `NNN.cast` and its text `NNN.txt` in `~/.walk-doc/<run>/attempt-<n>/media/`. The reader still sees the output, the exit code and a changed folder. A recorded command gets no input, so a prompt reads end of input. Browser steps use a headless Chromium that the plugin starts through Playwright's MCP server (`@playwright/mcp`, declared in `plugin.json`). Its page is exactly 1028x768 (wider than 1024, so pages show their desktop layout) and its profile is fresh for each session. For each browser step the reader saves a `.webm` video (`browser_start_video`, no action callouts) that shows an oversized red cursor, a click pulse and a fading red trail, drawn by `skills/browser-arrows/scripts/cursor.js`, and a JPEG of the final screen in the same folder. It waits 8 seconds after a page loads before it starts a video or takes control. The main agent turns a video into a GIF with `scripts/walk-doc/video-to-gif.sh <video> <name>.gif` (from the ndev plugin folder) when it places it: the reader's thinking time records as minutes of still screen, so the script keeps only the frames that change (a blinking caret does not count) and caps each still stretch at 2.5 seconds (`--hold`), so the reader's deliberate pauses (about 1.5 seconds after an action, and the arrow dwell) stay in the GIF.

`plugin.json` passes `skills/browser-arrows/scripts/cursor.js` and `arrow.js` to the server with `--init-script`, so both load in every page before its own scripts. `arrow.js` adds `window.walkArrow` and draws nothing until it is called. In a recording, the reader calls it through `browser_evaluate`: `walkArrow.point('text=Save', { text: 'Save the record', untilClick: true })` points at what to click, `walkArrow.magnify('#email', { untilBlur: true })` enlarges a field while it is typed in, and `walkArrow.stop()` clears the overlay before a screenshot. The default look is calm (thin lines, muted colours); `look: 'bold'` gives the bigarrow look. The header of `arrow.js` is the full API; the `browser-arrows` skill explains it. A label that `point` cannot find fails with code `NOT_FOUND` and names the target and the page, which the reader reports as INCORRECT.

Nothing goes in the docs by itself. After each step a reader would want to see, the reader sends `RECORD` with the file, a caption and `INSERT`. When a screenshot on the page differs from its screen, it sends `REPLACE` with `replaces`: that image's path. The main agent decides, places it and commits `walk-doc RECORD: …`. A single or simple command and its output goes in as a text code block, not a player; a player is for a lot of scrolling output, a wizard, several commands or TUI effects such as progress bars and redrawn screens. A wizard is a player even when only part of it is recorded. Before a cast is published, the main agent removes personal paths, the reader's markers and keypresses such as Ctrl+C, and the recording command in the header, and checks it holds no secret. The reader records a step with nothing filtering its output: a pipe such as `| tail` holds the output back, so the cast has one output event and cannot animate. Secrets reach a command only through environment variables. `walk_record` enforces this: it refuses a cast whose output came in one chunk, whose `NNN.sh` pipes the output through a filter such as `sed` or `tail` or redirects it to a file, or that holds a value from the `valuesFile`, and tells the reader how to record it again. The walk refuses to start without asciinema: `brew install asciinema`.

After 10 blocks on the same step, `CONTINUE` must describe a new approach. `BLOCKED` is the last resort. The main agent tries every route a developer has first. Only `walk_escalate` texts a person, and it must list what was tried.

If the Walk agent fails to start, or the Claude session ends, the dev server is stopped.

When the Walk agent calls `walk_done`, the main agent runs the finish commands and then calls `walk_finish`. That writes `walk-run/<run>/report.md`, stops the dev server, removes the walk's machines and sends the summary text.

## What the Walk agent may do

- Read the rendered docs pages, in the browser or with curl. It never opens the docs source.
- Run commands and use the headless Playwright browser.
- Work in its own workspace, `~/.walk-doc/<run>/attempt-<n>`. When the project sets `machines`, it makes a machine or container named `walk-<run>-<n>` as `machines.guide` tells it.
- It never edits docs, commits or pushes, signs up for paid services or creates accounts in anyone's name.

A guard denies its reads of the source, the internal docs, `~/.claude` and other repositories. Paths that the docs pages name stay open. When Claude Code saves one of the Walk agent's own outputs under `~/.claude` because it is too long to show, that one file is open to it too. Saved output from the main agent stays closed. Each denial is logged in the run and in the report. The guard is a heuristic, not a sandbox. It expands `$HOME` and `~`, reads relative paths from both the project and the workspace, and treats a glob as every path it could match. A determined reader could still get round it, so the Walk prompt also forbids those reads.

## Set up a project

Put `.walk-doc.json` at the repository root. The walk reads it when a session starts, so start a new session after you add it. Without the file, `/walk-doc` does nothing and tells you what to write. A required key that is missing or has the wrong type stops `/walk-doc` before a walk starts. The message names the key, the file and an example value.

```json
{
  "devCommand": ["pnpm", "--dir", "apps/docs", "exec", "next", "dev", "-p", "{port}"],
  "contentRoot": "apps/docs/content",
  "deny": ["apps", "docs", "scripts", "config"],
  "finish": ["pnpm --dir apps/docs build"],
  "media": "Copy media into public/media/ and embed a screenshot as ![caption](/media/name.jpg).",
  "issues": "gh issue create --title <title> --body-file <file>",
  "persona": "a developer on a Linux laptop who has never seen this project before",
  "valuesFile": ".env.walk-docs",
  "machines": {
    "guide": ["For a Linux install, make a fresh container: docker run -d --name <name> ubuntu sleep infinity."],
    "cleanup": "ids=$(docker ps -aq --filter name=^{prefix}) || exit 1; [ -z \"$ids\" ] || docker rm -f $ids"
  }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `devCommand` | Yes | The dev server's argv, run from the repository root. It must contain `{port}`; the walk replaces it with a free port. |
| `contentRoot` | Yes | The folder that holds the docs pages. A page's URL is its path under this folder. |
| `deny` | Yes | Repository paths the Walk agent may not read, unless a docs page names them. |
| `finish` | Yes | Commands the main agent runs once, at the end of the walk, before `walk_finish`. Use `[]` for none. |
| `media` | Yes | How these docs embed recordings and screenshots. The main agent is told it with each `RECORD`. |
| `issues` | Yes | The command that files an issue for a product fault the walk cannot fix now. Use `""` to file none. |
| `tips` | No | What every reader is told when it starts, such as which services it can reach. `/walk-doc tip <text>` adds one and sends it to the running reader. |
| `persona` | No | Who the reader is. The default is "a competent developer who has never seen this project before". |
| `valuesFile` | No | A file name at the repository root that holds values for the reader (see below). Without this key, the reader gets no values. |
| `machines` | No | How the reader makes a machine or container for Linux or server docs. `guide` is a list of lines the reader is told. `cleanup` is a bash command that must contain `{prefix}`; `walk_finish` and `/walk-doc stop` run it with `{prefix}` replaced by `walk-<run>-`, and it must delete only the machines whose names start with that prefix. A cleanup that fails must exit non-zero, so do not end it in a pipe that hides the exit status. Without `machines`, the reader is told nothing about machines, and nothing is cleaned up. |

Add `walk-run/` and the `valuesFile` to `.gitignore`.

### Values for the reader

Some docs say "ask us for the login". Put such values in the `valuesFile`, one `KEY=VALUE` per line (`#` comments allowed). The walk passes them to the Walk agent when it starts and again with each `CONTINUE`, so a value added during a walk reaches the reader on the next reply. The walk looks for the file at the root of the checkout it runs in. Then it looks at the root of the main project checkout, which every worktree shares. The start message and the reader's values note give the file's path and say whether it is in the main project checkout. When neither has it, the walk refuses to start. The refusal names a copy in another worktree and the `cp` command that puts it in the main project checkout, or says how to create the file. Keep the file out of git.

To get a text message when a walk escalates or finishes, set the ndev plugin option `textTo` to a phone number or Apple ID. Texts are sent with Messages through `osascript`, so they work only on a Mac. With `textTo` empty, no text is sent and the tool says so.

## Install

`/walk-doc` is part of the ndev plugin. Enable ndev in the project and add `.walk-doc.json`. The Walk agent is `ndev:walk`, and its tools are `mcp__ndev__walk_*`. The walk needs `asciinema` (`brew install asciinema` on a Mac) and Node for the Playwright MCP server. `/walk-doc` checks that the Playwright server (`plugin:ndev:playwright`) is connected before it starts the docs dev server. Claude Code connects it once, at session start. If its first `npx` start passes the 30-second connect limit, it stays unconnected: reconnect it in `/mcp`, or start Claude Code with `MCP_TIMEOUT=120000`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

`hooks/walk-doc/walk.ts` holds the pure rules (arguments, config, reports, replies, the guard, the report). `hooks/walk-doc/index.tsx` connects them to the engine; `hooks/register.ts` calls it. `hooks/walk-doc/prompts.ts` holds what the Walk agent is told. The tests are `tests/walk-doc*.test.ts`, with the fixture config in `tests/walk-doc-fixture.ts`.
