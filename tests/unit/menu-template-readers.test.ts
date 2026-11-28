import { describe, expect, it } from "vitest";
import { isBentoBox, isWpCafe, readBentoBox, readWith, readWpCafe, readersFor } from "../../scripts/lib/menu-readers.mjs";

// Template readers. Pages are invented fixtures in each builder's markup; no restaurant's content.

const bentoItem = (name: string, inner: string) => `
  <li class="menu-item menu-item--flex">
    <div class="menu-item__heading"><p class="menu-item__heading menu-item__heading--name">${name}</p></div>
    <p class="menu-item__details--description">A long description the reader must never keep.</p>
    ${inner}
  </li>`;
const price = (label: string | null, usd: string) =>
  `<p class="menu-item__details menu-item__details--price">${label ? `<strong>${label}</strong> ` : ""}<strong><span class="menu-item__currency">$</span>${usd}</strong></p>`;
const addon = (t: string) => `<p class="menu-item__details menu-item__details--addon">${t}<span></span></p>`;
const tags = (...t: string[]) => `<div class="menu-item__details--dietary_icons">${t.map((x) => `<img class="menu-item__dietary-info-${x}" aria-label="${x}" />`).join("")}</div>`;
const bento = (sections: [string, string[]][]) =>
  `<html><body><footer>powered by BentoBox</footer>${sections.map(([h, items]) => `<section class="menu-section" id="x"><div class="menu-section__header"><h2>${h}</h2></div><ul>${items.join("")}</ul></section>`).join("")}</body></html>`;

describe("BentoBox menus", () => {
  const html = bento([
    ["Bowls", [
      bentoItem("Test Tofu Bowl", price(null, "14.95") + addon("32g pro | 9g fiber")),
      bentoItem("Test Range Bowl", price(null, "16.95") + addon("26-44g pro | 12g fiber")),
      bentoItem("Test Smoothie", price("14oz (420 cal)", "9.95") + price("20oz (630 cal)", "13.95") + addon("Allergens: soy, coconut") + addon("14oz | 11g protein") + addon("20oz | 16g protein")),
      bentoItem("Test Salad", price("Small | 7g pro | 6g fiber", "11.45").replace("</p>", " (240 cal.)</p>") + price("Large | 14g pro | 12g fiber", "17.95").replace("</p>", " (470 cal.)</p>")),
    ]],
    ["Bases", [bentoItem("Test Rice", tags("dairy", "wheat", "vegetarian")), bentoItem("Test Quinoa", tags("vegetarian", "vegan"))]],
  ]);

  it("recognises the template only with its menu markup", () => {
    expect(isBentoBox(html)).toBe(true);
    expect(isBentoBox("<footer>powered by BentoBox</footer>")).toBe(false);
    expect(readersFor("example.test", html)).toEqual(["schema_org", "bentobox"]);
    expect(readersFor("example.test")).toEqual(["schema_org"]);
  });

  it("keeps names, sections, prices, tags and printed protein, and never the description", () => {
    const items = readBentoBox(html);
    expect(items.map((i) => [i.section, i.name])).toEqual([["Bowls", "Test Tofu Bowl"], ["Bowls", "Test Range Bowl"], ["Bowls", "Test Smoothie"], ["Bowls", "Test Salad"], ["Bases", "Test Rice"], ["Bases", "Test Quinoa"]]);
    expect(items.every((i) => i.description === null)).toBe(true);
    expect(JSON.stringify(items)).not.toContain("long description");
    expect(items[0]).toMatchObject({ price_usd: 14.95, nutrition: { protein_g: { amount: 32, unit: "g", per: "serving" }, fiber_g: { amount: 9 } } });
    expect(items[4].labels).toEqual(["dairy", "wheat", "vegetarian"]);
    expect(items[4].price_usd).toBeNull();
    expect(items[4].nutrition).toEqual({});
  });

  it("keeps a printed range as a range, never one number", () => {
    const r = readBentoBox(html)[1];
    expect(r.nutrition.protein_g).toBeUndefined();
    expect(r.published_ranges.protein_g).toEqual({ low: 26, high: 44, unit: "g", per: "serving" });
  });

  it("matches each size to its own price, calories and protein", () => {
    const s = readBentoBox(html)[2];
    expect(s.allergens).toEqual(["soy", "coconut"]);
    expect(s.variants).toEqual([
      { label: "14oz", usd: 9.95, kcal: 420, protein_g: 11 },
      { label: "20oz", usd: 13.95, kcal: 630, protein_g: 16 },
    ]);
    expect(s).toMatchObject({ price_usd: 9.95, serving: "14oz", nutrition: { protein_g: { amount: 11 }, energy_kcal: { amount: 420 } } });
  });
});

describe("BentoBox sizes that print their own protein", () => {
  it("reads protein, fiber and calories written in the size label and after the price", () => {
    const html = bento([["Salads", [bentoItem("Test Salad", price("Small | 7g pro | 6g fiber", "11.45").replace("</p>", " (240 cal.)</p>") + price("Large | 14g pro | 12g fiber", "17.95").replace("</p>", " (470 cal.)</p>"))]]]);
    const [s] = readBentoBox(html);
    expect(s.variants).toEqual([
      { label: "Small", usd: 11.45, kcal: 240, protein_g: 7 },
      { label: "Large", usd: 17.95, kcal: 470, protein_g: 14 },
    ]);
    expect(s).toMatchObject({ serving: "Small", nutrition: { protein_g: { amount: 7 }, fiber_g: { amount: 6 }, energy_kcal: { amount: 240 } } });
  });
});

describe("WP Cafe menus", () => {
  const item = (name: string, usd: string | null) => `
    <div class="wpc-food-menu-item wpc-row"><div class="wpc-food-inner-content">
      <h3 class="wpc-post-title wpc-title-with-border"><a href="" class="wpc-no-link"> ${name} </a><span class="wpc-title-border"></span>
      ${usd ? `<span class="wpc-menu-price"><span class="woocommerce-Price-amount amount"><span class="woocommerce-Price-currencySymbol">&#036;</span>${usd}</span></span>` : ""}</h3>
      <p>Words the reader must never keep.</p></div></div>`;
  const html = `<ul><li><a href='#' class='wpc-tab-a ' data-id='tab_0' data-cat_id='1'><span>SOUPS</span></a></li>
    <li><a href='#' class='wpc-tab-a ' data-id='tab_1' data-cat_id='2'><span>VEGETARIAN CORNER</span></a></li></ul>
    <div class="wpc-tab-content"><div class='wpc-tab tab-active' data-id='tab_0' data-cat_id='1'>${item("Test Soup", "6.50")}</div>
    <div class='wpc-tab' data-id='tab_1' data-cat_id='2'>${item("Test Tofu", "18.95")}${item("Test Tofu", "18.95")}${item("Test Greens", null)}</div></div>`;

  it("reads each tab as a section, once per dish, without the description", () => {
    expect(isWpCafe(html)).toBe(true);
    const items = readWith("wpcafe", html);
    expect(items.map((i: { section: string; name: string; price_usd: number | null }) => [i.section, i.name, i.price_usd])).toEqual([
      ["SOUPS", "Test Soup", 6.5], ["VEGETARIAN CORNER", "Test Tofu", 18.95], ["VEGETARIAN CORNER", "Test Greens", null],
    ]);
    expect(JSON.stringify(items)).not.toContain("never keep");
  });

  it("treats a section name as the restaurant's grouping, not a diet label", () => {
    expect(readWpCafe(html).every((i) => i.labels.length === 0)).toBe(true);
  });
});
