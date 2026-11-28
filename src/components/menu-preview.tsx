import { getPreviewAudience } from "@/server/catalog/menu-preview";
import { CuisineMark, cuisineFamily } from "./cuisine-mark";
import Link from "next/link";
import {
  cardNotes,
  DIET_FILTERS,
  DIET_SHORT,
  DIET_WORDS,
  PROTEIN_BASIS_WORDS,
  proteinPer100kcal,
  type DietFilter,
  type PreviewDiet,
  type PreviewMeal,
  type ProteinBasis,
} from "@/contracts/menu-preview";
import { allergenNote, evidenceWords, type FitView, type MealFit } from "@/contracts/meal-eligibility";
import { describeDietChoice, hasDietChoice, type DietChoice } from "@/domain/dietary/labels";
import type { HeldBack } from "@/contracts/meal-variety";

/**
 * Pieces of the founder-only private beta on real data (docs/59, redesigned in docs/60). Every screen that
 * shows a real meal says "Unverified preview": the meals are drafts from the restaurants' own pages, not
 * confirmed or approved by the founder unless the founder confirmed them, and not public.
 *
 * Cards lead with what a diner scans for (protein, name, price, diet) and keep the evidence one tap away on
 * the meal's own page. No photo is shown: none is available that we have the rights to, and nothing stands
 * in for one.
 */

export const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" });
/** A menu section as a reader sees it: a heading the menu prints in capitals ("VEGETARIAN CORNER") reads as
 *  "Vegetarian Corner". Display only; the stored words are unchanged. */
