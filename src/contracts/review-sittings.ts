/**
 * Founder review sittings (Boston charter 28 Nov 2026 00:32 UTC, section 7): the proposed meals split into short
 * sittings, each keeping to one or two restaurants so the founder compares against one or two saved menus at a time.
 * Branches of one restaurant ("Cafe Landwer (653 Boylston St)" and "Cafe Landwer (383 Chestnut Hill Ave)") share a
 * sitting, since their menus usually print the same words. Pure: the page supplies the meals and the progress.
 *
 * Grouping only orders the work. Every fact is still decided one by one by the founder; nothing is approved for a
 * group, a branch or a sitting.
 */

/** The restaurant a branch belongs to: the name without its "(street)" suffix. */
export const brandOf = (placeName: string): string => placeName.replace(/\s*\([^)]*\)\s*$/, "").trim();

export type SittingItem = { dishId: string; placeName: string };
export type Sitting = { n: number; brands: { brand: string; meals: number }[]; dishIds: string[] };

/** First-fit by size: the largest restaurant first, at most `maxBrands` restaurants and `maxMeals` meals a sitting. */
export function planSittings(items: SittingItem[], { maxMeals = 12, maxBrands = 2 } = {}): Sitting[] {
  const byBrand = new Map<string, string[]>();
  for (const it of items) {
    const b = brandOf(it.placeName);
    byBrand.set(b, [...(byBrand.get(b) ?? []), it.dishId]);
  }
  const groups = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out: Sitting[] = [];
  for (const [brand, ids] of groups) {
    const fit = out.find((s) => s.brands.length < maxBrands && s.dishIds.length + ids.length <= maxMeals);
    if (fit) {
      fit.brands.push({ brand, meals: ids.length });
      fit.dishIds.push(...ids);
    } else out.push({ n: out.length + 1, brands: [{ brand, meals: ids.length }], dishIds: [...ids] });
  }
  return out;
}
