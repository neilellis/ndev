---
name: copy
description: Write or review any {{name}} text, including website and film copy, guide pages, labels, errors, agent files and skills. Use the banned list and add new tells to it.
---

# Copy

Read these pages before you write. They are the standard.

- `app/copy/page.mdx`: the writing rules for all text.
- `app/voice/page.mdx`: the voice, mechanics, claims and calls to action for marketing copy.
- `app/copy/simple-english/page.mdx`: simple English for documentation and agent text.
- `app/copy/banned/page.mdx` and `public/ds/copy/banned.json`: the banned words and sentence patterns.
- `app/copy/checklist/page.mdx`: the checks to do before you share text.

## Rules

1. Choose the register first: internal, marketing, documentation, technical documentation or agent. Marketing follows the Voice page. Documentation, technical documentation and agent text follow the simple English page. Agent text includes agent files, skills and prompts. Technical documentation can use common technical terms, not business jargon.
2. Lead with the answer. Write one idea per sentence. Use British English and sentence case.
3. Do not make a claim stronger when you make it plainer. Keep every condition and limit.
4. Do not invent statistics, quotes, testimonials or client results.
5. Run the copy check on each file you change. Give the register with `--register`. The default is `documentation`.

```bash
node scripts/copy/check.mjs <file>...
node scripts/copy/check.mjs --register agent <file>...
```

6. Fix each **BANNED** result. Look at each **check** result and keep the word only when it carries a fact.
7. Do not hide a result with quotation marks or markers. Use curly quotes only for a real quoted example. Use the `copy-check: marketing` markers only for approved source copy.

## Keep the list current

When you find a new word, phrase or pattern that makes {{name}} text worse, add it to `public/ds/copy/banned.json` in the same pull request. Follow the steps on the banned words page. Use the source `house`. Then run `node scripts/copy/vale.mjs --write` to rebuild the Vale rules in `public/ds/copy/vale/`. The tests fail if the Vale rules do not match the list. If a new `ban` entry finds the word in existing pages, fix those pages in the same pull request.

`npm test` checks every guide page as documentation, the README as technical documentation, and the agent files and skills as agent text. The build fails on a banned word.
