# Skill index

Choose a skill by the task below. The installer exposes each source folder as `ndev-<name>` in Claude, Codex, opencode and Antigravity. Claude uses `/ndev-<name>`; Codex uses `$ndev-<name>`. Start a new session after reinstalling to refresh discovery.

Work skills carry the brief project-guidance reminder. Specialist skills do not repeat it.

## Choose between related skills

| Task | Entry point and boundary |
|---|---|
| A focused fix or small feature | `work-light` is the default; `work-heavy` adds planning and staged review for larger or risky changes. `work-hack` explores before hardening. `work-interactive` settles an underspecified idea. |
| A set of issues | `triage` groups issues; `goal-work` handles a named set; the auto work skills handle Ready-board passes. `epic-plan` specifies an epic; `epic-coordinate` delivers its slices. |
| Finish a change | `finish` prepares an app PR; `publish` handles an explicitly requested publication. The video counterparts check scenes and playback. `merge` handles a PR and its migrations. Follow the repository’s merge approval rules. |
| A release | `cut-release` builds notes from changes and handles draft assets; `milestone-release-notes` writes notes for the people who use the product; `milestone-release` publishes an existing committed notes file. |
| A diagram | `archify` validates five technical diagram types from a typed specification; `diagram-design` covers custom layouts and other chart types; `infographic` makes raster artwork. |
| Check a website | `responsive-check` owns the viewport/theme matrix and quick mobile screenshots. `site-check` checks links and runtime errors. `browser-arrows` annotates screenshots. |
| Documentation | `docs` is the entry point; `doc-coverage` finds gaps; `docs-sync` reconciles source changes; `docs-legibility` checks comprehension; `docs-team` coordinates a whole site. |
| Knowledge | `requirements` searches, writes and checks the requirement records (what the system must do); `requirements-find` finds the requirements in the project's documents and accounts for each line; `requirements-model` writes a Quint model with its manifest and checks it against the code; `requirements-retrospective` traces each merged pull request to a record; `requirements-document` writes the prose of the generated document; `requirements-publish` publishes the records to the documentation app; `requirements-retire` retires a prose document that the records replace; `requirements-deprecate` deprecates a record that is obsolete or replaced; `adr-pdr` searches and writes the decision records (ADRs for design, PDRs for requirement amendments); `remember` records project facts; `dev-wiki` records reusable lessons; `forget` removes false claims; `wiki-lint` checks structure and evidence. |

## Consolidated entry points

| Previous skill | Use now |
|---|---|
| `i` | `issue` |
| `r` | `remember` |
| `mobile-testing` | `responsive-check`, with [quick mobile capture](responsive-check/references/mobile-screenshots.md) |
| `for-codex` | `ndev install codex` and `ndev install verify codex` |

Reinstall removes unchanged files owned by the previous install manifest. It preserves unrelated skills and hooks, and refuses retirement of locally changed files. Review `--dry-run` before installing. There is no need to delete a skill tree or uninstall other plugins. Empty retired directories contain no discoverable skill.

The sections below cover every source skill once. Keep this index current when adding or retiring a skill. Specialist instructions, references and scripts stay together in the owning folder. The groups do not create additional discovery entries.

## Development

- [work-light](work-light/SKILL.md)
- [work-heavy](work-heavy/SKILL.md)
- [work-hack](work-hack/SKILL.md)
- [work-interactive](work-interactive/SKILL.md)
- [implement-spec](implement-spec/SKILL.md)
- [interview](interview/SKILL.md)
- [testing](testing/SKILL.md)
- [database](database/SKILL.md)
- [resolving-merge-conflicts](resolving-merge-conflicts/SKILL.md)
- [command-reuse](command-reuse/SKILL.md)
- [ast-grep](ast-grep/SKILL.md)
- [hyperfine](hyperfine/SKILL.md)
- [perf-review](perf-review/SKILL.md)
- [deadcode](deadcode/SKILL.md)

## Issues and orchestration

