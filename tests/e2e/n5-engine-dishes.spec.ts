import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { DISHES, demoRelease, loadDemoDishes } from "../../scripts/lib/nie-demo-dishes.mjs";
import { completeSignIn, expectNoSidewaysScroll } from "./helpers";

/**
 * NIE N-5 in a real browser: the ten synthetic demo dishes, worked out by the nutrition engine, read
 * in words at phone width. A calculated dish lists every ingredient with its USDA reference; an
 * estimate stays hidden until the visitor asks; an unknown dish shows no number; a restaurant's own
 * figure is shown as theirs, and the one that disagrees with our calculation by more than 25 % waits
 * on the editor desk. This file removes everything it added at the end (triggers paused for that one
 * clean-up transaction), so other browser test files see the seeded catalog as before.
 */
test.use({ viewport: { width: 360, height: 740 }, timezoneId: "America/New_York" });
test.setTimeout(180_000);

const ids = DISHES.map((d) => d.id);
const byName = (n: string) => DISHES.find((d) => d.name === n)!.id;
const made: { users: string[]; release?: string; createdRelease: boolean } = { users: [], createdRelease: false };

test.beforeAll(async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const mk = async (role: string) => {
      const id = randomUUID();
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
        [id, `n5-${role}-${id.slice(0, 8)}@example.test`],
      );
      await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, role]);
      made.users.push(id);
      return id;
    };
    const curator = await mk("curator");
    const publisher = await mk("publisher");
    const before = (await c.query("select count(*)::int n from app.usda_releases")).rows[0].n;
    made.release = await demoRelease(c, { allowExcerpt: true });
    made.createdRelease = (await c.query("select count(*)::int n from app.usda_releases")).rows[0].n > before;
    await loadDemoDishes(c, { curator, publisher, releaseId: made.release });
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
});

test.afterAll(async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const calcs = (await c.query(
      "select nv.calculation_id, nv.source_record_id from public.nutrient_values nv join public.food_revisions r on r.id = nv.revision_id where r.food_item_id = any($1::uuid[]) and nv.calculation_id is not null", [ids])).rows;
    const checkCalcs = (await c.query("select calculation_id from app.nie_published_checks where food_item_id = any($1::uuid[])", [ids])).rows.map((r) => r.calculation_id);
    const allCalcs = [...calcs.map((r) => r.calculation_id), ...checkCalcs];
    const records = calcs.map((r) => r.source_record_id).filter(Boolean);
    const models = (await c.query("select model_id from app.nie_calculations where id = any($1::uuid[])", [allCalcs])).rows.map((r) => r.model_id);
    // Public rows with their normal cascades (revisions, nutrition, dishes, portions, comparisons).
    await c.query("delete from public.food_items where id = any($1::uuid[])", [ids]);
    await c.query("delete from public.source_records where id = any($1::uuid[])", [records]);
    // The engine's permanent records: guards paused for this clean-up only.
    await c.query("set local session_replication_role = replica");
    await c.query("delete from app.nie_calculations where id = any($1::uuid[])", [allCalcs]);
    await c.query("delete from app.nie_model_lines where model_id = any($1::uuid[])", [models]);
    await c.query("delete from app.nie_dish_models where id = any($1::uuid[])", [models]);
    let releaseRecord: string | undefined;
    if (made.createdRelease && made.release) {
      releaseRecord = (await c.query("select source_record_id from app.usda_releases where id = $1", [made.release])).rows[0]?.source_record_id;
      await c.query("delete from app.usda_foods where release_id = $1", [made.release]);
      await c.query("delete from app.usda_releases where id = $1", [made.release]);
    }
    await c.query("set local session_replication_role = origin");
    if (releaseRecord) await c.query("delete from public.source_records where id = $1", [releaseRecord]);
    await c.query("delete from auth.users where id = any($1::uuid[])", [made.users]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
});

async function noAxeFailures(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test("each kind of protein figure reads differently, and the engine's working is shown ingredient by ingredient", async ({ page }) => {
  // Calculated from stated amounts: every ingredient, its USDA reference, the raw/cooked conversion.
  await page.goto(`/foods/${byName("Demo red lentil and spinach soup")}`);
  const how = page.getByTestId("protein-explanation");
  await expect(how).toHaveAttribute("data-state", "calculated");
  await expect(how).toContainText("25.5 g protein");
  await how.getByText("Ingredient by ingredient").click();
  const calc = page.getByTestId("explanation-calculation");
  await expect(calc).toContainText("Lentils, raw (FDC 172420, SR Legacy 2018-04)");
  await expect(calc).toContainText("Converted with a cooked-to-raw weight ratio of 2.5");
  await expect(calc).toContainText("Spinach, raw (FDC 168462");
  await expectNoSidewaysScroll(page);
  await noAxeFailures(page);

  // Estimate: hidden until asked, then a range with its reliability, never one exact number.
  await page.goto(`/foods/${byName("Demo hummus and pita plate")}`);
  await expect(page.getByTestId("protein-explanation")).toHaveAttribute("data-state", "estimate_hidden");
  await expect(page.getByTestId("protein-explanation")).not.toContainText(/\d+(\.\d)? g protein/);
  await page.getByRole("link", { name: "Show the estimate and how we got it" }).click();
  await expect(page.getByTestId("protein-explanation")).toHaveAttribute("data-state", "estimated_range");
  await expect(page.getByTestId("explanation-range")).toContainText("Between 9.6 g and 15.6 g protein, most likely about 12.5 g");
  await expect(page.getByTestId("protein-explanation")).toContainText("Wide range");
  await noAxeFailures(page);

  // Unknown: no number and no guess.
  await page.goto(`/foods/${byName("Demo lentil and rice plate")}?est=1`);
  await expect(page.getByTestId("protein-explanation")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("protein-explanation")).toContainText("We don’t fill the gap with a guess");
  await expect(page.getByTestId("protein-explanation")).not.toContainText(/\b\d+(\.\d)? g/);

  // The restaurant's own figure, shown as theirs, even though our calculation differs by 49 %.
  await page.goto(`/foods/${byName("Demo tofu scramble")}`);
  await expect(page.getByTestId("protein-explanation")).toHaveAttribute("data-state", "restaurant_published");
  await expect(page.getByTestId("protein-explanation")).toContainText("18 g protein, as the restaurant publishes it");
  await expect(page.getByTestId("protein-explanation")).not.toContainText("26.8");
});

test("the disagreement waits on the editor desk for a person", async ({ page }) => {
  const email = `n5-editor-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2Feditor");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  made.users.push(id);
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [id]);
  await page.goto("/editor");
  const list = page.getByTestId("desk-nutrition-checks");
  await expect(list).toContainText("Demo tofu scramble");
  await expect(list).toContainText("The restaurant publishes 18 g protein; our calculation from the ingredients gives 26.8 g, 49% apart (more than 25%)");
  await expect(list).not.toContainText("Demo egg, spinach and feta wrap"); // 8 % apart: no one needs to look
  await expectNoSidewaysScroll(page);
  await noAxeFailures(page);
});
