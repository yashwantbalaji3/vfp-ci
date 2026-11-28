import { z } from "zod";
import { BASES, KINDS, VIEWS, searchFiltersSchema, type SearchFilters } from "@/contracts/catalog";

/**
 * Page addresses carry the non-dietary filters so a search can be reloaded,
 * shared or reached with the Back button. A value that is not valid is ignored
 * rather than trusted (it never reaches the database).
 */
export type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const opt = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined => {
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
};
const UUID = z.uuid();
export const PAGE_SIZE = 12;

export function parseDiscoverParams(sp: RawParams): SearchFilters {
  const q = first(sp.q)?.trim().slice(0, 120) || undefined;
  return searchFiltersSchema.parse({
    q,
    view: opt(z.enum(VIEWS), first(sp.view)) ?? "matches",
    kinds: ["dish"],
    neighborhood: opt(z.string().trim().min(1).max(80), first(sp.hood)),
    cuisine: opt(z.string().trim().min(1).max(40), first(sp.cuisine)),
    maxPriceBand: opt(z.coerce.number().int().min(1).max(4), first(sp.price) || undefined),
    venueType: opt(searchFiltersSchema.shape.venueType, first(sp.type) || undefined),
    minProtein: opt(z.coerce.number().min(1).max(200), first(sp.protein) || undefined),
    includeEstimates: first(sp.est) === "1",
    openNow: first(sp.open) === "1",
    limit: PAGE_SIZE,
    offset: opt(z.coerce.number().int().min(0).max(5000), first(sp.offset) || undefined) ?? 0,
  });
}

export const PROTEIN_KIND_TABS = [
  { key: "all", label: "All" },
  { key: "dish", label: "Dishes" },
  { key: "recipe", label: "Recipes" },
  { key: "packaged", label: "Packaged" },
  { key: "ingredient", label: "Ingredients" },
] as const;

export type ProteinParams = { filters: SearchFilters; kind: "all" | (typeof KINDS)[number]; compare: string[]; perDollar: boolean };

export function parseProteinParams(sp: RawParams): ProteinParams {
  const kind = opt(z.enum(KINDS), first(sp.kind)) ?? "all";
  const compare = [...new Set((first(sp.compare) ?? "").split(",").filter((id) => UUID.safeParse(id).success))].slice(0, 3);
  // "Per dollar" ranks dishes only (only dishes have prices), by protein per serving, never by an estimate.
  const perDollar = first(sp.rank) === "dollar";
  const filters = searchFiltersSchema.parse({
    q: first(sp.q)?.trim().slice(0, 120) || undefined,
    view: opt(z.enum(VIEWS), first(sp.view)) ?? "matches",
    // "All" means things you can order, cook or buy ready. Raw ingredients (now a long pantry list) have their own tab.
    kinds: perDollar ? ["dish"] : kind === "all" ? ["dish", "recipe", "packaged"] : [kind],
    basis: perDollar ? "serving" : (opt(z.enum(BASES), first(sp.basis)) ?? "serving"),
    includeEstimates: first(sp.est) === "1",
    sort: perDollar ? "protein_per_dollar" : "protein",
    limit: 50,
    offset: 0,
  });
  return { filters, kind: perDollar ? "dish" : kind, compare, perDollar };
}

/** Build an address from the current parameters with some changed; empty values are dropped. */
export function hrefWith(path: string, current: RawParams, changes: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const value = first(v);
    if (value) params.set(k, value);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Add or remove one food in the compare list (never more than three). */
export function toggleCompare(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((c) => c !== id);
  return current.length >= 3 ? current : [...current, id];
}
