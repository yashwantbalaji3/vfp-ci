import { describe, expect, it } from "vitest";
import {
  buildCandidates, candidateQuality, chainNames, houseNumber, isAutoLink, matchScore, nameSimilarity, nameTokens,
  normalizeStreet, parseBostonLicenses, parseCambridgePermits, parseCsv, parseOverture, recordHash, runRefusal, THRESHOLDS,
} from "../../scripts/lib/catalog-import-lib.mjs";

// Bulk identity import (docs/31). Synthetic rows only: every name and address below is invented.

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rec = (o: R): R => {
  const r = { source_key: "overture_places", external_id: Math.random().toString(36), street: "10 Test St", postcode: "02116", locality: "Boston", lat: 42.35, lon: -71.07, category: "restaurant", status_hint: "open", confidence: 0.9, website: null, record_licence: "CDLA-Permissive-2.0", ...o };
  return { ...r, record_hash: recordHash(r) };
};
// About 11 m per 0.0001 degree of latitude.
const north = (m: number) => 42.35 + m / 111_000;

describe("names and addresses", () => {
  it("drops legal suffixes and generic words, folds accents and '&'", () => {
    expect(nameTokens("The Sample Café & Grill, LLC")).toEqual(["sample"]);
    expect(nameTokens("Crêpe Corner Inc.")).toEqual(["crepe", "corner"]);
    expect(nameTokens("Kitchen")).toEqual(["kitchen"]); // only generic words: kept
  });
  it("scores contained names 0.9 and different names low", () => {
    expect(nameSimilarity("Sample Noodle Dumpling", "Sample Noodle")).toBe(0.9);
    expect(nameSimilarity("Sample Noodle", "Other Tacos")).toBe(0);
    expect(nameSimilarity("Blue Lantern", "Blue Lantern Restaurant")).toBe(1);
  });
  it("normalizes street words and reads the house number", () => {
    expect(normalizeStreet("100 Massachusetts Avenue")).toBe("100 mass ave");
    expect(houseNumber("100-104 Main Street")).toBe("100");
    expect(houseNumber("Main Street")).toBeNull();
  });
});

describe("matching", () => {
  it("never matches beyond the search distance", () => {
    const m = matchScore(rec({ name: "Blue Lantern" }), rec({ name: "Blue Lantern", lat: north(400) }));
    expect(m.score).toBe(0);
    expect(isAutoLink(m)).toBe(false);
  });
  it("auto-links same name, same number, close by", () => {
    const m = matchScore(rec({ name: "Blue Lantern" }), rec({ name: "Blue Lantern Inc", lat: north(20) }));
    expect(m.sameNumber).toBe(true);
    expect(isAutoLink(m)).toBe(true);
    expect(isAutoLink(m, { chain: true })).toBe(true); // rule (a) still holds for chains
  });
  it("same name, different house number: links only when the name is not a chain's", () => {
    const m = matchScore(rec({ name: "Blue Lantern" }), rec({ name: "Blue Lantern", street: "14 Test St", lat: north(30) }));
    expect(m.sameNumber).toBe(false);
    expect(isAutoLink(m)).toBe(true);
    expect(isAutoLink(m, { chain: true })).toBe(false);
  });
  it("a similar but different name is not auto-linked", () => {
    const m = matchScore(rec({ name: "Blue Lantern Noodles" }), rec({ name: "Blue Moon Noodles", lat: north(10) }));
    expect(isAutoLink(m)).toBe(false);
  });
  it("chain names need three separate areas of one source", () => {
    const one = [0, 1, 2].map(() => rec({ name: "Sample Subs" })); // three listings, one spot
    expect(chainNames(one).size).toBe(0);
    const three = [0, 1500, 3000].map((m) => rec({ name: "Sample Subs", lat: north(m) }));
    expect(chainNames(three).has("sample subs")).toBe(true);
    const crossSource = [rec({ name: "X Diner" }), rec({ name: "X Diner", source_key: "boston_food_licenses", lat: north(1500) }), rec({ name: "X Diner", source_key: "cambridge_food_permits", lat: north(3000) })];
    expect(chainNames(crossSource).size).toBe(0);
  });
});

