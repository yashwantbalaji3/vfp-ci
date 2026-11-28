// Onboarding readiness for real Boston places (owner 20:42 UTC 16 Nov, milestone 1).
// Reads researched staging entries (the same JSON files `staging-entry.mjs enter` takes) and says,
// for each place, what is known, what is still unknown and what a first real profile still needs.
// It never decides anything is true: every fact stays "submitted" until the founder checks it, and
// a place that is "ready for founder review" is not ready to publish. Pure functions, no I/O.
import { FACT_GROUPS, describeValue } from "./pilot-review-lib.mjs";

export { FACT_GROUPS };

/** What a first real profile needs, in the order the founder would check it. */
export const REQUIREMENTS = [
  { key: "address", label: "Street address and ZIP", blocking: true },
  // Not blocking: restaurant sites list hours but rarely say "open", so the research leaves it unknown
  // and the founder decides it during review. It is still shown on every report.
  { key: "status", label: "Operating status (open / closed): the founder decides when the site only lists hours", blocking: false },
  { key: "hours", label: "Opening hours", blocking: false },
  { key: "dishes", label: "At least 2 dishes confirmed on the menu", blocking: true },
  { key: "dietary", label: "At least 2 dishes the restaurant itself states are vegetarian or vegan", blocking: true },
  { key: "allergens", label: "Allergen statement for each dish", blocking: false },
  { key: "prices", label: "Price for each dish", blocking: false },
  { key: "protein", label: "Published protein for each dish (unknown is allowed)", blocking: false },
];

const known = (f) => f && f.value !== undefined && f.value !== null;

/**
 * Readiness of one researched place. `facts` are its staging facts, each with an optional
 * `status` ("submitted" when absent). Returns per-requirement state "met" | "partial" | "missing",
 * the reasons the research gave for each unknown, and an overall tier:
 *   "review"  — every blocking requirement has researched evidence: ready for the founder's batch review;
 *   "partial" — the place is identified (address known) but blocking evidence is missing;
 *   "identity" — not even an address yet.
 */
