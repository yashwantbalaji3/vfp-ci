// Boston coverage report (MENU-8, docs/41): the owner's ten counts, each kept separate.
// LOCAL ONLY. Reads the private catalog, staging and menu areas; writes nothing to the database.
//
//   node scripts/coverage-report.mjs [--out file.md] [--json]
//
// Identity, menu and dietary verification are never added together. A dietary statement counts for a
// location only when it is about that location's dish: brand-wide statements (a chain's ingredient
// list, a dish on the brand's page) and preliminary labels are counted apart, never as explicit. "Submitted" means researched
// and waiting for the founder; "verified" means the founder checked it. Nothing here is public.
import { writeFileSync } from "node:fs";
import pg from "pg";

/** @param {import("pg").ClientBase} client */
export async function coverage(client) {
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  const catalog = await one(`
    select count(*) filter (where quality <> 'rejected')::int identified,
           count(*) filter (where quality = 'corroborated')::int corroborated,
           count(*) filter (where preview_tier = 'preview')::int preview
      from catalog_import.place_candidates`);
  const confirmed = await one(`
    select count(distinct candidate_id)::int n from (
      select distinct on (candidate_id) candidate_id, decision from catalog_import.identity_decisions
       order by candidate_id, decided_at desc, id desc) d where decision = 'verify_identity'`);
  const listings = await one(`
    select count(*) filter (where visibility = 'public')::int public, count(*) filter (where identity_status = 'verified')::int verified
      from public.place_listings`);
  // One researched location = its linked catalog place, else its address, else the staged profile.
  const staged = (await client.query(`
    with addr as (
      select distinct on (f.place_id) f.place_id, staging.address_key(f.value ->> 'street', f.value ->> 'postcode') k
        from staging.facts f
       where f.kind = 'address' and not f.is_unknown and f.status in ('submitted', 'verified')
       order by f.place_id, f.entered_at desc),
    loc as (
      select p.id place_id, coalesce(k.candidate_id::text, a.k, p.id::text) loc
        from staging.places p left join addr a on a.place_id = p.id left join staging.live_catalog_links k on k.staging_place = p.id),
    -- Only facts from cleared sources count (owner 22:37 UTC 17 Nov; docs/46). Held facts are counted apart.
    live as (select f.* from staging.facts f join staging.source_pages s on s.id = f.source_page_id
              where f.status in ('submitted', 'verified') and staging.source_access_state(s.url) = 'cleared')
    select l.loc,
           bool_or(f.kind = 'menu_item' and not f.is_unknown and f.value ->> 'listed' = 'true') menu_any,
           bool_or(f.kind = 'menu_item' and not f.is_unknown and f.value ->> 'listed' = 'true' and f.status = 'verified') menu_verified,
           bool_or(f.kind = 'dietary_status' and not f.is_unknown and f.subject in ('vegetarian', 'vegan') and f.value ->> 'status' = 'yes'
                   and coalesce(f.value ->> 'evidence', '') not like 'preliminary%' and coalesce(f.value ->> 'scope', '') not like 'brand_wide%') veg_explicit,
           bool_or(f.kind = 'dietary_status' and not f.is_unknown and f.subject in ('vegetarian', 'vegan') and f.value ->> 'status' = 'yes'
                   and f.value ->> 'evidence' like 'preliminary%' and coalesce(f.value ->> 'scope', '') not like 'brand_wide%') veg_preliminary,
           bool_or(f.kind = 'dietary_status' and not f.is_unknown and f.subject in ('vegetarian', 'vegan') and f.value ->> 'status' = 'yes' and f.status = 'verified') veg_verified,
           bool_or(f.kind = 'dietary_status' and not f.is_unknown and f.subject = 'vegan' and f.value ->> 'status' = 'yes'
                   and coalesce(f.value ->> 'evidence', '') not like 'preliminary%' and coalesce(f.value ->> 'scope', '') not like 'brand_wide%') vegan_any,
           bool_or(f.kind = 'dietary_status' and not f.is_unknown and f.subject = 'vegan' and f.value ->> 'status' = 'yes' and f.status = 'verified') vegan_verified,
           bool_or(f.status = 'submitted') awaiting,
           bool_or(k.candidate_id is not null) linked
      from loc l
      left join live f on f.place_id = l.place_id
      left join staging.live_catalog_links k on k.staging_place = l.place_id
     group by l.loc`)).rows;
  const count = (key) => staged.filter((r) => r[key]).length;
  const protein = await one(`
    select count(distinct (f.place_id, f.dish_id)) filter (where f.status in ('submitted', 'verified'))::int published,
           count(distinct (f.place_id, f.dish_id)) filter (where f.status = 'verified')::int published_verified
      from staging.facts f join staging.source_pages s on s.id = f.source_page_id
     where f.kind = 'published_nutrition' and f.subject = 'protein_g' and not f.is_unknown and f.dish_id is not null
       and staging.source_access_state(s.url) = 'cleared'`);
  const held = await one(`
    select coalesce(sum(facts), 0)::int facts, coalesce(sum(facts) filter (where state = 'prohibited'), 0)::int prohibited,
           coalesce(sum(facts) filter (where state = 'pending'), 0)::int pending,
           coalesce(sum(facts) filter (where state = 'private_pilot'), 0)::int private_pilot, coalesce(sum(protein_facts), 0)::int protein,
           count(distinct place_id)::int places
      from staging.held_sources()`);
  const dishes = await one(`
    select count(distinct d.id)::int dishes,
           count(distinct d.id) filter (where exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
                                                       where f.dish_id = d.id and f.status = 'submitted' and staging.source_access_state(s.url) = 'cleared'))::int awaiting
      from staging.dishes d`);
  const menuSources = (await client.query("select to_regclass('menu_ingest.source_status') r")).rows[0].r
    ? (await client.query("select state, count(*)::int websites, coalesce(sum(places), 0)::int places from menu_ingest.source_status group by state order by state")).rows
    : null;
  return {
    identified: catalog.identified,
    identityCorroborated: catalog.corroborated,
    preview: catalog.preview,
    identityConfirmed: confirmed.n,
    researchedLocations: staged.length,
    linkedToCatalog: count("linked"),
    usableMenu: { researched: count("menu_any"), verified: count("menu_verified") },
    vegetarianDish: { explicit: count("veg_explicit"), preliminaryOnly: staged.filter((r) => r.veg_preliminary && !r.veg_explicit).length, verified: count("veg_verified") },
    veganDish: { stated: count("vegan_any"), verified: count("vegan_verified") },
    protein: {
      published: protein.published, publishedVerified: protein.published_verified,
      // No real dish is tied to a calculation model yet (MENU-6); demo models are never counted.
      calculated: 0, estimatedRange: 0,
    },
    awaiting: { locations: count("awaiting"), dishes: dishes.awaiting, totalDishes: dishes.dishes },
    eligibleForPublication: listings.verified,
    public: listings.public,
    held,
    menuSources,
  };
}

