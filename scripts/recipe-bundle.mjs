#!/usr/bin/env node
// The 50 original recipes, carried to a hosted beta database without the demo library (owner direction 25 Nov 2026
// 21:53 UTC: finish hosted-beta preparation; never the seed on a hosted database).
//
// scripts/real-recipes.mjs builds the 12 first recipes by copying the demo library's structure, so it cannot run on a
// clean hosted database, which never receives supabase/seed.sql. Instead the recipes are built on a local database as
// usual (real-recipes.mjs load, then original-recipes.mjs load), exported here as plain rows, and imported unchanged.
//
//   node scripts/recipe-bundle.mjs export --out <file>     local database only; read-only
//   node scripts/recipe-bundle.mjs plan <file>             any target; read-only: what would be added, what is there
//   node scripts/recipe-bundle.mjs import <file> --confirm adds the rows that are missing, in one transaction
//
// Only rows under the two recipe id ranges are exported (a0000000-0000-4000-8000- for real-recipes.mjs and
// a0380000-0000-4000-8000- for original-recipes.mjs), from the recipe and food tables only: never an account, a diary,
// a review, a list or any other member's data. A demo row is refused. On import a row already on the target is left
// exactly as it is; if it differs from the bundle the whole import is refused, so nothing is ever overwritten.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const [cmd, file, ...rest] = process.argv.slice(2);
const args = [file, ...rest];
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const target = assertTarget(url, cmd, ["plan", "import"]);

