import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { demoRelease } from "../../scripts/lib/nie-demo-dishes.mjs";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * The founder's batch menu review (docs/58) at phone width: drafted rows are confirmed, rejected or
 * corrected a row at a time; a row from a source that is not cleared cannot be confirmed; nothing is
 * published; a member gets nothing. The restaurant, host and dishes are invented. Staged facts are
 * permanent by design, so each run uses its own names.
 */
test.use({
  timezoneId: "America/New_York",
  viewport: { width: 360, height: 740 },
});
test.setTimeout(150_000);

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PLACE = `Menu e2e Kitchen ${tag}`;
const open: BrowserContext[] = [];
let placeId = "";
let groupPlaceId = "";
let lentilPlate = "";
const GROUP_PLACE = `Menu e2e Bowls ${tag}`;
let autoPlaceId = "";
const AUTO_PLACE = `Menu e2e Automatic ${tag}`;
const one = async (sql: string, params: unknown[]) =>
  (await pool.query(`select ${sql} as r`, params)).rows[0].r;

test.beforeAll(async () => {
  const curator = randomUUID();
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [curator, `menu-curator-${tag}@example.test`],
  );
  await pool.query(
    "insert into public.role_assignments (user_id, role) values ($1, 'curator')",
    [curator],
  );
  await pool.query(
    `insert into staging.source_access (host, kind, status, evidence, permitted_uses, reviewer, reviewed_at)
     values ($1, 'terms_review', 'permits', 'Test clause', 'tests', 'Test reviewer', now())`,
    [`cleared-${tag}.test`],
  );
  // A Tier B site in the owner's private pilot (18 Nov 2026): facts can be matched to the source privately.
  await pool.query(
    `insert into staging.source_access (host, kind, status, evidence, reviewer, reviewed_at)
     values ($1, 'owner_decision', 'private_pilot', 'Test owner decision', 'Test reviewer', now())`,
    [`pilot-${tag}.test`],
  );
  placeId = await one(
    "staging.add_place($1, $2, 'kendall_square', 1::smallint)",
    [curator, PLACE],
  );
  const cleared = await one(
    "staging.add_source_page($1, $2, 'restaurant_site', 'Test', now())",
    [curator, `https://cleared-${tag}.test/menu`],
  );
  const pending = await one(
    "staging.add_source_page($1, $2, 'restaurant_site', 'Test', now())",
    [curator, `https://pending-${tag}.test/menu`],
  );
  const pilot = await one(
    "staging.add_source_page($1, $2, 'restaurant_site', 'Test', now())",
    [curator, `https://pilot-${tag}.test/menu`],
  );
  const today = (
    await pool.query(
      "select (now() at time zone 'America/New_York')::date::text d",
    )
  ).rows[0].d as string;
  const dish = (label: string) =>
    one("staging.add_dish($1, $2, $3)", [curator, placeId, label]);
  const submit = (dishId: string, src: string, p: Record<string, unknown>) =>
    one("staging.submit_fact($1, $2::jsonb)", [
      curator,
      JSON.stringify({
        placeId,
        dishId,
        sourcePageId: src,
        checkedOn: today,
        ...p,
      }),
    ]);
  const bowl = await dish("Chickpea bowl");
  await submit(bowl, cleared, {
    kind: "price",
    value: { usd: "13.95" },
    confidence: "high",
  });
  await submit(bowl, cleared, {
    kind: "listed_ingredients",
    value: { items: ["chickpeas", "tahini", "rice"] },
    confidence: "high",
  });
  await submit(bowl, cleared, {
    kind: "dietary_status",
    subject: "vegan",
    value: { claim: "vegan", status: "yes" },
    confidence: "high",
  });
  const wrap = await dish("Falafel wrap");
  await submit(wrap, cleared, {
    kind: "price",
    value: { usd: "11.50" },
    confidence: "medium",
  });
  const soup = await dish("Lentil soup");
  await submit(soup, pending, {
    kind: "price",
    value: { usd: "6.00" },
    confidence: "medium",
  });
  // A second place for grouped confirmation: two clean rows from the pilot source and one flagged row.
  groupPlaceId = await one("staging.add_place($1, $2, 'back_bay', 1::smallint)", [curator, GROUP_PLACE]);
  for (const [label, kind, extra] of [
    ["Lentil plate", "complete_meal", { kind: "price", value: { usd: "12.00" } }],
    ["Tofu bowl", "complete_meal", { kind: "price", value: { usd: "14.00" } }],
    ["Mystery bowl", null, { kind: "price", value: { usd: "9.00" }, confidence: "low" }],
  ] as const) {
    const d = await one("staging.add_dish($1, $2, $3)", [curator, groupPlaceId, label]);
    if (kind) await one("staging.classify_dish($1, $2, $3)", [curator, d, kind]);
    if (label === "Lentil plate") lentilPlate = d;
    for (const f of [extra, { kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } }])
      await one("staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: groupPlaceId, dishId: d, sourcePageId: pilot, checkedOn: today, confidence: "high", ...f })]);
  }
  // A USDA estimate for the lentil plate from typical amounts (owner direction 18 Nov 20:56 UTC):
  // lentils 150 to 250 g (9.02 g protein per 100 g) and rice 120 to 180 g (2.69) = 16.758 to 27.392 g.
  const c = await pool.connect();
  let releaseId: string;
  try {
    releaseId = await demoRelease(c, { allowExcerpt: true });
  } finally {
    c.release();
  }
  const line = (fdcId: number, grams: number, low: number, high: number) => ({
    label: `food ${fdcId}`, usdaReleaseId: releaseId, fdcId, usdaState: "cooked", weighedAs: "cooked", amountBasis: "typical", grams, gramsLow: low, gramsHigh: high,
  });
  const model = await one("app.nie_create_model($1, $2::jsonb)", [curator, JSON.stringify({
    label: "Estimate e2e", quantityBasis: "editorial_typical", servingBasis: "typical", assumptions: "Typical amounts for the test.",
    lines: [line(172421, 200, 150, 250), line(168878, 150, 120, 180)],
  })]);
  await one("staging.link_dish_estimate($1, $2, $3, 'dish_name', null)", [curator, lentilPlate, model]);
  // A third place where an automatic comparison with the saved page found every value in two rows,
  // and could not find the price of a third (owner direction 18 Nov 23:20 UTC).
  autoPlaceId = await one("staging.add_place($1, $2, 'back_bay', 1::smallint)", [curator, AUTO_PLACE]);
  for (const [label, found] of [["Chickpea plate", true], ["Kale bowl", true], ["Squash bowl", false]] as const) {
    const d = await one("staging.add_dish($1, $2, $3)", [curator, autoPlaceId, label]);
    await one("staging.classify_dish($1, $2, $3)", [curator, d, "complete_meal"]);
    for (const f of [{ kind: "price", value: { usd: "13.00" } }, { kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } }]) {
      const id = await one("staging.submit_fact($1, $2::jsonb)", [curator, JSON.stringify({ placeId: autoPlaceId, dishId: d, sourcePageId: pilot, checkedOn: today, confidence: "high", ...f })]);
      const ok = found || f.kind !== "price";
      await one("staging.record_machine_check($1, $2, $3, $4, $5, now())", [curator, id, ok ? "found" : "not_found", ok ? "$13.00 appears shortly after the dish name." : "$13.00 does not appear shortly after the dish name.", "c".repeat(64)]);
    }
  }
  const tofu = await dish("Tofu plate");
  await submit(tofu, pilot, {
    kind: "price",
    value: { usd: "15.00" },
    confidence: "high",
  });
});
test.afterAll(async () => {
  await Promise.all(
    open.splice(0).map((c) => c.close().catch(() => undefined)),
  );
});

