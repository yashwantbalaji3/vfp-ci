/**
 * Restaurant variety in meal lists (owner direction 20 Nov 2026 21:20 UTC, item 1; docs/64).
 *
 * One restaurant with many strong meals (Next Level Veggie Grill has 41) used to fill every top position. A list
 * now shows each restaurant's strongest one or two meals first, in the list's own order, so the person sees what
 * several restaurants offer before scrolling. Nothing is dropped: the rest of each restaurant's matching meals are
 * counted and one tap away ("12 more from Veggie Grill"), and "Show every meal" turns the rule off.
 *
 * Pure and order-preserving: it never re-ranks, so diet fit and protein relevance (or whatever sort the person
 * picked) still decide which meals come first. It runs after the diet check, so it can only hold meals back,
 * never add one that doesn't fit.
 */

export const PER_PLACE = 2;

export type HeldBack = { key: string; name: string; slug: string; count: number; best: number | null };
export type Spread<T> = { shown: T[]; held: HeldBack[]; total: number; spread: boolean };

type Place = { slug: string; name: string };

/**
 * @param rows already filtered and sorted, best first
 * @param opts.perPlace how many of one restaurant's meals show before the rest wait behind "more" (default 2)
 * @param opts.expand restaurants (by slug) whose every matching meal shows, or "all" to turn the rule off
 * @param opts.protein the figure that a held-back group's strongest meal is described by, if any
 */
export function spreadByPlace<T extends { place: Place }>(rows: T[], opts: { perPlace?: number; expand?: ReadonlySet<string> | "all"; protein?: (r: T) => number | null } = {}): Spread<T> {
  const per = Math.max(1, opts.perPlace ?? PER_PLACE);
  const expand = opts.expand ?? new Set<string>();
  const places = new Set(rows.map((r) => r.place.slug));
  // With one restaurant (a restaurant filter, or a search only one menu answers) there is nothing to spread.
  if (expand === "all" || places.size <= 1) return { shown: rows, held: [], total: rows.length, spread: false };
  const seen = new Map<string, number>();
  const held = new Map<string, HeldBack>();
  const shown: T[] = [];
  for (const r of rows) {
    const k = r.place.slug;
    const n = seen.get(k) ?? 0;
    if (n < per || expand.has(k)) {
      shown.push(r);
      seen.set(k, n + 1);
      continue;
    }
    const h = held.get(k) ?? { key: k, name: r.place.name, slug: k, count: 0, best: null };
    h.count += 1;
    const p = opts.protein?.(r) ?? null;
    if (p !== null && (h.best === null || p > h.best)) h.best = p;
    held.set(k, h);
  }
  return { shown, held: [...held.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), total: rows.length, spread: held.size > 0 };
}

/** The "more" restaurants named in an address (`more=slug,slug` or `more=all`), at most 12. */
export function readExpand(raw: string | string[] | undefined): ReadonlySet<string> | "all" {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "all") return "all";
  return new Set((v ?? "").split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9-]{1,80}$/.test(s)).slice(0, 12));
}

/** The address value with one more restaurant expanded. */
export function withExpanded(current: ReadonlySet<string> | "all", slug: string): string {
  if (current === "all") return "all";
  return [...new Set([...current, slug])].join(",");
}
