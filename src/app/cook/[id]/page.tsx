import { Suspense } from "react";
import { Fresh } from "@/components/freshness";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ReviewsSection } from "@/components/social/reviews-section";
import { notFound } from "next/navigation";
import { z } from "zod";
import { startCookAction } from "@/app/cook/actions";
import { AppShell, Loading } from "@/components/app-shell";
import { PlanForm } from "@/components/cook/plan-form";
import { RecipeAdjust } from "@/components/cook/recipe-adjust";
import { DietChip } from "@/components/diet-chip";
import { FoodIllustration } from "@/components/food-illustration";
import { Icon } from "@/components/icons";
import { Confidence, EvidenceBadge } from "@/components/labels";
import { AddToList } from "@/components/social/add-to-list";
import { Flash } from "@/components/social/bits";
import { MemberActions } from "@/components/member-actions";
import { idSchema } from "@/contracts/catalog";
import { DIARY_NUTRIENTS, MEAL_LABELS, type MealSlot } from "@/contracts/diary";
import { CUISINE_LABELS, recipeOptionsSchema, type Cuisine, type RecipeDetail, type RecipeEligibility } from "@/contracts/recipes";
import { describeDietChoice, familyWord, hasDietChoice, type ConfidenceLabel, type DietChoice } from "@/domain/dietary/labels";
import {
  allergenWord,
  displayName,
  formatMinutes,
  formatServings,
  ingredientLine,
  recipeHref,
  spokenQuantity,
  suitabilityWords,
  swapsFromParams,
  timerWords,
} from "@/domain/recipes/quantity";
import { formatAmount, formatDate } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { CatalogError } from "@/server/catalog";
import { readDietPreference } from "@/server/catalog/diet";
import { memberClock } from "@/server/diary/clock";
import { getMyCooking, getRecipe } from "@/server/recipes";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Recipe" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const NOTES: Record<string, string> = {
  invalid: "We couldn't start with those choices. Check the servings and swaps and try again.",
  excluded: "That swap contains something your dietary filter leaves out, so cooking was not started. Choose a different option.",
  failed: "We couldn't start cooking just now. Please try again.",
  unavailable: "That combination of servings and swaps isn't available. Showing the recipe as written.",
};

/** The dietary result in words for the recipe exactly as shown, swaps included. Unknown is never worded as suitable. */
function fitLabel(e: RecipeEligibility, choice: DietChoice): ConfidenceLabel {
  const dietWord = choice.diet === "vegan" ? "vegan" : "vegetarian";
  if (e.status === "eligible") return { tone: "ok", text: `Fits “${describeDietChoice(choice)}” · stated` };
  if (e.status === "conditional") return { tone: "ask", text: "Only with a change" };
  if (e.status === "excluded") {
    const fam = e.reasons.find((r) => r.code === "contains_excluded_family" || r.code === "contains_family");
    if (fam) return { tone: "no", text: `Contains ${familyWord(fam.family)}${fam.ingredient ? ` (${displayName(fam.ingredient).toLowerCase()})` : ""}` };
    return { tone: "no", text: `Not ${dietWord}${e.reasons[0]?.ingredient ? ` (${displayName(e.reasons[0].ingredient).toLowerCase()})` : ""}` };
  }
  const who = [...new Set(e.reasons.map((r) => r.ingredient).filter(Boolean))].map((n) => displayName(n as string).toLowerCase());
  return { tone: "ask", text: who.length ? `Not confirmed: ${who.join(", ")}` : `Not confirmed for “${describeDietChoice(choice)}”` };
}

