// Private real-catalog preview (docs/32): which imported place candidates may enter the founder's
// private preview, which go to an exception queue, and the representative sample the founder checks.
// Pure functions, no I/O. The database side is scripts/catalog-preview.mjs.
//
// Entering the preview is NOT verification. A candidate's identity becomes "verified" only by the
// founder's own decision on that place; nothing here sets it.
import { createHash } from "node:crypto";
import { FOCUS_POSTCODES, fold, houseNumber, metres, nameSimilarity } from "./catalog-import-lib.mjs";

/** Exception reasons, in the order the founder sees them, with plain words. */
export const EXCEPTION_REASONS = {
  rejected: "Rejected by a person",
  source_absent: "Missing from the latest release of one of its sources",
  possible_duplicate: "Looks like another nearby candidate (possible duplicate)",
  possibly_not_public: "Name suggests a school, hospital, office or other facility that may not be open to the public",
  possibly_not_restaurant: "Name suggests a shop, hotel or venue rather than a restaurant or café",
  sources_disagree_on_position: "The two sources place it more than 80 m apart",
  sources_disagree_on_name: "The two sources name it differently",
  sources_disagree_on_address: "The two sources give different house numbers",
  open_status_unknown: "Overture does not say it is open (it may have closed)",
  category_unclear: "Overture lists it as a food truck or stand at a fixed address",
  name_garbled: "The name has broken characters in the source data",
  near_twin: "Another preview place with almost the same name is within 150 m",
  founder_needs_more_evidence: "You asked for more evidence",
  reported_by_visitor: "A visitor reported a problem with it",
  missing_address: "No street or ZIP code",
  single_source: "Only one public source so far (needs a second source or a person)",
  needs_review: "Failed an import check (low confidence or missing address)",
};

// Whole words only. Deliberately crude: a hit sends the place to a person, never deletes it.
const NOT_PUBLIC = /\b(school|academy|elementary|preschool|daycare|day care|dining hall|dining services|campus center|hospital|medical center|health center|clinic|nursing|rehabilitation|senior center|employee|staff|corporate|commissary|food service|foodservice|correctional|shelter|ymca|country club|\d+(st|nd|rd|th) floor|floor \d+)\b/;
const NOT_RESTAURANT = /\b(grocery|supermarket|liquor|wine shop|wine and spirits|spirits|pharmacy|cvs|walgreens|7-eleven|convenience|gas station|hotel|motel|theater|theatre|cinema|stadium|arena|gym|fitness|atm|bank)\b/;
// Added after the 17 Nov sample audit (America's Test Kitchen, campus cafés): kitchens that are not
// restaurants, and university, hospital or government websites or addresses.
const NOT_PUBLIC_NAME = /\b(test kitchen|conference)\b/;
const NOT_PUBLIC_SITE = /\.(edu|gov)(\/|$)|\b(hospital|medical|dining\.|\/dining\b)/;
const NOT_PUBLIC_STREET = /\b(school of|campus dining|dining services|university|college)\b/;
const GARBLED = /Ã|â€|�/;

/**
 * Sorts one candidate (with its linked records) into the preview or an exception queue.
 * Returns {tier, reasons}: tier 'preview' (corroborated, every check passed), 'exception'
 * (a person decides) or 'excluded' (rejected). Single-source candidates are not in this first
 * preview; they are counted in their own queue.
 */
export function assessCandidate(c) {
  const reasons = [];
  if (c.quality === "rejected") return { tier: "excluded", reasons: ["rejected"] };
  const recs = c.records ?? [];
  if (recs.some((r) => r.present === false)) reasons.push("source_absent");
  if ((c.flags ?? []).includes("possible_duplicate")) reasons.push("possible_duplicate");
  const names = [c.name, ...recs.map((r) => r.name)].map((n) => fold(n));
  const sites = recs.map((r) => String(r.website ?? "").toLowerCase());
  const streets = recs.map((r) => fold(r.street));
  if (names.some((n) => NOT_PUBLIC.test(n) || NOT_PUBLIC_NAME.test(n)) || sites.some((w) => NOT_PUBLIC_SITE.test(w)) || streets.some((t) => NOT_PUBLIC_STREET.test(t))) reasons.push("possibly_not_public");
  if (names.some((n) => NOT_RESTAURANT.test(n))) reasons.push("possibly_not_restaurant");
  const sources = new Set(recs.map((r) => r.source_key));
  if (sources.size >= 2) {
    let far = 0;
    let unlike = 1;
    for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
      if (recs[i].source_key === recs[j].source_key) continue;
      far = Math.max(far, metres(recs[i], recs[j]));
      unlike = Math.min(unlike, nameSimilarity(recs[i].name, recs[j].name));
    }
    if (far > 80) reasons.push("sources_disagree_on_position");
    if (unlike < 0.5) reasons.push("sources_disagree_on_name");
    const numbers = new Set(recs.map((r) => houseNumber(r.street)).filter(Boolean));
    if (numbers.size > 1) reasons.push("sources_disagree_on_address");
  }
  const ov = recs.find((r) => r.source_key === "overture_places");
  if (ov && ov.status_hint && ov.status_hint !== "open") reasons.push("open_status_unknown");
  if (ov && ov.category === "food_truck_stand") reasons.push("category_unclear");
  if ([c.name, ...recs.map((r) => r.name)].some((n) => GARBLED.test(String(n ?? "")))) reasons.push("name_garbled");
  if (!c.street || !c.postcode) reasons.push("missing_address");
  if (c.quality === "single_source") reasons.push("single_source");
  if (c.quality === "needs_review") reasons.push("needs_review");
  return { tier: reasons.length ? "exception" : "preview", reasons };
}

