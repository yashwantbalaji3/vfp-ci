import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Founder identity review in a real browser (docs/33), at phone width: the founder works through a
 * queue one place at a time and records decisions; nothing is published and the menu stays "not
 * checked"; a member, a curator and a guest get nothing. Places are invented. Decisions are permanent
 * by design, so at the end the test places are taken out of every queue rather than deleted.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(150_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const QUEUE = `e2e_queue_${tag}`;
const open: BrowserContext[] = [];
const ids: string[] = [];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function evidence(street2: string) {
  return {
    quality: "corroborated",
    reasons: [{ code: "sources_disagree_on_address", words: "The two sources give different house numbers" }],
    records: [
      { source: "Test licences", sourceKey: "boston_food_licenses", release: "r1", recordId: `lic-${tag}`, name: "TEST LANTERN", street: "12 Sample St", postcode: "02118",
        locality: "Boston", category: "eating & drinking", website: null, openStatus: "licensed_active", present: true, lat: 42.341, lon: -71.072 },
      { source: "Test places", sourceKey: "overture_places", release: "r2", recordId: `ov-${tag}`, name: "Test Lantern", street: street2, postcode: "02118",
        locality: "Boston", category: "cafe", website: "https://example.test", openStatus: "open", present: true, lat: 42.3412, lon: -71.0722 },
    ],
    recordsApartMetres: 27,
    lookalikes: [],
    precheck: street2 === "12 Sample St" ? { level: "agree", concerns: [], version: 1 } : { level: "look", concerns: ["house_number"], version: 1 },
  };
}

test.beforeAll(async () => {
  for (const [i, name] of [`Review e2e Lantern ${tag}`, `Review e2e Harbour ${tag}`].entries()) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `insert into public.identity_review_items (candidate_id, name, street, postcode, area, lat, lon, queues, evidence, sort_key)
       values ($1, $2, '12 Sample St', '02118', 'South End', 42.341, -71.072, $3, $4, $5)`,
      [id, name, [QUEUE], JSON.stringify(evidence(i === 0 ? "14 Sample St" : "12 Sample St")), `000-${i}`],
    );
    await pool.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
       values ($1, $2, $3, '12 Sample St', 'Boston', '02118', 'South End', 42.341, -71.072, 'Café', 'corroborated', '[{"key":"overture_places","title":"Test source","attribution":"Test attribution"}]', 'e2e')`,
      [id, `review-e2e-${tag}-${i}`, name],
    );
  }
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  await pool.query("update public.identity_review_items set active = false where candidate_id = any($1::uuid[])", [ids]);
  await deleteTestListings("l.candidate_id = any($1::uuid[])", [ids]);
});

async function person(browser: Browser, label: string, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `review-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  }
  return page;
}
/** The app keeps earlier pages hidden for Back; look only at what is on screen. */
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
async function axe(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}

