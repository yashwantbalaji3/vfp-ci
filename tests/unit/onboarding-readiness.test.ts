import { describe, expect, it } from "vitest";
import { addressKey, coverageSummary, mergeByLocation, placeReadiness, readinessMarkdown, reviewBatches } from "../../scripts/lib/onboarding-readiness-lib.mjs";

// Synthetic places only (no real restaurant data in tests).
const base = (facts: object[], dishes = [{ key: "a", label: "Bowl A" }, { key: "b", label: "Bowl B" }]) => ({ label: "Test Place", area: "back_bay", dishes, facts });
const addr = { kind: "address", value: { street: "1 Test St", postcode: "02116" } };
const onMenu = (dish: string) => ({ kind: "menu_item", dish, value: { listed: true } });
const vegan = (dish: string, status = "yes") => ({ kind: "dietary_status", dish, subject: "vegan", value: { claim: "vegan", status } });
const unknownVegan = (dish: string) => ({ kind: "dietary_status", dish, subject: "vegan", unknownReason: "Marked 'vegan-friendly' only" });

describe("placeReadiness", () => {
  it("is ready for founder review with an address and two listed dishes the restaurant states are vegan", () => {
    const r = placeReadiness(base([addr, onMenu("a"), onMenu("b"), vegan("a"), vegan("b")]));
    expect(r.tier).toBe("review");
    expect(r.missing).toEqual([]);
    // Unknown status, hours, prices and protein never block, but are reported.
    expect(r.state).toMatchObject({ status: "missing", hours: "missing", prices: "missing", protein: "missing" });
  });

  it("never counts an ambiguous label or a stated 'no' as dietary evidence", () => {
    const r = placeReadiness(base([addr, onMenu("a"), onMenu("b"), unknownVegan("a"), vegan("b", "no")]));
    expect(r.tier).toBe("partial");
    expect(r.state.dietary).toBe("missing");
    expect(r.missing).toContain("At least 2 dishes the restaurant itself states are vegetarian or vegan");
    expect(r.unknownReasons).toEqual([{ kind: "dietary_status", dish: "a", reason: "Marked 'vegan-friendly' only" }]);
  });

  it("a dish not confirmed on the menu does not count, even with a dietary statement", () => {
    const r = placeReadiness(base([addr, onMenu("a"), vegan("a"), vegan("b")]));
    expect(r.state.dishes).toBe("partial");
    expect(r.state.dietary).toBe("partial");
    expect(r.tier).toBe("partial");
  });

  it("a place without an address is not yet identified; protein unknown is allowed and reported", () => {
    const r = placeReadiness(base([onMenu("a"), onMenu("b"), vegan("a"), vegan("b"), { kind: "published_nutrition", dish: "a", subject: "protein_g", value: { nutrient: "protein_g", amount: "20", per: "serving" } }]));
    expect(r.tier).toBe("identity");
    expect(r.state.protein).toBe("partial");
    expect(r.dishes.find((d: { key: string }) => d.key === "a").protein).toBe("20");
    expect(r.dishes.find((d: { key: string }) => d.key === "b").protein).toBeNull();
  });
});

describe("reviewBatches and the report", () => {
  it("packs whole places into batches, readiest first, without exceeding the fact limit", () => {
    const ready = { ...placeReadiness(base([addr, onMenu("a"), onMenu("b"), vegan("a"), vegan("b")])), label: "Ready" };
    const partial = { ...placeReadiness(base([addr])), label: "Partial" };
    const big = { ...placeReadiness(base(Array.from({ length: 50 }, () => addr))), label: "Big" };
    const batches = reviewBatches([partial, big, ready], 20);
    expect(batches[0].places[0]).toBe("Ready");
    for (const b of batches) if (b.places.length > 1) expect(b.facts).toBeLessThanOrEqual(20);
    expect(batches.flatMap((b: { places: string[] }) => b.places).sort()).toEqual(["Big", "Partial", "Ready"]);
  });

  it("the report says everything is unverified and that review readiness is not publication", () => {
    const r = placeReadiness(base([addr]));
    const md = readinessMarkdown([r], reviewBatches([r]), "2026-11-16");
    expect(md).toContain("**unverified**");
    expect(md).toContain("not that anything may be published");
    expect(md).toContain("publication lock stays off");
  });
});