const RANGES = ["a0000000-0000-4000-8000-%", "a0380000-0000-4000-8000-%"];
// In dependency order. `by` is the column that ties the row to a recipe or ingredient in the two ranges.
export const TABLES = [
  { name: "licenses", by: "id" },
  { name: "sources", by: "id" },
  { name: "source_records", by: "id" },
  { name: "food_items", by: "id" },
  { name: "food_revisions", by: "id" },
  { name: "nutrient_values", by: "revision_id" },
  { name: "portions", by: "revision_id" },
  { name: "dietary_claims", by: "revision_id" },
  { name: "allergen_statements", by: "revision_id" },
  { name: "ingredient_family_statements", by: "revision_id" },
  { name: "recipe_revisions", by: "food_revision_id" },
  { name: "recipe_ingredients", by: "recipe_revision_id" },
  { name: "recipe_steps", by: "recipe_revision_id" },
];
const inRange = (col) => `(${col}::text like '${RANGES[0]}' or ${col}::text like '${RANGES[1]}')`;
const inRangeJs = (v) => String(v).startsWith("a0000000-0000-4000-8000-") || String(v).startsWith("a0380000-0000-4000-8000-");
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function columns(c, table) {
  const rows = (await c.query(
    `select column_name, is_identity = 'YES' ident from information_schema.columns
      where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`, [table])).rows;
  return rows;
}
async function primaryKey(c, table) {
  return (await c.query(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = ('public.' || $1)::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`, [table])).rows.map((r) => r.attname);
}

async function exportBundle(c, out) {
  await c.query("begin read only");
  const tables = {};
  for (const t of TABLES) {
    const cols = (await columns(c, t.name)).map((x) => x.column_name);
    const list = cols.map((x) => `'${x}', t.${x}`).join(", ");
    tables[t.name] = (await c.query(`select jsonb_build_object(${list}) r from public.${t.name} t where ${inRange(`t.${t.by}`)} order by 1::text`)).rows.map((r) => r.r);
  }
  // Rows outside the two ranges that the recipes point at: the USDA release records that scripts/usda-import.mjs
  // creates, with a different id on every database. They travel by what they are (publisher and release file) and are
  // matched on the target the same way; the target must already have them (load the menus part first).
  const refs = new Set();
  for (const rows of Object.values(tables)) for (const r of rows) for (const [k, v] of Object.entries(r)) if (k.endsWith("source_record_id") && v && !inRangeJs(v)) refs.add(v);
  const external = (await c.query(
    `select sr.id, sr.external_id, s.publisher from public.source_records sr join public.sources s on s.id = sr.source_id where sr.id = any($1::uuid[])`, [[...refs]])).rows;
  await c.query("rollback");
  if (external.length !== refs.size) throw new Error("A recipe points at a source record that could not be described. Nothing written.");
  const demo = tables.food_items.filter((r) => r.is_demo).length + tables.sources.filter((r) => r.is_demo).length;
  if (demo) throw new Error(`${demo} demo rows in the recipe ranges. Nothing written.`);
  if (!tables.food_items.some((r) => r.kind === "recipe")) throw new Error("No recipes in this database: run real-recipes.mjs load and original-recipes.mjs load first. Nothing written.");
  for (const k of Object.keys(tables)) tables[k].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  writeFileSync(out, JSON.stringify({ format: "vfp-recipe-bundle-v1", exportedAt: new Date().toISOString(), external, tables }));
  const recipes = tables.food_items.filter((r) => r.kind === "recipe").length;
  console.log(`Wrote ${recipes} recipes and ${tables.food_items.length - recipes} ingredients (${Object.values(tables).reduce((n, r) => n + r.length, 0)} rows) to ${out} (SHA-256 ${sha(readFileSync(out))}). Nothing changed.`);
}

/** Per table: rows to add, rows already identical, rows that differ (any difference refuses the import). */
async function compare(c, bundle) {
  const out = [];
  for (const t of TABLES) {
    const rows = bundle.tables[t.name] ?? [];
    const pk = await primaryKey(c, t.name);
    const cols = (await columns(c, t.name)).map((x) => x.column_name);
    let add = 0, same = 0, differ = 0;
    const addIds = [];
    for (const r of rows) {
      const where = pk.map((k, i) => `t.${k}::text = $${i + 1}`).join(" and ");
      const have = (await c.query(`select jsonb_build_object(${cols.map((x) => `'${x}', t.${x}`).join(", ")}) r from public.${t.name} t where ${where}`, pk.map((k) => String(r[k])))).rows[0]?.r;
      if (!have) { add += 1; addIds.push(rowKey(pk, r)); }
      // food_items.current_revision_id is set last on import, so a row the import is adding may still lack it.
      else if (JSON.stringify(sortKeys(have)) === JSON.stringify(sortKeys(r))) same += 1;
      else differ += 1;
    }
    out.push({ table: t.name, add, same, differ, addIds });
  }
  return out;
}
const rowKey = (pk, r) => JSON.stringify(pk.map((k) => String(r[k])));
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

async function planOrImport(c, path, apply) {
  const raw = readFileSync(path);
  const bundle = JSON.parse(raw.toString("utf8"));
  if (bundle.format !== "vfp-recipe-bundle-v1") throw new Error("Not a recipe bundle. Nothing checked.");
  if (bundle.tables.food_items.some((r) => r.is_demo) || bundle.tables.sources.some((r) => r.is_demo)) throw new Error("The bundle holds demo rows. Nothing checked.");
  console.log(`Bundle SHA-256 ${sha(raw)}; target ${target.kind === "hosted" ? `hosted project ${target.ref}` : "this local database"}.`);
  // The USDA release records, found on the target by publisher and release file (exactly one each), never by id.
  const map = new Map();
  for (const e of bundle.external ?? []) {
    const found = (await c.query("select sr.id from public.source_records sr join public.sources s on s.id = sr.source_id where sr.external_id = $1 and s.publisher = $2", [e.external_id, e.publisher])).rows;
    if (found.length !== 1) {
      console.log(`Refused: the target has ${found.length} records for ${e.publisher} ${e.external_id} (needs exactly 1; load the reference part of scripts/hosted-import.mjs, which imports the USDA releases, first). Nothing changed.`);
      return 1;
    }
    map.set(e.id, found[0].id);
  }
  for (const rows of Object.values(bundle.tables))
    for (const r of rows) for (const k of Object.keys(r)) if (k.endsWith("source_record_id") && map.has(r[k])) r[k] = map.get(r[k]);
  if (!apply) {
    await c.query("begin read only");
    const cmp = await compare(c, bundle);
    await c.query("rollback");
    for (const r of cmp) console.log(`${r.table.padEnd(30)} add ${r.add}, already there ${r.same}, differ ${r.differ}`);
    const differ = cmp.reduce((n, r) => n + r.differ, 0);
    console.log(differ ? `${differ} rows differ: an import would be refused. Nothing changed.` : "Dry run. Nothing changed.");
    return differ ? 1 : 0;
  }
  await c.query("begin");
  const before = await compare(c, bundle);
  const differ = before.reduce((n, r) => n + r.differ, 0);
  if (differ) {
    await c.query("rollback");
    console.log(`Refused: ${differ} rows on the target differ from the bundle. Nothing changed.`);
    return 1;
  }
  if (!before.some((x) => x.add)) {
    await c.query("rollback");
    console.log("Every row in the bundle is already on the target, identical. Nothing changed.");
    return 0;
  }
  let added = 0;
  for (const t of TABLES) {
    const cols = await columns(c, t.name);
    const names = cols.map((x) => x.column_name);
    const ident = cols.some((x) => x.ident);
    const pk = await primaryKey(c, t.name);
    // Only the rows the target lacks: a row already there is identical (checked above) and is never written again.
    const missing = new Set(before.find((x) => x.table === t.name).addIds);
    for (const r of (bundle.tables[t.name] ?? []).filter((x) => missing.has(rowKey(pk, x)))) {
      // As the loaders do: an item starts approved with no current revision, and a revision starts unpublished, so
      // its nutrients, steps and ingredients can be added (a published revision's evidence is immutable). Both get
      // their exported values back below, once everything that belongs to them is there.
      const row = t.name === "food_items" ? { ...r, current_revision_id: null, status: "approved" } : t.name === "food_revisions" ? { ...r, published_at: null } : r;
      const res = await c.query(
        `insert into public.${t.name} (${names.join(", ")}) ${ident ? "overriding system value" : ""}
         select ${names.join(", ")} from jsonb_populate_record(null::public.${t.name}, $1::jsonb) on conflict do nothing`, [JSON.stringify(row)]);
      added += res.rowCount;
    }
  }
  // Only rows this import added are finished here (a row already on the target matched the bundle exactly above).
  const addedItems = new Set(before.find((x) => x.table === "food_items").addIds);
  const addedRevs = new Set(before.find((x) => x.table === "food_revisions").addIds);
  const idKey = (r) => JSON.stringify([String(r.id)]);
  for (const r of bundle.tables.food_revisions)
    if (addedRevs.has(idKey(r)) && r.published_at) await c.query("update public.food_revisions set published_at = $2 where id = $1 and published_at is null", [r.id, r.published_at]);
  for (const r of bundle.tables.food_items)
    if (addedItems.has(idKey(r))) await c.query("update public.food_items set current_revision_id = $2, status = $3 where id = $1 and current_revision_id is null", [r.id, r.current_revision_id, r.status]);
  const after = await compare(c, bundle);
  const bad = after.filter((r) => r.add || r.differ);
  if (bad.length) {
    await c.query("rollback");
    console.log(`Refused: after the import ${bad.map((r) => r.table).join(", ")} still differ from the bundle. Nothing changed.`);
    return 1;
  }
  await c.query("commit");
  console.log(`Added ${added} rows; every row in the bundle is now on the target exactly as exported.`);
  return 0;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (cmd === "export" && flag("--out")) {
    if (target.kind !== "local") throw new Error("Export runs on a local database only.");
    await exportBundle(client, flag("--out"));
  } else if (cmd === "plan" && file) process.exitCode = await planOrImport(client, file, false);
  else if (cmd === "import" && file) process.exitCode = await planOrImport(client, file, args.includes("--confirm"));
  else throw new Error("Use: export --out <file> | plan <file> | import <file> --confirm");
} finally {
  await client.end();
}
