import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as u from "../../scripts/lib/usda-normalize.mjs";
import { prepareRelease } from "../../scripts/lib/usda-import-lib.mjs";

// NIE V1 slice N-1 (docs/24 3.2): USDA records are mapped explicitly, nothing is guessed, missing stays
// missing, and the same file always gives the same fingerprint. Fixtures are small excerpts of the real
// public-domain USDA files (tests/fixtures/usda), so the expected numbers are USDA's own.

type Raw = { fdcId: number | string; dataType: string; description: string; nutrients: { id: number; unit: string; amount: unknown; derivation?: string }[]; portions?: unknown[] };
const raw = (over: Partial<Raw> = {}): Raw => ({ fdcId: 1, dataType: "Foundation", description: "Test food", nutrients: [], portions: [], ...over });
const foundation = () => u.fromFoundationJson(JSON.parse(readFileSync("tests/fixtures/usda/foundation-sample.json", "utf8")));
const srTables = () => {
  const dir = "tests/fixtures/usda/sr-sample";
  return Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.csv$/, ""), u.parseCsv(readFileSync(`${dir}/${f}`, "utf8"))]));
};

describe("USDA nutrients are mapped explicitly", () => {
  it("keeps USDA's exact decimals per 100 g, with the USDA nutrient number", () => {
    const lentils = foundation().map(u.normalizeFood).find((x: { record: { fdcId: number } }) => x.record.fdcId === 2644283)!.record;
    expect(lentils.description).toBe("Lentils, dry");
    expect(lentils.nutrients.protein_g).toEqual({ value: "23.6", unit: "g", usdaNutrientId: 1003, derivation: "NC" });
    expect(lentils.nutrients.fat_g.value).toBe("1.92");
    expect(lentils.nutrients.sodium_mg).toMatchObject({ value: "0", unit: "mg" }); // a reported zero stays a zero
    expect(lentils.nutrients.fiber_g).toBeUndefined(); // not given: unknown, never 0
  });

  it("energy: USDA 'Energy' first, then Atwater specific, then Atwater general; never worked out from macros", () => {
    const foods = foundation().map(u.normalizeFood).map((x: { record: unknown }) => x.record) as { fdcId: number; nutrients: Record<string, { value: string; usdaNutrientId: number }> }[];
    const by = (id: number) => foods.find((f) => f.fdcId === id)!;
    expect(by(321611).nutrients.energy_kcal).toMatchObject({ value: "21", usdaNutrientId: 1008 });
    expect(by(2644283).nutrients.energy_kcal).toMatchObject({ value: "351", usdaNutrientId: 2048 });
    expect(by(2257044).nutrients.energy_kcal).toMatchObject({ value: "40.7", usdaNutrientId: 2047 });
    const none = u.normalizeFood(raw({ nutrients: [{ id: 1003, unit: "G", amount: 10 }, { id: 1004, unit: "G", amount: 5 }, { id: 1005, unit: "G", amount: 20 }] })).record;
    expect(none.nutrients.energy_kcal).toBeUndefined();
  });

  it("refuses an unexpected unit, a negative or non-numeric value, and more than 100 g per 100 g, and reports each", () => {
    const { record, refused } = u.normalizeFood(raw({
      nutrients: [
        { id: 1003, unit: "kJ", amount: 10 },
        { id: 1093, unit: "g", amount: 0.4 },
        { id: 1005, unit: "G", amount: -0.475 },
        { id: 1004, unit: "G", amount: "trace" },
        { id: 1079, unit: "G", amount: 101 },
      ],
    }));
    expect(record.nutrients).toEqual({});
    expect(refused.map((r: { code: string }) => r.code).sort()).toEqual(["carb_g", "fat_g", "fiber_g", "protein_g", "sodium_mg"]);
    expect(refused.find((r: { code: string }) => r.code === "sodium_mg")?.reason).toMatch(/unexpected unit "g" \(expected mg\)/);
    // The real file has such values: the negative "carbohydrate by difference" of a Foundation food is refused.
    const chicken = u.normalizeFood(foundation().find((f: Raw) => f.fdcId === 2727566));
    expect(chicken.record.nutrients.carb_g).toBeUndefined();
    expect(chicken.refused).toEqual([{ code: "carb_g", usdaNutrientId: 1005, reason: 'not a usable number: "-0.475"' }]);
  });

  it("units are compared without regard to capitals (USDA writes G and g), and nothing else is converted", () => {
    expect(u.normalizeFood(raw({ nutrients: [{ id: 1003, unit: "G", amount: "5.00" }] })).record.nutrients.protein_g.value).toBe("5");
    expect(u.normalizeFood(raw({ nutrients: [{ id: 1093, unit: "MG", amount: "007.50" }] })).record.nutrients.sodium_mg.value).toBe("7.5");
  });

  it("an unknown data type or a bad FDC ID stops the import instead of guessing", () => {
    expect(() => u.normalizeFood(raw({ dataType: "Branded" }))).toThrow(/Unexpected USDA data type/);
    expect(() => u.normalizeFood(raw({ fdcId: "x" }))).toThrow(/Bad FDC ID/);
  });
});

