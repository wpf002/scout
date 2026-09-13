import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 11's console walk: load an investigation, scrub the timeline, open
 * an entity, adjudicate a review pair, confirm the audit trail recorded it.
 *
 * Runs against the synthetic fixtures case (every person, vessel, company
 * in it is made up). The adjudication it records is permanent, which is
 * the point of the audit check; the queue shrinks by one per run.
 */

const API = process.env["SCOUT_API_URL"] ?? "http://localhost:3001";
const CASE_NAME = "Synthetic Fixtures";

async function appIsUp(): Promise<boolean> {
  try {
    const web = await fetch(process.env["SCOUT_WEB_URL"] ?? "http://localhost:3000", { signal: AbortSignal.timeout(5_000) });
    const api = await fetch(`${API}/cases`, { signal: AbortSignal.timeout(5_000) });
    return web.ok && api.ok;
  } catch {
    return false;
  }
}

async function chooseCase(page: Page, select: ReturnType<Page["getByLabel"]>): Promise<string> {
  await select.selectOption({ label: CASE_NAME });
  const id = await select.inputValue();
  expect(id).not.toBe("");
  return id;
}

test.describe("the investigation console", () => {
  test.beforeAll(async () => {
    test.skip(!(await appIsUp()), "The app is not running. Start it with scripts/start.sh and seed with `pnpm --filter @scout/db run seed:v2`.");
  });

  test("loads an investigation, scrubs the timeline, opens an entity", async ({ page }) => {
    await page.goto("/");
    // The rail buttons are glyphs with their name in `title`.
    await page.getByTitle("Investigation").click();
    const panel = page.locator(".investigation");
    await expect(panel).toBeVisible();
    await chooseCase(page, panel.getByLabel("Investigation"));

    // Loaded: coverage bands for the sources that had data, and the entity list.
    await expect(panel.locator(".coverage-row").first()).toBeVisible();
    const rows = panel.locator(".entity-row");
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    expect(total).toBeGreaterThan(10);
    await expect(panel.locator(".entity-row.unseen")).toHaveCount(0);

    // Scrub to a third of the way through the range: entities first seen
    // later dim, and the moment on the scrubber says the new date.
    const slider = panel.getByRole("slider", { name: "As of" });
    const [min, max] = await slider.evaluate((el: HTMLInputElement) => [Number(el.min), Number(el.max)]);
    const target = Math.round(min + (max - min) / 3);
    await slider.evaluate((el: HTMLInputElement, value: number) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, target);
    const stamp = new Date(target).toISOString().slice(0, 10);
    await expect(panel.locator(".scrub-when")).toContainText(stamp);
    await expect.poll(async () => panel.locator(".entity-row.unseen").count()).toBeGreaterThan(0);
    await expect(panel.locator(".coverage-bars i.future").first()).toBeVisible();

    // Back to now, then open an entity by name.
    // Exact: "Now" is also the start of every Nowak in the fixtures.
    await panel.getByRole("button", { name: "Now", exact: true }).click();
    await panel.getByPlaceholder("Find an entity").fill("eriksen");
    await expect(rows.first()).toContainText(/eriksen/i);
    await rows.first().click();
    const view = panel.locator(".entity-view");
    await expect(view.locator("h2").first()).toContainText(/eriksen/i);
    await expect(view.getByText("Position", { exact: false }).first()).toBeVisible();
    await expect(view.getByText("Sources Consulted")).toBeVisible();
    await expect(view.getByText("Members")).toBeVisible();
  });

  test("adjudicates a review pair and finds it in the audit trail", async ({ page, request }) => {
    await page.goto("/");
    await page.getByTitle("Case File").click();
    const casefile = page.locator(".casefile");
    const caseId = await chooseCase(page, casefile.getByLabel("Investigation"));
    await casefile.getByRole("button", { name: /^Review/ }).click();

    const queue = casefile.locator(".review-list .review-row");
    await expect(queue.first()).toBeVisible();
    const before = await queue.count();
    expect(before).toBeGreaterThan(0);
    const names = (await queue.first().textContent()) ?? "";
    await queue.first().click();

    const note = `E2E: could not tell from the fields shown (${Date.now()})`;
    await casefile.locator(".review-note").fill(note);
    await casefile.getByRole("button", { name: "Can't Tell" }).click();

    // The pair leaves the queue and the decision is counted as waiting for a run.
    await expect.poll(async () => queue.count()).toBe(before - 1);
    await expect(casefile.locator(".review-waiting")).toContainText(/decision/);

    // The audit tab shows it, with the note.
    await casefile.getByRole("button", { name: /^Audit/ }).click();
    await expect(casefile.getByText("Pair Adjudicated").first()).toBeVisible();
    await expect(casefile.getByText(note)).toBeVisible();

    // And the API's record agrees.
    const audit = await request.get(`${API}/cases/${caseId}/audit`);
    expect(audit.ok()).toBeTruthy();
    const events = (await audit.json()).events as Array<{ action: string; detail: Record<string, unknown> }>;
    const recorded = events.find((e) => e.action === "v2.adjudicated" && e.detail["note"] === note);
    expect(recorded).toBeDefined();
    expect(recorded?.detail["decision"]).toBe("INDETERMINATE");
    expect(names.length).toBeGreaterThan(0);
  });
});
