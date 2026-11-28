import { Suspense } from "react";
import Link from "next/link";
import { removePlanAction } from "@/app/cook/actions";
import { AppShell, Loading } from "@/components/app-shell";
import { PrivacyNote, SignInPanel } from "@/components/diary/diary-tabs";
import { Icon } from "@/components/icons";
import { MEAL_LABELS, isoDateSchema, type MealSlot } from "@/contracts/diary";
import { addDays } from "@/domain/dates/week";
import { displayName, formatMinutes, formatServings, totalMinutes } from "@/domain/recipes/quantity";
import { formatAmount, formatDay } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { memberClock } from "@/server/diary/clock";
import { getPlan } from "@/server/recipes";
import { getPlannedMeals, getPreviewPlaces } from "@/server/catalog/menu-preview";
import { planMealAction } from "@/app/protein/meals/actions";
import type { PreviewMeal } from "@/contracts/menu-preview";

export const metadata = { title: "Week plan" };
type Props = { searchParams: Promise<RawParams> };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const NOTES: Record<string, string> = {
  planned: "Added to your plan.",
  removed: "Removed from your plan.",
  meal_planned: "Added to your week plan.",
  meal_unplanned: "Taken off your week plan.",
};
const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"];
const slotRank = (s: string | null) => (s ? SLOT_ORDER.indexOf(s) : 9);