describe("USDA portions keep USDA's own gram weights", () => {
  it("SR Legacy: lentils 1 cup = 198 g, tofu 1/4 block = 81 g; portions without grams are dropped", () => {
    const foods = u.fromSrLegacyCsv(srTables()).map((r: Raw) => u.normalizeFood(r).record);
    const lentils = foods.find((f: { fdcId: number }) => f.fdcId === 172421);
    expect(lentils.description).toBe("Lentils, mature seeds, cooked, boiled, without salt");
    expect(lentils.ndbNumber).toBe("16070");
    expect(lentils.nutrients.protein_g.value).toBe("9.02");
    expect(lentils.nutrients.energy_kcal).toMatchObject({ value: "116", usdaNutrientId: 1008 });
    expect(lentils.portions[0]).toEqual({ usdaPortionId: 90596, amount: "1", unit: null, modifier: "cup", description: null, grams: "198" });
    const tofu = foods.find((f: { fdcId: number }) => f.fdcId === 172475);
    expect(tofu.portions.find((p: { modifier: string }) => p.modifier === "block")).toMatchObject({ amount: "0.25", grams: "81" });
    const dropped = u.normalizeFood(raw({ portions: [{ id: 1, amount: 1, grams: 0 }, { id: 2, amount: 0, grams: 10 }, { id: 3, amount: 1, grams: "" }] })).record;
    expect(dropped.portions).toEqual([]);
  });
});

describe("the same file always gives the same fingerprint", () => {
  it("record and release fingerprints ignore key order and food order", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(u.canonical(a)).toBe(u.canonical(b));
    const recs = foundation().map((r: Raw) => u.normalizeFood(r).record);
    expect(u.releaseHash(recs)).toBe(u.releaseHash([...recs].reverse()));
    expect(u.releaseHash(recs)).not.toBe(u.releaseHash(recs.slice(1)));
  });

  it("preparing the same release twice gives identical output; a duplicate FDC ID is refused", () => {
    const meta = { dataset: "foundation", releaseLabel: "2026-10-29", fileName: "FoodData_Central_foundation_food_json_2026-10-29.zip", sha256: "0".repeat(64), sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/x.zip" };
    const one = prepareRelease(meta, foundation());
    const two = prepareRelease(meta, foundation());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.release.foodCount).toBe(4);
    expect(one.release.report.refusedCount).toBe(1);
    expect(() => prepareRelease(meta, [...foundation(), foundation()[0]])).toThrow(/Duplicate FDC ID/);
  });

  it("dates become ISO dates; the CSV reader handles quotes and commas inside fields", () => {
    expect(u.isoDate("10/26/2023")).toBe("2023-10-26");
    expect(u.isoDate("2019-04-01")).toBe("2019-04-01");
    expect(() => u.isoDate("26 Oct 2023")).toThrow();
    expect(u.parseCsv('"a","b"\n"1, 2","say ""hi"""\n')).toEqual([{ a: "1, 2", b: 'say "hi"' }]);
  });

  it("the manifest pins every accepted file by SHA-256, from the USDA site only", () => {
    const m = JSON.parse(readFileSync("reference/usda/manifest.json", "utf8"));
    for (const f of m.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sourceUrl).toBe(`https://fdc.nal.usda.gov/fdc-datasets/${f.fileName}`);
      expect(["foundation", "sr_legacy"]).toContain(f.dataset);
    }
    expect(m.citation).toMatch(/FoodData Central/);
  });
});
