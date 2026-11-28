import { describe, expect, it } from "vitest";
import { areaFor, assessCandidate, categoryLabel, drawSample, listingSlug, nearTwins, sampleVerdict } from "../../scripts/lib/catalog-preview-lib.mjs";

// Private real-catalog preview (docs/32). Synthetic candidates only.

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rec = (o: R = {}): R => ({ source_key: "overture_places", name: "Blue Lantern", street: "10 Test St", postcode: "02116", lat: 42.35, lon: -71.07, present: true, ...o });
const cand = (o: R = {}, records = [rec(), rec({ source_key: "boston_food_licenses", name: "BLUE LANTERN" })]): R => ({ id: "c1", name: "Blue Lantern", street: "10 Test St", postcode: "02116", quality: "corroborated", flags: [], records, ...o });

describe("assessCandidate", () => {
  it("a corroborated place that passes every check enters the preview", () => {
    expect(assessCandidate(cand())).toEqual({ tier: "preview", reasons: [] });
  });
  it("corroborated is not enough: look-alikes, facilities, shops, disagreements and gaps go to a person", () => {
    expect(assessCandidate(cand({ flags: ["possible_duplicate"] })).reasons).toEqual(["possible_duplicate"]);
    expect(assessCandidate(cand({ name: "Sample Elementary School Cafe" })).reasons).toContain("possibly_not_public");
    expect(assessCandidate(cand({ name: "Test Tower 10th Floor Cafe" })).reasons).toContain("possibly_not_public");
    expect(assessCandidate(cand({ name: "Sample Hotel Restaurant" })).reasons).toContain("possibly_not_restaurant");
    expect(assessCandidate(cand({}, [rec(), rec({ source_key: "boston_food_licenses", lat: 42.352 })])).reasons).toEqual(["sources_disagree_on_position"]);
    expect(assessCandidate(cand({}, [rec(), rec({ source_key: "boston_food_licenses", name: "Harbor Holdings" })])).reasons).toEqual(["sources_disagree_on_name"]);
    expect(assessCandidate(cand({ postcode: null })).reasons).toEqual(["missing_address"]);
    expect(assessCandidate(cand({}, [rec(), rec({ source_key: "boston_food_licenses", present: false })])).reasons).toEqual(["source_absent"]);
  });
  it("rules added after the 17 Nov sample audit", () => {
    // Different house numbers in the two sources (Capri, Seoul Jangteo, Burg & Shaw pattern).
    expect(assessCandidate(cand({}, [rec(), rec({ source_key: "boston_food_licenses", street: "4 Test St" })])).reasons).toEqual(["sources_disagree_on_address"]);
    // A test kitchen or offices (America's Test Kitchen pattern), and a food-truck category at a fixed address.
    expect(assessCandidate(cand({ name: "Sample Test Kitchen" }, [rec({ name: "Sample Test Kitchen", category: "food_truck_stand" }), rec({ source_key: "boston_food_licenses", name: "Sample Test Kitchen" })])).reasons).toEqual(["possibly_not_public", "category_unclear"]);
    // University, hospital or government website, or a campus address.
    expect(assessCandidate(cand({}, [rec({ website: "https://hms.example.edu/cafe" }), rec({ source_key: "boston_food_licenses" })])).reasons).toEqual(["possibly_not_public"]);
    expect(assessCandidate(cand({}, [rec({ street: "10 Test St, Campus Dining Services" }), rec({ source_key: "boston_food_licenses" })])).reasons).toEqual(["possibly_not_public"]);
    // Overture does not say open; a broken name.
    expect(assessCandidate(cand({}, [rec({ status_hint: "unknown" }), rec({ source_key: "boston_food_licenses" })])).reasons).toEqual(["open_status_unknown"]);
    expect(assessCandidate(cand({ name: "Lily\u00c3\u00a9 Cafe" })).reasons).toEqual(["name_garbled"]);
    expect(assessCandidate(cand({}, [rec({ status_hint: "open", website: "https://bluelantern.example.com" }), rec({ source_key: "boston_food_licenses" })])).tier).toBe("preview");
  });
  it("two preview places with almost the same name within 150 m are sent to the duplicate queue", () => {
    const a = { id: "a", name: "Blue Lantern", lat: 42.35, lon: -71.07 };
    const b = { id: "b", name: "Blue Lantern Cafe", lat: 42.3505, lon: -71.07 };
    const far = { id: "c", name: "Blue Lantern", lat: 42.36, lon: -71.07 };
    const other = { id: "d", name: "Sample Tacos", lat: 42.3501, lon: -71.07 };
    expect([...nearTwins([a, b, far, other])].sort()).toEqual(["a", "b"]);
  });
  it("a restaurant whose name merely contains a common word is not caught", () => {
    expect(assessCandidate(cand({ name: "Dig Inn" }, [rec({ name: "Dig Inn" }), rec({ source_key: "boston_food_licenses", name: "DIG INN" })])).tier).toBe("preview");
    expect(assessCandidate(cand({ name: "Lantern Bar & Kitchen" }, [rec({ name: "Lantern Bar & Kitchen" }), rec({ source_key: "boston_food_licenses", name: "Lantern Bar and Kitchen" })])).tier).toBe("preview");
  });
  it("single-source and failed-check candidates are not in this preview; rejected is excluded", () => {
    expect(assessCandidate(cand({ quality: "single_source" }, [rec()])).reasons).toEqual(["single_source"]);
    expect(assessCandidate(cand({ quality: "needs_review" }, [rec()])).tier).toBe("exception");
    expect(assessCandidate(cand({ quality: "rejected" }))).toEqual({ tier: "excluded", reasons: ["rejected"] });
  });
});

describe("listing helpers", () => {
  it("area, slug and category words", () => {
    expect(areaFor("02118")).toBe("South End");
    expect(areaFor("02134")).toBeNull();
    expect(listingSlug("Café Ünïque", "10 Test St", "abcd1234-0000")).toBe("cafe-unique-10-test-st-abcd12");
    expect(categoryLabel("coffee_shop")).toBe("Coffee shop");
    expect(categoryLabel(undefined)).toBe("Restaurant");
  });
});

describe("representative sample", () => {
  const pop = Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}`, postcode: i < 20 ? "02118" : i < 30 ? "02215" : "02134" }));
  it("covers every area in proportion, at least 3 each, and is repeatable for the same seed", () => {
    const s = drawSample(pop, { size: 20, seed: "a" });
    const by = (x: string) => s.filter((p) => p.stratum === x).length;
    expect(by("South End")).toBe(3);
    expect(by("Fenway / Kenmore / Longwood")).toBe(3);
    expect(by("Elsewhere in the service area")).toBe(17);
    expect(drawSample(pop, { size: 20, seed: "a" })).toEqual(s);
    expect(drawSample(pop, { size: 20, seed: "b" })).not.toEqual(s);
  });
  it("passes only when every item is checked and problems are at most 5%", () => {
    expect(sampleVerdict(["correct", null])).toMatchObject({ done: false, passes: false });
    expect(sampleVerdict(Array(20).fill("correct"))).toMatchObject({ done: true, passes: true, problems: 0 });
    expect(sampleVerdict([...Array(19).fill("correct"), "closed"])).toMatchObject({ passes: true, problems: 1 });
    expect(sampleVerdict([...Array(18).fill("correct"), "closed", "duplicate"])).toMatchObject({ passes: false, problems: 2 });
  });
});
