// Pure matching rules for carrying the founder's review decisions from one database to another
// (scripts/review-transfer.mjs; owner direction 25 Nov 2026 21:53 UTC). Kept free of database access so every rule is
// unit-tested. Ids differ between databases, so nothing is matched by id: a decision is matched by the restaurant,
// its branch (address and catalog records), the dish, the fact (kind, subject, value) and the source evidence (address
// of the saved page, its SHA-256 and retrieval time). A decision is replayed only when every one of these is
// identical on both sides; anything else is a conflict and stops the whole run.
import { createHash } from "node:crypto";

export const MEAL_KINDS = ["fact_review", "fact_transcription", "meal_note", "tester_decision"];
export const IDENTITY_KINDS = ["identity_decision"];

/** The same fact on two databases: restaurant, dish, kind, subject and value (the loader's key). */
export const factKey = (r) => JSON.stringify([r.place, r.dish ?? null, r.kind, r.subject ?? null, r.value ?? null]);
export const dishKey = (place, dish) => JSON.stringify([place, dish]);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Deterministic JSON (sorted object keys), so two databases describe equal things with equal strings. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** What a fact rests on. A change to any of these is a different version of the evidence. */
export const factEvidence = (f) => ({
  url: f.url ?? null,
  contentSha256: f.content_sha256 ?? null,
  retrievedAt: f.retrieved_at ?? null,
  isUnknown: Boolean(f.is_unknown),
  unknownReason: f.unknown_reason ?? null,
  checkedOn: f.checked_on ?? null,
  confidence: f.confidence ?? null,
  access: f.access ?? null,
});

/**
 * Describes one database's researched menus from plain rows (the same query runs on both sides).
 * facts: id, place, dish, kind, subject, value, status, transcribed, url, content_sha256, retrieved_at, is_unknown,
 *        unknown_reason, checked_on, confidence, access
 * places: id, label, address (array), catalog (array of [source_key, external_id])
 * dishes: id, place, dish
 */
export function describe({ facts, places, dishes }) {
  const factMap = new Map();
  const byDish = new Map();
  for (const f of facts) {
    const k = factKey(f);
    if (factMap.has(k)) factMap.set(k, { ...factMap.get(k), duplicate: true });
    else factMap.set(k, { id: f.id, status: f.status, transcribed: Boolean(f.transcribed), evidence: factEvidence(f), place: f.place });
    if (f.dish != null) {
      const dk = dishKey(f.place, f.dish);
      if (!byDish.has(dk)) byDish.set(dk, []);
      byDish.get(dk).push(stable([k, factEvidence(f)]));
    }
  }
  const placeMap = new Map(places.map((p) => [p.label, { id: p.id, identity: stable({ label: p.label, address: p.address ?? [], catalog: p.catalog ?? [] }) }]));
  const dishMap = new Map(dishes.map((d) => [dishKey(d.place, d.dish), { id: d.id, fingerprint: sha256((byDish.get(dishKey(d.place, d.dish)) ?? []).sort().join("\n")) }]));
  return { facts: factMap, places: placeMap, dishes: dishMap };
}

/**
 * Classifies each exported decision against the target: "replay", "done" (this exact source decision was already
 * replayed: its source_ref is in the target's audit log) or "conflict" with a reason. `target` is describe() of the
 * target plus `transferred` (Set of source_ref) and `candidates` (Map of candidate identity string to
 * {id, evidence, reviewItem}). Never throws on a mismatch; the caller refuses to apply when any conflict exists.
 */
export function planTransfer(exported, target) {
  const out = [];
  for (const d of exported.decisions) {
    const ref = `${exported.source.fingerprint}:${d.kind}:${d.sourceId}`;
    const row = { ref, kind: d.kind, sourceId: d.sourceId, at: d.at, label: d.label };
    if (target.transferred.has(ref)) { out.push({ ...row, outcome: "done" }); continue; }
    const conflict = (reason) => out.push({ ...row, outcome: "conflict", reason });
    if (d.kind === "identity_decision") {
      const c = target.candidates.get(stable(d.candidate.key));
      if (!c) { conflict("the restaurant's catalog identity (name, street, postcode and source records) is not on the target"); continue; }
      if (stable(c.evidence) !== stable(d.candidate.evidence)) { conflict("the catalog records differ (a different version of the source data)"); continue; }
      if (d.table === "identity_reviews" && !c.reviewItem) { conflict("the target has no identity review item for this restaurant"); continue; }
      out.push({ ...row, outcome: "replay", targetId: c.id });
      continue;
    }
    const place = target.places.get(d.place.label);
    if (!place) { conflict(`restaurant "${d.place.label}" is not on the target`); continue; }
    if (place.identity !== d.place.identity) { conflict(`restaurant "${d.place.label}" differs: its address or catalog link is not identical`); continue; }
    if (d.dish) {
      const dish = target.dishes.get(dishKey(d.place.label, d.dish.label));
      if (!dish) { conflict(`dish "${d.dish.label}" is not on the target`); continue; }
      if (dish.fingerprint !== d.dish.fingerprint) { conflict(`dish "${d.dish.label}": its facts or their evidence differ`); continue; }
      row.dishId = dish.id;
    }
    if (d.kind === "fact_review" || d.kind === "fact_transcription") {
      const f = target.facts.get(d.fact.key);
      if (!f) { conflict("the fact is not on the target"); continue; }
      if (f.duplicate) { conflict("the fact matches more than one fact on the target"); continue; }
      if (stable(f.evidence) !== stable(d.fact.evidence)) { conflict("the fact's evidence differs (source page, saved copy, retrieval time or access state)"); continue; }
      if (f.status !== "submitted" || f.transcribed) { conflict(`the fact was already decided on the target (${f.status}${f.transcribed ? ", source-reviewed" : ""})`); continue; }
      out.push({ ...row, outcome: "replay", targetId: f.id });
      continue;
    }
    if (d.kind === "meal_note" || d.kind === "tester_decision") {
      if (!row.dishId) { conflict("the decision names no dish"); continue; }
      out.push({ ...row, outcome: "replay", targetId: row.dishId });
      continue;
    }
    conflict(`unknown kind ${d.kind}`);
  }
  // Two source decisions on the same target fact can never both apply (the second would be refused); flag it here.
  const seen = new Map();
  for (const r of out.filter((x) => x.outcome === "replay" && (x.kind === "fact_review" || x.kind === "fact_transcription"))) {
    if (seen.has(r.targetId)) Object.assign(r, { outcome: "conflict", reason: "two decisions in the file name the same fact" });
    else seen.set(r.targetId, r);
  }
  return out;
}

/** Counts by outcome, and whether the run may apply (no conflict, something to do). */
export function summarise(plan) {
  const n = (o) => plan.filter((p) => p.outcome === o).length;
  const s = { replay: n("replay"), done: n("done"), conflict: n("conflict") };
  return { ...s, mayApply: s.conflict === 0 && s.replay > 0 };
}
