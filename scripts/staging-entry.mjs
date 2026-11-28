// Pilot staging: enter or review facts about real restaurants in the LOCAL private staging area.
// LOCAL, or a hosted beta database for loading commands only (scripts/lib/db-target.mjs). (plan docs/27 A; approval A-STAGING-1). Nothing here publishes, contacts anyone or reads the web.
//
//   node scripts/staging-entry.mjs enter  <entries.json> --as <curator email> [--dry-run]
//   node scripts/staging-entry.mjs review <fact id> verify|reject --as <publisher email> [--note "..."]
//   node scripts/staging-entry.mjs overview
//
// entries.json: { "places": [ { "label", "area", "priority", "sources": [ {key, url, kind, publisher, retrievedAt, termsNote?} ],
//   "dishes": [ {key, label, type?, parent?, section?, portion?, basis?, evidence?} ],
//   "options": [ {dish, kind: add|remove|swap|size, label, component?, priceDeltaUsd?, source, checkedOn} ], "facts": [ {dish?, kind, subject?, value? | unknownReason, source, checkedOn, confidence?} ] } ] }
// A dish "type" (complete_meal, customizable_meal, component, base, protein, topping_sauce, side, beverage,
// dessert) is recorded with how it was decided (basis source_section | source_label | person); "parent" is
// the key of the build-your-own meal a part belongs to. It is entered only when it differs from the current one.
// published_nutrition values may say basis published (default) | published_range {low, high} | restaurant_estimate.
// Kinds include listed_ingredients ({"items": ["chickpeas", "tahini"]}); confidence is high | medium | low.
// A place or dish already staged under the same label is reused, so a later draft file adds to it.
// A fact already on record (same place, dish, kind, subject, value or unknown reason, source page and check
// date, and not rejected or replaced) is skipped, so entering the same file twice writes nothing new.
// Facts are entered as "submitted". A different person with the publisher role must check each one.
// The whole file goes in one transaction: if any entry is refused, nothing is written. With --dry-run
// every entry is checked by the database exactly as for a real entry, then the transaction is rolled
// back, so nothing is written either way.
import { readFileSync } from "node:fs";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, cmd, ["enter"]);
if (!["enter", "review", "overview"].includes(cmd)) throw new Error("Use: enter <file> --as <email> | review <fact id> verify|reject --as <email> | overview");

const client = new pg.Client({ connectionString: url });
await client.connect();
const actorId = async (email) => {
  if (!email) throw new Error("--as <email> is required");
  const r = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
  if (!r.rows[0]) throw new Error(`No local account ${email}`);
  return r.rows[0].id;
};
const one = async (sql, params) => (await client.query(`select ${sql} as r`, params)).rows[0].r;

