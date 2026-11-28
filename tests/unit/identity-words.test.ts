import { describe, expect, it } from "vitest";
import { IDENTITY_SHORT, IDENTITY_WORDS } from "@/contracts/places";

// Activation readiness item 2: only a place the founder checked one by one may read as checked.
describe("identity wording", () => {
  it("only 'verified' says the identity was checked by us", () => {
    expect(IDENTITY_WORDS.verified).toBe("Identity checked by us");
    for (const basis of ["corroborated", "batch_sampled"] as const) {
      expect(IDENTITY_WORDS[basis]).not.toMatch(/^Identity checked/);
      expect(IDENTITY_WORDS[basis]).toMatch(/not (yet )?checked by us/i);
      expect(IDENTITY_WORDS[basis]).not.toMatch(/verified/i);
    }
  });

  it("the short card wording keeps the same rule", () => {
    expect(IDENTITY_SHORT.verified).toBe(IDENTITY_WORDS.verified);
    for (const basis of ["corroborated", "batch_sampled"] as const) {
      expect(IDENTITY_SHORT[basis]).not.toMatch(/^Identity checked/);
      expect(IDENTITY_SHORT[basis]).toMatch(/not (yet )?checked by us/i);
      expect(IDENTITY_SHORT[basis]).not.toMatch(/verified/i);
    }
  });
});
