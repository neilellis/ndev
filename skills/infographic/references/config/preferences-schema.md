# Optional infographic preferences

Store YAML frontmatter in `EXTEND.md` at a location listed in the skill. These are defaults; current user instructions take precedence.

```yaml
---
version: 1
preferred_layout: bento-grid
preferred_style: craft-handmade
preferred_aspect: landscape
language: en
preferred_image_backend: auto
custom_styles:
  - name: my-brand
    description: Warm brand palette
    prompt_fragment: Use warm pastel colours and rounded forms.
---
```

All fields except `version` may be omitted. Layout and style names correspond to files in `references/layouts/` and `references/styles/`; custom styles add a unique name, description and prompt fragment.

`preferred_aspect` accepts landscape (`16:9`), portrait (`9:16`), square (`1:1`) or a custom W:H ratio. `language` is the output language, inferred when absent.

`preferred_image_backend: auto` selects an available native tool. A named available backend expresses a preference; `ask` requests a backend choice. Do not launch a separate agent CLI because a saved backend is unavailable. Use the active runtime's tool instructions.
