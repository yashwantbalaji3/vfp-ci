#!/usr/bin/env node
// Carry the founder's review decisions from his own computer to the hosted beta database, by exact match only
// (owner direction 25 Nov 2026 21:53 UTC: "Do not replay any decision where the identities or evidence differ. Do not
// overwrite hosted data"). The rules are in scripts/lib/review-transfer-lib.mjs.
//
//   node scripts/review-transfer.mjs export --founder <email> --out <file>
//        On the computer where the founder reviewed (a local database only). Read-only: writes his decisions, each
//        with the restaurant, branch, dish, fact, value and evidence version it rested on, to <file>.
//   node scripts/review-transfer.mjs plan <file> [--part meals|identity]
//        Against the target. Read-only, a dry run: says for every decision whether it would be replayed, was already
//        replayed, or conflicts (and why). Writes nothing.
//   node scripts/review-transfer.mjs apply <file> --part meals|identity --as <founder email on the target>
//        --approval "<the owner's own words>" --confirm
//        Plans again inside one transaction. Any conflict: nothing is applied, and the refusal is logged. Otherwise
//        every decision is replayed through the same founder functions the review pages use, under the founder's
//        own account on the target, and each is logged in app.data_transfer_items with what it matched on. Running it
//        again changes nothing (each source decision is replayed at most once).
//
// A hosted target needs VFP_HOSTED_REF naming the project (scripts/lib/db-target.mjs). "identity" (restaurant identity
// decisions) runs before the catalog preview is rebuilt; "meals" (fact reviews, meal notes, tester includes) after
// the menus are loaded, linked and enrolled. Staff-answer records (docs/89) are not carried over; the plan counts them.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";
import { IDENTITY_KINDS, MEAL_KINDS, describe, dishKey, factEvidence, factKey, planTransfer, sha256, stable, summarise } from "./lib/review-transfer-lib.mjs";

