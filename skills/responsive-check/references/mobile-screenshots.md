# Mobile screenshots

Run `scripts/mobile-shots.mjs` in the responsive-check skill's folder with an explicit target. Then open the PNGs that it prints.

```bash
WEB_DIR=<web app dir> node <this skill>/scripts/mobile-shots.mjs --base http://localhost:3000 / /about
```

Start the local web server first if needed. `--base` is required: the script has no default site.

| Option | Meaning |
|---|---|
| `--base URL` / `BASE` | Site root (required) |
| `--device NAME` / `DEVICE` | Playwright device; default `iPhone 13` |
| `--out DIR` / `OUT` | Output folder; default a temporary `mobile-shots` folder |
| `--routes-file FILE.json` | Array of route strings or `{path, name}` objects. Positional routes override it. |

`WEB_DIR` is the folder where `@playwright/test` is installed. It defaults to the current directory. If the script cannot load Playwright, it exits 2 and names the fix.

| Exit | Meaning |
|---|---|
| 0 | Every route captured |
| 1 | At least one route failed; the log names it |
| 2 | Could not run |

## Read the result

- Each route gives a full-page PNG and a viewport-fold PNG.
- Check the measured viewport width in the log, not the apparent image size.
- A device descriptor sets the viewport, pixel ratio, mobile user agent and touch. The script uses Chromium, also for iPhone descriptors.
- A mobile user agent can redirect to a separate mobile experience. Check the final URLs.
- An authenticated page needs a session set up first.
- `networkidle` plus a short wait does not prove that every client-rendered state is ready.

Browser extensions often cannot change the CSS layout viewport, so they cannot emulate a device. Use this script for mobile screenshots. For a quick look at a signed-in page, use Orca's browser when Orca runs: `${CLAUDE_PLUGIN_ROOT}/scripts/browser/orca-shot.sh <url> <out.png> --viewport 390x844`. It has no touch and no WebKit. For a full check, follow the [responsive matrix](../SKILL.md).
