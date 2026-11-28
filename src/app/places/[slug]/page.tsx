import { Suspense } from "react";
import Link from "next/link";
import { communityOpen } from "@/server/member/community";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { cuisineWords, dietHintWords, IDENTITY_WORDS, REPORT_REASONS, REPORT_WORDS, type PlaceDetail } from "@/contracts/places";
import { boundPercent } from "@/contracts/review";
import { osmLink } from "@/lib/review-checks";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPlaceDetail, getPlaceVenue, linkPlaceVenue } from "@/server/catalog/places";
import { getBuilders, getPreviewForSlug, getPreviewIndex, type PreviewPlace } from "@/server/catalog/menu-preview";
import { metersBetween, miles } from "@/contracts/neighbourhoods";
import type { Builder } from "@/contracts/meal-builder";
import { DietFilterNav, DietScope, MealCard, Monogram, SectionNoteOnce, UnverifiedBanner } from "@/components/menu-preview";
import { byProtein, menuAgreedHints } from "@/contracts/menu-preview";
import { applyLens, dietTabCounts, type MealLens } from "@/contracts/meal-eligibility";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import { readMealLens } from "@/server/catalog/meal-lens";
import { MemberActions } from "@/components/member-actions";
import { AddToList } from "@/components/social/add-to-list";
import { ReviewsSection } from "@/components/social/reviews-section";
import { streetFile } from "@/server/map-tiles";
import { reportPlaceAction } from "../actions";
import { EvidenceMapLoader } from "../review/evidence-map-loader";

export const metadata = { title: "Restaurant or café", robots: { index: false, follow: false } };

const SLUG = /^[a-z0-9-]{2,120}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" });
const REPORT_ERRORS: Record<string, string> = {
  NOTE_REQUIRED: "Please say what is wrong in the note.",
  ALREADY_REPORTED: "You have already reported this problem. We are checking it.",
  TOO_MANY_REPORTS: "You have sent many reports today. Please try again tomorrow.",
  NOT_FOUND: "This place is no longer listed.",
};

function Identity({ p }: { p: PlaceDetail }) {
  return (
    <section aria-labelledby="id-h" className="post" data-testid="place-identity">
      <h2 id="id-h" className="h-sec" style={{ marginTop: 0 }}>
        How we know this place
      </h2>
      <p style={{ margin: 0 }} data-testid="identity-status">
        <strong>{IDENTITY_WORDS[p.identityBasis]}.</strong>
      </p>
      {p.identityBasis === "verified" && <p className="s14 muted" style={{ margin: "4px 0 0" }}>We checked that this place exists at this address and is open to the public.</p>}
      {p.identityBasis === "batch_sampled" && p.batch && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }} data-testid="identity-batch">
          It is in a batch of places where we checked a random sample of {p.batch.sampleSize} and found {p.batch.problems} {p.batch.problems === 1 ? "problem" : "problems"} ({day(p.batch.approvedAt)}). With 95% confidence, no more than{" "}
          {boundPercent(p.batch.upperBound)} of the batch is wrong, so this place could still be.
        </p>
      )}
      {p.identityBasis === "corroborated" && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }}>Two independent public datasets agree on its name and place. We have not checked it ourselves yet, so it could have closed or moved.</p>
      )}
      {p.identityBasis === "single_source" && (
        <p className="s14 muted" style={{ margin: "4px 0 0" }} data-testid="identity-single-source">
          Only one public dataset (Overture Maps) lists it, so nothing has cross-checked it. It may have closed, moved or be listed under another
          name. Nothing here says what it serves or whether any dish suits a diet.
        </p>
      )}
      {p.reported && (
        <p className="s14" style={{ margin: "8px 0 0" }} data-testid="place-reported">
          Someone reported a problem with this listing. We are checking it.
        </p>
      )}
    </section>
  );
}

/**
 * The founder-only menu preview of a researched place (docs/59, redesigned in docs/60): every drafted complete
 * meal under an "Unverified preview" label, highest protein first, under the person's saved diet by the shared
 * check (docs/63). Build-your-own meals get their own card. Meals left out of discovery (they name meat
 * with no vegetarian claim, or the menu says they are not vegetarian) stay here, folded away, so their history
 * is kept.
 */
