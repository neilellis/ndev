---
name: motion
description: "Add animation to a React or Next.js site with the Motion library (formerly Framer Motion): scroll reveals, hover and tap effects, enter and exit transitions, with reduced-motion support. Use when the user asks to animate a page or component, add Motion or Framer Motion, or make a site feel more alive."
---

# Animate with Motion

Movement must feel calm and professional. Use `work-light` for the change and `testing` for the checks.

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`) before you add movement. Follow its motion pages: durations, easing, and what can move. Where they differ from the rules below, the guide wins. Otherwise skip this section.

## Animation references

Before designing animation, review [Aceternity UI](https://ui.aceternity.com/) for interaction ideas and [Motion](https://motion.dev/docs) for implementation guidance.

- Use Aceternity examples to study purpose, timing and state changes. Adapt them to the project’s brand and content.
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
- Keep durations short, approximately 0.3 to 0.8 seconds, with gentle easing.
- Give decorative animated elements `aria-hidden="true"`.

## Respect reduced motion

- Use `useReducedMotion()` or put the animated part in `<MotionConfig reducedMotion="user">`.
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
