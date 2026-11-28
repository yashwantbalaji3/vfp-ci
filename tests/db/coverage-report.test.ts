import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";
import { coverage, coverageMarkdown } from "../../scripts/coverage-report.mjs";

// Coverage report (docs/41, MENU-8): the owner's ten counts, kept separate. Read-only.

afterAll(async () => {
  await pool.end();
});

describe("coverage report", () => {
  it("keeps identity, menu and dietary counts apart, never counts verified above researched, and writes nothing", async () => {
    const c = await pool.connect();
    try {
      const before = (await c.query("select (select count(*) from staging.facts) f, (select count(*) from staging.events) e")).rows[0];
      const r = await coverage(c);
      for (const n of [r.identified, r.identityCorroborated, r.preview, r.identityConfirmed, r.researchedLocations]) expect(Number.isInteger(n)).toBe(true);
      expect(r.identityCorroborated).toBeLessThanOrEqual(r.identified);
      expect(r.usableMenu.verified).toBeLessThanOrEqual(r.usableMenu.researched);
      expect(r.vegetarianDish.verified).toBeLessThanOrEqual(r.vegetarianDish.explicit + r.vegetarianDish.preliminaryOnly);
      expect(r.veganDish.verified).toBeLessThanOrEqual(r.veganDish.stated);
      expect(r.protein.publishedVerified).toBeLessThanOrEqual(r.protein.published);
      // No real dish has a calculation model yet; demo models are never counted.
      expect(r.protein).toMatchObject({ calculated: 0, estimatedRange: 0 });
      expect(r.public).toBe(0);
      // Facts from sources that are not cleared are counted only here (docs/46).
      const held = r.held as unknown as Record<string, number>;
      for (const n of Object.values(held)) expect(Number.isInteger(n)).toBe(true);
      // Private-pilot sources (owner decisions) are held from publication too, and counted in their own bucket.
      expect(held.facts).toBe(held.prohibited + held.pending + held.private_pilot);
      expect((await c.query("select (select count(*) from staging.facts) f, (select count(*) from staging.events) e")).rows[0]).toEqual(before);
      const md = coverageMarkdown(r, "2026-11-17");
      expect(md).toContain("# Boston coverage (2026-11-17)");
      expect(md).toContain("| Identity confirmed by the founder |");
      expect(md).toContain("| Eligible for publication |");
      expect(md).toContain("| Held for source clearance (not counted anywhere else) |");
    } finally {
      c.release();
    }
  });
});
