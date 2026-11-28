import { describe, expect, it } from "vitest";
import { classifyItem, readLabel, stagingDietaryValues } from "../../scripts/lib/dietary-labels.mjs";

// Dietary evidence from the restaurant's own words (docs/41, stage 4). Dishes are invented examples.

const c = (item: Parameters<typeof classifyItem>[0]) => {
  const r = classifyItem(item);
  return { vegetarian: r.vegetarian, vegan: r.vegan, warnings: r.warnings.map((w: { kind: string }) => w.kind) };
};

describe("only the restaurant's own words count", () => {
  it("explicit labels", () => {
    expect(c({ name: "Bowl", labels: ["Vegan"] })).toEqual({ vegetarian: "stated", vegan: "stated", warnings: [] });
    expect(c({ name: "Bowl", labels: ["Vegetarian"] })).toEqual({ vegetarian: "stated", vegan: "none", warnings: [] });
    expect(c({ name: "Vegan Chili" })).toEqual({ vegetarian: "stated", vegan: "stated", warnings: [] });
  });

  it("a short mark counts only through the page's own legend", () => {
    expect(c({ name: "Bowl", labels: ["V"] })).toEqual({ vegetarian: "none", vegan: "none", warnings: ["undefined_mark"] });
    expect(c({ name: "Bowl", labels: ["(V)"], legend: { V: "Vegetarian" } })).toMatchObject({ vegetarian: "stated", vegan: "none" });
    expect(c({ name: "Bowl", labels: ["VE"], legend: { "(VE)": "Vegan" } })).toMatchObject({ vegetarian: "stated", vegan: "stated" });
    expect(readLabel("GF", {})).toMatchObject({ undefinedMark: true, words: "" });
  });

  it("'vegan-friendly' is never vegan; the owner's VG rule makes vegetarian preliminary", () => {
    expect(c({ name: "Bowl", labels: ["VG"], legend: { VG: "Vegetarian & Vegan-Friendly" } })).toEqual({ vegetarian: "preliminary", vegan: "option", warnings: [] });
    expect(c({ name: "Bowl", labels: ["Vegan-friendly"] })).toMatchObject({ vegan: "option", vegetarian: "none" });
  });

  it("a modification is not the dish as listed", () => {
    for (const l of ["vegan option available", "Can be made vegan", "Vegan upon request", "Ask for vegan cheese"]) {
      expect(c({ name: "Pad Thai", labels: [l] })).toMatchObject({ vegan: "option", vegetarian: "none" });
    }
  });

  it("'plant-based' is a looser word: preliminary only", () => {
    expect(c({ name: "Burger", labels: ["Plant-based"] })).toMatchObject({ vegetarian: "preliminary", vegan: "preliminary" });
  });

  it("the restaurant can say no", () => {
    expect(c({ name: "Curry", labels: ["Non-Veg"] })).toMatchObject({ vegetarian: "stated_no", vegan: "stated_no" });
    expect(c({ name: "Pizza", labels: ["Vegetarian", "Not vegan"] })).toMatchObject({ vegetarian: "stated", vegan: "stated_no" });
  });

  it("names and ingredients never add a label", () => {
    expect(c({ name: "Veggie Burger" })).toMatchObject({ vegetarian: "none", vegan: "none" });
    expect(c({ name: "Garden Salad", ingredients: ["lettuce", "tomato", "olive oil"] })).toMatchObject({ vegetarian: "none", vegan: "none" });
    expect(c({ name: "Falafel Wrap", description: "chickpeas, tahini, pickles" })).toMatchObject({ vegetarian: "none", vegan: "none" });
  });
});

describe("ingredients raise warnings for a person", () => {
  it("meat or fish under a vegetarian or vegan label", () => {
    expect(c({ name: "Tacos", labels: ["Vegetarian"], description: "chicken tinga" }).warnings).toEqual(["contradiction"]);
    expect(c({ name: "Noodles", labels: ["Vegan"], ingredients: ["fish sauce"] }).warnings).toEqual(["contradiction"]);
  });

  it("dairy, egg or honey under a vegan label", () => {
    expect(c({ name: "Toast", labels: ["Vegan"], ingredients: ["honey"] }).warnings).toEqual(["contradiction"]);
    expect(c({ name: "Toast", labels: ["Vegetarian"], ingredients: ["honey", "butter"] }).warnings).toEqual([]);
  });

  it("qualified words are not animal products", () => {
    expect(c({ name: "Tacos", labels: ["Vegan"], description: "vegan cheese, Beyond beef, oat milk crema, plant-based chicken" }).warnings).toEqual([]);
  });

  it("ingredients whose recipe varies are flagged, not decided", () => {
    expect(c({ name: "Salad", labels: ["Vegetarian"], description: "caesar dressing, parmesan" }).warnings).toEqual(["ambiguous_ingredient"]);
  });
});

describe("staging fact values", () => {
  it("stated and preliminary become facts with the label kept; options and silence stay unknown", () => {
    expect(stagingDietaryValues({ name: "Bowl", labels: ["VG"], legend: { VG: "Vegetarian & Vegan-Friendly" } })).toEqual([
      { claim: "vegetarian", value: { claim: "vegetarian", status: "yes", evidence: "preliminary_label", label: "VG", legend: "Vegetarian & Vegan-Friendly" } },
      { claim: "vegan", unknownReason: 'Only offered as a modification: "VG"' },
    ]);
    expect(stagingDietaryValues({ name: "Soup", labels: ["Vegan"] })).toEqual([
      { claim: "vegetarian", value: { claim: "vegetarian", status: "yes", label: "Vegan" } },
      { claim: "vegan", value: { claim: "vegan", status: "yes", label: "Vegan" } },
    ]);
    expect(stagingDietaryValues({ name: "Soup" })).toEqual([
      { claim: "vegetarian", unknownReason: "The restaurant prints no dietary word for this dish" },
      { claim: "vegan", unknownReason: "The restaurant prints no dietary word for this dish" },
    ]);
  });
});