/**
 * Second pass over the places that passed every check: two of them with almost the same name within
 * 150 m are probably one place listed twice. Returns the ids to send to the duplicate queue.
 */
export function nearTwins(list) {
  const out = new Set();
  const sorted = [...list].sort((a, b) => a.lat - b.lat);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].lat - sorted[i].lat < 0.0015; j++) {
      if (Math.abs(sorted[j].lon - sorted[i].lon) > 0.002) continue;
      if (metres(sorted[i], sorted[j]) <= 150 && nameSimilarity(sorted[i].name, sorted[j].name) >= 0.9) { out.add(sorted[i].id); out.add(sorted[j].id); }
    }
  }
  return out;
}

/** The neighbourhood shown with a listing, from its ZIP code (approximate: a ZIP can straddle two). */
export function areaFor(postcode) {
  for (const [area, zips] of Object.entries(FOCUS_POSTCODES)) if (zips.includes(postcode)) return area;
  return null;
}

/** A short, stable public slug for a listing. */
export function listingSlug(name, street, id) {
  const base = fold(`${name} ${street ?? ""}`).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "place";
  return `${base}-${String(id).replace(/-/g, "").slice(0, 6)}`;
}

/** Plain category word for a listing, from the Overture category (never a dietary word). */
export function categoryLabel(category) {
  return { cafe: "Café", coffee_shop: "Coffee shop", smoothie_juice_bar: "Juice bar", food_truck_stand: "Food truck", food_court: "Food court", fast_food_restaurant: "Quick service", casual_eatery: "Restaurant", restaurant: "Restaurant" }[category] ?? "Restaurant";
}

/**
 * Representative sample for the founder: candidates spread across focus areas (and "elsewhere")
 * in proportion to their size, at least `minPerStratum` from each, chosen by a seeded hash so the
 * same seed gives the same sample. Returns [{id, stratum}].
 */
export function drawSample(candidates, { size = 60, seed = "sample-1", minPerStratum = 3 } = {}) {
  const strata = new Map();
  for (const c of candidates) {
    const s = areaFor(c.postcode) ?? "Elsewhere in the service area";
    if (!strata.has(s)) strata.set(s, []);
    strata.get(s).push(c);
  }
  const total = candidates.length;
  const key = (c) => createHash("sha256").update(`${seed}|${c.id}`).digest("hex");
  const out = [];
  for (const [s, list] of [...strata].sort((a, b) => a[0].localeCompare(b[0]))) {
    const want = Math.min(list.length, Math.max(minPerStratum, Math.round((size * list.length) / Math.max(total, 1))));
    out.push(...[...list].sort((a, b) => key(a).localeCompare(key(b))).slice(0, want).map((c) => ({ id: c.id, stratum: s })));
  }
  return out;
}

/**
 * What a checked sample says about the batch it came from. `outcomes` are the founder's results:
 * 'correct' or a problem code. The batch "passes" only if no more than `maxProblems` problems were
 * found; even then nothing becomes verified (docs/32 section 4).
 */
export function sampleVerdict(outcomes, { maxProblemShare = 0.05 } = {}) {
  const checked = outcomes.filter((o) => o);
  const problems = checked.filter((o) => o !== "correct").length;
  const done = checked.length === outcomes.length && outcomes.length > 0;
  const share = checked.length ? problems / checked.length : null;
  return { checked: checked.length, of: outcomes.length, problems, share, done, passes: done && share <= maxProblemShare };
}

/** The fingerprint of a frozen batch: a hash of its sorted place ids. */
export function batchFingerprint(ids) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

/**
 * Places to add when a batch's sample is extended (docs/35): the next places of the batch, not yet in
 * the sample, in a seeded hash order, so the same seed always adds the same places.
 */
export function extendSampleIds(batchIds, sampledIds, { to, seed }) {
  const have = new Set(sampledIds);
  const want = Math.max(0, to - have.size);
  const key = (id) => createHash("sha256").update(`${seed}|extend|${id}`).digest("hex");
  return batchIds.filter((id) => !have.has(id)).sort((a, b) => key(a).localeCompare(key(b))).slice(0, want);
}

/** One-sided 95% upper confidence bound on a batch's problem rate (exact Clopper-Pearson). Same as app.binomial_upper_95. */
export function upperBound95(k, n) {
  if (!(n > 0) || k >= n) return 1;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 60; it++) {
    const p = (lo + hi) / 2;
    let term = (1 - p) ** n;
    let cdf = term;
    for (let i = 0; i < k; i++) {
      term = (term * (n - i)) / (i + 1) * (p / (1 - p));
      cdf += term;
    }
    if (cdf > 0.05) lo = p;
    else hi = p;
  }
  return Math.round(lo * 10000) / 10000;
}

/** The approved acceptance rule (docs/34 §3). Same as app.sample_passes. */
export function samplePasses(problems, sampleSize, checked) {
  return checked === sampleSize && sampleSize > 0 && ((sampleSize >= 61 && problems === 0) || (sampleSize >= 125 && problems <= 2));
}