test("the founder checks a queue one place at a time; decisions are kept and nothing is published", async ({ browser }) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto("/places/review");
  await expect(seen(founder, "review-queues")).toBeVisible();
  await axe(founder);

  await founder.goto(`/places/review?queue=${QUEUE}`);
  await expect(seen(founder, "review-row")).toHaveCount(2);
  // The automatic pre-check (docs/51) shows on each row; it decides nothing.
  await expect(seen(founder, "review-row").filter({ hasText: `Review e2e Lantern ${tag}` })).toContainText("Pre-check: look closer (house numbers)");
  await expect(seen(founder, "review-row").filter({ hasText: `Review e2e Harbour ${tag}` })).toContainText("Pre-check: every check agrees");
  await expect(seen(founder, "review-queue-progress")).toContainText("0 of 2 checked");
  await founder.getByRole("link", { name: `Review e2e Lantern ${tag}` }).filter({ visible: true }).click();

  await expect(seen(founder, "review-name")).toHaveText(`Review e2e Lantern ${tag}`);
  await expect(seen(founder, "review-current")).toHaveText("Not decided yet");
  await expect(seen(founder, "review-reasons")).toContainText("different house numbers");
  await expect(seen(founder, "review-record")).toHaveCount(2);
  // At a glance (docs/57): both records side by side, with the decision right below the pre-check.
  const glance = seen(founder, "review-glance");
  await expect(glance.getByRole("columnheader")).toHaveCount(3);
  await expect(glance.getByRole("rowheader", { name: "Address" })).toBeVisible();
  await expect(glance).toContainText("The records are 27 m apart.");
  const order = await founder.evaluate(() => ["review-glance", "review-precheck", "review-decide", "review-records"].map((id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => (e as HTMLElement).offsetParent !== null)!.getBoundingClientRect().top));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(seen(founder, "review-checks")).toContainText("The house numbers differ: 12 and 14.");
  await expect(seen(founder, "review-checks")).toContainText("The sources put it 27 m apart.");
  await expect(seen(founder, "review-precheck")).toContainText("Pre-check: look closer.");
  await expect(seen(founder, "review-history-empty")).toBeVisible();
  await expect(founder.getByRole("button", { name: /all/i })).toHaveCount(0);
  await axe(founder);

  // "Identity correct" records one decision and opens the next undecided place.
  await seen(founder, "decide-verify").click();
  await expect(founder).toHaveURL(new RegExp(`/places/review/${ids[1]}\\?`));
  await expect(seen(founder, "review-message")).toContainText("Decision recorded");
  await expect(seen(founder, "review-name")).toHaveText(`Review e2e Harbour ${tag}`);
  await expect(seen(founder, "review-progress")).toContainText("1 of 2 checked");
  const first = (await pool.query("select identity_status, menu_status, visibility from public.place_listings where candidate_id = $1", [ids[0]])).rows[0];
  expect(first).toEqual({ identity_status: "verified", menu_status: "not_checked", visibility: "preview" });

  // Reject asks why, then withdraws only this place from the private preview.
  await founder.getByText("Reject", { exact: true }).filter({ visible: true }).click();
  await founder.getByLabel("Closed").filter({ visible: true }).check();
  await founder.getByLabel("Note (optional)").filter({ visible: true }).last().fill("Shut in October, per a news report");
  await seen(founder, "decide-reject").click();
  await expect(founder).toHaveURL(/m=queue_done/);
  await expect(seen(founder, "review-message")).toContainText("no more undecided places");
  await expect(seen(founder, "review-queue-progress")).toContainText("2 of 2 checked");
  const second = (await pool.query("select identity_status, visibility from public.place_listings where candidate_id = $1", [ids[1]])).rows[0];
  expect(second).toEqual({ identity_status: "corroborated", visibility: "withdrawn" });

  // The history keeps both decisions after a change of mind; nothing became public.
  await founder.goto(`/places/review/${ids[1]}?queue=${QUEUE}`);
  await seen(founder, "decide-verify").click();
  // Wait for the decision to be recorded (the queue is finished again) before opening the place.
  await expect(founder).toHaveURL(/m=queue_done/);
  await founder.goto(`/places/review/${ids[1]}?queue=${QUEUE}`);
  await expect(seen(founder, "review-history").getByRole("listitem", { includeHidden: false })).toHaveCount(2);
  await expect(seen(founder, "review-history")).toContainText("Rejected: Closed");
  await expect(seen(founder, "review-history")).toContainText("Shut in October");
  await axe(founder);
  expect((await pool.query("select count(*)::int n from public.place_listings where visibility = 'public'")).rows[0].n).toBe(0);

  // The real-places preview still says the menu is not checked.
  await founder.goto(`/places?q=${encodeURIComponent(`Review e2e Lantern ${tag}`)}`);
  const card = seen(founder, "place-listing").first();
  await expect(card.getByTestId("menu-status")).toHaveText("Menu not checked yet");
  await expect(card.getByTestId("identity-status")).toContainText("Identity checked by us");
});

test("a member, a curator and a guest cannot open the review", async ({ browser }) => {
  for (const [label, role] of [["member", undefined], ["curator", "curator"]] as const) {
    const page = await person(browser, label, role);
    // The list answers like a page that does not exist, so it does not reveal that a review area is there.
    await page.goto("/places/review");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("We couldn’t find that");
    await page.goto(`/places/review/${ids[0]}`);
    await expect(seen(page, "review-founder-only")).toBeVisible();
    await expect(page.getByText(`Review e2e Lantern ${tag}`)).toHaveCount(0);
  }
  const guest = await (await browser.newContext()).newPage();
  open.push(guest.context());
  await guest.goto("/places/review");
  await expect(guest.getByTestId("social-signin")).toBeVisible();
});
