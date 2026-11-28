import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, readExport } from "../../scripts/menu-export-import.mjs";

// Authorized menu exports (docs/45): the file a restaurant gives us is read as written. Nothing is
// filled in; a blank value stays blank (null), never zero.

describe("parseCsv", () => {
  it("handles quoted fields, doubled quotes, commas, newlines in quotes, CRLF and a byte-order mark", () => {
    expect(parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,,3\n')).toEqual([
      ["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"], ["1", "", "3"]]);
  });
});

describe("readExport", () => {
  it("reads CSV columns, splits labels on semicolons, and leaves blank numbers null", () => {
    const csv = "Name,Section,Labels,Price_USD,Serving_Grams,Protein_g,Fat_g,Unknown\nChickpea Wrap,Wraps,VG; GF,$9.75,310 g,18 g,,ignored\n,,,,,,,\nPlain Rice,,,,,,0,\nOdd Unit,,,,12 oz,500 mg,,\n";
    const r = readExport(csv, "csv");
    expect(r.documentDate).toBeNull();
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ name: "Chickpea Wrap", section: "Wraps", labels: ["VG", "GF"], price_usd: 9.75, serving_grams: 310,
      nutrition: { protein_g: { amount: 18, unit: "g", per: "serving" } } });
    expect(Object.keys(r.items[0].nutrition)).not.toContain("fat_g");
    // A real zero the restaurant wrote is kept; a blank is not.
    expect(r.items[1]).toMatchObject({ name: "Plain Rice", price_usd: null, serving_grams: null, nutrition: { fat_g: { amount: 0, unit: "g", per: "serving" } } });
    expect(r.items[1]).not.toHaveProperty("unknown");
    // A value in a different unit than its column is left out, never converted or guessed.
    expect(r.items[2]).toMatchObject({ name: "Odd Unit", serving_grams: null, nutrition: {} });
  });

  it("reads JSON, keeps the document date and legend, and drops nutrients without an amount or unit", () => {
    const r = readExport(JSON.stringify({ document_date: "2026-10-01", items: [
      { name: " Lentil Soup ", labels: ["V"], legend: { V: "Vegetarian" }, nutrition: { protein_g: { amount: 11, unit: "g" }, sodium_mg: { amount: -1, unit: "mg" }, fat_g: { unit: "g" } } },
      { name: "" }] }), "json");
    expect(r.documentDate).toBe("2026-10-01");
    expect(r.items).toEqual([expect.objectContaining({ name: "Lentil Soup", labels: ["V"], legend: { V: "Vegetarian" }, price_usd: null,
      nutrition: { protein_g: { amount: 11, unit: "g", per: "serving" } } })]);
  });
});

// Skipped only where the research registry is absent: the clean public CI copy (docs/65).
describe.skipIf(!existsSync("scripts/menu-access-registry.json"))("the source-access registry file", () => {
  it("is well formed, quotes its evidence, and grants nothing on Claude's reading alone", async () => {
    const { readFileSync } = await import("node:fs");
    const { PERMISSION_KINDS, PERMISSION_STATUSES } = await import("../../scripts/menu-sources.mjs");
    const j = JSON.parse(readFileSync("scripts/menu-access-registry.json", "utf8"));
    expect(j.reviews.length).toBeGreaterThan(0);
    for (const r of j.reviews) {
      expect(PERMISSION_KINDS).toContain(r.kind);
      expect(PERMISSION_STATUSES).toContain(r.status);
      expect(r.status).not.toBe("permits"); // a permit needs the owner's or restaurant's own confirmation
      expect(r.evidence.length).toBeGreaterThanOrEqual(3);
      expect(r.evidence.length).toBeLessThanOrEqual(2000);
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.hosts.length).toBeGreaterThan(0);
    }
  });
});
