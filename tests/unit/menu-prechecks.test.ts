import { describe, expect, it } from "vitest";
import { cleanGroups, isException, normalLabel, rowFlags } from "@/contracts/menu-prechecks";
import { estimateWords, factWords, type MenuDish, type MenuEstimate, type MenuFact } from "@/contracts/menu-review";

// Automatic pre-checks (docs/58): they sort rows so doubtful ones come first. They never confirm
// anything; a clean group still needs the founder's own comparison with the source.

const SRC = "11111111-1111-4111-8111-111111111111";
const fact = (p: Partial<MenuFact>): MenuFact => ({
  factId: crypto.randomUUID(),
  kind: "price",
  subject: null,
  value: { usd: "12.00" },
  unknown: false,
  unknownReason: null,
  status: "submitted",
  confidence: "high",
  sourceId: SRC,
  checkedOn: "2026-11-18",
  access: "private_pilot",
  confirmAs: "transcription",
  canConfirm: true,
  canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: false, publicationApproved: false },
  ...p,
});
const vegan = () => fact({ kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } });
const nut = (nutrient: string, amount: string, extra: Record<string, unknown> = {}) =>
  fact({ kind: "published_nutrition", subject: nutrient, value: { nutrient, amount, per: "serving", ...extra } });
const dish = (label: string, facts: MenuFact[], type: MenuDish["structure"] = null): MenuDish => ({
  dishId: crypto.randomUUID(),
  label,
  structure: type,
  options: [],
  estimate: null,
  facts,
  corrections: [],
});
const meal = (parentDishId: string | null = null, t: "complete_meal" | "component" = "complete_meal") => ({
  type: t,
  parentDishId,
  section: "Bowls",
  portion: null,
  basis: "source_section" as const,
  evidence: null,
});
const codes = (d: MenuDish, all: MenuDish[]) => rowFlags(d, { dishes: all }).map((f) => f.code);

describe("pre-check flags", () => {
  it("a classified vegan meal with a price and plausible nutrition is clean", () => {
    const d = dish("Tofu bowl", [fact({}), vegan(), nut("energy_kcal", "600"), nut("protein_g", "30"), nut("carb_g", "70"), nut("fat_g", "20")], meal());
    expect(isException(rowFlags(d, { dishes: [d] }))).toBe(false);
  });
  it("flags unclassified rows, rows with no dietary evidence and low confidence", () => {
    const d = dish("Mystery", [fact({ confidence: "low" })]);
    expect(codes(d, [d])).toEqual(expect.arrayContaining(["unclassified", "no_dietary_evidence", "low_confidence"]));
  });
  it("flags likely duplicates by normalized name, but not a topping and a dish of the same name in different meals", () => {
    const a = dish("Hummus & Pita", [vegan(), fact({})], meal());
    const b = dish("hummus and pita (large)", [vegan(), fact({})], meal());
    expect(codes(a, [a, b])).toContain("possible_duplicate");
    const parent = dish("Build your own bowl", [vegan()], { ...meal(), type: "customizable_meal" });
    const topping = dish("Hummus", [vegan()], meal(parent.dishId, "component"));
    const dip = dish("Hummus (dip)", [vegan(), fact({})], meal());
    expect(codes(topping, [parent, topping, dip])).not.toContain("possible_duplicate");
    expect(normalLabel("The Falafel & Tahini Roll!")).toBe("falafel and tahini roll");
  });
  it("flags vegan rows whose listed ingredients name animal products, but not plant versions", () => {
    const vham = dish("Emperor Tofu", [fact({ kind: "dietary_status", subject: "vegetarian", value: { claim: "vegetarian", status: "yes" } }), fact({ kind: "listed_ingredients", value: { items: ["tofu", "vegetarian ham"] } })], meal());
    expect(codes(vham, [vham])).not.toContain("ingredient_conflict");
    const bad = dish("Bowl", [vegan(), fact({ kind: "listed_ingredients", value: { items: ["rice", "feta", "honey"] } })], meal());
    expect(codes(bad, [bad])).toContain("ingredient_conflict");
    const ok = dish("Bowl", [vegan(), fact({ kind: "listed_ingredients", value: { items: ["rice", "vegan feta", "oat milk", "eggplant"] } })], meal());
    expect(codes(ok, [ok])).not.toContain("ingredient_conflict");
  });
  it("flags nutrition that does not add up, such as NAYA's falafel fiber", () => {
    const d = dish("Falafel", [vegan(), nut("carb_g", "41"), nut("fiber_g", "22")], meal());
    expect(codes(d, [d])).toContain("implausible_nutrition");
    const k = dish("Bowl", [vegan(), nut("energy_kcal", "200"), nut("protein_g", "30"), nut("carb_g", "70"), nut("fat_g", "20")], meal());
    expect(codes(k, [k])).toContain("implausible_nutrition");
  });
  it("ranges and estimates are noted, not flagged, and are never read as one number", () => {
    const d = dish("Bowl", [vegan(), fact({}), nut("protein_g", "", { basis: "published_range", amount: undefined, low: "12", high: "18" }), nut("energy_kcal", "500", { basis: "restaurant_estimate" })], meal());
    const f = rowFlags(d, { dishes: [d] });
    expect(f.map((x) => x.code)).toEqual(expect.arrayContaining(["published_range", "restaurant_estimate"]));
    expect(isException(f)).toBe(false);
  });
  it("a part of a build-your-own meal says so and is not asked for a price or dietary evidence", () => {
    const parent = dish("Build your own bowl", [vegan()], { ...meal(), type: "customizable_meal" });
    const part = dish("Brown rice", [nut("protein_g", "5")], meal(parent.dishId, "component"));
    const c = codes(part, [parent, part]);
    expect(c).toContain("part_of_meal");
    expect(c).not.toContain("no_dietary_evidence");
    expect(c).not.toContain("missing_price");
  });
});

