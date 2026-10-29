# Tools and their traps

| Tool | Real CSS viewport | Real engine | Touch | Use it for |
|---|---|---|---|---|
| `scripts/responsive-check.mjs` (Playwright) | yes | WebKit and Chromium | emulated | The matrix. The main tool. |
| Orca embedded browser | yes, with `set viewport` | Chromium | no | A quick look while you edit. |
| Orca emulator (iOS Simulator) | yes | real iOS Safari | yes | A final Safari check. Needs Xcode. |
| Claude in Chrome | no | Chrome | no | Not for layout checks. |
| The ndev Playwright MCP (`browser_resize`, `browser_emulate_media`) | yes | Chromium | no | An interactive look at one state, for example a menu open in dark mode. |

## Playwright

- A device descriptor sets the viewport, device pixel ratio, user agent, `isMobile` and `hasTouch`. The script uses one browser context for each viewport and scheme.
- **With no viewport meta, mobile WebKit lays the page out at 980 px**, and then scales it down. An element 600 px wide then does not overflow at 320. The `viewport-meta` error tells you this; fix the meta first, then read the overflow results.
- `networkidle` and `document.fonts.ready` do not prove that every client-rendered state is ready. When a cell looks empty, look at its screenshot and wait for a selector.
- Check `measured.width` in the report, not the image size: the image is in device pixels.
- A mobile user agent can redirect to another site. Check the final URL.

## Orca embedded browser

- `orca exec --command "set viewport 390 844"` sets the CSS viewport. `orca set device <name>` changes the user agent only: the layout stays at the desktop width.
- It has no WebKit and no touch, so it does not replace the matrix.

## Orca emulator (iOS Simulator)

- It needs Xcode (`xcrun simctl`). With the Command Line Tools only, it is not available. Say so in the result.
- Use it to check Safari's own behaviour: the toolbar and `100vh`, input zoom, safe areas, the bounce scroll, `position: fixed` under the keyboard.
- Load the Orca emulator guide with `orca skills get orca-emulator` before you use it.

## Browser extensions

An extension can resize the window, but it cannot change the CSS layout viewport, the device pixel ratio or the touch mode. A screenshot from a narrow window is not a phone check.
