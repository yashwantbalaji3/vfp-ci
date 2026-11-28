#!/usr/bin/env node
// Boston coverage metrics (owner direction 24 Nov 2026 03:27 UTC, M3 "Define meaningful coverage metrics").
// LOCAL ONLY and READ-ONLY: one read-only transaction; it writes nothing anywhere except the optional --out file.
//
//   node scripts/coverage-metrics.mjs [--json] [--out file.md]
//
// Each level is counted apart and never added to another:
//   directory listing  a restaurant identity in the private catalog (not a claim about its food)
//   linked menu        a researched menu tied to one of those identities
//   stated meal        a complete meal the researched draft says the restaurant calls vegetarian or vegan
//   source-backed meal a complete meal whose menu entry comes from a cleared source and whose restaurant's own words
//                      say vegetarian or vegan, with no record saying otherwise
//   tester-eligible    a source-backed meal that also passes every tester check except enrolment (found on the
//                      saved page by the automatic comparison, a price, checked in the last 120 days, not closed)
//   publishable        a fact the founder has verified. Nothing is public until the owner decides.
import { writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("begin read only");
const rows = async (sql) => (await client.query(sql)).rows;

const meals = await rows(`
  with d as (
    -- The area is the linked listing's address-based one (app.boston_area, the definition Discover and the scorecard
    -- use); the research label (p.area, e.g. harvard_square) only where a place has no linked listing.
    select d.id, d.label dish, p.label place,
           coalesce((select pl.area from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
                      where k.staging_place = p.id and pl.area is not null order by pl.id limit 1), p.area) area,
           staging.tester_meal_checks(d.id) c,
           staging.has_restaurant_protein(d.id) printed_protein,
           (select e.model_id is not null and e.unknown_reason is null from staging.current_estimate(d.id) e) estimate,
           exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject = 'egg_free'
                    and f.value ->> 'status' = 'yes' and f.status in ('submitted', 'verified') and not f.is_unknown) egg_free,
           exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'listed_ingredients' and f.status in ('submitted', 'verified')) ingredients,
           exists (select 1 from staging.facts f where f.dish_id = d.id and f.status = 'verified') any_verified,
           -- Founder-verified diet: a vegetarian or vegan "yes" the founder verified at its source (not a transcription check).
           exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject in ('vegetarian', 'vegan')
                    and f.value ->> 'status' = 'yes' and f.status = 'verified' and not f.is_unknown) diet_verified,
           -- A current documented "suitable" answer the founder recorded (migration 20261124000900), and no current "not suitable".
           (exists (select 1 from staging.diet_confirmations c where c.dish_id = d.id and c.answer = 'suitable' and staging.diet_confirmation_state(c) = 'current')
            and not exists (select 1 from staging.diet_confirmations c where c.dish_id = d.id and c.answer = 'not_suitable' and staging.diet_confirmation_state(c) = 'current')) staff_confirmed,
           staging.tester_meal_included(d.id) tester_included,
           exists (select 1 from staging.facts f join staging.publication_changes pc on f.id = any (pc.fact_ids)
                     join public.catalog_changes cc on cc.id = pc.change_id
                    where f.dish_id = d.id and cc.state = 'published') published,
           exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject in ('vegetarian', 'vegan')
                    and f.value ->> 'status' = 'yes' and f.status in ('submitted', 'verified') and not f.is_unknown)
             and not exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject in ('vegetarian', 'vegan')
                    and f.value ->> 'status' = 'no' and f.status in ('submitted', 'verified') and not f.is_unknown) stated_any,
           l.candidate_id
      from staging.dishes d join staging.places p on p.id = d.place_id
      left join staging.live_catalog_links l on l.staging_place = p.id
     where not d.is_demo and not p.is_demo)
  select d.*, pl.cuisines, pl.identity_status
    from d left join public.place_listings pl on pl.candidate_id = d.candidate_id`);

const listings = (await rows(`
  select count(*)::int total,
         count(*) filter (where visibility = 'public')::int public,
         count(*) filter (where identity_status = 'verified')::int identity_verified
    from public.place_listings`))[0];
const places = await rows(`
  select p.label, p.area, exists (select 1 from staging.live_catalog_links l where l.staging_place = p.id) linked
    from staging.places p where not p.is_demo order by 1`);
const verifiedFacts = (await rows("select count(*)::int n from staging.facts where status = 'verified'"))[0].n;
// Six markets (docs/83): directory identities counted inside each market's 25-mile area. Menus and meals are
// researched in Boston only so far; the other markets start at zero rather than borrowing Boston's figures.
const hasAreas = (await rows(`select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'markets' and column_name = 'radius_m'`))[0].n > 0;
// Per market (owner decision 24 Nov 2026 17:59 UTC): records read, identities after duplicates are merged, how many
// were merged or held as possible duplicates, and the private listings by how well their identity is known.
const byMarket = hasAreas
  ? await rows(`with m as (select slug, name, state, coverage_geometry g from public.markets where coverage_geometry is not null),
        rec as (select m.slug, r.id, l.candidate_id from m
                  join catalog_import.source_records r on r.present
                   and extensions.st_covers(m.g, extensions.st_setsrid(extensions.st_makepoint(r.lon, r.lat), 4326)::extensions.geography)
                  left join catalog_import.candidate_links l on l.record_id = r.id),
        cand as (select m.slug, c.id, c.quality, c.flags from m
                  join catalog_import.place_candidates c on c.quality <> 'rejected'
                   and extensions.st_covers(m.g, extensions.st_setsrid(extensions.st_makepoint(c.lon, c.lat), 4326)::extensions.geography))
      select m.slug, m.name, m.state,
             (select count(*)::int from rec where rec.slug = m.slug) records,
             (select count(*)::int from cand where cand.slug = m.slug) identities,
             (select (count(*) - count(distinct candidate_id))::int from rec where rec.slug = m.slug and candidate_id is not null) merged,
             (select count(*)::int from cand where cand.slug = m.slug and 'possible_duplicate' = any(cand.flags)) possible_duplicates,
             (select count(*)::int from public.place_listings l where l.market_slug = m.slug and l.visibility <> 'withdrawn' and l.identity_status = 'corroborated') corroborated,
             (select count(*)::int from public.place_listings l where l.market_slug = m.slug and l.visibility <> 'withdrawn' and l.identity_status = 'single_source') single_source,
             (select count(*)::int from public.place_listings l where l.market_slug = m.slug and l.visibility <> 'withdrawn' and l.identity_status = 'verified') verified,
             (select count(*)::int from public.place_listings l where l.market_slug = m.slug and l.visibility = 'public') public,
             (select count(distinct k.staging_place)::int from staging.live_catalog_links k join public.place_listings l on l.candidate_id = k.candidate_id where l.market_slug = m.slug) menus
        from m order by array_position(array['boston','new-york','chicago','los-angeles','san-francisco','dallas'], m.slug::text), m.slug`)
  : [];
await client.query("rollback");
await client.end();

const is = (m, k) => m.c?.[k] === true;
const statedAny = meals.filter((m) => is(m, "meal") && m.stated_any);
const sourceBacked = meals.filter((m) => is(m, "meal") && is(m, "rights") && is(m, "stated"));
const testerEligible = sourceBacked.filter((m) => is(m, "fresh") && is(m, "price") && is(m, "open"));
const vegan = sourceBacked.filter((m) => (m.c.statedDiets ?? []).includes("vegan"));
const cuisineOf = (m) => {
  const c = (m.cuisines ?? []).map((x) => (typeof x === "string" ? x : x.basis === "possibly" ? null : x.cuisine ?? x.label ?? x.name)).filter((x) => x && !/possibly/i.test(String(x)));
  return c[0] ?? "unknown";
};
const group = (list, key) => {
  const g = {};
  for (const m of list) (g[key(m)] ??= []).push(m);
  return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
};
const places_ = (list) => new Set(list.map((m) => m.place)).size;
const today = new Date();
const ageDays = (m) => (m.c?.checkedOn ? Math.floor((today - new Date(m.c.checkedOn)) / 864e5) : null);
const ages = sourceBacked.map(ageDays).filter((x) => x !== null).sort((a, b) => a - b);
const top = group(sourceBacked, (m) => m.place)[0];

const R = {
  asOf: today.toISOString(),
  directoryListings: listings.total,
  publicListings: listings.public,
  identityVerifiedListings: listings.identity_verified,
  researchedMenus: places.length,
  linkedMenus: places.filter((p) => p.linked).length,
  completeMeals: meals.filter((m) => is(m, "meal")).length,
  restaurantStatedMeals: statedAny.length,
  restaurantsWithStatedMeals: places_(statedAny),
  sourceBackedMeals: sourceBacked.length,
  restaurantsWithSourceBackedVegetarian: places_(sourceBacked),
  sourceBackedVeganMeals: vegan.length,
  restaurantsWithSourceBackedVegan: places_(vegan),
  mealsWithEggFreeStatement: meals.filter((m) => m.egg_free).length,
  restaurantsWithEggFreeStatement: places_(meals.filter((m) => m.egg_free)),
  sourceBackedWithIngredientList: sourceBacked.filter((m) => m.ingredients).length,
  sourceBackedWithPrintedProtein: sourceBacked.filter((m) => m.printed_protein).length,
  sourceBackedWithUsdaEstimate: sourceBacked.filter((m) => !m.printed_protein && m.estimate).length,
  sourceBackedProteinUnknown: sourceBacked.filter((m) => !m.printed_protein && !m.estimate).length,
  testerEligibleExceptEnrolment: testerEligible.length,
  needsConfirmation: sourceBacked.filter((m) => !m.any_verified).length,
  publishableVerifiedFacts: verifiedFacts,
  freshnessDays: ages.length ? { newest: ages[0], median: ages[Math.floor(ages.length / 2)], oldest: ages.at(-1) } : null,
  concentration: top ? { restaurant: top[0], meals: top[1].length, share: Math.round((100 * top[1].length) / sourceBacked.length) } : null,
  byArea: group(sourceBacked, (m) => m.area ?? "unknown").map(([area, l]) => ({ area, meals: l.length, restaurants: places_(l), vegan: l.filter((m) => (m.c.statedDiets ?? []).includes("vegan")).length, cuisines: [...new Set(l.map(cuisineOf))] })),
  byCuisine: group(sourceBacked, cuisineOf).map(([cuisine, l]) => ({ cuisine, meals: l.length, restaurants: places_(l) })),
  byRestaurant: group(sourceBacked, (m) => m.place).map(([place, l]) => ({ place, area: l[0].area, meals: l.length, vegan: l.filter((m) => (m.c.statedDiets ?? []).includes("vegan")).length, printedProtein: l.filter((m) => m.printed_protein).length, testerEligible: l.filter((m) => testerEligible.includes(m)).length })),
  // Researched menus exist in Boston only, so its meals are Boston's; every other market starts at zero.
  byMarket: byMarket.map((m) => ({ ...m, market: m.slug, sourceBackedMeals: m.slug === "boston" ? sourceBacked.length : 0, sourceBackedRestaurants: m.slug === "boston" ? places_(sourceBacked) : 0 })),
  // Owner direction 24 Nov 2026 20:53 UTC, item 6: five separate counts, never merged.
  ladder: {
    directoryIdentities: listings.total,
    researchedMenus: places.length,
    sourceBackedSuitableMeals: sourceBacked.length,
    sourceBackedSuitableRestaurants: places_(sourceBacked),
    founderVerifiedMeals: sourceBacked.filter((m) => m.diet_verified).length,
    staffConfirmedMeals: meals.filter((m) => m.staff_confirmed && !sourceBacked.includes(m)).length,
    approvedForTesters: meals.filter((m) => m.tester_included).length,
    publishedMeals: meals.filter((m) => m.published).length,
  },
  menusWithoutSourceBackedMeals: places.filter((p) => !sourceBacked.some((m) => m.place === p.label)).map((p) => p.label),
};

if (args.includes("--json")) console.log(JSON.stringify(R, null, 1));
else {
  const md = [
    `# Boston coverage, ${R.asOf.slice(0, 10)}`,
    "",
    "| Usefulness ladder (each row separate; none implies the next) | Count |",
    "| --- | --- |",
    `| 1. Directory identities (name and address only) | ${R.ladder.directoryIdentities} |`,
    `| 2. Researched menus | ${R.ladder.researchedMenus} |`,
    `| 3. Source-backed suitable meals (restaurant's own words, found on the saved page) | ${R.ladder.sourceBackedSuitableMeals} at ${R.ladder.sourceBackedSuitableRestaurants} restaurants |`,
    `| 4. Founder-verified meals (diet verified at its source by the founder) | ${R.ladder.founderVerifiedMeals} |`,
    `| 4b. Staff-confirmed meals (founder's documented answer, no published label; founder-only, not counted as suitable) | ${R.ladder.staffConfirmedMeals} |`,
    `| 5. Approved for invited testers (not verification) | ${R.ladder.approvedForTesters} |`,
    `| 6. Published meals | ${R.ladder.publishedMeals} |`,
    "",
    "| Measure | Count |",
    "| --- | --- |",
    `| Directory listings (private identities, not food claims) | ${R.directoryListings} (public ${R.publicListings}, identity verified ${R.identityVerifiedListings}) |`,
    `| Researched menus / linked to a listing | ${R.researchedMenus} / ${R.linkedMenus} |`,
    `| Complete meals on those menus | ${R.completeMeals} |`,
    `| Restaurant-stated vegetarian or vegan meals (researched draft) | ${R.restaurantStatedMeals} at ${R.restaurantsWithStatedMeals} restaurants |`,
    `| of which source-backed (cleared source, text found on the saved page) | ${R.sourceBackedMeals} at ${R.restaurantsWithSourceBackedVegetarian} restaurants |`,
    `| of which vegan | ${R.sourceBackedVeganMeals} at ${R.restaurantsWithSourceBackedVegan} restaurants |`,
    `| Meals with an egg-free statement | ${R.mealsWithEggFreeStatement} at ${R.restaurantsWithEggFreeStatement} restaurants |`,
    `| Source-backed meals with an ingredient list | ${R.sourceBackedWithIngredientList} |`,
    `| Protein: printed / USDA estimate / unknown | ${R.sourceBackedWithPrintedProtein} / ${R.sourceBackedWithUsdaEstimate} / ${R.sourceBackedProteinUnknown} |`,
    `| Tester-eligible except enrolment | ${R.testerEligibleExceptEnrolment} |`,
    `| Needing founder confirmation | ${R.needsConfirmation} |`,
    `| Publishable (founder-verified facts) | ${R.publishableVerifiedFacts} |`,
    `| Freshness, days since checked (newest / median / oldest) | ${R.freshnessDays ? `${R.freshnessDays.newest} / ${R.freshnessDays.median} / ${R.freshnessDays.oldest}` : "none"} |`,
    `| Largest single restaurant share | ${R.concentration ? `${R.concentration.restaurant}, ${R.concentration.meals} meals (${R.concentration.share}%)` : "none"} |`,
    "",
    "| Market (25 miles) | Food records read | Identities after merging | Records merged as duplicates | Held as possible duplicates | Listings: two sources | Listings: one source, not cross-checked | Identity verified | Public | Researched menus | Source-backed veg meals (restaurants) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...R.byMarket.map((m) => `| ${m.name} | ${m.records} | ${m.identities} | ${m.merged} | ${m.possible_duplicates} | ${m.corroborated} | ${m.single_source} | ${m.verified} | ${m.public} | ${m.menus} | ${m.sourceBackedMeals} (${m.sourceBackedRestaurants}) |`),
    "",
    "| Area | Meals | Restaurants | Vegan | Cuisines |",
    "| --- | --- | --- | --- | --- |",
    ...R.byArea.map((a) => `| ${a.area} | ${a.meals} | ${a.restaurants} | ${a.vegan} | ${a.cuisines.join(", ")} |`),
    "",
    "| Restaurant | Area | Meals | Vegan | Printed protein | Tester-eligible |",
    "| --- | --- | --- | --- | --- | --- |",
    ...R.byRestaurant.map((r) => `| ${r.place} | ${r.area} | ${r.meals} | ${r.vegan} | ${r.printedProtein} | ${r.testerEligible} |`),
    "",
    `Menus with no source-backed meal: ${R.menusWithoutSourceBackedMeals.join(", ") || "none"}.`,
  ].join("\n");
  console.log(md);
  if (out) writeFileSync(out, md + "\n");
}
