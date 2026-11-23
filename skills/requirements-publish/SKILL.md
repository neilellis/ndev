---
name: requirements-publish
description: "Publish the requirement records to the project's documentation app as Markdown or MDX pages: an index, one page for each section with its narrative, and the records as JSON. Use after requirements-document, when publish --check fails, or when the user says publish the requirements, put the requirements in the docs or the docs site."
---

# Publish the requirements

The records, their format and their rules are in `${CLAUDE_PLUGIN_ROOT}/kb/requirements.md` (read "Publication"). Read it first.

The helper is `${CLAUDE_PLUGIN_ROOT}/scripts/requirements/requirements.mjs`. Run it with `node` from the project.

| Command | What it does |
|---|---|
| `requirements.mjs publish` | Writes the pages into the folder that `docs/formal/requirements/extra/publish.json` names. Removes the pages of the last publish that it no longer writes. |
| `requirements.mjs publish --check` | Fails when a page is missing, is not current or is left from the last publish. Writes nothing. |

## Set up

Do this one time for each project.

1. Find the documentation app: its content folder, its page format (`md` or `mdx`), the path at which it serves the pages, and the front matter that its own checks need on each page.
2. Choose a folder of its own for the pages, for example `<content>/requirements/formal`. The script refuses to overwrite a file that it did not write.
3. Write `docs/formal/requirements/extra/publish.json`. Show it to the human before you commit it.

```json
{
  "to": "apps/docs/content/requirements/formal",
  "format": "mdx",
  "route": "/requirements/formal",
  "source": "https://github.com/<owner>/<repo>/blob/main/",
  "frontMatter": { "wiki": ["{records}"] },
  "meta": "nextra"
}
```

4. Add the folder to the app's navigation when the app needs it. With `"meta": "nextra"`, the script writes `_meta.js` in the folder, in the order of the outline. The parent `_meta` file still needs an entry for the folder.

## Procedure

1. Run `requirements.mjs check` and `requirements.mjs narrative`. Fix each failure first: use the `requirements` and `requirements-document` skills.
2. Run `requirements.mjs publish`.
3. Run the documentation app's own checks and build. When a check fails on front matter, add the key to `frontMatter` in `publish.json`. Do not edit a published page: the next publish overwrites it.
4. Open the index and one section page in the app. Make sure that the links to the records, to the cited lines and between the pages go to the right place.
5. Run `requirements.mjs publish --check`. Stop when it passes.

## Finish

1. Commit `publish.json` and the published folder with the records.
2. Add `requirements.mjs publish --check` to the project's checks with `check`, `render --check` and `narrative`.
3. Report to the human: the folder, the number of pages, the app checks that you ran and their result, and each link that did not go to the right place.

The installer resolves `${CLAUDE_PLUGIN_ROOT}` to the shared ndev release folder for each harness. Use the installed absolute paths to run shared scripts.