async function person(
  browser: Browser,
  label: string,
  role?: string,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    timezoneId: "America/New_York",
  });
  open.push(context);
  const page = await context.newPage();
  const email = `menu-${label}-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  if (role) {
    const id = (
      await pool.query("select id from auth.users where email = $1", [email])
    ).rows[0].id as string;
    await pool.query(
      "insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing",
      [id, role],
    );
  }
  return page;
}
const seen = (page: Page, testId: string) =>
  page.getByTestId(testId).filter({ visible: true });
async function axe(page: Page) {
  await page.waitForLoadState("networkidle");
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await expectNoSidewaysScroll(page);
}
const row = (page: Page, name: string) =>
  seen(page, "menu-dish").filter({ has: page.getByRole("heading", { name }) });

test("the founder confirms, rejects and corrects drafted rows; nothing is published", async ({
  browser,
}) => {
  const founder = await person(browser, "founder", "publisher");
  await founder.goto("/places/review/menus");
  await expect(seen(founder, "menu-places")).toContainText(PLACE);
  await axe(founder);
  await founder.getByRole("link", { name: PLACE }).click();
  await expect(seen(founder, "menu-place-name")).toHaveText(PLACE);
  await expect(seen(founder, "menu-dish")).toHaveCount(4);
  await expect(row(founder, "Tofu plate")).toContainText("private check only");
  await expect(row(founder, "Chickpea bowl")).toContainText(
    "chickpeas, tahini, rice",
  );
  await expect(row(founder, "Chickpea bowl")).toContainText(
    "Vegan: yes, stated by the restaurant",
  );
  // The soup's source is not cleared: its row can be rejected but not confirmed.
  await expect(
    row(founder, "Lentil soup").getByLabel("Everything matches the source"),
  ).toBeDisabled();
  await axe(founder);

  // Saving with every row on "Later" records nothing.
  await founder.getByTestId("menu-save").click();
  await expect(seen(founder, "menu-error")).toContainText("Nothing was saved");

  await row(founder, "Chickpea bowl")
    .getByLabel("Everything matches the source")
    .check();
  await row(founder, "Lentil soup").getByLabel("Reject this row").check();
  await row(founder, "Tofu plate")
    .getByLabel("Everything matches the source")
    .check();
  await founder.getByTestId("menu-save").click();
  await expect(seen(founder, "menu-flash")).toHaveText(
    "Saved: 3 confirmed, 1 matched to their source privately, 1 rejected. Nothing was published.",
  );
  await expect(row(founder, "Tofu plate")).toContainText(
    "Matches the source (private only)",
  );
  await expect(row(founder, "Chickpea bowl")).toContainText("Confirmed by you");
  await expect(row(founder, "Chickpea bowl")).toContainText(
    "Nothing left to check in this row.",
  );

  // Correct the wrap's price.
  await row(founder, "Falafel wrap")
    .getByRole("link", { name: "Correct price" })
    .click();
  await expect(seen(founder, "fix-drafted")).toHaveText("$11.50");
  await axe(founder);
  await founder
    .getByLabel("Price in dollars (for example 12.50)")
    .fill("10.50");
  await founder.getByTestId("fix-save").click();
  await expect(seen(founder, "menu-flash")).toContainText("Correction saved");
  await expect(row(founder, "Falafel wrap")).toContainText(
    "You corrected one fact here",
  );

  const facts = (
    await pool.query(
      "select status, count(*)::int n from staging.facts where place_id = $1 group by status order by status",
      [placeId],
    )
  ).rows;
  expect(facts).toEqual([
    { status: "rejected", n: 2 },
    { status: "submitted", n: 1 },
    { status: "verified", n: 3 },
  ]);
  expect(
    (
      await pool.query(
        "select count(*)::int n from staging.fact_confirmations c join staging.facts f on f.id = c.fact_id where f.place_id = $1",
        [placeId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select count(*)::int n from staging.publications where place_id = $1",
        [placeId],
      )
    ).rows[0].n,
  ).toBe(0);
});

test("an automatic comparison can be accepted for a group, and is never shown as the founder's own comparison", async ({
  browser,
}) => {
  const founder = await person(browser, "autoacc", "publisher");
  await founder.goto(`/places/review/menus/${autoPlaceId}`);
  await expect(seen(founder, "menu-place-name")).toHaveText(AUTO_PLACE);
  // A value the comparison could not find makes the row an exception, listed first.
  await expect(seen(founder, "menu-dish").first()).toContainText("Squash bowl");
  await expect(row(founder, "Squash bowl")).toContainText("automatic comparison couldn't find this on the saved page");
  await expect(row(founder, "Kale bowl").getByTestId("menu-machine-check").first()).toContainText("Automatic check, not by you: found on the saved page");
  const group = seen(founder, "menu-clean-group");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("2 rows");
  await axe(founder);
  // Pressing accept without the box saves nothing.
  await group.getByTestId("menu-clean-accept-automatic").click();
  await expect(seen(founder, "menu-error")).toContainText("tick the box to say you accept the automatic comparison");
  await seen(founder, "menu-clean-group").getByLabel(/I accept the automatic comparison for these 2 rows/).check();
  await seen(founder, "menu-clean-group").getByTestId("menu-clean-accept-automatic").click();
  await expect(seen(founder, "menu-flash")).toHaveText(
    "Saved: 0 confirmed, 4 matched to their source privately, 0 rejected. Nothing was published.",
  );
  const badge = row(founder, "Kale bowl").getByTestId("menu-transcribed").first();
  await expect(badge).toHaveText("Automatic comparison accepted by you, not compared by hand (private only)");
  await expect(badge).toHaveAttribute("data-basis", "automatic_comparison");
  await expect(row(founder, "Squash bowl")).not.toContainText("accepted by you");
  await axe(founder);
  const notes = (await pool.query(
    "select c.note from staging.fact_confirmations c join staging.facts f on f.id = c.fact_id where f.place_id = $1",
    [autoPlaceId],
  )).rows.map((r) => r.note as string);
  expect(notes).toHaveLength(4);
  expect(notes.every((n) => n.startsWith("Basis: automatic comparison accepted by the founder; not compared by hand."))).toBe(true);
  expect((await pool.query("select count(*)::int n from staging.publications where place_id = $1", [autoPlaceId])).rows[0].n).toBe(0);
});

test("clean rows from one source are confirmed together, flagged rows come first, and nothing is published", async ({
  browser,
}) => {
  const founder = await person(browser, "grouper", "publisher");
  await founder.goto(`/places/review/menus/${groupPlaceId}`);
  await expect(seen(founder, "menu-place-name")).toHaveText(GROUP_PLACE);
  // The flagged row is listed first, with its reasons.
  await expect(seen(founder, "menu-dish").first()).toContainText("Mystery bowl");
  await expect(row(founder, "Mystery bowl")).toContainText("Not sorted into meal");
  await expect(row(founder, "Mystery bowl")).toContainText("drafter was unsure");
  await expect(row(founder, "Tofu bowl")).toContainText("Complete meal");
  // The estimate sits apart from the facts, as a labelled range with its assumptions, and does not
  // stop the row from being clean.
  const estimate = row(founder, "Lentil plate").getByTestId("menu-estimate");
  await expect(estimate).toContainText("USDA estimate: about 16 to 28 g protein");
  await expect(estimate).toContainText("not the restaurant's figure");
  await estimate.locator("summary").click();
  await expect(estimate).toContainText("Nobody has reviewed these assumptions yet");
  await expect(estimate).toContainText("150 to 250 g");
  const group = seen(founder, "menu-clean-group");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("2 rows");
  await expect(group).toContainText("never makes them public");
  await axe(founder);
  await group.getByLabel(/I compared these 2 rows/).check();
  await group.getByTestId("menu-clean-save").click();
  await expect(seen(founder, "menu-flash")).toHaveText(
    "Saved: 0 confirmed, 4 matched to their source privately, 0 rejected. Nothing was published.",
  );
  await expect(seen(founder, "menu-clean-group")).toHaveCount(0);
  await expect(row(founder, "Mystery bowl")).not.toContainText("Matches the source");
  await expect(row(founder, "Tofu bowl").getByTestId("menu-transcribed").first()).toHaveAttribute("data-basis", "founder");
  // The coverage table on the list page counts the estimate separately from published nutrition.
  await founder.goto("/places/review/menus");
  const coverage = seen(founder, "menu-coverage");
  await expect(coverage.getByRole("columnheader", { name: GROUP_PLACE })).toBeVisible();
  await expect(coverage.locator('[data-measure="USDA estimate from typical amounts (not reviewed)"]')).toBeVisible();
  await axe(founder);
  expect(
    (
      await pool.query(
        "select count(*)::int n from staging.facts where place_id = $1 and status <> 'submitted'",
        [groupPlaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "select count(*)::int n from staging.publications where place_id = $1",
        [groupPlaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});

test("a member who is not the founder gets nothing", async ({ browser }) => {
  const member = await person(browser, "member");
  await member.goto("/places/review/menus");
  await expect(member.getByRole("heading", { level: 1 })).toHaveText("We couldn’t find that");
  await member.goto(`/places/review/menus/${placeId}`);
  await expect(seen(member, "review-founder-only")).toBeVisible();
  await expect(member.getByText("Chickpea bowl")).toHaveCount(0);
});
