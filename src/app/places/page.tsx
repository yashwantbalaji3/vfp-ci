import { Suspense } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { placeQuerySchema } from "@/contracts/places";
import { PlaceCard, PlaceListNote } from "@/components/place-card";
import { CuisineMark, cuisineFamily } from "@/components/cuisine-mark";
import { distinctBranchNames } from "@/contracts/menu-preview";
import { getPreviewIndex } from "@/server/catalog/menu-preview";
import { streetFile } from "@/server/map-tiles";
import { PlacesMap } from "./places-map";
import { PlacesNearMe } from "./near-me";
import { hrefWith, type RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPlaceDirectory } from "@/server/catalog/places";

export const metadata = { title: "Restaurants and cafés", robots: { index: false, follow: false } };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function Places({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places">
        <p>Restaurant meals are in a small private test for now. Sign in if you are taking part.</p>
      </SignInPrompt>
    );
  }
  const query = placeQuerySchema.safeParse({
    q: first(sp.q) || undefined,
    area: first(sp.area) || undefined,
    kind: first(sp.kind) || undefined,
    checked: first(sp.checked) || undefined,
    cuisine: first(sp.cuisine) || undefined,
    possible: first(sp.possible) || undefined,
    offset: first(sp.offset) || undefined,
    view: first(sp.view) || undefined,
  });
  const opts = query.success ? query.data : {};
  const view = opts.view ?? "list";
  const filtersOn = [opts.area, opts.kind, opts.cuisine, opts.checked].filter(Boolean).length;
  let dir;
  // The founder's private menu previews: marked on their cards, and offered first when nothing is filtered.
  const menus = await getPreviewIndex().catch(() => null);
  const withMenu = new Set((menus ?? []).map((m) => m.slug));
  try {
    dir = await getPlaceDirectory(opts);
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load places just now.</strong> <Link href="/places">Try again</Link>
      </div>
    );
  }
  if (!dir.preview && dir.total === 0) {
    return (
      <div className="empty" data-testid="places-none">
        <h2>No real places are listed yet</h2>
        <p>Real Boston-area restaurants are being prepared.{FLAGS.allowDemoContent ? " Until then, Discover shows example dishes." : ""}</p>
      </div>
    );
  }
  const attributions = [...new Set(dir.items.flatMap((p) => p.sources.map((s) => s.attribution).filter(Boolean)))];
  return (
    <>
      {dir.preview && dir.total > 0 && dir.cuisines.length === 0 && (
        <p className="callout" data-testid="cuisine-missing">
          <strong>Cuisine data isn&rsquo;t loaded on this computer</strong>, so the cuisine filter only offers &ldquo;All cuisines&rdquo;. Restaurants and menus are unaffected. To add it, load
          Overture&rsquo;s category list and refresh cuisines (<code>node scripts/catalog-preview.mjs cuisine-status</code> prints the exact steps). Only you see this note.
        </p>
      )}
      <form action="/places" method="get" role="search" className="stack" style={{ margin: "12px 0" }}>
        <div className="searchbar">
          <label htmlFor="pq" className="sr-only">
            Search places by name or street
          </label>
          <input id="pq" name="q" type="search" defaultValue={opts.q ?? ""} placeholder="Name or street" maxLength={120} enterKeyHint="search" />
          <button className="btn primary" type="submit">
            Search
          </button>
        </div>
        {view === "map" && <input type="hidden" name="view" value="map" />}
        {/* On a phone the filters fold away so the first places show without scrolling (screen audit, 18 Nov). */}
        <details className="sheet" open={filtersOn > 0} data-testid="places-filters">
          <summary>
            <Icon name="filter" />
            Filters{filtersOn > 0 ? ` (${filtersOn} on)` : ""}
          </summary>
          <div className="sheet-body stack">
        <div className="field-grid">
        <div>
          <label htmlFor="parea">Area</label>
          <select id="parea" name="area" defaultValue={opts.area ?? ""}>
            <option value="">All areas</option>
            {dir.areas.map((a) => (
              <option key={a.area} value={a.area}>
                {a.area} ({a.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pkind">Kind of place</label>
          <select id="pkind" name="kind" defaultValue={opts.kind ?? ""} data-testid="places-kind">
            <option value="">All kinds</option>
            {dir.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind} ({k.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pcuisine">Cuisine or style</label>
          <select id="pcuisine" name="cuisine" defaultValue={opts.cuisine ?? ""} data-testid="places-cuisine" aria-describedby="pcuisine-help">
            <option value="">All cuisines</option>
            {dir.cuisines.map((c) => (
              <option key={c.cuisine} value={c.cuisine}>
                {c.cuisine} ({c.count})
              </option>
            ))}
          </select>
        </div>
        </div>
          <p id="pcuisine-help" className="s13 muted" style={{ margin: 0 }}>
            Cuisine comes from each place&rsquo;s main category in Overture Maps, not checked by us. It says nothing about vegetarian or vegan dishes.
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
            <input type="checkbox" name="possible" value="true" defaultChecked={opts.possible ?? false} data-testid="places-possible" /> Also show places that only possibly serve the cuisine
          </label>
        {dir.preview && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
            <input type="checkbox" name="checked" value="true" defaultChecked={opts.checked ?? false} data-testid="places-checked" /> Only places whose identity you checked ({dir.checked})
          </label>
        )}
        <p style={{ margin: 0 }}>
          <button className="btn" type="submit" data-testid="places-apply">
            Apply filters
          </button>
        </p>
          </div>
        </details>
      </form>
      <nav className="seg" aria-label="Show places as" style={{ marginBottom: 12 }}>
        <Link href={hrefWith("/places", sp, { view: undefined, offset: undefined })} aria-current={view === "list" ? "true" : undefined} data-testid="places-view-list">
          List
        </Link>
        <Link href={hrefWith("/places", sp, { view: "map", offset: undefined })} aria-current={view === "map" ? "true" : undefined} data-testid="places-view-map">
          Map
        </Link>
      </nav>
      {menus && menus.length > 0 && !opts.q && filtersOn === 0 && !opts.offset && view === "list" && (
        <section aria-labelledby="menus-h" style={{ marginBottom: 16 }} data-testid="places-with-menus">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h2 className="h-sec" id="menus-h" style={{ margin: 0 }}>
              Menus you can browse ({menus.length})
            </h2>
            <Link className="link s14" href="/places/menus">
              All their meals
            </Link>
          </div>
          <ul className="mstrip" style={{ marginTop: 8 }}>
            {distinctBranchNames(menus).map((m) => (
              <li key={m.listingId}>
                <Link className="mtile" href={`/places/${m.slug}`} data-testid="menu-tile">
                  <CuisineMark family={cuisineFamily(m.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine, m.label)} size={40} />
                  <span>
                    <strong>{m.name}</strong>
                    <span className="s13 muted">{m.area ?? m.street}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <h2 className="h-sec" data-testid="places-count">
        {dir.total} {dir.total === 1 ? "place" : "places"}
      </h2>
      {view === "map" ? (
        <PlacesMap q={opts.q} area={opts.area} kind={opts.kind} checked={opts.checked} cuisine={opts.cuisine} possible={opts.possible} streetUrl={(await streetFile()) ? "/map-data/streets" : null} />
      ) : (
        <>
          <PlacesNearMe q={opts.q} area={opts.area} kind={opts.kind} checked={opts.checked} cuisine={opts.cuisine} possible={opts.possible} />
          {dir.items.length === 0 ? (
            <p className="muted">No places match. Try another name, area, kind of place or cuisine.</p>
          ) : (
            <>
              <PlaceListNote />
              <ul className="feed" style={{ marginTop: 12 }}>
                {dir.items.map((p) => (
                  <PlaceCard key={p.id} p={p} menu={withMenu.has(p.slug)} />
                ))}
              </ul>
            </>
          )}
          {dir.nextOffset !== null && (
            <p>
              <Link className="btn" href={hrefWith("/places", sp, { offset: dir.nextOffset })}>
                More places
              </Link>
            </p>
          )}
        </>
      )}
      {attributions.length > 0 && (
        <p className="s14 muted" data-testid="place-sources">
          Sources: {attributions.join("; ")}.
        </p>
      )}
    </>
  );
}

export default function PlacesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston area</p>
      <h1 className="title">Restaurants and cafés</h1>
      <Suspense fallback={<Loading label="Finding places…" />}>
        <Places searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