export function coverageMarkdown(c, asOf = new Date().toISOString().slice(0, 10)) {
  const L = [`# Boston coverage (${asOf})`, "",
    "Identity, menu and dietary evidence are counted separately. \"Researched\" facts are unverified until the founder checks them. Nothing here is public.", "",
    "| Measure | Count |", "| --- | --- |",
    `| Real places identified | ${c.identified} |`,
    `| Identity corroborated by two public sources | ${c.identityCorroborated} (${c.preview} in the preview) |`,
    `| Identity confirmed by the founder | ${c.identityConfirmed} |`,
    `| Researched locations | ${c.researchedLocations} (${c.linkedToCatalog} tied to a catalog place) |`,
    `| Usable menu | ${c.usableMenu.researched} researched, ${c.usableMenu.verified} verified |`,
    `| Held for source clearance (not counted anywhere else) | ${c.held.facts} facts at ${c.held.places} places: ${c.held.prohibited} prohibited, ${c.held.pending} pending, ${c.held.private_pilot} in the founder-only private pilot; ${c.held.protein} protein figures |`,
    `| At least one supported vegetarian dish | ${c.vegetarianDish.explicit} on an explicit label, ${c.vegetarianDish.preliminaryOnly} more on a preliminary label only, ${c.vegetarianDish.verified} verified |`,
    `| At least one supported vegan dish | ${c.veganDish.stated} stated, ${c.veganDish.verified} verified |`,
    `| Dishes with published protein | ${c.protein.published} researched, ${c.protein.publishedVerified} verified |`,
    `| Dishes with calculated protein | ${c.protein.calculated} |`,
    `| Dishes with an estimated protein range | ${c.protein.estimatedRange} |`,
    `| Awaiting verification | ${c.awaiting.locations} locations, ${c.awaiting.dishes} of ${c.awaiting.totalDishes} dishes |`,
    `| Eligible for publication | ${c.eligibleForPublication} (public: ${c.public}) |`];
  if (c.menuSources) {
    L.push("", "## Menu sources", "", "| State | Websites | Places |", "| --- | --- | --- |", ...c.menuSources.map((r) => `| ${r.state} | ${r.websites} | ${r.places} |`));
  }
  return L.join("\n") + "\n";
}

async function main() {
  const rest = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const c = await coverage(client);
    if (rest.includes("--json")) { console.log(JSON.stringify(c, null, 2)); return; }
    const md = coverageMarkdown(c);
    if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}`); } else process.stdout.write(md);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
