// Staged member-visible LOCAL beta (owner decision 22 Nov 2026 15:26 UTC; APPROVALS A-1122-CK item 3;
// migration 20261122000600). Local, or a hosted beta database for status and enroll only (scripts/lib/db-target.mjs).
//
//   node scripts/member-beta.mjs status                    what is enrolled, whether the switch is on, and what members would see
//   node scripts/member-beta.mjs enroll --stage 1 --by "<who records it>" [--confirm]
//        enrols the stage's places, recording the owner decision it rests on. Without --confirm it is a dry run.
//        stage 1: Next Level Veggie Grill, Madras Dosa Co, Asmara Restaurant, Brown Sugar Cafe (22 Nov 2026).
//        stage 2: the eight restaurants of the review queue's proposed first selection (25 Nov 2026 17:10 UTC).
//        Enrolling never includes a meal, confirms a fact, or turns the member beta switch on.
//   node scripts/member-beta.mjs on|off --by "<who>" [--note "..."] [--confirm]
//
// What members then see is decided by the database alone (staging.member_fact_ok): only facts the founder verified
// or whose text the latest automatic comparison found on the saved copy of the restaurant's page, from a source the
// access registry marks private_pilot or cleared. This script never confirms, verifies or publishes anything, and
// never touches the three publication switches.
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const has = (n) => args.includes(n);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, args[0], ["status", "enroll"]);

export const STAGES = {
  1: {
    labels: ["Next Level Veggie Grill", "Madras Dosa Co", "Asmara Restaurant", "Brown Sugar Cafe"],
    decision:
      "Owner decision (22 Nov 2026 15:26 UTC): member visibility approved for a staged, local-only beta, starting with Veggie Grill, Madras Dosa, Asmara and Brown Sugar Cafe; only legitimately eligible facts; publication locks preserved; nothing public. Not a confirmation of any fact.",
  },
  2: {
    labels: [
      "Asmara Restaurant",
      "Brown Sugar Cafe",
      "Cafe Landwer (Back Bay)",
      "Cafe Landwer (Cleveland Circle)",
      "Gene's Chinese Flatbread Cafe",
      "India Quality Restaurant",
      "Next Level Veggie Grill",
      "Pho Pasteur",
    ],
    decision:
      "Owner decision (25 Nov 2026 17:10 UTC, Option A): enrol the eight restaurants of the proposed first selection in the local invited beta. Enrolment is separate from meal review and publication; no meal is member-visible until the founder source-reviews it and includes it; the member beta switch stays off. Not a confirmation of any fact.",
  },
};

async function status(client) {
  const sw = (await client.query("select enabled, meal_mode, changed_by, changed_at, note from staging.member_beta_switch")).rows[0];
  const rows = (
    await client.query(`
      select p.label, b.stage, b.recorded_at,
             (select count(*)::int from staging.dishes d where d.place_id = p.id) dishes,
             (select count(*)::int from staging.dishes d where d.place_id = p.id
                and exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'menu_item' and staging.member_fact_ok(f))) member_dishes,
             (select count(*)::int from staging.dishes d where d.place_id = p.id and staging.tester_meal_included(d.id)) included,
             (select count(*)::int from staging.facts f where f.place_id = p.id and f.status in ('submitted', 'verified') and not f.is_unknown) facts,
             (select count(*)::int from staging.facts f where f.place_id = p.id and staging.member_fact_ok(f)) member_facts,
             exists (select 1 from staging.live_catalog_links l join public.place_listings pl on pl.candidate_id = l.candidate_id
                      where l.staging_place = p.id and pl.visibility = 'preview') listed
        from staging.member_beta_places b join staging.places p on p.id = b.place_id order by p.label`)
  ).rows;
  const locks = (await client.query("select count(*)::int n from public.place_listings where visibility = 'public'")).rows[0].n;
  console.log(`Member beta switch: ${sw?.enabled ? "ON" : "off"}${sw?.changed_at ? ` (by ${sw.changed_by}, ${sw.changed_at.toISOString()})` : ""}`);
  console.log(
    sw?.meal_mode === "whole_place"
      ? "Mode: whole place (members see every eligible dish of an enrolled place)."
      : "Mode: reviewed meals (members see only the meals the founder included for testers).",
  );
  console.table(rows.map((r) => ({ place: r.label, stage: r.stage, listed: r.listed, dishes: r.dishes, "eligible dishes": r.member_dishes, "included for testers": r.included, facts: r.facts, "eligible facts": r.member_facts })));
  console.log(`Public listings: ${locks} (this beta never makes a listing public).`);
}

async function enroll(client) {
  const stage = Number(flag("--stage") ?? "1");
  const by = flag("--by");
  const s = STAGES[stage];
  if (!s) throw new Error(`No stage ${stage}`);
  if (!by) throw new Error('Give --by "<who records it>"');
  const places = (await client.query("select id, label from staging.places where label = any($1::text[]) and not is_demo", [s.labels])).rows;
  const missing = s.labels.filter((l) => !places.some((p) => p.label === l));
  if (missing.length) throw new Error(`Not in this database yet: ${missing.join(", ")}. Load the menus first.`);
  // Each name must be exactly one researched place (two branches of one chain are separate places with separate names).
  const twice = s.labels.filter((l) => places.filter((p) => p.label === l).length > 1);
  if (twice.length) throw new Error(`More than one place is called ${twice.join(", ")}. Nothing changed.`);
  if (!has("--confirm")) {
    console.log(`Dry run: would enrol ${places.map((p) => p.label).join(", ")} at stage ${stage}. Nothing changed.`);
    return;
  }
  let added = 0;
  for (const p of places) {
    added += (await client.query("insert into staging.member_beta_places (place_id, stage, decision, recorded_by) values ($1, $2, $3, $4) on conflict (place_id) do nothing", [p.id, stage, s.decision, by])).rowCount;
  }
  const sw = (await client.query("select enabled from staging.member_beta_switch")).rows[0];
  console.log(`Enrolled ${added} new (${places.length - added} already enrolled). Nothing was confirmed, verified, included or published.`);
  console.log(`Member beta switch: ${sw?.enabled ? "ON" : "off"} (unchanged by enrolment).`);
}

async function toggle(client, on) {
  const by = flag("--by");
  if (!by) throw new Error('Give --by "<who>"');
  if (!has("--confirm")) {
    console.log(`Dry run: would turn the member beta ${on ? "ON" : "off"}. Nothing changed.`);
    return;
  }
  await client.query("update staging.member_beta_switch set enabled = $1, changed_by = $2, changed_at = now(), note = $3", [on, by, flag("--note") ?? null]);
  console.log(`Member beta is now ${on ? "ON" : "off"}. The publication switches are unchanged.`);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const cmd = args[0];
  if (cmd === "status") await status(client);
  else if (cmd === "enroll") await enroll(client);
  else if (cmd === "on" || cmd === "off") await toggle(client, cmd === "on");
  else throw new Error("Use: status | enroll --stage 1 --by ... [--confirm] | on|off --by ... [--confirm]");
} finally {
  await client.end();
}