describe("parsers", () => {
  const ov = (o: R) => ({ id: "ov1", name: "Blue Lantern", category: "restaurant", confidence: "0.9", operating_status: "open", street: "10 Test St", locality: "Boston", postcode: "02116-1234", lat: "42.35", lon: "-71.07", website: "https://example.test", licences: "CDLA-Permissive-2.0", ...o });
  it("Overture: keeps food places, skips each reason with a count", () => {
    const { records, skipped } = parseOverture([
      ov({}), ov({ id: "2", category: "hardware_store" }), ov({ id: "3", operating_status: "permanently_closed" }), ov({ id: "4", operating_status: "temporarily_closed" }),
      ov({ id: "5", name: " " }), ov({ id: "6", lat: "" }), ov({ id: "7", lat: "40.7" }), ov({ id: "8", confidence: "0.3" }), ov({ id: "9", website: "javascript:x" }),
    ]);
    expect(records.map((r: R) => r.external_id)).toEqual(["ov1", "9"]);
    expect(records[0]).toMatchObject({ postcode: "02116", status_hint: "open", confidence: 0.9 });
    expect(records[1].website).toBeNull();
    expect(skipped).toEqual({ not_food_category: 1, closed: 2, no_name: 1, no_coordinates: 1, outside_area: 1, low_confidence: 1 });
  });
  it("Boston: one record per place, never reads the phone column", () => {
    const row = (o: R) => ({ businessname: "Lantern Holdings LLC", dbaname: "Blue Lantern", licstatus: "Active", address: "10 Test St", city: "BOSTON", zip: "02116", property_id: "77", latitude: "42.35", longitude: "-71.07", descript: "Eating & Drinking", dayphn_cleaned: "6175550100", ...o });
    const { records, skipped } = parseBostonLicenses([row({}), row({ descript: "Eating & Drinking w/ Take Out" }), row({ licstatus: "Inactive" }), row({ latitude: "0", longitude: "0", dbaname: "Zero" })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "Blue Lantern", locality: "Boston", status_hint: "licensed_active", record_licence: "ODC-PDDL-1.0" });
    expect(JSON.stringify(records)).not.toContain("6175550100");
    expect(skipped).toEqual({ second_licence_same_place: 1, not_active: 1, no_coordinates: 1 });
  });
  it("Cambridge: current permits only, latest per place, never reads the applicant", () => {
    const row = (o: R) => ({ business_name: "Lantern Co", dba: "Green Lantern", full_address: "5 Sample Ave, Cambridge, MA 02139", latitude: "42.37", longitude: "-71.1", issue_date: "2026-06-01", applicant_name: "Pat Example", ...o });
    const asOf = new Date("2026-11-17");
    const { records, skipped } = parseCambridgePermits([row({ issue_date: "2025-06-01" }), row({}), row({ dba: "Old Spot", issue_date: "2023-01-01" })], asOf);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "Green Lantern", street: "5 Sample Ave", postcode: "02139", locality: "Cambridge" });
    expect(JSON.stringify(records)).not.toContain("Pat");
    expect(skipped).toEqual({ older_permit_same_place: 1, permit_not_current: 1 });
  });
  it("CSV: quotes, doubled quotes, newlines in quotes, BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nok"\n1,\n')).toEqual([{ a: "x, y", b: 'he said "hi"\nok' }, { a: "1", b: "" }]);
  });
  it("record hash changes only when a kept field changes", () => {
    const a = rec({ name: "Blue Lantern" });
    expect(recordHash({ ...a, external_id: "other" })).toBe(a.record_hash);
    expect(recordHash({ ...a, street: "12 Test St" })).not.toBe(a.record_hash);
  });
});

describe("run-level refusal", () => {
  const many = (n: number) => Array.from({ length: n }, () => ({ record_licence: "x" }));
  it("refuses a short file, a mostly skipped file and a big jump from the last run", () => {
    expect(runRefusal("boston_food_licenses", many(100), 120, null)).toMatch(/Only 100 usable records/);
    expect(runRefusal("boston_food_licenses", many(10), 1000, null, 5)).toMatch(/Almost every row/);
    expect(runRefusal("boston_food_licenses", many(2600), 3000, 4000)).toMatch(/changed from 4000 to 2600/);
    expect(runRefusal("boston_food_licenses", many(2600), 3000, 2700)).toBeNull();
    expect(runRefusal("boston_food_licenses", [{ record_licence: "" }], 1, null, 1)).toMatch(/no licence/);
    expect(THRESHOLDS.maxCountChange).toBe(0.3);
  });
});

