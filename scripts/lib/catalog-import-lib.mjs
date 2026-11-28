// Boston-wide restaurant IDENTITY import: parsing, validation, deduplication and quality (docs/31).
// Pure functions, no I/O. The database side is scripts/catalog-import.mjs.
//
// Identity only: name, address, position, a category hint and an operating-status hint. Nothing here
// says what a place serves, so nothing imported can ever pass a dietary filter.
import { createHash } from "node:crypto";
import MARKETS_JSON from "./markets.json" with { type: "json" };

/** The service area for the first import: Boston core, Cambridge, Somerville and Brookline. */
export const SERVICE_AREA = { minLat: 42.3, maxLat: 42.4, minLon: -71.2, maxLon: -70.98 };

/**
 * Import areas (docs/84). "boston-core" is the first import's box above and stays the default, so a re-run of the
 * approved Boston files imports exactly what it did before. Each market slug ("boston", "new-york", ...) is a circle
 * of about 25 miles around its centre, the same as public.markets. One pipeline for every city: only the area and
 * the dataset files change.
 */
export const MARKET_AREAS = Object.fromEntries(
  Object.entries(MARKETS_JSON).filter(([k]) => !k.startsWith("_")),
);
const EARTH_M = 6371008.8;
export function metresBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}
/** The market slug whose 25-mile area holds a point (the nearest centre if two overlap), or null outside all of them. */
/**
 * The database's market area is a 32-sided polygon on the spheroid, up to about 0.2 km inside the true circle, and this
 * sphere distance differs from the spheroid by up to about 0.2 km at 25 miles. A listing is only given a market when it
 * is at least this far inside the edge, so the database's own check never disagrees (LISTING_OUTSIDE_MARKET).
 */
export const MARKET_EDGE_MARGIN_M = 500;
export function marketAt(p) {
  let best = null;
  for (const [slug, m] of Object.entries(MARKET_AREAS)) {
    const d = metresBetween(m, p);
    if (d <= m.radiusM - MARKET_EDGE_MARGIN_M && (!best || d < best.d)) best = { slug, d };
  }
  return best?.slug ?? null;
}
/** An area by name: { key, contains(point), box } (box: the smallest lat/lon rectangle around it, for extracts). */
export function areaFor(key = "boston-core") {
  if (key === "boston-core") {
    const b = SERVICE_AREA;
    return { key, box: b, contains: (p) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon };
  }
  const m = MARKET_AREAS[key];
  if (!m) throw new Error(`Unknown import area ${key}. Use boston-core or one of: ${Object.keys(MARKET_AREAS).join(", ")}`);
  const dLat = (m.radiusM / EARTH_M) * (180 / Math.PI);
  const dLon = dLat / Math.cos((m.lat * Math.PI) / 180);
  return {
    key,
    box: { minLat: m.lat - dLat, maxLat: m.lat + dLat, minLon: m.lon - dLon, maxLon: m.lon + dLon },
    contains: (p) => metresBetween(m, p) <= m.radiusM,
  };
}

/** Overture basic categories kept as restaurants and cafés. Bars, stores and services are left out. */
export const OVERTURE_FOOD_CATEGORIES = ["restaurant", "casual_eatery", "fast_food_restaurant", "cafe", "coffee_shop", "smoothie_juice_bar", "food_truck_stand", "food_court"];

/** Thresholds (docs/31 section 6). A run that breaks a run-level threshold writes nothing. */
export const THRESHOLDS = {
  overtureMinConfidence: 0.5, // below: not imported
  overtureReviewBelow: 0.77, // between the two: imported, candidate marked needs_review
  minRows: { overture_places: 3000, boston_food_licenses: 2500, cambridge_food_permits: 400 },
  cambridgePermitMaxAgeDays: 550, // a permit issued in the last ~18 months counts as current
  maxCountChange: 0.3, // vs the previous completed run of the same source
  minCoordinateShare: 0.95,
  autoLinkScore: 0.85,
  autoLinkMaxMetres: 80,
  autoLinkMinName: 0.75,
  reviewLinkScore: 0.6,
  sameNameMinName: 0.95,
  sameNameMaxMetres: 50,
  addressTwinMetres: 50,
  searchMetres: 150,
  sameSourceDuplicateMetres: 25,
};