export function placeReadiness(place) {
  const facts = place.facts ?? [];
  const placeFact = (kind) => facts.find((f) => f.kind === kind && !f.dish);
  const dishes = (place.dishes ?? []).map((d) => {
    const of = (kind, subject) => facts.filter((f) => f.dish === d.key && f.kind === kind && (subject === undefined || f.subject === subject || f.value?.claim === subject || f.value?.nutrient === subject));
    const diet = [...of("dietary_status", "vegan"), ...of("dietary_status", "vegetarian")];
    return {
      key: d.key,
      label: d.label,
      onMenu: of("menu_item").some((f) => known(f) && f.value.listed === true),
      dietaryStated: diet.filter(known).map((f) => `${f.value.claim}: ${f.value.status}`),
      // Only a stated "yes" makes a dish fit the platform; a stated "no" is evidence too, but against.
      // Owner 22:26 UTC 16 Nov: a preliminary label ("VG = Vegetarian & Vegan-Friendly") makes a dish
      // eligible for founder review, but only when nothing in its description is flagged as
      // contradicting it (a flagged dish such as one with "cucumber raita" is listed, never counted).
      fits: diet.some((f) => known(f) && f.value.status === "yes" && !(f.value.reviewFlags ?? []).length),
      // Evidence class of the strongest counted "yes": an explicit per-dish statement, a brand-wide
      // ingredient statement (owner 23:11 UTC: never read as covering whole bowls or every location),
      // or a preliminary label.
      evidenceClass: (() => {
        const yes = diet.filter((f) => known(f) && f.value.status === "yes" && !(f.value.reviewFlags ?? []).length);
        if (yes.some((f) => !f.value.evidence && f.value.scope !== "brand_wide_ingredient")) return "explicit";
        if (yes.some((f) => f.value.scope === "brand_wide_ingredient")) return "brand_ingredient";
        return yes.length ? "preliminary" : null;
      })(),
      reviewFlags: diet.flatMap((f) => (known(f) ? f.value.reviewFlags ?? [] : [])),
      dietaryUnknown: diet.filter((f) => !known(f)).map((f) => f.unknownReason),
      allergens: of("allergen_statement").some(known),
      price: of("price").some(known),
      protein: of("published_nutrition", "protein_g").find(known)?.value?.amount ?? null,
    };
  });
  const listed = dishes.filter((d) => d.onMenu);
  const withDiet = listed.filter((d) => d.fits);
  // "explicit": at least 2 counted dishes rest on an explicit statement; otherwise "preliminary".
  const atLeast = (classes) => withDiet.filter((d) => classes.includes(d.evidenceClass)).length >= 2;
  const evidence = atLeast(["explicit"]) ? "explicit" : atLeast(["explicit", "brand_ingredient"]) ? "brand_ingredient" : withDiet.length ? "preliminary" : "none";
  const share = (n) => (listed.length === 0 ? "missing" : n === listed.length ? "met" : n > 0 ? "partial" : "missing");
  const state = {
    address: known(placeFact("address")) ? "met" : "missing",
    status: known(placeFact("operating_status")) ? "met" : "missing",
    hours: known(placeFact("weekly_hours")) ? "met" : "missing",
    dishes: listed.length >= 2 ? "met" : listed.length === 1 ? "partial" : "missing",
    dietary: withDiet.length >= 2 ? "met" : withDiet.length === 1 ? "partial" : "missing",
    allergens: share(listed.filter((d) => d.allergens).length),
    prices: share(listed.filter((d) => d.price).length),
    protein: share(listed.filter((d) => d.protein !== null).length),
  };
  const blockingOpen = REQUIREMENTS.filter((r) => r.blocking && state[r.key] !== "met");
  const tier = blockingOpen.length === 0 ? "review" : state.address === "met" ? "partial" : "identity";
  const unknownReasons = facts.filter((f) => !known(f) && f.unknownReason).map((f) => ({ kind: f.kind, dish: f.dish ?? null, reason: f.unknownReason }));
  const counts = {
    facts: facts.length,
    known: facts.filter(known).length,
    unknown: facts.filter((f) => !known(f)).length,
    verified: facts.filter((f) => f.status === "verified").length,
  };
  return { label: place.label, area: place.area, entries: place.entries ?? [place.label], locationKey: place.locationKey ?? null, evidence, tier, state, missing: blockingOpen.map((r) => r.label), dishes, unknownReasons, counts };
}

// ---- Identity deduplication (owner 22:03 UTC 16 Nov: "distinguish unique physical locations from
// supplemental menu research entries"). Two entries with the same normalized street + ZIP are one
// physical location; the later entries are supplemental research about it. An entry without an
// address stays its own (unidentified) location: names alone are never merged.

const STREET_WORDS = [[/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\bboulevard\b/g, "blvd"], [/\broad\b/g, "rd"], [/\bplace\b/g, "pl"], [/\bsquare\b/g, "sq"], [/\bjohn f\.? kennedy\b/g, "jfk"]];