const modelled = (low: number | null, high: number | null, state: "estimated" | "unknown" = "estimated"): MenuEstimate => ({
  state: "modelled",
  modelId: crypto.randomUUID(),
  evidence: "listed_ingredients",
  at: "2026-11-18T21:00:00Z",
  modelStatus: "draft",
  assumptions: "Typical amounts.",
  servingBasis: "typical",
  lines: [],
  result: { state, central: low === null ? null : (low + (high ?? low)) / 2, low, high, confidence: state === "estimated" ? "low" : null, reason: state === "unknown" ? "range_too_wide" : null },
});

describe("estimates, prices and unstated diets", () => {
  it("notes a USDA estimate as a labelled range and never as a check or dietary evidence", () => {
    const d = { ...dish("Lentil stew", [fact({}), vegan()], meal()), estimate: modelled(16.758, 27.392) };
    const f = rowFlags(d, { dishes: [d] });
    expect(f.find((x) => x.code === "usda_estimate")).toMatchObject({ level: "note" });
    expect(f.find((x) => x.code === "usda_estimate")!.words).toContain("about 16 to 28 g protein");
    expect(isException(f)).toBe(false);
    const none = { ...dish("Lentil stew", [fact({})], meal()), estimate: modelled(16.758, 27.392) };
    expect(codes(none, [none])).toContain("no_dietary_evidence");
  });
  it("says why an estimate is unknown", () => {
    expect(estimateWords(modelled(null, null, "unknown"))).toMatch(/unknown, because the likely range is too wide/);
    expect(estimateWords({ state: "unknown", reason: "The menu says only vegetables.", at: "x" })).toBe("USDA estimate: unknown. The menu says only vegetables.");
  });
  it("flags a meal that has both an estimate and the restaurant's own protein", () => {
    const d = { ...dish("Bowl", [fact({}), vegan(), nut("protein_g", "20")], meal()), estimate: modelled(10, 15) };
    expect(codes(d, [d])).toContain("estimate_and_published");
  });
  it("flags a price far from the menu's usual meal price, given enough meals to compare", () => {
    const priced = (label: string, usd: string) => dish(label, [fact({ value: { usd } }), vegan()], meal());
    const rows = [priced("A", "14.95"), priced("B", "15.95"), priced("C", "13.95"), priced("D", "14.50"), priced("E", "149.50"), priced("F", "1.50")];
    expect(codes(rows[4], rows)).toContain("price_outlier");
    expect(codes(rows[5], rows)).toContain("price_outlier");
    expect(codes(rows[0], rows)).not.toContain("price_outlier");
    expect(codes(rows[4], rows.slice(3, 5))).not.toContain("price_outlier");
  });
  it("notes a meal whose menu says nothing either way about diet, without making it an exception", () => {
    const d = dish("Curry", [fact({}), fact({ kind: "dietary_status", subject: "vegetarian", value: null, unknown: true, unknownReason: "Not stated" })], meal());
    const f = rowFlags(d, { dishes: [d] });
    expect(f.map((x) => x.code)).toContain("diet_not_stated");
    expect(f.map((x) => x.code)).not.toContain("no_dietary_evidence");
  });
});

