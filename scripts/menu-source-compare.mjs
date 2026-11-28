// Automatic comparison of drafted menu facts with the SAVED copy of their source page (docs/58,
// owner direction 18 Nov 2026 23:20 UTC). LOCAL ONLY. Nothing here reads the web, confirms, verifies
// or publishes anything: each result is recorded as an automatic check, separate from any decision by
// a person, and the founder's screens always show it as automatic.
//
//   node scripts/menu-source-compare.mjs <page-map.json> --as <curator email> [--dry-run] [--list]
//   (--list prints each "not found" result with its dish, for tuning the comparison)
//   (--only-mapped compares only facts whose page is in the map and leaves every other fact's latest check as it
//    is; without it, a fact whose page is missing is recorded "not_checked")
//
// page-map.json: { "pages": [ { "url", "file", "textFile"?, "savedAt", "sha256"? } ] }
//   url       the source page URL as staged (a www. prefix and a trailing slash are ignored)
//   file      the saved copy exactly as fetched; its SHA-256 is recorded with every result
//   textFile  optional plain text of the same file (for a PDF); searched instead of the file
//   sha256    optional fingerprint from the fetch log; when it differs from the file, nothing is compared
//
// For each fact waiting for review, the comparison looks for the dish name on the saved page and then
// for the drafted value close after it (or, for a dietary claim, in the dish's section heading or a
// statement covering the whole menu). The result is "found", "not_found" or "not_checked" with what was
// searched. "found" means only that the text appears where expected; it is never a confirmation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { compareFact, fold, otherDishStarts, pageText } from "./lib/source-compare.mjs";

const [file, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (!file) throw new Error("Use: node scripts/menu-source-compare.mjs <page-map.json> --as <curator email> [--dry-run]");
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");

const key = (u) => {
  const x = new URL(u);
  return `${x.host.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const map = JSON.parse(readFileSync(file, "utf8"));
  const base = dirname(resolve(file));
  const pages = new Map();
  for (const p of map.pages) {
    const bytes = readFileSync(resolve(base, p.file));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const changed = p.sha256 && p.sha256 !== sha;
    const text = p.textFile ? fold(readFileSync(resolve(base, p.textFile), "utf8")) : pageText(bytes.toString("utf8"));
    pages.set(key(p.url), { sha, savedAt: p.savedAt, text, changed });
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  try {
    const email = flag("--as");
    if (!email) throw new Error("--as <email> is required");
    const actor = (await q("select id from auth.users where lower(email) = lower($1)", [email]))[0]?.id;
    if (!actor) throw new Error(`No local account ${email}`);
    const facts = await q(`
      select f.id, f.kind, f.subject, f.value, f.is_unknown as unknown, d.label as dish, sp.url,
             (select s.section from staging.dish_structure s where s.dish_id = d.id order by s.created_at desc, s.id desc limit 1) as section
        from staging.facts f join staging.dishes d on d.id = f.dish_id join staging.source_pages sp on sp.id = f.source_page_id
       where f.status = 'submitted' and not sp.is_demo
       order by d.label, f.kind`);
    // The dishes drafted from each page, so a value is only credited to the dish it is printed under.
    const dishesOn = new Map();
    for (const f of facts) {
      const m = dishesOn.get(key(f.url)) ?? new Map();
      if (!m.get(f.dish)) m.set(f.dish, f.kind === "price" && !f.unknown ? (f.value?.usd ?? null) : null);
      dishesOn.set(key(f.url), m);
    }
    const startsCache = new Map();
    const startsFor = (f, text) => {
      const k = `${key(f.url)}|${f.dish}`;
      if (!startsCache.has(k)) startsCache.set(k, otherDishStarts(text, f.dish, [...dishesOn.get(key(f.url))].map(([label, usd]) => ({ label, usd }))));
      return startsCache.get(k);
    };
    await client.query("begin");
    const tally = {};
    let skipped = 0;
    for (const f of facts) {
      const page = pages.get(key(f.url));
      if (!page && rest.includes("--only-mapped")) {
        skipped += 1;
        continue;
      }
      const r = !page
        ? { result: "not_checked", detail: "No saved copy of the source page is available here." }
        : page.changed
          ? { result: "not_checked", detail: "The saved copy differs from the fingerprint taken when it was fetched." }
          : compareFact(page.text, f, startsFor(f, page.text));
      tally[`${f.kind}:${r.result}`] = (tally[`${f.kind}:${r.result}`] ?? 0) + 1;
      if (rest.includes("--list") && r.result === "not_found") console.log(`${f.dish} | ${f.kind} ${f.subject ?? ""} | ${r.detail}`);
      await q("select staging.record_machine_check($1, $2, $3, $4, $5, $6)",
        [actor, f.id, r.result, r.detail, r.result === "not_checked" && !page ? null : page?.sha ?? null, page?.savedAt ?? null]);
    }
    await client.query(rest.includes("--dry-run") ? "rollback" : "commit");
    console.table(Object.entries(tally).map(([k, n]) => ({ check: k, facts: n })));
    console.log(`${rest.includes("--dry-run") ? "Dry run: nothing written" : "Recorded"} ${facts.length - skipped} automatic checks${skipped ? ` (${skipped} facts on other pages left as they were)` : ""}.`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}
