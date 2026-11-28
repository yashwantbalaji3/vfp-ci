import { describe, expect, it } from "vitest";
import { extractJsonLd, findMenuLinks, matchKey, parseAmount, parsePrice, readSchemaOrg, readWith, readersFor } from "../../scripts/lib/menu-readers.mjs";

// Menu readers (docs/41, stage 2). Pages are invented fixtures.

const page = (ld: unknown, extra = "") => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script>${extra}</head><body></body></html>`;

describe("schema.org menus", () => {
  const menu = {
    "@context": "https://schema.org", "@type": "Restaurant", name: "Test Kitchen",
    hasMenu: { "@type": "Menu", hasMenuSection: [
      { "@type": "MenuSection", name: "Bowls", hasMenuItem: [
        { "@type": "MenuItem", name: "Harvest Bowl&trade;", description: "Kale, roasted sweet potato, tofu",
          suitableForDiet: ["https://schema.org/VeganDiet"], offers: { "@type": "Offer", price: "13.95", priceCurrency: "USD" },
          nutrition: { "@type": "NutritionInformation", proteinContent: "21 g", calories: "540 calories", servingSize: "410 g" } },
        { "@type": "MenuItem", name: "Mystery Soup", nutrition: { proteinContent: "" } },
      ] },
    ] },
  };

  it("copies names, sections, labels, prices and nutrition exactly; a missing value stays missing", () => {
    const items = readSchemaOrg(page(menu));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      name: "Harvest Bowl&trade;", section: "Bowls", description: "Kale, roasted sweet potato, tofu",
      labels: ["VeganDiet"], legend: { VeganDiet: "Vegan" }, ingredients: null, allergens: null, price_usd: 13.95,
      serving: "410 g", serving_grams: 410,
      nutrition: { protein_g: { amount: 21, unit: "g", per: "serving" }, energy_kcal: { amount: 540, unit: "kcal", per: "serving" } },
    });
    expect(items[1]).toMatchObject({ name: "Mystery Soup", nutrition: {}, price_usd: null, labels: [] });
  });

  it("finds menus inside @graph and arrays, and skips broken blocks", () => {
    const html = page({ "@graph": [{ "@type": "WebPage" }, { "@type": "Menu", hasMenuItem: { "@type": "MenuItem", name: "Dal" } }] }) +
      '<script type="application/ld+json">{ not json </script>';
    expect(readSchemaOrg(html).map((i: { name: string }) => i.name)).toEqual(["Dal"]);
    expect(extractJsonLd("<p>no data</p>")).toEqual([]);
  });

  it("reads diets given as objects, and skips items with no printed name", () => {
    const items = readSchemaOrg(page({ "@type": "MenuSection", hasMenuItem: [
      { "@type": "MenuItem", name: "Red Curry", suitableForDiet: [{ "@type": "RestrictedDiet", name: "vegan" }, { "@type": "RestrictedDiet", name: "gluten free" }] },
      { "@type": "MenuItem", name: "&nbsp;", description: "Nutrition information and the fine print" },
    ] }));
    expect(items.map((i: { name: string; labels: string[] }) => [i.name, i.labels])).toEqual([["Red Curry", ["vegan", "gluten free"]]]);
  });

  it("ignores prices in another currency", () => {
    expect(readSchemaOrg(page({ "@type": "MenuItem", name: "Tea", offers: { price: "3", priceCurrency: "EUR" } }))[0].price_usd).toBeNull();
  });
});

describe("amounts, prices and match keys", () => {
  it("parses amounts and never turns a blank into zero", () => {
    expect(parseAmount("21g")).toEqual({ amount: 21, unit: "g" });
    expect(parseAmount("1,200 mg")).toEqual({ amount: 1200, unit: "mg" });
    expect(parseAmount("0 g")).toEqual({ amount: 0, unit: "g" });
    for (const v of ["", "-", "n/a", null, undefined]) expect(parseAmount(v)).toBeNull();
    expect(parsePrice("$12.50")).toBe(12.5);
    expect(parsePrice("market price")).toBeNull();
  });
  it("one dish, one key, however it is printed", () => {
    expect(matchKey("Harvest Bowl™")).toBe("harvest bowl");
    expect(matchKey("  HARVEST   bowl ")).toBe("harvest bowl");
    expect(matchKey("Mac & Cheese")).toBe("mac and cheese");
    expect(matchKey("Crème Brûlée")).toBe("creme brulee");
  });
});

describe("links to follow", () => {
  it("only menu, nutrition, allergen and ingredient pages on the same site", () => {
    const html = `
      <a href="/menu">Our menu</a><a href="https://www.chain.test/nutrition.pdf">Nutrition</a>
      <a href="/about">About</a><a href="https://other.test/menu">Elsewhere</a>
      <a href="/allergens#top">Allergen guide</a><a href="/img/menu.jpg">Menu photo</a><a href="mailto:a@chain.test">menu by email</a>`;
    expect(findMenuLinks(html, "https://chain.test/").map((l: { url: string }) => l.url)).toEqual([
      "https://chain.test/menu", "https://www.chain.test/nutrition.pdf", "https://chain.test/allergens",
    ]);
  });
  it("reads unquoted links too", () => {
    expect(findMenuLinks("<a href=/menu class=nav>Menu</a><a href=/careers>Jobs</a>", "https://chain.test/").map((l: { url: string }) => l.url)).toEqual(["https://chain.test/menu"]);
  });
});

describe("site readers", () => {
  it("only schema.org applies until a site's terms or a written permission allow a site reader", () => {
    for (const h of ["www.sweetgreen.com", "lifealive.com", "chain.test"]) expect(readersFor(h)).toEqual(["schema_org"]);
    expect(() => readWith("lifealive", "<html></html>")).toThrow("Unknown reader lifealive");
  });
});