try {
  if (cmd === "overview") {
    const r = await client.query("select * from staging.pilot_overview()");
    console.table(r.rows.map(({ place_id, ...x }) => x)); // eslint-disable-line @typescript-eslint/no-unused-vars
  } else if (cmd === "review") {
    const [factId, decision] = rest;
    const actor = await actorId(flag("--as"));
    console.log(await one("staging.review_fact($1, $2, $3, $4)", [actor, factId, decision, flag("--note") ?? null]));
  } else {
    const file = JSON.parse(readFileSync(rest[0], "utf8"));
    const actor = await actorId(flag("--as"));
    await client.query("begin");
    const summary = [];
    for (const p of file.places ?? []) {
      // A place already staged (same label and area) gets the new drafts; it is not entered twice.
      const known = await client.query("select id from staging.places where label = $1 and area = $2", [p.label, p.area]);
      const placeId = known.rows[0]?.id ?? (await one("staging.add_place($1, $2, $3, $4::smallint)", [actor, p.label, p.area, p.priority]));
      const src = {};
      for (const s of p.sources ?? []) {
        // One page read once can back several places (a chain's nutrition page): reuse its record
        // instead of entering the same page and time twice.
        const seen = await client.query("select id from staging.source_pages where url = $1 and retrieved_at = $2::timestamptz", [s.url, s.retrievedAt]);
        src[s.key] = seen.rows[0]?.id ?? (await one("staging.add_source_page($1, $2, $3, $4, $5::timestamptz, $6)", [actor, s.url, s.kind, s.publisher, s.retrievedAt, s.termsNote ?? null]));
      }
      const dish = {};
      for (const d of p.dishes ?? []) {
        const seenDish = await client.query("select id from staging.dishes where place_id = $1 and label = $2", [placeId, d.label]);
        dish[d.key] = seenDish.rows[0]?.id ?? (await one("staging.add_dish($1, $2, $3)", [actor, placeId, d.label]));
      }
      // Meals first, so a part can name the build-your-own meal it belongs to.
      const ordered = [...(p.dishes ?? [])].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
      for (const d of ordered) {
        if (!d.type) continue;
        if (d.parent && !dish[d.parent]) throw new Error(`${p.label}: unknown parent dish key ${d.parent}`);
        const cur = (await client.query("select dish_type, parent_dish_id from staging.current_structure($1) where id is not null", [dish[d.key]])).rows[0];
        const parent = d.parent ? dish[d.parent] : null;
        if (cur && cur.dish_type === d.type && cur.parent_dish_id === parent) continue;
        await one("staging.classify_dish($1, $2, $3, $4, $5, $6, $7, $8)", [actor, dish[d.key], d.type, parent, d.section ?? null, d.portion ?? null, d.basis ?? "source_section", d.evidence ?? null]);
      }
      for (const o of p.options ?? []) {
        if (!dish[o.dish] || (o.component && !dish[o.component])) throw new Error(`${p.label}: unknown dish key in option ${o.label}`);
        if (!src[o.source]) throw new Error(`${p.label}: unknown source key ${o.source}`);
        const seenOpt = await client.query("select 1 from staging.dish_options where dish_id = $1 and option_kind = $2 and label = $3", [dish[o.dish], o.kind, o.label]);
        if (seenOpt.rowCount) continue;
        await one("staging.add_dish_option($1, $2, $3, $4, $5, $6::date, $7, $8)", [actor, dish[o.dish], o.kind, o.label, src[o.source], o.checkedOn, o.component ? dish[o.component] : null, o.priceDeltaUsd ?? null]);
      }
      let facts = 0;
      let already = 0;
      for (const f of p.facts ?? []) {
        if (!src[f.source]) throw new Error(`${p.label}: unknown source key ${f.source}`);
        if (f.dish && !dish[f.dish]) throw new Error(`${p.label}: unknown dish key ${f.dish}`);
        // Re-entering the same file is a no-op: the same claim from the same source page and check date,
        // still on record (not rejected or replaced), is not submitted twice.
        const same = await client.query(
          `select 1 from staging.facts
            where place_id = $1 and dish_id is not distinct from $2 and kind = $3 and subject is not distinct from $4
              and source_page_id = $5 and checked_on = $6::date and status in ('submitted', 'verified')
              and value is not distinct from $7::jsonb and unknown_reason is not distinct from $8`,
          [placeId, f.dish ? dish[f.dish] : null, f.kind, f.subject ?? null, src[f.source], f.checkedOn, f.value === undefined ? null : JSON.stringify(f.value), f.unknownReason ?? null]);
        if (same.rowCount) { already += 1; continue; }
        await one("staging.submit_fact($1, $2::jsonb)", [actor, JSON.stringify({
          placeId, dishId: f.dish ? dish[f.dish] : undefined, kind: f.kind, subject: f.subject, value: f.value,
          unknownReason: f.unknownReason, sourcePageId: src[f.source], checkedOn: f.checkedOn, confidence: f.confidence,
        })]);
        facts += 1;
      }
      summary.push({ place: p.label, sources: Object.keys(src).length, dishes: Object.keys(dish).length, factsSubmitted: facts, alreadyOnRecord: already });
    }
    if (rest.includes("--dry-run")) {
      await client.query("rollback");
      console.table(summary);
      console.log("Dry run: every entry was accepted by the database, and nothing was written.");
    } else {
      await client.query("commit");
      console.table(summary);
    }
  }
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`Nothing written: ${e.message}${e.detail ? ` (${e.detail})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
