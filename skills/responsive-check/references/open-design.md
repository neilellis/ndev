# Redesign with OpenDesign

OpenDesign is a local design workspace (https://github.com/nexu-io/open-design). Its MCP server is registered for Claude, Codex and opencode as `open-design`. Use it when a defect needs a layout decision, not a CSS fix: a navigation that does not fit on a phone, a table that must become cards, a hero that fails at every width.

## Before you start

- Start the OpenDesign app. The MCP tools talk to its local service. The port changes at each start; the app sets it for the MCP server.
- On macOS, `/usr/bin/od` (octal dump) has the same name as the OpenDesign CLI. Use the MCP tools, or give the CLI's full path and `--daemon-url`.
- If the MCP tools are not loaded, load them with ToolSearch (`+open-design`).

## Give it the brand

Write a `DESIGN.md` for the OpenDesign project from the brand site: the colour tokens (light and dark), the type scale, spacing, the radius, the touch target size and the breakpoints. Take the values from the brand site, not from memory. Upload it with `write_file`.

## Run

1. `list_skills` and choose the skills that fit. The useful ones are `responsive-design`, `design-review`, `web-design-guidelines` and `platform-design`.
2. `list_agents`, and pass only an agent from that list to `start_run`.
3. `create_project`, or use the open project. Upload the screenshots of the failing cells and the page's current HTML and CSS.
4. `start_run` with a prompt that names: the route, the failing cells (viewport and scheme), each finding, the brand `DESIGN.md`, and the rule "mobile first, no sideways scroll at 320 px, 24 px targets minimum, 44 px on touch, both schemes". Make one `requestId` and use it again after a timeout.
5. `get_run` until it is done. Open the preview URL and look at it at 320, 768 and 1280 in both schemes.
6. Port the design into the project's own components and tokens. Do not paste the generated HTML into the app.
7. Run the matrix again.

## Rules

- OpenDesign gives a proposal. The project's brand site and its tokens stay the source of truth.
- A new token or breakpoint from the design goes to the brand site in the same PR (see [brand-site.md](brand-site.md)).
