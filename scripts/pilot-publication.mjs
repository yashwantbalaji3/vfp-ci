// Pilot publication: prepare a DRAFT public place and its dishes from facts the founder has verified
// in the LOCAL private staging area (docs/29). Nothing here publishes: a different person with the
// publisher role approves each change in the app's editor (/editor/changes), and approval is refused
// while the real-data lock ('pilot_publication') is off. This script cannot turn the lock on.
//
//   node scripts/pilot-publication.mjs list
//   node scripts/pilot-publication.mjs prepare "<staged place label>" --as <curator email>
//   node scripts/pilot-publication.mjs status <publication id>
import pg from "pg";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
if (!["list", "prepare", "status"].includes(cmd)) throw new Error('Use: list | prepare "<place label>" --as <email> | status <publication id>');

const client = new pg.Client({ connectionString: url });
await client.connect();
const one = async (sql, params) => (await client.query(`select ${sql} as r`, params)).rows[0].r;

const REASONS = {
  not_confirmed_on_menu: "dish not confirmed on the restaurant's current menu by a verified fact",
  source_not_usable: "its source is not the restaurant's own page, or its rights are denied",
  per_100g_needs_serving_weight: "a per-100 g figure needs a verified serving weight first",
  allergen_word_not_in_catalog: "an allergen word is not in the catalog's list, so it was not guessed",
  price_on_other_page: "the price was read on a different page from the menu listing",
  hours_unreadable: "the opening hours could not be read reliably",
};

try {
  if (cmd === "list") {
    const r = await client.query(`select p.id, pl.label, p.prepared_at, v.status as venue_status
                                    from staging.publications p join staging.places pl on pl.id = p.place_id
                                    join public.venues v on v.id = p.venue_id order by p.prepared_at`);
    if (!r.rows.length) console.log("No publications prepared yet.");
    else console.table(r.rows);
  } else if (cmd === "prepare") {
    const email = flag("--as");
    if (!email) throw new Error("--as <email> is required");
    const actor = (await client.query("select id from auth.users where lower(email) = lower($1)", [email])).rows[0]?.id;
    if (!actor) throw new Error(`No local account ${email}`);
    const place = (await client.query("select id from staging.places where label = $1", [rest[0]])).rows[0]?.id;
    if (!place) throw new Error(`No staged place called "${rest[0]}"`);
    const r = await one("staging.prepare_publication($1, $2)", [actor, place]);
    const dishes = r.changes.filter((c) => c.kind === "dish");
    console.log(`Prepared ${r.place.name}: 1 place change and ${dishes.length} dish change(s), all waiting for a second person in the editor.`);
    for (const d of dishes) console.log(`  - ${d.name}: protein ${d.nutrition.protein_g ?? "unknown"}${d.nutrition.protein_g != null ? " g (restaurant's figure)" : ""}; dietary ${JSON.stringify(d.dietary)}`);
    for (const l of r.leftOut) console.log(`  left out: ${REASONS[l.reason] ?? l.reason}`);
    console.log(`Publication ${r.publicationId}. Publishing real restaurants is locked until the founder approves it.`);
  } else {
    console.log(JSON.stringify(await one("staging.publication_status($1)", [rest[0]]), null, 2));
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
