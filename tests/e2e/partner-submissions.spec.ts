import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Restaurant submissions in a real browser (docs/48), at phone width: a representative claims a place,
 * cannot send a menu until a moderator records an ownership check, then uploads a CSV under the stated
 * permission; the moderator sees every dish in the restaurant's own words with its notes and
 * provenance and decides each one; nothing becomes public. A member gets no moderator view and a guest
 * is asked to sign in. The place and people are invented and removed at the end.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(180_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PLACE = `Partner e2e Kitchen ${tag}`;
const open: BrowserContext[] = [];
const emails: string[] = [];
let candidate = "";
let run = "";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const CSV =
  "name,section,labels,ingredients,allergens,serving,price_usd,protein_g,calories_kcal\n" +
  `Lentil bowl ${tag},Bowls,Vegan;Gluten free,"lentils, rice, tahini",sesame,1 bowl,14.50,21 g,540\n` +
  `Cheese melt ${tag},Sandwiches,Vegan,"sourdough, cheddar cheese",,1 sandwich,,,\n`;

test.beforeAll(async () => {
  run = (await pool.query("insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status) values ('boston_food_licenses', $1, $2, now(), '{}', 'completed') returning id", [`partner-e2e-${tag}`, "0".repeat(64)])).rows[0].id;
  candidate = (await pool.query("insert into catalog_import.place_candidates (name, street, postcode, lat, lon, category, quality, created_run) values ($1, '9 Sample St', '02116', 42.35, -71.07, 'restaurant', 'corroborated', $2) returning id", [PLACE, run])).rows[0].id;
});
test.afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
  // Deleting the accounts removes the claim and everything it holds (docs/48); then the invented place.
  if (emails.length) await pool.query("delete from auth.users where email = any($1::text[])", [emails]);
  if (candidate) await pool.query("delete from catalog_import.place_candidates where id = $1", [candidate]);
  if (run) await pool.query("delete from catalog_import.import_runs where id = $1", [run]);
});

async function person(browser: Browser, label: string, role?: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  open.push(context);
  const page = await context.newPage();
  const email = `partner-${label}-${randomUUID().slice(0, 8)}@example.test`;
  emails.push(email);
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
    await pool.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [id, role]);
  }
  return page;
}
const seen = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
async function axe(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}
const publicCounts = async () =>
  (await pool.query("select (select count(*)::int from public.place_listings where visibility = 'public') listings, (select count(*)::int from public.food_revisions where name like $1) dishes", [`%${tag}%`])).rows[0];