function NutritionTable({ recipe }: { recipe: RecipeDetail }) {
  const protein = recipe.nutrients.protein_g;
  // Confidence describes the figures shown in this table.
  const partial = DIARY_NUTRIENTS.some((n) => (recipe.nutrients[n.code]?.value ?? null) === null);
  const demoSource = recipe.source.ingredientSources.some((s) => s?.isDemo) || recipe.source.recipe?.isDemo;
  return (
    <section aria-labelledby="nutrition-h">
      <h2 className="h-sec" id="nutrition-h">
        Nutrition per serving
      </h2>
      <dl className="nutri" data-testid="recipe-nutrition">
        {DIARY_NUTRIENTS.map((n) => {
          const cell = recipe.nutrients[n.code];
          return (
            <div key={n.code} data-testid={`nutrient-${n.code}`}>
              <dt>{n.label}</dt>
              <dd>
                {cell && cell.value !== null ? (
                  <>
                    {formatAmount(cell.value)} {n.unit}
                  </>
                ) : (
                  <span className="accent-text">
                    Not known
                    {cell && cell.missingIngredients > 0 && ` (${cell.missingIngredients} of ${cell.ingredientCount} ingredients have no figure)`}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <details className="src" data-testid="nutrition-source">
        <summary>How these numbers were worked out</summary>
        <div className="src-body stack">
          <p style={{ margin: 0 }}>
            <strong>Method:</strong> calculated. Each ingredient&rsquo;s amount is multiplied by its nutrition figures, the results are added up and divided by {formatServings(recipe.yieldServings)}.
            Nothing is adjusted for cooking losses.{" "}
            {recipe.swapped && <strong data-testid="recalculated">Recalculated for your swaps: the numbers of the recipe as written are not reused.</strong>}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Source:</strong> {recipe.source.recipe?.summary ?? "No source on file."}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Confidence:</strong>{" "}
            {partial
              ? "Partly known. Where an ingredient has no figure, that nutrient is shown as “Not known” for the whole recipe. It is never counted as zero."
              : `Complete for all ${protein?.ingredientCount ?? recipe.ingredients.length} ingredients in use.`}{" "}
            {demoSource ? "The ingredient figures are invented demo values, not laboratory measurements." : ""}{" "}
            {recipe.trialCookedAt ? `Test-cooked ${formatDate(recipe.trialCookedAt)}.` : "This recipe has not been test-cooked and weighed."}
          </p>
        </div>
      </details>
    </section>
  );
}

async function Detail({ params, searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(rawId);
  if (!id.success) notFound();
  const diet = await readDietPreference();
  const requested = recipeOptionsSchema.safeParse({ servings: first(sp.servings) || undefined, swaps: swapsFromParams(sp) });
  let recipe: RecipeDetail;
  let fallback = !requested.success;
  try {
    recipe = await getRecipe(id.data, requested.success ? requested.data : { swaps: {} }, diet);
  } catch (e) {
    if (e instanceof CatalogError && e.status === 404) notFound();
    if (!(e instanceof CatalogError && e.status === 422)) throw e;
    // An address with a swap or serving count that is not allowed: show the recipe as written and say so.
    recipe = await getRecipe(id.data, { swaps: {} }, diet);
    fallback = true;
  }
  const showUnsure = first(sp.unsure) === "1";
  const planId = z.uuid().safeParse(first(sp.plan)).data;
  const here = recipeHref(recipe.foodItemId, { servings: recipe.servings, yieldServings: recipe.yieldServings, swaps: recipe.swaps, unsure: showUnsure, plan: planId });
  const member = await getCurrentMember();
  const clock = await memberClock();
  let open: { sessionId: string; currentStep: number; stepCount: number } | undefined;
  if (member) {
    try {
      open = (await getMyCooking(clock.today)).inProgress.find((s) => s.foodItemId === recipe.foodItemId);
    } catch {
      open = undefined;
    }
  }

  const strict = hasDietChoice(diet);
  const fit = strict ? fitLabel(recipe.eligibility, diet) : null;
  const general = suitabilityWords(recipe.suitability);
  const groups = recipe.ingredients.filter((i) => i.group !== null);
  const used = recipe.ingredients.filter((i) => i.included);
  const extras = recipe.ingredients.filter((i) => !i.included);
  const protein = recipe.nutrients.protein_g;
  const energy = recipe.nutrients.energy_kcal;
  const note = fallback ? NOTES.unavailable : NOTES[first(sp.note) ?? ""];
  const name = displayName(recipe.name);

  return (
    <article>
      <p style={{ margin: "0 0 8px" }}>
        <Link className="link-btn" href="/cook">
          <Icon name="back" className="icon" />
          All recipes
        </Link>
      </p>
      <FoodIllustration name={recipe.name} size="hero" />
      <p className="eyebrow" style={{ marginTop: 16 }}>
        {[recipe.cuisine ? CUISINE_LABELS[recipe.cuisine as Cuisine] : null, ...recipe.mealTypes.map((m) => MEAL_LABELS[m as MealSlot] ?? m)].filter(Boolean).join(" · ")}
        {recipe.isDemo ? " · Demo recipe" : ""}
      </p>
      <h1 className="title" data-testid="recipe-name">
        {name}
      </h1>
      <Fresh food={recipe.foodItemId} block />
      {recipe.description && <p className="lede">{recipe.description}</p>}
      {note && (
        <p className="callout" role="alert" data-testid="recipe-note">
          {note}
        </p>
      )}

      <ul className="facts" aria-label="Key facts">
        <li>
          <div className="k">Protein per serving</div>
          {protein && protein.value !== null ? (
            <>
              <div className="big" data-testid="recipe-protein">
                {formatAmount(protein.value)} g
              </div>
              <EvidenceBadge method={protein.method} known />
            </>
          ) : (
            <>
              <div className="big words" data-testid="recipe-protein">
                Not known
              </div>
              <EvidenceBadge method={null} known={false} />
            </>
          )}
          <div className="s13 muted" data-testid="recipe-energy">
            {energy && energy.value !== null ? `${formatAmount(energy.value)} kcal` : "Calories not known"}
          </div>
        </li>
        <li>
          <div className="k">Time</div>
          <div className="big words">{formatMinutes((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0)) ?? "Not stated"}</div>
          <div className="s13 muted">
            {[recipe.prepMinutes !== null ? `${recipe.prepMinutes} min prep` : null, recipe.cookMinutes ? `${recipe.cookMinutes} min cooking` : null].filter(Boolean).join(" · ")}
          </div>
        </li>
        <li>
          <div className="k">Makes</div>
          <div className="big words" data-testid="recipe-servings">
            {formatServings(recipe.servings)}
          </div>
          {recipe.servingNote && recipe.servings === recipe.yieldServings && <div className="s13 muted">{recipe.servingNote}</div>}
        </li>
      </ul>

      <section className="panel" aria-labelledby="fit-h">
        <h2 className="h-sec" id="fit-h" style={{ marginTop: 0 }}>
          Dietary information
        </h2>
        <div className="row" style={{ marginBottom: 8 }} data-testid="recipe-diet">
          <Confidence label={general} />
          {recipe.families.map((f) => (
            <Confidence key={f} label={{ tone: "ask", text: `Contains ${f.toLowerCase()}` }} />
          ))}
          {recipe.swapped && <span className="s13 muted">with your swaps</span>}
        </div>
        <div className="row">
          <DietChip diet={diet} returnTo={here} />
        </div>
        {fit && (
          <div style={{ marginTop: 8 }} data-testid="recipe-fit" data-status={recipe.eligibility.status}>
            <Confidence label={fit} />
            {recipe.eligibility.status === "excluded" && (
              <p className="callout stop" style={{ marginTop: 8 }}>
                <strong>This recipe{recipe.swapped ? ", with these swaps," : " as written"} does not fit your dietary filter.</strong>{" "}
                {groups.length > 0 ? "Check the swaps below: an approved alternative may make it suitable." : ""}
              </p>
            )}
            {recipe.eligibility.status === "needs_confirmation" && (
              <p className="callout" style={{ marginTop: 8 }}>
                <strong>Not confirmed for your dietary filter.</strong> Check the label of the ingredient named above before relying on it.
              </p>
            )}
          </div>
        )}
        <p className="s14" style={{ margin: "12px 0 0" }} data-testid="recipe-allergens">
          <strong>Allergens in the ingredients:</strong>{" "}
          {recipe.allergens.contains.length ? `contains ${recipe.allergens.contains.map(allergenWord).join(", ")}.` : "none declared."}
          {recipe.allergens.unconfirmed.length > 0 && ` Not confirmed: ${recipe.allergens.unconfirmed.map(allergenWord).join(", ")}.`}
        </p>
        <p className="s13 muted" style={{ margin: "4px 0 0" }}>
          This comes from the ingredient records, not from your own packets. It is not an allergy guarantee: always check the labels of what you buy.
        </p>
      </section>

      <section aria-labelledby="yours-h" className="panel">
        <h2 className="h-sec" id="yours-h" style={{ marginTop: 0 }}>
          Make it yours
        </h2>
        <RecipeAdjust
          recipeId={recipe.foodItemId}
          servings={recipe.servings}
          yieldServings={recipe.yieldServings}
          swaps={recipe.swaps}
          groups={groups}
          showUnsure={showUnsure}
          planId={planId}
        />
        {groups.length === 0 && <p className="s13 muted" style={{ margin: "8px 0 0" }}>This recipe has no approved swaps yet.</p>}
      </section>

      <div className="cook-cta" data-testid="cook-cta">
        {open ? (
          <>
            <Link className="btn primary big" href={`/cook/session/${open.sessionId}`} data-testid="resume-cooking">
              Resume cooking · {open.currentStep === 0 ? "getting ready" : `step ${open.currentStep} of ${open.stepCount}`}
            </Link>
            <form action={startCookAction}>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="foodItemId" value={recipe.foodItemId} />
              <input type="hidden" name="servings" value={recipe.servings} />
              <input type="hidden" name="swaps" value={JSON.stringify(recipe.swaps)} />
              <input type="hidden" name="here" value={here} />
              <input type="hidden" name="replaceSessionId" value={open.sessionId} />
              {planId && <input type="hidden" name="planId" value={planId} />}
              <button className="btn" type="submit" data-testid="start-over">
                Start over with what is shown here
              </button>
            </form>
          </>
        ) : (
          <form action={startCookAction}>
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <input type="hidden" name="foodItemId" value={recipe.foodItemId} />
            <input type="hidden" name="servings" value={recipe.servings} />
            <input type="hidden" name="swaps" value={JSON.stringify(recipe.swaps)} />
            <input type="hidden" name="here" value={here} />
            {planId && <input type="hidden" name="planId" value={planId} />}
            <button className="btn primary big" type="submit" data-testid="start-cooking">
              <Icon name="cook" className="" />
              Start cooking
            </button>
          </form>
        )}
        <p className="s13 muted" style={{ margin: 0 }}>
          {member ? "Step by step, with your place saved. " : "Cooking mode needs an account so your place can be saved. You'll come back here after signing in. "}
          Cooking never adds anything to your diary by itself.
        </p>
      </div>

      <section aria-labelledby="ing-h">
        <h2 className="h-sec" id="ing-h">
          Ingredients <span className="s14 muted">for {formatServings(recipe.servings)}</span>
        </h2>
        <ul className="ingredients" data-testid="ingredients">
          {used.map((i) => {
            const line = ingredientLine(i);
            return (
              <li key={i.id} data-testid="ingredient" data-group={i.group ?? undefined}>
                <span aria-label={spokenQuantity(line)}>{line}</span>
                {i.optional && <span className="tagline">optional</span>}
                {i.group && !i.isDefault && <span className="tagline swap">swapped in</span>}
                {!i.calculable && <span className="tagline warn">amount can&rsquo;t be converted, so it is not in the numbers</span>}
              </li>
            );
          })}
        </ul>
        {extras.length > 0 && (
          <p className="s14 muted" data-testid="extras">
            Optional extras, not included in the numbers: {extras.map((i) => ingredientLine(i)).join("; ")}.
          </p>
        )}
        <h3 className="h-sub">You will need</h3>
        <p style={{ margin: 0 }} data-testid="equipment">
          {recipe.equipment.length ? recipe.equipment.map((e, n) => (n === 0 ? e.charAt(0).toUpperCase() + e.slice(1) : e)).join(", ") : "No special equipment."}
        </p>
      </section>

      <NutritionTable recipe={recipe} />

      <section aria-labelledby="method-h">
        <h2 className="h-sec" id="method-h">
          Method
        </h2>
        <ol className="method" data-testid="method">
          {recipe.steps.map((s) => (
            <li key={s.ordinal}>
              {s.title && <strong>{s.title}. </strong>}
              {s.instruction}
              {s.timerSeconds ? <span className="s13 muted"> About {timerWords(s.timerSeconds)}.</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="keep-h">
        <h2 className="h-sec" id="keep-h">
          Keep it for later
        </h2>
        <details className="sheet" style={{ marginBottom: 12 }} data-testid="plan-sheet">
          <summary>
            <Icon name="diary" />
            Add to week plan
          </summary>
          <div className="sheet-body">
            <PlanForm foodItemId={recipe.foodItemId} servings={recipe.servings} today={clock.today} here={here} mealSlot={recipe.mealTypes.length === 1 ? recipe.mealTypes[0] : undefined} />
          </div>
        </details>
        <MemberActions target={{ foodItemId: recipe.foodItemId }} returnTo={here} outcome={first(sp.saved)} />
        <Flash sp={sp} />
        <AddToList kind="food" id={recipe.foodItemId} returnTo={here} />
        <p className="s14" style={{ marginTop: 16 }}>
          <Link className="link" href={`/diary/log?food=${recipe.foodItemId}`}>
            Ate this without cooking it here? Log a serving as written
          </Link>
        </p>
      </section>

      <Suspense fallback={null}>
        <ReviewsSection kind="food" id={recipe.foodItemId} returnTo={here} recipe />
      </Suspense>
    </article>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="cook" narrow>
      <Suspense fallback={<Loading label="Loading recipe…" />}>
        <Detail {...props} />
      </Suspense>
    </AppShell>
  );
}
