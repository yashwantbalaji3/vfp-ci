#!/usr/bin/env node
// Give every Boston-area listing its neighbourhood (owner directive 27 Nov 2026 06:04 UTC, Boston first).
// Migration 20261127000100 decides the area of each new or changed listing; listings already in a database keep
// their old area (often none) until this runs once.
//
//   node scripts/boston-areas.mjs            read-only: what would change, area by area
//   node scripts/boston-areas.mjs --apply    make the change, in one transaction
//
// LOCAL databases only. It rewrites place_listings.area and nothing else: before committing it checks that the
// number of listings and a fingerprint of every other column are unchanged, and rolls back otherwise. A linked
// venue's neighbourhood follows through the existing sync trigger. No decision, review, fact, visibility or switch
// is touched. Rollback: the exact update in the migration's header.
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
assertTarget(url, apply ? "apply" : "check", []);

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
// Every column except area and updated_at (the guard trigger stamps updated_at on any update).
const FINGERPRINT = `select count(*)::int n, md5(string_agg(md5(row(id, candidate_id, market_slug, slug, name, street, locality, postcode,
  lat, lon, category, identity_status, menu_status, sources, visibility, built_from, publication_batch, venue_id, cuisines)::text), '' order by id)) h
  from public.place_listings`;
try {
  await client.query(apply ? "begin" : "begin read only");
  if (!(await q("select 1 from pg_proc where proname = 'boston_area'")).length) throw new Error("app.boston_area() is missing: apply migration 20261127000100 first. Nothing done.");
  const plan = await q(`
    select coalesce(area, '(no area)') was, coalesce(app.boston_area(postcode, locality, lon), '(no area)') becomes, count(*)::int n
      from public.place_listings
     where market_slug = 'boston' and area is distinct from app.boston_area(postcode, locality, lon)
     group by 1, 2 order by 3 desc`);
  const total = plan.reduce((s, r) => s + r.n, 0);
  const after = await q(`select coalesce(app.boston_area(postcode, locality, lon), '(no area)') area, count(*)::int n
      from public.place_listings where market_slug = 'boston' group by 1 order by 2 desc`);
  console.log(`${total} Boston-area listing(s) would get a different area${apply ? "" : " (read-only check; --apply makes the change)"}.`);
  for (const r of plan.slice(0, 40)) console.log(`  ${String(r.n).padStart(6)}  ${r.was} -> ${r.becomes}`);
  if (plan.length > 40) console.log(`  ... and ${plan.length - 40} smaller groups`);
  console.log("Areas afterwards:");
  for (const r of after) console.log(`  ${String(r.n).padStart(6)}  ${r.area}`);
  if (apply && total > 0) {
    const [before] = await q(FINGERPRINT);
    await client.query(`update public.place_listings set area = app.boston_area(postcode, locality, lon)
                         where market_slug = 'boston' and area is distinct from app.boston_area(postcode, locality, lon)`);
    const [now] = await q(FINGERPRINT);
    if (before.n !== now.n || before.h !== now.h) throw new Error("Something other than the area changed. Rolled back; nothing changed.");
    const [left] = await q("select count(*)::int n from public.place_listings where market_slug = 'boston' and area is distinct from app.boston_area(postcode, locality, lon)");
    if (left.n !== 0) throw new Error(`${left.n} listing(s) still differ. Rolled back; nothing changed.`);
    await client.query("commit");
    console.log(`Done: ${total} area(s) set. Listing count (${now.n}) and every other column unchanged.`);
  } else await client.query("rollback");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
