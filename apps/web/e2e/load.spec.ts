import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

/**
 * Map render frame rate under the load case (Phase 11). Opt in with
 * SCOUT_LOAD=1 after apps/api/src/load/run.ts has generated the data. The
 * console loads at most 2 000 observations per case, so the map is drawing
 * that many points plus traces and links; the number reported is for that
 * picture, and the cap is the reason it is not a million.
 */

const LOAD = process.env["SCOUT_LOAD"] === "1";

test.describe("map frame rate under load", () => {
  test.skip(!LOAD, "Set SCOUT_LOAD=1 with the load case generated to measure frame rate.");

  test("draws the load case and reports frames per second while panning", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle("Investigation").click();
    const panel = page.locator(".investigation");
    await panel.getByLabel("Investigation").selectOption({ label: "Load Test" });
    await expect(panel.locator(".entity-row").first()).toBeVisible({ timeout: 60_000 });
    const drawn = (await panel.locator(".entity-list p.tiny.faint").first().textContent())?.trim() ?? "";

    // Fly to an entity so the map is over the points, then measure frames
    // while the camera pans.
    await panel.locator(".entity-row").first().click();
    await page.waitForTimeout(2_500);
    const canvas = page.locator("canvas.maplibregl-canvas").first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = (box?.x ?? 0) + 200;
    const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;

    const measure = page.evaluate(() => new Promise<{ frames: number; seconds: number }>((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames += 1;
        if (performance.now() - start < 5_000) requestAnimationFrame(tick);
        else resolve({ frames, seconds: (performance.now() - start) / 1000 });
      };
      requestAnimationFrame(tick);
    }));
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
      await page.mouse.up();
      await page.mouse.move(cx + 120, cy + 40);
      await page.mouse.down();
      await page.mouse.move(cx, cy, { steps: 12 });
      await page.mouse.up();
    }
    const { frames, seconds } = await measure;
    const fps = Math.round((frames / seconds) * 10) / 10;
    // Headless Chromium renders WebGL in software (SwiftShader); a headed run
    // uses the GPU and is the number a user would see. Both are recorded.
    const result = { at: new Date().toISOString(), fps, frames, seconds, drawn, headless: test.info().project.use.headless !== false, viewport: page.viewportSize() };
    writeFileSync("test-results/load-fps.json", JSON.stringify(result, null, 2));
    console.log(`[load] map frame rate: ${fps} fps over ${seconds.toFixed(1)} s while panning (${drawn})`);
    expect(fps).toBeGreaterThan(0);
  });
});
