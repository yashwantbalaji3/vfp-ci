import Link from "next/link";
import { cuisineWords, IDENTITY_SHORT, type PlaceListing } from "@/contracts/places";
import { formatDistance } from "@/lib/format";
import { CuisineMark, cuisineFamily } from "./cuisine-mark";

/**
 * One real place in a list (docs/32, docs/36). Identity only, unless the founder has a private menu preview
 * for it: then it says so and links to the meals. It never shows a diet, dish or protein figure. What "Menu not
 * checked yet" means is said once above the list (PlaceListNote), not on every card (P2 part 2).
 */
export function PlaceCard({ p, menu = false }: { p: PlaceListing; menu?: boolean }) {
  const distance = formatDistance(p.distanceM);
  const cuisine = cuisineWords(p.cuisines);
  const primary = p.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine;
  return (
    <li className="post pcard" data-testid="place-listing" data-menu={menu ? "preview" : "not_checked"}>
      <CuisineMark family={cuisineFamily(primary, p.category)} />
      <div className="pcard-body">
        <div className="head">
          <h3 style={{ margin: 0, fontSize: 16, overflowWrap: "anywhere" }}>
            <Link href={`/places/${p.slug}`} data-testid="place-link">
              {p.name}
            </Link>
          </h3>
          {menu ? (
            <span className="badge ok sm" data-testid="menu-status">
              Menu: unverified preview
            </span>
          ) : (
            <span className="badge wait sm" data-testid="menu-status">
              Menu not checked yet
            </span>
          )}
        </div>
        <p className="s14" style={{ margin: "2px 0 0" }}>
          {p.category}
          {cuisine ? <span data-testid="place-cuisine"> · {cuisine}</span> : null}
          {p.area ? ` · ${p.area}` : p.locality ? ` · ${p.locality}` : ""}
          {distance ? <strong className="pcard-dist"> · {distance}</strong> : null}
        </p>
        <p className="s13 muted" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
          {p.street}, {p.locality ? `${p.locality} ` : ""}
          {p.postcode}
          <span data-testid="identity-status"> · {IDENTITY_SHORT[p.identityBasis]}.</span>
        </p>
        {p.reported && (
          <p className="s14" style={{ margin: "4px 0 0" }} data-testid="place-reported">
            Someone reported a problem with this listing. We are checking it.
          </p>
        )}
      </div>
    </li>
  );
}

/** Said once above a list of places: what "Menu not checked yet" means for diets and protein. */
export function PlaceListNote() {
  return (
    <p className="s14 muted" style={{ margin: "8px 0 0" }} data-testid="places-menu-note">
      &ldquo;Menu not checked yet&rdquo; means we haven&rsquo;t read what the place serves, so it is not called vegetarian or vegan and is not in any diet or protein filter. Pictures are drawings of a kind of food, not photos of the place.
    </p>
  );
}