describe("candidates", () => {
  it("links a city licence to the Overture place: corroborated", () => {
    const o = rec({ name: "Blue Lantern" });
    const b = rec({ name: "BLUE LANTERN", source_key: "boston_food_licenses", lat: north(15), confidence: null });
    const { candidates, links, stats } = buildCandidates([b, o]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].quality).toBe("corroborated");
    expect(candidates[0].category).toBe("restaurant"); // seeded by Overture whatever the input order
    expect(links.map((l: R) => l.method)).toEqual(["seed", "auto_strict"]);
    expect(stats.auto_linked).toBe(1);
  });
  it("a borderline look-alike is never linked: both flagged for a person", () => {
    const { candidates, stats } = buildCandidates([rec({ name: "Blue Lantern Noodles" }), rec({ name: "Blue Lantern Dumplings", source_key: "boston_food_licenses", lat: north(10) })]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c: R) => c.flags.includes("possible_duplicate") && c.quality === "needs_review")).toBe(true);
    expect(stats.possible_duplicates).toBe(1);
  });
  it("another business at the same address is noted, not merged", () => {
    const { candidates } = buildCandidates([rec({ name: "Blue Lantern" }), rec({ name: "Sample Tacos", source_key: "boston_food_licenses", lat: north(10) })]);
    expect(candidates).toHaveLength(2);
    expect(candidates[1].flags).toEqual(["shared_address"]);
  });
  it("Cambridge permits corroborate but never start a candidate", () => {
    const o = rec({ name: "Green Lantern", lat: 42.37, lon: -71.1, postcode: "02139" });
    const linked = rec({ name: "Green Lantern", source_key: "cambridge_food_permits", lat: 42.37, lon: -71.1, postcode: "02139" });
    const alone = rec({ name: "Sample Caterer", source_key: "cambridge_food_permits", lat: 42.38, lon: -71.12 });
    const { candidates, stats } = buildCandidates([linked, alone, o]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].quality).toBe("corroborated");
    expect(stats.unmatched_link_only).toBe(1);
  });
  it("two records from one source are not linked to each other unless they are the same listing", () => {
    const far = buildCandidates([rec({ name: "Blue Lantern" }), rec({ name: "Blue Lantern", lat: north(40) })]);
    expect(far.candidates).toHaveLength(2);
    const dup = buildCandidates([rec({ name: "Blue Lantern" }), rec({ name: "Blue Lantern", lat: north(5) })]);
    expect(dup.candidates).toHaveLength(1);
    expect(dup.stats.same_source_duplicates).toBe(1);
  });
  it("a second run links nothing the first run left: chains are judged on every record, not only new ones", () => {
    const chain = [0, 1500, 3000].map((m, i) => rec({ external_id: `s${i}`, name: "Sample Subs", lat: north(m) }));
    const permit = rec({ external_id: "p", name: "Sample Subs", street: "14 Test St", source_key: "cambridge_food_permits", lat: north(30), confidence: null });
    const first = buildCandidates([...chain, permit]);
    expect(first.stats.unmatched_link_only).toBe(1);
    const second = buildCandidates([permit], first.candidates);
    expect(second.stats).toMatchObject({ auto_linked: 0, new_candidates: 0, unmatched_link_only: 1 });
  });
  it("the same records in any order give the same candidates", () => {
    const rs = [
      rec({ external_id: "a", name: "Blue Lantern" }), rec({ external_id: "b", name: "Blue Lantern Annex", lat: north(12) }),
      rec({ external_id: "c", name: "BLUE LANTERN", source_key: "boston_food_licenses", lat: north(6) }), rec({ external_id: "d", name: "Sample Tacos", lat: north(60) }),
    ];
    const shape = (list: R[]) => buildCandidates(list).candidates.map((c: R) => c.records.map((r: R) => r.external_id).join("+")).sort();
    expect(shape([...rs].reverse())).toEqual(shape(rs));
    expect(shape([rs[2], rs[0], rs[3], rs[1]])).toEqual(shape(rs));
  });
  it("existing candidates are kept and extended", () => {
    const first = buildCandidates([rec({ name: "Blue Lantern" })]);
    const next = buildCandidates([rec({ name: "Blue Lantern", source_key: "boston_food_licenses", lat: north(10) })], first.candidates);
    expect(next.candidates).toHaveLength(1);
    expect(next.links).toHaveLength(1);
    expect(next.candidates[0].records).toHaveLength(2);
  });
  it("quality: never verified; low confidence or missing address needs a person; rejected stays rejected", () => {
    expect(candidateQuality({ records: [rec({ confidence: 0.6 })] })).toBe("needs_review");
    expect(candidateQuality({ records: [rec({ postcode: null })] })).toBe("needs_review");
    expect(candidateQuality({ records: [rec({})] })).toBe("single_source");
    // A low-confidence twin of the same place gives the same answer whichever order the records come in.
    const twin = [rec({ external_id: "a", confidence: 0.99 }), rec({ external_id: "b", confidence: 0.52 })];
    expect(candidateQuality({ records: twin })).toBe("single_source");
    expect(candidateQuality({ records: [...twin].reverse() })).toBe("single_source");
    expect(candidateQuality({ quality: "rejected", records: [rec({}), rec({ source_key: "boston_food_licenses" })] })).toBe("rejected");
  });
});