describe("clean groups", () => {
  it("groups clean rows by source and kind of confirmation, leaving exceptions and decided rows out", () => {
    const clean1 = dish("A", [fact({}), vegan()], meal());
    const clean2 = dish("B", [fact({}), vegan()], meal());
    const flagged = dish("C", [fact({ confidence: "low" }), vegan()], meal());
    const done = dish("D", [fact({ status: "verified", canConfirm: false, canReject: false, confirmAs: null })], meal());
    const cleared = { sourceId: "22222222-2222-4222-8222-222222222222", access: "cleared" as const, confirmAs: "verify" as const };
    const other = dish("E", [fact(cleared), fact({ ...cleared, kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" } })], meal());
    const g = cleanGroups({ dishes: [clean1, clean2, flagged, done, other] });
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ sourceIds: [SRC], method: "transcription", dishIds: [clean1.dishId, clean2.dishId], facts: 4 });
    expect(g[1].method).toBe("verify");
  });
  it("splits clean rows from different menu sections into separate groups", () => {
    const a = dish("A", [fact({}), vegan()], meal());
    const b = dish("B", [fact({}), vegan()], { ...meal(), section: "Salads" });
    const g = cleanGroups({ dishes: [a, b] });
    expect(g.map((x) => x.section).sort()).toEqual(["Bowls", "Salads"]);
  });
  it("rows using the same two sources group together; a row mixing kinds of confirmation does not group", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    let n = 0;
    const two = () => dish(`Row ${++n}`, [fact({}), vegan(), fact({ kind: "listed_ingredients", value: { items: ["rice"] }, sourceId: OTHER })], meal());
    const g = cleanGroups({ dishes: [two(), two()] });
    expect(g).toHaveLength(1);
    expect(g[0].sourceIds).toEqual([SRC, OTHER].sort());
    const mixed = dish("A", [fact({}), vegan(), fact({ sourceId: OTHER, access: "cleared", confirmAs: "verify" })], meal());
    expect(cleanGroups({ dishes: [mixed] })).toEqual([]);
  });
});

describe("nutrition words", () => {
  it("keeps ranges as ranges and labels estimates", () => {
    expect(factWords({ kind: "published_nutrition", subject: "protein_g", unknown: false, unknownReason: null, value: { nutrient: "protein_g", low: "12", high: "18", per: "serving", basis: "published_range" } })).toBe(
      "Protein 12 to 18 g per serving (published range, not one value)",
    );
    expect(factWords({ kind: "published_nutrition", subject: "protein_g", unknown: false, unknownReason: null, value: { nutrient: "protein_g", amount: "9", per: "serving", basis: "restaurant_estimate" } })).toBe(
      "Protein 9 g per serving (the restaurant's own estimate)",
    );
    expect(factWords({ kind: "published_nutrition", subject: "protein_g", unknown: false, unknownReason: null, value: { nutrient: "protein_g", amount: "6", per: "serving", portion: "3 oz" } })).toBe(
      "Protein 6 g per 3 oz (published)",
    );
  });
});

describe("automatic comparison with the saved page", () => {
  const mc = (result: "found" | "not_found" | "not_checked", detail = "Test detail.") => ({ machineCheck: { result, detail, pageSavedAt: "2026-11-18T17:00:00Z", at: "2026-11-18T23:40:00Z" } });
  it("a value the comparison could not find makes the row an exception with the reason", () => {
    const d = dish("Lentil plate", [fact(mc("not_found", "$12.00 does not appear shortly after the dish name.")), { ...vegan(), ...mc("found") }], meal());
    const flags = rowFlags(d, { dishes: [d] });
    const f = flags.find((x) => x.code === "automatic_not_found")!;
    expect(f.level).toBe("check");
    expect(f.words).toContain("$12.00 does not appear");
    expect(isException(flags)).toBe(true);
    expect(cleanGroups({ dishes: [d] })).toEqual([]);
  });

  it("all values found is only a note, says it is not the founder's check, and opens the automatic option", () => {
    const a = dish("Lentil plate", [fact(mc("found")), { ...vegan(), ...mc("found") }], meal());
    const b = dish("Tofu plate", [fact(mc("found")), { ...vegan(), ...mc("found") }], meal());
    const f = rowFlags(a, { dishes: [a, b] }).find((x) => x.code === "automatic_found")!;
    expect(f.level).toBe("note");
    expect(f.words).toMatch(/not a check by you/);
    const [g] = cleanGroups({ dishes: [a, b] });
    expect(g.dishIds).toHaveLength(2);
    expect(g.automaticAllFound).toBe(true);
  });

  it("a row with a value not compared, or recorded as unknown, never counts as all found", () => {
    const a = dish("Lentil plate", [fact(mc("found")), { ...vegan(), ...mc("found") }], meal());
    const b = dish("Tofu plate", [fact(mc("found")), { ...vegan(), ...mc("not_checked") }], meal());
    const c = dish("Kale plate", [fact({}), vegan()], meal());
    expect(cleanGroups({ dishes: [a, b] })[0].automaticAllFound).toBe(false);
    expect(cleanGroups({ dishes: [c] })[0].automaticAllFound).toBe(false);
    expect(codes(b, [a, b])).not.toContain("automatic_found");
    expect(codes(c, [c])).not.toContain("automatic_found");
  });
});