/** A comparison key for a street address, or null when the entry has no address. */
export function addressKey(place) {
  const a = (place.facts ?? []).find((f) => f.kind === "address" && !f.dish && known(f));
  if (!a) return null;
  let street = String(a.value.street ?? "").toLowerCase().replace(/[.,#]/g, " ");
  for (const [re, to] of STREET_WORDS) street = street.replace(re, to);
  street = street.replace(/\s+/g, " ").trim();
  return `${street}|${String(a.value.postcode ?? "").trim()}`;
}

/** The brand (restaurant identity) an entry belongs to: its label without the "(location)" suffix. */
export const brandOf = (label) => label.replace(/\s*\(.*\)\s*$/, "").trim();

/**
 * Groups research entries into unique physical locations. Each location keeps the first entry's
 * label and area, lists every entry that described it, and combines their dishes and facts (dish
 * keys are prefixed by entry so two entries' "bowl" never collide). Nothing is invented or dropped.
 */
export function mergeByLocation(places) {
  const groups = new Map();
  // An entry may name, by exact label, an earlier entry it adds to ("supersedes"), for example an
  // address found later on the restaurant's own site. That is an explicit link, never a fuzzy match.
  const keys = places.map((p, i) => addressKey(p) ?? `unidentified:${i}`);
  places.forEach((p, i) => {
    if (!p.supersedes) return;
    places.forEach((q, j) => { if (j !== i && q.label === p.supersedes) keys[j] = keys[i]; });
  });
  places.forEach((p, i) => {
    const key = keys[i];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ p, i });
  });
  return [...groups.entries()].map(([key, members]) => {
    const multi = members.length > 1;
    const k = (i, d) => (multi ? `e${i}:${d}` : d);
    // Name the location after the first entry that has an address (an addressless entry it
    // superseded may come first in the files).
    const first = (members.find(({ p }) => addressKey(p)) ?? members[0]).p;
    return {
      // A supplement keeps the name of the entry it adds to.
      label: first.supersedes ?? first.label,
      area: first.area,
      locationKey: key.startsWith("unidentified:") ? null : key,
      entries: members.map(({ p }) => p.label),
      dishes: members.flatMap(({ p, i }) => (p.dishes ?? []).map((d) => ({ ...d, key: k(i, d.key) }))),
      // Place-level facts repeat across entries (each states the address); keep the first entry's
      // place facts first so placeReadiness reads them, and keep every fact for the counts.
      facts: [first, ...members.map(({ p }) => p).filter((p) => p !== first)].flatMap((p) => {
        const i = places.indexOf(p);
        return (p.facts ?? []).map((f) => ({ ...f, ...(f.dish ? { dish: k(i, f.dish) } : {}), ...(f.source ? { source: k(i, f.source) } : {}) }));
      }),
      sources: members.flatMap(({ p, i }) => (p.sources ?? []).map((src) => ({ ...src, key: k(i, src.key) }))),
    };
  });
}

/** Headline counts for the founder: entries, unique locations, brands, and progress to the targets. */
export function coverageSummary(entries, locations, readiness, targets = [10, 50]) {
  const ready = readiness.filter((r) => r.tier === "review").length;
  const readyPreliminary = readiness.filter((r) => r.tier === "review" && r.evidence === "preliminary").length;
  const readyBrand = readiness.filter((r) => r.tier === "review" && r.evidence === "brand_ingredient").length;
  const verified = readiness.filter((r) => r.counts.verified > 0 && r.counts.verified === r.counts.facts).length;
  return {
    entries: entries.length,
    locations: locations.length,
    identified: locations.filter((l) => l.locationKey).length,
    brands: new Set(locations.map((l) => brandOf(l.label))).size,
    supplemental: entries.length - locations.length,
    ready,
    readyExplicit: ready - readyPreliminary - readyBrand,
    readyBrand,
    readyPreliminary,
    verified,
    targets: targets.map((t) => ({ target: t, ready: Math.min(ready, t), verified: Math.min(verified, t) })),
  };
}

/** Facts held back because their sources are not cleared (docs/46): counts only, by state. */
export function heldSummary(locations) {
  const all = locations.flatMap((l) => (l.held ?? []).map((f) => ({ ...f, location: l.label })));
  const protein = (f) => f.kind === "published_nutrition" && !f.unknownReason && (f.subject ?? f.value?.nutrient) === "protein_g";
  const of = (state) => all.filter((f) => f.sourceState === state);
  return {
    facts: all.length,
    prohibited: of("prohibited").length,
    pending: of("pending").length,
    protein: all.filter(protein).length,
    locations: new Set(all.map((f) => f.location)).size,
    fullyHeld: locations.filter((l) => (l.held ?? []).length && !(l.facts ?? []).length).length,
  };
}

/** Renders the blocked-sources registry so the same unusable sources are not researched again. */
export function blockersMarkdown(blockers) {
  if (!blockers?.length) return "";
  const lines = ["## Sources we cannot use (do not research again unless something changes)", "", "| Restaurant / source | Why it is blocked | Checked | Retry when |", "|---|---|---|---|"];
  for (const b of blockers) lines.push(`| ${b.subject} | ${b.reason} | ${b.checked ?? ""} | ${b.retry ?? "—"} |`);
  lines.push("");
  return lines.join("\n");
}