const [cmd, file, ...rest] = process.argv.slice(2);
const args = [file, ...rest];
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const has = (n) => args.includes(n);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Export only from a local database (the founder's computer); plan and apply may name a hosted project.
const target = assertTarget(url, cmd, ["plan", "apply"]);

const UTC = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function snapshot(c) {
  const facts = (await c.query(`
    select f.id, p.label place, d.label dish, f.kind, f.subject, f.value, f.status, f.is_unknown, f.unknown_reason,
           f.checked_on::text checked_on, f.confidence, s.url, s.content_sha256, ${UTC("s.retrieved_at")} retrieved_at,
           staging.source_access_state(s.url) access,
           exists (select 1 from staging.fact_confirmations x where x.fact_id = f.id) transcribed
      from staging.facts f join staging.places p on p.id = f.place_id
      left join staging.dishes d on d.id = f.dish_id left join staging.source_pages s on s.id = f.source_page_id`)).rows;
  const places = (await c.query(`
    select p.id, p.label,
           coalesce((select jsonb_agg(f.value order by f.value::text) from staging.facts f where f.place_id = p.id and f.kind = 'address'), '[]') address,
           coalesce((select jsonb_agg(distinct jsonb_build_array(r.source_key, r.external_id))
                       from staging.live_catalog_links l join catalog_import.candidate_links cl on cl.candidate_id = l.candidate_id
                       join catalog_import.source_records r on r.id = cl.record_id where l.staging_place = p.id), '[]') catalog
      from staging.places p`)).rows;
  for (const p of places) p.catalog.sort((a, b) => stable(a).localeCompare(stable(b)));
  const dishes = (await c.query("select d.id, p.label place, d.label dish from staging.dishes d join staging.places p on p.id = d.place_id")).rows;
  return { rows: { facts, places, dishes }, view: describe({ facts, places, dishes }) };
}

/** A catalog place's identity (name, street, postcode, source records) and evidence version (record hashes). */
async function candidates(c, where, params) {
  const rows = (await c.query(`
    select c.id, c.name, c.street, c.postcode,
           exists (select 1 from public.identity_review_items i where i.candidate_id = c.id) review_item,
           coalesce(jsonb_agg(jsonb_build_array(r.source_key, r.external_id, r.record_hash) order by r.source_key, r.external_id) filter (where r.id is not null), '[]') records
      from catalog_import.place_candidates c
      left join catalog_import.candidate_links l on l.candidate_id = c.id left join catalog_import.source_records r on r.id = l.record_id
     where ${where} group by c.id`, params)).rows;
  return rows.map((r) => ({
    id: r.id,
    reviewItem: r.review_item,
    key: { name: r.name, street: r.street, postcode: r.postcode, records: r.records.map(([s, e]) => [s, e]) },
    evidence: { recordHashes: r.records.map(([s, e, h]) => [s, e, h]) },
  }));
}

async function exportDecisions(c, founderEmail, out) {
  const founder = (await c.query("select u.id from auth.users u join public.role_assignments r on r.user_id = u.id and r.role = 'publisher' where u.email = $1", [founderEmail])).rows[0]?.id;
  if (!founder) throw new Error(`No founder (publisher) account ${founderEmail} on this database. Nothing written.`);
  await c.query("begin read only");
  const fingerprint = (await c.query("select system_identifier::text || ':' || current_database() id from pg_control_system()")).rows[0].id;
  const { rows, view } = await snapshot(c);
  const byId = new Map(rows.facts.map((f) => [f.id, f]));
  const placeOf = (label) => ({ label, identity: view.places.get(label).identity });
  const dishOf = (place, dish) => ({ label: dish, fingerprint: view.dishes.get(dishKey(place, dish)).fingerprint });
  const factOf = (f) => ({ key: factKey(f), evidence: factEvidence(f) });
  const decisions = [];
  const factDecision = (kind, sourceId, at, f, extra) =>
    decisions.push({ kind, sourceId, at, label: `${f.place} / ${f.dish ?? "(restaurant)"} / ${f.kind}`, place: placeOf(f.place), dish: f.dish ? dishOf(f.place, f.dish) : null, fact: factOf(f), ...extra });
  for (const r of (await c.query(`select id::text, fact_id, note, ${UTC("confirmed_at")} at from staging.fact_confirmations where confirmed_by = $1 and level = 'transcription' order by confirmed_at, id`, [founder])).rows)
    factDecision("fact_transcription", r.id, r.at, byId.get(r.fact_id), { note: r.note });
  for (const r of (await c.query(`select id::text, fact_id, action, detail ->> 'note' note, ${UTC("at")} at from staging.events where actor_id = $1 and action in ('verify_fact', 'reject_fact') order by at, id`, [founder])).rows)
    factDecision("fact_review", r.id, r.at, byId.get(r.fact_id), { decision: r.action === "verify_fact" ? "verify" : "reject", note: r.note });
  const meal = async (sql, kind, extra) => {
    for (const r of (await c.query(sql, [founder])).rows)
      decisions.push({ kind, sourceId: r.id, at: r.at, label: `${r.place} / ${r.dish}`, place: placeOf(r.place), dish: dishOf(r.place, r.dish), ...extra(r) });
  };
  await meal(`select n.id::text, n.outcome, n.note, ${UTC("n.recorded_at")} at, p.label place, d.label dish from staging.meal_review_notes n
                join staging.dishes d on d.id = n.dish_id join staging.places p on p.id = d.place_id where n.recorded_by = $1 order by n.recorded_at, n.id`,
    "meal_note", (r) => ({ outcome: r.outcome, note: r.note }));
  await meal(`select t.id::text, t.decision, t.reason, ${UTC("t.decided_at")} at, p.label place, d.label dish from staging.tester_meal_decisions t
                join staging.dishes d on d.id = t.dish_id join staging.places p on p.id = d.place_id where t.decided_by = $1 order by t.decided_at, t.id`,
    "tester_decision", (r) => ({ decision: r.decision, reason: r.reason }));
  for (const [table, extraCols] of [["catalog_import.identity_decisions", ""], ["public.identity_reviews", ", reason, queue, sample_seed"]]) {
    for (const r of (await c.query(`select id::text, candidate_id, decision, note${extraCols}, ${UTC("decided_at")} at from ${table} where decided_by = $1 order by decided_at, id`, [founder])).rows) {
      const [cand] = await candidates(c, "c.id = $1", [r.candidate_id]);
      decisions.push({
        kind: "identity_decision", sourceId: `${table.split(".")[1]}-${r.id}`, at: r.at, label: `${cand.key.name}, ${cand.key.street ?? ""} ${cand.key.postcode ?? ""}`.trim(),
        table: table.split(".")[1], decision: r.decision, note: r.note, reason: r.reason ?? null, queue: r.queue ?? null, sampleSeed: r.sample_seed ?? null,
        candidate: { key: cand.key, evidence: cand.evidence },
      });
    }
  }
  const notCarried = {
    staffAnswerRecords: (await c.query("select count(*)::int n from staging.diet_confirmations where recorded_by = $1", [founder])).rows[0].n,
  };
  await c.query("rollback");
  decisions.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId));
  let commit = null;
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  const body = { format: "vfp-review-transfer-v1", source: { fingerprint, exportedAt: new Date().toISOString(), commit }, notCarried, decisions };
  writeFileSync(out, JSON.stringify(body, null, 1));
  const n = (k) => decisions.filter((d) => d.kind === k).length;
  console.log(`Wrote ${decisions.length} decisions to ${out} (SHA-256 ${sha256(readFileSync(out))}).`);
  console.log(`  source reviews ${n("fact_transcription")}, fact verify/reject ${n("fact_review")}, meal notes ${n("meal_note")}, tester decisions ${n("tester_decision")}, identity decisions ${n("identity_decision")}`);
  if (notCarried.staffAnswerRecords) console.log(`  Not carried over: ${notCarried.staffAnswerRecords} staff-answer records (record them again on the target).`);
  console.log("Nothing changed on this database.");
}

