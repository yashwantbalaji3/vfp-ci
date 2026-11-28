import { Suspense } from "react";
import { Fresh } from "@/components/freshness";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { DietChip } from "@/components/diet-chip";
import { FoodIllustration } from "@/components/food-illustration";
import { Icon } from "@/components/icons";
import { Confidence, EvidenceBadge, ProteinFigure } from "@/components/labels";
import { AddToList } from "@/components/social/add-to-list";
import { Flash } from "@/components/social/bits";
import { ReviewsSection } from "@/components/social/reviews-section";
import { MemberActions } from "@/components/member-actions";
import { SourceNote } from "@/components/source-note";
import { idSchema } from "@/contracts/catalog";
import { confidenceLabel, describeDietChoice, presenceLabel } from "@/domain/dietary/labels";
import { KIND_LABELS, amountText, formatAmount, formatDate, formatMoney, methodLabel, priceBand, reasonText, titleCase } from "@/lib/format";
import type { RawParams } from "@/lib/search-params";
import { CatalogError, checkEligibility, getFood, getProteinExplanation } from "@/server/catalog";
import { ProteinExplanationPanel } from "@/components/protein-explanation";
import { readDietPreference } from "@/server/catalog/diet";
import { limitNotice } from "@/components/too-many-requests";
import { pageLimit } from "@/server/page-limit";

export const metadata = { title: "Food details" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };

const MISSING: Record<string, string> = {
  not_provided: "Not provided",
  estimate_hidden: "Estimate hidden",
  not_measured: "Not measured",
};

