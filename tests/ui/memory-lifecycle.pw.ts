import { expect, test } from "@playwright/test";

test("full viewport retains shadow outside the old crop for classic/slim skins", async ({ page }) => {
  await page.goto("/#/home");
  await page.waitForFunction(() => Array.from(document.querySelectorAll("canvas")).some(canvas => canvas.height > 400));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("slh-native-activity", { detail:false })));
  for (const slim of [false,true]) for (const overlay of [false,true]) {
    const result = await page.evaluate(async ({slim,overlay}) => {
      // @ts-expect-error Vite serves this source fixture.
      const fixture = await import("/tests/ui/fixtures/home-viewport-equivalence.ts");
      return fixture.compareHomeViewport(slim,overlay);
    },{slim,overlay});
    console.log(JSON.stringify({slim,overlay,...result}));
    expect(result.visible).toBeGreaterThan(1000);
    expect(result.shadowOutsideNarrowViewport).toBeGreaterThan(100);
    expect(result.compactBuffers).toBe(true);
    expect(result.lutCount).toBeGreaterThan(0);
    expect(result.lutListeners).toBe(0);
    if (overlay) expect(result.voxelVertices).toBeGreaterThan(100);
    expect(result.callsAfter).toBe(result.callsBefore);
    expect(result.trianglesAfter).toBe(result.trianglesBefore);
    // Float transforms move a few rasterization edge pixels on different GPUs.
    expect(result.significant / result.channels).toBeLessThan(.001);
    expect(result.difference / result.channels).toBeLessThan(.05);
  }
});

test("finished environment keeps identical real WebGL pixels for classic and slim skins", async ({ page }) => {
  await page.goto("/#/home");
  // Wait for the app's dynamic Three.js imports before loading the fixture;
  // otherwise Vite may restart dependency optimization during its first fetch.
  await page.waitForFunction(() => Array.from(document.querySelectorAll("canvas")).some(canvas => canvas.height > 400));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("slh-native-activity", { detail:false })));
  for (const slim of [false,true]) {
    const result=await page.evaluate(async slim => {
      // @ts-expect-error Vite serves this source fixture to the test browser.
      const fixture=await import("/tests/ui/fixtures/environment-equivalence.ts");
      return fixture.compareEnvironment(slim);
    },slim);
    expect(result.visible).toBeGreaterThan(1000);
    expect(result.dataTexture).toBe(true);
    expect(result.retainedTarget).toBe(false);
    expect(result.differences).toBe(0);
  }
});
