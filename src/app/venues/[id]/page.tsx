import { Suspense } from "react";
import { Fresh } from "@/components/freshness";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getPlaceSlugForVenue } from "@/server/catalog/places";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { DishCard } from "@/components/dish-card";
import { Icon } from "@/components/icons";
import { MemberActions } from "@/components/member-actions";
import { AddToList } from "@/components/social/add-to-list";
import { Flash } from "@/components/social/bits";
import { ReviewsSection } from "@/components/social/reviews-section";
import { SourceNote } from "@/components/source-note";
import { idSchema, searchFiltersSchema } from "@/contracts/catalog";
import { hasDietChoice, hiddenReasonText } from "@/domain/dietary/labels";
import { formatDate, priceBand, titleCase } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { CatalogError, getVenue, searchCatalog } from "@/server/catalog";
import { getVenueHours } from "@/server/catalog/hours";
import { OpeningHours } from "@/components/opening-hours";
import { readDietPreference } from "@/server/catalog/diet";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Place details" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };

async function Detail({ params, searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(rawId);
  if (!id.success) notFound();
  const diet = await readDietPreference();
  const inNeeds = sp.view === "needs_confirmation";
  let venue, dishes, hours;
  try {
    [venue, dishes, hours] = await Promise.all([
      getVenue(id.data),
      searchCatalog(searchFiltersSchema.parse({ venueId: id.data, kinds: ["dish"], view: inNeeds ? "needs_confirmation" : "matches", limit: 50 }), diet),
      getVenueHours(id.data),
    ]);
  } catch (e) {
    if (e instanceof CatalogError && e.status === 404) {
      // A real place's app record (docs/49) normally goes to its place page in src/proxy.ts; this is the fallback.
      const slug = await getPlaceSlugForVenue(id.data);
      if (slug) redirect(`/places/${slug}`);
      notFound();
    }
    throw e;
  }
  const here = `/venues/${venue.id}`;
  const strict = hasDietChoice(diet);
  const address = [venue.street, venue.locality, venue.region, venue.postalCode].filter(Boolean).join(", ");
  // Directions open an outside map for the place's own address. Nothing about the visitor's location is sent or stored.
  const directions = venue.street && !venue.isDemo ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}` : null;

  return (
    <article>
      <p className="eyebrow">
        {titleCase(venue.venueType ?? "Place")}
        {venue.isDemo ? " · Demo" : ""}
      </p>
      <h1 className="title" data-testid="venue-name">
        {venue.name}
      </h1>
      <Fresh venue={venue.id} block />
      <p className="muted" style={{ margin: 0 }}>
        {[venue.neighborhood, venue.locality, priceBand(venue.priceBand), venue.cuisines.map(titleCase).join(", ")].filter(Boolean).join(" · ")}
      </p>
      {venue.status !== "published" && (
        <p className="callout" style={{ marginTop: 12 }}>
          {venue.status === "closed" ? "This place is marked as permanently closed." : "This place is marked as temporarily closed."}
        </p>
      )}
      <div className="panel">
        <p style={{ margin: 0 }}>
          <strong>Address:</strong> {address || "Not on file"}
        </p>
        {directions ? (
          <a className="link-btn" href={directions} target="_blank" rel="noopener noreferrer">
            <Icon name="pin" />
            Directions (opens a map in a new tab)
          </a>
        ) : (
          <p className="s14 muted" style={{ margin: "4px 0 0" }}>
            {venue.isDemo ? "This is an invented demo place, so there are no real directions." : "Directions are unavailable without a street address."}
          </p>
        )}
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>
          {formatDate(venue.reviewedAt) ? `Details last reviewed ${formatDate(venue.reviewedAt)}.` : "Review date not recorded."}
        </p>
        {venue.facts.length > 0 && (
          <dl className="deflist">
            {venue.facts.map((f) => (
              <div key={f.field}>
                <dt>{f.field === "hours" ? "Hours as written by the place" : titleCase(f.field)}</dt>
                <dd>
                  {factText(f.value) ?? "See source"}
                  {f.expired ? " (check out of date)" : ""}
                  <SourceNote source={f.source} checkedAt={f.checkedAt} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <OpeningHours hours={hours} />
      <h2 className="h-sec" id="dishes-h">
        {inNeeds ? "Dishes that need confirmation" : strict ? "Dishes that match your filter" : "Dishes"}
      </h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <DietChip diet={diet} returnTo={here} />
      </div>
      {strict && (
        <nav className="seg" aria-label="Result groups" style={{ marginBottom: 12 }}>
          <Link href={here} aria-current={!inNeeds ? "true" : undefined}>
            Confirmed ({dishes.counts.matches})
          </Link>
          <Link href={`${here}?view=needs_confirmation`} aria-current={inNeeds ? "true" : undefined}>
            Needs confirmation ({dishes.counts.needsConfirmation})
          </Link>
        </nav>
      )}
      {inNeeds && (
        <p className="callout">
          <strong>Not confirmed.</strong> These are not matches. Ask the restaurant before ordering.
        </p>
      )}
      {dishes.items.length > 0 ? (
        <ul className="cards" aria-labelledby="dishes-h" style={{ marginTop: 12 }}>
          {dishes.items.map((item) => (
            <DishCard key={item.foodItemId} item={item} diet={diet} />
          ))}
        </ul>
      ) : (
        <p className="muted">{inNeeds ? "Nothing here is waiting for confirmation." : strict ? "No dish here is confirmed for your filter." : "No dishes are listed for this place yet."}</p>
      )}
      {strict && dishes.counts.hidden > 0 && (
        <p className="s14 muted" style={{ marginTop: 12 }}>
          Always hidden for your filter: {dishes.hiddenReasons.map((r) => hiddenReasonText(r.code, r.family, r.count)).join(", ")}.
        </p>
      )}

      <Flash sp={sp} />
      <Suspense fallback={<Loading />}>
        <ReviewsSection kind="venue" id={venue.id} returnTo={here} />
      </Suspense>

      <h2 className="h-sec">Keep or correct</h2>
      <Suspense fallback={<Loading />}>
        <MemberActions target={{ venueId: venue.id }} returnTo={here} outcome={typeof sp.saved === "string" ? sp.saved : undefined} />
      </Suspense>
      <Suspense fallback={null}>
        <AddToList kind="venue" id={venue.id} returnTo={here} />
      </Suspense>
    </article>
  );
}

/** A place fact is stored either as a plain value or, when an editor entered it, as { text }. */
function factText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text;
  return null;
}

export default function VenuePage(props: Props) {
  return (
    <AppShell active="discover" narrow>
      <Link className="link-btn" href="/discover">
        <Icon name="back" />
        Discover
      </Link>
      <Suspense fallback={<Loading />}>
        <Detail {...props} />
      </Suspense>
    </AppShell>
  );
}
