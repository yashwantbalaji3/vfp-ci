import { describe, expect, it } from "vitest";
import { batchFingerprint, extendSampleIds, samplePasses, upperBound95 } from "../../scripts/lib/catalog-preview-lib.mjs";
import { batchDecisionSchema, boundPercent } from "@/contracts/review";

// Sample-reviewed batches (docs/35). Synthetic ids only.
const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("confidence and the approved rule", () => {
  it("gives the exact one-sided 95% bounds from docs/34 (same as the database)", () => {
    expect([upperBound95(0, 61), upperBound95(1, 61), upperBound95(2, 61), upperBound95(3, 61), upperBound95(0, 120), upperBound95(2, 120), upperBound95(0, 200)]).toEqual([
      0.0479, 0.0754, 0.0996, 0.1222, 0.0247, 0.0515, 0.0149,
    ]);
    expect(upperBound95(0, 0)).toBe(1);
    expect(boundPercent(0.0479)).toBe("4.8%");
  });
  it("passes 0 of 61 or at most 2 of 125, only with every place checked", () => {
    // Founder decision 17 Nov 05:49 UTC: 2 of 120 has a 5.15% bound, above the 5% target.
    expect(upperBound95(2, 125)).toBeLessThanOrEqual(0.05);
    expect(upperBound95(2, 120)).toBeGreaterThan(0.05);
    expect(samplePasses(2, 125, 125)).toBe(true);
    expect(samplePasses(3, 125, 125)).toBe(false);
    expect(samplePasses(2, 125, 124)).toBe(false);
    expect(samplePasses(1, 120, 120)).toBe(false);
    expect(samplePasses(0, 61, 61)).toBe(true);
    expect(samplePasses(1, 61, 61)).toBe(false);
    expect(samplePasses(0, 61, 60)).toBe(false);
    expect(samplePasses(2, 120, 120)).toBe(false);
    expect(samplePasses(3, 120, 120)).toBe(false);
    expect(samplePasses(0, 30, 30)).toBe(false);
  });
});

describe("freezing and extending a batch", () => {
  it("the fingerprint ignores order but notices any change in the list", () => {
    expect(batchFingerprint([...ids].reverse())).toBe(batchFingerprint(ids));
    expect(batchFingerprint(ids.slice(1))).not.toBe(batchFingerprint(ids));
  });
  it("an extension adds new places only, the same ones for the same seed, up to the target", () => {
    const sampled = ids.slice(0, 61);
    const add = extendSampleIds(ids, sampled, { to: 120, seed: "s1" });
    expect(add).toHaveLength(59);
    expect(add.some((id: string) => sampled.includes(id))).toBe(false);
    expect(extendSampleIds([...ids].reverse(), sampled, { to: 120, seed: "s1" })).toEqual(add);
    expect(extendSampleIds(ids, sampled, { to: 120, seed: "s2" })).not.toEqual(add);
    expect(extendSampleIds(ids, sampled, { to: 50, seed: "s1" })).toEqual([]);
  });
});

describe("a batch decision", () => {
  const batchId = "00000000-0000-4000-8000-000000000001";
  it("approve needs the acknowledgement; withdraw does not", () => {
    expect(batchDecisionSchema.safeParse({ batchId, decision: "approve", acknowledged: false }).success).toBe(false);
    expect(batchDecisionSchema.safeParse({ batchId, decision: "approve", acknowledged: true }).success).toBe(true);
    expect(batchDecisionSchema.safeParse({ batchId, decision: "withdraw", acknowledged: false }).success).toBe(true);
    expect(batchDecisionSchema.safeParse({ batchId, decision: "publish", acknowledged: true }).success).toBe(false);
  });
});
