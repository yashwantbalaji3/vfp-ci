import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { MealListSkeleton, UnverifiedBanner } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { CATEGORY_WORDS, evidenceCategories, type DietConfirmation } from "@/contracts/diet-confirmation";
import { evidenceWords } from "@/contracts/meal-eligibility";
import type { MenuFact, MenuPlace } from "@/contracts/menu-review";
import {
  approvalChanges,
  DIET_DIMENSION_WORDS,
  dietDimensions,
  founderChecked,
  founderCheckedClaim,
  NUTRITION_DIMENSION_WORDS,
  nutritionDimension,
  openNotes,
  questionsFor,
  reviewClaim,
  reviewCounts,
  sourceReview,
  type QueueRow,
} from "@/contracts/review-queue";
import { allPass, CHECK_KEYS, prioritise } from "@/contracts/tester-meals";
import type { RawParams } from "@/lib/search-params";
import { getOriginalWording } from "@/server/evidence/originals";
import { fold, type OriginalWording } from "@/contracts/original-wording";
import { brandOf, planSittings } from "@/contracts/review-sittings";
import { getCurrentMember } from "@/server/auth/session";
import { getDietConfirmations } from "@/server/catalog/diet-confirmations";
import { getPreviewAudience, getPreviewPlaces, type PreviewPlace } from "@/server/catalog/menu-preview";
import { getMenuPlace } from "@/server/catalog/menu-review";
import { getMealNotes, type MealNote } from "@/server/catalog/review-queue";
import { getTesterQueue } from "@/server/catalog/tester-meals";
import type { PreviewMeal } from "@/contracts/menu-preview";
import { editionOf, isHistoricalEdition } from "@/contracts/source-editions";
import { reviewMealAction } from "./actions";

