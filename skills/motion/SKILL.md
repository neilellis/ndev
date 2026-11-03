---
name: motion
description: "Add animation to a React or Next.js site with the Motion library (formerly Framer Motion): scroll reveals, hover and tap effects, enter and exit transitions, with reduced-motion support. Use when the user asks to animate a page or component, add Motion or Framer Motion, make a site feel more alive, or add delight or microanimations to a UI."
---

# Animate with Motion

Movement must feel calm and professional. Use `work-light` for the change and `testing` for the checks.

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`) before you add movement. Follow its motion pages: durations, easing, and what can move. Where they differ from the rules below, the guide wins. Otherwise skip this section.

## Choose the moment, then the tool

Delight is motion that tells the reader something: their action landed, the work moves, something changed, it is their turn. Start from those moments, not from a library's catalogue. [references/delight.md](references/delight.md) lists the moments and their patterns, the tests each idea must pass, a verdict and licence for each library, and a review checklist.

- Use CSS first: transitions on the brand's tokens, `@starting-style` for entries, `::details-content` for disclosures. Use Motion only where CSS cannot do the job.
- Before you install or write a component, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` and choose it from there.
- For a motion-rich control that shadcn/ui lacks (hold to confirm, a progress ring), look at [Kokonut UI](https://kokonutui.com/) (MIT). It installs through the shadcn registry. Change its timing and colours to the brand before it ships.
- Use [Aceternity UI](https://ui.aceternity.com/), Magic UI and Motion Primitives to study purpose, timing and state changes. Adapt the idea to the project's brand and content. Aceternity's licence does not allow its source files to be redistributed, so copy no code from it.
- Use Motion’s official docs to check supported APIs, accessibility and performance. Check the installed version before adopting an API.
- For glass effects, read [Liquid Glass](https://ui.aceternity.com/components/liquid-glass). Check browser support, text contrast and reduced transparency.
- Record the chosen pattern, its trigger and its reduced-motion behaviour in the project’s brand guide when it has one.

## Set up

- Import from `motion/react`. Never import from `framer-motion` directly.
- In a Next.js App Router project, start any file that uses `motion.*`, `m.*`, `AnimatePresence`, `useReducedMotion`, `useInView` or `useScroll` with `"use client"`.
- Keep animated parts as small leaf client components. Do not turn a whole page into a client component. If the project requires static pages (for example, a build check that a page stays static), keep all animated parts in leaf client components on those pages.
- Pin `motion` to an exact version in `package.json`.
- On a page that had no Motion before, use `LazyMotion` with `domAnimation` and the `m` component to keep the bundle small. Use `motion` only when a feature needs it, and say why.

## Write the animation

- Animate `opacity` and `transform` only. Do not animate layout properties on large sections.
- Use `whileInView` with `viewport={{ once: true }}` for scroll reveals. Use `whileHover` and `whileTap` for interaction. Use `AnimatePresence` for mount and unmount.
- Keep durations short, approximately 0.3 to 0.8 seconds, with gentle easing. Keep feedback for an action at 150–200 ms.
- Where the brand forbids overshoot, use a tween with the brand's easing. Springs, the default in many component libraries, can overshoot.
- Animate a value when it changes, not when the component mounts. A chart that redraws from zero each time its tab opens becomes noise.
- When looping motion stops because its work stopped, let it finish the cycle or pause it. Do not snap it back with `animation: none`.
- Give decorative animated elements `aria-hidden="true"`.

## Respect reduced motion

- Call `useReducedMotion()` in each animated component and give it a still state. `<MotionConfig reducedMotion="user">` alone is not enough: it turns off transform and layout animation, but opacity still animates and values driven by `useSpring` or `animate()` keep moving.
- Keep a version with no movement that is fully readable.
- Content must show without JavaScript. Use `initial={false}` where content must be visible on first paint. Use a hidden initial state only on decoration.

## Check

1. Take screenshots of each changed page with reduced motion on and with reduced motion off, at desktop and mobile widths. Look at each one: all content shows, and nothing overlaps or stays hidden. In Orca's browser, `orca set media --reduced-motion reduce --page <id>` sets reduced motion until you change it, and `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh` takes the screenshots.
2. Make sure that the browser console shows no errors.
3. Run the project's precheck, or let CI run it. If the project requires static pages, make sure that they are still static.

## Common mistakes

- No `"use client"` on a file that uses Motion.
- A whole page imported as a client component.
- Content hidden by an initial state with no fallback, so it stays invisible if JavaScript fails.
- `Date` or `window` read during render, which causes hydration mismatches. Read them in `useEffect`.
- Width, height or position animated on a large section.
- Motion left on for people who asked for less.
- A `filter: blur()` or `clip-path` animation on a control used many times a day.
- Decoration that runs all day: a loop that does not stop when the work stops.