async function Plan({ searchParams }: Props) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPanel next="/cook/plan">
        Sign in to plan recipes for the week. Your plan is private.
      </SignInPanel>
    );
  }
  const clock = await memberClock();
  const asked = isoDateSchema.safeParse(first(sp.date)).data;
  // A day in the coming week (after planning one, say) shows the week from today, so today stays in view.
  const anchor = !asked || (asked >= clock.today && asked < addDays(clock.today, 7)) ? clock.today : asked;
  // Seven days from today (or from the chosen day): a plan looks ahead, so a Sunday never shows a week that is over.
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const [plan, outings, places] = await Promise.all([getPlan(days[0], days[6]), getPlannedMeals(days[0], days[6]), getPreviewPlaces().catch(() => null)]);
  const meals = new Map<string, { meal: PreviewMeal; place: string }>();
  for (const pl of places ?? []) for (const m of pl.meals) meals.set(m.dishId, { meal: m, place: pl.name });
  const note = NOTES[first(sp.note) ?? first(sp.m) ?? ""];
  const here = `/cook/plan?date=${days[0]}`;
  return (
    <>
      <nav className="daynav" aria-label="Week">
        <Link className="btn" href={`/cook/plan?date=${addDays(days[0], -7)}`} aria-label="Previous week">
          <Icon name="back" className="" />
        </Link>
        <p style={{ margin: 0, textAlign: "center", fontWeight: 700 }} data-testid="plan-range">
          {formatDay(days[0], "short")} to {formatDay(days[6], "short")}
        </p>
        <Link className="btn" href={`/cook/plan?date=${addDays(days[0], 7)}`} aria-label="Next week">
          <Icon name="next" className="" />
        </Link>
      </nav>
      {note && (
        <p className="callout calm" role="status" data-testid="plan-note">
          {note}
        </p>
      )}
      <p className="callout calm" data-testid="plan-explainer">
        A plan is only an intention. Planned recipes and restaurant meals are <strong>not counted</strong> in your diary, your protein or your home-cooking goal until you cook or log them.
      </p>
      <ul className="plan-days">
        {days.map((d) => {
          const items = plan.filter((p) => p.date === d).sort((a, b) => slotRank(a.mealSlot) - slotRank(b.mealSlot));
          const out = outings.filter((o) => o.date === d && meals.has(o.dishId)).sort((a, b) => slotRank(a.mealSlot) - slotRank(b.mealSlot));
          // Planned protein if one serving of each is eaten: known figures only, a range when a meal's is a range.
          const lows = [...items.map((p) => p.proteinG), ...out.map((o) => meals.get(o.dishId)!.meal.protein.low)];
          const highs = [...items.map((p) => p.proteinG), ...out.map((o) => meals.get(o.dishId)!.meal.protein.high)];
          const known = lows.filter((v) => v !== null).length;
          const low = lows.reduce<number>((a, v) => a + (v ?? 0), 0);
          const high = highs.reduce<number>((a, v) => a + (v ?? 0), 0);
          return (
            <li key={d} data-testid="plan-day" data-date={d}>
              <h2 className="h-sub">
                {formatDay(d)}
                {d === clock.today ? " · today" : ""}
              </h2>
              {known > 0 && (
                <p className="s13 muted" style={{ margin: "0 0 6px" }} data-testid="plan-day-protein">
                  Planned protein, one serving of each: {low === high ? `${formatAmount(low)} g` : `${formatAmount(low)} to ${formatAmount(high)} g`}
                  {known < lows.length ? `, from ${known} of ${lows.length} items with a known figure` : ""}. Not counted until you log it.
                </p>
              )}
              {out.length > 0 && (
                <ul className="mine-list" data-testid="plan-outings">
                  {out.map((o) => {
                    const { meal, place } = meals.get(o.dishId)!;
                    return (
                      <li key={o.planId} data-testid="plan-outing">
                        <div>
                          <Link href={`/meals/${meal.dishId}?from=${encodeURIComponent(here)}`}>
                            <strong>{meal.label}</strong>
                          </Link>
                          <span className="s14 muted">
                            {[o.mealSlot ? MEAL_LABELS[o.mealSlot as MealSlot] : null, `Eating out at ${place}`, meal.protein.low !== null ? meal.protein.words : "protein not known"]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <span className="s13 muted">Not yet checked by a person · only you can see your plan</span>
                        </div>
                        <div className="row">
                          <Link className="btn primary" href={`/diary/custom?date=${d}&slot=${o.mealSlot ?? "lunch"}&meal=${meal.dishId}`}>
                            Log it<span className="sr-only">: {meal.label}</span>
                          </Link>
                          <form action={planMealAction}>
                            <input type="hidden" name="dishId" value={meal.dishId} />
                            <input type="hidden" name="planId" value={o.planId} />
                            <input type="hidden" name="returnTo" value={here} />
                            <button className="btn" type="submit">
                              Remove<span className="sr-only"> {meal.label} from the plan</span>
                            </button>
                          </form>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {items.length === 0 ? (
                out.length === 0 && (
                  <p className="s14 muted" style={{ margin: 0 }}>
                    Nothing planned.
                  </p>
                )
              ) : (
                <ul className="mine-list">
                  {items.map((p) => (
                    <li key={p.planId} data-testid="plan-item">
                      <div>
                        <strong>{displayName(p.name)}</strong>
                        <span className="s14 muted">
                          {[
                            p.mealSlot ? MEAL_LABELS[p.mealSlot as MealSlot] : null,
                            formatServings(p.servings),
                            formatMinutes(totalMinutes(p.prepMinutes, p.cookMinutes)),
                            p.proteinG !== null ? `${formatAmount(p.proteinG)} g protein per serving` : "protein not known",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <span className="s14" data-testid="plan-status">
                          {p.cooked ? "Cooked" : "Planned, not cooked"}
                        </span>
                      </div>
                      <div className="row">
                        {p.cooked && p.sessionId ? (
                          <Link className="btn" href={`/cook/session/${p.sessionId}/done`}>
                            Add to diary<span className="sr-only">: {displayName(p.name)}</span>
                          </Link>
                        ) : (
                          <Link className="btn primary" href={`/cook/${p.foodItemId}?servings=${p.servings}&plan=${p.planId}`}>
                            Cook this<span className="sr-only">: {displayName(p.name)}</span>
                          </Link>
                        )}
                        <form action={removePlanAction}>
                          <input type="hidden" name="planId" value={p.planId} />
                          <button className="btn" type="submit">
                            Remove<span className="sr-only"> {displayName(p.name)} from the plan</span>
                          </button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <p className="row" style={{ marginTop: 16 }}>
        <Link className="btn primary" href="/cook">
          <Icon name="plus" className="" />
          Choose a recipe to plan
        </Link>
        {places && (
          <Link className="btn" href="/protein/meals" data-testid="plan-find-meal">
            Plan a restaurant meal
          </Link>
        )}
      </p>
      <PrivacyNote />
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="cook" narrow>
      <p style={{ margin: "0 0 8px" }}>
        <Link className="link-btn" href="/cook">
          <Icon name="back" className="icon" />
          All recipes
        </Link>
      </p>
      <p className="eyebrow">Cook at home and eat out</p>
      <h1 className="title">Week plan</h1>
      <Suspense fallback={<Loading />}>
        <Plan {...props} />
      </Suspense>
    </AppShell>
  );
}
