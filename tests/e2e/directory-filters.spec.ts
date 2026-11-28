import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deleteTestListings, pool } from "../helpers/db";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * Directory filters in a real browser at phone width (docs/36 "Filters"): forgiving search, kind of
 * place, founder-checked identity, kept by the map view. Places are invented and removed at the end.
 */
test.use({ timezoneId: "America/New_York", viewport: { width: 360, height: 740 } });
test.setTimeout(120_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const SRC = JSON.stringify([{ key: "overture_places", title: "Test dataset", attribution: "Test attribution e2e", release: "r-e2e" }]);
const ids: string[] = [];
const PLACES: [string, string, string][] = [
  [`Filter e2e Felipe's ${tag}`, "Restaurant", "verified"],
  [`Filter e2e Café Zoë ${tag}`, "Café", "corroborated"],
  [`Filter e2e Truck ${tag}`, "Food truck", "corroborated"],
];

test.beforeAll(async () => {
  for (const [i, [name, category, identity]] of PLACES.entries()) {
    ids.push((await pool.query(
      `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from)
       values (gen_random_uuid(), $1, $2, '5 Sample Row', 'Boston', '02118', 'South End', $3, -71.0731, $4, $5, $6, 'e2e') returning id`,
      [`filter-e2e-${tag}-${i}`, name, 42.3412 + i * 0.0005, category, identity, SRC])).rows[0].id);
  }
});
test.afterAll(async () => {
  await deleteTestListings("l.id = any($1::uuid[])", [ids]);
});

test("the founder finds places with a forgiving search and narrows by kind and by checked identity", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `filters-founder-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  const cards = () => page.getByTestId("place-listing").filter({ visible: true });

  // No apostrophe or accent needed.
  await page.goto(`/places?q=${encodeURIComponent(`filter e2e felipes ${tag}`)}`);
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText(`Filter e2e Felipe's ${tag}`);
  await page.goto(`/places?q=${encodeURIComponent(`filter e2e cafe zoe ${tag}`)}`);
  await expect(cards()).toHaveCount(1);

  // Kind of place, then checked identity, through the form.
  await page.goto(`/places?q=${tag}`);
  await expect(cards()).toHaveCount(3);
  // The filters fold away until one is on.
  await expect(page.getByLabel("Kind of place")).toBeHidden();
  await page.getByTestId("places-filters").locator("summary").click();
  await page.getByLabel("Kind of place").selectOption("Food truck");
  await page.getByTestId("places-apply").click();
  await expect(page).toHaveURL(/kind=Food\+truck/);
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText(`Filter e2e Truck ${tag}`);
  await expect(cards().first().getByTestId("menu-status")).toHaveText("Menu not checked yet");
  await expect(page.getByTestId("places-filters").locator("summary")).toContainText("Filters (1 on)");
  await page.getByLabel("Kind of place").selectOption("");
  await page.getByTestId("places-checked").check();
  await page.getByTestId("places-apply").click();
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText(`Filter e2e Felipe's ${tag}`);
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);

  // The map keeps the same filters as the list.
  await page.goto(`/places?q=${tag}&kind=Caf%C3%A9&view=map`);
  await expect(page.getByTestId("places-count").filter({ visible: true })).toHaveText("1 place");
  await expect(page.getByText(/1 place on the map/)).toBeVisible();
  await context.close();
});
