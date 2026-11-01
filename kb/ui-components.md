# UI components

[kb](README.md) › ui-components

**Take each UI component from an approved source before you write one.** This page lists the approved sources and maps each component type to one registry item. It also gives the rules that make all sources look like one product.

## The rule

- Take a component from an approved source before you write a new one. Write your own only when no row in the [component map](#component-map) fits.
- Install only with the shadcn CLI or the source's own registry: `npx shadcn@latest add <name or registry URL>`. Do not copy code from a demo page or a gist.
- Put a comment at the top of each installed file that names the source, the registry item and the date. For example: `// From Kokonut UI hold-button (https://kokonutui.com/r/hold-button.json), 2026-11-01. Changed for <project>: …`. A component you write yourself gets `// Own component: <why no row of the component map fits>.` instead. Enforce it in the project with `node ${CLAUDE_PLUGIN_ROOT}/scripts/ui/component-sources.mjs <component folders>` (in a test or CI step); it fails on a file without either line, on a source that is not approved, and on a URL that is not that source's host.
- Take a component only when it improves a real interaction. Record the decision for each control: used, or left out and why.
- The project's own design system comes first. If the project already has a component for the type, use it. Follow the project's primitive family (Radix or Base UI).

## Approved sources

Numbers measured on 2026-11-01 with `gh api repos/OWNER/REPO`. "Items" is the count of entries in the source's registry index on that date, demos included. The index URL gives the full list.

| Source | Site | Repository | Stars | Last push | Licence | Install | Items (index) | Best at |
|---|---|---|---|---|---|---|---|---|
| shadcn/ui | [ui.shadcn.com](https://ui.shadcn.com) | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | 127,121 | 2026-10-31 | MIT | `npx shadcn@latest add <name>` | [65](https://ui.shadcn.com/r/index.json) | The default. Primitives for forms, overlays, menus, navigation, tables and charts. |
| Magic UI | [magicui.design](https://magicui.design) | [magicuidesign/magicui](https://github.com/magicuidesign/magicui) | 23,024 | 2026-10-31 | MIT | `npx shadcn@latest add https://magicui.design/r/<name>.json` | [250](https://magicui.design/r/registry.json) | Motion for marketing pages: backgrounds, marquees, number tickers, beams. |
| Plate | [platejs.org](https://platejs.org) | [udecode/plate](https://github.com/udecode/plate) | 16,685 | 2026-11-01 | MIT (licence file; GitHub reports NOASSERTION) | `npx shadcn@latest add https://platejs.org/r/<name>.json` | [324](https://platejs.org/r/registry.json) | Rich text editing. |
| assistant-ui | [assistant-ui.com](https://www.assistant-ui.com) | [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | 12,887 | 2026-11-01 | MIT | `npx shadcn@latest add https://r.assistant-ui.com/<name>.json` | [174](https://r.assistant-ui.com/registry.json) | Chat threads with streaming, branches and tool calls. |
| coss ui (formerly Origin UI) | [coss.com/ui](https://coss.com/ui) | [cosscom/ui](https://github.com/cosscom/ui) | 10,778 | 2026-10-31 | MIT (licence file; GitHub reports NOASSERTION) | `npx shadcn@latest add https://coss.com/ui/r/<name>.json` | [606](https://coss.com/ui/r/registry.json) | Base UI primitives that shadcn/ui lacks: number field, autocomplete, composer. |
| Cult UI | [cult-ui.com](https://www.cult-ui.com) | [nolly-studio/cult-ui](https://github.com/nolly-studio/cult-ui) | 6,890 | 2026-10-29 | MIT | `npx shadcn@latest add https://www.cult-ui.com/r/<name>.json` | [307](https://www.cult-ui.com/r/registry.json) | Small utility controls, such as the copy button. |
| tablecn | [tablecn.com](https://tablecn.com) | [sadmann7/tablecn](https://github.com/sadmann7/tablecn) | 6,367 | 2026-11-01 | MIT | `npx shadcn@latest add https://tablecn.com/r/<name>.json` | [15](https://tablecn.com/r/registry.json) | Server-side data tables and editable data grids. |
| Kibo UI | [kibo-ui.com](https://www.kibo-ui.com) | [shadcnblocks/kibo](https://github.com/shadcnblocks/kibo) | 3,977 | 2026-05-04 | MIT | `npx shadcn@latest add https://www.kibo-ui.com/r/<name>.json` | [41](https://www.kibo-ui.com/r/registry.json) | Drop zone, Gantt, tree, tags, code block, status. |
| UI Layouts | [ui-layouts.com](https://www.ui-layouts.com) | [ui-layouts/uilayouts](https://github.com/ui-layouts/uilayouts) | 3,835 | 2026-10-31 | MIT | `npx shadcn@latest add https://www.ui-layouts.com/r/<name>.json` | [327](https://www.ui-layouts.com/r/registry.json) | Password strength indicator. |
| ReUI | [reui.io](https://reui.io) | [keenthemes/reui](https://github.com/keenthemes/reui) | 3,833 | 2026-10-16 | MIT | `npx shadcn@latest add https://reui.io/r/<name>.json` | [2,022](https://reui.io/r/registry.json) | Filter builder, cascader, event calendar. |
| OpenStatus data-table | [data-table.openstatus.dev](https://data-table.openstatus.dev) | [openstatusHQ/data-table-filters](https://github.com/openstatusHQ/data-table-filters) | 2,286 | 2026-10-02 | MIT | `npx shadcn@latest add https://data-table.openstatus.dev/r/<name>.json` | [15](https://data-table.openstatus.dev/r/registry.json) | Log and event tables with a faceted command filter. |
| Kokonut UI | [kokonutui.com](https://kokonutui.com) | [kokonut-labs/kokonutui](https://github.com/kokonut-labs/kokonutui) | 2,259 | 2026-10-31 | MIT | `npx shadcn@latest add https://kokonutui.com/r/<name>.json` | [107](https://kokonutui.com/r/registry.json) | Motion-rich interactions: hold to confirm, activity rings, AI controls. |
| Dice UI | [diceui.com](https://diceui.com) | [sadmann7/diceui](https://github.com/sadmann7/diceui) | 2,099 | 2026-11-01 | MIT | `npx shadcn@latest add https://diceui.com/r/<name>.json` | [260](https://diceui.com/r/registry.json) | Accessible composites: stepper, kanban, file upload, tags input, phone input. |
| Eldora UI | [eldoraui.site](https://eldoraui.site) | [karthikmudunuri/eldoraui](https://github.com/karthikmudunuri/eldoraui) | 1,976 | 2026-09-26 | MIT | `npx shadcn@latest add https://eldoraui.site/r/<name>.json` | [115](https://eldoraui.site/r/registry.json) | Marketing sections, such as pricing. |
| blocks.so | [blocks.so](https://blocks.so) | [ephraimduncan/blocks](https://github.com/ephraimduncan/blocks) | 1,854 | 2026-10-30 | MIT | `npx shadcn@latest add https://blocks.so/r/<name>.json` | [82](https://blocks.so/r/registry.json) | App page blocks: stats, dialogs, sign-in. |

### Rejected sources

A library from [awesome-shadcn-ui](https://github.com/birobirobiro/awesome-shadcn-ui) must pass all four tests to be a candidate:

1. At least 1,500 GitHub stars.
2. A push on or after 2026-05-01.
3. Not archived.
4. A permissive licence.

A candidate must also be a component library with a public registry. It must be clearly the best source for at least one component type. Templates, tools and ports to other frameworks are out of scope. To add a source, measure it again and add a row above.

- **Passed the threshold, not approved:** Spectrum UI (no type where it is clearly better); shadcn-admin (a template); maily.to (an email editor application); AutoForm (a form generator, not a component set); neobrutalism-components and 8bitcn (a full visual theme that conflicts with a brand); Tailark (its registry items need a sign-in, HTTP 401); NumberFlow (an npm package with no shadcn registry); shadcn-ui-expansions, Animata, shadcn/studio and shadcn-multi-select-component (no public registry JSON).
- **Failed the threshold:** Novel, Tremor, Vaul, 21st.dev, minimal-tiptap, shadcn-chat and shadcn-ui-sidebar (no push since the date limit); background-snippets and Stepperize (no licence); Animate UI (MIT with Commons Clause, not permissive); Tool UI (archived); Smooth UI and about 120 other libraries (under 1,500 stars). Aceternity UI has no public repository.

## Component map

One row for each component type. shadcn/ui is the choice when it has the exact type. Another source is the choice only when it is clearly better for that type. Each item was found in the source's registry on 2026-11-01. The general rules in [Uniformity rules](#uniformity-rules) apply to every row. The tips give only what is specific to the row.

| Component type | Source | Component and install | Styling tips |
|---|---|---|---|
| **Forms and inputs** | | | |
| Text field with label, hint and error | shadcn/ui | `field` + `input`: `npx shadcn@latest add field input` | Wrap every input in `Field` so label, description and error share one layout. Height `--btn-h`. Error text and border use the danger token, not `red-500`. |
| Input with icon, prefix, suffix or inline button | shadcn/ui | `input-group`: `npx shadcn@latest add input-group` | Use `InputGroupAddon` for the icon or unit. The whole group takes `--btn-h` and one radius; an inner button uses `--btn-h-sm`. |
| Password input with show/hide | shadcn/ui | `input-group`: `npx shadcn@latest add input-group` | Compose: `InputGroupInput type="password"` plus an `InputGroupButton` that toggles the type. Give the button `aria-label` "Show password" / "Hide password" and `aria-pressed`. |
| Password strength meter | UI Layouts | `pass-strengthindicator`: `npx shadcn@latest add https://www.ui-layouts.com/r/pass-strengthindicator.json` | Replace the green/amber/red Tailwind colours with the success, warning and danger tokens. Also show the strength as text; colour alone fails WCAG 1.4.1. |
| OTP / one-time code input | shadcn/ui | `input-otp`: `npx shadcn@latest add input-otp` | Set `autoComplete="one-time-code"` and `inputMode="numeric"`. Slot height `--btn-h-lg`. The focused slot uses the focus ring token. |
| Search field with clear button | shadcn/ui | `input-group`: `npx shadcn@latest add input-group` | Search icon in a start addon, clear button (`aria-label="Clear search"`) in an end addon, shown only when there is text. Use `type="search"` and Escape clears. |
| Number input with steppers | coss ui | `number-field`: `npx shadcn@latest add https://coss.com/ui/r/number-field.json` | Built on Base UI. Map coss colour variables to the project tokens. Steppers use `--btn-h-sm` inside a `--btn-h` field. Keep the locale formatting. |
| Phone number input with country | Dice UI | `phone-input`: `npx shadcn@latest add https://diceui.com/r/phone-input.json` | Store the value as E.164. The country trigger uses the same height and radius as the input. Remove flag emoji if the brand uses icons. |
| Masked input (card, date, postcode) | Dice UI | `mask-input`: `npx shadcn@latest add https://diceui.com/r/mask-input.json` | Show the format in the hint, not only in the placeholder. Keep the raw value for validation. |
| Multi-line text, auto-grow | shadcn/ui | `textarea`: `npx shadcn@latest add textarea` | The v4 textarea uses `field-sizing: content`; set a `max-height` and let it scroll. Same border, radius and focus ring as the input. |
| Select, native (mobile-first, long forms) | shadcn/ui | `native-select`: `npx shadcn@latest add native-select` | Use on mobile and in long forms: it gets the platform picker. Height `--btn-h`. |
| Select, custom list | shadcn/ui | `select`: `npx shadcn@latest add select` | Use when options need icons or descriptions. Content radius matches popovers. Do not add a per-item shadow. |
| Combobox (searchable single select) | shadcn/ui | `combobox`: `npx shadcn@latest add combobox` | Use when the list has more than about 10 options. The trigger looks like an input, not a button. |
| Autocomplete (free text plus suggestions) | coss ui | `autocomplete`: `npx shadcn@latest add https://coss.com/ui/r/autocomplete.json` | Use when the user can type a value that is not in the list. Highlight the matched part with a weight change, not a colour. |
| Multi-select with tags | Kibo UI | `tags`: `npx shadcn@latest add https://www.kibo-ui.com/r/tags.json` | Selected values show as `badge` chips with a remove button (`aria-label="Remove <name>"`). Chips use `--btn-h-sm`. |
| Tags input (free-entry chips) | Dice UI | `tags-input`: `npx shadcn@latest add https://diceui.com/r/tags-input.json` | Enter or comma adds a tag; Backspace on an empty input removes the last one. Same chip style as the multi-select. |
| Cascading select (country → region → city) | ReUI | `cascader`: `npx shadcn@latest add https://reui.io/r/cascader.json` | Use only for real hierarchies of 3 or more levels. Columns use the popover surface token. |
| Checkbox | shadcn/ui | `checkbox`: `npx shadcn@latest add checkbox` | The hit area is at least 24 px (44 px on touch) through the label. The checked fill is the accent token. |
| Checkbox group with "select all" | Dice UI | `checkbox-group`: `npx shadcn@latest add https://diceui.com/r/checkbox-group.json` | The parent shows the mixed state (`aria-checked="mixed"`). Spacing comes from the project scale. |
| Radio group / choice cards | shadcn/ui | `radio-group`: `npx shadcn@latest add radio-group` | For choice cards, wrap each item in a `label` styled as a card; the selected card uses the accent border, not a shadow. |
| Switch (on/off setting) | shadcn/ui | `switch`: `npx shadcn@latest add switch` | Use only for a setting that takes effect at once. In a form that saves on submit, use a checkbox. |
| Slider and range slider | shadcn/ui | `slider`: `npx shadcn@latest add slider` | Pass two values for a range. Show the current value as text next to the label. Thumb focus uses the focus ring. |
| Date picker | shadcn/ui | `calendar` + `popover`: `npx shadcn@latest add calendar popover` | Compose a `Popover` with `Calendar mode="single"` (shadcn docs: Date Picker). Allow typed input too. Format dates with the locale. |
| Date range picker | shadcn/ui | `calendar` + `popover`: `npx shadcn@latest add calendar popover` | Use `Calendar mode="range"` with `numberOfMonths={2}` on desktop and 1 on mobile. Range fill uses the accent-subtle token. |
| Time picker | Dice UI | `time-picker`: `npx shadcn@latest add https://diceui.com/r/time-picker.json` | Follow the locale for 12 or 24 hours. Same trigger height as the date picker so they sit side by side. |
| Colour picker | Dice UI | `color-picker`: `npx shadcn@latest add https://diceui.com/r/color-picker.json` | Keep a text field for the hex value. The swatch border uses the border token so white and black swatches stay visible. |
| File drop zone | Kibo UI | `dropzone`: `npx shadcn@latest add https://www.kibo-ui.com/r/dropzone.json` | The zone is a real button (keyboard opens the file dialog). State the accepted types and size limit in text. Dashed border uses the border token. |
| File upload with list and progress | Dice UI | `file-upload`: `npx shadcn@latest add https://diceui.com/r/file-upload.json` | Wire it to the real upload and its errors; never show fake progress. Each row shows name, size, progress and a remove button. |
| Image crop before upload | Dice UI | `cropper`: `npx shadcn@latest add https://diceui.com/r/cropper.json` | Give keyboard controls for move and zoom. The crop frame uses the accent token. |
| Signature pad | Kokonut UI | `signature-pad`: `npx shadcn@latest add https://kokonutui.com/r/signature-pad.json` | Give a typed-name alternative for keyboard and screen-reader users. The stroke uses the foreground token so it works in dark mode. |
| Star rating input | Dice UI | `rating`: `npx shadcn@latest add https://diceui.com/r/rating.json` | Arrow keys change the value; the value is also shown as text ("4 of 5"). Fill uses the accent or warning token, not `yellow-400`. |
| Inline editable text | Dice UI | `editable`: `npx shadcn@latest add https://diceui.com/r/editable.json` | Show an edit affordance on hover and on focus. Enter saves, Escape cancels. |
| @mention input | Dice UI | `mention`: `npx shadcn@latest add https://diceui.com/r/mention.json` | The suggestion list uses the popover surface. The inserted mention uses the accent-subtle background. |
| Segmented control (2 to 5 options) | shadcn/ui | `toggle-group`: `npx shadcn@latest add toggle-group` | Use `type="single"` and keep one item always selected. Height `--btn-h-sm` in toolbars, `--btn-h` in forms. The selected item uses the surface-raised token. |
| **Buttons and actions** | | | |
| Button (primary, secondary, ghost, destructive) | shadcn/ui | `button`: `npx shadcn@latest add button` | Map the variants to the brand tokens; delete variants the brand does not use. Sizes map to `--btn-h-sm` / `--btn-h` / `--btn-h-lg`. One primary button for each view. |
| Split button / CTA with dropdown | shadcn/ui | `button-group` + `dropdown-menu`: `npx shadcn@latest add button-group dropdown-menu` | Main action in a `Button`, the menu trigger in a second `Button` with `aria-label="More options"`, both inside `ButtonGroup`. Shared height and one outer radius. |
| Button with loading state | shadcn/ui | `button` + `spinner`: `npx shadcn@latest add button spinner` | Put `Spinner` inside the button and set `disabled` and `aria-busy`. Keep the label (or a fixed width) so the button does not change size. |
| Hold-to-confirm destructive button | Kokonut UI | `hold-button`: `npx shadcn@latest add https://kokonutui.com/r/hold-button.json` | Replace its colours with the danger token. Give a non-hold path: a click with `event.detail === 0` (screen reader, voice control) arms it and a second activation confirms. Static under reduced motion. |
| Slide-to-confirm (touch) | Kokonut UI | `slide-to-confirm`: `npx shadcn@latest add https://kokonutui.com/r/slide-to-confirm.json` | Touch screens only. Give a button fallback for keyboard and assistive technology. Track uses `--btn-h-lg`. |
| Copy-to-clipboard button | Cult UI | `copy-button`: `npx shadcn@latest add https://www.cult-ui.com/r/copy-button.json` | Icon button with `aria-label="Copy"`; after a copy, change the icon to a check and announce "Copied" through `aria-live`. Remove its animation under reduced motion. |
| Floating action bar for selected items | Dice UI | `action-bar`: `npx shadcn@latest add https://diceui.com/r/action-bar.json` | Show it only while items are selected; state the count ("3 selected"). Escape clears the selection. Buttons are `--btn-h-sm`. |
| Dropdown menu | shadcn/ui | `dropdown-menu`: `npx shadcn@latest add dropdown-menu` | Destructive items use the danger token and sit last, after a separator. Keyboard shortcuts show with `kbd`. |
| Right-click context menu | shadcn/ui | `context-menu`: `npx shadcn@latest add context-menu` | Every item must also be reachable without a right click (a menu button or keyboard shortcut). |
| Theme toggle (light / dark / system) | Kibo UI | `theme-switcher`: `npx shadcn@latest add https://www.kibo-ui.com/r/theme-switcher.json` | Three states, with "system" the default. Bind it to the project theme provider, not a second store. |
| **Feedback and overlays** | | | |
| Toast notification | shadcn/ui | `sonner`: `npx shadcn@latest add sonner` | One `Toaster` in the root layout. Map its colours to the surface and status tokens. Use an action button for undo. Errors that need action stay on the page, not in a toast. |
| Inline alert / callout | shadcn/ui | `alert`: `npx shadcn@latest add alert` | One variant for each status token (info, success, warning, danger). Include an icon and a text label, not colour alone. |
| Site-wide banner | Kibo UI | `banner`: `npx shadcn@latest add https://www.kibo-ui.com/r/banner.json` | Dismissible, with the dismissal stored. Height and padding from the project scale; no gradient. |
| Confirm dialog (destructive) | shadcn/ui | `alert-dialog`: `npx shadcn@latest add alert-dialog` | The title names the action and the object ("Delete 3 reports?"). The confirm button uses the danger variant; focus starts on Cancel. |
| Modal dialog | shadcn/ui | `dialog`: `npx shadcn@latest add dialog` | Overlay uses the scrim token. Max width from the project scale. Remove the zoom animation under reduced motion. |
| Responsive dialog (dialog on desktop, drawer on mobile) | Dice UI | `responsive-dialog`: `npx shadcn@latest add https://diceui.com/r/responsive-dialog.json` | Use the same breakpoint as the rest of the site. Content and actions are the same in both forms. |
| Sheet / side panel | shadcn/ui | `sheet`: `npx shadcn@latest add sheet` | Use for detail views and filters. Width from the project scale; full width below the small breakpoint. |
| Bottom drawer (mobile) | shadcn/ui | `drawer`: `npx shadcn@latest add drawer` | Built on Vaul. Keep the drag handle visible; also give a close button. |
| Tooltip | shadcn/ui | `tooltip`: `npx shadcn@latest add tooltip` | Only for supplementary text; never put the only label or an action in a tooltip. Same delay site-wide. |
| Hover card (profile or link preview) | shadcn/ui | `hover-card`: `npx shadcn@latest add hover-card` | Must also open on focus. Content is a preview only; the link itself goes to the full page. |
| Popover | shadcn/ui | `popover`: `npx shadcn@latest add popover` | One popover surface token, radius and shadow for every floating panel (popover, select, combobox, menu). |
| Progress bar | shadcn/ui | `progress`: `npx shadcn@latest add progress` | Give it a visible label and the value as text. Indeterminate state only when the duration is unknown. |
| Circular progress / gauge | Dice UI | `circular-progress`: `npx shadcn@latest add https://diceui.com/r/circular-progress.json` | Track uses the muted token, value uses the accent token. Show the number in the centre. |
| Spinner | shadcn/ui | `spinner`: `npx shadcn@latest add spinner` | Use for waits under about 1 s or inside a button; use a skeleton for content. Under reduced motion, slow the spin or show a static icon. |
| Skeleton loader | shadcn/ui | `skeleton`: `npx shadcn@latest add skeleton` | Match the size of the real content so the layout does not shift. Under reduced motion, remove the pulse. |
| Empty state | shadcn/ui | `empty`: `npx shadcn@latest add empty` | Say what is missing and give one action to fix it. Use the project icon set, not an illustration from the library. |
| Status dot (online, degraded, down) | Kibo UI | `status`: `npx shadcn@latest add https://www.kibo-ui.com/r/status.json` | Map each status to a status token and always show the text label next to the dot. |
| Badge / tag | shadcn/ui | `badge`: `npx shadcn@latest add badge` | Variants map to status tokens. Height `--btn-h-sm` or smaller; same radius as chips. |
| Badge overflow ("+3") | Dice UI | `badge-overflow`: `npx shadcn@latest add https://diceui.com/r/badge-overflow.json` | The "+N" badge opens a popover or tooltip that lists the hidden items. |
| Keyboard shortcut hint | shadcn/ui | `kbd`: `npx shadcn@latest add kbd` | Show the platform key (⌘ on macOS, Ctrl elsewhere). Monospace font from the project type scale. |
| Onboarding tour | Dice UI | `tour`: `npx shadcn@latest add https://diceui.com/r/tour.json` | Five steps or fewer; always give Skip. Do not start it again after the user closes it. |
| Relative time ("3 min ago") | Kibo UI | `relative-time`: `npx shadcn@latest add https://www.kibo-ui.com/r/relative-time.json` | Wrap the value in `<time datetime>` and show the full date in a tooltip. |
| **Navigation** | | | |
| Sidebar navigation | shadcn/ui | `sidebar`: `npx shadcn@latest add sidebar` | Use its CSS variables (`--sidebar-*`) mapped to the project tokens. The active item uses the accent-subtle background and `aria-current="page"`. |
| Top navigation with dropdowns | shadcn/ui | `navigation-menu`: `npx shadcn@latest add navigation-menu` | Use for marketing pages; app pages use the sidebar. On mobile, move the links to a sheet. |
| Breadcrumbs | shadcn/ui | `breadcrumb`: `npx shadcn@latest add breadcrumb` | The last item is the current page (`aria-current="page"`), not a link. Collapse the middle items on mobile. |
| Pagination | shadcn/ui | `pagination`: `npx shadcn@latest add pagination` | Links, not buttons, so each page has a URL. Item size `--btn-h-sm`. |
| Tabs | shadcn/ui | `tabs`: `npx shadcn@latest add tabs` | Keep the selected tab in the URL when it changes the content. One tab style site-wide (line or pill, not both). |
| Command palette (⌘K) | shadcn/ui | `command` + `dialog`: `npx shadcn@latest add command dialog` | Use `CommandDialog`. Group the commands and show their shortcuts with `kbd`. Open with ⌘K and Ctrl+K. |
| Stepper / multi-step form progress | Dice UI | `stepper`: `npx shadcn@latest add https://diceui.com/r/stepper.json` | Show step number and name; the current step has `aria-current="step"`. Completed steps can be revisited. |
| Scroll-spy table of contents | Dice UI | `scroll-spy`: `npx shadcn@latest add https://diceui.com/r/scroll-spy.json` | Use for long docs pages. The active link uses the accent token. Smooth scroll is off under reduced motion. |
| **Data display** | | | |
| Data table with sort, filter and pagination | tablecn | `data-table`: `npx shadcn@latest add https://tablecn.com/r/data-table.json` | Server-side sort, filter and paging through URL state (nuqs). Row height from the project scale; header uses the muted surface token. |
| Editable spreadsheet-style grid | tablecn | `data-grid`: `npx shadcn@latest add https://tablecn.com/r/data-grid.json` | Use only when users edit many cells. Keep keyboard navigation; cell focus uses the focus ring. |
| Filter bar (chips with field, operator, value) | ReUI | `filters`: `npx shadcn@latest add https://reui.io/r/filters.json` | Filters live in the URL. Chips use `--btn-h-sm` and the badge radius. "Clear all" is a ghost button. |
| Log / event table with command filter | OpenStatus data-table | `data-table-filter-command`: `npx shadcn@latest add https://data-table.openstatus.dev/r/data-table-filter-command.json` | For log and event views with many facets. Map its chart and level colours to the status tokens. |
| Card | shadcn/ui | `card`: `npx shadcn@latest add card` | One card surface, border and radius site-wide. No shadow unless the brand asks for one. |
| List row / item (icon, title, meta, action) | shadcn/ui | `item`: `npx shadcn@latest add item` | Use for settings lists and search results. Row padding from the project scale. |
| Stat / KPI card | Dice UI | `stat`: `npx shadcn@latest add https://diceui.com/r/stat.json` | Number in the display type size; the change shows a sign and a word ("+4% vs last week"), not only a green arrow. |
| Chart card (area, bar, line, pie) | shadcn/ui | `chart`: `npx shadcn@latest add chart` | Set the series colours in `ChartConfig` from the project chart tokens. Give each chart a title and a text summary or table. |
| User avatar with fallback | shadcn/ui | `avatar`: `npx shadcn@latest add avatar` | Fallback shows initials on the muted token. `alt` is the person's name. One size scale (for example 24 / 32 / 40). |
| Avatar group / stack | Dice UI | `avatar-group`: `npx shadcn@latest add https://diceui.com/r/avatar-group.json` | Limit the visible count and add a "+N" item. Ring colour uses the background token so it works in dark mode. |
| Timeline / activity feed | Dice UI | `timeline`: `npx shadcn@latest add https://diceui.com/r/timeline.json` | Use `<ol>` order, newest first unless the task needs time order. Dots use the status tokens. |
| Kanban board | Dice UI | `kanban`: `npx shadcn@latest add https://diceui.com/r/kanban.json` | Drag must have a keyboard alternative (move with buttons or a menu). Column surface uses the muted token. |
| Gantt chart | Kibo UI | `gantt`: `npx shadcn@latest add https://www.kibo-ui.com/r/gantt.json` | Bars use the accent scale. Give a table view of the same data. |
| Tree view / file tree | Kibo UI | `tree`: `npx shadcn@latest add https://www.kibo-ui.com/r/tree.json` | Arrow-key navigation (`role="tree"`). Indent from the spacing scale; icons from the project set. |
| Code block with copy | Kibo UI | `code-block`: `npx shadcn@latest add https://www.kibo-ui.com/r/code-block.json` | Shiki highlighting: set the project syntax theme for light and dark. The copy button follows the copy-to-clipboard row. (shadcn/ui has `code-block` only in its newer nova styles, not `new-york-v4`.) |
| Install-command snippet with tabs (npm, pnpm, yarn) | Kibo UI | `snippet`: `npx shadcn@latest add https://www.kibo-ui.com/r/snippet.json` | Remember the chosen package manager. Same code font and surface as the code block. |
| Accordion / FAQ | shadcn/ui | `accordion`: `npx shadcn@latest add accordion` | Questions are headings inside the trigger. Allow several items open on FAQ pages. Remove the height animation under reduced motion. |
| Carousel | shadcn/ui | `carousel`: `npx shadcn@latest add carousel` | Never autoplay without a pause button. Previous and next buttons have labels. |
| Event calendar (month, week, agenda) | ReUI | `event-calendar`: `npx shadcn@latest add https://reui.io/r/event-calendar.json` | Event colours map to a fixed set of category tokens. Agenda view is the default on mobile. |
| Contribution / activity heatmap | Kibo UI | `contribution-graph`: `npx shadcn@latest add https://www.kibo-ui.com/r/contribution-graph.json` | Use a sequential scale from the chart tokens. Each cell has a tooltip with date and count. |
| QR code | Dice UI | `qr-code`: `npx shadcn@latest add https://diceui.com/r/qr-code.json` | Dark modules on a light background in both themes, with a quiet zone; give the URL as text too. |
| Video / audio player | Dice UI | `media-player`: `npx shadcn@latest add https://diceui.com/r/media-player.json` | Controls take `--btn-h-sm`. Captions on by default when a track exists. |
| Before / after compare slider | Dice UI | `compare-slider`: `npx shadcn@latest add https://diceui.com/r/compare-slider.json` | The handle works with arrow keys and has a label. Both images have `alt` text. |
| Sortable list (drag to reorder) | Dice UI | `sortable`: `npx shadcn@latest add https://diceui.com/r/sortable.json` | Give a keyboard path (move up / move down) and announce the new position. |
| Resizable split panels | shadcn/ui | `resizable`: `npx shadcn@latest add resizable` | The handle has a visible grip and keyboard resize. Store the sizes for each user. |
| Rich text editor | Plate | `editor-kit`: `npx shadcn@latest add https://platejs.org/r/editor-kit.json` | Start from `editor-kit` and delete the plugins you do not need. Toolbar buttons use `--btn-h-sm`; map Plate colours to the project tokens. |
| **AI and chat** | | | |
| Chat thread (messages, composer, scroll) | assistant-ui | `thread`: `npx shadcn@latest add https://r.assistant-ui.com/thread.json` | Use it with the assistant-ui runtime. Restyle through the project tokens; keep its scroll-to-bottom and streaming behaviour. |
| AI message bubble | shadcn/ui | `message`: `npx shadcn@latest add message` | User and assistant messages differ by alignment and surface token, not by bright colours. Render markdown with the project prose styles. |
| Chat input / prompt composer | coss ui | `composer`: `npx shadcn@latest add https://coss.com/ui/r/composer.json` | Enter sends, Shift+Enter makes a new line. Send button `--btn-h-sm`. Disable send while a reply streams, and give Stop. |
| Reasoning / thinking panel | assistant-ui | `reasoning`: `npx shadcn@latest add https://r.assistant-ui.com/reasoning.json` | Collapsed by default. Muted text token. Do not animate placeholder text over a real streamed reply. |
| Tool-call approval card | Kokonut UI | `ai-tool-approval`: `npx shadcn@latest add https://kokonutui.com/r/ai-tool-approval.json` | Approve and Deny are real buttons with the standard heights. Show the tool name and its arguments as text. |
| Inline citations / sources | Kokonut UI | `ai-citations`: `npx shadcn@latest add https://kokonutui.com/r/ai-citations.json` | Each citation links to its source. Use the project link style. |
| Context window meter | Kokonut UI | `ai-context-meter`: `npx shadcn@latest add https://kokonutui.com/r/ai-context-meter.json` | Show the numbers ("12k of 128k tokens"), not only the ring. Warning and danger tokens near the limit. |
| Model selector | Kokonut UI | `ai-model-selector`: `npx shadcn@latest add https://kokonutui.com/r/ai-model-selector.json` | Feed it the real model list. Same trigger as the select. |
| **Marketing pages** | | | |
| Hero animated background | Magic UI | `flickering-grid`: `npx shadcn@latest add https://magicui.design/r/flickering-grid.json` | Marketing pages only. Colour from the accent token at low opacity. Static (or `dot-pattern`) under reduced motion. Stop it when off screen. |
| Static background pattern | Magic UI | `dot-pattern`: `npx shadcn@latest add https://magicui.design/r/dot-pattern.json` | Use the border token for the dots. Fade it with a mask so text keeps its contrast. |
| Testimonial / logo marquee | Magic UI | `marquee`: `npx shadcn@latest add https://magicui.design/r/marquee.json` | Pause on hover and on focus; stop under reduced motion. Logos in one colour from the muted token. |
| Number ticker | Magic UI | `number-ticker`: `npx shadcn@latest add https://magicui.design/r/number-ticker.json` | Animate once when it enters the viewport. Under reduced motion, show the final number. Use tabular figures. |
| Animated beam (integration diagram) | Magic UI | `animated-beam`: `npx shadcn@latest add https://magicui.design/r/animated-beam.json` | Beam colours from the accent scale, not its default gradient. Give a text list of the integrations. |
| Shimmer CTA button | Magic UI | `shimmer-button`: `npx shadcn@latest add https://magicui.design/r/shimmer-button.json` | One per page, in the hero. Set its height to `--btn-h-lg` and its radius to the button radius. Remove the shimmer under reduced motion. |
| Bento grid (feature overview) | Magic UI | `bento-grid`: `npx shadcn@latest add https://magicui.design/r/bento-grid.json` | For short feature summaries only, not long text. Card surface and radius from the card token. |
| Device mockup (browser frame) | Magic UI | `safari`: `npx shadcn@latest add https://magicui.design/r/safari.json` | Use a real screenshot of the product. Frame colours from the surface tokens. |
| Word rotate headline | Magic UI | `word-rotate`: `npx shadcn@latest add https://magicui.design/r/word-rotate.json` | At most one per page. Under reduced motion, show the first word. Keep the full sentence in the accessible name. |
| Confetti on success | Magic UI | `confetti`: `npx shadcn@latest add https://magicui.design/r/confetti.json` | Only for a real milestone (first publish, payment done). Off under reduced motion. |
| Pricing card / table | Eldora UI | `pricing-01`: `npx shadcn@latest add https://eldoraui.site/r/pricing-01.json` | Replace its colours with the project tokens. The recommended plan uses the accent border, not a gradient. Prices and features are text, not images. |
| Activity rings (progress against targets) | Kokonut UI | `apple-activity-card`: `npx shadcn@latest add https://kokonutui.com/r/apple-activity-card.json` | Ring colours from the chart tokens. Show each value as text too. |
| **Page blocks** | | | |
| Sign-in / sign-up form | shadcn/ui | `login-01`: `npx shadcn@latest add login-01` | A block: a starting layout, not a component. Replace its copy and links; keep one primary button. |
| Dashboard stats row | blocks.so | `stats-01`: `npx shadcn@latest add https://blocks.so/r/stats-01.json` | A block. Use the stat card rules above. Remove the demo numbers. |

## Uniformity rules

Components from different sources must look like one product. Apply these rules to every installed file before you commit it.

- **One height scale.** Define `--btn-h` (40 px), `--btn-h-sm` (32 px) and `--btn-h-lg` (52 px) once, in the global stylesheet. Buttons, inputs, selects, toggles and chips use only these heights. Replace each fixed `h-8`, `h-9`, `h-10` or `h-12` in installed code with the matching variable. On touch layouts, the hit area is at least 44 px (WCAG 2.5.8 and [ux-principles](../skills/ux-principles/SKILL.md)).
- **One radius scale.** Use the `--radius` token that shadcn/ui defines, and its `sm`, `md`, `lg` and `xl` steps. Replace other fixed radii (`rounded-2xl`, `rounded-[20px]`) with a step of that scale. A control and its popover use the same step.
- **One focus ring.** Every focusable element uses the shadcn/ui ring: `focus-visible:ring-[3px]` in the `--ring` colour, with the outline removed only where the ring replaces it. Remove a different ring that a library adds.
- **Tokens, not colours.** Replace each raw colour (`bg-zinc-900`, `text-blue-500`, a hex value) with a project token: background, foreground, muted, accent, border, ring, or a status token (success, warning, danger, info). The component must then work in dark mode without a `dark:` override of its own.
- **No per-library shadows or gradients.** Remove the shadows, gradients, glows, glass and blur effects that a library adds. Use the project's elevation tokens only. A gradient is allowed only when the brand defines it.
- **Reduced motion.** Each animation has a static state under `prefers-reduced-motion: reduce` (Motion: `useReducedMotion()`; CSS: `motion-reduce:` variants). The static state shows the same information.
- **One motion library.** If the project already uses Motion (`motion/react`), keep it. Do not add a second animation library for one component.
- **Magic UI on marketing pages only.** Magic UI and other decorative motion components go on public marketing pages. Application screens, forms and admin pages use the static components.
- **Strip library defaults.** Delete demo data, placeholder images, unused variants, a library's own `cn` or `utils` copy (import the project's), and any font that the library loads.
- **One spacing scale.** Padding and gaps come from the project spacing scale. Replace odd values (`p-[18px]`) with the nearest step.

## Kokonut UI

Kokonut UI is an MIT-licensed set of motion-rich components on the shadcn registry. It is not a design system. Use it for a single interaction that shadcn/ui does not have.

- **When it fits:** hold to confirm (`hold-button`), activity rings (`apple-activity-card`), the AI controls in the map, an action search bar (`action-search-bar`), and a file upload with motion (`file-upload`).
- **Usually leave out:** glass, liquid and gradient effects; animated placeholder text; card stacks; bento grids for long text; demo data.
- **Install:** `npx shadcn@latest add https://kokonutui.com/r/<name>.json`, then add `motion` if the project does not have it. Remove the stray `cn` dependency and import the project's `cn`. Put the files in `components/kokonut/`, with a `LICENSE.kokonut.md` that keeps the MIT notice and a short `README.md` that lists each component, its source URL and the changes.
- **Adapt:** apply the [uniformity rules](#uniformity-rules). Connect real data and real errors.
- **Hold button and assistive technology:** a click with `event.detail === 0` (keyboard, screen reader or voice control) arms the button, and a second activation confirms. A mouse click never confirms. A held Enter or Space counts as a hold. Announce the armed state through `aria-live`.
- **Tests in a DOM emulator:** happy-dom and jsdom do not have the Web Animations API. In the test setup, delete `Element.prototype.animate` so that Motion uses its fallback, and import the component with a dynamic `import()` after that setup. Test the hold, the assistive-technology path and the reduced-motion state.