/** Founder-review batches: places in readiness order, packed so no batch has more than `maxFacts` facts (a place is never split). */
export function reviewBatches(readiness, maxFacts = 60) {
  const order = { review: 0, partial: 1, identity: 2 };
  const sorted = [...readiness].sort((a, b) => order[a.tier] - order[b.tier] || b.counts.known - a.counts.known || a.label.localeCompare(b.label));
  const batches = [];
  // A location with no countable fact (for example, every fact held for source clearance) has nothing to review.
  for (const r of sorted.filter((x) => x.counts.facts > 0)) {
    const last = batches[batches.length - 1];
    if (last && last.facts + r.counts.facts <= maxFacts) {
      last.places.push(r.label);
      last.facts += r.counts.facts;
    } else {
      batches.push({ places: [r.label], facts: r.counts.facts });
    }
  }
  return batches;
}

const MARK = { met: "yes", partial: "partly", missing: "no" };
const EVIDENCE_WORDS = { explicit: "Explicit statement", brand_ingredient: "Brand-wide ingredient statement only", preliminary: "Preliminary label only", none: "None yet" };
const TIER_WORDS = { review: "Ready for founder review", partial: "Identified, evidence missing", identity: "Not yet identified" };

/** A plain-language Markdown report for the founder. Says nothing is verified unless it is. */
export function readinessMarkdown(readiness, batches, generatedOn, { summary, blockers } = {}) {
  const lines = [];
  lines.push(`# Real Boston restaurant onboarding: readiness (${generatedOn})`, "");
  lines.push("Every fact below was researched from the restaurant's own pages and is **unverified** until the founder checks it. \"Ready for founder review\" means the research is complete enough to check, not that anything may be published. The real-data publication lock stays off.", "");
  const byTier = (t) => readiness.filter((r) => r.tier === t).length;
  if (summary) {
    lines.push(`**${summary.locations} unique physical locations** (${summary.brands} restaurant brands) from ${summary.entries} research entries; ${summary.supplemental} entr${summary.supplemental === 1 ? "y is" : "ies are"} supplemental research about a location already counted.`, "");
    lines.push(`**Progress:** ${summary.ready} location${summary.ready === 1 ? "" : "s"} ready for founder review (${summary.readyExplicit} on explicit per-dish vegetarian/vegan statements, ${summary.readyBrand} on brand-wide ingredient statements only, ${summary.readyPreliminary} on a preliminary restaurant label only) and ${summary.verified} verified. ` + summary.targets.map((t) => `First ${t.target}: ${t.ready}/${t.target} ready, ${t.verified}/${t.target} verified.`).join(" "), "");
  }
  if (summary?.held) {
    const h = summary.held;
    lines.push(`**Held for source clearance:** ${h.facts} researched facts at ${h.locations} locations (${h.prohibited} from sources whose terms prohibit our use, ${h.pending} from sources with unclear, unreadable or unreviewed terms; ${h.protein} protein figures) do not count here, are never in a founder-review batch and cannot be published. ${h.fullyHeld} locations have no cleared fact at all. See the research source audit (docs/46).`, "");
  }
  lines.push(`**${readiness.length} ${summary ? "locations" : "places"} researched:** ${byTier("review")} ready for founder review, ${byTier("partial")} identified with evidence missing, ${byTier("identity")} not yet identified.`, "");
  lines.push("| Place | Area | Readiness | Dietary evidence | Address | Status | Hours | Dishes on menu | Stated veg/vegan | Prices | Protein | Facts (known / unknown) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of readiness) {
    const s = r.state;
    lines.push(`| ${r.label} | ${r.area} | ${TIER_WORDS[r.tier]} | ${EVIDENCE_WORDS[r.evidence]} | ${MARK[s.address]} | ${MARK[s.status]} | ${MARK[s.hours]} | ${r.dishes.filter((d) => d.onMenu).length} | ${r.dishes.filter((d) => d.onMenu && d.fits).length} | ${MARK[s.prices]} | ${MARK[s.protein]} | ${r.counts.known} / ${r.counts.unknown} |`);
  }
  lines.push("", "## What each place still needs", "");
  for (const r of readiness) {
    lines.push(`### ${r.label}`, "");
    if (r.entries?.length > 1) lines.push(`One location, ${r.entries.length} research entries: ${r.entries.join("; ")}.`, "");
    lines.push(r.missing.length ? `Blocking: ${r.missing.join("; ")}.` : "Nothing blocking: ready for the founder's review.");
    const flagged = r.dishes.filter((d) => d.reviewFlags.length);
    if (flagged.length) {
      lines.push("", "Flagged for explicit founder review (not counted toward readiness):");
      for (const d of flagged) for (const f of d.reviewFlags) lines.push(`- ${d.label}: ${f}`);
    }
    const open = r.unknownReasons.slice(0, 6);
    if (open.length) {
      lines.push("", "Unresolved (from the research):");
      for (const u of open) lines.push(`- ${u.dish ? `${u.dish} · ` : ""}${u.kind}: ${u.reason}`);
      if (r.unknownReasons.length > open.length) lines.push(`- …and ${r.unknownReasons.length - open.length} more.`);
    }
    lines.push("");
  }
  lines.push("## Suggested founder-review batches", "");
  if (!batches.length) lines.push("None: no location has a fact from a cleared source yet.");
  batches.forEach((b, i) => lines.push(`${i + 1}. ${b.places.join(", ")} (${b.facts} facts)`));
  lines.push("");
  const blocked = blockersMarkdown(blockers);
  if (blocked) lines.push(blocked);
  return lines.join("\n");
}

