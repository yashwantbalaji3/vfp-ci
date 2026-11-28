import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProteinExplanationPanel } from "@/components/protein-explanation";
import { proteinExplanationSchema } from "@/contracts/catalog";

// NIE N-4 "How we got this": the words a visitor reads for each of the four protein states.
// The shapes are exactly what public.protein_explanation returns (checked in tests/db/nie-protein-explanation).

const base = { foodItemId: "f", revisionId: "r", basis: { kind: "serving", amount: 1, unit: "serving" }, missingReason: null, assumptions: null, source: null, calculation: null, low: null, high: null, confidence: null, value: null };
const render = (e: Record<string, unknown>) => {
  const parsed = proteinExplanationSchema.parse({ ...base, ...e });
  return renderToStaticMarkup(createElement(ProteinExplanationPanel, { explanation: parsed, showEstimatesHref: "/foods/f?est=1#how-h" }));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&rsquo;/g, "’").replace(/\s+/g, " ");

const calc = {
  computedAt: "2026-11-16T01:00:00Z",
  engineVersion: "nie-v1-calc-1",
  inputsSha256: "a".repeat(64),
  quantityBasis: "restaurant_verified",
  servingBasis: "stated",
  servingFactorLow: 1,
  servingFactorHigh: 1,
  modelAssumptions: null,
  lines: [
    { lineNo: 1, label: "Cooked lentils", usdaDescription: "Lentils, raw", fdcId: 172420, usdaDataset: "sr_legacy", usdaRelease: "2018-04", usdaState: "raw", weighedAs: "cooked", preparation: null, amountBasis: "stated", grams: 250, gramsLow: 250, gramsHigh: 250, yieldFactor: 2.5, yieldSource: "USDA yield table", substitutes: 0, proteinG: 24.63, lowG: 24.63, highG: 24.63 },
  ],
  references: [{ dataset: "sr_legacy", release: "2018-04", sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/x.zip", contentSha256: "b".repeat(64) }],
};

describe("N4 How we got this, in words", () => {
  it("a restaurant figure is shown as theirs, unchanged, not measured by us", () => {
    const t = text(render({ state: "restaurant_published", value: 44, source: { publisher: "Demo cafe", sourceType: "menu", observedAt: "2026-11-15T12:00:00Z", summary: null, url: "https://example.test/n", isDemo: true } }));
    expect(t).toContain("The restaurant's own published figure");
    expect(t).toContain("44 g protein, as the restaurant publishes it");
    expect(t).toContain("we have not measured it ourselves");
    expect(t).toContain("Where this came from");
    expect(t).not.toContain("Ingredient by ingredient");
  });

  it("a calculation lists each ingredient, the raw/cooked conversion and the USDA reference", () => {
    const t = text(render({ state: "calculated", value: 24.63, calculation: calc }));
    expect(t).toContain("Calculated by us from the ingredients");
    expect(t).toContain("24.6 g protein");
    expect(t).toContain("It is a calculation, not a lab measurement or a restaurant figure");
    expect(t).toContain("Amounts supplied by the restaurant or weighed by us");
    expect(t).toContain("Weighed cooked; the reference value is for raw. Converted with a cooked-to-raw weight ratio of 2.5 (USDA yield table)");
    expect(t).toContain("Lentils, raw (FDC 172420, SR Legacy 2018-04)");
    expect(t).toContain("Reference values: USDA FoodData Central (public domain) · SR Legacy 2018-04");
    expect(t).toContain("Record aaaaaaaaaaaa");
  });

  it("an estimate is a range from a typical recipe, never a verified figure, with its reliability", () => {
    const t = text(render({ state: "estimated_range", value: 13.53, low: 10.824, high: 16.236, confidence: "medium", calculation: { ...calc, quantityBasis: "editorial_typical", lines: [{ ...calc.lines[0], usdaState: "cooked", weighedAs: "cooked", yieldFactor: null, yieldSource: null, amountBasis: "typical", grams: 150, gramsLow: 120, gramsHigh: 180, proteinG: 13.53, lowG: 10.824, highG: 16.236, substitutes: 1 }] } }));
    expect(t).toContain("Estimated range from a typical recipe");
    expect(t).toContain("Between 10.8 g and 16.2 g protein, most likely about 13.5 g");
    expect(t).toContain("not from this restaurant, so it is an estimate, not a verified figure");
    expect(t).toContain("Medium range");
    expect(t).toContain("It is not a statistical confidence interval");
    expect(t).toContain("Amounts from our own typical recipe, not from the restaurant");
    expect(t).toContain("120–180 g (typical 150 g) cooked");
    expect(t).toContain("May be swapped for another ingredient");
    expect(t).toContain("10.8–16.2 g");
  });

  it("a hidden estimate shows no number, only the way to see it; unknown says we won't guess", () => {
    const hidden = render({ state: "estimate_hidden" });
    expect(text(hidden)).toContain("estimates are hidden unless you choose to see them");
    expect(hidden).toContain('href="/foods/f?est=1#how-h"');
    expect(text(hidden)).not.toMatch(/\d+(\.\d)? g/);
    const unknown = text(render({ state: "unknown", missingReason: "not_provided" }));
    expect(unknown).toContain("Protein unknown");
    expect(unknown).toContain("We don’t fill the gap with a guess");
    expect(unknown).not.toMatch(/\b0 g/);
  });

  it("a packaged food's figure is the maker's; a recipe's sum of its ingredients is a calculation without engine lines", () => {
    const pub = text(render({ state: "published", value: 17 }));
    expect(pub).toContain("The maker's published figure");
    expect(pub).not.toContain("restaurant");
    const rec = text(render({ state: "calculated", value: 21 }));
    expect(rec).toContain("added up from the listed ingredients and their amounts");
    expect(rec).not.toContain("restaurant");
    expect(rec).not.toContain("Ingredient by ingredient");
  });

  it("text from records is escaped, never markup", () => {
    const html = render({ state: "calculated", value: 1, calculation: { ...calc, modelAssumptions: "<img src=x onerror=alert(1)>", lines: [{ ...calc.lines[0], label: "<script>x</script>" }] } });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