async function targetView(c, exported) {
  const { view } = await snapshot(c);
  const transferred = new Set((await c.query("select source_ref from app.data_transfer_items")).rows.map((r) => r.source_ref));
  const cands = new Map();
  for (const d of exported.decisions.filter((x) => x.kind === "identity_decision")) {
    for (const cand of await candidates(c, "c.name = $1 and c.street is not distinct from $2 and c.postcode is not distinct from $3", [d.candidate.key.name, d.candidate.key.street, d.candidate.key.postcode]))
      if (stable(cand.key) === stable(d.candidate.key)) cands.set(stable(cand.key), cand);
  }
  return { ...view, transferred, candidates: cands };
}

function readExport(path) {
  const raw = readFileSync(path);
  const body = JSON.parse(raw.toString("utf8"));
  if (body.format !== "vfp-review-transfer-v1") throw new Error("Not a review-transfer file. Nothing checked.");
  return { body, fileSha: sha256(raw) };
}

const partKinds = (part) => (part === "identity" ? IDENTITY_KINDS : part === "meals" ? MEAL_KINDS : [...IDENTITY_KINDS, ...MEAL_KINDS]);

function printPlan(plan, label) {
  const s = summarise(plan);
  for (const p of plan.filter((x) => x.outcome !== "replay")) console.log(`${p.outcome.toUpperCase().padEnd(8)} ${p.kind} ${p.label}${p.reason ? `: ${p.reason}` : ""}`);
  console.log(`${label}: ${s.replay} to replay, ${s.done} already replayed, ${s.conflict} conflicts.`);
  return s;
}

