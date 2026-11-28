#!/usr/bin/env node
// Founder review queue summary (owner decision 25 Nov 2026 14:25 UTC: three separate review dimensions).
// LOCAL ONLY and READ-ONLY: one read-only transaction that is rolled back; it creates no account, grants no role and
// changes no record. It writes nothing anywhere except the optional --out file.
//
//   node scripts/review-queue-summary.mjs [--json] [--out file.md] [--founder <account id>]
//
// It first reads the founder's own queue (public.tester_meal_queue) as the founder account that already exists here
// (the one account holding the founder role, or the one named by --founder, which must already hold it), so the founder's permissions are exercised exactly as the app does. If
// there is not exactly one such account it stops and says so. Then it counts, per meal, the three dimensions:
//   1. Source review   the founder checked the menu item, price and diet label against the restaurant's source
//   2. Dietary         the claim rests on the restaurant's own published words the founder source-reviewed, or on a
//                      current documented staff answer; unknowns and conflicts stay open
//   3. Nutrition       protein printed by the restaurant (and whether the founder checked it) vs labelled estimates
// plus whether every tester check passes (member-eligible). Counts are separate and never added together.
import { writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const PER_PLACE = 6; // the review queue's proposed first selection: at most 6 ready meals from one restaurant

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("begin read only");
try {
  const named = args.includes("--founder") ? args[args.indexOf("--founder") + 1] : null;
  const founders = (
    // Invented seed accounts (addresses at the reserved example.invalid domain, supabase/seed.sql) never count as the founder.
    await client.query(
      `select r.user_id::text id from public.role_assignments r join auth.users u on u.id = r.user_id
        where r.role = 'publisher' and coalesce(u.email, '') not like '%@example.invalid' and ($1::text is null or r.user_id::text = $1)`,
      [named],
    )
  ).rows;
  if (founders.length !== 1) {
    console.error(
      named
        ? "That account does not hold the founder role here. Nothing was read as the founder; nothing was changed."
        : `Expected exactly one founder account here, found ${founders.length}; name one with --founder. Nothing was read as the founder; nothing was changed.`,
    );
    process.exitCode = 2;
  } else {
    const founder = founders[0].id;
    // The founder's own view, through the same database function and permission check the app uses.
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: founder, role: "authenticated" })]);
    const queue = (await client.query("select public.tester_meal_queue() q")).rows[0].q;
    await client.query("reset role");
    const ids = queue.meals.map((m) => m.dishId);

    const meals = (
      await client.query(
        `with q as (select unnest($1::uuid[]) id),
         d as (
           select d.id, d.label dish, p.label place, p.id place_id, c checks,
                  staging.tester_meal_all_pass(c) member_eligible,
                  staging.tester_meal_all_pass(c || '{"place": true, "reviewed": true}'::jsonb) ready,
                  (c ->> 'place')::boolean enrolled,
                  staging.tester_meal_included(d.id) included,
                  case when exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject = 'vegan'
                                      and f.value ->> 'status' = 'yes' and f.status in ('submitted', 'verified') and not f.is_unknown)
                       then 'vegan' else 'vegetarian' end claim
             from q join staging.dishes d on d.id = q.id join staging.places p on p.id = d.place_id
             cross join lateral staging.tester_meal_checks(d.id) c),
         r as (
           select d.*,
                  -- The facts a tester sees first: menu item, price, and the restaurant's "yes" for the claim.
                  (select count(*) from staging.facts f where f.dish_id = d.id and f.status in ('submitted', 'verified') and not f.is_unknown
                     and (f.kind in ('menu_item', 'price') or (f.kind = 'dietary_status' and f.subject = d.claim and f.value ->> 'status' = 'yes'))) need,
                  (select count(*) from staging.facts f where f.dish_id = d.id and f.status in ('submitted', 'verified') and not f.is_unknown
                     and (f.kind in ('menu_item', 'price') or (f.kind = 'dietary_status' and f.subject = d.claim and f.value ->> 'status' = 'yes'))
                     and staging.fact_reviewed(f)) done,
                  (exists (select 1 from staging.diet_confirmations x where x.dish_id = d.id and x.claim = d.claim and x.answer = 'suitable' and staging.diet_confirmation_state(x) = 'current')
                   and not exists (select 1 from staging.diet_confirmations x where x.dish_id = d.id and x.answer = 'not_suitable' and staging.diet_confirmation_state(x) = 'current')) staff,
                  exists (select 1 from staging.diet_confirmations x where x.dish_id = d.id and x.answer = 'not_suitable' and staging.diet_confirmation_state(x) = 'current') staff_against,
                  staging.has_restaurant_protein(d.id) printed,
                  exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'published_nutrition' and f.subject = 'protein_g'
                            and f.status in ('submitted', 'verified') and not f.is_unknown and staging.fact_reviewed(f)) printed_reviewed,
                  (select e.model_id is not null and e.unknown_reason is null from staging.current_estimate(d.id) e) estimate
             from d)
         select r.*, (r.checks ->> 'stated')::boolean stated from r order by place, dish`,
        [ids],
      )
    ).rows;

    // Complete meals only (sides, drinks and add-ons never reach testers), as on the review queue page.
    const labelled = meals.filter((m) => m.checks.meal && (m.stated || m.staff));
    const source = (m) => (m.need >= 3 && m.done === m.need ? "complete" : m.done > 0 ? "partial" : "none");
    const diet = (m) =>
      m.staff_against ? "conflict" : m.stated && source(m) === "complete" ? "published_reviewed" : m.staff ? "staff_confirmed" : m.stated ? "published_unreviewed" : "other";
    const nutrition = (m) => (m.printed ? (m.printed_reviewed ? "printed_reviewed" : "printed") : m.estimate ? "estimate" : "unknown");
    const tally = (rows) => ({
      meals: rows.length,
      sourceReviewed: rows.filter((m) => source(m) === "complete").length,
      sourceReviewStarted: rows.filter((m) => source(m) === "partial").length,
      dietaryConfirmed: rows.filter((m) => ["published_reviewed", "staff_confirmed"].includes(diet(m))).length,
      dietaryUnconfirmed: rows.filter((m) => !["published_reviewed", "staff_confirmed"].includes(diet(m))).length,
      proteinPrinted: rows.filter((m) => m.printed).length,
      proteinPrintedReviewed: rows.filter((m) => nutrition(m) === "printed_reviewed").length,
      proteinEstimate: rows.filter((m) => nutrition(m) === "estimate").length,
      proteinUnknown: rows.filter((m) => nutrition(m) === "unknown").length,
      memberEligible: rows.filter((m) => m.member_eligible).length,
      includedForTesters: rows.filter((m) => m.included).length,
    });
    const ready = labelled.filter((m) => m.ready && m.stated);
    const byPlace = new Map();
    for (const m of ready) byPlace.set(m.place, [...(byPlace.get(m.place) ?? []), m]);
    const proposed = [...byPlace.values()].flatMap((rows) => rows.slice(0, PER_PLACE));
    const KEYS = ["rights", "stated", "fresh", "price", "open", "place", "reviewed"];
    const gaps = Object.fromEntries(KEYS.map((k) => [k, labelled.filter((m) => !m.checks[k]).length]));
    const report = {
      at: new Date().toISOString(),
      readAs: "the existing founder account (read-only, rolled back)",
      betaSwitchOn: queue.betaOn,
      mode: queue.mode,
      founderQueueMeals: queue.meals.length,
      labelled: tally(labelled),
      readyForReview: { ...tally(ready), restaurants: byPlace.size },
      proposedSelection: {
        ...tally(proposed),
        restaurants: byPlace.size,
        notEnrolled: [...byPlace.values()].filter((rows) => !rows[0].enrolled).length,
        perRestaurant: [...byPlace.entries()].map(([place, rows]) => ({ place, meals: Math.min(rows.length, PER_PLACE), enrolled: rows[0].enrolled })),
      },
      failingChecksAmongLabelled: gaps,
    };
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 1));
    else {
      const t = (o) => Object.entries(o).filter(([, v]) => typeof v === "number").map(([k, v]) => `| ${k} | ${v} |`).join("\n");
      const md = [
        `# Founder review queue summary, ${report.at.slice(0, 16)}Z`,
        "",
        `Read as ${report.readAs}. Member beta switch ${queue.betaOn ? "ON" : "off"}, mode ${queue.mode}. Each count is its own question; they overlap and are never added up.`,
        "",
        "## Proposed first selection (ready meals, at most 6 per restaurant)",
        "",
        "| Count | Meals |\n| --- | --- |",
        t(report.proposedSelection),
        "",
        ...report.proposedSelection.perRestaurant.map((p) => `- ${p.place}: ${p.meals}${p.enrolled ? "" : " (not enrolled)"}`),
        "",
        "## Every complete meal with a restaurant label or a staff answer",
        "",
        "| Count | Meals |\n| --- | --- |",
        t(report.labelled),
        "",
        "## Evidence gaps (labelled meals failing each check)",
        "",
        "| Check | Meals failing |\n| --- | --- |",
        t(gaps),
        "",
      ].join("\n");
      console.log(md);
      if (out) writeFileSync(out, md);
    }
  }
} finally {
  await client.query("rollback");
  await client.end();
}
