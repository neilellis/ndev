# Delight: meaningful motion

In a work tool, delight is motion that tells the reader something they want to know. It comes at the moment they want to know it, then gets out of the way. It is not decoration. Use this page to find the moments, judge each idea and pick the tool.

## Find the moments

Look for these moments in the interface. Each one has a pattern that usually fits.

| Moment | What the reader wants to know | Pattern |
|---|---|---|
| The reader's own action landed (save, copy, a saved setting) | "It worked, here" | **Confirm in place.** The control's label crossfades to "✓ Saved" for about 1.5 s, then back. The control keeps its width, so nothing around it moves. A failure does not animate; the error shows in text. |
| A long task makes progress (a step ends, a count goes up) | "It is moving" | **A change lands.** A connector or bar grows from its start with `scaleX` or `scaleY` (200–400 ms). An icon takes its new colour in about 200 ms. |
| The system starts or stops working | "Is it still busy?" | **Signal while working, then come to rest.** A loop runs only while the work runs. When the work stops, the loop finishes its cycle or pauses where it is. |
| Something changed while the reader looked away (a live row, a field a model filled, a new figure) | "What is new?" | **Highlight trace.** The new item takes a soft accent background, holds, then fades: up to 2 s, colour only. Mark only items new since the previous read, never the first load. |
| The system waits for the reader (a gate, a failed step) | "Is it my turn?" | **Your turn.** The one action enters with opacity and a 4 px rise. A polite live region names it. Focus does not move. |
| A node or row arrives in a graph or tree | "Where does it belong?" | **Grows from its neighbour.** It starts at its parent's or neighbours' position and settles there; it does not fly in from a corner. |
| A section opens | "Where did this come from?" | **Opens from its summary.** Opacity and a few pixels of movement in about 150 ms. Do not animate height. Closing is instant. |

## Judge each idea

Keep an idea only if all of these are true:

1. **It carries information.** Remove the motion: if the reader loses nothing, drop it.
2. **It survives the tenth view.** An action started from the keyboard does not animate. A frequent action (a hover, a toggle, a control used hundreds of times a day) changes only colour or opacity, in 150–200 ms or less. Larger movement is for something rare.
3. **It never blocks.** The reader can act during the animation. Nothing waits for it to finish. Interrupted, it reverses from its current value, not from its start.
4. **It keeps the element.** Change the control in place, so cause and effect stay together.
5. **It has a still version.** With reduced motion, the same information shows at once.
6. **It fits the brand.** Read the project's brand guide first (the `brand` skill); its durations and easing win.

Usually reject these in a work tool:

- a shake on an error;
- confetti or a celebration, because it implies a verdict;
- a rolling number for a cost or a count, because it hides the exact figure;
- a shimmer skeleton for a short wait;
- tabs or panels that slide or blur, and page transitions;
- beams, glows, sparkles and spotlights.

## Pick the tool

Use the lightest tool that does the job. Read each licence before you copy code, because licences change.

| Tool | Licence | Use |
|---|---|---|
| CSS: transitions on tokens, `@keyframes`, `@starting-style` (entry), `element.animate()` (Web Animations, from script), `::details-content` with `transition-behavior: allow-discrete` (disclosure), same-document View Transitions | Web platform | **First choice.** Reduced motion is one media query. Check browser support for the newer features, and make sure the fallback is "no animation", not "broken". |
| [Motion](https://motion.dev/docs) (`motion`, Motion for React) | MIT | When CSS cannot do it: exit animation, layout animation, values driven from script. A spring with `bounce: 0` does not overshoot; a spring with a bounce does, so use a tween with the brand's easing where overshoot is not allowed. |
| [Kokonut UI](https://kokonutui.com/) | MIT | Motion-rich components that shadcn/ui does not have (hold to confirm, progress rings). Installs through the shadcn registry, so the code becomes yours. Change it to the brand's tokens and rules before it ships. |
| [Motion Primitives](https://motion-primitives.com/) | MIT | Reference. Good ideas (text morph, animated number, transition panel), but bouncy springs by default and often no reduced-motion branch. Twenty lines of Motion usually do the same job. |
| [Magic UI](https://magicui.design/) | MIT | Reference, mostly for marketing pages. Many effects (beams, shine borders, particles) are decoration. |
| [Animate UI](https://animate-ui.com/) | MIT with Commons Clause | Reference. Animates Radix, Base UI and React Aria primitives. The Commons Clause limits redistribution. |
| [Aceternity UI](https://ui.aceternity.com/) | Proprietary: you cannot redistribute its source files | Visual reference only. Do not copy its code into a repository that is public or can become public. |
| [React Bits](https://reactbits.dev/) | MIT with Commons Clause | Usually avoid in a work tool: showcase effects that pull in rendering libraries such as `gsap`, `ogl` or `three`. |

## Audit existing motion

Use this when the user asks to review or improve the motion that a project already has. The audit is read-only until the user picks the fixes.

1. Map it: the motion library and its version, the motion tokens, and each animated surface. Search for `transition`, `@keyframes`, `animate=`, `motion.`, `ease-in`, `transition-all`, `scale(0)` and `prefers-reduced-motion`.
2. Give each surface a frequency: keyboard or hundreds a day, tens a day, occasional (a dialog, a toast), rare (first run). Frequency sets the severity.
3. Check each surface against this page and the motion skill. Read the code at each `path:line` again before you report it. Do not report a decision that the brand guide or a design note records.
4. Rate each finding. High: it breaks the feel (`ease-in` on an entry or a response, motion on a keyboard action, dropped frames, `scale(0)`). Medium: it is visibly wrong (wrong origin, a restart when interrupted, no reduced-motion branch). Low: polish (duplicate tokens, stagger).
5. Report one table, ordered by impact against effort, with the fix and its exact values on each row. Below it, list at most four places that must animate and do not, and the candidates you rejected, each with its reason. "Nothing to change" is a valid result.

## Review checklist

Before a motion change leaves draft:

- [ ] Each animation names its moment and the information it carries.
- [ ] Durations and easing come from the brand's tokens, not literal values. Entries and responses ease out, and no entry eases in. Each exit is shorter than its entry.
- [ ] Only `transform`, `opacity` and colour animate. No `width`, `height`, `filter: blur()` or `clip-path` on a frequent path. No `transition: all` and no animated `box-shadow`.
- [ ] Each element scales from its trigger or its centre, never from `scale(0)`. An interrupted animation reverses from where it is.
- [ ] Nothing animates on first paint or on mount, only on a change.
- [ ] A loop runs only while its work runs, and comes to rest when it stops.
- [ ] Each animated component has its own reduced-motion branch, and the still version carries the same information.
- [ ] Focus never moves because of an animation, and a removed item hands focus to a neighbour.
- [ ] Screen readers get the change once, through an existing live region; one message per step does not flood them.
- [ ] Screenshots at rest, in motion and with reduced motion, at desktop and mobile widths. Each animation watched at one fifth speed.
