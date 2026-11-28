import { describe, expect, it } from "vitest";
import { namesAgree, precheckIdentity } from "../../scripts/lib/identity-precheck.mjs";

// Automatic identity pre-check (docs/51). Synthetic places only.

const lic = (o: Record<string, unknown> = {}) => ({ source: "Test licences", sourceKey: "boston_food_licenses", name: "Test Lantern", street: "12 Sample", category: "eating & drinking", website: null, openStatus: "licensed_active", present: true, ...o });
const ovt = (o: Record<string, unknown> = {}) => ({ source: "Test places", sourceKey: "overture_places", name: "Test Lantern", street: "12 Sample St", category: "restaurant", website: "https://testlantern.example/", openStatus: "open", present: true, ...o });

describe("names that agree apart from common words", () => {
  it("accepts legal forms, location tails and filler words", () => {
    expect(namesAgree("TEST LANTERN RESTAURANT INC.", "Test Lantern")).toBe(true);
    expect(namesAgree("Test Lantern Donuts", "Test Lantern")).toBe(true);
    expect(namesAgree("Test Lantern of Boston", "Test Lantern")).toBe(true);
    expect(namesAgree("Test Lantern", "Test Lantern - Back Bay")).toBe(true);
    expect(namesAgree("Test Lantern", "Test Lantern | Pier 9")).toBe(true);
  });
  it("refuses different businesses", () => {
    expect(namesAgree("Harbor Food Market", "Sample Food Market - Harbor")).toBe(false);
    expect(namesAgree("Test Lantern", "Test Kettle")).toBe(false);
  });
});

describe("the pre-check result", () => {
  it("agrees when both sources agree on name, place, number and status", () => {
    const r = precheckIdentity({ records: [lic(), ovt()], recordsApartMetres: 9, lookalikes: [] });
    expect(r.level).toBe("agree");
    expect(r.points.every((p) => p.ok)).toBe(true);
    expect(r.version).toBe(1);
  });
  it("one source, far apart, other numbers, dropped, unknown status and look-alikes each ask for a look", () => {
    expect(precheckIdentity({ records: [lic()], lookalikes: [] }).level).toBe("look");
    const r = precheckIdentity({ records: [lic({ present: false }), ovt({ street: "80 Other St", openStatus: "unknown" })], recordsApartMetres: 240, lookalikes: [{ name: "Test Lantern 2" }] });
    expect(r.level).toBe("look");
    expect(r.points.filter((p) => !p.ok).map((p) => p.code).sort()).toEqual(["distance", "dropped", "house_number", "lookalikes", "open_status"]);
  });
  it("flags a website that belongs to an ordering or deals service, and a name that sounds like a shop", () => {
    const web = precheckIdentity({ records: [lic(), ovt({ website: "https://www.groupon.com/biz/boston/test-lantern" })], recordsApartMetres: 5, lookalikes: [] });
    expect(web.level).toBe("look");
    expect(web.points.find((p) => p.code === "website")?.text).toBe("The website on file is a page on groupon.com, not the place's own site.");
    const shop = precheckIdentity({ records: [lic({ name: "Test Lantern Market" }), ovt({ name: "Test Lantern Market" })], recordsApartMetres: 5, lookalikes: [] });
    expect(shop.points.find((p) => p.code === "shop_name")?.ok).toBe(false);
  });
  it("never says verified", () => {
    const r = precheckIdentity({ records: [lic(), ovt()], recordsApartMetres: 9, lookalikes: [] });
    expect(JSON.stringify(r)).not.toMatch(/verif/i);
  });
});