describe("identity deduplication and coverage", () => {
  const at = (label: string, street: string, postcode: string, facts: object[] = [], dishes = [{ key: "a", label: "Bowl A" }, { key: "b", label: "Bowl B" }]) => ({ label, area: "back_bay", dishes, facts: [{ kind: "address", value: { street, postcode } }, ...facts] });

  it("treats the same street and ZIP (spelled differently) as one location and keeps every entry's dishes", () => {
    const main = at("Test Cafe", "10 Example Street", "02116", [onMenu("a"), vegan("a")]);
    const extra = at("Test Cafe (specials)", "10 Example St.", "02116", [onMenu("a"), vegan("a")]);
    const other = at("Test Cafe (Downtown)", "99 Other Ave", "02108");
    const locs = mergeByLocation([main, extra, other]);
    expect(locs).toHaveLength(2);
    expect(locs[0].entries).toEqual(["Test Cafe", "Test Cafe (specials)"]);
    // Dish keys are kept apart, so two dishes from two entries add up to "ready".
    const r = placeReadiness(locs[0]);
    expect(r.tier).toBe("review");
    expect(r.dishes.map((d: { key: string }) => d.key)).toEqual(["e0:a", "e0:b", "e1:a", "e1:b"]);
  });

  it("never merges entries by name alone; an entry without an address stays separate", () => {
    const a = { label: "Same Name", area: "downtown", dishes: [], facts: [] };
    const b = { label: "Same Name", area: "downtown", dishes: [], facts: [] };
    expect(mergeByLocation([a, b])).toHaveLength(2);
    expect(addressKey(a)).toBeNull();
  });

  it("counts entries, unique locations, brands and progress toward the targets without inventing verification", () => {
    const e = [at("Brand (One)", "1 A St", "02116", [onMenu("a"), onMenu("b"), vegan("a"), vegan("b")]), at("Brand (Two)", "2 B St", "02116"), at("Brand (One, menu)", "1 A Street", "02116")];
    const locs = mergeByLocation(e);
    const rs = locs.map(placeReadiness);
    const s = coverageSummary(e, locs, rs);
    expect(s).toMatchObject({ entries: 3, locations: 2, brands: 1, supplemental: 1, ready: 1, verified: 0 });
    expect(s.targets).toEqual([{ target: 10, ready: 1, verified: 0 }, { target: 50, ready: 1, verified: 0 }]);
    const md = readinessMarkdown(rs, reviewBatches(rs), "2026-11-16", { summary: s, blockers: [{ subject: "Example source", reason: "robots.txt disallows it", checked: "2026-11-16" }] });
    expect(md).toContain("**2 unique physical locations** (1 restaurant brands) from 3 research entries");
    expect(md).toContain("First 10: 1/10 ready, 0/10 verified.");
    expect(md).toContain("| Example source | robots.txt disallows it | 2026-11-16 | — |");
    expect(md).toContain("One location, 2 research entries");
  });

  it("an entry that explicitly supersedes an addressless entry joins it into one location", () => {
    const old = { label: "Test Taqueria", area: "harvard_square", dishes: [{ key: "a", label: "A" }, { key: "b", label: "B" }], facts: [onMenu("a"), onMenu("b"), vegan("a"), vegan("b")] };
    const addr2 = { ...at("Test Taqueria (address)", "21 Example St", "02138", [], []), supersedes: "Test Taqueria" };
    const unrelated = { label: "Test Taqueria", area: "downtown", dishes: [], facts: [] };
    const locs = mergeByLocation([old, addr2]);
    expect(locs).toHaveLength(1);
    expect(locs[0].label).toBe("Test Taqueria");
    expect(placeReadiness(locs[0]).tier).toBe("review");
    // Without the explicit link, the same name is not merged.
    expect(mergeByLocation([unrelated, at("Test Taqueria (x)", "1 A St", "02116")])).toHaveLength(2);
  });
});

describe("preliminary restaurant labels (owner 22:26 UTC 16 Nov)", () => {
  const prelim = (dish: string, flags: string[] = []) => ({ kind: "dietary_status", dish, subject: "vegetarian", value: { claim: "vegetarian", status: "yes", evidence: "preliminary_label", label: "VG", labelWording: "Vegetarian & Vegan-Friendly Options", labelSource: "https://example.test/menu", reviewFlags: flags } });

  it("a preliminary label makes a place reviewable, reported apart from explicit statements; vegan stays unknown", () => {
    const r = placeReadiness(base([addr, onMenu("a"), onMenu("b"), prelim("a"), prelim("b"), unknownVegan("a")]));
    expect(r.tier).toBe("review");
    expect(r.evidence).toBe("preliminary");
    expect(r.dishes[0].evidenceClass).toBe("preliminary");
    const e = placeReadiness(base([addr, onMenu("a"), onMenu("b"), vegan("a"), vegan("b")]));
    expect(e.evidence).toBe("explicit");
    const s = coverageSummary([r, e], [r, e], [r, e]);
    expect(s).toMatchObject({ ready: 2, readyExplicit: 1, readyBrand: 0, readyPreliminary: 1, verified: 0 });
  });

  it("a dish with a flagged contradiction (e.g. raita) is listed for review but never counted", () => {
    const r = placeReadiness(base([addr, onMenu("a"), onMenu("b"), prelim("a"), prelim("b", ["Description lists 'cucumber raita'"])]));
    expect(r.tier).toBe("partial");
    expect(r.state.dietary).toBe("partial");
    const md = readinessMarkdown([r], reviewBatches([r]), "2026-11-16");
    expect(md).toContain("Flagged for explicit founder review (not counted toward readiness):");
    expect(md).toContain("Bowl B: Description lists 'cucumber raita'");
  });
});


