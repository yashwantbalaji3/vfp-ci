import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfirmationState, DietLabel, FitChip, FitPanel, MachineEvidence, MealListSkeleton, ProteinLine, ProteinTile, UnverifiedBanner, day, price } from "@/components/menu-preview";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import { idSchema } from "@/contracts/catalog";
import { mealFit } from "@/contracts/meal-eligibility";
import { previewMeals } from "@/contracts/menu-preview";
import type { DietChoice } from "@/domain/dietary/labels";
import { describeDietChoice } from "@/domain/dietary/labels";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getPreviewAudience } from "@/server/catalog/menu-preview";
import { getMemberPreview, type PreviewGates } from "@/server/catalog/review-queue";
import { SocialError } from "@/server/social";

/**
 * Founder-only, read-only preview of one meal as an invited member would see it once every gate passes (owner
 * direction 25 Nov 2026 17:10 UTC). The facts come from the same member rule the member beta uses, so unreviewed
 * ingredient lists, egg warnings, conflicts and estimates show exactly as a member would see them. Nothing here
 * includes, confirms or publishes anything.
 */
export const metadata = { title: "Member preview (private)", robots: { index: false, follow: false } };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<RawParams> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const AS: Record<string, DietChoice> = {
  vegetarian: { diet: "vegetarian", exclusions: [] },
  vegan: { diet: "vegan", exclusions: [] },
  "egg-free": { diet: "vegetarian", exclusions: ["egg"] },
};

const GATES: { key: keyof PreviewGates; words: string }[] = [
  { key: "evidence", words: "Evidence checks pass (complete meal, the restaurant's own label found on the saved page, fresh, priced, open)" },
  { key: "enrolled", words: "Restaurant enrolled in the invited beta" },
  { key: "reviewed", words: "You source-reviewed the menu item, price and diet label" },
  { key: "included", words: "You included the meal for testers" },
  { key: "switchOn", words: "Member beta switch on (your activation decision; off)" },
];

async function Preview({ params, searchParams }: Props) {
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = idSchema.safeParse(raw);
  if (!id.success) notFound();
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/places/review/queue/preview/${id.data}`}>
        <p>This private page is for the founder. Sign in to continue.</p>
      </SignInPrompt>
    );
  }
  if ((await getPreviewAudience()) !== "founder") notFound();
  let data;
  try {
    data = await getMemberPreview(id.data);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 403 || e.status === 404)) notFound();
    throw e;
  }
  const { gates, place } = data;
  const m = previewMeals(place).find((x) => x.dishId === id.data) ?? null;
  const asKey = AS[one(sp.as) ?? ""] ? (one(sp.as) as string) : "vegetarian";
  const choice = AS[asKey];
  const fit = m ? mealFit(m.evidence, choice) : null;
  return (
    <>
      <p className="callout warn" role="note" data-testid="mp-banner">
        <strong>Founder preview.</strong> This is what an invited member would see for this meal once every gate below passes. Nothing is published, included or
        confirmed by opening it.
      </p>
      <section className="panel" data-testid="mp-gates" style={{ marginBottom: 16 }}>
        <h2 className="h-sec" style={{ marginTop: 0 }}>
          {gates.visibleNow ? "A member can see this meal now" : "Members cannot see this meal yet"}
        </h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {GATES.map((g) => (
            <li key={g.key} data-testid={`mp-gate-${g.key}`} data-pass={gates[g.key] ? "yes" : "no"}>
              {gates[g.key] ? "✓" : "○"} {g.words}
            </li>
          ))}
        </ul>
      </section>
      <nav className="tabs" aria-label="Preview as" style={{ marginBottom: 12 }}>
        {Object.keys(AS).map((k) => (
          <Link key={k} href={`/places/review/queue/preview/${id.data}?as=${k}`} aria-current={k === asKey ? "page" : undefined} className={`chip${k === asKey ? " on" : ""}`} data-testid={`mp-as-${k}`}>
            As {describeDietChoice(AS[k]).toLowerCase()}
          </Link>
        ))}
      </nav>
      <p className="eyebrow" data-testid="mp-place">
        {place.label}
        {place.area ? <span className="muted"> · {place.area}</span> : null}
      </p>
      {m ? (
        <>
          <h1 className="title" data-testid="mp-name">
            {m.label}
          </h1>
          <div className="meal-hero" data-testid="mp-hero">
            <ProteinTile m={m} size="hero" />
            <div className="facts">
              <span className={m.priceUsd ? "price" : "price none"}>{price(m.priceUsd) ?? (m.historicalPrice ? "Current price not known" : "Price not stated")}</span>
              {m.historicalPrice && (
                <span className="s13 muted" data-testid="mp-price-historical">
                  {price(m.historicalPrice.usd)} on the {m.historicalPrice.edition} menu: kept as a record, never shown to members as current.
                </span>
              )}
              <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <DietLabel m={m} />
                <FitChip fit={fit!} />
                <ConfirmationState m={m} />
              </span>
              <span className="s14 muted">{m.kcal !== null ? `${m.kcal} kcal printed by the restaurant` : "Calories not printed"}</span>
            </div>
          </div>
          <UnverifiedBanner />
          <div data-testid="mp-fit">
            <FitPanel m={m} fit={fit!} choice={choice} />
          </div>
          <details className="fold" open data-testid="mp-protein">
            <summary>How we know the protein</summary>
            <ProteinLine m={m} />
          </details>
          <details className="fold" open data-testid="mp-source">
            <summary>Where this came from</summary>
            <p>
              {m.sourceUrl ? (
                <a href={m.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {place.label}&rsquo;s own menu page
                </a>
              ) : (
                "Source not recorded"
              )}
              {m.checkedOn ? `, read ${day(m.checkedOn)}` : ""}.
            </p>
            <p>
              <ConfirmationState m={m} /> An automatic check found these details on the saved copy of the restaurant&rsquo;s page. Ask the restaurant if a detail
              matters to you.
            </p>
          </details>
          <details className="fold" data-testid="mp-checks">
            <summary>Automatic checks{m.autoChecks.some((c) => c.level === "check") ? " (one needs a look)" : ""}</summary>
            <MachineEvidence m={m} />
          </details>
        </>
      ) : (
        <div className="empty" data-testid="mp-none">
          <h3>Members would see no meal here</h3>
          <p>None of this dish&rsquo;s facts pass the member rule, or it is not a complete meal.</p>
        </div>
      )}
      <p className="s14" style={{ marginTop: 16 }}>
        <Link href={`/places/review/queue?view=all#meal-${id.data}`}>Back to the review queue</Link>
      </p>
    </>
  );
}

export default function MemberPreviewPage(props: Props) {
  if (!FLAGS.realCatalogPreview) notFound();
  return (
    <AppShell active="discover" realPlaces>
      <p className="eyebrow">Private · founder only · read-only</p>
      <Suspense fallback={<MealListSkeleton rows={2} />}>
        <Preview {...props} />
      </Suspense>
    </AppShell>
  );
}
