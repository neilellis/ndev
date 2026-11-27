---
name: browser-arrows
description: "Show the viewer of a browser screen recording where to look: a calm arrow with a short sign, a ring or box round the target, a magnifier on a field while text is typed, and a large red cursor with a click pulse. Use when you record a web page for a how-to video, a docs GIF or a walkthrough with Playwright, or when a recording must point at a control, a field or a result."
---

# Browser arrows

Two scripts draw into the page that a browser records. They do not change the page.

- `scripts/cursor.js` draws a large red cursor, a fading trail and a click pulse of 300 ms, so the viewer sees each move and click. A scroll starts a new trail, so a click on a target out of view draws no line across the screen. Before a still, call `walkCursor.park()`: it hides the pointer and its marks until the mouse moves again. It starts by itself.
- `scripts/arrow.js` adds `window.walkArrow`. It draws nothing until you call it.

Both overlays ignore pointer events, take no focus and are hidden from assistive technology. A click, an accessibility snapshot and a test see the page as it is.

## Load the scripts

Load them as init scripts, so they run in each document before the page's own scripts.

- Playwright MCP: add `--init-script <this skill>/scripts/cursor.js <this skill>/scripts/arrow.js` to the server arguments. The option takes several paths.
- Playwright library: `await context.addInitScript({ path: '<this skill>/scripts/cursor.js' })`, then the same for `arrow.js`.
- Puppeteer: `await page.evaluateOnNewDocument(fs.readFileSync(path, 'utf8'))` for each script.

Do not inject them after the page loads: a navigation removes them.

## Record a step

1. Load the page. Wait 8 seconds, so fonts and data settle, then start the video.
2. Before a click, point at the control with the label the documentation uses:
   `walkArrow.point('text=Save', { text: 'Save the record', untilClick: true, untilAnyClick: true })`. untilClick alone ends only on a click inside the element it found; when a label matches two elements or the page re-renders, the click can miss it and the sign stays up. untilAnyClick ends it on the click anyway.
   The arrow goes away when the control is clicked.
   Wait before you click so the viewer can read the sign: 2 seconds plus 0.05 second for each character of the sign, at most 5 seconds (Playwright `browser_wait_for` with `time`). The walk-doc guard refuses an early click.
   After each click, navigation, typed entry or selection, wait about 1.5 seconds while recording, so the result is visible before the next arrow.
3. Before you type in a field, magnify it: `walkArrow.magnify('#email', { untilBlur: true })`. The viewer can read each keystroke. A password field shows dots. A search field that clears and keeps focus after a choice keeps its magnifier: call `walkArrow.stop()` when the entry is done, so it never covers the next target.
4. To show a result, point at it for a set time: `walkArrow.point('text=Saved', { text: 'The record is saved', duration: 3000 })`.
5. Call `walkArrow.stop()` before the step ends and before each screenshot. A screenshot shows the product alone.

With Playwright MCP, call each of these through `browser_evaluate`. With the library, use `page.evaluate`.

## Keep it professional

- Use the default `look: 'calm'` and the default colour. `look: 'bold'` is for marketing only.
- Show one arrow at a time. Use a second arrow only to join two things the narration names together.
- Write a sign of three to six words, in sentence case, with no exclamation mark. Name the action or the result: "Open AI agents", not "Click here!".
- Use `card` only for a step title or a value the viewer must copy. Keep its rows to three or fewer.
- Do not cover the thing you point at. Use `from` to move the sign to a side that is clear.
- Do not use `say`; the narration is the voice.

## The API

The header comment of `scripts/arrow.js` is the full reference. In short:

| Call | Result |
|---|---|
| `point(target, options)` | An arrow, a sign and a ring or box. Returns an id. |
| `card(options)` | A cue card with a title, a note and rows. A row can point at a target. |
| `magnify(target, options)` | An enlarged copy of a text field that follows each keystroke. |
| `stop(which)` | Removes all overlays, or one id, `'last'` or `{ group }`. |
| `wait(id)` | A promise of `{ id, reason }`: click, timeout, blur, stop or gone. |
| `plan(target, options)` | A dry run: where the arrow and sign go, with nothing drawn. |
| `elements()`, `doctor()` | The labels `text=` can match, and the viewport and live ids. |

A target is a CSS selector, `'text=<label>'`, an element, a point `{ x, y }`, a rectangle `{ x, y, w, h }`, `'mouse'` or `'viewport'`.

An error has the code `BAD_INPUT` or `NOT_FOUND`, and names the target and the page address. If `point` cannot find a label that the documentation names, the screen differs from the documentation. Report that as a fault in the documentation or the product. Do not point at a different control.

## Check the recording

Watch the recording before you publish it, or make a contact sheet of frames with `ffmpeg -i video.webm -vf fps=1,scale=320:-1,tile=6x4 grid.png`. Check that:

- each arrow tip meets its ring or box;
- each sign is inside the frame and does not cover its target;
- no overlay is left in a screenshot;
- the cursor pulse shows on each click.

## Credit

`arrow.js` does in a web page what bigarrow (github.com/franzenzenhofer/big-arrow-on-the-screen, MIT) does on a screen. The code is written from bigarrow's documented behaviour, not copied from it. The video kit ships this file to projects as `scripts/video-kit/arrow.js` for its arrow cues (the `video-scenes` skill); raise the kit's version in `skills/video-setup/scripts/kit.json` when it changes.

## The workflow

While a workflow runs, this skill is one step of the current stage. Commit each file that it changes with `mcp__ndev__checkpoint`, and read the next step with `mcp__ndev__status`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
