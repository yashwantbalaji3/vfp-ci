import { Suspense } from "react";
import Link from "next/link";
import { z } from "zod";
import { AppShell, Loading } from "@/components/app-shell";
import { RecipeCard } from "@/components/cook/recipe-card";
import { DietChip } from "@/components/diet-chip";
import { Icon } from "@/components/icons";
import { MEAL_LABELS, MEAL_SLOTS } from "@/contracts/diary";
import { CUISINES, CUISINE_LABELS, HIGH_PROTEIN_G, RECIPE_VIEWS, recipeFiltersSchema, type RecipeFilters } from "@/contracts/recipes";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import { displayName, formatServings, recipeHref } from "@/domain/recipes/quantity";
import { formatDay } from "@/lib/format";
import { hrefWith, type RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { memberClock } from "@/server/diary/clock";
import { getMyCooking, getPlan, listRecipes } from "@/server/recipes";
import { addDays } from "@/domain/dates/week";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Recipes" };
type Props = { searchParams: Promise<RawParams> };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined => {
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
};

function parse(sp: RawParams): RecipeFilters {
  return recipeFiltersSchema.parse({
    q: first(sp.q)?.trim().slice(0, 120) || undefined,
    meal: pick(z.enum(MEAL_SLOTS), first(sp.meal)),
    cuisine: pick(z.enum(CUISINES), first(sp.cuisine)),
    highProtein: first(sp.protein) === "high",
    view: pick(z.enum(RECIPE_VIEWS), first(sp.view)) ?? "matches",
  });
}

const NOTES: Record<string, string> = {
  cooked: "Saved as cooked. Nothing was added to your diary. You can add it later from “Cooked recently”.",
  stopped: "Cooking session stopped. Nothing was logged.",
  gone: "That recipe or cooking session is no longer available.",
};

/** The member's own cooking: sessions to resume, meals cooked but not logged, and what is planned next. Private. */
async function Mine() {
  const member = await getCurrentMember();
  if (!member) return null;
  const clock = await memberClock();
  let cooking, plan;
  try {
    [cooking, plan] = await Promise.all([getMyCooking(clock.today), getPlan(clock.today, addDays(clock.today, 6))]);
  } catch {
    return null;
  }
  const toLog = cooking.recent.filter((r) => r.loggedServings === 0).slice(0, 3);
  const upcoming = plan.filter((p) => !p.cooked).slice(0, 3);
  if (!cooking.inProgress.length && !toLog.length && !upcoming.length) return null;
  return (
    <section className="panel mine" aria-labelledby="mine-h" data-testid="my-cooking">
      <h2 className="h-sec" id="mine-h" style={{ marginTop: 0 }}>
        Your kitchen
      </h2>
      <ul className="mine-list">
        {cooking.inProgress.map((s) => (
          <li key={s.sessionId} data-testid="resume-row">
            <div>
              <strong>{displayName(s.name)}</strong>
              <span className="s14 muted">
                {s.currentStep === 0 ? "Getting ready" : `Step ${s.currentStep} of ${s.stepCount}`} · {formatServings(s.servings)}
              </span>
            </div>
            <Link className="btn primary" href={`/cook/session/${s.sessionId}`}>
              Resume<span className="sr-only"> cooking {displayName(s.name)}</span>
            </Link>
          </li>
        ))}
        {toLog.map((s) => (
          <li key={s.sessionId} data-testid="cooked-row">
            <div>
              <strong>{displayName(s.name)}</strong>
              <span className="s14 muted">Cooked {formatDay(s.date, "short")} · not in your diary</span>
            </div>
            <Link className="btn" href={`/cook/session/${s.sessionId}/done`}>
              Add to diary<span className="sr-only">: {displayName(s.name)}</span>
            </Link>
          </li>
        ))}
        {upcoming.map((p) => (
          <li key={p.planId} data-testid="planned-row">
            <div>
              <strong>{displayName(p.name)}</strong>
              <span className="s14 muted">
                Planned for {p.date === clock.today ? "today" : formatDay(p.date, "short")}
                {p.mealSlot ? ` · ${MEAL_LABELS[p.mealSlot as keyof typeof MEAL_LABELS].toLowerCase()}` : ""}
              </span>
            </div>
            <Link className="btn" href={`/cook/${p.foodItemId}?servings=${p.servings}&plan=${p.planId}`}>
              Open<span className="sr-only"> {displayName(p.name)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="s13 muted" style={{ margin: "8px 0 0" }}>
        Only you can see this. Planned and cooked meals are not counted as eaten.
      </p>
    </section>
  );
}

async function Library({ searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const sp = await searchParams;
  const filters = parse(sp);
  const diet = await readDietPreference();
  let result;
  try {
    result = await listRecipes(filters, diet);
  } catch {
    return (
      <div className="callout stop" role="alert">
        <strong>We couldn&rsquo;t load recipes just now.</strong> Nothing is wrong on your side. <Link href={hrefWith("/cook", sp, {})}>Try again</Link>
      </div>
    );
  }
  const strict = hasDietChoice(diet);
  const inNeeds = filters.view === "needs_confirmation";
  const note = NOTES[first(sp.note) ?? ""];
  const keep = { note: null };
  const shown = inNeeds ? result.counts.needsConfirmation : result.counts.matches;
  const filtered = Boolean(filters.q || filters.meal || filters.cuisine || filters.highProtein);

  return (
    <>
      {note && (
        <p className="callout calm" role="status" data-testid="cook-note">
          {note}
        </p>
      )}
      <div className="stack">
        <div className="chips scroll">
          <DietChip diet={diet} returnTo={hrefWith("/cook", sp, keep)} />
          <Link className="chip" href="/cook/plan">
            <Icon name="diary" className="" />
            Week plan
          </Link>
          <Link className="chip" href="/saved">
            <Icon name="save" className="" />
            Saved
          </Link>
        </div>
        <form action="/cook" method="get" role="search" className="searchbar">
          <label htmlFor="recipe-q" className="sr-only">
            Search recipes
          </label>
          <input id="recipe-q" name="q" type="search" defaultValue={filters.q ?? ""} placeholder="Recipe or ingredient" maxLength={120} enterKeyHint="search" />
          {filters.meal && <input type="hidden" name="meal" value={filters.meal} />}
          {filters.cuisine && <input type="hidden" name="cuisine" value={filters.cuisine} />}
          {filters.highProtein && <input type="hidden" name="protein" value="high" />}
          <button className="btn primary" type="submit">
            Search
          </button>
        </form>
        <nav aria-label="Meal" className="chips scroll">
          <Link className="chip" href={hrefWith("/cook", sp, { ...keep, meal: null })} aria-current={!filters.meal ? "true" : undefined}>
            All meals
          </Link>
          {MEAL_SLOTS.map((m) => (
            <Link key={m} className="chip" href={hrefWith("/cook", sp, { ...keep, meal: m })} aria-current={filters.meal === m ? "true" : undefined}>
              {MEAL_LABELS[m]}
            </Link>
          ))}
        </nav>
        <nav aria-label="Style of cooking and protein" className="chips scroll">
          {CUISINES.map((c) => (
            <Link
              key={c}
              className="chip"
              href={hrefWith("/cook", sp, { ...keep, cuisine: filters.cuisine === c ? null : c })}
              aria-current={filters.cuisine === c ? "true" : undefined}
            >
              {CUISINE_LABELS[c]}
            </Link>
          ))}
          <Link
            className="chip"
            href={hrefWith("/cook", sp, { ...keep, protein: filters.highProtein ? null : "high" })}
            aria-current={filters.highProtein ? "true" : undefined}
            data-testid="high-protein-chip"
          >
            {HIGH_PROTEIN_G} g protein or more
          </Link>
        </nav>
      </div>

      {strict && (
        <nav className="seg" aria-label="Dietary view" style={{ marginTop: 16 }}>
          <Link href={hrefWith("/cook", sp, { ...keep, view: null })} aria-current={!inNeeds ? "true" : undefined}>
            Confirmed matches ({result.counts.matches})
          </Link>
          <Link href={hrefWith("/cook", sp, { ...keep, view: "needs_confirmation" })} aria-current={inNeeds ? "true" : undefined}>
            Needs confirmation ({result.counts.needsConfirmation})
          </Link>
        </nav>
      )}

      <h2 className="h-sec" data-testid="recipes-heading" aria-live="polite">
        {strict
          ? inNeeds
            ? `${shown} ${shown === 1 ? "recipe needs" : "recipes need"} confirmation`
            : `${shown} confirmed ${shown === 1 ? "match" : "matches"}`
          : `${shown} ${shown === 1 ? "recipe" : "recipes"}`}
      </h2>
      {strict && (
        <p className="s14 muted" style={{ marginTop: 0 }} data-testid="recipe-filter-note">
          {inNeeds
            ? `These recipes have an ingredient we could not confirm for “${describeDietChoice(diet)}”. Check the ingredients yourself before cooking.`
            : `Showing only recipes confirmed for “${describeDietChoice(diet)}”.`}
          {result.counts.hidden > 0 &&
            ` ${result.counts.hidden} ${result.counts.hidden === 1 ? "recipe is" : "recipes are"} hidden because ${result.counts.hidden === 1 ? "it contains" : "they contain"} something you leave out.`}
          {!inNeeds && result.counts.canBeMade > 0 && ` ${result.counts.canBeMade} can be made to fit with approved swaps: see below.`}
        </p>
      )}
      {result.counts.notComparable > 0 && (
        <p className="s14 muted" data-testid="not-comparable">
          {result.counts.notComparable} {result.counts.notComparable === 1 ? "recipe is" : "recipes are"} left out of the protein filter because {result.counts.notComparable === 1 ? "its" : "their"}{" "}
          protein is not known.
        </p>
      )}

      {result.items.length === 0 ? (
        <div className="panel" data-testid="recipes-empty">
          <p style={{ marginTop: 0 }}>
            <strong>{filtered ? "No recipes match this search." : inNeeds ? "Nothing needs confirmation." : "No recipes yet."}</strong>
          </p>
          <p className="muted">
            {filtered
              ? "Try a different meal or style of cooking. We never fill gaps with recipes that don't fit your dietary filter."
              : "Recipes will appear here as they are added."}
          </p>
          {filtered && (
            <Link className="btn" href="/cook">
              Show all recipes
            </Link>
          )}
        </div>
      ) : (
        <ul className="cards feature">
          {result.items.map((r) => (
            <RecipeCard key={r.foodItemId} recipe={r} diet={diet} />
          ))}
        </ul>
      )}

      {strict && !inNeeds && result.canBeMade.length > 0 && (
        <section aria-labelledby="can-be-made-h" data-testid="can-be-made" style={{ marginTop: 24 }}>
          <h2 className="h-sec" id="can-be-made-h">
            {diet.diet !== "none" && diet.exclusions.length === 0 ? `Can be made ${diet.diet}` : `Can be made to fit \u201c${describeDietChoice(diet)}\u201d`} ({result.counts.canBeMade})
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            These recipes don&rsquo;t fit as written. With the swaps named, every ingredient is confirmed for your filter. They are not counted as matches above.
          </p>
          <ul className="entries">
            {result.canBeMade.map((r) => (
              <li key={r.foodItemId} className="entry" data-testid="can-be-made-row">
                <div className="entry-main">
                  <Link className="name link" href={recipeHref(r.foodItemId, { swaps: r.swaps })}>
                    {r.name}
                  </Link>
                  <div className="s14">
                    Swap {r.swapNames.map((n) => `${n.from} for ${n.to}`).join(", and ")}.
                  </div>
                  <div className="s13 muted">Not suitable as written. Opens with these swaps chosen.</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function Page(props: Props) {
  return (
    <AppShell active="cook">
      <p className="eyebrow">Cook at home</p>
      <h1 className="title">Recipes</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Change the servings, swap an ingredient, then cook one step at a time.
      </p>
      <Suspense fallback={null}>
        <Mine />
      </Suspense>
      <Suspense fallback={<Loading label="Loading recipes…" />}>
        <Library {...props} />
      </Suspense>
    </AppShell>
  );
}
