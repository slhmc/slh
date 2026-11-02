import { expect, type Page } from "@playwright/test";
export async function revealControl(page: Page, selector: string) {
  const control = page.locator(selector).first();
  await expect(control).toBeAttached();
  for (const disclosure of await control.locator("xpath=ancestor::details").all()) {
    if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await disclosure.locator(":scope > summary").click();
  }
  await expect(control).toBeVisible();
}
