import { describe, expect, it } from "vitest";
import { recordDecisionSchema, reviewItemSchema, queueWords, type ReviewItem } from "@/contracts/review";
import { evidenceChecks, osmLink } from "@/lib/review-checks";

// Founder identity review (docs/33). Synthetic places only.

const rec = (o: Partial<ReviewItem["evidence"]["records"][number]> = {}) => ({
  source: "Test licences", sourceKey: "boston_food_licenses", release: "r1", recordId: "1", name: "Test Lantern", street: "12 Sample St",
  postcode: "02116", locality: "Boston", category: "eating & drinking", website: null, openStatus: "licensed_active", present: true, lat: 42.35, lon: -71.07, ...o,
});
const item = (evidence: Partial<ReviewItem["evidence"]>): ReviewItem =>
  reviewItemSchema.parse({
    candidateId: "00000000-0000-4000-8000-000000000001", name: "Test Lantern", street: "12 Sample St", postcode: "02116", area: null, lat: 42.35, lon: -71.07,
    queues: ["sample"], active: true, evidence: { reasons: [], records: [], lookalikes: [], ...evidence }, history: [], listing: null, next: null,
  });

describe("what the automatic checks found, in words", () => {
  it("two agreeing sources: every check is fine", () => {
    const checks = evidenceChecks(item({ records: [rec(), rec({ sourceKey: "overture_places", source: "Test places", name: "Test Lantern", street: "12 Sample Street", openStatus: "open" })], recordsApartMetres: 12 }));
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.text)).toContain("Both give house number 12.");
    expect(checks.map((c) => c.text)).toContain("The sources put it 12 m apart.");
  });

  it("flags different house numbers, far-apart sources, unknown open status, a missing record and look-alikes", () => {
    const checks = evidenceChecks(
      item({
        records: [rec({ present: false }), rec({ sourceKey: "overture_places", source: "Test places", name: "Lantern Cafe Downtown", street: "80 Other St", openStatus: "unknown" })],
        recordsApartMetres: 240,
        lookalikes: [{ name: "Test Lantern 2", street: "14 Sample St", metres: 30 }],
      }),
    );
    const bad = checks.filter((c) => !c.ok).map((c) => c.text);
    expect(bad).toEqual(
      expect.arrayContaining([
        "The sources put it 240 m apart (more than 80 m).",
        "The house numbers differ: 12 and 80.",
        "Test licences no longer lists it in its latest release.",
        "Test places does not say it is open.",
        "1 similar name within 150 m (listed below).",
      ]),
    );
  });

  it("a single source is never presented as fine", () => {
    expect(evidenceChecks(item({ records: [rec()] }))[0]).toEqual({ ok: false, text: "Only one public source has this place." });
  });
});

describe("a decision names one place and a known decision", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("reject needs a reason, and only reject takes one", () => {
    expect(recordDecisionSchema.safeParse({ candidateId: id, decision: "reject" }).success).toBe(false);
    expect(recordDecisionSchema.safeParse({ candidateId: id, decision: "reject", reason: "closed" }).success).toBe(true);
    expect(recordDecisionSchema.safeParse({ candidateId: id, decision: "verify_identity", reason: "closed" }).success).toBe(false);
  });
  it("refuses unknown decisions, lists of places and long notes", () => {
    expect(recordDecisionSchema.safeParse({ candidateId: id, decision: "publish" }).success).toBe(false);
    expect(recordDecisionSchema.safeParse({ candidateId: [id, id], decision: "verify_identity" }).success).toBe(false);
    expect(recordDecisionSchema.safeParse({ candidateId: id, decision: "verify_identity", note: "x".repeat(1001) }).success).toBe(false);
  });
  it("queue names and map links read plainly", () => {
    expect(queueWords("sources_disagree_on_address")).toBe("Different house numbers");
    expect(queueWords("something_new")).toBe("something new");
    expect(osmLink(42.35, -71.07)).toBe("https://www.openstreetmap.org/?mlat=42.35&mlon=-71.07#map=19/42.35/-71.07");
  });
});
