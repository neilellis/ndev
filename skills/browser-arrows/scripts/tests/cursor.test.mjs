// cursor.js in a real Chrome page. It needs Google Chrome and a node_modules folder with
// playwright-core: set VIDEO_KIT_NODE_MODULES to that folder (for example a video project's own).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/google/chrome/chrome", "/usr/bin/google-chrome"].find((f) => fs.existsSync(f));
const modules = process.env.VIDEO_KIT_NODE_MODULES;
const skip = !chrome ? "Google Chrome is not installed"
  : !modules || !fs.existsSync(path.join(modules, "playwright-core")) ? "set VIDEO_KIT_NODE_MODULES to a node_modules folder with playwright-core"
  : false;
const cursor = fs.readFileSync(path.resolve(import.meta.dirname, "../cursor.js"), "utf8");

describe("cursor.js", { skip }, () => {
  it("starts a new trail after the page scrolls, so a click on a scrolled-to target draws no line across the screen", async () => {
    const { chromium } = await import(path.join(modules, "playwright-core/index.mjs"));
    const browser = await chromium.launch({ executablePath: chrome });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      await page.addInitScript(cursor);
      await page.route("http://cursor.test/", (r) => r.fulfill({ contentType: "text/html", body: '<body style="margin:0; height:4000px; background:#fff"></body>' }));
      await page.goto("http://cursor.test/");
      // How red the trail canvas is along a vertical line, between two heights.
      const red = (x, from, to) => page.evaluate(([x, from, to]) => {
        const c = document.querySelector('html > div[role="presentation"] canvas');
        const k = c.width / innerWidth, d = c.getContext("2d").getImageData(x * k, from * k, 1, (to - from) * k).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      }, [x, from, to]);
      const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      // Without a scroll, a jump draws its trail between the two points: the overlay works.
      await page.mouse.move(500, 100);
      await page.mouse.move(500, 700);
      await frame();
      assert.ok(await red(500, 300, 500) > 0, "a move with no scroll drew no trail");

      await page.waitForTimeout(700); // the trail fades in 600 ms
      await page.mouse.move(300, 100);
      await page.evaluate(() => scrollTo(0, 1500));
      await frame();
      await page.mouse.move(300, 700);
      await frame();
      assert.equal(await red(300, 300, 500), 0, "a trail ran from the place before the scroll to the place after it");
    } finally {
      await browser.close();
    }
  });
});
