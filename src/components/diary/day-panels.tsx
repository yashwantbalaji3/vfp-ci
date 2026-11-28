import Link from "next/link";
import { DIARY_NUTRIENTS, type DiaryDay } from "@/contracts/diary";
import { cardNotes } from "@/contracts/menu-preview";
import { knownAmount, proteinProgress } from "@/domain/diary/summary";
import { formatAmount } from "@/lib/format";
import { ideaAim, ideaBasisWords, mealIdeas, recipeIdeas, savedWithoutFigure } from "@/contracts/protein-to-go";
import { recipeFiltersSchema } from "@/contracts/recipes";
import { readDietPreference } from "@/server/catalog/diet";
import { getPlannedMeals, getPreviewPlaces, getSavedMeals } from "@/server/catalog/menu-preview";
import { getPlan } from "@/server/recipes";
import { MEAL_LABELS, type MealSlot } from "@/contracts/diary";
import { displayName } from "@/domain/recipes/quantity";
import { listRecipes } from "@/server/recipes";

/** The day's protein and calories, with the goal meter. Shared by Today and the diary so the two always agree. */
export function Summary({ day }: { day: DiaryDay }) {
  const protein = knownAmount(day.totals.protein_g);
  const energy = knownAmount(day.totals.energy_kcal);
  const progress = proteinProgress(day);
  const pct =
    progress.state === "met" ? 100
    : progress.state === "in_progress" ? Math.min(100, Math.round((progress.value / progress.target) * 100))
    : progress.state === "maybe" ? Math.min(99, Math.round((progress.low / progress.target) * 100))
    : 0;
  return (
    <section className="panel day-summary" aria-labelledby="sum-h" data-testid="day-summary">
      <h2 className="sr-only" id="sum-h">
        Summary for the day
      </h2>
      <div className="k s13 muted" style={{ fontWeight: 700 }}>
        Protein
      </div>
      {protein.state === "none" && <p className="pro none" style={{ margin: 0 }}><span className="v">Nothing logged yet</span></p>}
      {protein.state === "unknown" && <p className="pro none" style={{ margin: 0 }}><span className="v">Not known for what you logged</span></p>}
      {(protein.state === "partial" || protein.state === "complete") && (
        <p className="pro lg" style={{ margin: 0 }} data-testid="day-protein">
          {protein.state === "partial" ? <span className="per">at least</span> : protein.estimate && <span className="per">about</span>}
          {(protein.state === "partial" || protein.estimate) && " "}
          <span className="v">{formatAmount(protein.value)}</span> <span className="u">g</span>
        </p>
      )}
      {(protein.state === "partial" || protein.state === "complete") && protein.estimate && (
        <p className="s14" style={{ margin: "2px 0 0" }} data-testid="day-estimated">
          {protein.estimate.count} {protein.estimate.count === 1 ? "item is an estimate" : "items are estimates"}, so the known total is between{" "}
          {formatAmount(protein.estimate.low)} and {formatAmount(protein.estimate.high)} g.
        </p>
      )}
      {protein.state === "partial" && (
        <p className="s14" style={{ margin: "2px 0 0" }} data-testid="day-incomplete">
          {protein.missing} {protein.missing === 1 ? "item has" : "items have"} no protein value, so {protein.missing === 1 ? "it isn't" : "they aren't"} counted.
        </p>
      )}
      <p className="s14 muted" style={{ margin: "2px 0 0" }} data-testid="day-kcal">
        {energy.state === "complete" && `${formatAmount(energy.value)} kcal`}
        {energy.state === "partial" && `At least ${formatAmount(energy.value)} kcal (${energy.missing} without calories)`}
        {energy.state === "unknown" && "Calories not known"}
      </p>

      {progress.state !== "no_goal" && (
        <div style={{ marginTop: 12 }} data-testid="day-goal">
          <div className="meter" role="img" aria-label={`Protein goal progress: ${pct} percent`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="s14" style={{ margin: "6px 0 0" }}>
            {progress.state === "met" && !progress.estimated && `You reached your ${formatAmount(progress.target)} g goal.`}
            {progress.state === "met" && progress.estimated &&
              `Based on estimates, you reached your ${formatAmount(progress.target)} g goal: even at the low end of the estimates the total is ${formatAmount(progress.low)} g. This is an estimate, not a measured intake.`}
            {progress.state === "in_progress" &&
              `${progress.atLeast ? "At least " : progress.estimated ? "About " : ""}${formatAmount(progress.value)} g recorded of your ${formatAmount(progress.target)} g goal.`}
            {progress.state === "maybe" &&
              `About ${formatAmount(progress.value)} g of your ${formatAmount(progress.target)} g goal. Part of this is an estimate that could be as low as ${formatAmount(progress.low)} g, so we can't say the goal is reached.`}
            {progress.state === "nothing_logged" && `Your goal for this day is ${formatAmount(progress.target)} g.`}
            {progress.state === "unknown" && `Your goal is ${formatAmount(progress.target)} g. Protein isn't known for what you logged.`}
          </p>
        </div>
      )}
      {progress.state === "no_goal" && (
        <p className="s14 muted" style={{ margin: "8px 0 0" }}>
          No protein goal set.{" "}
          <Link className="link" href="/diary/goals">
            Set one if you like
          </Link>
        </p>
      )}

      {day.entries.length > 0 && (
        <details className="src" data-testid="more-nutrition">
          <summary>More nutrition</summary>
          <dl className="nutri">
            {DIARY_NUTRIENTS.filter((n) => n.code !== "protein_g").map((n) => {
              const a = knownAmount(day.totals[n.code]);
              return (
                <div key={n.code}>
                  <dt>{n.label}</dt>
                  <dd>
                    {a.state === "complete" && `${formatAmount(a.value)} ${n.unit}`}
                    {a.state === "partial" && `At least ${formatAmount(a.value)} ${n.unit} (${a.missing} without a value)`}
                    {(a.state === "unknown" || a.state === "none") && "Not known"}
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>
      )}
    </section>
  );
}


/**
 * Ideas for the next meal (docs/62, docs/68 L1). With a goal, aimed at what's left of it ("protein to go"); with
 * no goal, aimed at one meal's worth. Only real things are suggested: the person's saved real meals first, then
 * other real meals (one per restaurant) that fit their saved diet by the shared check (docs/63), then recipes.
 * A suggestion with unknown protein is never shown, and each one names where its figure came from; a saved meal
 * without a printed figure is listed apart, with no figure (journey K). Restaurant
 * meals appear only for the founder (the database refuses anyone else), so a member sees recipes only.
 */
export async function IdeasPanel({ day, from }: { day: DiaryDay; from: string }) {
  const aim = ideaAim(proteinProgress(day));
  if (!aim) return null;
  const { toGo } = aim;
  const pref = await readDietPreference();
  const [places, saved, recipes] = await Promise.all([
    getPreviewPlaces().catch(() => null),
    getSavedMeals().catch(() => [] as string[]),
    listRecipes(recipeFiltersSchema.parse({}), pref).catch(() => null),
  ]);
  // Not something already logged today ("Log this meal" names an entry "Meal (Restaurant)"; a recipe keeps its name).
  const logged = new Set(day.entries.map((e) => e.name));
  const candidates = (places ?? []).flatMap((p) => p.meals.filter((m) => !logged.has(`${m.label} (${p.name})`)).map((meal) => ({ meal, placeName: p.name })));
  const meals = mealIdeas(toGo, candidates, new Set(saved), pref);
  const unprinted = savedWithoutFigure(candidates, new Set(saved), pref, new Set(meals.map((x) => x.meal.dishId)));
  const cooks = recipeIdeas(toGo, (recipes?.items ?? []).filter((r) => !logged.has(r.name)));
  const back = encodeURIComponent(from);
  const method = new Map((recipes?.items ?? []).map((r) => [r.foodItemId, r.proteinMethod]));
  return (
    <section className="panel" aria-labelledby="togo-h" data-testid="protein-to-go" data-aim={aim.kind}>
      <h2 className="title-sm" id="togo-h" style={{ marginTop: 0 }}>
        {aim.kind === "open" ? "Ideas for your next meal" : `${toGo.atMost ? "At most " : ""}${formatAmount(toGo.grams)} g protein to go today`}
      </h2>
      {aim.kind === "to_go" && toGo.atMost && <p className="s14 muted" style={{ margin: "0 0 8px" }}>Some of what you logged has no protein value, so you may need less.</p>}
      {aim.kind === "open" && (
        <p className="s14 muted" style={{ margin: "0 0 8px" }}>
          {pref.diet === "none" ? "Satisfying meals and recipes" : "Meals and recipes that fit your diet, as stated,"} with a good amount of protein.
          Want a daily target?{" "}
          <Link className="link" href="/diary/goals">
            Set a protein goal
          </Link>
          . It&rsquo;s optional.
        </p>
      )}
      {meals.length + cooks.length + unprinted.length === 0 ? (
        <p className="s14 muted" style={{ margin: 0 }} data-testid="togo-none">
          No ideas yet. <Link className="link" href="/protein">Browse by protein</Link> or <Link className="link" href="/cook">find a recipe</Link>.
        </p>
      ) : (
        <ul className="entries" data-testid="togo-ideas">
          {meals.map(({ meal, placeName, saved: isSaved }) => (
            <li key={meal.dishId} className="entry" data-testid="togo-meal">
              <div>
                <Link className="link" href={`/meals/${meal.dishId}?from=${back}`}>
                  {meal.label}
                </Link>
                <div className="s13 muted">
                  {placeName}
                  {isSaved ? " · Saved" : ""} · <span data-testid="togo-basis">{ideaBasisWords(meal.protein.basis)}</span> · Unverified preview
                </div>
                {cardNotes(meal).plant && (
                  <div className="s13" data-testid="togo-plant-note">
                    {cardNotes(meal).plant}
                  </div>
                )}
              </div>
              <span className="pro" data-testid="togo-protein">
                {meal.protein.low === meal.protein.high ? `${formatAmount(meal.protein.low as number)} g` : `${formatAmount(meal.protein.low as number)}–${formatAmount(meal.protein.high as number)} g`}
              </span>
            </li>
          ))}
          {unprinted.map(({ meal, placeName }) => (
            <li key={meal.dishId} className="entry" data-testid="togo-saved-unprinted">
              <div>
                <Link className="link" href={`/meals/${meal.dishId}?from=${back}`}>
                  {meal.label}
                </Link>
                <div className="s13 muted">{placeName} · Saved · Unverified preview</div>
              </div>
              <span className="s13 muted">Protein not printed</span>
            </li>
          ))}
          {cooks.map((r) => (
            <li key={r.foodItemId} className="entry" data-testid="togo-recipe">
              <div>
                <Link className="link" href={`/cook/${r.foodItemId}`}>
                  {r.name}
                </Link>
                <div className="s13 muted">Recipe · {method.get(r.foodItemId) === "calculated" ? "per serving, calculated from its ingredients" : "per serving"}</div>
              </div>
              <span className="pro">{formatAmount(r.proteinG)} g</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"];
/**
 * What you planned for today (P2 part 2: one daily home for planning, eating out and cooking). Recipes and, for the
 * founder, real restaurant meals from the week plan, each one tap from cooking or logging. Nothing here is counted.
 */
export async function TodayPlan({ today }: { today: string }) {
  const [recipes, outings, places] = await Promise.all([
    getPlan(today, today).catch(() => []),
    getPlannedMeals(today, today).catch(() => []),
    getPreviewPlaces().catch(() => null),
  ]);
  const meals = new Map<string, { label: string; place: string }>();
  for (const pl of places ?? []) for (const m of pl.meals) meals.set(m.dishId, { label: m.label, place: pl.name });
  type Row = { key: string; slot: string | null; name: string; detail: string; href: string; action: string };
  const rows: Row[] = [
    ...recipes.map((p) => ({
      key: p.planId,
      slot: p.mealSlot,
      name: displayName(p.name),
      detail: p.cooked ? "Recipe, cooked" : "Recipe to cook",
      href: p.cooked && p.sessionId ? `/cook/session/${p.sessionId}/done` : `/cook/${p.foodItemId}?servings=${p.servings}&plan=${p.planId}`,
      action: p.cooked ? "Add to diary" : "Cook this",
    })),
    ...outings
      .filter((o) => meals.has(o.dishId))
      .map((o) => ({
        key: o.planId,
        slot: o.mealSlot,
        name: meals.get(o.dishId)!.label,
        detail: `Eating out at ${meals.get(o.dishId)!.place}`,
        href: `/diary/custom?date=${today}&slot=${o.mealSlot ?? "lunch"}&meal=${o.dishId}`,
        action: "Log it",
      })),
  ].sort((a, b) => (a.slot ? SLOT_ORDER.indexOf(a.slot) : 9) - (b.slot ? SLOT_ORDER.indexOf(b.slot) : 9));
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="today-plan-h" style={{ marginTop: 16 }} data-testid="today-plan">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 className="h-sec" id="today-plan-h" style={{ margin: 0 }}>
          Planned for today
        </h2>
        <Link className="link s14" href="/cook/plan">
          Week plan
        </Link>
      </div>
      <ul className="entries">
        {rows.map((r) => (
          <li key={r.key} className="entry" data-testid="today-plan-item">
            <span>
              {r.name}
              <span className="s13 muted" style={{ display: "block" }}>
                {[r.slot ? MEAL_LABELS[r.slot as MealSlot] : null, r.detail].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Link className="btn" href={r.href}>
              {r.action}
              <span className="sr-only">: {r.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
