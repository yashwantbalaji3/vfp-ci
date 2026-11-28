import Link from "next/link";
import { mealListAction } from "@/app/protein/meals/actions";
import { FLAGS } from "@/config/flags";
import { getListMeals, getPreviewMealIndex } from "@/server/catalog/menu-preview";
import { ProteinTile, price } from "./menu-preview";

/**
 * Real meals the founder put on one of their own lists (docs/60). They are drafts in the private preview, so
 * only the list's owner ever sees them, even on a list they published. For anyone else this renders nothing.
 */
export async function ListMeals({ listId, returnTo, manage = false }: { listId: string; returnTo: string; manage?: boolean }) {
  if (!FLAGS.realCatalogPreview) return null;
  const entries = await getListMeals(listId);
  if (!entries.length) return null;
  const index = await getPreviewMealIndex().catch(() => null);
  if (!index) return null;
  const rows = entries.flatMap((e) => (index.has(e.dishId) ? [{ ...e, ...index.get(e.dishId)! }] : []));
  if (!rows.length) return null;
  return (
    <section aria-labelledby="list-meals-h" data-testid="list-meals" style={{ marginTop: 16 }}>
      <h2 className="h-sec" id="list-meals-h">
        Real meals ({rows.length})
      </h2>
      <p className="preview-bar" role="note">
        <span>
          <span className="pill">Unverified preview</span> Only you see these entries, even if this list is published.
        </span>
      </p>
      <ul className="mine-list">
        {rows.map((r) => {
          const label = r.meal?.label ?? r.builder!.label;
          return (
            <li key={r.dishId} data-testid="list-meal">
              <div style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                {r.meal && <ProteinTile m={r.meal} />}
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <Link href={`/meals/${r.dishId}?from=${encodeURIComponent(returnTo)}`}>
                    <strong>{label}</strong>
                  </Link>
                  <span className="s14 muted">
                    {r.place.name}
                    {r.meal?.priceUsd ? ` · ${price(r.meal.priceUsd)}` : ""}
                  </span>
                </span>
              </div>
              {manage && (
                <form action={mealListAction}>
                  <input type="hidden" name="dishId" value={r.dishId} />
                  <input type="hidden" name="listId" value={listId} />
                  <input type="hidden" name="op" value="remove" />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button className="btn small" type="submit">
                    Remove<span className="sr-only"> {label}</span>
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
