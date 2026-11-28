import { describe, expect, it } from "vitest";
import type { MenuDish, MenuPlace } from "@/contracts/menu-review";
import { sourceOutcome, tallyOf, verifyDish, workload } from "@/contracts/verification";

// Verification dry run (owner directive 28 Nov 2026 04:59 UTC, part 2). Invented dishes only.

const SRC = "00000000-0000-4000-8000-000000000001";
const OLD = "00000000-0000-4000-8000-000000000002";
const place = {
  placeId: "00000000-0000-4000-8000-0000000000aa", label: "Test Kitchen", area: "back_bay", city: "Boston", placeFacts: [], dishes: [],
  sources: [
    { sourceId: SRC, url: "https://example.test/menu", host: "example.test", kind: "restaurant_site", publisher: "Test", retrievedAt: "2026-11-28T00:00:00Z", access: "private_pilot" },
    { sourceId: OLD, url: "https://phopasteurboston.net/Boston%20Full%20Menu-2024-September.pdf", host: "phopasteurboston.net", kind: "restaurant_site", publisher: "Test", retrievedAt: "2026-11-23T00:00:00Z", access: "private_pilot" },
  ],
} as unknown as MenuPlace;
type F = { kind: string; subject?: string; value?: Record<string, unknown> | null; unknown?: boolean; check?: "found" | "not_found" | "not_checked" | null; detail?: string; source?: string; confidence?: string };
let n = 0;
const fact = (f: F) => ({
  factId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, kind: f.kind, subject: f.subject ?? null, value: f.unknown ? null : (f.value ?? null),
  unknown: !!f.unknown, unknownReason: f.unknown ? "The menu does not say" : null, status: "submitted", confidence: f.confidence ?? "high", sourceId: f.source ?? SRC,
  checkedOn: "2026-11-28", access: "private_pilot", confirmAs: "transcription", canConfirm: true, canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: false, publicationApproved: false },
  machineCheck: f.check === null || (f.unknown && f.check === undefined) ? null
    : { result: f.check ?? "found", detail: f.detail ?? (f.kind === "dietary_status" ? `The word "${f.subject}" appears shortly after the dish name.` : "found"), pageSavedAt: "2026-11-28T00:00:00Z", at: "2026-11-28T00:00:00Z" },
});
const dish = (label: string, facts: F[]): MenuDish => ({
  dishId: `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`, label, structure: { type: "complete_meal", parentDishId: null, section: null, portion: null, basis: "source_section", evidence: null },
  options: [], estimate: null, corrections: [], facts: [fact({ kind: "menu_item", value: { listed: true } }), ...facts.map(fact)],
}) as unknown as MenuDish;
const veg = (yes = true): F => (yes ? { kind: "dietary_status", subject: "vegetarian", value: { claim: "vegetarian", status: "yes" } } : { kind: "dietary_status", subject: "vegetarian", unknown: true });
const vegan = (yes = true, check: F["check"] = "found"): F => (yes ? { kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" }, check } : { kind: "dietary_status", subject: "vegan", unknown: true });
const items = (...i: string[]): F => ({ kind: "listed_ingredients", value: { items: i } });
const price = (usd: string, extra: Partial<F> = {}): F => ({ kind: "price", value: { usd }, ...extra });
const run = (d: MenuDish) => verifyDish(d, place, "unknown", Date.parse("2026-11-28T12:00:00Z"));

describe("source verification (dimension 1)", () => {
  it("is A only when every stated fact was found on the saved page", () => {
    expect(run(dish("Chana Masala", [price("14.00"), veg(), vegan(false)])).source).toBe("A");
  });
  it("sends a fact that was not found, or never compared, to a person (B)", () => {
    expect(run(dish("Saag", [price("15.00", { check: "not_found", detail: "$15.00 does not appear shortly after the dish name." })])).source).toBe("B");
    expect(run(dish("Dal", [price("12.00", { check: null })])).source).toBe("B");
  });
  it("marks a missing saved copy or a September 2024 price as unavailable or outdated (E), never as verified", () => {
    const r = run(dish("Pho Chay", [price("13.95", { source: OLD })]));
    expect(r.source).toBe("E");
    expect(r.sourceReasons.join(" ")).toMatch(/old menu edition/);
    expect(run(dish("Tofu Bowl", [price("11.00", { check: "not_checked", detail: "No saved copy of the source page is available here." })])).source).toBe("E");
  });
  it("needs the dish name itself to be found", () => {
    const d = dish("Ghost Dish", [price("9.00")]);
    d.facts[0].machineCheck = { result: "not_found", detail: "not found", pageSavedAt: null, at: "2026-11-28T00:00:00Z" };
    expect(sourceOutcome(d, place).source).toBe("B");
  });
});

describe("dietary evidence (dimension 2) never turns silence or cuisine into a claim", () => {
  it("a vegetarian label found next to the dish is a vegetarian candidate, but says nothing about vegan or egg", () => {
    const r = run(dish("Paneer Dosa", [veg(), vegan(false), items("paneer")]));
    expect(r.diet.vegetarian).toMatchObject({ outcome: "candidate", scope: "dish" });
    expect(r.diet.vegan.outcome).toBe("C"); // paneer is dairy
    expect(r.diet.egg_free.outcome).toBe("D"); // egg is never ruled out by silence
    expect(r.eligibility).toEqual({ vegetarian: true, vegan: false, egg_free: false });
  });
  it("an egg salad the restaurant prints as Veg is vegetarian by its word and never egg-free (Madras Dosa, 28 Nov)", () => {
    const r = run(dish("Egg Salad Canteen Sandwiches", [veg(), items("egg salad")]));
    expect(r.diet.vegetarian.outcome).toBe("candidate");
    expect(r.diet.egg_free.outcome).toBe("C");
  });
  it("a tea egg excludes vegan and egg-free even with a vegetarian label (Gene's Xi'an Cold Noodles)", () => {
    const r = run(dish("Xi'an Cold Noodles", [veg(), vegan(false), items("noodles", "one tea egg")]));
    expect(r.diet.vegan.outcome).toBe("C");
    expect(r.diet.egg_free.outcome).toBe("C");
    expect(r.diet.vegetarian.outcome).toBe("candidate");
  });
  it("a vegan label contradicted by a printed ingredient goes to a person, and is not a candidate meanwhile", () => {
    const r = run(dish("Vegan Bowl", [vegan(), items("rice", "feta")]));
    expect(r.diet.vegan.outcome).toBe("B");
    expect(r.eligibility.vegan).toBe(false);
  });
  it("honey is handled explicitly for vegan", () => {
    expect(run(dish("Granola Bowl", [vegan(), items("oats", "honey")])).diet.vegan.outcome).toBe("B");
  });
  it("a dish that names meat with no claim is excluded from all three", () => {
    const r = run(dish("Chicken Dosa", [items("chicken")]));
    expect([r.diet.vegetarian.outcome, r.diet.vegan.outcome, r.diet.egg_free.outcome]).toEqual(["C", "C", "C"]);
  });
  it("no label at all is insufficient evidence (D), whatever the cuisine", () => {
    const r = run(dish("Masala Dosa", [veg(false), vegan(false), items("spicy potatoes")]));
    expect(r.diet.vegetarian.outcome).toBe("D");
    expect(r.diet.vegan.outcome).toBe("D");
  });
  it("a vegan word that the comparison did not find on the page is an exception, not a candidate", () => {
    expect(run(dish("Vegan Dosa", [vegan(true, "not_found")])).diet.vegan.outcome).toBe("B");
  });
  it("a section or whole-menu statement is a candidate with that scope recorded", () => {
    const d = dish("Tofu Wrap", [{ kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" }, detail: "A statement covering the whole menu (\"100% vegan\") says it is all vegan; the word is not next to the dish." }]);
    expect(run(d).diet.vegan).toMatchObject({ outcome: "candidate", scope: "section_or_menu" });
  });
  it("plant-based meat is not meat", () => {
    expect(run(dish("Plant Based Meat Dosa", [vegan(), items("seasoned plant-based filling")])).diet.vegetarian.outcome).toBe("candidate");
  });
});

describe("counting", () => {
  it("counts each dish once per dimension and never publishes", () => {
    const rows = [run(dish("A1", [veg(), price("10.00")])), run(dish("A2", [price("10.00", { check: "not_found" })])), run(dish("A3", [items("beef")]))];
    const t = tallyOf(rows);
    expect(t.dishes).toBe(3);
    expect(t.source.A + t.source.B + t.source.E).toBe(3);
    for (const f of ["vegetarian", "vegan", "egg_free"] as const) expect(Object.values(t.diet[f]).reduce((a, b) => a + b, 0)).toBe(3);
    expect(t.published).toBe(0);
    expect(workload(rows)).toMatchObject({ meals: 3, transcriptionChecksReplaceable: 2 });
  });
});
