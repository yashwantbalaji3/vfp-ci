import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Batch review in a real browser (docs/35), at phone width: the founder sees a batch's sample result,
 * its 95% confidence bound and both gates; approval is unavailable until the sample passes, needs an
 * explicit acknowledgement, publishes nothing, and can be withdrawn. Places are invented; batch rows
 * are permanent by design, so the test batch stays (its places are taken out of every queue).
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(180_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const NAME = `e2e-batch-${tag}`;
const SRC = JSON.stringify([{ key: "overture_places", title: "Test source", attribution: "Test attribution" }]);
const open: BrowserContext[] = [];
const places: string[] = [];
let batchId = "";

test.beforeAll(async () => {
  batchId = (await pool.query("insert into public.publication_batches (name, sample_seed, fingerprint, place_count) values ($1, $2, $3, 62) returning id", [NAME, `e2e-seed-${tag}`, "0".repeat(64)])).rows[0].id;
  for (let i = 0; i < 62; i++) {
    const id = randomUUID();
    places.push(id);
    await pool.query(
      `insert into public.identity_review_items (candidate_id, name, street, postcode, lat, lon, queues, sample_seed, evidence, sort_key)
       values ($1, $2, '1 Sample St', '02116', 42.35, -71.07, $3, $4, '{}'::jsonb, 'zzz')`,
      [id, `Batch e2e ${tag} ${i}`, [i < 61 ? `e2e_batch_${tag}` : `e2e_other_${tag}`], `e2e-seed-${tag}`]);
    await pool.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, lat, lon, category, identity_status, sources, built_from, publication_batch)
       values ($1, $2, $3, '1 Sample St', 'Boston', '02116', 42.35, -71.07, 'Restaurant', 'corroborated', $4, 'e2e', $5)`,
      [id, `batch-e2e-${tag}-${i}`, `Batch e2e ${tag} ${i}`, SRC, batchId]);
    await pool.query("insert into public.publication_batch_places (batch_id, candidate_id, in_sample) values ($1, $2, $3)", [batchId, id, i < 61]);
  }
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  await pool.query("update public.identity_review_items set active = false where candidate_id = any($1::uuid[])", [places]);
});

async function person(browser: Browser, label: string, role?: string): Promise<{ page: Page; id: string }> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `batch-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  if (role) await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  return { page, id };
}
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const ours = (page: Page) => seen(page, "batch").filter({ hasText: NAME });
async function axe(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}

test("the founder sees the sample result and both gates, and can approve only a passing batch", async ({ browser }) => {
  const { page: founder, id: founderId } = await person(browser, "founder", "publisher");
  await founder.goto("/places/review/batches");
  const card = ours(founder);
  await expect(card.getByTestId("batch-progress")).toContainText("0 of 61 checked");
  await expect(card.getByTestId("batch-confidence")).toContainText("no estimate yet");
  await expect(card.getByTestId("batch-gate1")).toHaveText("Not approved");
  await expect(card.getByTestId("batch-gates")).toContainText("Public listing switch: off.");
  await expect(card.getByTestId("batch-approve")).toBeDisabled();
  await axe(founder);

  // The founder's own decisions on the 61 sampled places (recorded here directly, as the review page would).
  for (const id of places.slice(0, 61)) {
    await pool.query("insert into public.identity_reviews (candidate_id, decision, queue, sample_seed, decided_by) values ($1, 'verify_identity', 'sample', $2, $3)", [id, `e2e-seed-${tag}`, founderId]);
  }
  await founder.reload();
  await expect(ours(founder).getByTestId("batch-rule")).toContainText("The sample passes.");
  await expect(ours(founder).getByTestId("batch-confidence")).toContainText("no more than 4.8%");
  await ours(founder).getByLabel(/I understand that approving this batch publishes nothing/).check();
  await ours(founder).getByTestId("batch-approve").click();
  await expect(seen(founder, "batch-message")).toContainText("Nothing is public");
  await expect(ours(founder).getByTestId("batch-gate1")).toHaveText("Approved by you");
  await expect(ours(founder).getByTestId("batch-history")).toContainText("61 of 61 checked, 0 problems, at most 4.8% wrong");
  await axe(founder);

  // Approval publishes nothing and verifies nothing.
  const unsampled = (await pool.query("select identity_status, visibility from public.place_listings where candidate_id = $1", [places[61]])).rows[0];
  expect(unsampled).toEqual({ identity_status: "corroborated", visibility: "preview" });
  expect((await pool.query("select count(*)::int n from public.place_listings where visibility = 'public'")).rows[0].n).toBe(0);

  await ours(founder).getByTestId("batch-withdraw").click();
  await expect(seen(founder, "batch-message")).toContainText("Approval withdrawn");
  await expect(ours(founder).getByTestId("batch-gate1")).toHaveText("Not approved");
  await expect(ours(founder).getByTestId("batch-history").getByRole("listitem")).toHaveCount(2);
});

test("a member and a curator cannot open batch review", async ({ browser }) => {
  for (const [label, role] of [["member", undefined], ["curator", "curator"]] as const) {
    const { page } = await person(browser, label, role);
    await page.goto("/places/review/batches");
    await expect(seen(page, "review-founder-only")).toBeVisible();
    await expect(page.getByText(NAME)).toHaveCount(0);
  }
});