describe("founder review wording for a preliminary label", () => {
  it("shows the exact label, its definition, its source and every flag, and says it is not verified", async () => {
    const { describeValue } = await import("../../scripts/lib/pilot-review-lib.mjs");
    const text = describeValue({ kind: "dietary_status", subject: "vegetarian", value: { claim: "vegetarian", status: "yes", evidence: "preliminary_label", label: "VG", labelWording: "Vegetarian & Vegan-Friendly Options", labelSource: "https://example.test/menu", reviewFlags: ["Description lists 'cucumber raita'"] } });
    expect(text).toContain('marks it "VG", defined as "Vegetarian & Vegan-Friendly Options" at https://example.test/menu');
    expect(text).toContain("not a verified vegetarian statement");
    expect(text).toContain("CHECK: Description lists 'cucumber raita'");
  });
});

describe("founder-review batches grouped by what is verified (owner 23:11 UTC 16 Nov)", () => {
  const loc = {
    label: "Test Bistro", area: "back_bay", entries: ["Test Bistro"],
    dishes: [{ key: "a", label: "Bowl A" }],
    sources: [{ key: "s", url: "https://example.test/menu", retrievedAt: "2026-11-16T10:00:00Z" }],
    facts: [
      { kind: "address", source: "s", value: { street: "1 Test St", postcode: "02116" } },
      { kind: "menu_item", dish: "a", source: "s", value: { listed: true } },
      { kind: "dietary_status", dish: "a", subject: "vegan", source: "s", value: { claim: "vegan", status: "yes" } },
      { kind: "published_nutrition", dish: "a", subject: "protein_g", source: "s", unknownReason: "No nutrition published" },
    ],
  };

  it("the batch sheet separates identity, dishes, dietary and nutrition, links every fact to its source, and lists unknown nutrition without blocking", async () => {
    const { batchSheetMarkdown, groupFacts } = await import("../../scripts/lib/onboarding-readiness-lib.mjs");
    const g = groupFacts(loc);
    expect(g.map((x: { key: string }) => x.key)).toEqual(["identity", "status", "dishes", "dietary", "nutrition", "serving", "allergens", "prices"]);
    expect(g.find((x: { key: string }) => x.key === "nutrition")!.facts[0]).toMatchObject({ unknown: true, dish: "Bowl A" });
    const md = batchSheetMarkdown([loc], "Batch 1", "2026-11-16");
    expect(md).toContain("**submitted and unverified**");
    expect(md).toContain("| Bowl A | Vegan: yes | [link](https://example.test/menu) (2026-11-16) |");
    expect(md).toContain("| Test Bistro | 1 known / 0 unknown | 0 known / 0 unknown | 1 known / 0 unknown | 1 known / 0 unknown | 0 known / 1 unknown |");
  });

  it("the review page shows only the batch's places, grouped by fact type, each card naming its dish", async () => {
    const { renderPage } = await import("../../scripts/lib/pilot-review-lib.mjs");
    const fact = (id: string, kind: string, extra: object = {}) => ({ fact_id: id, kind, value: {}, is_unknown: false, source_url: "https://example.test/", source_kind: "restaurant_site", entered_by: "u1", ...extra });
    const queue = [
      { id: "p1", label: "In Batch", area: "back_bay", priority: 1, groups: [{ dishId: null, label: "The place itself", facts: [fact("f1", "address", { value: { street: "1 A St", postcode: "02116" } })] }, { dishId: "d1", label: "Bowl A", facts: [fact("f2", "dietary_status", { subject: "vegan", value: { claim: "vegan", status: "yes" } })] }] },
      { id: "p2", label: "Not In Batch", area: "downtown", priority: 2, groups: [{ dishId: null, label: "The place itself", facts: [fact("f3", "address", { value: { street: "2 B St", postcode: "02108" } })] }] },
    ];
    const html = renderPage(queue, { token: "t", reviewer: { id: "u2", email: "f@example.test" }, flash: null, batch: ["In Batch"] });
    expect(html).toContain("In Batch");
    expect(html).not.toContain("Not In Batch");
    expect(html).toContain("2 facts waiting");
    expect(html).toContain('data-group="identity"');
    expect(html).toContain('data-group="dietary"');
    expect(html).toContain("Bowl A · Dietary status");
    // Still one decision per fact: no bulk approve.
    expect(html.match(/name="fact"/g)).toHaveLength(2);
  });
});
