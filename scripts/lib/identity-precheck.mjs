// Automatic identity pre-check for one place in the founder's review (docs/51). Pure: it reads only the evidence
// snapshot that `catalog-preview.mjs build` already stores, fetches nothing and decides nothing.
//
// The result is "agree" (every automatic check found nothing worrying) or "look" (at least one did, with the reasons).
// "agree" is never a verification: the founder still records each decision, one place at a time.

/** @typedef {{ source?: string | null, sourceKey: string, name?: string | null, street?: string | null, category?: string | null, website?: string | null, openStatus?: string | null, present?: boolean | null }} PrecheckRecord */
/** @typedef {{ records?: PrecheckRecord[], recordsApartMetres?: number | null, lookalikes?: { name: string }[] }} PrecheckEvidence */
/** @typedef {{ ok: boolean, code: string, text: string }} PrecheckPoint */

export const PRECHECK_VERSION = 1;

const simple = (/** @type {unknown} */ s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Words that say nothing about which business it is: legal forms, "restaurant", "the" and similar. */
const FILLER = new Set(["the", "and", "of", "inc", "llc", "co", "corp", "company", "ltd", "restaurant", "restaurante", "ristorante", "cafe", "bar", "grill", "grille", "kitchen", "eatery", "boston", "cambridge"]);
const coreWords = (/** @type {unknown} */ name) =>
  simple(String(name ?? "").replace(/\s[-|–]\s.*$/, "").replace(/\(.*?\)/g, " "))
    .split(" ")
    .filter((w) => w && !FILLER.has(w));

/** True when one name's distinctive words all appear in the other ("Dunkin' Donuts" and "Dunkin'", "Genki Ya of Boston" and "Genki Ya"). */
export function namesAgree(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  const x = coreWords(a);
  const y = coreWords(b);
  if (!x.length || !y.length) return simple(a) === simple(b);
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  const joinedLong = [...long].join("");
  return short.every((w) => long.has(w) || joinedLong.includes(w));
}

const houseNumber = (/** @type {unknown} */ street) => simple(street).match(/^(\d+)[a-z]?\b/)?.[1] ?? null;

/** Websites that belong to an ordering, deals or map service rather than to the place itself. */
const THIRD_PARTY = ["groupon.", "toasttab.", "olo.com", "doordash.", "ubereats.", "grubhub.", "yelp.", "facebook.", "instagram.", "google.", "squareup.", "square.site", "clover.com", "menufy.", "slicelife."];
const hostOf = (/** @type {string} */ url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Names that suggest a shop rather than somewhere to eat; the founder decides. */
const SHOP_WORDS = /\b(market|grocery|supermarket|mart|liquors?|pharmacy|convenience|deli and grocery|food store)\b/;

const OPEN_WORDS = /** @type {Record<string, string>} */ ({ open: "says it is open", licensed_active: "lists an active licence or permit", unknown: "does not say it is open" });

/**
 * Every automatic check on one place, in plain sentences, and the overall result.
 * @param {PrecheckEvidence} evidence
 * @returns {{ level: "agree" | "look", points: PrecheckPoint[], version: number }}
 */
export function precheckIdentity(evidence) {
  const records = evidence?.records ?? [];
  const lookalikes = evidence?.lookalikes ?? [];
  /** @type {PrecheckPoint[]} */
  const points = [];
  const add = (/** @type {boolean} */ ok, /** @type {string} */ code, /** @type {string} */ text) => points.push({ ok, code, text });

  if (records.length >= 2) {
    const apart = evidence.recordsApartMetres ?? 0;
    add(apart <= 80, "distance", `The sources put it ${apart} m apart${apart <= 80 ? "" : " (more than 80 m)"}.`);
    const names = records.map((r) => r.name ?? "");
    const same = new Set(names.map(simple)).size === 1;
    const agree = names.every((n) => namesAgree(n, names[0]));
    add(agree, "name", same ? "Both sources use the same name." : agree ? `The names match apart from common words: ${names.map((n) => `“${n || "no name"}”`).join(" and ")}.` : `The names differ: ${names.map((n) => `“${n || "no name"}”`).join(" and ")}.`);
    const numbers = [...new Set(records.map((r) => houseNumber(r.street)).filter(Boolean))];
    if (numbers.length > 1) add(false, "house_number", `The house numbers differ: ${numbers.join(" and ")}.`);
    else if (numbers.length === 1) add(true, "house_number", `Both give house number ${numbers[0]}.`);
    else add(false, "house_number", "Neither source gives a house number.");
  } else {
    add(false, "single_source", "Only one public source has this place.");
  }

  for (const r of records) {
    const who = r.source ?? r.sourceKey;
    if (r.present === false) add(false, "dropped", `${who} no longer lists it in its latest release.`);
    if (r.openStatus) add(r.openStatus !== "unknown", "open_status", `${who} ${OPEN_WORDS[r.openStatus] ?? `says “${r.openStatus}”`}.`);
  }

  add(lookalikes.length === 0, "lookalikes", lookalikes.length === 0 ? "No similar name within 150 m." : `${lookalikes.length} similar ${lookalikes.length === 1 ? "name" : "names"} within 150 m (listed below).`);

  const shopName = records.find((r) => SHOP_WORDS.test(simple(r.name)));
  if (shopName) add(false, "shop_name", `“${shopName.name}” sounds like a shop: check that people can eat there.`);

  for (const r of records) {
    if (!r.website) continue;
    const host = hostOf(r.website);
    if (!host) continue;
    if (THIRD_PARTY.some((t) => host.includes(t))) add(false, "website", `The website on file is a page on ${host}, not the place's own site.`);
  }

  return { level: points.every((p) => p.ok) ? "agree" : "look", points, version: PRECHECK_VERSION };
}
