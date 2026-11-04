# Kokonut UI

[Kokonut UI](https://kokonutui.com/) is a free (MIT) set of React components built on shadcn/ui, Tailwind and Motion. Its components install through the shadcn registry, so the code lands in the repository and the project owns it. Use it as a source of motion-rich interaction patterns that shadcn/ui does not have. Do not use it as a design system.

## When it fits

Take a component only when it improves a real interaction. Compare each control in the UI with the catalogue, and record the decision for each one: used, or left out and why.

| Interaction | Good fit | Why |
|---|---|---|
| Any delete or destructive action (delete, reset, delete all) | Hold button | Holding for 1 to 2 s is a clearer guard than a second click. |
| Progress against targets | Apple activity card | Rings show several ratios at a glance, for example steps done and questions answered. |
| A live count on a dashboard | Number ticker (`smooth-number` and similar) | A changing number reads as live. |
| A command search over many actions | Action search bar | It suits a long list of actions, not three buttons. |
| Upload with real feedback | File upload | Use it only when it is wired to the real pipeline and its errors. |

Usually leave out:
- glass, liquid and gradient-text effects in a work area;
- animated placeholders that hide real state, such as a typing effect over a streamed model reply;
- card stacks and bento grids for long text;
- a component whose value is its demo data.

## Install

1. Run `npx shadcn@latest add https://kokonutui.com/r/<name>.json`. The registry is `https://kokonutui.com/r/<name>.json`, and the names are on each component's page.
2. Add `motion` (Motion for React) if the project does not have it.
3. Read the diff before you commit. The registry can add a `cn` package as a dependency. Remove it and use the project's own `cn` (for example `@/lib/utils`). Remove the demo content.
4. Put the files in their own folder (for example `components/kokonut/`). Add the MIT notice (`LICENSE.kokonut.md`) and a README that lists each file, its upstream name and version, and what it is used for.
5. Keep each file's upstream header, and add a "Changed for <project>" list under it.

## Adapt

- Map the colours to the project's tokens (accent and its scale), not Tailwind palette names, so that the light and dark themes both work.
- Feed the component real data, and clamp values to their targets.
- Respect `prefers-reduced-motion`.
- Give every gesture a keyboard path and a path for assistive technology. A hold button is the common case: a screen reader or voice control sends one click with `event.detail === 0`. Let that click arm the button and say so ("Activate again to …"). A second activation within a few seconds confirms. A mouse click (`detail >= 1`) must never confirm. A held Enter or Space key counts as a hold.
- Write component tests for the guard: a mouse click does not complete; two assistive-technology clicks do; the armed state times out; a held key completes; a key released early does not.

## Test in a DOM emulator

Motion uses the Web Animations API when it exists. Emulators such as happy-dom have a partial one, and they reject a cancelled animation's promise that nothing awaits. In the test file, delete `Element.prototype.animate` and `HTMLElement.prototype.animate`. Then import the component with a dynamic `import()`, so that Motion animates with JavaScript.
