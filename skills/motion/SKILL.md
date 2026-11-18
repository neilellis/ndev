---
name: motion
description: "Add, audit or fix animation in a React or Next.js site with the Motion library (formerly Framer Motion): scroll reveals, hover and tap effects, enter and exit transitions, drag and swipe, with reduced-motion support. Use when the user asks to animate a page or component, add Motion or Framer Motion, make a site feel more alive, add delight or microanimations, or says that motion stutters, feels slow, feels static or that too much moves."
---

# Animate with Motion

For the project’s `NORTH_STAR.md`, follow `${CLAUDE_PLUGIN_ROOT}/kb/north-star.md`. Use this check if motion affects an interaction or accessibility rule of the project.

Movement must feel calm and professional. Use `work-light` for the change and `testing` for the checks.

If `.neil-dev.json` at the project root (`git rev-parse --show-toplevel`) has `branding`, read `branding.guide` (or else `branding.site`) before you add movement. Follow its motion pages: durations, easing, and what can move. Where they differ from the rules below, the guide wins. Otherwise skip this section.

## Choose the moment, then the tool

Delight is motion that tells the reader something: their action landed, the work moves, something changed, it is their turn. Start from those moments, not from a library's catalogue. [references/delight.md](references/delight.md) lists the moments and their patterns, the tests each idea must pass, a verdict and licence for each library, an audit method for existing motion, and a review checklist.

