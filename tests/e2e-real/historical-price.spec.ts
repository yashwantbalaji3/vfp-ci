import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pool } from "../helpers/db";
import { completeSignIn } from "../e2e/helpers";

// Owner decision 28 Nov 2026 02:27 UTC (decision 4): Pho Pasteur's September 2024 menu prices stay in staging as
// historical source evidence and are never shown as a current price. Founder view, disposable account (cloud copy).

test("a September 2024 Pho Pasteur price is kept as a record, not shown as current", async ({ browser }) => {
  const r = await pool.query(`
    select d.id from staging.dishes d join staging.places p on p.id = d.place_id
     where p.label = 'Pho Pasteur'
       and exists (select 1 from staging.dish_structure s where s.dish_id = d.id and s.dish_type = 'complete_meal')
       and exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'price' and not f.is_unknown and f.status <> 'rejected')
     order by d.label limit 1`).catch(() => ({ rows: [] as { id: string }[] }));
  test.skip(r.rows.length === 0, "Pho Pasteur is not loaded in this database");
  const dishId = r.rows[0].id as string;
  const stored = (await pool.query("select count(*)::int n from staging.facts where dish_id = $1 and kind = 'price' and not is_unknown", [dishId])).rows[0].n;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/New_York" });
  const page = await context.newPage();
  const email = `histprice-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/login?next=%2F");
  await completeSignIn(page, email);
  const id = (await pool.query("select id from auth.users where email = $1", [email])).rows[0].id as string;
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher') on conflict do nothing", [id]);
  try {
    await page.goto(`/meals/${dishId}`);
    const price = page.getByTestId("meal-price").filter({ visible: true });
    await expect(price).toHaveText("Current price not known");
    await expect(page.getByTestId("meal-price-historical").filter({ visible: true })).toContainText("September 2024");
    await expect(price).not.toContainText("$");
    // The record itself is untouched.
    expect((await pool.query("select count(*)::int n from staging.facts where dish_id = $1 and kind = 'price' and not is_unknown", [dishId])).rows[0].n).toBe(stored);
  } finally {
    await context.close();
    await pool.query("delete from public.role_assignments where user_id = $1", [id]);
  }
});
