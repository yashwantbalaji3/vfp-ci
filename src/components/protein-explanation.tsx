import Link from "next/link";
import type { ProteinExplanation, ProteinExplanationLine } from "@/contracts/catalog";
import { SourceNote } from "@/components/source-note";
import { formatAmount, formatDate } from "@/lib/format";

/**
 * NIE N-4 "How we got this": where a protein figure came from and how far to trust it, in plain
 * words. The four states never blur: a restaurant's figure, our calculation, an estimated range
 * from a typical recipe, or unknown. An estimate is never worded as a verified exact value.
 */
export const STATE_HEADLINE: Record<ProteinExplanation["state"], string> = {
  restaurant_published: "The restaurant's own published figure",
  published: "The maker's published figure",
  calculated: "Calculated by us from the ingredients",
  estimated_range: "Estimated range from a typical recipe",
  estimate_hidden: "An estimate is available but hidden",
  unknown: "Protein unknown",
};

const CONFIDENCE_WORDS: Record<string, string> = {
  high: "Narrow range: the high end is at most 1.25 times the low end.",
  medium: "Medium range: the high end is at most 1.5 times the low end.",
  low: "Wide range: treat this as a rough guide only.",
};

const STATE_WORDS: Record<string, string> = { raw: "raw", cooked: "cooked", as_sold: "as sold" };

function g(v: number | null): string {
  return v === null ? "unknown" : `${formatAmount(v)} g`;
}

function amountWords(l: ProteinExplanationLine): string {
  if (l.amountBasis === "typical" && l.gramsLow !== l.gramsHigh) return `${formatAmount(l.gramsLow)}–${formatAmount(l.gramsHigh)} g (typical ${formatAmount(l.grams)} g)`;
  return `${formatAmount(l.grams)} g`;
}

function conversionWords(l: ProteinExplanationLine): string | null {
  if (l.weighedAs === l.usdaState) return null;
  if (l.yieldFactor === null) return `Weighed ${STATE_WORDS[l.weighedAs]}, but the reference is ${STATE_WORDS[l.usdaState]} and no conversion is on file.`;
  return `Weighed ${STATE_WORDS[l.weighedAs]}; the reference value is for ${STATE_WORDS[l.usdaState]}. Converted with a cooked-to-raw weight ratio of ${formatAmount(l.yieldFactor)}${l.yieldSource ? ` (${l.yieldSource})` : ""}.`;
}

export function ProteinExplanationPanel({ explanation, showEstimatesHref }: { explanation: ProteinExplanation; showEstimatesHref: string }) {
  const e = explanation;
  const c = e.calculation;
  return (
    <section aria-labelledby="how-h" className="panel" data-testid="protein-explanation" data-state={e.state}>
      <h2 className="h-sec" id="how-h" style={{ marginTop: 0 }}>
        How we got this protein figure
      </h2>
      <p style={{ margin: 0 }}>
        <strong data-testid="explanation-state">{STATE_HEADLINE[e.state]}</strong>
      </p>

      {e.state === "restaurant_published" && (
        <p className="s14">
          {g(e.value)} protein, as the restaurant publishes it. We show their number unchanged; we have not measured it ourselves, and real servings can vary.
        </p>
      )}
      {e.state === "published" && (
        <p className="s14">{g(e.value)} protein, as published by whoever makes or sells it. We show their number unchanged; we have not measured it ourselves.</p>
      )}
      {e.state === "calculated" && c && (
        <p className="s14">
          {g(e.value)} protein, added up from ingredient amounts the restaurant gave us or that we weighed, using USDA reference values. It is a calculation, not a lab measurement or a restaurant figure.
        </p>
      )}
      {e.state === "calculated" && !c && (
        <p className="s14">{g(e.value)} protein, added up from the listed ingredients and their amounts. It is a calculation, not a lab measurement.</p>
      )}
      {e.state === "estimated_range" && (
        <>
          <p className="s14" data-testid="explanation-range">
            Between {g(e.low)} and {g(e.high)} protein, most likely about {g(e.value)}. This comes from a typical recipe for this kind of dish, not from this restaurant, so it is an estimate, not a verified figure.
          </p>
          {e.confidence && <p className="s14">{CONFIDENCE_WORDS[e.confidence]}</p>}
          <p className="s13 muted">The range shows the lowest and highest results our stated assumptions allow. It is not a statistical confidence interval.</p>
        </>
      )}
      {e.state === "estimate_hidden" && (
        <p className="s14">
          We have an estimate for this dish, but estimates are hidden unless you choose to see them.{" "}
          <Link className="link" href={showEstimatesHref}>
            Show the estimate and how we got it
          </Link>
        </p>
      )}
      {e.state === "unknown" && (
        <p className="s14">We don&rsquo;t have a reliable protein figure for this dish, so we show none. We don&rsquo;t fill the gap with a guess.</p>
      )}

      {e.source && (
        <div className="s14">
          <SourceNote source={e.source} label="Where this came from" />
        </div>
      )}
      {e.assumptions && <p className="s13 muted">{e.assumptions}</p>}

      {c && (
        <details className="src" data-testid="explanation-calculation">
          <summary>Ingredient by ingredient</summary>
          <div className="src-body">
            <p className="s14" style={{ marginTop: 0 }}>
              {c.quantityBasis === "restaurant_verified" ? "Amounts supplied by the restaurant or weighed by us." : "Amounts from our own typical recipe, not from the restaurant."}{" "}
              {c.servingBasis === "typical" && c.servingFactorLow !== c.servingFactorHigh
                ? `Serving size allowed to vary from ${formatAmount(c.servingFactorLow * 100)}% to ${formatAmount(c.servingFactorHigh * 100)}% of the recipe.`
                : ""}
            </p>
            {/* The table can scroll sideways on a phone: keyboard users need to reach it (WCAG 2.1.1). */}
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Protein, ingredient by ingredient">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Ingredient</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Protein</th>
                  </tr>
                </thead>
                <tbody>
                  {(c.lines ?? []).map((l) => (
                    <tr key={l.lineNo}>
                      <th scope="row">
                        {l.label}
                        {l.substitutes > 0 && <div className="s13 muted">May be swapped for another ingredient; the range covers that.</div>}
                      </th>
                      <td>
                        {amountWords(l)} {STATE_WORDS[l.weighedAs]}
                        {conversionWords(l) && <div className="s13 muted">{conversionWords(l)}</div>}
                      </td>
                      <td className="s13">
                        {l.usdaDescription ?? "USDA food"} (FDC {l.fdcId}
                        {l.usdaDataset ? `, ${l.usdaDataset === "sr_legacy" ? "SR Legacy" : "Foundation Foods"} ${l.usdaRelease ?? ""}` : ""})
                      </td>
                      <td className="n">{l.lowG !== null && l.highG !== null && l.lowG !== l.highG ? `${formatAmount(l.lowG)}–${formatAmount(l.highG)} g` : g(l.proteinG)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.modelAssumptions && <p className="s13">{c.modelAssumptions}</p>}
            <p className="s13 muted">
              Reference values: USDA FoodData Central (public domain)
              {(c.references ?? []).map((r) => ` · ${r.dataset === "sr_legacy" ? "SR Legacy" : "Foundation Foods"} ${r.release}`).join("")}. Calculated{" "}
              {formatDate(c.computedAt) ?? "on a recorded date"} by engine {c.engineVersion}. Record {c.inputsSha256.slice(0, 12)}.
            </p>
          </div>
        </details>
      )}
    </section>
  );
}
