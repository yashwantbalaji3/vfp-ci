// The Boston-area neighbourhood of a listing, from its own address (owner directive 27 Nov 2026, Boston first).
// The database decides with app.boston_area() (migration 20261127000100); this is the same table for scripts that
// need the answer before a row exists. tests/db/boston-neighbourhoods.test.ts keeps the two in step.
// An area is an address-based browsing shortcut (postcodes follow neighbourhood lines only roughly), never a claim
// about the place.

/** Postcode → area, in the order the database checks them (02215 and 02115 are split by longitude first). @type {[string, string[]][]} */
export const BOSTON_AREA_POSTCODES = [
  ["Back Bay / Prudential", ["02116", "02199"]],
  ["South End", ["02118"]],
  ["Downtown / Financial District / Chinatown", ["02108", "02109", "02110", "02111", "02201", "02203", "02205"]],
  ["Cambridge (Central, Harvard, Kendall)", ["02138", "02139", "02142"]],
  ["Cambridge (Porter, Inman, East Cambridge)", ["02140", "02141"]],
  ["Allston / Brighton", ["02134", "02135", "02163"]],
  ["Brookline", ["02445", "02446", "02447"]],
  ["North End", ["02113"]],
  ["Beacon Hill / West End", ["02114"]],
  ["South Boston / Seaport", ["02127", "02210"]],
  ["East Boston", ["02128"]],
  ["Charlestown", ["02129"]],
  ["Jamaica Plain", ["02130"]],
  ["Mission Hill / Longwood", ["02120"]],
  ["Roxbury", ["02119"]],
  ["Dorchester", ["02121", "02122", "02124", "02125"]],
  ["Mattapan", ["02126"]],
  ["Roslindale", ["02131"]],
  ["West Roxbury", ["02132"]],
  ["Hyde Park", ["02136"]],
  ["Somerville", ["02143", "02144", "02145"]],
];
/** West of St. Paul Street (about 71.112° W), postcode 02215 is Allston rather than Kenmore. */
export const ALLSTON_02215_WEST_OF = -71.112;
/** West of about 71.098° W, postcode 02115 is the Longwood Medical Area rather than the Fens and Northeastern. */
export const LONGWOOD_02115_WEST_OF = -71.098;

/** @param {string} s */
const initcap = (s) => s.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/**
 * @param {string | null | undefined} postcode
 * @param {string | null | undefined} [locality]
 * @param {number | null | undefined} [lon]
 * @returns {string | null}
 */
export function bostonArea(postcode, locality = null, lon = null) {
  if (postcode === "02215") return typeof lon === "number" && lon < ALLSTON_02215_WEST_OF ? "Allston / Brighton" : "Fenway / Kenmore";
  if (postcode === "02115") return typeof lon === "number" && lon < LONGWOOD_02115_WEST_OF ? "Mission Hill / Longwood" : "Fenway / Northeastern";
  for (const [area, zips] of BOSTON_AREA_POSTCODES) if (zips.includes(postcode)) return area;
  const town = (locality ?? "").trim();
  const low = town.toLowerCase();
  if (low.startsWith("newton")) return "Newton";
  if (low === "brookline") return "Brookline";
  if (low === "allston" || low === "brighton") return "Allston / Brighton";
  if (town && low !== "boston") return initcap(town);
  return null;
}
