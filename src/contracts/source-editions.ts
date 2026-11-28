// Menus that state their own edition date (owner decision 28 Nov 2026 02:27 UTC, decision 4).
//
// A menu we read recently can still be an old edition: Pho Pasteur's own PDF is "Boston Full Menu-2024-September".
// Its prices stay in staging as historical source evidence, unchanged, but they are never shown as a current price.
// A current price appears again only when a more recent reliable source supplies one.
//
// Kept in version control (reviewed like a migration) so the cloud copy and the Mac read the same list.

export type SourceEdition = {
  /** The exact source URL as recorded in staging.source_pages. */
  url: string;
  /** First day of the month the document states as its edition. */
  statedOn: string;
  /** Words for people: "September 2024". */
  label: string;
  /** Where the date comes from. */
  basis: string;
};

export const SOURCE_EDITIONS: readonly SourceEdition[] = [
  {
    url: "https://phopasteurboston.net/Boston%20Full%20Menu-2024-September.pdf",
    statedOn: "2024-09-01",
    label: "September 2024",
    basis: "the restaurant's own file name (Boston Full Menu-2024-September)",
  },
];

/** A price from a menu edition older than this is historical. */
export const CURRENT_PRICE_MAX_AGE_DAYS = 365;

export const editionOf = (url: string | null | undefined): SourceEdition | null =>
  (url && SOURCE_EDITIONS.find((e) => e.url === url)) || null;

/** True when the source states an edition older than CURRENT_PRICE_MAX_AGE_DAYS. */
export function isHistoricalEdition(url: string | null | undefined, now = Date.now()): boolean {
  const e = editionOf(url);
  if (!e) return false;
  return (now - Date.parse(`${e.statedOn}T00:00:00Z`)) / 86_400_000 > CURRENT_PRICE_MAX_AGE_DAYS;
}
