import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { MealListSkeleton, UnverifiedBanner } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { evidenceWords } from "@/contracts/meal-eligibility";
import { CATEGORY_ORDER, CATEGORY_WORDS, evidenceCategories, type DietConfirmation, type EvidenceCategory } from "@/contracts/diet-confirmation";
import { confirmationRow, LEAD_WORDS, type ConfirmationRow } from "@/contracts/needs-confirmation";
import { getDietConfirmations } from "@/server/catalog/diet-confirmations";
import { getCurrentMember } from "@/server/auth/session";
import { getPreviewAudience, getPreviewPlaces } from "@/server/catalog/menu-preview";

export const metadata = { title: "Meals that need confirmation (private)", robots: { index: false, follow: false } };

/**
 * The founder-only "Needs confirmation" group (owner decision 22 Nov 2026 15:26 UTC, item 2). Meals whose diet the
 * menu does not state stay out of every strict match and suitable count; here the founder sees each one with the
 * evidence that exists and what is missing, kept apart from meals with an explicit conflict. Nothing here changes
 * a meal's status, and nothing is confirmed by viewing it.
 */
async function Confirm() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/places/menus/confirm">
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  const [places, audience] = await Promise.all([getPreviewPlaces(), getPreviewAudience()]);
  if (!places || audience !== "founder") notFound();
  const all = await getDietConfirmations();
  const byDish = new Map<string, DietConfirmation[]>();
  for (const r of all) byDish.set(r.dishId, [...(byDish.get(r.dishId) ?? []), r]);
  const rows = places.flatMap((p) => p.meals.map((m) => ({ p, m, r: confirmationRow(m.evidence), cat: evidenceCategories(m.evidence, byDish.get(m.dishId) ?? []) })));
  const n = (claim: "vegetarian" | "vegan", c: EvidenceCategory) => rows.filter((x) => x.cat[claim] === c).length;
  const total = rows.length;
  const open = rows.filter((x) => x.r.vegetarian === "insufficient");
  const order: ConfirmationRow["lead"][] = ["ingredients_clear", "ingredients_unclear", "no_ingredients"];
  const byPlace = places
    .map((p) => ({ p, meals: open.filter((x) => x.p.placeId === p.placeId).sort((a, b) => order.indexOf(a.r.lead) - order.indexOf(b.r.lead) || a.m.label.localeCompare(b.m.label)) }))
    .filter((x) => x.meals.length > 0)
    .sort((a, b) => b.meals.length - a.meals.length);
  return (
    <>
      <UnverifiedBanner />
      <section className="panel" data-testid="confirm-summary" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {total} complete meals at {places.length} restaurants
        </h2>
        <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">Vegetarian</th>
              <th scope="col">Vegan</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.map((c) => (
              <tr key={c} data-testid={`confirm-row-${c}`}>
                <th scope="row">{CATEGORY_WORDS[c]}</th>
                <td className="n">{n("vegetarian", c)}</td>
                <td className="n">{n("vegan", c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="s14 muted" style={{ marginBottom: 0 }}>
          Each row is its own kind of evidence and they are never added together. Only the first row counts toward suitable meals for members.
          &ldquo;Staff-confirmed&rdquo; is your own documented answer (private to you, lapses after 120 days or when the menu changes).
          &ldquo;Ingredient-supported&rdquo; is only our reading of a listed ingredient list, which can be incomplete. A missing label is never read as meat.
        </p>
      </section>
      <h2 className="h-sec">Vegetarian not stated: {open.length} meals</h2>
      <p className="s14 muted">Strongest leads first: meals whose listed ingredients name no meat or fish. These stay out of every diet match until the evidence changes.</p>
      {byPlace.length === 0 ? (
        <div className="empty" data-testid="confirm-none">
          <h3>Nothing waiting</h3>
          <p>Every meal either has the restaurant&rsquo;s own diet label or an explicit conflict.</p>
        </div>
      ) : (
        byPlace.map(({ p, meals }) => (
          <details key={p.placeId} className="panel" data-testid="confirm-place" style={{ marginBottom: 10 }}>
            <summary>
              <strong>{p.name}</strong> <span className="muted">· {meals.length} {meals.length === 1 ? "meal" : "meals"} · {meals.filter((x) => x.r.lead === "ingredients_clear").length} with clear listed ingredients</span>
            </summary>
            <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
              {meals.map(({ m, r, cat }) => {
                const words = evidenceWords(m.evidence);
                return (
                  <li key={m.dishId} data-testid="confirm-meal" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <Link href={`/meals/${m.dishId}?from=${encodeURIComponent("/places/menus/confirm")}`}>{m.label}</Link>
                    {m.section ? <span className="s13 muted"> · {m.section}</span> : null}
                    <span className="badge wait sm" style={{ marginLeft: 6 }}>
                      {LEAD_WORDS[r.lead]}
                    </span>
                    <p className="s14" style={{ margin: "4px 0" }}>
                      {m.evidence.ingredients ? <>Listed: {m.evidence.ingredients.join(", ")}. </> : null}
                      <span className="muted">{words.ourReading}</span>
                    </p>
                    <p className="s14" style={{ margin: 0 }} data-testid="confirm-missing">
                      <strong>Missing:</strong> {r.missing.join("; ")}.
                    </p>
                    <p className="s14" style={{ margin: "4px 0 0" }}>
                      <span data-testid="confirm-category">
                        Vegetarian: {CATEGORY_WORDS[cat.vegetarian]} · Vegan: {CATEGORY_WORDS[cat.vegan]}
                      </span>{" "}
                      · <Link href={`/places/menus/confirm/${m.dishId}`} data-testid="confirm-record-link">Record a documented answer</Link>
                    </p>
                  </li>
                );
              })}
            </ul>
          </details>
        ))
      )}
      <p className="s14 muted">
        <Link href="/places/menus">Back to restaurants with menus</Link>
      </p>
    </>
  );
}

export default function ConfirmPage() {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Boston · Private preview</p>
      <h1 className="title">Meals that need confirmation</h1>
      <Suspense fallback={<MealListSkeleton rows={4} />}>
        <Confirm />
      </Suspense>
    </AppShell>
  );
}