- For existing motion, first name the problem: wrong, missing or too much. Audit it read-only with "Audit existing motion" in [references/delight.md](references/delight.md) before you change code.
- When the user describes an effect loosely ("make it pop", "a smooth slide"), name it in standard terms (property, trigger, duration, easing) and confirm that name before you build it.
- Use CSS first: transitions on the brand's tokens, `@starting-style` for entries, `::details-content` for disclosures. Use Motion only where CSS cannot do the job. For the CSS detail (`@starting-style`, `transition-behavior: allow-discrete`, view transitions, scroll-driven animation), read the guide in `modern-web-guidance`. Where it differs from the rules here, these rules win.
- Before you install or write a component, read `${CLAUDE_PLUGIN_ROOT}/kb/ui-components.md` and choose it from there.
- For a motion-rich control that shadcn/ui lacks (hold to confirm, a progress ring), look at [Kokonut UI](https://kokonutui.com/) (MIT). It installs through the shadcn registry. Change its timing and colours to the brand before it ships.
- Use [Aceternity UI](https://ui.aceternity.com/), Magic UI and Motion Primitives to study purpose, timing and state changes. Adapt the idea to the project's brand and content. Aceternity's licence does not allow its source files to be redistributed, so copy no code from it.
- Use Motion’s official docs to check supported APIs, accessibility and performance. Check the installed version before adopting an API.
- For glass effects, read [Liquid Glass](https://ui.aceternity.com/components/liquid-glass). Check browser support and text contrast. Do not put a translucent surface on another translucent surface. Under `prefers-reduced-transparency: reduce`, make the surface solid with no blur. Under `prefers-contrast: more`, use a solid background and a border.
- Record the chosen pattern, its trigger and its reduced-motion behaviour in the project’s brand guide when it has one.

## Set up

- Import from `motion/react`. Never import from `framer-motion` directly.
- In a Next.js App Router project, start any file that uses `motion.*`, `m.*`, `AnimatePresence`, `useReducedMotion`, `useInView` or `useScroll` with `"use client"`.
- Keep animated parts as small leaf client components. Do not turn a whole page into a client component. If the project requires static pages (for example, a build check that a page stays static), keep all animated parts in leaf client components on those pages.
- Pin `motion` to an exact version in `package.json`.
- On a page that had no Motion before, use `LazyMotion` with `domAnimation` and the `m` component to keep the bundle small. Use `motion` only when a feature needs it, and say why.

## Write the animation

- Animate `opacity` and `transform` only, and name each property: never `transition: all`. Use `scale()` and `translate()` in place of `width`, `height`, `top` or `left`. Enter from `scale(0.95)` with opacity 0, never from `scale(0)`. A popover scales from its trigger (keep the Radix origin class); a dialog scales from its centre.
- Use `whileInView` with `viewport={{ once: true }}` for scroll reveals, on one or two key elements of a marketing page and on none in product UI. Use `whileHover` and `whileTap` for interaction. Use `AnimatePresence` for mount and unmount, with a stable `key` on each child. For a list removal, use `mode="popLayout"` (the child forwards its ref) with `layout` on the siblings, so they close the gap. When an exit depends on data that changes (a direction), pass `custom` to both `AnimatePresence` and the child.
- Keep action feedback at the user’s current point of attention: animate or change the control they used, or the affected content beside it. Do not make a distant notification the only sign that something happened. Show press feedback at once on pointer down, and commit on release. Start the change in the input handler, in the same frame: set the pressed, pending or optimistic state first, then `await`.
- Do not animate what the keyboard opens or moves (a command palette, list focus, a shortcut).
- Take durations from the brand's tokens. Without tokens, keep small controls under 300 ms: feedback 150–200 ms; tooltips, menus and popovers 150–250 ms. Dialogs, drawers and toasts take up to 400 ms, and scroll reveals on content pages up to 800 ms. An exit is shorter than its entry.
- Take easing from the brand. Without it, use ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`) to enter and to respond, ease-in-out to move on screen, `linear` only for progress, spinners and marquees, and ease-in only for an exit, never for an entry or a response.
- Use springs with `bounce: 0` by default. After a gesture, the spring takes the release velocity. Use a bounce of 0.2 or less only after momentum and where the brand allows overshoot; otherwise use a tween with the brand's easing.
- A state that can reverse part-way (hover, open, toggle) uses a transition or Motion, not `@keyframes`, so it reverses from where it is. It exits along the path it entered by.
- Give each container one entrance. Do not reverse the stagger on exit.
- Drive per-frame values with motion values or CSS, never React state. Run a side effect at a threshold once, not on each frame. `layout`, `layoutId`, drag and `useTransform` run on the main thread, so they stutter while the page is busy.
- Animate a value when it changes, not when the component mounts. A chart that redraws from zero each time its tab opens becomes noise. Give numbers that change in place `tabular-nums`, so the digits do not shift.
- When looping motion stops because its work stopped, let it finish the cycle or pause it. Do not snap it back with `animation: none`.
- Give decorative animated elements `aria-hidden="true"`.

## Drag and swipe

- Choose in this order: the component map (shadcn `drawer`, Dice UI `sortable` and `kanban`), then the native scroll-snap guides in `modern-web-guidance` (`swipe-to-remove`, `swipe-to-reveal`, `navigation-drawer`), then a Motion drag. Native scrolling gives momentum, snap-back and interruption at no cost.
- While the pointer is down, the element follows it 1:1, from a `useMotionValue` or a `transform` on the element itself. Do not use a spring, a transition or a React state update while it tracks. At a boundary, resist (`dragElastic` about 0.2); do not stop dead.
- Derive linked values (overlay opacity, the scale of the page behind) from the same motion value with `useTransform`, so they do not drift apart when the user reverses.
- On release, dismiss when the offset passes about 40 % of the travel or the velocity passes about 500 px/s, so a short flick also works. Dismiss along the axis the element entered on; otherwise snap back. A close from a button has no bounce.

## Respect reduced motion

- Call `useReducedMotion()` in each animated component and give it a still state. `<MotionConfig reducedMotion="user">` alone is not enough: it turns off transform and layout animation, but opacity still animates and values driven by `useSpring` or `animate()` keep moving.
- Keep a version with no movement that is fully readable. Remove translation, scale, parallax and overshoot. A short opacity or colour change can stay. Keep 1:1 drag tracking, because the user makes that movement.
- Content must show without JavaScript. Use `initial={false}` where content must be visible on first paint. Use a hidden initial state only on decoration.

## Check

1. Take screenshots of each changed page with reduced motion on and with reduced motion off, at desktop and mobile widths. Look at each one: all content shows, and nothing overlaps or stays hidden. In Orca's browser, `orca set media --reduced-motion reduce --page <id>` sets reduced motion until you change it, and `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh` takes the screenshots.
2. Watch each animation at one fifth speed: `orca eval --page <id> --expression 'setInterval(() => document.getAnimations().forEach(a => { a.playbackRate = 0.2 }), 16)'`, or the DevTools Animations panel. This slows CSS and Web Animations only, not Motion values driven from script. Look for the wrong origin, a jump at the start or end, and parts that drift apart.
3. Test each gesture on a real phone that opens the dev server at the computer's local IP address. Emulators and Orca's browser have no real touch, and a 60 Hz monitor hides stutter that a 120 Hz screen shows.
4. If motion stutters, name the cause in this order: an animated property other than `transform` or `opacity`; a busy main thread; React renders on each frame; a cost that grows with the content; and only then `will-change`. Record a performance trace on a mid-range phone: a frame has 16.7 ms at 60 Hz and 8.3 ms at 120 Hz. Mark each finding as verified by a trace or as needing one. The `modern-web-guidance` performance guides give the fixes.
5. Make sure that the browser console shows no errors.
6. Run the project's precheck, or let CI run it. If the project requires static pages, make sure that they are still static.

## Common mistakes

- No `"use client"` on a file that uses Motion.
- A whole page imported as a client component.
- Content hidden by an initial state with no fallback, so it stays invisible if JavaScript fails.
- `Date` or `window` read during render, which causes hydration mismatches. Read them in `useEffect`.
- Width, height or position animated on a large section.
- Motion left on for people who asked for less.
- A `filter: blur()` or `clip-path` animation on a control used many times a day. Where blur is needed, keep it at 2–5 px.
- An animated `box-shadow`. Fade the opacity of a `::after` that carries the shadow.
- A CSS hover effect not inside `@media (hover: hover) and (pointer: fine)`, so it sticks after a tap.
- `will-change` added before a stutter was seen and measured.
- A CSS variable on a parent changed on each frame, which restyles every descendant.
- An entry animation on the rows of a virtualised list, which replays as the reader scrolls.
- A sequence that breaks when it starts again before it ends.
- A half-done removal: the animation went, but its start state or a wait for `onAnimationEnd` stayed.
- Decoration that runs all day: a loop that does not stop when the work stops.
- A pulse, ping or shimmer on an element that is not live or loading (except the one Shimmer CTA that `kb/ui-components.md` allows in a marketing hero), or a `hover:scale` on a card. A hover is a colour or surface change.

## The workflow

To get an animation idea for one function, call `mcp__ndev__iNeedA('animation', description)`. The guide is `${CLAUDE_PLUGIN_ROOT}/kb/workflow.md`.
