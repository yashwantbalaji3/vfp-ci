import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// Hosted import audit log (migration 20261125000500) and the Boston market on a clean database (20261125000600).
// Each test runs inside one rolled-back transaction.
async function tx(fn: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
const run = (c: PoolClient) =>
  c.query(
    `insert into app.data_transfer_runs (kind, part, outcome, target, approval, recorded_by)
     values ('review_transfer', 'meals', 'applied', 'local', 'test approval (test database only)', 'test') returning id`,
  );

afterAll(async () => {
  await pool.end();
});

describe("data transfer audit log", () => {
  it("is append-only: a run or an item can never be changed or removed", () =>
    tx(async (c) => {
      const id = (await run(c)).rows[0].id;
      await c.query(
        `insert into app.data_transfer_items (run_id, source_ref, kind, natural_key, evidence, source_decided_at, target_id)
         values ($1, 'test-source:fact_transcription:1', 'fact_transcription', '{}', '{}', now(), 'x')`, [id]);
      await c.query("savepoint s");
      await expect(c.query("update app.data_transfer_runs set outcome = 'refused' where id = $1", [id])).rejects.toThrow(/RECORD_IMMUTABLE/);
      await c.query("rollback to savepoint s");
      await expect(c.query("delete from app.data_transfer_items where run_id = $1", [id])).rejects.toThrow(/RECORD_IMMUTABLE/);
    }));
  it("replays one source decision at most once", () =>
    tx(async (c) => {
      const id = (await run(c)).rows[0].id;
      const item = () => c.query(
        `insert into app.data_transfer_items (run_id, source_ref, kind, natural_key, evidence, source_decided_at, target_id)
         values ($1, 'test-source:tester_decision:7', 'tester_decision', '{}', '{}', now(), 'x')`, [id]);
      await item();
      await expect(item()).rejects.toThrow(/duplicate key/);
    }));
  it("needs the owner's words for every run", () =>
    tx(async (c) => {
      await expect(c.query(
        `insert into app.data_transfer_runs (kind, part, outcome, target, approval, recorded_by) values ('hosted_import', 'catalog', 'applied', 'local', '  ', 'test')`,
      )).rejects.toThrow(/check/);
    }));
  it("is closed to every API role", () =>
    tx(async (c) => {
      for (const role of ["anon", "authenticated"]) {
        await c.query("savepoint s");
        await c.query(`set local role ${role}`);
        await expect(c.query("select count(*) from app.data_transfer_runs")).rejects.toThrow(/permission denied/);
        await c.query("rollback to savepoint s");
      }
    }));
});

describe("Boston market", () => {
  it("exists once, with the 25-mile area, whether or not the seed ran", async () => {
    const r = (await pool.query("select count(*)::int n, max(radius_m) r, bool_and(coverage_geometry is not null) g from public.markets where slug = 'boston'")).rows[0];
    expect(r).toEqual({ n: 1, r: 40234, g: true });
  });
});
