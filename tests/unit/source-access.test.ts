import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessState, auditSources, cleanEntry, hostOf, registryIndex, splitByClearance } from "../../scripts/lib/source-access.mjs";
import { heldSummary } from "../../scripts/lib/onboarding-readiness-lib.mjs";

// Research source clearance (docs/46). Hosts, places and facts are invented.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const review = (hosts: string[], status: string, extra = {}) => ({ hosts, kind: "terms_review", status, evidence: "Test clause", reviewer: "Test", reviewedAt: new Date().toISOString(), ...extra });
const index = registryIndex({ reviews: [
  review(["www.good.test"], "permits", { uses: "tests" }),
  review(["bad.test"], "prohibits"),
  review(["meh.test"], "unclear"),
  review(["old.test"], "permits", { uses: "x", reviewedAt: "2020-01-01T00:00:00Z" }),
  review(["flip.test"], "permits", { uses: "x", reviewedAt: "2026-01-01T00:00:00Z" }),
  review(["flip.test"], "prohibits", { reviewedAt: "2026-02-01T00:00:00Z" }),
] });

const place = {
  label: "Test Cafe",
  sources: [
    { key: "a", url: "https://good.test/menu", kind: "restaurant_site", retrievedAt: "2026-11-16T09:00:00Z", termsNote: "Read through a summarising fetcher" },
    { key: "b", url: "https://www.bad.test/menu", kind: "restaurant_site", retrievedAt: "2026-11-16T09:00:00Z" },
    { key: "c", url: "https://meh.test/", kind: "restaurant_site", retrievedAt: "2026-11-16T09:00:00Z" },
  ],
  dishes: [{ key: "d1", label: "Bowl" }, { key: "d2", label: "Wrap" }],
  facts: [
    { kind: "address", value: { street: "1 Test St", postcode: "02116" }, source: "a" },
    { kind: "published_nutrition", dish: "d2", subject: "protein_g", value: { nutrient: "protein_g", amount: "20" }, source: "b" },
    { kind: "menu_item", dish: "d2", value: { listed: true }, source: "b" },
    { kind: "menu_item", dish: "d1", value: { listed: true }, source: "c" },
  ],
  notes: "Quoted from the banned page",
};

describe("access states", () => {
  it("fails closed: only a current permit clears; latest entry wins; exact host, www ignored", () => {
    expect(hostOf("https://WWW.Good.test/x")).toBe("good.test");
    expect(hostOf("not a url")).toBeNull();
    expect(accessState("https://good.test/a", index)).toBe("cleared");
    expect(accessState("https://sub.good.test/a", index)).toBe("pending");
    expect(accessState("https://bad.test/", index)).toBe("prohibited");
    expect(accessState("https://meh.test/", index)).toBe("pending");
    expect(accessState("https://old.test/", index)).toBe("pending");
    expect(accessState("https://unknown.test/", index)).toBe("pending");
    expect(accessState("https://flip.test/", index)).toBe("prohibited");
  });
});