// ---- Founder-review batch sheet (owner 23:11 UTC 16 Nov): one evidence-linked sheet per batch,
// grouped by what is being verified, so identity, status, dishes, dietary status, nutrition,
// allergens, prices and serving size can each be checked on their own. A missing nutrition figure is
// listed as unknown and never holds back the other groups.



const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Facts of one location grouped by FACT_GROUPS, each with its dish label and source link. */
export function groupFacts(location) {
  const dishLabel = new Map((location.dishes ?? []).map((d) => [d.key, d.label]));
  const source = new Map((location.sources ?? []).map((s) => [s.key, s]));
  return FACT_GROUPS.map((g) => ({
    ...g,
    facts: (location.facts ?? []).filter((f) => g.kinds.includes(f.kind)).map((f) => ({
      dish: f.dish ? dishLabel.get(f.dish) ?? f.dish : null,
      text: describeValue({ kind: f.kind, subject: f.subject ?? f.value?.claim ?? f.value?.nutrient, value: f.value, is_unknown: !known(f), unknown_reason: f.unknownReason }),
      unknown: !known(f),
      url: source.get(f.source)?.url ?? null,
      read: String(source.get(f.source)?.retrievedAt ?? "").slice(0, 10),
      note: source.get(f.source)?.termsNote ?? null,
    })),
  }));
}

/** Markdown sheet for one founder-review batch. Says what is unverified and what is not decided. */
export function batchSheetMarkdown(locations, title, generatedOn) {
  const lines = [`# ${title} (${generatedOn})`, ""];
  lines.push("Every fact here is **submitted and unverified**. Check each one against its source link, then verify or reject it on the local review page (`node scripts/pilot-review.mjs --as <you> --batch …`). Verifying does not publish anything; the real-data publication lock stays off. Unknown facts are listed so you can see the gap; they never block the facts that are known.", "");
  const totals = locations.map((l) => ({ l, groups: groupFacts(l) }));
  lines.push("| Place | " + FACT_GROUPS.map((g) => g.label).join(" | ") + " |");
  lines.push("|---|" + FACT_GROUPS.map(() => "---").join("|") + "|");
  for (const { l, groups } of totals) lines.push(`| ${cell(l.label)} | ` + groups.map((g) => `${g.facts.filter((f) => !f.unknown).length} known / ${g.facts.filter((f) => f.unknown).length} unknown`).join(" | ") + " |");
  lines.push("");
  for (const { l, groups } of totals) {
    lines.push(`## ${l.label}`, "");
    if (l.entries?.length > 1) lines.push(`One location, ${l.entries.length} research entries: ${l.entries.join("; ")}.`, "");
    for (const g of groups) {
      if (!g.facts.length) { lines.push(`### ${g.label}`, "", "Nothing researched yet.", ""); continue; }
      lines.push(`### ${g.label}`, "", "| Dish | Fact | Source (read on) |", "|---|---|---|");
      for (const f of g.facts) lines.push(`| ${cell(f.dish ?? "The place")} | ${cell(f.text)} | ${f.url ? `[link](${f.url}) (${f.read})` : "no source"} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