export const sectionLabel = (s: string | null | undefined) =>
  !s ? "" : /[a-z]/.test(s) || !/[A-Z]{4}/.test(s) ? s : s.toLowerCase().replace(/(^|[\s/&(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
export const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const price = (usd: string | null) => (usd ? `$${usd}` : null);

/** Short words for the protein evidence, always beside the figure. */
export const PROTEIN_BASIS_SHORT: Record<ProteinBasis, string> = {
  published: "Printed",
  published_range: "Printed range",
  restaurant_estimate: "Restaurant estimate",
  usda_range: "USDA estimate",
  unknown: "Unknown",
};
const BASIS_TONE: Record<ProteinBasis, string> = {
  published: "ok",
  published_range: "ok",
  restaurant_estimate: "ok",
  usda_range: "est",
  unknown: "none",
};

export async function UnverifiedBanner({ children }: { children?: React.ReactNode }) {
  const audience = await getPreviewAudience().catch(() => null);
  if (audience === "member_beta") {
    return (
      <div className="preview-bar" role="note" data-testid="unverified-banner" data-audience="member_beta">
        <p style={{ margin: 0 }}>
          <span className="pill">Not yet checked</span> <span>From each restaurant&rsquo;s own menu. No person has confirmed it yet.</span>
        </p>
        <details className="s14">
          <summary>What this means</summary>
          <p style={{ margin: "6px 0 0" }}>
            This is a test on this computer only; nothing here is public. Each detail shown (a dish, its price, the restaurant&rsquo;s own diet label, its
            listed ingredients or printed nutrition) was copied from the restaurant&rsquo;s own menu page, and an automatic check found the same words on
            the saved copy of that page. Details that check could not find are left out. A meal whose diet the menu doesn&rsquo;t state is never shown as
            vegetarian or vegan. USDA ranges are estimates, never the restaurant&rsquo;s figure. This is not an allergy guarantee: ask the restaurant.
          </p>
        </details>
        {children}
      </div>
    );
  }
  return (
    <div className="preview-bar" role="note" data-testid="unverified-banner">
      <p style={{ margin: 0 }}>
        <span className="pill">Unverified preview</span> <span>Drafted from the restaurant&rsquo;s own menu, not checked.</span>
      </p>
      <details className="s14">
        <summary>What this means</summary>
        <p style={{ margin: "6px 0 0" }}>
          The meals are drafted from each restaurant&rsquo;s own menu page and have not been confirmed by you unless a meal says so. Diet labels are the
          restaurant&rsquo;s own words; a meal whose diet the menu doesn&rsquo;t state is never shown as vegetarian or vegan. USDA ranges are estimates, never
          the restaurant&rsquo;s figure and never verified. Your saved diet is applied by checking the restaurant&rsquo;s labels and the ingredients and
          allergens it lists; that check never adds a diet the restaurant didn&rsquo;t state, and it is not an allergy guarantee.
        </p>
      </details>
      {children}
    </div>
  );
}

export const DIET_FILTER_WORDS: Record<DietFilter, string> = {
  any: "All meals",
  vegetarian: "Vegetarian (stated)",
  vegan: "Vegan (stated)",
};
export function DietFilterNav({ current, href, counts }: { current: DietFilter; href: (d: DietFilter) => string; counts?: Partial<Record<DietFilter, number>> }) {
  return (
    <nav className="chips scroll" aria-label="Diet, as the restaurant states it" data-testid="preview-diet-filter">
      {DIET_FILTERS.map((d) => (
        <Link key={d} className="chip" href={href(d)} aria-current={current === d ? "true" : undefined} data-testid={`preview-diet-${d}`}>
          {DIET_FILTER_WORDS[d]}
          {counts?.[d] !== undefined ? <span className="count">{counts[d]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

const DIET_TONE: Record<PreviewDiet, string> = { vegan_stated: "vegan", vegetarian_stated: "veg", unknown: "unknown", not_vegetarian: "meat" };
export function DietLabel({ m }: { m: Pick<PreviewMeal, "diet"> }) {
  return (
    <span className={`dchip ${DIET_TONE[m.diet]}`} data-testid="preview-diet" data-diet={m.diet} title={DIET_WORDS[m.diet]}>
      {DIET_SHORT[m.diet]}
    </span>
  );
}

const FIT_TONE: Record<MealFit["status"], string> = { eligible: "ok", needs_confirmation: "ask", ineligible: "no" };
/** How a meal fits the person's diet, from the shared check. Nothing is shown when no diet is chosen. */
export function FitChip({ fit }: { fit?: MealFit }) {
  if (!fit || !fit.short) return null;
  return (
    <span className={`dchip fit-${FIT_TONE[fit.status]}`} data-testid="meal-fit" data-status={fit.status} title={fit.reasons.join(". ")}>
      {fit.status === "eligible" ? "Fits, as stated" : fit.short}
    </span>
  );
}

/**
 * The rest of each restaurant's matching meals, held back so one restaurant doesn't fill the list (docs/64).
 * Each is one tap away; "Show every meal" turns the rule off, and the expanded list offers the way back.
 */
export function MoreFromPlaces({ held, total, expanded, href, allHref, lessHref }: { held: HeldBack[]; total: number; expanded: boolean; href: (slug: string) => string; allHref: string; lessHref: string }) {
  if (expanded) {
    return (
      <p className="s14" data-testid="more-less">
        Showing every meal in order. <Link href={lessHref}>Show each restaurant&rsquo;s strongest first</Link>
      </p>
    );
  }
  if (held.length === 0) return null;
  return (
    <section className="more-from" aria-labelledby="more-from-h" data-testid="more-from">
      <h3 className="s14" id="more-from-h" style={{ margin: "0 0 4px" }}>
        More from these restaurants
      </h3>
      <p className="s13 muted" style={{ margin: "0 0 6px" }}>
        Each restaurant&rsquo;s strongest matches show first, so one menu doesn&rsquo;t fill the list.
      </p>
      <ul className="chips" style={{ flexWrap: "wrap" }}>
        {held.map((h) => (
          <li key={h.key}>
            <Link className="chip" href={href(h.slug)} data-testid="more-from-place" data-place={h.slug}>
              {h.count} more from {h.name}
              {h.best !== null ? <span className="count">top {Number.isInteger(h.best) ? h.best : h.best.toFixed(1)} g</span> : null}
            </Link>
          </li>
        ))}
        <li>
          <Link className="chip" href={allHref} data-testid="more-all">
            Show every meal ({total})
          </Link>
        </li>
      </ul>
    </section>
  );
}

/**
 * The diet in force on a list of real meals, and the explicit choices to look wider (docs/63). The person's
 * saved diet applies by default; "Needs confirmation" and "All meals" are separate, labelled views they open.
 */
export function DietScope({ choice, saved, view, counts, href }: { choice: DietChoice; saved: boolean; view: FitView; counts: Record<FitView, number>; href: (v: FitView) => string }) {
  if (!hasDietChoice(choice)) return null;
  const name = describeDietChoice(choice);
  const views: [FitView, string][] = [
    ["mine", "Fits your diet"],
    ["check", "Needs confirmation"],
    ["all", "All meals"],
  ];
  return (
    <div className="diet-scope" data-testid="diet-scope" data-view={view}>
      <p className="s14" style={{ margin: "0 0 6px" }}>
        {saved ? "Your diet" : "Diet filter"}: <strong data-testid="diet-scope-name">{name}</strong>{" "}
        <Link className="s13" href="/diet">
          Change
        </Link>
      </p>
      <nav className="seg" aria-label="Which meals to show">
        {views.map(([v, w]) => (
          <Link key={v} href={href(v)} aria-current={view === v ? "true" : undefined} data-testid={`fit-view-${v}`}>
            {w} <span className="count">{counts[v]}</span>
          </Link>
        ))}
      </nav>
      {view === "check" && (
        <p className="callout s14" data-testid="fit-check-note" style={{ marginTop: 8 }}>
          <strong>Not matches.</strong> The restaurant&rsquo;s words don&rsquo;t settle whether these fit {name.toLowerCase()}: something is missing, unclear or
          contradictory. Each card says what. Ask the restaurant before ordering.
        </p>
      )}
      {view === "all" && (
        <p className="callout stop s14" data-testid="fit-all-note" style={{ marginTop: 8 }}>
          <strong>Showing every meal, including ones that don&rsquo;t fit {name.toLowerCase()}.</strong> Each card says whether it fits.{" "}
          <Link href={href("mine")}>Back to meals that fit</Link>
        </p>
      )}
    </div>
  );
}

/** On a meal's own page: whether it fits, why, and the evidence, with the restaurant's words kept apart from ours. */
export function FitPanel({ m, fit, choice }: { m: Pick<PreviewMeal, "evidence">; fit: MealFit; choice: DietChoice }) {
  const ev = evidenceWords(m.evidence);
  const chosen = hasDietChoice(choice);
  const title = !chosen ? "Diet and allergens" : fit.status === "eligible" ? `Fits your diet: ${describeDietChoice(choice)}` : fit.status === "ineligible" ? `Doesn't fit your diet: ${describeDietChoice(choice)}` : `Needs confirmation for ${describeDietChoice(choice)}`;
  return (
    <section className={`fit-panel fit-${FIT_TONE[fit.status]}`} aria-labelledby="fit-h" data-testid="fit-panel" data-status={chosen ? fit.status : "none"}>
      <h2 className="h-sec" id="fit-h" style={{ marginTop: 0 }}>
        {title}
      </h2>
      {chosen && fit.reasons.length > 0 && (
        <ul data-testid="fit-reasons" style={{ margin: "0 0 6px", paddingLeft: 20 }}>
          {fit.reasons.map((r) => (
            <li key={r}>{r}.</li>
          ))}
        </ul>
      )}
      <p className="s14" style={{ margin: "0 0 4px" }} data-testid="fit-stated">
        <strong>Restaurant states:</strong> {ev.stated}
      </p>
      <p className="s14" style={{ margin: "0 0 4px" }} data-testid="fit-reading">
        <strong>Our check:</strong> {ev.ourReading}
      </p>
      <p className="s13 muted" style={{ margin: 0 }} data-testid="fit-allergens">
        {allergenNote(m.evidence)}
      </p>
    </section>
  );
}

/** The protein figure as the card's anchor: the number, its unit, and where it comes from. */
export function ProteinTile({ m, size = "card" }: { m: Pick<PreviewMeal, "protein">; size?: "card" | "hero" }) {
  const p = m.protein;
  const value = p.low === null ? "?" : p.low === p.high ? fmt(p.low) : `${fmt(p.low)}–${fmt(p.high!)}`;
  return (
    <div className={`ptile ${BASIS_TONE[p.basis]} ${size}`} data-testid="preview-protein-tile" data-basis={p.basis} data-low={p.low ?? ""}>
      <span className="v">{value}</span>
      <span className="u">{p.low === null ? "protein unknown" : "g protein"}</span>
      <span className="b" data-testid="preview-protein-basis" title={PROTEIN_BASIS_WORDS[p.basis]}>
        {PROTEIN_BASIS_SHORT[p.basis]}
      </span>
    </div>
  );
}

/** The full protein explanation for the meal page, with the USDA working folded away. */
export function ProteinLine({ m }: { m: PreviewMeal }) {
  const p = m.protein;
  const per100 = proteinPer100kcal(m);
  return (
    <div data-testid="preview-protein" data-basis={p.basis}>
      <p style={{ margin: 0 }}>
        <strong>{PROTEIN_BASIS_WORDS[p.basis]}.</strong>{" "}
        {p.basis === "unknown" ? `${(p.unknownReason ?? "").replace(/[.\s]+$/, "")}.` : p.portion ? `${p.portion[0].toUpperCase()}${p.portion.slice(1)}.` : ""}
        {m.kcal !== null ? ` ${m.kcal} kcal printed by the restaurant.` : " Calories not printed."}
        {per100 ? ` About ${fmt(per100.low)}${per100.high !== per100.low ? `–${fmt(per100.high)}` : ""} g protein per 100 kcal.` : ""}
      </p>
      {p.usda && (
        <details className="fold" data-testid="preview-usda" open={p.basis === "usda_range"}>
          <summary>
            How the USDA estimate was made ({p.usda.confidence ?? "low"} confidence{p.usda.modelReviewed ? "" : ", assumptions not reviewed yet"})
          </summary>
          <p>
            This is not the restaurant&rsquo;s figure and it is not verified. It adds up USDA FoodData Central protein values for typical amounts of the listed
            ingredients. The restaurant&rsquo;s real portions may differ.
          </p>
          {p.usda.assumptions && <p>Assumptions: {p.usda.assumptions}</p>}
          <p>Serving: {p.usda.servingBasis}</p>
          <table className="glance">
            <thead>
              <tr>
                <th scope="col">Ingredient</th>
                <th scope="col">Protein</th>
                <th scope="col">USDA food and amount</th>
              </tr>
            </thead>
            <tbody>
              {p.usda.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.label}</td>
                  <td>
                    {fmt(l.gramsLow)}–{fmt(l.gramsHigh)} g
                  </td>
                  <td>
                    {l.usda} ({l.amountBasis.replace(/_/g, " ")})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

/** The automatic evidence for a meal, always labelled as automatic, never as the founder's check. */
export function MachineEvidence({ m }: { m: PreviewMeal }) {
  const total = m.machine.found + m.machine.notFound + m.machine.notChecked;
  return (
    <div className="s14" data-testid="preview-machine">
      {total > 0 ? (
        <p style={{ margin: 0 }}>
          Automatic check, not by you: {m.machine.found} of {total} drafted values found on the saved page
          {m.machine.boundedByNextDish ? ` (${m.machine.boundedByNextDish} of them under this dish, before the next one starts)` : ""}
          {m.machine.notFound ? `; ${m.machine.notFound} not found` : ""}
          {m.machine.notChecked ? `; ${m.machine.notChecked} not compared` : ""}.
        </p>
      ) : (
        <p style={{ margin: 0 }}>No automatic comparison was made for this meal.</p>
      )}
      {m.autoChecks.length > 0 && (
        <ul style={{ margin: "4px 0 0", paddingLeft: 20 }} data-testid="preview-autochecks">
          {m.autoChecks.map((c, i) => (
            <li key={i} data-code={c.code} data-level={c.level}>
              {c.level === "check" ? "Needs a look: " : ""}
              {c.words}.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** True when a test member (not the founder) is reading: their screens never say "you" about the founder's checks. */
async function readByMember() {
  return (await getPreviewAudience().catch(() => null)) === "member_beta";
}

/** Words for a meal's confirmation state. The founder reads "by you"; a test member reads whether a person checked it. */
export function confirmationWords(m: Pick<PreviewMeal, "confirmed" | "confirmedAutomatically">, member: boolean) {
  if (!m.confirmed) return member ? "Not yet checked by a person" : "Draft, not confirmed by you";
  if (member) return m.confirmedAutomatically ? "Checked automatically against the menu, not verified" : "Checked against the menu, not verified";
  return m.confirmedAutomatically ? "Automatic comparison accepted by you, not verified" : "Transcription confirmed by you, not verified";
}

export async function ConfirmationState({ m }: { m: PreviewMeal }) {
  const words = confirmationWords(m, await readByMember());
  return m.confirmed ? (
    <span className="dchip ok" data-testid="preview-confirmed" data-basis={m.confirmedAutomatically ? "automatic_comparison" : "founder"}>
      {words}
    </span>
  ) : (
    <span className="dchip draft" data-testid="preview-unconfirmed">
      {words}
    </span>
  );
}

async function UnconfirmedNote({ m }: { m: PreviewMeal }) {
  return (
    <span className="sr-only" data-testid="preview-unconfirmed">
      {confirmationWords(m, await readByMember())}
    </span>
  );
}

/**
 * One meal in a list: protein first, then the name (a link to the meal's own page), the place, the price and
 * the diet. Everything else (sources, checks, USDA working) is on the meal page.
 */
export function MealCard({ m, placeName, placeSlug, compare, from, fit, distance, sectionNote = true }: { m: PreviewMeal; placeName?: string; placeSlug?: string; compare?: React.ReactNode; from?: string; fit?: MealFit; distance?: string; sectionNote?: boolean }) {
  const href = `/meals/${m.dishId}${from ? `?from=${encodeURIComponent(from)}` : ""}`;
  const notes = cardNotes(m);
  return (
    <li className="mcard" data-testid="preview-meal" data-dish={m.dishId} data-fit={fit?.short ? fit.status : undefined}>
      <ProteinTile m={m} />
      <div className="body">
        <h3 data-testid="preview-meal-name">
          <Link href={href}>{m.label}</Link>
        </h3>
        <p className="meta">
          {placeName ? (
            <>
              {placeSlug ? (
                <Link className="over" href={`/places/${placeSlug}`}>
                  {placeName}
                </Link>
              ) : (
                placeName
              )}
              {m.section ? " · " : ""}
            </>
          ) : null}
          {sectionLabel(m.section)}
        </p>
        {notes.plant && (
          <p className="s13 muted" style={{ margin: 0 }} data-testid="meal-plant-note">
            {notes.plant}
          </p>
        )}
        {sectionNote && notes.section && (
          <p className="s13 muted" style={{ margin: 0 }} data-testid="meal-section-note">
            {notes.section}
          </p>
        )}
        {distance && (
          <p className="s13 muted" style={{ margin: 0 }} data-testid="meal-distance">
            {distance}, in a straight line
          </p>
        )}
        <div className="foot">
          <span className={m.priceUsd ? "price" : "price none"}>{price(m.priceUsd) ?? "Price not stated"}</span>
          <DietLabel m={m} />
          <FitChip fit={fit} />
          {m.confirmed ? <ConfirmationState m={m} /> : <UnconfirmedNote m={m} />}
          {m.exceptions.length > 0 && (
            <span className="dchip draft" title={m.exceptions.join("; ")} data-testid="preview-exceptions">
              Needs a look
            </span>
          )}
        </div>
        {compare && <div className="over">{compare}</div>}
      </div>
    </li>
  );
}

/**
 * A restaurant's picture: an original drawing of its kind of food (D3), never a logo or a photo of the place.
 * Decorative; the name beside it carries the meaning.
 */
export function Monogram({ name, cuisine, size = 56 }: { name: string; cuisine?: string | null; size?: number }) {
  return <CuisineMark family={cuisineFamily(cuisine, name)} size={size} />;
}

/** Shown while meals load: the shape of the cards, nothing invented. */
export function MealListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="cards" aria-busy="true" aria-label="Loading meals" data-testid="meal-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="mcard skel">
          <span className="ptile skel-box" />
          <span className="body">
            <span className="skel-line" style={{ width: "70%" }} />
            <span className="skel-line" style={{ width: "45%" }} />
            <span className="skel-line" style={{ width: "30%" }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One restaurant's list: the note about a diet-sounding section is said once above the list, not on every card
 * (P2, docs/68). It changes nothing about any meal's diet.
 */
export function SectionNoteOnce({ meals }: { meals: Pick<PreviewMeal, "label" | "section" | "diet">[] }) {
  const sections = [...new Set(meals.filter((m) => cardNotes(m).section).map((m) => m.section!))];
  if (!sections.length) return null;
  return (
    <p className="s13 muted" style={{ margin: "0 0 8px" }} data-testid="section-note-once">
      {sections.map((x) => `“${x}”`).join(", ")} {sections.length === 1 ? "is a menu section name" : "are menu section names"}, not a diet label. Only a dish the menu labels counts as vegetarian or vegan.
    </p>
  );
}
