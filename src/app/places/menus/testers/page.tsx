import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { MealListSkeleton } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { mealFit } from "@/contracts/meal-eligibility";
import type { PreviewMeal } from "@/contracts/menu-preview";
import { areaProgress, CHECK_KEYS, CHECK_WORDS, failing, prioritise, testerState, type TesterRow, type TesterState } from "@/contracts/tester-meals";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPreviewAudience, getPreviewPlaces, type PreviewPlace } from "@/server/catalog/menu-preview";
import { getTesterQueue } from "@/server/catalog/tester-meals";
import { getMenuPlace } from "@/server/catalog/menu-review";
import type { MenuFact, MenuPlace } from "@/contracts/menu-review";
import { approveCleanMealsAction, decideTesterMealAction } from "./actions";

export const metadata = { title: "Meals for invited testers (private)", robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type View = TesterState | "suggested";
const VIEWS: { key: View; label: string }[] = [
  { key: "suggested", label: "Suggested first set" },
  { key: "ready", label: "All ready to decide" },
  { key: "included", label: "Included" },
  { key: "left_out", label: "Left out" },
  { key: "not_eligible", label: "Not eligible" },
];
const MESSAGES: Record<string, string> = {
  included: "Approved for testers. Testers would see this meal once the member beta is switched on. Its facts stay unverified.",
  left_out: "Rejected. Testers will not see this meal.",
};
/** docs/80: about 30 meals, at most 15 from one restaurant, meals with a printed protein figure first. */
// The first review set (owner decision 24 Nov 2026 17:45 UTC): 15 to 30 meals, as many restaurants and areas as possible.
const PER_PLACE = 6;
const FIRST_SET = 30;
const BATCH_MAX = 30;
const printed = (m: PreviewMeal) => m.protein.basis === "published" || m.protein.basis === "published_range";
const ERRORS: Record<string, string> = {
  CHECKS_FAIL: "Not included: a check no longer passes.",
  LIMIT_REACHED: "Not included: the tester set already holds 75 meals. Leave one out first.",
  FOUNDER_ONLY: "Only the founder can choose tester meals.",
  BAD_REASON: "The note must be between 3 and 300 characters.",
};

type Row = TesterRow & { meal: PreviewMeal; place: PreviewPlace; conflict: boolean; state: TesterState };

async function Testers({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/menus/testers">
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const [audience, places, queue] = await Promise.all([getPreviewAudience(), getPreviewPlaces(), getTesterQueue()]);
  if (audience !== "founder" || !places || !queue) notFound();
  const meals = new Map(places.flatMap((p) => p.meals.map((m) => [m.dishId, { m, p }] as const)));
  const rows: Row[] = queue.meals.flatMap((r) => {
    const hit = meals.get(r.dishId);
    if (!hit) return [];
    const conflict = mealFit(hit.m.evidence, { diet: "vegetarian", exclusions: [] }).status === "ineligible";
    const state = conflict && !r.included ? "not_eligible" : testerState(r);
    return [{ ...r, meal: hit.m, place: hit.p, conflict, state }];
  });
  const view: View = VIEWS.find((v) => v.key === one(sp.view))?.key ?? "suggested";
  // The suggested first set (owner directive 24 Nov 2026 14:59 UTC, 2C): ready meals that add the most variety and the
  // strongest evidence first (a restaurant or area testers don't have yet, the restaurant's own vegan or no-egg words,
  // listed ingredients, a printed protein figure, a fresh menu), at most PER_PLACE per restaurant.
  const includedByPlace = new Map<string, number>();
  const includedByArea = new Map<string, number>();
  for (const r of rows.filter((x) => x.included)) {
    includedByPlace.set(r.placeId, (includedByPlace.get(r.placeId) ?? 0) + 1);
    const a = r.place.area?.trim() || "";
    if (a) includedByArea.set(a, (includedByArea.get(a) ?? 0) + 1);
  }
  const ranked = prioritise(
    rows
      .filter((r) => r.state === "ready")
      .map((r) => ({
        ...r,
        label: r.meal.label,
        area: r.place.area,
        veganStated: r.meal.evidence.veganClaim === "yes",
        eggFreeStated: false,
        ingredientsListed: (r.meal.evidence.ingredients?.length ?? 0) > 0,
        proteinPrinted: printed(r.meal),
        checkedOn: r.meal.checkedOn,
      })),
    { includedByPlace, includedByArea, today: new Date().toISOString().slice(0, 10) },
    PER_PLACE,
    FIRST_SET,
  );
  const priorityOf = new Map(ranked.map((r, i) => [r.dishId, { rank: i, reasons: r.priority.reasons }]));
  const suggested = new Set(ranked.map((r) => r.dishId));
  const inView = (r: Row, v: View) => (v === "suggested" ? suggested.has(r.dishId) : r.state === v);
  const count = (v: View) => rows.filter((r) => inView(r, v)).length;
  const included = rows.filter((r) => r.included);
  const progress = areaProgress(rows, places);
  const shown = rows.filter((r) => inView(r, view));
  const byPlace = [...new Set(shown.map((r) => r.placeId))]
    .map((id) => ({ place: shown.find((r) => r.placeId === id)!.place, rows: shown.filter((r) => r.placeId === id).sort((a, b) => (view === "suggested" ? (priorityOf.get(a.dishId)?.rank ?? 1e9) - (priorityOf.get(b.dishId)?.rank ?? 1e9) : 0) || a.meal.label.localeCompare(b.meal.label)) }))
    .sort((a, b) =>
      view === "suggested"
        ? Math.min(...a.rows.map((r) => priorityOf.get(r.dishId)?.rank ?? 1e9)) - Math.min(...b.rows.map((r) => priorityOf.get(r.dishId)?.rank ?? 1e9))
        : b.rows.length - a.rows.length || a.place.name.localeCompare(b.place.name),
    );
  // Fact-by-fact evidence for every shown meal (owner direction 24 Nov 2026 20:53 UTC, item 1): each fact with its
  // source page, the date it was read and what the automatic comparison found. Read-only; founder-only function.
  const menus = await Promise.all(byPlace.map(({ place }) => getMenuPlace(place.placeId).catch(() => null)));
  const factsOf = new Map<string, DishFacts>();
  for (const mp of menus) {
    if (!mp) continue;
    const src = new Map(mp.sources.map((x) => [x.sourceId, x]));
    for (const d of mp.dishes) factsOf.set(d.dishId, { facts: d.facts, src });
  }
  const set = view === "suggested" ? shown : [];
  const sheet = {
    meals: set.length,
    restaurants: new Set(set.map((r) => r.placeId)).size,
    areas: new Set(set.map((r) => r.place.area ?? "")).size,
    vegan: set.filter((r) => r.meal.evidence.veganClaim === "yes").length,
    printedProtein: set.filter((r) => printed(r.meal)).length,
    usda: set.filter((r) => r.meal.protein.basis === "usda_range").length,
    ingredients: set.filter((r) => (r.meal.evidence.ingredients?.length ?? 0) > 0).length,
    needsLook: set.filter((r) => conflictsOf(r).length > 0 || r.meal.evidence.unclear.length > 0).length,
    notFound: set.filter((r) => r.meal.machine.notFound > 0).length,
  };
  const batch = /^batch_(\d+)_(\d+)$/.exec(one(sp.m) ?? "");
  const msg = batch
    ? `Approved ${batch[1]} clean meals for testers.${batch[2] !== "0" ? ` ${batch[2]} could not be approved (a check no longer passes, or the set is full); they are still listed.` : ""} Their facts stay unverified.`
    : MESSAGES[one(sp.m) ?? ""];
  const err = one(sp.e) ? (ERRORS[one(sp.e)!] ?? "That didn't work. Nothing was changed.") : null;
  return (
    <>
      <p className="callout" data-testid="testers-status">
        <strong>Nothing here is visible to anyone else yet.</strong> The member beta switch is {queue.betaOn ? "ON" : "off"}
        {queue.mode === "whole_place" ? " and set to show every eligible meal of an enrolled restaurant, not only the meals you include." : "."} Including a meal does not confirm it: its
        facts keep their &ldquo;unverified&rdquo; label, and it drops out by itself if a check stops passing. Showing the set to testers is your separate publication decision.
      </p>
      {msg && (
        <p className="callout ok" role="status" data-testid="testers-message">
          {msg}
        </p>
      )}
      {err && (
        <p className="callout stop" role="alert" data-testid="testers-error">
          {err}
        </p>
      )}
      <section className="panel" data-testid="testers-summary" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {included.length} of up to {queue.limit} meals included, at {new Set(included.map((r) => r.placeId)).size} restaurants
        </h2>
        {progress.length === 0 ? (
          <p className="muted s14" style={{ marginBottom: 0 }}>
            No meal is included yet. The launch minimum is 3 restaurants with at least 3 included meals each, and 2 or more cuisines, in each launch neighbourhood.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data" data-testid="testers-progress">
              <thead>
                <tr>
                  <th scope="col">Neighbourhood</th>
                  <th scope="col">Meals</th>
                  <th scope="col">Restaurants with 3+</th>
                  <th scope="col">Cuisines</th>
                  <th scope="col">Launch minimum</th>
                </tr>
              </thead>
              <tbody>
                {progress.map((a) => (
                  <tr key={a.area}>
                    <th scope="row">{a.area}</th>
                    <td className="n">{a.meals}</td>
                    <td className="n">{a.strongRestaurants}</td>
                    <td className="n">{a.cuisines}</td>
                    <td>{a.meetsMinimum ? "Met" : `Not yet (needs 3 restaurants and 2 cuisines)`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {view === "suggested" && sheet.meals > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="data" data-testid="testers-sheet">
            <caption className="s14" style={{ textAlign: "left" }}>The first set at a glance</caption>
            <tbody>
              <tr><th scope="row">Meals / restaurants / neighbourhoods</th><td className="n">{sheet.meals} / {sheet.restaurants} / {sheet.areas}</td></tr>
              <tr><th scope="row">The restaurant says vegan</th><td className="n">{sheet.vegan}</td></tr>
              <tr><th scope="row">Protein printed by the restaurant / USDA estimate only</th><td className="n">{sheet.printedProtein} / {sheet.usda}</td></tr>
              <tr><th scope="row">Ingredients listed</th><td className="n">{sheet.ingredients}</td></tr>
              <tr><th scope="row">Need a closer look (a conflict, an unclear word or a check)</th><td className="n">{sheet.needsLook}</td></tr>
              <tr><th scope="row">A drafted fact was not found on the saved page</th><td className="n">{sheet.notFound}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      {view === "suggested" && byPlace.length > 0 && (
        <p className="s14" data-testid="testers-suggested-help">
          <strong>{count("suggested")} meals to review</strong> at {byPlace.length} restaurants, numbered in review order. Every check passes. Each pick goes to a
          restaurant or area the set doesn&rsquo;t have yet where it can, then to the restaurant&rsquo;s own vegan words, listed ingredients and printed protein. At most {FIRST_SET} meals, and no
          restaurant has more than {PER_PLACE}. For each one, read the restaurant&rsquo;s own words and the source, then approve or reject it. Approving lets invited testers
          see it; it does not verify any fact for you.
        </p>
      )}
      {view === "suggested" && (() => {
        const clean = shown.filter(isClean).sort((a, b) => (priorityOf.get(a.dishId)?.rank ?? 1e9) - (priorityOf.get(b.dishId)?.rank ?? 1e9)).slice(0, BATCH_MAX);
        if (clean.length < 2) return null;
        return (
          <form action={approveCleanMealsAction} className="panel" data-testid="testers-batch">
            <input type="hidden" name="view" value="suggested" />
            {clean.map((r) => (
              <input key={r.dishId} type="hidden" name="dishId" value={r.dishId} />
            ))}
            <p style={{ marginTop: 0 }}>
              <strong>{clean.length} of these meals are clean:</strong> every check passes, no conflict, no unclear ingredient word. You can approve them
              together after reading the list. The others need a look one by one.
            </p>
            <details>
              <summary>The {clean.length} meals</summary>
              <ul className="s14">
                {clean.map((r) => (
                  <li key={r.dishId} data-testid="testers-batch-item">
                    {r.meal.label} · {r.place.name}
                    {priorityOf.get(r.dishId)?.reasons.length ? <span className="muted"> ({priorityOf.get(r.dishId)!.reasons.join(", ")})</span> : null}
                  </li>
                ))}
              </ul>
            </details>
            <button className="btn primary" type="submit" data-testid="testers-batch-approve" style={{ marginTop: 8 }}>
              Approve these {clean.length} for testers
            </button>
          </form>
        );
      })()}
      <nav className="seg" aria-label="Show meals" style={{ marginBottom: 12 }} data-testid="testers-views">
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/places/menus/testers?view=${v.key}`} aria-current={view === v.key ? "true" : undefined} data-testid={`testers-view-${v.key}`}>
            {v.label} ({count(v.key)})
          </Link>
        ))}
      </nav>
      {byPlace.length === 0 ? (
        <div className="empty" data-testid="testers-none">
          <h3>No meals here</h3>
          <p>{view === "ready" || view === "suggested" ? "Every meal that passes all the checks has been decided." : "Nothing in this group yet."}</p>
        </div>
      ) : (
        byPlace.map(({ place, rows: rs }) => (
          <details key={place.placeId} className="panel" data-testid="testers-place" open={byPlace.length <= 3} style={{ marginBottom: 10 }}>
            <summary>
              <strong>{place.name}</strong>{" "}
              <span className="muted">
                · {place.area ?? "area not recorded"} · {rs.length} {rs.length === 1 ? "meal" : "meals"}
              </span>
            </summary>
            <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
              {rs.map((r) => (
                <MealRow key={r.dishId} r={r} view={view} why={view === "suggested" ? priorityOf.get(r.dishId) : undefined} facts={factsOf.get(r.dishId)} />
              ))}
            </ul>
          </details>
        ))
      )}
      <p className="s14 muted">
        Checks, all required: {CHECK_KEYS.map((k) => CHECK_WORDS[k].pass.toLowerCase()).join("; ")}; and no listed ingredient conflicts with vegetarian. <Link href="/places/menus">Back to restaurants with menus</Link>
      </p>
    </>
  );
}

const CLAIM: Record<string, string> = { yes: "says yes", no: "says no" };

/** Anything that should make the founder look twice: a conflict, a "no", or an automatic check that wants a look. */
function conflictsOf(r: Row): string[] {
  const e = r.meal.evidence;
  return [
    ...(r.conflict ? ["A listed ingredient conflicts with vegetarian"] : []),
    ...(e.namesMeat ? ["Its name or ingredients name meat or fish"] : []),
    ...(e.vegetarianClaim === "no" || e.veganClaim === "no" ? ["The restaurant says no for a diet"] : []),
    ...r.meal.autoChecks.filter((c) => c.level === "check").map((c) => c.words),
  ];
}
/** Clean: every check passes, nothing above, no unclear ingredient word. These may be approved together. */
const isClean = (r: Row) => r.state === "ready" && conflictsOf(r).length === 0 && r.meal.evidence.unclear.length === 0;

/** What the founder needs to decide one meal: the restaurant's own words, the lists, conflicts and the source. */
function Evidence({ r }: { r: Row }) {
  const e = r.meal.evidence;
  const claims = [
    e.vegetarianClaim ? `Vegetarian: the restaurant ${CLAIM[e.vegetarianClaim]}` : "Vegetarian: not stated",
    e.veganClaim ? `Vegan: the restaurant ${CLAIM[e.veganClaim]}` : "Vegan: not stated",
  ];
  const lists = [...new Set(e.found.map((f) => f.family))];
  const conflicts = conflictsOf(r);
  let host: string | null = null;
  try {
    host = r.meal.sourceUrl ? new URL(r.meal.sourceUrl).hostname.replace(/^www\./, "") : null;
  } catch {
    host = null;
  }
  const m = r.meal.machine;
  return (
    <div className="s14" style={{ margin: "6px 0", display: "grid", gap: 2 }} data-testid="testers-evidence">
      <p style={{ margin: 0 }}>
        <strong>Restaurant&rsquo;s own words:</strong> {claims.join(" · ")}
      </p>
      <p style={{ margin: 0 }}>
        <strong>Listed ingredients:</strong> {e.ingredients?.length ? e.ingredients.join(", ") : "None listed"}
      </p>
      <p style={{ margin: 0 }}>
        <strong>Allergens and families named:</strong> {e.allergens?.length ? `Contains: ${e.allergens.join(", ")}` : "No allergen list"}
        {lists.length > 0 && ` · names ${lists.join(", ")}`}
        {e.unclear.length > 0 && ` · unclear: ${e.unclear.map((u) => `"${u.word}" (${u.family}?)`).join(", ")}`}
      </p>
      <p style={{ margin: 0 }} data-testid="testers-conflicts">
        <strong>Conflicts:</strong> {conflicts.length ? <strong>{conflicts.join("; ")}</strong> : "None found"}
      </p>
      <p style={{ margin: 0 }}>
        <strong>Source:</strong>{" "}
        {r.meal.sourceUrl && host ? (
          <a href={r.meal.sourceUrl} rel="noopener noreferrer nofollow" target="_blank" data-testid="testers-source">
            {host}
          </a>
        ) : (
          "No source link"
        )}
        {` · checked ${r.checks.checkedOn ?? "date unknown"} · the automatic comparison found ${m.found} of ${m.found + m.notFound + m.notChecked} facts on the saved page`}
      </p>
    </div>
  );
}

type DishFacts = { facts: MenuFact[]; src: Map<string, MenuPlace["sources"][number]> };
const KIND_WORDS: Record<string, string> = {
  menu_item: "On the menu", price: "Price", dietary_status: "Diet statement", listed_ingredients: "Listed ingredients",
  allergen_statement: "Allergen statement", published_nutrition: "Nutrition figure", serving_size: "Serving size",
};
const NUTRIENT: Record<string, [string, string]> = { protein_g: ["Protein", "g"], energy_kcal: ["Calories", "kcal"], sodium_mg: ["Sodium", "mg"], fat_g: ["Fat", "g"], carbohydrate_g: ["Carbohydrate", "g"], fiber_g: ["Fibre", "g"], sugar_g: ["Sugar", "g"] };
const FACT_ORDER = ["dietary_status", "listed_ingredients", "allergen_statement", "published_nutrition", "serving_size", "price", "menu_item"];
/** One fact in plain words: exactly what was drafted, never more. */
function factWords(f: MenuFact): string {
  if (f.unknown) return `Unknown${f.unknownReason ? `: ${f.unknownReason}` : ""}`;
  const v = (f.value ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (x === undefined || x === null ? "" : String(x));
  switch (f.kind) {
    case "menu_item": return "Listed";
    case "price": return v.usd ? `$${str(v.usd)}` : "Recorded";
    case "dietary_status": return `${str(v.claim || f.subject)}: ${v.status === "yes" ? "the restaurant says yes" : v.status === "no" ? "the restaurant says no" : str(v.status)}`;
    case "listed_ingredients": return Array.isArray(v.items) ? (v.items as unknown[]).map(str).join(", ") : "Recorded";
    case "allergen_statement": return Array.isArray(v.allergens) ? `${str(v.statement) || "contains"}: ${(v.allergens as unknown[]).map(str).join(", ")}` : "Recorded";
    case "published_nutrition": {
      const [name, unit] = NUTRIENT[str(v.nutrient)] ?? [str(v.nutrient), ""];
      const per = v.per === "100g" ? "per 100 g" : v.portion ? `per serving (${str(v.portion)})` : "per serving";
      const basis = v.basis === "published_range" ? ", a printed range" : v.basis === "restaurant_estimate" ? ", the restaurant's estimate" : ", printed by the restaurant";
      return `${name} ${str(v.amount ?? `${str(v.low)} to ${str(v.high)}`)} ${unit} ${per}${basis}`;
    }
    case "serving_size": return str(v.text ?? v.amount ?? JSON.stringify(v));
    default: return JSON.stringify(v);
  }
}
const COMPARE: Record<string, string> = { found: "Found", not_found: "Not found", not_checked: "Not compared" };

/** Every drafted fact behind one meal, with its own source page, date and automatic comparison. Nothing is confirmed here. */
function FactTable({ d }: { d: DishFacts }) {
  const facts = [...d.facts].sort((a, b) => FACT_ORDER.indexOf(a.kind) - FACT_ORDER.indexOf(b.kind));
  if (!facts.length) return null;
  return (
    <details className="s14" data-testid="testers-facts" style={{ margin: "4px 0" }}>
      <summary>Every fact behind this meal ({facts.length}), with its source</summary>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Fact</th>
              <th scope="col">What was drafted</th>
              <th scope="col">Source page</th>
              <th scope="col">Read on</th>
              <th scope="col">On the saved copy</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => {
              const s = d.src.get(f.sourceId);
              const mc = f.machineCheck?.result ?? "not_checked";
              return (
                <tr key={f.factId} data-testid="testers-fact" data-kind={f.kind} data-compare={mc}>
                  <th scope="row">{KIND_WORDS[f.kind] ?? f.kind}</th>
                  <td>{factWords(f)}</td>
                  <td>
                    {s ? (
                      <a href={s.url} rel="noopener noreferrer nofollow" target="_blank">
                        {s.host}
                      </a>
                    ) : (
                      "Unknown"
                    )}
                    {s?.kind ? <span className="muted"> ({s.kind.replace(/_/g, " ")})</span> : null}
                  </td>
                  <td>{f.checkedOn}</td>
                  <td>{mc === "not_found" ? <strong>{COMPARE[mc]}</strong> : COMPARE[mc]}</td>
                  <td>{f.status === "verified" ? "Verified" : f.statuses.transcriptionConfirmed ? "Transcription confirmed" : "Drafted, unverified"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function MealRow({ r, view, why, facts }: { r: Row; view: View; why?: { rank: number; reasons: string[] }; facts?: DishFacts }) {
  const fails = failing(r.checks);
  const diets = r.checks.statedDiets.length ? r.checks.statedDiets.join(" and ") : null;
  return (
    <li id={`meal-${r.dishId}`} data-testid="testers-meal" data-dish={r.dishId} data-state={r.state} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <Link href={`/meals/${r.dishId}?from=${encodeURIComponent("/places/menus")}`}>{r.meal.label}</Link>
      {diets && <span className="badge ok sm" style={{ marginLeft: 6 }}>Restaurant says {diets}</span>}
      {why && (
        <p className="s13 muted" style={{ margin: "2px 0" }} data-testid="testers-why">
          #{why.rank + 1} in the first set{why.reasons.length ? `: ${why.reasons.join(", ")}` : ""}
        </p>
      )}
      <p className="s14" style={{ margin: "4px 0" }}>
        {r.meal.priceUsd ? `$${r.meal.priceUsd}` : "No price"} · menu checked {r.checks.checkedOn ?? "unknown"}
      </p>
      <Evidence r={r} />
      <p className="s14" style={{ margin: "2px 0" }} data-testid="testers-nutrition">
        <strong>Nutrition source:</strong> {r.meal.protein.words}
        {r.meal.protein.basis === "usda_range" ? ". Shown to testers as an estimate only." : ""}
      </p>
      {facts && <FactTable d={facts} />}
      {(fails.length > 0 || r.conflict) && (
        <p className="s14" style={{ margin: "4px 0" }} data-testid="testers-fails">
          <strong>Why not:</strong> {[...fails.map((k) => CHECK_WORDS[k].fail), ...(r.conflict ? ["A listed ingredient conflicts with vegetarian"] : [])].join("; ")}.
        </p>
      )}
      {r.decision && (
        <p className="s13 muted" style={{ margin: "4px 0" }}>
          Last decision: {r.decision === "include" ? "approved" : "rejected"}
          {r.decidedAt ? ` on ${r.decidedAt.slice(0, 10)}` : ""}
          {r.reason ? `: ${r.reason}` : ""}
        </p>
      )}
      {(r.state === "ready" || r.state === "left_out" || r.state === "included") && (
        <form action={decideTesterMealAction} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end", margin: "6px 0 10px" }}>
          <input type="hidden" name="dishId" value={r.dishId} />
          <input type="hidden" name="view" value={view} />
          <label className="s14" style={{ flex: "1 1 200px" }}>
            Note (optional)
            <input name="reason" maxLength={300} placeholder={r.included ? "Why reject it now" : "Why approve or reject it"} />
          </label>
          {r.included ? (
            <button className="btn" name="decision" value="leave_out" data-testid="testers-leave-out">
              Reject (remove from testers)
            </button>
          ) : (
            <>
              <button className="btn primary" name="decision" value="include" data-testid="testers-include">
                Approve for testers
              </button>
              {r.state === "ready" && (
                <button className="btn" name="decision" value="leave_out" data-testid="testers-leave-out">
                  Reject
                </button>
              )}
            </>
          )}
        </form>
      )}
    </li>
  );
}

export default function TestersPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston · Private preview</p>
      <h1 className="title">Meals for invited testers</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose a small set of real meals that invited testers could see. Only meals that pass every check can be included.
      </p>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <Testers searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
