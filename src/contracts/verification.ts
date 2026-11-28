/**
 * Evidence-based verification, DRY RUN (owner directive 28 Nov 2026 04:59 UTC, part 2). Pure: it reads a staged meal
 * and returns five independent results. It writes nothing, approves nothing and publishes nothing; the founder's
 * policy decision is still needed before any of it is applied.
 *
 *   1. source       A  every stated fact was found on the saved copy of its approved source page
 *                   B  human exception: something was not found where expected, or was never compared
 *                   E  source unavailable or outdated: no usable saved copy, or an old menu edition
 *   2. diet         per filter (vegetarian, vegan, egg-free vegetarian), decided by the app's own mealFit, so a meal
 *                   reads the same here as in Discover, Protein Explorer and saved lists:
 *                   candidate  the restaurant's own word supports it, nothing printed contradicts it, and that word
 *                              was found on the saved page
 *                   B          human exception: the restaurant's word and a printed ingredient disagree, labels
 *                              disagree, a listed word may hide an ingredient, or the word was not found on the page
 *                   C          explicit exclusion: a printed ingredient, the name or the restaurant rules it out
 *                   D          insufficient evidence: the restaurant says nothing usable either way
 *   3. nutrition    published | published_range | restaurant_estimate | usda_range | unknown (never zero)
 *   4. eligibility  per filter, true only for source A and diet candidate; computed, never applied
 *   5. publication  as recorded; never changed here
 *
 * Cuisine, venue type, photos, a missing word or a confidence score are never evidence for a claim.
 */
import type { DietChoice } from "@/domain/dietary/labels";
import { dishEvidence, mealFit, type DietEvidence } from "./meal-eligibility";
import type { MenuDish, MenuFact, MenuPlace } from "./menu-review";
import { rowFlags } from "./menu-prechecks";
import { isHistoricalEdition } from "./source-editions";

