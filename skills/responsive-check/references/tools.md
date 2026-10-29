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
- Use it to check Safari's own behaviour: the toolbar and `100vh`, input zoom, safe areas, the bounce scroll, `position: fixed` under the keyboard. It is also the way to press a page's own controls, for example a theme toggle.
- Load the Orca emulator guide with `orca skills get orca-emulator` before you use it.

The steps that work:

1. Boot a device and open the page: `xcrun simctl boot <udid>`, then `xcrun simctl openurl <udid> http://localhost:3000/`. The simulator reaches the Mac's `localhost`. The first `openurl` after a boot can time out while Safari starts; run it again.
2. Attach by UDID: `orca emulator attach <udid> --json`. A name such as "iPhone SE (3rd generation)" can match a device in each installed iOS runtime. Orca can then choose a device that is not booted and fail with `serve-sim command failed`. Get the UDID from `xcrun simctl list devices booted`.
3. Read the result's `ok` field, not the exit code: a failed `attach` returns `"ok": false` with exit code 0.
4. Read the tree: `orca emulator ax --json`. It lists the page's own links and buttons with their labels, so you can find a control by its label. If it returns `noFrontmostApplication`, bring Safari to the front (`xcrun simctl launch <udid> com.apple.mobilesafari`) and try again.
5. Tap at the centre of the element's frame: `orca emulator tap <x + width/2> <y + height/2> --json`. The coordinates are 0..1, not pixels.
6. Take the screenshot with `xcrun simctl io <udid> screenshot <file>.png`, and look at it.
7. Stop the helper when you are done: `orca emulator kill --json`.

- `xcrun simctl ui <udid> appearance dark` sets the system scheme only. A site that stores its own theme choice does not follow it: press the site's toggle instead.
- The iPhone SE (3rd generation) is 375 px wide. The matrix's 320 px row has no current simulator, so check 320 px with the script.

## Browser extensions

An extension can resize the window, but it cannot change the CSS layout viewport, the device pixel ratio or the touch mode. A screenshot from a narrow window is not a phone check.