test("a restaurant claims, is checked, sends a menu; a moderator reviews each dish; nothing is published", async ({ browser }) => {
  const before = await publicCounts();
  const rep = await person(browser, "rep");

  // Claim through the link the moderator gave.
  await rep.goto(`/partner/claim/${candidate}`);
  await expect(seen(rep, "partner-claim-place")).toHaveText(PLACE);
  await axe(rep);
  await rep.getByLabel("Your role at the restaurant").fill("Owner");
  await rep.getByLabel("Email we can reach you at").fill(`owner-${tag}@kitchen.example.test`);
  await rep.getByLabel("I am authorised to act for this restaurant.").check();
  await seen(rep, "partner-claim-send").click();
  await expect(rep).toHaveURL(/\/partner\?m=claimed/);
  await expect(seen(rep, "partner-claim-state")).toHaveText("Waiting for an ownership check");
  await expect(seen(rep, "partner-upload-link")).toHaveCount(0);
  await axe(rep);
  const claimId = (await pool.query("select c.id from partner.claims c where c.candidate_id = $1", [candidate])).rows[0].id as string;
  await rep.goto(`/partner/${claimId}/upload`);
  await expect(seen(rep, "partner-upload-blocked")).toBeVisible();

  // A member without the moderator role gets nothing; the moderator records a check done by phone.
  const member = await person(browser, "member");
  await member.goto("/places/review/partner");
  await expect(seen(member, "review-founder-only")).toBeVisible();
  const mod = await person(browser, "mod", "publisher");
  await mod.goto("/places/review/partner");
  const row = seen(mod, "partner-mod-claim").filter({ hasText: PLACE });
  await expect(row).toContainText("Waiting for an ownership check");
  await axe(mod);
  await row.getByText("Record an ownership check").click();
  await row.getByLabel("Call to the restaurant's public phone number").check();
  await row.getByLabel("They represent the restaurant").check();
  await row.getByLabel("What you did and what you saw").fill("Called the number in the city licence record; the manager confirmed the owner's name");
  await row.getByTestId("partner-check-send").click();
  await expect(seen(mod, "partner-message")).toHaveText("Ownership check recorded.");
  await expect(seen(mod, "partner-mod-claim").filter({ hasText: PLACE })).toContainText("Ownership checked");

  // The representative sends the CSV under the stated permission.
  await rep.goto("/partner");
  await expect(seen(rep, "partner-claim-state")).toHaveText("Ownership checked");
  await seen(rep, "partner-upload-link").click();
  await expect(seen(rep, "partner-licence")).toContainText("non-exclusive");
  await axe(rep);
  await rep.getByLabel(/Menu file/).setInputFiles({ name: "menu.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await seen(rep, "partner-accept").check();
  await seen(rep, "partner-upload-send").click();
  await expect(rep).toHaveURL(/m=submitted/);
  await expect(seen(rep, "partner-message")).toContainText("2 dishes were received for review");
  await expect(seen(rep, "partner-message")).toContainText("1 label was kept for a person to read");
  await expect(seen(rep, "partner-claim-counts")).toContainText("2 dishes sent: 0 checked by a moderator, 0 not accepted, 2 waiting");

  // The moderator sees each dish in the restaurant's words, with notes and provenance.
  await mod.goto("/places/review/partner");
  const bowl = seen(mod, "partner-dish").filter({ hasText: `Lentil bowl ${tag}` });
  const melt = seen(mod, "partner-dish").filter({ hasText: `Cheese melt ${tag}` });
  await expect(bowl.getByTestId("partner-dish-dietary")).toHaveText("vegan: “Vegan”");
  await expect(bowl.getByTestId("partner-dish-nutrition")).toHaveText("Protein 21 g per serving; Calories 540 kcal per serving");
  await expect(bowl.getByTestId("partner-dish-provenance")).toContainText(`Sent by owner-${tag}@kitchen.example.test`);
  await expect(bowl.getByTestId("partner-dish-provenance")).toContainText("permission version v1-2026-11");
  await expect(bowl.getByTestId("partner-dish-flags")).toHaveCount(0);
  await expect(melt.getByTestId("partner-dish-flags")).toContainText("Says vegan, but the ingredients or description name an animal product");
  await expect(melt.getByTestId("partner-dish-flags")).toContainText("No allergen statement");
  await expect(melt.getByTestId("partner-dish-nutrition")).toHaveText("None given (unknown, not zero)");
  await axe(mod);
  await bowl.getByTestId("partner-dish-verify").click();
  await expect(seen(mod, "partner-message")).toHaveText("Dish marked as checked. It is still not published.");
  await seen(mod, "partner-dish").filter({ hasText: `Cheese melt ${tag}` }).getByLabel("Note (optional)").fill("Cheddar is not vegan");
  await seen(mod, "partner-dish").filter({ hasText: `Cheese melt ${tag}` }).getByTestId("partner-dish-reject").click();
  await expect(seen(mod, "partner-message")).toHaveText("Dish not accepted.");
  await expect(seen(mod, "partner-dish").filter({ hasText: tag })).toHaveCount(0);

  // The representative sees the outcome; nothing became public.
  await rep.goto("/partner");
  await expect(seen(rep, "partner-claim-counts")).toContainText("2 dishes sent: 1 checked by a moderator, 1 not accepted, 0 waiting");
  expect(await publicCounts()).toEqual(before);

  // Withdrawal: nothing from the claim is used afterwards.
  await rep.getByText("Stop sharing this restaurant’s menu").click();
  await rep.getByLabel(/I understand that nothing from this claim/).check();
  await seen(rep, "partner-withdraw").click();
  await expect(seen(rep, "partner-message")).toContainText("Withdrawn");
  await expect(seen(rep, "partner-claim-state")).toHaveText("Withdrawn by the restaurant");
  await expect(seen(rep, "partner-upload-link")).toHaveCount(0);
});

test("a guest is asked to sign in, and an unknown place is not found", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  open.push(context);
  const page = await context.newPage();
  for (const path of ["/partner", `/partner/claim/${candidate}`, "/places/review/partner"]) {
    await page.goto(path);
    await expect(seen(page, "social-signin")).toBeVisible();
  }
  const signedIn = await person(browser, "stranger");
  await signedIn.goto(`/partner/claim/${randomUUID()}`);
  await expect(signedIn.getByRole("heading", { name: "We couldn’t find that" })).toBeVisible();
  await expect(seen(signedIn, "partner-claim-form")).toHaveCount(0);
});