export const FILTERS = ["vegetarian", "vegan", "egg_free"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_CHOICE: Record<Filter, DietChoice> = {
  vegetarian: { diet: "vegetarian", exclusions: [] },
  vegan: { diet: "vegan", exclusions: [] },
  egg_free: { diet: "vegetarian", exclusions: ["egg"] },
};
export const FILTER_WORDS: Record<Filter, string> = { vegetarian: "Vegetarian", vegan: "Vegan", egg_free: "Egg-free vegetarian" };

export type SourceOutcome = "A" | "B" | "E";
export type DietOutcome = "candidate" | "B" | "C" | "D";
export type Verification = {
  dishId: string;
  source: SourceOutcome;
  /** Plain reasons for B or E, one per fact that held it back. */
  sourceReasons: string[];
  diet: Record<Filter, { outcome: DietOutcome; reasons: string[]; scope: "dish" | "section_or_menu" | null }>;
  nutrition: "published" | "published_range" | "restaurant_estimate" | "usda_range" | "unknown";
  eligibility: Record<Filter, boolean>;
  publication: "published" | "not_published";
};

const live = (d: MenuDish) => d.facts.filter((f) => f.status === "submitted" || f.status === "verified");
const factWords = (f: MenuFact) => (f.kind === "dietary_status" ? `the ${f.subject} label` : f.kind === "published_nutrition" ? `the ${f.subject?.replace(/_g$|_mg$/, "")} figure` : `the ${f.kind.replace(/_/g, " ")}`);

/** 1. Whether the drafted words match the saved source page. Says nothing about the food itself. */
export function sourceOutcome(d: MenuDish, place: Pick<MenuPlace, "sources">, now = Date.now()): { source: SourceOutcome; reasons: string[] } {
  const stated = live(d).filter((f) => !f.unknown);
  if (!stated.length) return { source: "E", reasons: ["Nothing stated about this dish is on record"] };
  const reasons: string[] = [];
  let worst: SourceOutcome = "A";
  const raise = (o: SourceOutcome) => { if (o === "E" || worst === "A") worst = o; };
  for (const f of stated) {
    const url = place.sources.find((s) => s.sourceId === f.sourceId)?.url;
    if (isHistoricalEdition(url, now)) {
      if (f.kind === "price") { raise("E"); reasons.push(`${cap(factWords(f))} comes from an old menu edition`); continue; }
    }
    const mc = f.machineCheck;
    if (!mc) { raise("B"); reasons.push(`${cap(factWords(f))} was never compared with a saved page`); continue; }
    if (mc.result === "not_checked") {
      if (/no saved copy|differs from the fingerprint/i.test(mc.detail)) { raise("E"); reasons.push(`${cap(factWords(f))}: ${mc.detail}`); }
      else { raise("B"); reasons.push(`${cap(factWords(f))} was not compared: ${mc.detail}`); }
      continue;
    }
    if (mc.result === "not_found") { raise("B"); reasons.push(`${cap(factWords(f))} was not found where expected: ${mc.detail}`); }
  }
  if (worst === "A" && !stated.some((f) => f.kind === "menu_item" && f.machineCheck?.result === "found")) {
    worst = "B";
    reasons.push("The dish name itself was not confirmed on the saved page");
  }
  return { source: worst, reasons };
}

/** 2. One filter, from the app's own eligibility rule plus whether the restaurant's word was found on the page. */
export function dietOutcome(d: MenuDish, e: DietEvidence, filter: Filter): Verification["diet"][Filter] {
  const fit = mealFit(e, FILTER_CHOICE[filter]);
  const labels = live(d).filter((f) => f.kind === "dietary_status" && !f.unknown && f.value?.status === "yes");
  // The restaurant's own label is contradicted only when what is printed breaks that label itself: anything animal
  // against "vegan", meat against "vegetarian". Egg beside a vegetarian label is no conflict; it simply isn't egg-free.
  const labelContradicted = e.veganClaim === "yes" || (e.vegetarianClaim === "yes" && e.namesMeat);
  if (fit.status === "ineligible") {
    // A printed contradiction overrides a positive label until a person resolves it.
    return labelContradicted ? { outcome: "B", reasons: fit.reasons, scope: null } : { outcome: "C", reasons: fit.reasons, scope: null };
  }
  if (fit.status === "needs_confirmation") {
    const silence = (r: string) => /doesn't say|isn't ruled out: the restaurant doesn't say/i.test(r);
    const onlySilence = fit.reasons.every(silence);
    // The reason a person is needed comes first; plain silence after it.
    return { outcome: onlySilence ? "D" : "B", reasons: [...fit.reasons.filter((r) => !silence(r)), ...fit.reasons.filter(silence)], scope: null };
  }
  // Eligible: the restaurant's word must also be on the saved page.
  const used = labels.filter((f) => f.subject === "vegan" || (filter !== "vegan" && f.subject === "vegetarian"));
  const found = used.filter((f) => f.machineCheck?.result === "found");
  if (!found.length) return { outcome: "B", reasons: ["The restaurant's diet word was not found next to the dish on the saved page by the automatic comparison", ...fit.reasons], scope: null };
  const dishLevel = found.some((f) => /shortly after the dish name/i.test(f.machineCheck?.detail ?? ""));
  return { outcome: "candidate", reasons: fit.reasons, scope: dishLevel ? "dish" : "section_or_menu" };
}

/** All five dimensions for one staged dish. */
export function verifyDish(d: MenuDish, place: MenuPlace, protein: Verification["nutrition"], now = Date.now()): Verification {
  const flags = rowFlags(d, place);
  const notVeg = live(d).some((f) => f.kind === "dietary_status" && f.subject === "vegetarian" && !f.unknown && f.value?.status === "no");
  const e = dishEvidence(d, flags.some((f) => f.code === "names_meat") || notVeg);
  const { source, reasons } = sourceOutcome(d, place, now);
  const diet = Object.fromEntries(FILTERS.map((k) => [k, dietOutcome(d, e, k)])) as Verification["diet"];
  const published = live(d).some((f) => f.ladder?.published || f.statuses.publicationApproved);
  return {
    dishId: d.dishId,
    source,
    sourceReasons: reasons,
    diet,
    nutrition: protein,
    eligibility: Object.fromEntries(FILTERS.map((k) => [k, source === "A" && diet[k].outcome === "candidate"])) as Verification["eligibility"],
    publication: published ? "published" : "not_published",
  };
}

export type Tally = {
  dishes: number;
  source: Record<SourceOutcome, number>;
  sourceReasons: Record<string, number>;
  diet: Record<Filter, Record<DietOutcome, number>>;
  dietReasons: Record<Filter, Record<string, number>>;
  nutrition: Record<string, number>;
  eligible: Record<Filter, number>;
  published: number;
};
/** Reason text without the dish-specific words, so the same reason groups together. */
export const reasonKey = (r: string) =>
  r.replace(/“[^”]*”|"[^"]*"/g, "…").replace(/: .*$/, "").replace(/^It lists …$/, "It lists an ingredient the filter rules out").replace(/^Its allergen list says it contains .*$/, "Its allergen list names an ingredient the filter rules out");

/** Counts, each within one dimension only; a dish is counted once per dimension (and once per filter). */
export function tallyOf(rows: Verification[]): Tally {
  const t: Tally = {
    dishes: rows.length,
    source: { A: 0, B: 0, E: 0 },
    sourceReasons: {},
    diet: Object.fromEntries(FILTERS.map((k) => [k, { candidate: 0, B: 0, C: 0, D: 0 }])) as Tally["diet"],
    dietReasons: Object.fromEntries(FILTERS.map((k) => [k, {}])) as Tally["dietReasons"],
    nutrition: {},
    eligible: Object.fromEntries(FILTERS.map((k) => [k, 0])) as Tally["eligible"],
    published: 0,
  };
  for (const r of rows) {
    t.source[r.source] += 1;
    for (const k of new Set(r.sourceReasons.map(sourceReasonKey))) t.sourceReasons[k] = (t.sourceReasons[k] ?? 0) + 1;
    for (const f of FILTERS) {
      t.diet[f][r.diet[f].outcome] += 1;
      if (r.diet[f].outcome !== "candidate") {
        const k = `${r.diet[f].outcome}: ${reasonKey(r.diet[f].reasons[0] ?? "")}`;
        t.dietReasons[f][k] = (t.dietReasons[f][k] ?? 0) + 1;
      }
      if (r.eligibility[f]) t.eligible[f] += 1;
    }
    t.nutrition[r.nutrition] = (t.nutrition[r.nutrition] ?? 0) + 1;
    if (r.publication === "published") t.published += 1;
  }
  return t;
}
const sourceReasonKey = (r: string) =>
  /old menu edition/.test(r) ? "Price from an old menu edition"
  : /never compared/.test(r) ? "A fact was never compared with a saved page"
  : /No saved copy/i.test(r) ? "No saved copy of the source page"
  : /differs from the fingerprint/.test(r) ? "Saved copy changed since it was fetched"
  : /not compared/.test(r) ? "A fact was not compared (see detail)"
  : /dish name itself/.test(r) ? "Dish name not confirmed on the page"
  : /^The price was not found/.test(r) ? "Price not found next to the dish"
  : /^The listed ingredients was not found/.test(r) ? "Listed ingredients not found as written"
  : /^The (vegan|vegetarian|egg_free) label was not found/.test(r) ? "Diet word not found next to the dish"
  : /^The menu item was not found/.test(r) ? "Dish name not found on the page"
  : /not found where expected/.test(r) ? "Another fact not found where expected"
  : "Nothing stated on record";

/** Manual reviews the policy could replace, if the founder adopts it: source-A meals need no per-fact transcription check. */
export function workload(rows: Verification[]) {
  const transcription = rows.filter((r) => r.source === "A").length;
  const dietHuman = rows.filter((r) => FILTERS.some((f) => r.diet[f].outcome === "B")).length;
  return { meals: rows.length, transcriptionChecksReplaceable: transcription, stillNeedSourceException: rows.length - transcription, dietExceptions: dietHuman };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
