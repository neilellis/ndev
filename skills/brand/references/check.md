# /brand check and /brand apply

Both compare the project with its brand site. `check` changes nothing. `apply` does the same check, then fixes the project. Neither changes the brand site: when the project is right and the brand site is wrong, say so, and leave the brand site alone.

`B` is `branding.path`, and `P` is the project root. If the user's note names a folder or files, check only those.

## Check

### 1. Run the audit

```bash
node $S/audit.mjs --brand $B --json $P > <scratchpad>/brand-audit.json; echo "exit $?"
```

- Exit 2: nothing was checked, the brand site cannot be read, or the audit crashed. Show the message. It names the file or the repair. Stop.
- Any other exit except 0 and 1 is a failure of the command. Show stderr and stop.
- For a website, run it again with `--register marketing`, and give the folder that holds the page copy (for example `$P/app`) as the project, because page copy is marketing copy.
- Read the counts first. Group the findings by kind and file. Do not paste the full JSON.

The audit finds colour literals (`colour-literal` when a token has the same value, `off-brand-colour` with the nearest token when none has), font families outside the type tokens, banned words, and an unfinished brand site. A colour with transparency whose base is a token is a warning. `skipped-link` is a linked folder that the audit did not follow.

It does not check `hsl()`, `oklch()`, named colours or the `font` shorthand, so look for those in step 2. In scripts it reads only colours inside strings. A link fragment such as `"#add"` in a string can still look like a colour: check before you change it.

### 2. Review what a script cannot see

Take the brand site's pages as the rules. Look at the project for each item, with one bounded search for each:

| Area | Brand site page | What breaks it |
|---|---|---|
| Logo | Logo | Redrawn, stretched or recoloured logo; the name written another way |
| Type | Typography | Sizes, weights or line heights outside the scale; more than the allowed fonts |
| Space and layout | Layout, Responsive | Spacing values outside the scale; containers and breakpoints that differ |
| Components | Components, Page sections, UI kit | Buttons, links, cards or forms with other markup, radii or states than the brand classes |
| Depth and motion | Depth & motion, Animation | Shadows outside the elevation tokens; durations and easing outside the motion tokens; no `prefers-reduced-motion` |
| Accessibility | Accessibility | Text and background pairs below the contrast table; focus styles missing |
| Voice and copy | Voice, Copy, Banned words | Copy against the voice rules; banned words in text that the audit did not read (strings in `.ts` or `.tsx` content files) |
| Images | Photography, Iconography, Diagrams | Image styles, icon sets or diagram styles the brand does not use; photographs without credits |

### 3. Report

Give at most twelve lines. Put errors first: the kind, the count and the three worst places as `file:line`. Then the review findings, the warnings, and what you did not check. Say which findings `apply` fixes by itself and which need a decision. Then offer `/brand apply`.

## Apply

1. Run the check above.
2. Run `node $S/audit.mjs --brand $B --fix $P`. It replaces colours that equal a token with `var(--token)` in `.css` files only. Sass and Less colour functions need real colours, so it reports those and does not change them. Look at `git diff` for the result.
3. Fix the rest by hand, one kind at a time:
   - `colour-literal` in scripts and markup: use the token through the project's own route (a class, a CSS variable, or a Tailwind theme name). Do not add inline `var()` where the project uses classes.
   - `off-brand-colour`: use the nearest token when the difference is not visible (a distance under about 10). Otherwise the colour is a decision. List it and ask, or add it to the brand only if the user says so.
   - `colour-literal` in Sass or Less: use the Sass or Less variable that holds the token value. Use `var()` only where no colour function reads the value.
   - `colour-literal` warning (transparency): use the `color-mix()` that the finding names.
   - `off-brand-font`: use the brand font token.
   - `banned-word`: rewrite the sentence with the replacement that the finding names. Do not only swap the word.
   - Review findings: change the project to match the brand page that the finding names.
4. Run the audit again, then the project's own checks (tests, lint, build). Every fix must keep them passing.
5. Report the changes by kind with counts, the findings that remain and why, and the check results. Do not commit unless the user asks.
