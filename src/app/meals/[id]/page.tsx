import { Suspense } from "react";
import Link from "next/link";
import { communityOpen } from "@/server/member/community";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import {
  ConfirmationState,
  DietLabel,
  FitChip,
  FitPanel,
  MachineEvidence,
  MealCard,
  SectionNoteOnce,
  MealListSkeleton,
  ProteinLine,
  ProteinTile,
  UnverifiedBanner,
  day,
  price,
  sectionLabel,
} from "@/components/menu-preview";
import { BuilderView } from "@/components/meal-builder";
import { Flash, SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { idSchema } from "@/contracts/catalog";
import { byProtein, type PreviewMeal } from "@/contracts/menu-preview";
import { applyLens, mealFit } from "@/contracts/meal-eligibility";
import type { DietChoice } from "@/domain/dietary/labels";
import { readDietPreference } from "@/server/catalog/diet";
import { readSelection } from "@/contracts/meal-builder";
import { safeReturn } from "@/lib/preview-paths";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getMealLists, getMealReviews, getPlannedMeals, getPreviewAudience, getPreviewMeal, getSavedMeals, type MealReview, type PreviewPlace } from "@/server/catalog/menu-preview";
import { memberClock } from "@/server/diary/clock";
import { addDays } from "@/domain/dates/week";
import { formatDay } from "@/lib/format";
import { getMyLists } from "@/server/social";
import { mealListAction, mealReviewAction, planMealAction, saveMealAction } from "@/app/protein/meals/actions";

export const metadata = { title: "Meal", robots: { index: false, follow: false } };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const RATINGS = [
  { n: 1, word: "Poor" },
  { n: 2, word: "Fair" },
  { n: 3, word: "Good" },
  { n: 4, word: "Very good" },
  { n: 5, word: "Excellent" },
];

function SaveButton({ dishId, saved, here }: { dishId: string; saved: boolean; here: string }) {
  return (
    <form action={saveMealAction}>
      <input type="hidden" name="dishId" value={dishId} />
      <input type="hidden" name="returnTo" value={here} />
      <input type="hidden" name="saved" value={saved ? "no" : "yes"} />
      <button className={saved ? "btn" : "btn primary"} type="submit" data-testid="meal-save" aria-pressed={saved}>
        <Icon name="save" />
        {saved ? "Saved" : "Save"}
      </button>
    </form>
  );
}

