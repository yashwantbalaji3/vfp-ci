import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../helpers/db";

/** On a database seeded from the current seed.sql, the top-up has nothing to add (docs/22). */
afterAll(async () => {
  await pool.end();
});

describe("demo top-up on a freshly seeded database", () => {
  it("adds no rows and fails nothing; checked inside a transaction that is rolled back", async () => {
    const body = readFileSync("supabase/demo-topup.sql", "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    const c = await pool.connect();
    try {
      await c.query("begin");
      const results = [].concat((await c.query(body)) as never) as { fields: { name: string }[]; rows: Record<string, number>[] }[];
      const report = results.filter((r) => r.fields?.some((f) => f.name === "rows added")).at(-1)!;
      expect(report.rows).toEqual([]);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