export const metadata = { title: "Founder review queue (private)", robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
// Proposed first beta selection: at most PER_PLACE from one restaurant, at most PROPOSED in all, ready meals only.
const PER_PLACE = 6;
const PROPOSED = 50;
const VIEWS = [
  { key: "proposed", label: "Proposed first selection" },
  { key: "all", label: "Every meal with the restaurant's own label" },
  { key: "flagged", label: "Flagged" },
] as const;
type View = (typeof VIEWS)[number]["key"];

const MESSAGES: Record<string, string> = {
  needs_evidence: "Marked: needs more evidence. Nothing about the meal changed.",
  restaurant_confirmation: "Flagged for restaurant confirmation. Nobody was contacted.",
  cleared: "Flag cleared. The earlier note is kept in the history.",
};
const ERRORS: Record<string, string> = {
  INVALID_REQUEST: "That request was not valid. Nothing was changed.",
  NOTE_NEEDED: "Write a short note (at least 3 characters) for that choice. Nothing was changed.",
  NOTHING_SELECTED: "Nothing that choice applies to was selected, or those facts were already decided. Nothing was changed.",
  FOUNDER_ONLY: "Only the founder can review meals.",
  STAGING_SAME_PERSON: "A fact cannot be confirmed by the person who entered it. Nothing was changed.",
  STAGING_ALREADY_REVIEWED: "One of those facts was already decided. Reload and try again.",
};

const KIND: Record<string, string> = {
  menu_item: "On the menu",
  price: "Price",
  dietary_status: "Diet label",
  listed_ingredients: "Listed ingredients",
  published_nutrition: "Nutrition",
  allergen_statement: "Allergen statement",
  serving_size: "Serving",
};
function factWords(f: MenuFact, sourceUrl?: string): string {
  if (f.unknown) return `Unknown: ${f.unknownReason ?? "not on the menu"}`;
  const v = (f.value ?? {}) as Record<string, unknown>;
  if (f.kind === "menu_item") return "Listed";
  if (f.kind === "price") {
    const e = isHistoricalEdition(sourceUrl) ? editionOf(sourceUrl) : null;
    return e ? `$${v.usd} on the ${e.label} menu (historical, not shown as current)` : `$${v.usd}`;
  }
  if (f.kind === "dietary_status") return `${f.subject}: ${v.status === "yes" ? "the restaurant says yes" : v.status === "no" ? "the restaurant says no" : String(v.status)}`;
  if (f.kind === "listed_ingredients") return (v.items as string[] | undefined)?.join(", ") ?? "";
  if (f.kind === "published_nutrition") return `${f.subject}: ${v.amount ?? `${v.low}-${v.high}`} per ${v.per ?? "serving"}`;
  if (f.kind === "allergen_statement") return `${v.statement}: ${(v.allergens as string[] | undefined)?.join(", ") ?? ""}`;
  return JSON.stringify(v).slice(0, 120);
}
const statusWords = (f: MenuFact) =>
  f.status === "verified" ? "Verified" : f.statuses.transcriptionConfirmed ? "You confirmed it matches the page" : "Drafted, not checked by you";
const compareWords = (f: MenuFact) =>
  f.machineCheck?.result === "found" ? "Found on the saved page" : f.machineCheck?.result === "not_found" ? "Not found on the saved page" : "Not compared";

type Card = { row: QueueRow; p: PreviewPlace; m: PreviewMeal; menu: MenuPlace | null; note: MealNote | undefined; history: MealNote[]; rank?: { n: number; reasons: string[] }; next?: string };
const reviewedCard = (c: Card) => sourceReview(c.row.facts, reviewClaim(c.row)) === "complete";

async function Queue({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/review/queue">
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const [audience, places, queue] = await Promise.all([getPreviewAudience(), getPreviewPlaces(), getTesterQueue()]);
  if (audience !== "founder" || !places || !queue) notFound();
  const [records, notes, menus] = await Promise.all([
    getDietConfirmations(),
    getMealNotes(),
    Promise.all(places.map((p) => getMenuPlace(p.placeId).catch(() => null))),
  ]);
  const menuOf = new Map(places.map((p, i) => [p.placeId, menus[i]]));
  const recOf = new Map<string, DietConfirmation[]>();
  for (const r of records) recOf.set(r.dishId, [...(recOf.get(r.dishId) ?? []), r]);
  const open = openNotes(notes);
  const checksOf = new Map(queue.meals.map((r) => [r.dishId, r]));

  const cards: Card[] = places.flatMap((p) =>
    p.meals.map((m) => {
      const menu = menuOf.get(p.placeId) ?? null;
      const facts = menu?.dishes.find((d) => d.dishId === m.dishId)?.facts ?? [];
      const t = checksOf.get(m.dishId);
      const note = open.get(m.dishId);
      return {
        p,
        m,
        menu,
        note,
        history: notes.filter((n) => n.dishId === m.dishId),
        row: {
          dishId: m.dishId,
          cat: evidenceCategories(m.evidence, recOf.get(m.dishId) ?? []),
          // Evidence ready for your review: every check except enrolment and your own source review.
          ready: !!t && CHECK_KEYS.every((k) => k === "place" || k === "reviewed" || t.checks[k]),
          inBeta: !!t?.checks.place,
          memberEligible: !!t && allPass(t.checks),
          proteinBasis: m.protein.basis,
          includedForTesters: !!t?.included,
          facts,
          openNote: (note?.outcome as QueueRow["openNote"]) ?? null,
        },
      };
    }),
  );
  const counts = reviewCounts(cards.map((c) => c.row));
  const labelled = cards.filter((c) => c.row.cat.vegetarian === "restaurant_published" || c.row.cat.vegan === "restaurant_published");
  const ranked = prioritise(
    labelled
      .filter((c) => c.row.ready && !c.note)
      .map((c) => ({
        dishId: c.m.dishId,
        placeId: c.p.placeId,
        label: c.m.label,
        area: c.p.area,
        veganStated: c.m.evidence.veganClaim === "yes",
        eggFreeStated: false,
        ingredientsListed: (c.m.evidence.ingredients?.length ?? 0) > 0,
        proteinPrinted: c.m.protein.basis === "published" || c.m.protein.basis === "published_range",
        checkedOn: c.m.checkedOn,
      })),
    { includedByPlace: new Map(), includedByArea: new Map(), today: new Date().toISOString().slice(0, 10) },
    PER_PLACE,
    PROPOSED,
  );
  const rankOf = new Map(ranked.map((r, i) => [r.dishId, { n: i + 1, reasons: r.priority.reasons }]));
  // Everything else with a label, interleaved by restaurant (no per-restaurant cap), so one menu never fills the page.
  const rest = prioritise(
    labelled
      .filter((c) => !rankOf.has(c.m.dishId))
      .map((c) => ({ dishId: c.m.dishId, placeId: c.p.placeId, label: c.m.label, area: c.p.area, veganStated: c.m.evidence.veganClaim === "yes", eggFreeStated: false, ingredientsListed: false, proteinPrinted: false, checkedOn: null })),
    { includedByPlace: new Map(), includedByArea: new Map(), today: new Date().toISOString().slice(0, 10) },
    Number.POSITIVE_INFINITY,
  ).map((r) => r.dishId);
  const byId = new Map(cards.map((c) => [c.m.dishId, c]));
  const view: View = VIEWS.find((v) => v.key === one(sp.view))?.key ?? "proposed";
  const todo = one(sp.todo) === "1" && view !== "flagged";
  // Sittings (charter 28 Nov 2026, section 7): the proposed meals in short groups of one or two restaurants.
  const sittings = planSittings(ranked.map((r) => ({ dishId: r.dishId, placeName: byId.get(r.dishId)!.p.name })));
  const sitting = view === "proposed" ? (sittings.find((x) => String(x.n) === one(sp.sitting)) ?? null) : null;
  const listed: Card[] =
    view === "proposed"
      ? ranked.filter((r) => !sitting || sitting.dishIds.includes(r.dishId)).map((r) => ({ ...byId.get(r.dishId)!, rank: rankOf.get(r.dishId) }))
      : view === "all"
        ? [...ranked.map((r) => r.dishId), ...rest].map((id) => ({ ...byId.get(id)!, rank: rankOf.get(id) }))
        : cards.filter((c) => c.note);
  // "Still to review" hides meals whose menu item, price and label you already checked; each card links to the next.
  const shown: Card[] = (todo ? listed.filter((c) => !reviewedCard(c)) : listed).map((c, i, all) => ({ ...c, next: all[i + 1]?.m.dishId }));
  const proposed = ranked.map((r) => byId.get(r.dishId)!);
  const sheet = {
    restaurants: new Set(proposed.map((c) => c.p.placeId)).size,
    areas: new Set(proposed.map((c) => c.p.area ?? "")).size,
    cuisines: new Set(proposed.flatMap((c) => c.p.cuisines.filter((x) => x.basis !== "possibly").map((x) => x.cuisine))).size,
    vegan: proposed.filter((c) => c.m.evidence.veganClaim === "yes").length,
    ingredients: proposed.filter((c) => (c.m.evidence.ingredients?.length ?? 0) > 0).length,
    printed: proposed.filter((c) => c.m.protein.basis === "published" || c.m.protein.basis === "published_range").length,
    reviewed: proposed.filter(reviewedCard).length,
    notEnrolled: new Set(proposed.filter((c) => !c.row.inBeta).map((c) => c.p.placeId)).size,
    largest: Math.max(0, ...[...new Set(proposed.map((c) => c.p.placeId))].map((id) => proposed.filter((c) => c.p.placeId === id).length)),
  };
  const reviewedIds = new Set(proposed.filter(reviewedCard).map((c) => c.m.dishId));
  // The same dish at another branch of the same restaurant: worth comparing side by side; each is still decided on its own.
  const twinsOf = new Map<string, { dishId: string; place: string }[]>();
  for (const c of cards) {
    const twins = cards.filter((o) => o.m.dishId !== c.m.dishId && o.p.placeId !== c.p.placeId && brandOf(o.p.name) === brandOf(c.p.name) && fold(o.m.label) === fold(c.m.label));
    if (twins.length) twinsOf.set(c.m.dishId, twins.map((o) => ({ dishId: o.m.dishId, place: o.p.name })));
  }
  // The menu's own words beside each draft, from the founder's private copies of the saved pages (27 Nov 2026).
  const wording = await getOriginalWording(shown.map((c) => ({ dishId: c.m.dishId, label: c.m.label }))).catch(() => new Map<string, OriginalWording>());
  const msg = one(sp.m);
  const err = one(sp.e);
  const msgText = msg ? (MESSAGES[msg] ?? (/^approved_(\d+)$/.test(msg) ? `Recorded ${msg.split("_")[1]} fact decisions, one each. Nothing was published.` : /^rejected_(\d+)$/.test(msg) ? `Rejected ${msg.split("_")[1]} facts, with your note. Nothing else changed.` : null)) : null;
  const ROWS: [keyof typeof counts, string][] = [
    ["restaurantLabelled", "Restaurant-labelled vegetarian or vegan"],
    ["sourceBacked", "Source-backed (label found on the saved page; complete meal, fresh, priced, open)"],
    ["staffConfirmed", "Staff-confirmed (your documented answer)"],
    ["ingredientSupported", "Ingredient-supported only (no label; listed ingredients name nothing animal)"],
    ["sourceReviewed", "1. Source-reviewed by you (menu item, price and diet label match the source)"],
    ["sourceReviewPartial", "1. Source review started, not finished"],
    ["dietaryConfirmed", "2. Dietary-confirmed (published words you source-reviewed, or a documented staff answer)"],
    ["dietaryUnconfirmed", "2. Not dietary-confirmed yet (includes unknowns and conflicts, which stay open)"],
    ["nutritionPrinted", "3. Protein printed by the restaurant"],
    ["nutritionPrintedReviewed", "3. Printed protein you checked against the source"],
    ["nutritionEstimate", "3. Protein from a labelled estimate (never a measurement)"],
    ["nutritionUnknown", "3. Protein unknown"],
    ["betaEligible", "Evidence ready at a restaurant you enrolled (before your source review)"],
    ["memberEligible", "Member-eligible now: every check passes, your source review included"],
    ["approvedForTesters", "Approved by you for testers"],
    ["published", "Published"],
    ["awaitingEvidence", "Awaiting evidence (no label either way)"],
    ["conflicted", "Explicit conflict for vegetarian"],
    ["flaggedForRestaurant", "Flagged for restaurant confirmation"],
    ["needsEvidence", "Marked as needing more evidence"],
  ];
  return (
    <>
      <UnverifiedBanner />
      {msgText ? (
        <p className="callout ok" role="status" data-testid="rq-message">
          {msgText}
        </p>
      ) : null}
      {err ? (
        <p className="callout stop" role="alert" data-testid="rq-error">
          {ERRORS[decodeURIComponent(err)] ?? "That didn't work. Nothing was changed."}
        </p>
      ) : null}

      <nav className="tabs" aria-label="Review views" style={{ marginBottom: 12 }}>
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/places/review/queue?view=${v.key}`} aria-current={v.key === view ? "page" : undefined} className={`chip${v.key === view ? " on" : ""}`} data-testid={`rq-view-${v.key}`}>
            {v.label}
          </Link>
        ))}
      </nav>
      <p className="s13" style={{ margin: "0 0 12px" }}>
        <Link href="/places/review/verification" data-testid="rq-verification-link">
          Verification dry run: how the proposed policy would sort these meals
        </Link>
      </p>

      {view === "proposed" ? (
        <section className="panel" data-testid="rq-proposal" style={{ marginBottom: 16 }}>
          <h2 className="h-sec" style={{ marginTop: 0 }}>
            Proposed first beta selection: {proposed.length} meals
          </h2>
          <p className="s14" style={{ marginTop: 0 }}>
            {sheet.restaurants} restaurants, {sheet.areas} neighbourhoods, {sheet.cuisines} cuisines. {sheet.vegan} say vegan; {sheet.ingredients} list ingredients; {sheet.printed} print protein. At
            most {PER_PLACE} from one restaurant (the largest has {sheet.largest}). Only meals where every evidence check passes. No meal states egg-free, so egg-free vegetarians get none
            here yet.
          </p>
          <p className="s14" data-testid="rq-progress">
            <strong>
              {sheet.reviewed} of {proposed.length} source-reviewed by you.
            </strong>{" "}
            {todo ? (
              <Link href={`/places/review/queue?view=proposed${sitting ? `&sitting=${sitting.n}` : ""}`} data-testid="rq-todo-off">
                Show all {proposed.length}
              </Link>
            ) : (
              <Link href={`/places/review/queue?view=proposed&todo=1${sitting ? `&sitting=${sitting.n}` : ""}`} data-testid="rq-todo-on">
                Show only the {proposed.length - sheet.reviewed} still to review
              </Link>
            )}
          </p>
          <ol className="s14" data-testid="rq-sittings" style={{ paddingLeft: 20 }}>
            {sittings.map((x) => {
              const done = x.dishIds.filter((id) => reviewedIds.has(id)).length;
              return (
                <li key={x.n} data-testid="rq-sitting" data-done={done === x.dishIds.length ? "yes" : "no"} style={{ marginBottom: 4 }}>
                  <strong>Sitting {x.n}:</strong> {x.brands.map((b) => `${b.brand} (${b.meals})`).join(", ")} · {done} of {x.dishIds.length} reviewed ·{" "}
                  {sitting?.n === x.n ? (
                    <span aria-current="true">showing now</span>
                  ) : (
                    <Link href={`/places/review/queue?view=proposed&sitting=${x.n}${todo ? "&todo=1" : ""}`}>Open sitting {x.n}</Link>
                  )}
                </li>
              );
            })}
          </ol>
          {sitting ? (
            <p className="s14" data-testid="rq-sitting-now">
              Showing sitting {sitting.n} only. <Link href={`/places/review/queue?view=proposed${todo ? "&todo=1" : ""}`}>Show every sitting</Link>
            </p>
          ) : null}
          {sheet.notEnrolled ? (
            <p className="s14" data-testid="rq-proposal-enrol">
              {sheet.notEnrolled} of these restaurants are not in the beta yet. Including their meals would also mean enrolling them, which is your choice.
            </p>
          ) : null}
          {proposed.length < 30 ? (
            <p className="callout warn s14" data-testid="rq-proposal-short">
              The evidence supports {proposed.length} meals, fewer than 30. More need more restaurants with their own labels, or your documented answers.
            </p>
          ) : null}
        </section>
      ) : null}

      {shown.length === 0 ? (
        <div className="empty" data-testid="rq-none">
          <h3>Nothing here</h3>
          <p>{view === "flagged" ? "No meal is flagged." : "No meal with a restaurant label is waiting."}</p>
        </div>
      ) : (
        <ol className="stack" style={{ listStyle: "none", padding: 0 }}>
          {shown.map((c) => (
            <MealCard key={c.m.dishId} c={c} view={view} todo={todo} wording={wording.get(c.m.dishId)} twins={twinsOf.get(c.m.dishId)} sitting={sitting?.n} />
          ))}
        </ol>
      )}
      {/* The sittings and cards come first, so the founder starts work at once; the full counts follow (charter 28 Nov 2026, section 7). */}
      <section className="panel" data-testid="rq-counts" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {counts.meals} complete meals at {places.length} restaurants
        </h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Each row is its own question; rows overlap and are never added up</th>
                <th scope="col">Meals</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([k, words]) => (
                <tr key={k} data-testid={`rq-count-${k}`}>
                  <th scope="row">{words}</th>
                  <td className="n">{counts[k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="s14 muted" style={{ marginBottom: 0 }}>
          Rows 1 to 3 are the three separate dimensions. Source review records that the restaurant&rsquo;s page says what was drafted; it is not permission to publish, and
          it never claims allergen safety. &ldquo;Source-backed&rdquo; here means the label was found on the saved page and the meal is complete, fresh, priced and open; the
          coverage report&rsquo;s figure also counts meals without a price or a recent check, so it is larger.
        </p>
      </section>
    </>
  );
}

/** The menu's own words around the dish, from the founder's private copy of the exact saved page. */
function OriginalWords({ w }: { w?: OriginalWording }) {
  if (!w || w.state === "no_folder")
    return <span className="muted">Your private copies of the saved menus aren&rsquo;t connected on this computer (setting VFP_EVIDENCE_DIR), so only the source link is shown.</span>;
  if (w.state === "no_copy") return <span className="muted">No private copy of the exact page this draft was checked against is on this computer.</span>;
  if (w.state === "pdf_without_text") return <span className="muted">The saved page is a PDF ({w.file}) with no text copy beside it. Open the PDF to compare.</span>;
  if (w.state === "not_found") return <span className="muted">The dish name wasn&rsquo;t found in your private copy ({w.file}). Open it to compare; the draft may use different words.</span>;
  return (
    <>
      {w.excerpts.map((e, i) => (
        <blockquote key={i} className="s14" style={{ margin: i ? "6px 0 0" : 0, paddingLeft: 10, borderLeft: "3px solid var(--line, #ccc)" }} data-testid="rq-original-excerpt">
          {e.before}
          <mark>{e.match}</mark>
          {e.after}
        </blockquote>
      ))}
      <span className="s13 muted">
        From your private copy {w.file}
        {w.savedAt ? `, saved ${w.savedAt.slice(0, 10)}` : ""}: the restaurant&rsquo;s own menu, for your check only. Not stored or shown anywhere else.
      </span>
    </>
  );
}

function MealCard({ c, view, todo, wording, twins, sitting }: { c: Card; view: View; todo: boolean; wording?: OriginalWording; twins?: { dishId: string; place: string }[]; sitting?: number }) {
  const { m, p, row, menu } = c;
  const facts = row.facts;
  const src = new Map((menu?.sources ?? []).map((s) => [s.sourceId, s]));
  const dietFact = facts.find((f) => f.kind === "dietary_status" && !f.unknown && f.value?.status === "yes");
  const source = dietFact ? src.get(dietFact.sourceId) : facts[0] ? src.get(facts[0].sourceId) : undefined;
  const claim = m.evidence.veganClaim === "yes" ? "vegan" : "vegetarian";
  const conflicts = [
    ...(m.evidence.namesMeat ? ["Its name or ingredients name meat or fish"] : []),
    ...m.evidence.found.map((f) => `Lists ${f.word}`),
    ...m.evidence.unclear.map((u) => `Unclear: ${u.word}`),
    ...m.autoChecks.filter((a) => a.level === "check").map((a) => a.words),
  ];
  const unknowns = facts.filter((f) => f.unknown).map((f) => `${KIND[f.kind] ?? f.kind}${f.subject ? ` (${f.subject})` : ""}`);
  const decidable = facts.filter((f) => f.canConfirm || f.canReject);
  const done = founderCheckedClaim(facts, claim);
  const review = sourceReview(facts, reviewClaim(row));
  const diets = dietDimensions(row);
  const nutrition = nutritionDimension(facts, row.proteinBasis);
  const changes = approvalChanges({ claim, diet: diets[claim], nutrition, inBeta: row.inBeta, otherChecks: row.ready });
  const questions = questionsFor({
    evidenceNote: menu?.dishes.find((d) => d.dishId === m.dishId)?.structure?.evidence ?? null,
    ingredients: m.evidence.ingredients,
    veganClaim: m.evidence.veganClaim,
    vegetarianClaim: m.evidence.vegetarianClaim,
    unclear: m.evidence.unclear.map((u) => u.word),
  });
  const cuisine = p.cuisines.filter((x) => x.basis !== "possibly").map((x) => x.cuisine).join(", ");
  return (
    <li className="panel" id={`meal-${m.dishId}`} data-testid="rq-meal" data-ready={row.ready ? "yes" : "no"} data-checked={done ? "yes" : "no"} style={{ marginBottom: 12 }}>
      <p className="eyebrow" style={{ margin: 0 }}>
        {c.rank ? `#${c.rank.n} · ` : ""}
        {p.name} · {p.street}
        {p.area ? ` · ${p.area}` : ""}
        {cuisine ? ` · ${cuisine}` : ""}
      </p>
      <h3 style={{ margin: "4px 0" }}>
        <Link href={`/meals/${m.dishId}?from=${encodeURIComponent("/places/review/queue")}`}>{m.label}</Link>
        {m.section ? <span className="s14 muted"> · {m.section}</span> : null}
      </h3>
      {row.ready && !row.inBeta ? (
        <p className="s14 muted" data-testid="rq-not-enrolled" style={{ margin: 0 }}>
          Restaurant not in the beta yet: enrolling it is your choice.
        </p>
      ) : null}
      {twins?.length ? (
        <p className="s14" data-testid="rq-twins" style={{ margin: "4px 0" }}>
          The same dish is drafted at{" "}
          {twins.map((t, i) => (
            <span key={t.dishId}>
              {i ? ", " : ""}
              <a href={`#meal-${t.dishId}`}>{t.place}</a>
            </span>
          ))}
          . Compare the two menus&rsquo; words side by side; each branch is still decided on its own.
        </p>
      ) : null}
      {c.note ? (
        <p className="callout warn s14" data-testid="rq-open-note">
          {c.note.outcome === "restaurant_confirmation" ? "Flagged for restaurant confirmation" : "Needs more evidence"}: {c.note.note}
        </p>
      ) : null}
      <dl className="s14 kv" style={{ margin: "6px 0" }}>
        <dt>Restaurant&rsquo;s words</dt>
        <dd data-testid="rq-wording">
          {dietFact ? `${claim === "vegan" ? "Vegan" : "Vegetarian"}: ${dietFact.machineCheck?.detail ?? "not compared with the saved page yet"}` : "No vegetarian or vegan label"}
        </dd>
        <dt>Source</dt>
        <dd>
          {source ? (
            <>
              <a href={source.url} rel="noreferrer nofollow" target="_blank">
                {source.host}
              </a>{" "}
              (read {source.retrievedAt.slice(0, 10)}; {source.access === "cleared" ? "cleared source" : source.access === "private_pilot" ? "private pilot: facts only, never published" : source.access})
            </>
          ) : (
            "None recorded"
          )}
        </dd>
        <dt>Menu&rsquo;s own words</dt>
        <dd data-testid="rq-original">
          <OriginalWords w={wording} />
        </dd>
        <dt>Ingredients</dt>
        <dd>{m.evidence.ingredients?.length ? m.evidence.ingredients.join(", ") : "Not listed"}</dd>
        <dt>Nutrition</dt>
        <dd>{m.protein.words}</dd>
        <dt>Evidence category</dt>
        <dd data-testid="rq-category">
          Vegetarian: {CATEGORY_WORDS[row.cat.vegetarian]} · Vegan: {CATEGORY_WORDS[row.cat.vegan]}
        </dd>
        <dt>Conflicts and unknowns</dt>
        <dd>{[...conflicts, ...(unknowns.length ? [`Unknown: ${unknowns.join(", ")}`] : [])].join("; ") || "None recorded"}</dd>
      </dl>
      <dl className="s14 kv" style={{ margin: "6px 0" }} data-testid="rq-dimensions">
        <dt>1. Source review</dt>
        <dd data-testid="rq-dim-source" data-state={review}>
          {review === "complete" ? "Done: you checked the menu item, price and diet label against the source" : review === "partial" ? "Started: some of the menu item, price and diet label are checked" : "Not yet"}
        </dd>
        <dt>2. Dietary</dt>
        <dd data-testid="rq-dim-diet" data-state={diets[claim]}>
          {claim === "vegan" ? "Vegan" : "Vegetarian"}: {DIET_DIMENSION_WORDS[diets[claim]]}
          {claim === "vegan" ? ` · Vegetarian: ${DIET_DIMENSION_WORDS[diets.vegetarian]}` : ""}
        </dd>
        <dt>3. Nutrition</dt>
        <dd data-testid="rq-dim-nutrition" data-state={nutrition}>
          {NUTRITION_DIMENSION_WORDS[nutrition]}
        </dd>
        <dt>Testers</dt>
        <dd data-testid="rq-dim-member" data-state={row.memberEligible ? "eligible" : "not_yet"}>
          {row.includedForTesters ? (
            "Included by you for testers"
          ) : row.memberEligible ? (
            <>
              Includable for testers now, a separate choice: <Link href="/places/menus/testers">include it on the tester page</Link>
            </>
          ) : (
            "Not includable yet"
          )}
        </dd>
      </dl>
      <details className="s14" data-testid="rq-changes">
        <summary>What approving does, and what stays unverified</summary>
        <ul>
          <li>
            <strong>Source review:</strong> {changes.sourceReview}
          </li>
          <li>
            <strong>Dietary:</strong> {changes.dietary}
          </li>
          <li>
            <strong>Nutrition:</strong> {changes.nutrition}
          </li>
          <li>
            <strong>Testers:</strong> {changes.testers}
          </li>
        </ul>
        <p>
          <strong>Stays unverified:</strong> allergen safety and cross-contact; whether the recipe changed since {m.checkedOn ?? "the reading"}; anything the menu does not say
          (stock, sauces, frying oil); and permission to publish, which a private-pilot source never gives.
        </p>
        <p className="muted">{evidenceWords(m.evidence).ourReading}</p>
      </details>
      <details className="s14">
        <summary>Questions that would settle what is open</summary>
        <ul data-testid="rq-questions">
          {questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </details>
      <form action={reviewMealAction} className="stack" style={{ marginTop: 8 }} data-testid="rq-form">
        <input type="hidden" name="dishId" value={m.dishId} />
        <input type="hidden" name="placeId" value={p.placeId} />
        <input type="hidden" name="claim" value={claim} />
        <input type="hidden" name="view" value={view} />
        {todo ? <input type="hidden" name="todo" value="1" /> : null}
        {sitting ? <input type="hidden" name="sitting" value={sitting} /> : null}
        <fieldset className="s14">
          <legend>Facts ({facts.filter(founderChecked).length} of {facts.length} checked by you)</legend>
          {facts.map((f) => (
            <div key={f.factId} className="rq-fact" data-testid="rq-fact" data-kind={f.kind} data-reviewed={founderChecked(f) ? "yes" : "no"} style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <label style={{ display: "block" }}>
                <input type="checkbox" name="fact" value={f.factId} disabled={!(f.canConfirm || f.canReject)} /> <strong>{KIND[f.kind] ?? f.kind}:</strong> {factWords(f, src.get(f.sourceId)?.url)}{" "}
                <span className="muted">
                  · {compareWords(f)} · {statusWords(f)}
                </span>
              </label>
              {f.machineCheck?.detail ? (
                <p className="s13 muted" style={{ margin: "2px 0 2px 24px" }} data-testid="rq-fact-evidence">
                  On the saved page: {f.machineCheck.detail}
                </p>
              ) : null}
              {f.canConfirm || f.canReject ? (
                <span className="row wrap" style={{ gap: 6, marginLeft: 24 }}>
                  {f.canConfirm && f.confirmAs ? (
                    <button className="btn small" name="op" value={`approve_one:${f.factId}`} data-testid="rq-fact-approve">
                      Matches the source
                    </button>
                  ) : null}
                  {f.canReject ? (
                    <button className="btn small danger" name="op" value={`reject_one:${f.factId}`} data-testid="rq-fact-reject">
                      Doesn&rsquo;t match (needs a note)
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
          ))}
        </fieldset>
        <label className="s14">
          Note (required to reject or flag; it is the question to ask when flagging)
          <textarea name="note" rows={2} maxLength={1000} />
        </label>
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn" href={`/places/review/queue/preview/${m.dishId}`} data-testid="rq-member-preview">
            Preview as a member
          </Link>
          {c.next ? (
            <Link className="btn" href={`#meal-${c.next}`} data-testid="rq-next">
              Next meal
            </Link>
          ) : null}
          <button className="btn primary" name="op" value="approve_claim" disabled={done || decidable.length === 0} data-testid="rq-approve-claim">
            Approve the {claim} claim
          </button>
          <button className="btn" name="op" value="approve_selected" data-testid="rq-approve-selected">
            Approve selected facts
          </button>
          <button className="btn" name="op" value="needs_evidence" data-testid="rq-needs-evidence">
            Needs more evidence
          </button>
          <button className="btn" name="op" value="restaurant_confirmation" data-testid="rq-flag">
            Flag for restaurant confirmation
          </button>
          <button className="btn danger" name="op" value="reject_selected" data-testid="rq-reject">
            Reject selected facts
          </button>
          {c.note ? (
            <button className="btn" name="op" value="cleared" data-testid="rq-clear">
              Clear the flag
            </button>
          ) : null}
        </div>
        <p className="s13 muted" style={{ margin: 0 }}>
          Approving records one decision per fact (menu item, price and the {claim} label). From a private-pilot source this confirms the page says it; it never verifies for
          publication. A note never changes a fact.
          {c.history.length > 1 ? ` ${c.history.length} notes in this meal's history.` : ""}
        </p>
      </form>
    </li>
  );
}

export default function QueuePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only</p>
      <h1 className="title">Review queue</h1>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