describe("audit, split and clean", () => {
  it("audits every source with its state, collection method and protein count", () => {
    const rows = auditSources([{ file: "f.json", entry: { places: [place] } }], index);
    expect(rows.map((r) => [r.host, r.state, r.facts, r.protein, r.termsStatus])).toEqual([
      ["good.test", "cleared", 1, 0, "permits"], ["bad.test", "prohibited", 2, 1, "prohibits"], ["meh.test", "pending", 1, 0, "unclear"]]);
    expect(rows[0].method).toMatch(/summarising/);
  });

  it("only cleared facts count; held facts are summarised by state", () => {
    const { cleared, held } = splitByClearance(place, index);
    expect(cleared.map((f) => f.kind)).toEqual(["address"]);
    expect(held.map((f) => f.sourceState)).toEqual(["prohibited", "prohibited", "pending"]);
    expect(heldSummary([{ label: "Test Cafe", facts: cleared, held }])).toEqual({ facts: 3, prohibited: 2, pending: 1, protein: 1, locations: 1, fullyHeld: 0 });
  });

  it("cleanup removes prohibited sources, their facts, emptied dishes and notes; pending content stays; the log holds no content", () => {
    const { entry, removed, noteSha256 } = cleanEntry({ _note: "Quoted legend", places: [place] }, index, sha);
    expect(entry._note).not.toMatch(/Quoted/);
    expect(noteSha256).toBe(sha("Quoted legend"));
    const p = entry.places[0];
    expect(p.sources.map((s: { key: string }) => s.key)).toEqual(["a", "c"]);
    expect(p.facts.map((f: { source: string }) => f.source)).toEqual(["a", "c"]);
    expect(p.dishes.map((d: { key: string }) => d.key)).toEqual(["d1"]);
    expect(p.notes).toBeUndefined();
    expect(p.sourceHold).toMatch(/removed/);
    expect(removed).toEqual([{ place: "Test Cafe", hosts: ["bad.test"], sources: [{ urlSha256: sha("https://www.bad.test/menu"), retrievedAt: "2026-11-16T09:00:00Z" }], facts: 2, protein: 1, dishes: 1 }]);
    expect(JSON.stringify(removed)).not.toMatch(/bad\.test\/menu|Wrap|Quoted/);
    // Nothing prohibited: the entry is returned unchanged.
    const clean = { places: [{ ...place, sources: [place.sources[0]], facts: [place.facts[0]] }] };
    expect(cleanEntry(clean, index, sha)).toEqual({ entry: clean, removed: [] });
  });
});

describe("private pilot sources", () => {
  it("are their own state, never cleared, and a later prohibition still wins", () => {
    const idx = registryIndex({ reviews: [
      review(["pilot.test"], "unclear", { reviewedAt: "2026-11-18T10:00:00Z" }),
      { ...review(["pilot.test"], "private_pilot", { reviewedAt: "2026-11-18T19:00:00Z" }), kind: "owner_decision" },
      { ...review(["later.test"], "private_pilot", { reviewedAt: "2026-11-18T19:00:00Z" }), kind: "owner_decision" },
      review(["later.test"], "prohibits", { reviewedAt: "2026-11-19T10:00:00Z" }),
    ] });
    expect(accessState("https://www.pilot.test/menu", idx)).toBe("private_pilot");
    expect(accessState("https://later.test/", idx)).toBe("prohibited");
    const split = splitByClearance({ sources: [{ key: "s", url: "https://pilot.test/" }], facts: [{ source: "s", kind: "price" }] }, idx);
    expect(split.cleared).toHaveLength(0);
    expect(split.held[0].sourceState).toBe("private_pilot");
  });
});

// The registry is a research record: the clean public CI copy leaves it out (docs/65), so these checks run wherever
// the file exists (every local regression and the private repository) and are skipped only there.
const REGISTRY = "scripts/menu-access-registry.json";
describe.skipIf(!existsSync(REGISTRY))("the registry file", () => {
  it("covers every host, uses quoted evidence and grants nothing on Claude's reading alone", () => {
    const j = JSON.parse(readFileSync("scripts/menu-access-registry.json", "utf8"));
    // A host appears once per kind of entry: its terms reading, and at most one owner decision after it.
    const keys = j.reviews.flatMap((r: { hosts: string[]; kind: string }) => r.hosts.map((h) => `${r.kind} ${h}`));
    expect(new Set(keys).size).toBe(keys.length);
    const index = registryIndex(j);
    for (const r of j.reviews.filter((x: { kind: string }) => x.kind === "owner_decision")) {
      expect(r.status).toBe("private_pilot");
      for (const h of r.hosts) expect(accessState(`https://${h}/`, index)).toBe("private_pilot");
    }
    expect(j.reviews.every((r: { status: string }) => r.status !== "permits")).toBe(true);
  });
});