- [cli](cli/SKILL.md)
- [issue](issue/SKILL.md)
- [github](github/SKILL.md)
- [triage](triage/SKILL.md)
- [epic-plan](epic-plan/SKILL.md)
- [epic-coordinate](epic-coordinate/SKILL.md)
- [multi-epic-triage](multi-epic-triage/SKILL.md)
- [goal-work](goal-work/SKILL.md)
- [work-light-auto](work-light-auto/SKILL.md)
- [work-heavy-auto](work-heavy-auto/SKILL.md)
- [pick-up-prs](pick-up-prs/SKILL.md)
- [fix-all-prs](fix-all-prs/SKILL.md)

## Review and delivery

- [adversarial-review](adversarial-review/SKILL.md)
- [second-opinion](second-opinion/SKILL.md)
- [fix-ci](fix-ci/SKILL.md)
- [ci-server](ci-server/SKILL.md)
- [finish](finish/SKILL.md)
- [publish](publish/SKILL.md)
- [merge](merge/SKILL.md)
- [cut-release](cut-release/SKILL.md)
- [milestone-release](milestone-release/SKILL.md)
- [milestone-release-notes](milestone-release-notes/SKILL.md)
- [reset](reset/SKILL.md)
- [hotfix](hotfix/SKILL.md)
- [are-we-done](are-we-done/SKILL.md)
- [report-work-done](report-work-done/SKILL.md)
- [retro](retro/SKILL.md)
- [improve-agent](improve-agent/SKILL.md)
- [project-analysis](project-analysis/SKILL.md)

## Documentation and knowledge

- [docs](docs/SKILL.md)
- [doc-coverage](doc-coverage/SKILL.md)
- [docs-sync](docs-sync/SKILL.md)
- [docs-legibility](docs-legibility/SKILL.md)
- [docs-team](docs-team/SKILL.md)
- [wiki-lint](wiki-lint/SKILL.md)
- [clean-reader](clean-reader/SKILL.md)
- [adr-pdr](adr-pdr/SKILL.md)
- [requirements](requirements/SKILL.md)
- [requirements-find](requirements-find/SKILL.md)
- [requirements-model](requirements-model/SKILL.md)
- [requirements-retrospective](requirements-retrospective/SKILL.md)
- [requirements-document](requirements-document/SKILL.md)
- [requirements-publish](requirements-publish/SKILL.md)
- [requirements-retire](requirements-retire/SKILL.md)
- [requirements-deprecate](requirements-deprecate/SKILL.md)
- [remember](remember/SKILL.md)
- [forget](forget/SKILL.md)
- [dev-wiki](dev-wiki/SKILL.md)
- [harness-sync](harness-sync/SKILL.md)

## Design and browser checks

- [brand](brand/SKILL.md)
- [copy](copy/SKILL.md)
- [ux-principles](ux-principles/SKILL.md)
- [modern-web-guidance](modern-web-guidance/SKILL.md)
- [motion](motion/SKILL.md)
- [responsive-check](responsive-check/SKILL.md)
- [site-check](site-check/SKILL.md)
- [browser-arrows](browser-arrows/SKILL.md)
- [react-grab](react-grab/SKILL.md)
- [archify](archify/SKILL.md)
- [diagram-design](diagram-design/SKILL.md)
- [infographic](infographic/SKILL.md)

## Video

- [video-workflow](video-workflow/SKILL.md)
- [video-setup](video-setup/SKILL.md)
- [video-types](video-types/SKILL.md)
- [video-how-to](video-how-to/SKILL.md)
- [video-explainer](video-explainer/SKILL.md)
- [video-marketing](video-marketing/SKILL.md)
- [video-scenes](video-scenes/SKILL.md)
- [video-images](video-images/SKILL.md)
- [video-narration](video-narration/SKILL.md)
- [video-podcast-effect](video-podcast-effect/SKILL.md)
- [video-render-review](video-render-review/SKILL.md)
- [video-docs](video-docs/SKILL.md)
- [video-finish](video-finish/SKILL.md)
- [video-publish](video-publish/SKILL.md)

## Conversation

- [i-have-adhd](i-have-adhd/SKILL.md)
- [what-do-you-need](what-do-you-need/SKILL.md)
