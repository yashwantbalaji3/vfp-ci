import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { IDS } from "../fixtures/ids";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll, setDiet } from "./helpers";

/**
 * MAP-2 in a real browser (plans/2026-11-15-map-2-plan.md, H6, H9, H10, H12): checked hours entered
 * by one editor and published by another; the "Open now" filter on the list and the map; the
 * status words; keyboard and accessibility. Synthetic data only. The practice place this file
 * creates is removed at the end, and its hours go with it.
 *
 * The demo hours are real clock times, so these tests never assume what is open at the moment
 * they run: they check that whatever is shown as open really is open, and that nothing else is.
 * The exact moments (clock changes, midnight, holidays, 60 days) are proved in tests/db/map2-hours.test.ts.
 *
 * Set MAP2_SHOTS=<folder> to save review screenshots.
 */
test.use({ timezoneId: "America/New_York" });
test.setTimeout(180_000);

const SHOTS = process.env.MAP2_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const open: BrowserContext[] = [];
const madeVenues = new Set<string>();
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});
test.afterAll(async () => {
  await pool.query("delete from public.catalog_changes where state in ('draft', 'submitted') and summary like 'MAP2 test%'");
  if (madeVenues.size) await pool.query("delete from public.venues where id = any($1::uuid[])", [[...madeVenues]]);
  await pool.query("delete from public.venues where name like 'MAP2 test %'");
});

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const flash = (page: Page, text: string | RegExp) => page.getByTestId("flash").filter({ hasText: text });
const flashError = (page: Page, text: string | RegExp) => page.getByTestId("flash-error").filter({ hasText: text });
// The two demo dishes that contain egg (tests/e2e/m2-discovery.spec.ts: "2 items with egg").
const EGG_DISH = /Demo egg noodles|Demo tofu bibimbap/;
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  // After a form's redirect the page is swapped in on the client and its <title> lands a moment later; checking in
  // between once reported a missing title (main e9bba2e, 18 Nov). Wait for the title, then check everything.
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `accessibility problems on ${page.url()}`).toEqual([]);
}