function MenuPreview({ preview, builders, lens, here }: { preview: PreviewPlace; builders: Builder[]; lens: MealLens; here: string }) {
  const { shown: unsorted, counts } = applyLens(preview.meals, lens);
  const shown = [...unsorted].sort(byProtein);
  const left = preview.meals.filter((m) => m.excluded);
  const chosen = hasDietChoice(lens.choice);
  const name = describeDietChoice(lens.choice).toLowerCase();
  const link = (q: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries(q).filter((x): x is [string, string] => !!x[1]));
    return `${here}${u.size ? `?${u}` : ""}#menu-h`;
  };
  const tmp = !lens.saved && lens.choice.diet !== "none" ? lens.choice.diet : undefined;
  const known = preview.meals.filter((m) => !m.excluded && m.protein.low !== null).length;
  return (
    <section aria-labelledby="menu-h" style={{ marginBottom: 16 }} data-testid="place-menu-preview">
      <h2 id="menu-h" className="h-sec" style={{ marginTop: 8 }}>
        Meals
      </h2>
      <UnverifiedBanner>
        <p className="s14" style={{ margin: 0 }}>
          {preview.meals.length} complete {preview.meals.length === 1 ? "meal" : "meals"}, {known} with a protein figure
          {preview.otherRows ? `; ${preview.otherRows} sides, parts, drinks or desserts not listed` : ""}.{" "}
          <Link href={`/places/review/menus/${preview.placeId}`}>Review the drafts</Link>
        </p>
      </UnverifiedBanner>
      {!lens.saved && <DietFilterNav current={lens.choice.diet === "none" ? "any" : lens.choice.diet} href={(d) => link({ diet: d === "any" ? undefined : d })} counts={dietTabCounts(preview.meals)} />}
      <DietScope choice={lens.choice} saved={lens.saved} view={lens.view} counts={counts} href={(v) => link({ diet: tmp, fit: v === "mine" ? undefined : v })} />
      <p className="s13 muted" style={{ margin: "0 0 8px" }}>
        Highest protein first; a range sorts by its low end and unknown comes last.
        {chosen ? " A meal whose diet the menu doesn't state, or that lists something you leave out, isn't shown as fitting your diet." : ""}
      </p>
      {builders.length > 0 && (
        <ul className="cards" style={{ marginBottom: 12 }} data-testid="place-builders">
          {builders.map((b) => (
            <li key={b.dishId} className="mcard" data-testid="builder-card">
              <div className="ptile ok">
                <span className="v">{b.parts.length}</span>
                <span className="u">choices</span>
                <span className="b">Build your own</span>
              </div>
              <div className="body">
                <h3>
                  <Link href={`/meals/${b.dishId}`}>{b.label}</Link>
                </h3>
                <p className="meta">
                  {b.groups.wrap.length ? `${b.groups.wrap.length} breads · ` : ""}
                  {b.groups.base.length} bases · {b.groups.protein.length} proteins · {b.groups.topping_sauce.length} toppings and sauces
                </p>
                <div className="foot">
                  <span className="s13">Pick your own and see the protein, added up from the restaurant&rsquo;s per-item figures</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {shown.length === 0 ? (
        <div className="empty" data-testid="preview-none">
          <h3>{!chosen ? "No complete meals drafted here yet" : lens.view === "check" ? "No meals here need confirmation" : `No meal here fits ${name} by the menu's own words`}</h3>
          <p>
            {counts.check > 0 && lens.view !== "check" ? `${counts.check} ${counts.check === 1 ? "needs" : "need"} confirmation. ` : ""}
            {counts.all} {counts.all === 1 ? "meal is" : "meals are"} on this menu in all.
          </p>
          <p className="row">
            {counts.check > 0 && lens.view !== "check" && (
              <Link className="btn" href={link({ diet: tmp, fit: "check" })}>
                See the ones that need confirmation
              </Link>
            )}
            <Link className="btn" href={link({ diet: tmp, fit: "all" })}>
              See all meals, including ones that don&rsquo;t fit
            </Link>
          </p>
        </div>
      ) : (
        <>
        <SectionNoteOnce meals={shown} />
        <ul className="cards">
          {shown.map((m) => (
            <MealCard key={m.dishId} m={m} from={here} fit={m.fit} sectionNote={false} />
          ))}
        </ul>
        </>
      )}
      {left.length > 0 && (
        <details className="fold" style={{ marginTop: 12 }} data-testid="preview-left-out">
          <summary>
            {left.length} {left.length === 1 ? "meal" : "meals"} left out of discovery
          </summary>
          <p className="s14 muted">Not shown in Discover, Protein Explorer or any diet filter. Kept here with their source history.</p>
          <ul className="mine-list">
            {left.map((m) => (
              <li key={m.dishId} data-testid="preview-left-out-meal">
                <div>
                  <Link href={`/meals/${m.dishId}?from=${encodeURIComponent(here)}`}>
                    <strong>{m.label}</strong>
                  </Link>
                  <span className="s14">{m.excluded}.</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Report({ p, signedIn, error, message }: { p: PlaceDetail; signedIn: boolean; error?: string; message?: string }) {
  return (
    <section id="report" aria-labelledby="rep-h" className="post" data-testid="place-report">
      <h2 id="rep-h" className="h-sec" style={{ marginTop: 0 }}>
        Report a problem
      </h2>
      {message === "reported" && (
        <p className="callout calm" role="status" data-testid="report-message">
          Thank you. Your report was sent. It does not change the listing until we have checked it.
        </p>
      )}
      {error && (
        <p className="callout stop" role="alert" data-testid="report-error">
          {REPORT_ERRORS[error] ?? "The report was not sent. Please try again."}
        </p>
      )}
      {!signedIn ? (
        <p style={{ margin: 0 }}>
          <Link href={`/login?next=${encodeURIComponent(`/places/${p.slug}#report`)}`}>Sign in</Link> to report a wrong address, a duplicate, a closure or a place that is not open to the public.
        </p>
      ) : (
        <details open={Boolean(error)}>
          <summary>Something is wrong with this listing</summary>
          <form action={reportPlaceAction} className="stack" style={{ marginTop: 8 }}>
            <input type="hidden" name="listingId" value={p.id} />
            <input type="hidden" name="slug" value={p.slug} />
            <fieldset>
              <legend>What is wrong?</legend>
              {REPORT_REASONS.map((r) => (
                <label key={r} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                  <input type="radio" name="reason" value={r} required /> {REPORT_WORDS[r]}
                </label>
              ))}
            </fieldset>
            <div>
              <label htmlFor="report-note">Details (optional; needed for “something else”)</label>
              <textarea id="report-note" name="note" maxLength={500} rows={3} style={{ width: "100%" }} aria-describedby="report-note-help" />
              <p id="report-note-help" className="s14 muted" style={{ margin: "4px 0 0" }}>
                Please don&rsquo;t include anyone&rsquo;s personal details. Up to 500 characters.
              </p>
            </div>
            <button className="btn primary" type="submit" data-testid="report-send">
              Send report
            </button>
          </form>
        </details>
      )}
    </section>
  );
}

/**
 * Up to three researched menus within 3 km of a place: those with meals the restaurant labels vegetarian or vegan
 * first, then the rest, each group nearest first (straight-line distance between the two addresses). Only the six
 * nearest menus are opened, so a page costs at most six menu reads however many menus exist.
 */
async function nearestMenus(p: { lat: number; lon: number }) {
  const close = ((await getPreviewIndex()) ?? [])
    .map((e) => ({ e, meters: metersBetween(p, e) }))
    .filter((x) => x.meters <= 3000)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 6);
  const opened = await Promise.all(close.map(async ({ e, meters }) => ({ x: await getPreviewForSlug(e.slug), meters })));
  return opened
    .filter((o): o is { x: PreviewPlace; meters: number } => o.x !== null && o.x.meals.length > 0)
    .map(({ x, meters }) => ({
      slug: x.slug,
      name: x.name,
      area: x.area,
      meters,
      stated: x.meals.filter((m) => m.diet === "vegan_stated" || m.diet === "vegetarian_stated").length,
    }))
    .sort((a, b) => Number(b.stated > 0) - Number(a.stated > 0) || a.meters - b.meters || a.name.localeCompare(b.name))
    .slice(0, 3);
}

async function Place({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<RawParams> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  if (!SLUG.test(slug)) notFound();
  const member = await getCurrentMember();
  let p: PlaceDetail | null;
  try {
    p = await getPlaceDetail(slug);
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load this place just now.</strong> <Link href="/places">Back to places</Link>
      </div>
    );
  }
  if (!p) {
    if (!member) {
      return (
        <SignInPrompt next={`/places/${slug}`}>
          <p>Real places are a private preview for now. Sign in to continue.</p>
        </SignInPrompt>
      );
    }
    notFound();
  }
  // Saves, ratings and lists point at the app's place record for this real place (docs/49). A signed-in member who
  // may see the place gets it made on first visit (identity fields only); a guest only reads an existing one.
  const [street, venueId, preview] = await Promise.all([
    streetFile(),
    member ? linkPlaceVenue(p.id) : getPlaceVenue(p.slug),
    member && p.visibility === "preview" ? getPreviewForSlug(p.slug).catch(() => null) : null,
  ]);
  const builders = preview ? await getBuilders(preview.placeId) : [];
  // An unresearched place points to the nearest researched menus (journey J, owner directive 27 Nov 2026).
  const nearby = !preview && member && p.visibility === "preview" ? await nearestMenus(p).catch(() => []) : [];
  const lens = await readMealLens(sp);
  // A report's outcome uses its own parameters ("re" and m=reported); every other outcome on this page comes from
  // saving, listing or rating, and is announced the same way as on any other page.
  const e = first(sp.re);
  const reported = first(sp.m) === "reported";
  const here = `/places/${p.slug}`;
  const cuisine = cuisineWords(p.cuisines);
  // The open map's vegetarian/vegan category: founder-only, through the researched-menu index (docs/64).
  const hints = preview ? menuAgreedHints(preview.dietHints, preview.meals) : [];
  const hint = dietHintWords(hints);
  return (
    <>
      <p>
        <Link href="/places">← Restaurants and cafés</Link>
      </p>
      {/* A preview listing is covered by the one private-preview note at the top of every real page (bug B4, docs/68). */}
      <div className="place-head">
        <Monogram name={p.name} cuisine={p.cuisines.find((c) => c.basis === "dataset_primary")?.cuisine ?? p.category} />
        <div style={{ minWidth: 0 }}>
          <h1 className="title" style={{ overflowWrap: "anywhere" }} data-testid="place-name">
            {p.name}
          </h1>
          <p className="s14 muted" style={{ margin: "2px 0 0" }}>
            {p.category}
            {p.area ? ` · ${p.area}` : ""}
          </p>
        </div>
      </div>
      <div className="place-facts">
        {preview ? (
          <span className="dchip draft" data-testid="menu-status">
            Menu: unverified preview
          </span>
        ) : (
          <span className="dchip draft" data-testid="menu-status">
            Menu not checked yet
          </span>
        )}
        <span style={{ overflowWrap: "anywhere" }} data-testid="place-address">
          {p.street}, {p.locality ? `${p.locality} ` : ""}
          {p.postcode}
        </span>
        <a href={osmLink(p.lat, p.lon)} target="_blank" rel="noreferrer noopener">
          Directions (OpenStreetMap)
        </a>
        {/* On a phone the save and rate buttons sit after the meals; this jumps straight to them (P2 part 2). */}
        {preview && venueId && (
          <a href="#place-social" data-testid="place-jump-social">
            Save, list or rate
          </a>
        )}
      </div>
      <p className="s13" style={{ margin: "0 0 12px" }} data-testid="place-cuisine">
        {cuisine ? (
          <>
            <strong>Cuisine or style: {cuisine}.</strong>{" "}
            <span className="muted">From Overture Maps&rsquo; category, not checked by us; it says nothing about vegetarian or vegan dishes.</span>
          </>
        ) : (
          <span className="muted">Cuisine not known.</span>
        )}
      </p>
      {hint && (
        <p className="s13" style={{ margin: "-6px 0 12px" }} data-testid="place-diet-hint">
          <strong>{hint}.</strong>{" "}
          <span className="muted">A hint about the restaurant from open map data, not checked by us. It doesn&rsquo;t say any dish is {hints.some((h) => h.hint === "vegan") ? "vegan" : "vegetarian"}; only the menu can.</span>
        </p>
      )}
      <div className={preview ? "place-layout" : undefined}>
        {preview && (
          <div className="place-main">
            <MenuPreview preview={preview} builders={builders} lens={lens} here={here} />
          </div>
        )}
        <div className={preview ? "place-aside" : undefined}>

      {preview ? null : (
      <section aria-labelledby="menu-h" className="callout" style={{ marginBottom: 12 }} data-testid="place-menu">
        <h2 id="menu-h" className="h-sec" style={{ marginTop: 0 }}>
          Menu not checked yet
        </h2>
        <p style={{ margin: 0 }}>
          We have not checked what this place serves. It is not shown as vegetarian or vegan, and it is not in any diet or protein filter, until we check its dishes from a source we can name.
        </p>
        <p className="s14" style={{ margin: "8px 0 0" }}>
          Know a vegetarian or vegan dish here? <Link href={`/contribute?place=${p.slug}`}>Suggest it</Link> and we&rsquo;ll check it at its source before it shows anywhere.
        </p>
      </section>
      )}
      {nearby.length > 0 && (
        <section aria-labelledby="nearby-h" style={{ marginBottom: 12 }} data-testid="place-nearby-menus">
          <h2 id="nearby-h" className="h-sec">
            Nearby restaurants with researched menus
          </h2>
          <ul className="plain" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {nearby.map((n) => (
              <li key={n.slug} className="panel" style={{ padding: "10px 12px" }}>
                <Link href={`/places/${n.slug}`}>
                  <strong>{n.name}</strong>
                </Link>{" "}
                <span className="s14 muted">· {miles(n.meters)} away{n.area ? ` · ${n.area}` : ""}</span>
                <p className="s14" style={{ margin: "2px 0 0" }}>
                  {n.stated > 0
                    ? `${n.stated} ${n.stated === 1 ? "meal" : "meals"} the restaurant labels vegetarian or vegan`
                    : "Menu researched; no meal labelled vegetarian or vegan by the restaurant"}
                </p>
              </li>
            ))}
          </ul>
          <p className="s14 muted" style={{ margin: "6px 0 0" }}>
            Straight-line distance between the two addresses. <Link href="/places/menus">All restaurants with menus</Link>
          </p>
        </section>
      )}

      {!reported && <Flash sp={{ m: sp.m, e: sp.e }} />}
      {venueId && (
        <section id="place-social" aria-label="Save, rate or list this place" data-testid="place-social" style={{ marginBottom: 12 }}>
          {member && <MemberActions target={{ venueId }} returnTo={here} outcome={typeof sp.saved === "string" ? sp.saved : undefined} corrections={false} />}
          {member && <AddToList kind="venue" id={venueId} returnTo={here} />}
          {preview ? (
            <details className="fold" data-testid="place-reviews-fold">
              <summary>Ratings and reviews of this restaurant</summary>
              <ReviewsSection kind="venue" id={venueId} returnTo={here} />
            </details>
          ) : (
            <ReviewsSection kind="venue" id={venueId} returnTo={here} />
          )}
        </section>
      )}
      {/* P2 (docs/68): save, rate and list come before the map on a phone. */}
      <EvidenceMapLoader pins={[{ letter: "", lat: p.lat, lon: p.lon, label: `${p.name}, ${p.street}` }]} streetUrl={street ? "/map-data/streets" : null} />
      <div style={{ height: 16 }} />

      <div className="stack">
        {preview ? (
          <details className="fold" data-testid="place-about-fold">
            <summary>How we know this place, and its sources</summary>
            <PlaceEvidence p={p} />
          </details>
        ) : (
          <PlaceEvidence p={p} />
        )}
        {member && (await communityOpen()) && (
          <p className="s14" data-testid="place-suggest">
            Know a vegetarian or vegan dish here, or a menu change?{" "}
            <Link href={`/contribute?place=${p.slug}`}>Suggest a change</Link>
          </p>
        )}
        <Report p={p} signedIn={member !== null} error={e && /^[A-Z_]{1,40}$/.test(e) ? e : undefined} message={reported ? "reported" : undefined} />
      </div>
        </div>
      </div>
    </>
  );
}

/** Identity and sources: always on the page; folded away when the page leads with a menu. */
function PlaceEvidence({ p }: { p: Parameters<typeof Identity>[0]["p"] }) {
  return (
    <>
      <Identity p={p} />
      <section aria-labelledby="src-h" className="post" data-testid="place-sources">
        <h2 id="src-h" className="h-sec" style={{ marginTop: 0 }}>
          Sources
        </h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {p.sources.map((s, i) => (
            <li key={i}>
              {s.title ?? "Public dataset"}
              {s.release ? ` (release ${s.release})` : ""}
              {s.attribution ? `. ${s.attribution}` : ""}
            </li>
          ))}
        </ul>
        <p className="s14 muted" style={{ margin: "8px 0 0" }}>Listing last rebuilt {day(p.updatedAt)}.</p>
      </section>
    </>
  );
}

export default function PlacePage(props: { params: Promise<{ slug: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces narrow>
      <Suspense fallback={<Loading label="Loading this place…" />}>
        <Place {...props} />
      </Suspense>
    </AppShell>
  );
}