async function Detail({ params, searchParams }: Props) {
  const refused = limitNotice(await pageLimit());
  if (refused) return refused;
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(rawId);
  if (!id.success) notFound();
  const showEstimates = sp.est === "1";
  const diet = await readDietPreference();
  let food;
  try {
    food = await getFood(id.data, showEstimates);
  } catch (e) {
    if (e instanceof CatalogError && e.status === 404) notFound();
    throw e;
  }
  const [eligibility, explanation] = await Promise.all([checkEligibility(food.revisionId, diet), getProteinExplanation(food.foodItemId, showEstimates)]);
  const here = `/foods/${food.foodItemId}${showEstimates ? "?est=1" : ""}`;
  const stated = food.families.filter((f) => f.presence !== "unknown");
  const unknown = food.families.filter((f) => f.presence === "unknown");
  const hasHiddenEstimate = food.nutrients.some((n) => n.missingReason === "estimate_hidden") || food.protein.perServingReason === "estimate_hidden";
  // A food recorded per 100 g with no serving weight (most ingredients): lead with its per-100 g figures,
  // labelled as such, instead of "not provided". Energy is shown only when the record itself is per 100 g,
  // so nothing is scaled or invented.
  const per100Only = food.protein.perServing === null && food.protein.per100g !== null;
  const energyPer100g =
    per100Only && food.basis.kind === "mass" && Number(food.basis.amount) === 100 && food.basis.unit === "g"
      ? food.nutrients.find((n) => n.code === "energy_kcal" && n.value !== null && n.missingReason === null)
      : undefined;
  const basisWords = food.basis.kind === "serving" ? `per ${food.protein.servingLabel?.replace(/^1 /, "") ?? "serving"}` : `per ${formatAmount(food.basis.amount)} ${food.basis.unit}`;
  const label = eligibility ? confidenceLabel(eligibility.status, eligibility.reasons, diet) : null;
  const price = food.prices[0];

  type Nutrient = (typeof food.nutrients)[number];
  const nutrientText = (n: Nutrient) =>
    n.value !== null
      ? n.code === "protein_g" && explanation?.state === "estimated_range"
        ? amountText(n.value, n.unit, n.method, explanation.low, explanation.high)
        : amountText(n.value, n.unit, n.method)
      : (MISSING[n.missingReason ?? ""] ?? "Not provided");
  // The figures people check first; everything else is one tap away on a phone.
  const keyNutrients = food.nutrients.filter((n) => n.code === "protein_g" || n.code === "energy_kcal");
  const nutritionTable = (
  <div className="table-wrap">
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Nutrient</th>
          <th scope="col">Amount</th>
          <th scope="col">How we know</th>
        </tr>
      </thead>
      <tbody>
        {food.nutrients.map((n) => (
          <tr key={n.code}>
            <th scope="row">{n.name}</th>
            <td className="n">{nutrientText(n)}</td>
            <td>
              {n.value !== null ? (
                <>
                  {methodLabel(n.method)}
                  <SourceNote source={n.source} />
                </>
              ) : (
                <span className="muted">No value on file</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  );

  return (
    <article>
      <FoodIllustration name={food.name} size="hero" />
      <p className="eyebrow" style={{ marginTop: 16 }}>
        {KIND_LABELS[food.kind]}
        {food.isDemo ? " · Demo" : ""}
      </p>
      <h1 className="title" data-testid="food-name">
        {food.name}
      </h1>
      <Fresh food={food.foodItemId} block />
      {food.venue && (
        <p style={{ margin: 0 }}>
          <Link className="link" href={`/venues/${food.venue.id}`}>
            {food.venue.name}
          </Link>
          <span className="muted">
            {[food.venue.neighborhood, priceBand(food.venue.priceBand)].filter(Boolean).map((x) => ` · ${x}`).join("")}
          </span>
        </p>
      )}
      {food.brand && <p className="muted" style={{ margin: 0 }}>{food.brand}</p>}
      {food.venue?.availability && food.venue.availability !== "available" && (
        <p className="callout" style={{ marginTop: 12 }}>This dish is marked {titleCase(food.venue.availability).toLowerCase()} right now.</p>
      )}

      <ul className="facts" aria-label="Key facts">
        <li>
          <div className="k">Protein</div>
          <ProteinFigure protein={food.protein} basis={per100Only ? "100g" : "serving"} large />
          <div>
            <EvidenceBadge method={food.protein.method} known={food.protein.perServing !== null || per100Only} />
          </div>
        </li>
        <li>
          <div className="k">Energy</div>
          {food.protein.energyKcalPerServing !== null ? (
            <>
              <div className="big">{formatAmount(food.protein.energyKcalPerServing)} kcal</div>
              <EvidenceBadge method={food.protein.energyMethod} known />
            </>
          ) : energyPer100g ? (
            <>
              <div className="big">
                {formatAmount(energyPer100g.value as number)} kcal <span className="s13 muted">per 100 g</span>
              </div>
              <EvidenceBadge method={energyPer100g.method} known />
            </>
          ) : (
            <>
              <div className="big words">Not provided</div>
              <EvidenceBadge method={null} known={false} />
            </>
          )}
        </li>
        <li>
          <div className="k">Serving</div>
          <div className="big words">{food.protein.servingLabel ?? "Not stated"}</div>
          <div className="s13 muted">{food.protein.servingGrams !== null ? `${formatAmount(food.protein.servingGrams)} g` : "Weight not provided"}</div>
        </li>
      </ul>

      <section aria-labelledby="fit-h" className="panel">
        <h2 className="h-sec" id="fit-h" style={{ marginTop: 0 }}>
          Does it fit your filter?
        </h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <DietChip diet={diet} returnTo={here} />
        </div>
        {label && eligibility ? (
          <div data-testid="fit-result">
            <Confidence label={label} />
            <p style={{ margin: "8px 0 0" }}>
              {eligibility.status === "eligible" && `The source states this fits ${describeDietChoice(diet).toLowerCase()}.`}
              {eligibility.status === "conditional" && `It fits only with this change: ${label.detail ?? "ask the restaurant"}.`}
              {eligibility.status === "needs_confirmation" &&
                (label.detail
                  ? `It fits only with this change: ${label.detail}`
                  : "Nobody has confirmed this for your filter, so it is not counted as a match. Ask before ordering.")}
              {eligibility.status === "excluded" && "It is hidden from your search results."}
            </p>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            You haven&rsquo;t chosen a dietary filter, so nothing is checked against one.
          </p>
        )}
      </section>

      <section aria-labelledby="diet-h">
        <h2 className="h-sec" id="diet-h">
          Dietary statements
        </h2>
        {food.dietaryClaims.length === 0 && <p className="muted">No vegetarian or vegan statement on file. Treat it as not confirmed.</p>}
        <dl className="deflist">
          {food.dietaryClaims.map((c) => (
            <div key={c.diet}>
              <dt>
                {titleCase(c.diet)}: {c.expired ? "check out of date" : c.outcome === "compatible" ? "stated suitable" : c.outcome === "conditional" ? "only with a change" : c.outcome === "incompatible" ? "not suitable" : "not confirmed"}
              </dt>
              <dd>
                {c.modifications && <p style={{ margin: 0 }}>Change needed: {c.modifications}</p>}
                {c.conflictState && c.conflictState !== "none" && <p style={{ margin: 0 }}>Sources disagree about this.</p>}
                <SourceNote source={c.source} checkedAt={c.checkedAt} expiresAt={c.expiresAt} label="Who says so, and when" />
              </dd>
            </div>
          ))}
        </dl>
        <h3 className="s14" style={{ margin: "16px 0 8px" }}>
          Ingredients people often avoid
        </h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
          {stated.map((f) => (
            <li key={f.family}>
              <Confidence label={presenceLabel(f.presence, f.label)} />
              {f.detail && <span className="s14 muted"> {f.detail}</span>}
              <SourceNote source={f.source} checkedAt={f.checkedAt} expiresAt={f.expiresAt} />
            </li>
          ))}
        </ul>
        {unknown.length > 0 && (
          <p className="s14" style={{ marginTop: 8 }} data-testid="unknown-families">
            <strong>Not confirmed:</strong> {unknown.map((f) => f.label.toLowerCase()).join(", ")}. Not confirmed means nobody has
            stated it either way.
          </p>
        )}
        <h3 className="s14" style={{ margin: "16px 0 8px" }}>
          Allergens and cross-contact
        </h3>
        {food.allergens.length === 0 ? (
          <p className="s14 muted" style={{ margin: 0 }}>
            No allergen or cross-contact statement on file. This page is never an allergy-safety guarantee.
          </p>
        ) : (
          <ul className="s14">
            {food.allergens.map((a) => (
              <li key={a.allergen}>
                {titleCase(a.allergen)}: {titleCase(a.presence).toLowerCase()}
                {a.crossContact ? ` · cross-contact: ${titleCase(a.crossContact).toLowerCase()}` : ""}
                {formatDate(a.checkedAt) ? ` · checked ${formatDate(a.checkedAt)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="nut-h">
        <h2 className="h-sec" id="nut-h">
          Nutrition <span className="s14 muted">({basisWords})</span>
        </h2>
        {food.nutrients.length > 0 && (
          <>
            {/* Wide screens: the full table. Narrow screens (320–430 px): the key figures stay visible and the
                full table folds into a details panel, so the page is not a long table before "Log this". */}
            <div className="nut-wide">{nutritionTable}</div>
            <div className="nut-narrow">
              <dl className="nut-key" data-testid="nutrition-key">
                {keyNutrients.map((n) => (
                  <div key={n.code}>
                    <dt>{n.name}</dt>
                    <dd>{nutrientText(n)}</dd>
                  </div>
                ))}
              </dl>
              <details className="sheet" data-testid="nutrition-details" open={showEstimates || undefined}>
                <summary>All nutrition details ({food.nutrients.length} values, with sources)</summary>
                <div className="sheet-body">{nutritionTable}</div>
              </details>
            </div>
          </>
        )}
        {food.nutrients.length === 0 && <p className="muted">No nutrition values are on file for this item. We don&rsquo;t fill the gap with guesses.</p>}
        {hasHiddenEstimate && !showEstimates && (
          <p className="s14">
            Some values here are estimates and are hidden by default.{" "}
            <Link className="link" href={`/foods/${food.foodItemId}?est=1`}>
              Show estimated values
            </Link>
          </p>
        )}
        {showEstimates && (
          <p className="s14">
            Estimated values are shown and labelled &ldquo;Estimated&rdquo;.{" "}
            <Link className="link" href={`/foods/${food.foodItemId}`}>
              Hide estimates
            </Link>
          </p>
        )}
        {food.protein.per100g === null && food.protein.per100gReason && (
          <p className="s14 muted">Per 100 g comparison unavailable: {reasonText(food.protein.per100gReason).toLowerCase()}.</p>
        )}
      </section>

      <ProteinExplanationPanel explanation={explanation} showEstimatesHref={`/foods/${food.foodItemId}?est=1#how-h`} />

      <section aria-labelledby="portion-h">
        <h2 className="h-sec" id="portion-h">
          Portions{price ? " and price" : ""}
        </h2>
        <ul className="s14" style={{ paddingLeft: 20, margin: 0 }}>
          {food.portions.map((p) => (
            <li key={p.id}>
              {p.label} {p.grams !== null ? `(${formatAmount(p.grams)} g)` : "(weight not provided)"}
            </li>
          ))}
        </ul>
        {food.portions.length === 0 && <p className="s14 muted">No portion sizes on file.</p>}
        {price && (
          <p className="s14" style={{ marginBottom: 0 }}>
            {formatMoney(price.amountMinor, price.currency)}
            {price.servingDescription ? ` for ${price.servingDescription}` : ""}
            {formatDate(price.checkedAt) ? ` · price checked ${formatDate(price.checkedAt)}` : " · check date not recorded"}
          </p>
        )}
        <p style={{ marginBottom: 0 }}>
          <Link className="btn primary" href={`/diary/log?food=${food.foodItemId}`} data-testid="log-this">
            <Icon name="diary" className="" />
            Log this
          </Link>
        </p>
        <p className="s13 muted" style={{ marginTop: 6 }}>Adds it to your private diary. You choose the portion on the next screen.</p>
      </section>

      {food.recipe && (
        <section aria-labelledby="recipe-h">
          <h2 className="h-sec" id="recipe-h">
            Recipe
          </h2>
          <p className="s14 muted" style={{ marginTop: 0 }}>
            {[
              food.recipe.yieldServings !== null ? `Makes ${formatAmount(food.recipe.yieldServings)} servings` : null,
              food.recipe.prepMinutes !== null ? `${food.recipe.prepMinutes} min prep` : null,
              food.recipe.cookMinutes !== null ? `${food.recipe.cookMinutes} min cooking` : null,
              food.recipe.trialCookedAt ? `test-cooked ${formatDate(food.recipe.trialCookedAt)}` : null,
            ].filter(Boolean).join(" · ")}
          </p>
          <p>
            <Link className="btn" href={`/cook/${food.foodItemId}`} data-testid="open-recipe">
              <Icon name="cook" className="" />
              Open the recipe
            </Link>
          </p>
          <p className="s13 muted" style={{ marginTop: 6 }}>Ingredients, swaps, servings and step-by-step cooking.</p>
        </section>
      )}

      <section aria-labelledby="next-h">
        <h2 className="h-sec" id="next-h">
          What next
        </h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <Link className="btn" href={`/protein?compare=${food.foodItemId}`}>
            <Icon name="protein" className="" />
            Compare protein
          </Link>
          {food.venue && (
            <Link className="btn" href={`/venues/${food.venue.id}`}>
              <Icon name="pin" className="" />
              About {food.venue.name}
            </Link>
          )}
        </div>
        <Suspense fallback={<Loading />}>
          <MemberActions target={{ foodItemId: food.foodItemId }} returnTo={here} outcome={typeof sp.saved === "string" ? sp.saved : undefined} />
        </Suspense>
        {food.kind !== "ingredient" && (
          <Suspense fallback={null}>
            <AddToList kind="food" id={food.foodItemId} returnTo={here} />
          </Suspense>
        )}
      </section>
      <Flash sp={sp} />
      {food.kind === "dish" && (
        <Suspense fallback={<Loading />}>
          <ReviewsSection kind="food" id={food.foodItemId} returnTo={here} />
        </Suspense>
      )}
      <p className="s13 muted" style={{ marginTop: 24 }}>
        Version {food.revisionNo}
        {formatDate(food.publishedAt) ? ` · published ${formatDate(food.publishedAt)}` : ""}. Dietary and nutrition information comes from the
        sources shown and can change; it is not medical or allergy advice.
      </p>
    </article>
  );
}

export default function FoodPage(props: Props) {
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