async function staff(browser: Browser, label: string, role: string, width = 1280): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `map2-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Feditor");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return page;
}

test.describe("H10 entering checked hours takes two people", () => {
  test("a curator enters hours by keyboard with clear errors; a publisher approves; the place page shows them", async ({ browser }) => {
    const curator = await staff(browser, "cur", "curator");
    const publisher = await staff(browser, "pub", "publisher");
    const name = `MAP2 test Kitchen ${randomUUID().slice(0, 6)}`;

    await curator.goto("/editor/new");
    await seen(curator, "new-place").getByRole("button").click();
    await expect(flash(curator, "Draft started. Nothing public has changed.")).toBeVisible();
    const changeId = curator.url().match(/\/editor\/changes\/([0-9a-f-]{36})/)![1];
    await curator.getByLabel("Who says so").fill("The owner, by phone (invented for this test)");
    await curator.getByLabel("Kind of source").selectOption("operator_statement");
    await curator.getByLabel("Date you saw or heard it").fill(today());
    await curator.getByLabel("What the source says, in your own words").fill("Gave the opening hours for every day.");
    await curator.getByLabel("One line for the person who will check this").fill("MAP2 test: a practice place with hours");
    await curator.getByLabel("Name", { exact: true }).fill(name);
    await curator.getByLabel("Neighbourhood").fill("Test Square");

    const hours = seen(curator, "hours-fields");
    await hours.getByLabel("Include checked opening hours in this change").check();
    // A closing time before the opening time, without "past midnight": refused in words.
    await hours.getByLabel("Monday first period opens").fill("14:00");
    await hours.getByLabel("Monday first period closes").fill("11:00");
    await curator.getByRole("button", { name: "Save draft" }).click();
    await expect(flashError(curator, "A closing time is before its opening time")).toBeVisible();
    await shot(curator, "editor-hours-error");

    // Refused hours are not kept, so the box is ticked again (everything else in the form was saved).
    await hours.getByLabel("Include checked opening hours in this change").check();
    // Every day open 24 hours, chosen by keyboard (so the place is open whenever this test runs).
    await hours.getByLabel("Monday first period opens").fill("");
    await hours.getByLabel("Monday first period closes").fill("");
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      const box = hours.getByLabel(`Open 24 hours on ${day}`);
      await box.focus();
      await curator.keyboard.press("Space");
      await expect(box).toBeChecked();
    }
    await hours.getByLabel("Change 1: from").fill("2030-01-01");
    await hours.getByLabel("Reason shown to visitors (optional)").first().fill("New Year (practice)");
    await curator.getByRole("button", { name: "Save and send for checking" }).click();
    await expect(flash(curator, "Sent for checking.")).toBeVisible();
    await expectAccessible(curator);

    // Nothing is public yet.
    const pending = (await pool.query("select count(*)::int n from public.venue_hours_sets s join public.venues v on v.id = s.venue_id where v.name = $1", [name])).rows[0].n;
    expect(pending).toBe(0);

    // The author cannot approve their own change.
    await curator.goto(`/editor/changes/${changeId}`);
    await expect(seen(curator, "review-form")).toHaveCount(0);

    // The publisher sees the hours they are approving, then approves.
    await publisher.goto(`/editor/changes/${changeId}`);
    await expect(publisher.getByText(/Mon Open 24 hours/)).toBeVisible();
    await shot(publisher, "editor-hours-review");
    const form = seen(publisher, "review-form");
    await form.getByLabel(/I looked at the source myself/).check();
    await form.getByLabel(/Nothing here is copied/).check();
    await form.getByRole("button", { name: "Approve and publish" }).click();
    await expect(flash(publisher, "Checked and published.")).toBeVisible();

    const venueId = (await pool.query("select id from public.venues where name = $1", [name])).rows[0].id as string;
    madeVenues.add(venueId);
    await publisher.goto(`/venues/${venueId}`);
    const panel = publisher.getByTestId("opening-hours");
    await expect(panel.getByTestId("hours-status")).toHaveAttribute("data-state", "open");
    await expect(panel.getByTestId("hours-status")).toContainText("Open now");
    await expect(panel.getByTestId("hours-status")).toContainText("Open 24 hours");
    await expect(panel.getByRole("row", { name: /Monday/ })).toContainText("Open 24 hours");
    await expect(panel.getByTestId("hours-exceptions")).toContainText("New Year (practice)");
    await expectAccessible(publisher);
    await shot(publisher, "place-hours-published");
  });
});

test.describe("H9 status words", () => {
  test("place pages say whether hours are checked, in words, on a phone", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
    open.push(context);
    const page = await context.newPage();
    await page.goto(`/venues/${IDS.venueAllston}`);
    const unchecked = page.getByTestId("opening-hours");
    await expect(unchecked.getByTestId("hours-status")).toHaveText(/Hours need confirmation/);
    await expect(unchecked).toContainText("never appears under “Open now”");
    await page.goto(`/venues/${IDS.venueBackBay}`);
    const checked = page.getByTestId("opening-hours");
    await expect(checked.getByTestId("hours-status")).toHaveText(/^. (Open now|Closed · opens at .+)/);
    await expect(checked.getByRole("row", { name: /Monday/ })).toContainText("7 AM–3 PM");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, "phone-place-hours");
    // The list with Open now on a phone: status words on every card, nothing sideways.
    await page.goto("/discover?open=1");
    await expectNoSidewaysScroll(page);
    await shot(page, "phone-list-open-now");
  });
});

test.describe("H6 and H12 Open now on the list and the map", () => {
  test("the list shows only places open now, says how many were left out, and sends no location", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
    open.push(context);
    await setDiet(context, "vegetarian", ["egg"]);
    const page = await context.newPage();
    const sent: string[] = [];
    page.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));
    await page.goto("/discover");
    await page.locator("summary", { hasText: "Filters" }).click();
    await page.getByLabel("Open now").check();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/[?&]open=1/);
    for (const status of await page.getByTestId("dish-card").getByTestId("hours-status").all()) {
      await expect(status).toHaveAttribute("data-state", "open");
    }
    // Demo Allston Dosa Corner has no checked hours: it is left out and counted.
    await expect(page.getByTestId("open-now-left-out")).toContainText(/left out because (its|their) opening hours need confirmation/);
    // The egg-free vegetarian filter still applies: the demo egg dish is not shown.
    await expect(page.getByTestId("dish-card").filter({ hasText: EGG_DISH })).toHaveCount(0);
    await shot(page, "list-open-now");
    // Whole words only: a build's random file names (for example "1wa9latd283bq.js") can contain "lat".
    expect(sent.filter((s) => /(^|[^a-z0-9])(lat|lon|lng|latitude|longitude)([^a-z0-9]|$)/i.test(s))).toEqual([]);
  });

  test("with Open now, the map's pins and the list beside it show the same open places, in words", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
    open.push(context);
    const page = await context.newPage();
    await page.goto("/discover?open=1");
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
    await expect(page.getByTestId("map-view")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const rows = page.locator(".place-row");
    const n = await rows.count();
    for (let i = 0; i < n; i++) await expect(rows.nth(i).getByTestId("hours-status")).toHaveAttribute("data-state", "open");
    for (const pin of await page.getByTestId("map-pin").all()) {
      await expect(pin).toHaveAttribute("aria-label", /Open now/);
      await expect(pin).toHaveAttribute("data-hours", "open");
    }
    // Without the filter, a place whose hours are not checked says so on its pin.
    await page.goto("/discover");
    await page.getByRole("group", { name: "Show results as" }).getByRole("button", { name: "Map" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".place-row", { hasText: "Demo Allston Dosa Corner" }).getByTestId("hours-status")).toHaveText(/Hours need confirmation/);
    await shot(page, "map-hours");
    await expectAccessible(page);
  });
});
