import type { Basis, ProteinFacts } from "@/contracts/catalog";

/** Display helpers. A missing value is always worded; it is never shown as 0. */
export function formatAmount(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * An amount in words. An exact figure is shown as it is; an estimate is never shown as a measurement:
 * "about 28 g (estimate 24–32 g)", or "about 28 g (estimate)" when its range is not at hand.
 */
export function amountText(value: number, unit: string, method: string | null | undefined, low?: number | null, high?: number | null): string {
  if (method !== "estimated") return `${formatAmount(value)} ${unit}`;
  const range = low !== null && low !== undefined && high !== null && high !== undefined ? ` (estimate ${formatAmount(low)}–${formatAmount(high)} ${unit})` : " (estimate)";
  return `about ${formatAmount(value)} ${unit}${range}`;
}

export const METHOD_LABELS: Record<string, string> = {
  published: "Published",
  calculated: "Calculated",
  estimated: "Estimated",
  user_entered: "Entered by you",
};
export const methodLabel = (method: string | null | undefined) => (method ? (METHOD_LABELS[method] ?? "Not provided") : "Not provided");

export const REASON_TEXT: Record<string, string> = {
  not_provided: "Protein not provided",
  estimate_hidden: "Estimate hidden",
  serving_weight_unknown: "Serving weight not provided",
  energy_not_provided: "Energy not provided",
  volume_basis: "Measured by volume, not weight",
};
export const reasonText = (reason: string | null | undefined) => (reason ? (REASON_TEXT[reason] ?? "Not available") : "Not available");

export type ProteinView = { value: number | null; reason: string | null; per: string };

/** The protein figure for a chosen basis, with the words that say what it is measured against. */
export function proteinFor(p: ProteinFacts, basis: Basis): ProteinView {
  if (basis === "100g") return { value: p.per100g, reason: p.per100gReason, per: "per 100 g" };
  if (basis === "100kcal") return { value: p.per100kcal, reason: p.per100kcalReason, per: "per 100 kcal" };
  return { value: p.perServing, reason: p.perServingReason, per: p.servingLabel ? `per ${p.servingLabel.replace(/^1 /, "")}` : "per serving" };
}

/**
 * An estimate's range for the chosen basis, scaled by the same factor as the value. Null for an
 * exact or unknown figure, or when the range is not on file.
 */
export function proteinRangeFor(p: ProteinFacts, basis: Basis): { low: number; high: number } | null {
  const v = proteinFor(p, basis).value;
  if (p.method !== "estimated" || v === null || !p.basisValue) return null;
  if (p.estimateLow === null || p.estimateLow === undefined || p.estimateHigh === null || p.estimateHigh === undefined) return null;
  const k = v / p.basisValue;
  return { low: p.estimateLow * k, high: p.estimateHigh * k };
}

export const priceBand = (band: number | null | undefined) => (band ? "$".repeat(band) : null);

export function formatDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined) return null;
  const miles = meters / 1609.344;
  return miles < 0.1 ? "Under 0.1 mi" : `${miles.toFixed(1)} mi`;
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" });
}

export function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

export const KIND_LABELS: Record<string, string> = { dish: "Restaurant dish", recipe: "Recipe", packaged: "Packaged food", ingredient: "Ingredient" };
export const titleCase = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Only same-site relative paths are accepted as "return to" targets (no open redirects). Browsers and the URL parser
 * drop tabs and newlines, so "/\t/evil.example" would become "//evil.example": any control character, a backslash or
 * a second leading slash is refused, and the path must still resolve to this site.
 */
export function safeReturnPath(next: string | null | undefined, fallback = "/discover"): string {
  if (!next || next.length > 500 || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  const base = "http://same-site.invalid";
  let resolved: URL;
  try {
    resolved = new URL(next, base);
  } catch {
    return fallback;
  }
  return resolved.origin === base ? next : fallback;
}

/** A stored local date ("2026-11-14") in words. The date is never shifted through a timezone. */
export function formatDay(isoDate: string, style: "long" | "short" = "long"): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(
    "en-US",
    style === "long" ? { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" } : { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" },
  );
}