async function planOrApply(c, path, apply) {
  const { body, fileSha } = readExport(path);
  const part = flag("--part");
  if (part && !["meals", "identity"].includes(part)) throw new Error("--part is meals or identity. Nothing checked.");
  const fp = (await c.query("select system_identifier::text || ':' || current_database() id from pg_control_system()").catch(() => ({ rows: [{ id: null }] }))).rows[0].id;
  if (fp && fp === body.source.fingerprint) throw new Error("The target is the database the decisions came from. Nothing checked.");
  const selected = { ...body, decisions: body.decisions.filter((d) => partKinds(part).includes(d.kind)) };
  const where = target.kind === "hosted" ? `hosted project ${target.ref}` : "this local database";
  console.log(`File SHA-256 ${fileSha}; ${selected.decisions.length} decisions${part ? ` (${part})` : ""}; target ${where}.`);
  if (body.notCarried?.staffAnswerRecords) console.log(`NOTE ${body.notCarried.staffAnswerRecords} staff-answer records are not carried over.`);
  if (!apply) {
    await c.query("begin read only");
    const s = printPlan(planTransfer(selected, await targetView(c, selected)), "Dry run");
    await c.query("rollback");
    console.log("Nothing changed.");
    return s.conflict ? 1 : 0;
  }
  const as = flag("--as");
  const approval = flag("--approval");
  if (!part) throw new Error("apply needs --part meals or --part identity. Nothing changed.");
  if (!as || !approval || approval.trim().length < 3) throw new Error('apply needs --as <founder email on the target> and --approval "<the owner\'s own words>". Nothing changed.');
  const founder = (await c.query("select u.id from auth.users u join public.role_assignments r on r.user_id = u.id and r.role = 'publisher' where u.email = $1", [as])).rows[0]?.id;
  if (!founder) throw new Error(`${as} is not a founder (publisher) account on the target. Nothing changed.`);
  let commit = null;
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  const run = async (outcome, summary) =>
    (await c.query(
      `insert into app.data_transfer_runs (kind, part, outcome, target, source_fingerprint, file_sha256, code_commit, approval, summary, recorded_by)
       values ('review_transfer', $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [part, outcome, target.kind === "hosted" ? target.ref : "local", body.source.fingerprint, fileSha, commit, approval.trim(), summary, `scripts/review-transfer.mjs as ${as}`])).rows[0].id;
  await c.query("begin");
  await c.query("select pg_advisory_xact_lock(hashtext('review_transfer'))");
  const plan = planTransfer(selected, await targetView(c, selected));
  const s = printPlan(plan, "Plan");
  if (s.conflict) {
    await c.query("rollback");
    const id = await run("refused", { ...s, conflicts: plan.filter((p) => p.outcome === "conflict").map((p) => ({ kind: p.kind, label: p.label, reason: p.reason })) });
    console.log(`Refused: ${s.conflict} decisions do not match exactly. Nothing was replayed (logged as run ${id}).`);
    return 1;
  }
  if (!s.replay) {
    await c.query("rollback");
    const id = await run("no_change", s);
    console.log(`Every decision in the file was already replayed. Nothing changed (logged as run ${id}).`);
    return 0;
  }
  const runId = await run("applied", s);
  // The founder functions read the signed-in account from the request; set it to the founder's own account here.
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: founder, role: "authenticated" })]);
  const byRef = new Map(selected.decisions.map((d) => [`${body.source.fingerprint}:${d.kind}:${d.sourceId}`, d]));
  try {
    for (const p of plan.filter((x) => x.outcome === "replay")) {
      const d = byRef.get(p.ref);
      let targetId = p.targetId;
      if (d.kind === "fact_transcription") {
        await c.query("select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: p.targetId, decision: "confirm_transcription", ...(d.note ? { note: d.note } : {}) }])]);
      } else if (d.kind === "fact_review") {
        await c.query("select public.menu_review_decide($1::jsonb)", [JSON.stringify([{ factId: p.targetId, decision: d.decision, ...(d.note ? { note: d.note } : {}) }])]);
      } else if (d.kind === "meal_note") {
        targetId = String((await c.query("select (public.meal_review_note_add($1, $2, $3)) ->> 'id' id", [p.targetId, d.outcome, d.note])).rows[0].id);
      } else if (d.kind === "tester_decision") {
        await c.query("select public.tester_meal_decide($1, $2, $3)", [p.targetId, d.decision, d.reason]);
      } else if (d.kind === "identity_decision") {
        targetId = d.table === "identity_reviews"
          ? (await c.query("insert into public.identity_reviews (candidate_id, decision, reason, note, queue, sample_seed, decided_by) values ($1, $2, $3, $4, $5, $6, $7) returning id::text", [p.targetId, d.decision, d.reason, d.note, d.queue, d.sampleSeed, founder])).rows[0].id
          : (await c.query("insert into catalog_import.identity_decisions (candidate_id, decision, note, decided_by) values ($1, $2, $3, $4) returning id::text", [p.targetId, d.decision, d.note, founder])).rows[0].id;
      }
      await c.query(
        `insert into app.data_transfer_items (run_id, source_ref, kind, natural_key, evidence, source_decided_at, target_id) values ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, p.ref, d.kind,
         d.kind === "identity_decision" ? { candidate: d.candidate.key, decision: d.decision } : { place: d.place, dish: d.dish?.label ?? null, fact: d.fact?.key ?? null, decision: d.decision ?? d.outcome ?? "confirm_transcription" },
         d.kind === "identity_decision" ? d.candidate.evidence : { fact: d.fact?.evidence ?? null, dishFingerprint: d.dish?.fingerprint ?? null, placeIdentity: d.place.identity },
         d.at, String(targetId)]);
    }
  } catch (e) {
    await c.query("rollback");
    const id = await run("refused", { ...s, error: String(e.message ?? e).split("\n")[0] });
    console.log(`Refused by the database: ${String(e.message ?? e).split("\n")[0]}. Nothing was replayed (logged as run ${id}).`);
    return 1;
  }
  await c.query("commit");
  console.log(`Replayed ${s.replay} decisions as ${as} (run ${runId}). Nothing was published and no switch changed.`);
  return 0;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (cmd === "export" && flag("--founder") && flag("--out")) await exportDecisions(client, flag("--founder"), flag("--out"));
  else if (cmd === "plan" && file) process.exitCode = await planOrApply(client, file, false);
  else if (cmd === "apply" && file) process.exitCode = await planOrApply(client, file, has("--confirm"));
  else throw new Error("Use: export --founder <email> --out <file> | plan <file> [--part meals|identity] | apply <file> --part meals|identity --as <email> --approval \"...\" --confirm");
} finally {
  await client.end();
}