/** Put this meal on a day of the week plan (P2 part 2: eating out in the plan). A plan logs nothing. */
async function PlanSheet({ dishId, here }: { dishId: string; here: string }) {
  const clock = await memberClock();
  const days = Array.from({ length: 7 }, (_, i) => addDays(clock.today, i));
  const planned = (await getPlannedMeals(days[0], days[6])).filter((p) => p.dishId === dishId);
  return (
    <details className="sheet" data-testid="meal-plan">
      <summary>
        <Icon name="plus" />
        {planned.length ? `Planned for ${planned.map((p) => formatDay(p.date, "short")).join(", ")}` : "Plan it for a day"}
      </summary>
      <div className="sheet-body stack">
        <form action={planMealAction} className="stack">
          <input type="hidden" name="dishId" value={dishId} />
          <input type="hidden" name="returnTo" value={here} />
          <div className="row">
            <div>
              <label htmlFor="mp-date">Day</label>
              <select id="mp-date" name="date" defaultValue={days[0]}>
                {days.map((d, i) => (
                  <option key={d} value={d}>
                    {i === 0 ? `Today, ${formatDay(d, "short")}` : formatDay(d, "short")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="mp-slot">Meal</label>
              <select id="mp-slot" name="slot" defaultValue="lunch">
                <option value="breakfast">Breakfast</option>
                <option value="lunch">Lunch</option>
                <option value="dinner">Dinner</option>
                <option value="snack">Snack</option>
              </select>
            </div>
          </div>
          <button className="btn" type="submit">
            Add to my week plan
          </button>
          <p className="s13 muted" style={{ margin: 0 }}>
            A plan is only an intention. Nothing is logged in your diary until you log it. <Link href="/cook/plan">See your week plan</Link>
          </p>
        </form>
      </div>
    </details>
  );
}

async function ListsSheet({ dishId, here }: { dishId: string; here: string }) {
  const [mine, holding] = await Promise.all([getMyLists().catch(() => []), getMealLists(dishId)]);
  const inList = new Set(holding.map((l) => l.listId));
  const others = mine.filter((l) => !inList.has(l.listId));
  return (
    <details className="sheet" data-testid="meal-lists">
      <summary>
        <Icon name="plus" />
        {holding.length ? `On ${holding.length} of your lists` : "Add to a list"}
      </summary>
      <div className="sheet-body stack">
        {holding.length > 0 && (
          <ul className="mine-list" data-testid="meal-lists-holding">
            {holding.map((l) => (
              <li key={l.listId}>
                <div>
                  <Link href={`/friends/lists/${l.listId}`}>{l.title}</Link>
                </div>
                <form action={mealListAction}>
                  <input type="hidden" name="dishId" value={dishId} />
                  <input type="hidden" name="returnTo" value={here} />
                  <input type="hidden" name="listId" value={l.listId} />
                  <input type="hidden" name="op" value="remove" />
                  <button className="btn" type="submit">
                    Take off
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <form action={mealListAction} className="stack">
            <input type="hidden" name="dishId" value={dishId} />
            <input type="hidden" name="returnTo" value={here} />
            <input type="hidden" name="op" value="add" />
            <div>
              <label htmlFor="ml-list">Choose one of your lists</label>
              <select id="ml-list" name="listId">
                {others.map((l) => (
                  <option key={l.listId} value={l.listId}>
                    {l.title}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn primary" type="submit">
              Add to this list
            </button>
          </form>
        )}
        <form action={mealListAction} className="stack">
          <input type="hidden" name="dishId" value={dishId} />
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="op" value="new" />
          <div>
            <label htmlFor="ml-new">{mine.length ? "Or start a new list" : "Start your first list"}</label>
            <input id="ml-new" type="text" name="title" maxLength={80} required placeholder="For example: High-protein lunches" />
          </div>
          <button className="btn" type="submit">
            Create list and add this
          </button>
        </form>
        <p className="s13 muted" style={{ margin: 0 }}>
          Real meals on a list are shown to you only, even if you publish the list, until a meal is verified and published.
        </p>
      </div>
    </details>
  );
}

function ReviewSheet({ dishId, here, mine }: { dishId: string; here: string; mine: MealReview | undefined }) {
  return (
    <details className="sheet" data-testid="meal-review">
      <summary>
        {mine ? `Your rating: ${mine.rating} of 5` : "Rate and review"}
      </summary>
      <div className="sheet-body stack">
        {mine?.body && (
          <p style={{ margin: 0, whiteSpace: "pre-line" }} data-testid="meal-review-body">
            {mine.body}
          </p>
        )}
        <form action={mealReviewAction} className="stack">
          <input type="hidden" name="dishId" value={dishId} />
          <input type="hidden" name="returnTo" value={here} />
          <fieldset>
            <legend>Your rating</legend>
            <div className="rating-pick">
              {RATINGS.map((r) => (
                <label key={r.n}>
                  <input type="radio" name="rating" value={r.n} defaultChecked={mine?.rating === r.n} required />
                  <span className="num">{r.n}</span>
                  <span>{r.word}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="mr-body">Notes for yourself (optional)</label>
            <textarea id="mr-body" name="body" defaultValue={mine?.body ?? ""} maxLength={2000} rows={4} />
          </div>
          <div>
            <label htmlFor="mr-date">When did you go? (optional)</label>
            <input id="mr-date" type="date" name="visitDate" defaultValue={mine?.visitDate ?? ""} style={{ minHeight: 44, font: "inherit", padding: "8px 12px", border: "1px solid var(--control-border)", borderRadius: 8, width: "100%" }} />
          </div>
          <p className="s13 muted" style={{ margin: 0 }}>
            Private: only you can read it. Reviews of unverified meals can&rsquo;t be shared and count toward no rating.
          </p>
          <button className="btn primary" type="submit">
            {mine ? "Update review" : "Save review"}
          </button>
        </form>
        {mine && (
          <form action={mealReviewAction}>
            <input type="hidden" name="dishId" value={dishId} />
            <input type="hidden" name="returnTo" value={here} />
            <input type="hidden" name="op" value="delete" />
            <button className="btn" type="submit">
              Delete review
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

function MoreHere({ place, current, from, choice }: { place: PreviewPlace; current: string; from: string; choice: DietChoice }) {
  // Only meals that fit the person's diet are suggested here (docs/63).
  const more = applyLens(place.meals.filter((m) => m.dishId !== current), { choice, view: "mine" }).shown.sort(byProtein).slice(0, 3);
  if (!more.length) return null;
  return (
    <section aria-labelledby="more-h">
      <h2 id="more-h" className="h-sec">
        More at {place.name}
      </h2>
      <SectionNoteOnce meals={more} />
      <ul className="cards">
        {more.map((m) => (
          <MealCard key={m.dishId} m={m} from={from} fit={m.fit} sectionNote={false} />
        ))}
      </ul>
      <p>
        <Link href={`/places/${place.slug}#menu-h`}>All meals at {place.name}</Link>
      </p>
    </section>
  );
}

function Details({ m, place, member }: { m: PreviewMeal; place: PreviewPlace; member: boolean }) {
  return (
    <>
      <details className="fold" open data-testid="meal-protein-detail">
        <summary>How we know the protein</summary>
        <ProteinLine m={m} />
      </details>
      <details className="fold" data-testid="meal-source">
        <summary>Where this came from</summary>
        <p>
          {m.sourceUrl ? (
            <>
              Drafted from{" "}
              <a href={m.sourceUrl} target="_blank" rel="noreferrer noopener">
                {place.name}&rsquo;s own menu page
              </a>
            </>
          ) : (
            "Source not recorded"
          )}
          {m.checkedOn ? `, read ${day(m.checkedOn)}` : ""}.{m.section ? ` Listed under “${sectionLabel(m.section)}”.` : ""}
        </p>
        {member ? (
          <p>
            <ConfirmationState m={m} /> An automatic check found these details on the saved copy of the restaurant&rsquo;s page. Ask the restaurant if a detail
            matters to you.
          </p>
        ) : (
          <p>
            <ConfirmationState m={m} />{" "}
            {m.confirmed ? "" : "Nothing about this meal has been confirmed by you yet."} <Link href={`/places/review/menus/${m.placeId}`}>Review this restaurant&rsquo;s drafts</Link>
          </p>
        )}
      </details>
      <details className="fold" data-testid="meal-checks">
        <summary>Automatic checks{m.autoChecks.some((c) => c.level === "check") ? " (one needs a look)" : ""}</summary>
        <MachineEvidence m={m} />
      </details>
      {m.exceptions.length > 0 && (
        <details className="fold" open data-testid="meal-exceptions">
          <summary>On your review list</summary>
          <ul style={{ paddingLeft: 20 }}>
            {m.exceptions.map((x, i) => (
              <li key={i}>{x}.</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

async function Meal({ params, searchParams }: Props) {
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(raw);
  if (!id.success) notFound();
  const here = `/meals/${id.data}`;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={here}>
        <h1 className="title-sm">Sign in to continue</h1>
        <p>This page is part of a private preview.</p>
      </SignInPrompt>
    );
  }
  const found = await getPreviewMeal(id.data);
  if (!found) notFound();
  const { place, meal, builder, menu } = found;
  const from = safeReturn(one(sp.from), `/places/${place.slug}`);
  const hereWithFrom = one(sp.from) ? `${here}?from=${encodeURIComponent(from)}` : here;
  const [saved, reviews, choice] = await Promise.all([getSavedMeals(), getMealReviews(), readDietPreference()]);
  // The founder, or a member of the local member beta (20261122000600, 20261123000100): both can save, plan, log,
  // list and review the meal. A member's list entries and reviews of a real meal stay private to them (the sheets say so).
  // A direct link or a saved meal stays reachable, but always says whether it fits the person's diet (docs/63).
  const fit = meal ? mealFit(meal.evidence, choice) : null;
  const isSaved = saved.includes(id.data);
  const mine = reviews.find((r) => r.dishId === id.data);
  const backWords = from.startsWith(`/places/${place.slug}`) ? place.name : from.startsWith("/protein/meals") ? "Meals" : from === "/saved" ? "Saved" : from.startsWith("/search") ? "Search" : from.startsWith("/discover") ? "Discover" : "Back";
  return (
    <>
      <Link className="link-btn" href={from} data-testid="meal-back">
        <Icon name="back" />
        {backWords}
      </Link>
      <p className="eyebrow" data-testid="meal-place">
        <Link href={`/places/${place.slug}`}>{place.name}</Link>
        {place.area ? <span className="muted"> · {place.area}</span> : null}
      </p>
      <h1 className="title" data-testid="meal-name">
        {meal?.label ?? builder!.label}
      </h1>
      <Flash sp={sp} />
      {meal ? (
        <>
          <div className="meal-layout">
            <div>
          <div className="meal-hero" data-testid="meal-hero">
            <ProteinTile m={meal} size="hero" />
            <div className="facts">
              <span className={meal.priceUsd ? "price" : "price none"} data-testid="meal-price">
                {price(meal.priceUsd) ?? (meal.historicalPrice ? "Current price not known" : "Price not stated")}
              </span>
              {meal.historicalPrice && (
                <span className="s13 muted" data-testid="meal-price-historical">
                  The menu we read is the restaurant&rsquo;s {meal.historicalPrice.edition} edition, so its prices may have changed. We keep them as a record but don&rsquo;t show them as current.
                </span>
              )}
              <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <DietLabel m={meal} />
                <FitChip fit={fit!} />
                <ConfirmationState m={meal} />
              </span>
              <span className="s14 muted">{meal.kcal !== null ? `${meal.kcal} kcal printed by the restaurant` : "Calories not printed"}</span>
            </div>
          </div>
          {meal.excluded && (
            <p className="callout stop" data-testid="meal-excluded">
              <strong>Left out of discovery.</strong> {meal.excluded}. It isn&rsquo;t shown in Discover, Protein Explorer or any diet filter.
            </p>
          )}
          <div className="actions-row" data-testid="meal-actions">
            <SaveButton dishId={meal.dishId} saved={isSaved} here={hereWithFrom} />
            {!meal.excluded && (
              <Link className="btn" href={`/protein/meals?compare=${meal.dishId}#compare`} data-testid="meal-compare-link">
                Compare
              </Link>
            )}
            <Link className="btn" href={`/diary/custom?meal=${meal.dishId}`} data-testid="meal-log">
              Log this meal
            </Link>
          </div>
          <UnverifiedBanner />
          <FitPanel m={meal} fit={fit!} choice={choice} />
          <div className="stack" style={{ marginBottom: 16 }}>
            <ListsSheet dishId={meal.dishId} here={hereWithFrom} />
            {!meal.excluded && <PlanSheet dishId={meal.dishId} here={hereWithFrom} />}
            <ReviewSheet dishId={meal.dishId} here={hereWithFrom} mine={mine} />
          </div>
            </div>
            <div>
              <Details m={meal} place={place} member={(await getPreviewAudience().catch(() => null)) === "member_beta"} />
            </div>
          </div>
          <MoreHere place={place} current={meal.dishId} from={from} choice={choice} />
          {(await communityOpen()) && (
            <p className="s14" data-testid="meal-suggest">
              Something wrong or missing?{" "}
              <Link href={`/contribute?place=${place.slug}&dish=${meal.dishId}`}>Suggest a change</Link>
            </p>
          )}
        </>
      ) : (
        <>
          <div className="actions-row" data-testid="meal-actions">
            <SaveButton dishId={builder!.dishId} saved={isSaved} here={hereWithFrom} />
          </div>
          <UnverifiedBanner />
          <div className="stack" style={{ marginBottom: 16 }}>
            <ListsSheet dishId={builder!.dishId} here={hereWithFrom} />
            <ReviewSheet dishId={builder!.dishId} here={hereWithFrom} mine={mine} />
          </div>
          <BuilderView b={builder!} selection={readSelection(builder!, { wrap: one(sp.wrap), base: one(sp.base), protein: one(sp.protein), top: sp.top })} here={here} from={one(sp.from) ? from : undefined} sources={menu.sources} choice={choice} />
        </>
      )}
    </>
  );
}

export default function MealPage(props: Props) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="protein" realPlaces narrow>
      <Suspense fallback={<MealListSkeleton rows={2} />}>
        <Meal {...props} />
      </Suspense>
    </AppShell>
  );
}