const STREET_WORDS = [[/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\bboulevard\b/g, "blvd"], [/\broad\b/g, "rd"], [/\bplace\b/g, "pl"], [/\bsquare\b/g, "sq"], [/\bplaza\b/g, "plz"], [/\bdrive\b/g, "dr"], [/\bhighway\b/g, "hwy"], [/\bwharf\b/g, "whf"], [/\bjohn f\.? kennedy\b/g, "jfk"], [/\bmassachusetts\b/g, "mass"]];
const LEGAL = /\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|dba|d\/b\/a)\b\.?/g;
const GENERIC = new Set(["the", "and", "of", "restaurant", "restaurants", "cafe", "café", "bar", "grill", "kitchen", "boston", "cambridge", "eatery", "co", "house", "bistro", "express"]);

export const fold = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Name tokens used for matching: folded, "&" → "and", legal suffixes and generic words removed. */
export function nameTokens(name) {
  const s = fold(name).replace(/&/g, " and ").replace(/['’`]/g, "").replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const all = s.split(/\s+/).filter(Boolean);
  const sig = all.filter((t) => !GENERIC.has(t));
  return sig.length ? sig : all;
}

/** 0–1: how alike two names are. A name wholly contained in the other scores 0.9. */
export function nameSimilarity(a, b) {
  const x = new Set(nameTokens(a));
  const y = new Set(nameTokens(b));
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((t) => y.has(t)).length;
  const jaccard = inter / (x.size + y.size - inter);
  const contained = inter === Math.min(x.size, y.size) ? 0.9 : 0;
  return Math.max(jaccard, contained);
}

export function normalizeStreet(street) {
  let s = fold(street).replace(/[.,#]/g, " ");
  for (const [re, to] of STREET_WORDS) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

/** The house number at the start of a street address ("100-104 Main St" → "100"), or null. */
export const houseNumber = (street) => normalizeStreet(street).match(/^(\d+)[a-z]?\b/)?.[1] ?? null;

export function metres(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * How likely two records describe the same physical place, 0–1, with the parts that decided it.
 * Name carries most weight; the house number and distance confirm. Far apart is never a match.
 */
export function matchScore(a, b) {
  const d = metres(a, b);
  const name = nameSimilarity(a.name, b.name);
  const ha = houseNumber(a.street);
  const hb = houseNumber(b.street);
  const number = ha && hb ? (ha === hb ? 1 : 0) : 0.5;
  const near = d <= 30 ? 1 : d <= 80 ? 0.6 : d <= THRESHOLDS.searchMetres ? 0.2 : 0;
  const score = d > THRESHOLDS.searchMetres ? 0 : 0.6 * name + 0.25 * number + 0.15 * near;
  return { score: Math.round(score * 1000) / 1000, metres: Math.round(d), name: Math.round(name * 1000) / 1000, sameNumber: number === 1 };
}

/**
 * Strict automatic link. Either (a) very alike, close and the same house number, or (b) the same name
 * within 50 m when the name is not a chain's (city licences often give the parcel's address, so the
 * house number differs from the restaurant's own). Anything weaker goes to a person.
 */
export const isAutoLink = (m, { chain = false } = {}) =>
  (m.score >= THRESHOLDS.autoLinkScore && m.metres <= THRESHOLDS.autoLinkMaxMetres && m.name >= THRESHOLDS.autoLinkMinName && m.sameNumber) ||
  (!chain && m.name >= THRESHOLDS.sameNameMinName && m.metres <= THRESHOLDS.sameNameMaxMetres);

/**
 * Chain names: a name seen in 3 or more separate areas (cells about 500 m across) of one source.
 * A chain is never linked on name and distance alone. Counting areas, not records, keeps a single
 * café listed twice by one source from looking like a chain.
 */
export function chainNames(records) {
  const cells = new Map();
  for (const r of records) {
    const k = `${r.source_key}|${nameTokens(r.name).join(" ")}`;
    if (!cells.has(k)) cells.set(k, new Set());
    cells.get(k).add(`${Math.floor(r.lat / 0.005)}:${Math.floor(r.lon / 0.006)}`);
  }
  return new Set([...cells].filter(([, v]) => v.size >= 3).map(([k]) => k.split("|")[1]));
}

const zip = (z) => (String(z ?? "").match(/^(\d{5})/)?.[1] ?? null);
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const slug = (s) => nameTokens(s).join("-").slice(0, 80) || "unnamed";
const cleanUrl = (u) => (/^https?:\/\/[^\s]+$/.test(u ?? "") && u.length <= 500 ? u : null);

/** A stable fingerprint of the fields we keep, so a later run can tell "changed" from "unchanged". */
export function recordHash(r) {
  const keep = ["name", "street", "locality", "postcode", "lat", "lon", "category", "status_hint", "confidence", "website", "record_licence"];
  return createHash("sha256").update(JSON.stringify(keep.map((k) => r[k] ?? null))).digest("hex");
}

/**
 * Overture rows (from scripts/catalog/overture-extract.py) → records. Returns {records, skipped}
 * where skipped counts each reason. Permanently closed, out-of-area, non-food and very low
 * confidence rows are not imported.
 */
export function parseOverture(rows, { area = areaFor() } = {}) {
  const inArea = area.contains;
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const records = [];
  for (const row of rows) {
    const lat = num(row.lat);
    const lon = num(row.lon);
    const confidence = num(row.confidence);
    if (!OVERTURE_FOOD_CATEGORIES.includes(row.category)) { skip("not_food_category"); continue; }
    if (row.operating_status === "permanently_closed" || row.operating_status === "temporarily_closed") { skip("closed"); continue; }
    if (!row.name?.trim()) { skip("no_name"); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skip("no_coordinates"); continue; }
    if (!inArea({ lat, lon })) { skip("outside_area"); continue; }
    if (!(confidence >= THRESHOLDS.overtureMinConfidence)) { skip("low_confidence"); continue; }
    const r = {
      source_key: "overture_places",
      external_id: row.id,
      name: row.name.trim().slice(0, 300),
      street: row.street?.trim() || null,
      locality: row.locality?.trim() || null,
      postcode: zip(row.postcode),
      lat, lon,
      category: row.category,
      status_hint: row.operating_status === "open" ? "open" : "unknown",
      confidence: Math.round(confidence * 1000) / 1000,
      website: cleanUrl(row.website),
      record_licence: row.licences || "CDLA-Permissive-2.0",
    };
    records.push({ ...r, record_hash: recordHash(r) });
  }
  return { records, skipped };
}

/**
 * City of Boston active food licences → records. The licence file has one row per licence (a café
 * with both "Eating & Drinking" and "Take Out" licences has two): those become one record. The phone
 * column is never read. Names stay as the City prints them (business or "doing business as").
 */
export function parseBostonLicenses(rows, { area = areaFor() } = {}) {
  const inArea = area.contains;
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const byId = new Map();
  for (const row of rows) {
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    const name = (row.dbaname?.trim() || row.businessname?.trim() || "").slice(0, 300);
    if (fold(row.licstatus) !== "active") { skip("not_active"); continue; }
    if (!name) { skip("no_name"); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) { skip("no_coordinates"); continue; }
    if (!inArea({ lat, lon })) { skip("outside_area"); continue; }
    const external_id = `${row.property_id || normalizeStreet(row.address)}:${slug(name)}`;
    if (byId.has(external_id)) { skip("second_licence_same_place"); continue; }
    const r = {
      source_key: "boston_food_licenses",
      external_id,
      name,
      street: row.address?.trim() || null,
      locality: row.city?.trim() ? row.city.trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()) : null,
      postcode: zip(row.zip),
      lat, lon,
      category: fold(row.descript) || null,
      status_hint: "licensed_active",
      confidence: null,
      website: null,
      record_licence: "ODC-PDDL-1.0",
    };
    byId.set(external_id, { ...r, record_hash: recordHash(r) });
  }
  return { records: [...byId.values()], skipped };
}

/**
 * City of Cambridge food establishment permits → records. Only identity columns are read (the file's
 * applicant name and inspection-style fields are never imported). Permits are renewed yearly, so
 * only the latest permit per business and address, issued within ~18 months of `asOf`, is kept.
 * Permits also cover shops and caterers, so these records corroborate a place; they never start a
 * candidate on their own (LINK_ONLY_SOURCES).
 */
export function parseCambridgePermits(rows, asOf = new Date(), { area = areaFor() } = {}) {
  const inArea = area.contains;
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const byId = new Map();
  const cutoff = asOf.getTime() - THRESHOLDS.cambridgePermitMaxAgeDays * 86400000;
  for (const row of rows) {
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    const name = (row.dba?.trim() || row.business_name?.trim() || "").slice(0, 300);
    const issued = Date.parse(row.issue_date);
    if (!name) { skip("no_name"); continue; }
    if (!Number.isFinite(issued) || issued < cutoff) { skip("permit_not_current"); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) { skip("no_coordinates"); continue; }
    if (!inArea({ lat, lon })) { skip("outside_area"); continue; }
    const [street, , rest] = String(row.full_address ?? "").split(",").map((x) => x.trim());
    const external_id = `${normalizeStreet(street)}:${slug(name)}`;
    const prev = byId.get(external_id);
    if (prev && prev.issued >= issued) { skip("older_permit_same_place"); continue; }
    if (prev) skip("older_permit_same_place");
    const r = {
      source_key: "cambridge_food_permits",
      external_id,
      name,
      street: street || null,
      locality: "Cambridge",
      postcode: zip(String(rest ?? "").replace(/^MA\s*/, "")) ?? zip(String(row.full_address).match(/(\d{5})\s*$/)?.[1]),
      lat, lon,
      category: null,
      status_hint: "licensed_active",
      confidence: null,
      website: null,
      record_licence: "ODC-PDDL-1.0",
    };
    byId.set(external_id, { ...r, record_hash: recordHash(r), issued });
  }
  return { records: [...byId.values()].map((r) => { const out = { ...r }; delete out.issued; return out; }), skipped };
}

/** Sources whose records only corroborate an existing candidate and never start one. */
export const LINK_ONLY_SOURCES = new Set(["cambridge_food_permits"]);

/**
 * Run-level checks. Returns null when the run may be written, or the plain reason it is refused.
 * `previousCount` is the record count of the previous completed run of the same source, if any.
 */
export function runRefusal(sourceKey, records, inputRows, previousCount, minRows) {
  const min = minRows ?? THRESHOLDS.minRows[sourceKey] ?? 1;
  if (records.length < min) return `Only ${records.length} usable records (at least ${min} expected); the file may be incomplete.`;
  if (inputRows > 0 && records.length / inputRows < 0.05) return "Almost every row was skipped; the file format may have changed.";
  if (previousCount && Math.abs(records.length - previousCount) / previousCount > THRESHOLDS.maxCountChange) {
    return `Record count changed from ${previousCount} to ${records.length} (more than ${THRESHOLDS.maxCountChange * 100}%); check the release before importing.`;
  }
  if (records.some((r) => !r.record_licence)) return "A record has no licence.";
  return null;
}

/** A coarse grid (about 110 m × 80 m cells) so matching only compares nearby records. */
function grid(items) {
  const cell = (p) => `${Math.floor(p.lat / 0.001)}:${Math.floor(p.lon / 0.001)}`;
  const map = new Map();
  for (const it of items) {
    const k = cell(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  const near = (p) => {
    const [a, b] = cell(p).split(":").map(Number);
    const out = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) out.push(...(map.get(`${a + i}:${b + j}`) ?? []));
    return out;
  };
  return { near, add: (it) => { const k = cell(it); if (!map.has(k)) map.set(k, []); map.get(k).push(it); } };
}

/**
 * Builds or extends place candidates from records. `existing` candidates (with their linked records)
 * are kept as they are; new records are linked to a candidate only by a strict automatic match,
 * otherwise they start a new candidate. A borderline match is never linked: both candidates get a
 * `possible_duplicate` flag for a person to decide. Returns {candidates, links, stats}.
 */
export function buildCandidates(records, existing = []) {
  const cands = existing.map((c) => ({ ...c, records: [...c.records], flags: [...(c.flags ?? [])] }));
  const index = grid([]);
  for (const c of cands) index.add(c);
  const links = [];
  const stats = { auto_linked: 0, new_candidates: 0, possible_duplicates: 0, same_source_duplicates: 0, unmatched_link_only: 0 };
  // Seed order: Overture first (it has categories and websites), then the City licences.
  const rank = (k) => (k === "overture_places" ? 0 : LINK_ONLY_SOURCES.has(k) ? 2 : 1);
  // Ties broken by record id, so the same files always give the same candidates whatever order the
  // database returns them in.
  const order = [...records].sort((a, b) => rank(a.source_key) - rank(b.source_key) || String(a.external_id).localeCompare(String(b.external_id)));
  // Chains are judged on every record, already linked or not: judged on the new records alone, a later run would
  // stop treating a chain as a chain and link more loosely than the first run did (24 Nov six-city rehearsal).
  const chains = chainNames([...records, ...cands.flatMap((c) => c.records)]);
  for (const r of order) {
    let best = null;
    for (const c of index.near(r)) {
      for (const other of c.records) {
        const m = matchScore(r, other);
        const sameSourceDup = other.source_key === r.source_key && m.metres <= THRESHOLDS.sameSourceDuplicateMetres && m.name >= 0.95;
        // Equal scores are settled the same way every run (a candidate that can take this record first, then
        // the lower record id), so a second run never links what the first run left (24 Nov rehearsal).
        const open = sameSourceDup || !c.records.some((x) => x.source_key === r.source_key);
        const key = `${open ? 0 : 1}:${other.source_key}:${other.external_id}`;
        if (!best || m.score > best.m.score || (m.score === best.m.score && key < best.key)) best = { c, m, sameSourceDup, key };
      }
    }
    const chain = chains.has(nameTokens(r.name).join(" "));
    if (best && (isAutoLink(best.m, { chain }) || best.sameSourceDup) && (best.sameSourceDup || !best.c.records.some((x) => x.source_key === r.source_key))) {
      best.c.records.push(r);
      links.push({ candidate: best.c, record: r, score: best.m.score, method: "auto_strict" });
      if (best.sameSourceDup) stats.same_source_duplicates++; else stats.auto_linked++;
      continue;
    }
    if (LINK_ONLY_SOURCES.has(r.source_key)) { stats.unmatched_link_only++; continue; }
    const c = { name: r.name, street: r.street, postcode: r.postcode, lat: r.lat, lon: r.lon, category: r.source_key === "overture_places" ? r.category : null, records: [r], flags: [] };
    // A different name at the same house number close by is usually another business in the same
    // building (checked on the 17 Nov files: food halls, hotels, airports), sometimes a replaced one.
    // It is noted, not treated as a duplicate.
    const addressTwin = best && best.m.sameNumber && best.m.metres <= THRESHOLDS.addressTwinMetres && best.m.score < THRESHOLDS.reviewLinkScore;
    if (addressTwin) c.flags.push("shared_address");
    // Borderline: alike enough to doubt. Never linked; a person decides.
    if (best && best.m.score >= THRESHOLDS.reviewLinkScore) {
      c.flags.push("possible_duplicate");
      if (!best.c.flags.includes("possible_duplicate")) best.c.flags.push("possible_duplicate");
      stats.possible_duplicates++;
    }
    cands.push(c);
    index.add(c);
    links.push({ candidate: c, record: r, score: 1, method: "seed" });
    stats.new_candidates++;
  }
  for (const c of cands) c.quality = candidateQuality(c);
  return { candidates: cands, links, stats };
}

/** Quality of a candidate's identity evidence. Never "verified": that is the founder's step. */
export function candidateQuality(c) {
  if (c.quality === "rejected") return "rejected";
  const sources = new Set(c.records.map((r) => r.source_key));
  const flags = c.flags ?? [];
  // Two independent sources agreeing outweighs a nearby look-alike; the flag stays visible.
  if (sources.size >= 2) return "corroborated";
  if (flags.includes("possible_duplicate")) return "needs_review";
  // Judge by the most confident record, not the first one: the order records come back from the
  // database is not fixed, and a low-confidence same-place twin must not change the answer between runs.
  const r = [...c.records].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || String(a.external_id).localeCompare(String(b.external_id)))[0];
  if (r.source_key === "overture_places" && !(r.confidence >= THRESHOLDS.overtureReviewBelow)) return "needs_review";
  if (!r.street || !r.postcode) return "needs_review";
  return "single_source";
}

/** The owner's focus areas by ZIP code (a ZIP can straddle two neighbourhoods; counts are approximate). */
export const FOCUS_POSTCODES = {
  "Fenway / Kenmore / Longwood": ["02215"],
  "Back Bay / Prudential": ["02116", "02199"],
  "Fenway / Northeastern / Mission Hill": ["02115"],
  "South End": ["02118"],
  "Downtown / Financial District / Chinatown": ["02108", "02109", "02110", "02111"],
  "Cambridge (Central, Harvard, Kendall)": ["02138", "02139", "02142"],
};

/** Plain-language coverage summary for the founder (docs/31 section 5). */
export function coverageMarkdown(candidates, runs, generatedOn) {
  const by = (q) => candidates.filter((c) => c.quality === q).length;
  const lines = [`# Boston restaurant identity import: coverage (${generatedOn})`, ""];
  lines.push("Identity only (name, address, map position, category hint). Nothing here is verified or published, and nothing imported says what a place serves: dietary filters ignore every imported place. The real-data publication lock stays off.", "");
  lines.push("| Source run | Release | Usable records | Skipped |", "|---|---|---|---|");
  for (const r of runs) lines.push(`| ${r.source_key} | ${r.release} | ${r.records} | ${Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`);
  lines.push("", `**${candidates.length} place candidates:** ${by("corroborated")} corroborated by two independent public sources, ${by("single_source")} from one source with every check passed, ${by("needs_review")} needing a person (possible duplicate, low confidence or missing address).`, "");
  lines.push("| Focus area (by ZIP) | Candidates | Corroborated |", "|---|---|---|");
  for (const [area, zips] of Object.entries(FOCUS_POSTCODES)) {
    const inA = candidates.filter((c) => zips.includes(c.postcode));
    lines.push(`| ${area} (${zips.join(", ")}) | ${inA.length} | ${inA.filter((c) => c.quality === "corroborated").length} |`);
  }
  lines.push("");
  const loc = new Map();
  for (const c of candidates) {
    const k = c.records.find((r) => r.locality)?.locality ?? "Unknown";
    loc.set(k, (loc.get(k) ?? 0) + 1);
  }
  lines.push("| Locality | Candidates |", "|---|---|");
  for (const [k, v] of [...loc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  return lines.join("\n");
}

/** A small RFC 4180 CSV reader (quoted fields, doubled quotes, newlines inside quotes) → row objects. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const keys = (head ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}
