// Authorized menu exports (MENU-2b, owner direction 17 Nov 2026 22:06 UTC, point 7): one reusable
// way to bring in a menu the restaurant itself gave us under written permission, instead of a
// scraper per website. LOCAL ONLY database. Nothing is verified or published.
//
//   node scripts/menu-export-import.mjs <file.json|file.csv> --host <restaurant site> [--document-date YYYY-MM-DD]
//
// The source must hold a current written permission or licence that permits this use
// (menu-sources.mjs permission ... --kind written_permission --status permits --uses "...").
// The file is kept as a snapshot tied to that permission, then read into items with the
// restaurant's own words and numbers; a blank value stays blank, never zero.
//
// JSON: { "document_date": "2026-11-01", "items": [{ "name", "description", "section", "labels": [],
//         "legend": {}, "ingredients", "allergens", "price_usd", "serving", "serving_grams",
//         "nutrition": { "protein_g": { "amount": 21, "unit": "g", "per": "serving" } } }] }
// CSV:  name,description,section,labels,ingredients,allergens,price_usd,serving,serving_grams,
//       calories_kcal,protein_g,carb_g,fat_g,fiber_g,sodium_mg,sugar_g   (labels separated by ";")
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";
import { matchKey } from "./lib/menu-readers.mjs";

export const EXPORT_READER = "menu_export@1";
const sha = (b) => createHash("sha256").update(b).digest("hex");
export { parseCsv, readExport } from "./lib/menu-export.mjs";
import { readExport } from "./lib/menu-export.mjs";

/** Store an authorized export and read it into items. Refuses without a current permission. */
export async function importExport(client, { host, file, documentDate = null }) {
  const st = (await client.query("select id, state, permission_kind, permission_status from menu_ingest.source_status where host = $1", [host])).rows[0];
  if (!st) throw new Error(`No source ${host}`);
  if (st.permission_status !== "permits" || !["written_permission", "licence"].includes(st.permission_kind) || !["may_import", "may_fetch"].includes(st.state)) {
    throw new Error(`No current written permission or licence for ${host} (state ${st.state}); record one first`);
  }
  const perm = (await client.query("select id from menu_ingest.access_permissions where source_id = $1 order by reviewed_at desc, id desc limit 1", [st.id])).rows[0].id;
  const body = readFileSync(file);
  const kind = /\.json$/i.test(file) ? "json" : /\.csv$/i.test(file) ? "csv" : null;
  if (!kind) throw new Error("Use a .json or .csv export");
  const parsed = readExport(body.toString("utf8"), kind);
  const url = `https://${host}/authorized-export/${encodeURIComponent(basename(file))}`;
  const snap = (await client.query(`
    insert into menu_ingest.snapshots (source_id, permission_id, url, fetched_at, fetched_via, http_status, content_type, sha256, bytes, body)
    values ($1, $2, $3, coalesce($4::date::timestamptz, now()), 'authorized_export', 200, $5, $6, $7, $8) on conflict (url, sha256) do nothing returning id`,
    [st.id, perm, url, documentDate ?? parsed.documentDate, kind === "json" ? "application/json" : "text/csv", sha(body), body.length, body])).rows[0]?.id;
  if (!snap) return { snapshot: null, items: 0, already: true };
  const run = (await client.query("insert into menu_ingest.read_runs (snapshot_id, reader, items, note) values ($1, $2, $3, $4) returning id",
    [snap, EXPORT_READER, parsed.items.length, parsed.items.length ? null : "No items in this export"])).rows[0].id;
  let items = 0;
  for (const it of parsed.items) {
    const key = matchKey(it.name);
    if (!key) continue;
    await client.query(`
      insert into menu_ingest.items (read_run_id, source_id, name, description, section, labels, legend, ingredients, allergens, price_usd, serving, serving_grams, nutrition, match_key, item_sha256)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) on conflict do nothing`,
      [run, st.id, it.name.slice(0, 300), it.description?.slice(0, 2000) ?? null, it.section?.slice(0, 200) ?? null, it.labels, it.legend, it.ingredients?.slice(0, 4000) ?? null,
       it.allergens?.slice(0, 1000) ?? null, it.price_usd, it.serving?.slice(0, 200) ?? null, it.serving_grams, it.nutrition, key, sha(JSON.stringify(it))]);
    items++;
  }
  return { snapshot: snap, items, already: false };
}

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (!file || !flag("--host")) throw new Error("Use: menu-export-import.mjs <file.json|file.csv> --host <site> [--document-date YYYY-MM-DD]");
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await importExport(client, { host: flag("--host"), file, documentDate: flag("--document-date") ?? null });
    console.log(r.already ? "This exact export is already stored." : `Stored the export and read ${r.items} items (unverified, private).`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
