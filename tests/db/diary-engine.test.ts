import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// Database fixtures F01, F02, F07, F10, F11, F13, F14 plus validation (docs/14).
// Runs the real SQL functions as an authenticated member against local Postgres.

let userA: string;
let userB: string;
const created: string[] = [];

beforeAll(async () => {
  userA = await createTestUser("diary-a");
  userB = await createTestUser("diary-b");
  created.push(userA, userB);
});
afterAll(async () => {
  await deleteTestUsers(created);
  await pool.end();
});

type LogArgs = {
  key?: string;
  rev: string;
  portion?: string | null;
  multiplier?: string | null;
  grams?: string | null;
  context?: string;
  slot?: string;
  date?: string;
  tz?: string;
  consumedAt?: string | null;
};
const logSql = `select public.log_food_entry($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as r`;
const logParams = (a: LogArgs) => [
  a.key ?? randomUUID(),
  a.rev,
  a.portion ?? null,
  a.multiplier ?? null,
  a.grams ?? null,
  a.context ?? "restaurant",
  a.slot ?? "lunch",
  a.date ?? "2026-11-13",
  a.tz ?? "America/New_York",
  a.consumedAt ?? null,
];

async function snapshotNutrients(c: import("pg").PoolClient, entryId: string) {
  const { rows } = await c.query(
    `select s.nutrients, s.resolved_mass_g, s.revision_no, s.food_revision_id
       from public.diary_entries e join public.diary_snapshots s on s.id = e.current_snapshot_id
      where e.id = $1`,
    [entryId],
  );
  return rows[0];
}

describe("diary snapshots", () => {
  it("F01: 150 g of a 12 g/100 g food -> 18 g, source and method recorded", async () => {
    await asMember(userA, async (c) => {
      const { rows } = await c.query(logSql, logParams({ rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1", context: "home" }));
      const snap = await snapshotNutrients(c, rows[0].r.entryId);
      expect(Number(snap.nutrients.protein_g.value)).toBeCloseTo(18, 9);
      expect(snap.nutrients.protein_g.method).toBe("published");
      expect(snap.nutrients.protein_g.sourceRecordId).toBe(IDS.sourceRecord);
      expect(Number(snap.resolved_mass_g)).toBe(150);
    });
  });

  it("F02: half of a 24 g serving with no mass -> 12 g; unknown nutrients stay null with reason", async () => {
    await asMember(userA, async (c) => {
      const { rows } = await c.query(logSql, logParams({ rev: IDS.bowl.rev, portion: IDS.bowl.portionServing, multiplier: "0.5" }));
      const snap = await snapshotNutrients(c, rows[0].r.entryId);
      expect(Number(snap.nutrients.protein_g.value)).toBe(12);
      expect(snap.nutrients.fat_g.value).toBeNull();
      expect(snap.nutrients.fat_g.missingReason).toBe("not_provided");
      expect(snap.resolved_mass_g).toBeNull();
    });
  });

  it("F10: 2 oz portion -> 56.69904625 g and 5.669904625 g protein, exact decimal", async () => {
    await asMember(userA, async (c) => {
      const { rows } = await c.query(logSql, logParams({ rev: IDS.snackMix.rev, portion: IDS.snackMix.portion2oz, multiplier: "1", context: "packaged" }));
      const snap = await snapshotNutrients(c, rows[0].r.entryId);
      expect(snap.resolved_mass_g).toMatch(/^56\.69904625(0*)$/);
      expect(String(snap.nutrients.protein_g.value)).toMatch(/^5\.669904625/);
    });
  });

  it("F11: two bowls with no gram mapping -> logged, unquantified, no guessed mass", async () => {
    await asMember(userA, async (c) => {
      const { rows } = await c.query(logSql, logParams({ rev: IDS.dal.rev, portion: IDS.dal.portionBowl, multiplier: "2" }));
      const snap = await snapshotNutrients(c, rows[0].r.entryId);
      expect(snap.resolved_mass_g).toBeNull();
      expect(snap.nutrients.protein_g.value).toBeNull();
      expect(snap.nutrients.protein_g.missingReason).toBe("unavailable_conversion");
    });
  });

  it("F07: a later catalog revision (24 -> 30 g) leaves the old log at 24 g; a new log uses 30 g", async () => {
    // Publish a second revision of the demo bowl as the database owner, then roll everything back.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userA, role: "authenticated" })]);
      const first = await c.query(logSql, logParams({ rev: IDS.bowl.rev, portion: IDS.bowl.portionServing, multiplier: "1" }));
      await c.query("reset role");
      const rev2 = randomUUID();
      await c.query(
        `insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit)
         values ($1, $2, 2, 'Demo chickpea power bowl', 'serving', 1, 'serving')`,
        [rev2, IDS.bowl.item],
      );
      await c.query(
        `insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id) values ($1, 'protein_g', 30, 'published', $2)`,
        [rev2, IDS.sourceRecord],
      );
      const p2 = randomUUID();
      await c.query(
        `insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values ($1, $2, '1 bowl', 1, 'serving', $3)`,
        [p2, rev2, IDS.sourceRecord],
      );
      await c.query("update public.food_revisions set published_at = now() where id = $1", [rev2]);
      await c.query("update public.food_items set current_revision_id = $1 where id = $2", [rev2, IDS.bowl.item]);
      await c.query("set local role authenticated");
      const second = await c.query(logSql, logParams({ rev: rev2, portion: p2, multiplier: "1" }));
      const old = await snapshotNutrients(c, first.rows[0].r.entryId);
      const fresh = await snapshotNutrients(c, second.rows[0].r.entryId);
      expect(Number(old.nutrients.protein_g.value)).toBe(24);
      expect(Number(fresh.nutrients.protein_g.value)).toBe(30);
      // Editing the old entry's quantity keeps its ORIGINAL revision (no silent refresh).
      const upd = await c.query("select public.update_diary_entry($1, 1, $2, 0.5, null) as r", [
        first.rows[0].r.entryId,
        IDS.bowl.portionServing,
      ]);
      const edited = await snapshotNutrients(c, upd.rows[0].r.entryId);
      expect(Number(edited.nutrients.protein_g.value)).toBe(12);
      expect(edited.revision_no).toBe(2);
      expect(edited.food_revision_id).toBe(IDS.bowl.rev);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("snapshots are immutable, even for the database owner", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userA, role: "authenticated" })]);
      const { rows } = await c.query(logSql, logParams({ rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1" }));
      await c.query("reset role");
      const err = await pgError(
        c.query("update public.diary_snapshots set nutrients = '{}' where entry_id = $1", [rows[0].r.entryId]),
      );
      expect(err.code).toBe("PT403");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("idempotency and concurrency", () => {
  it("F13: the same idempotency key submitted twice concurrently creates exactly one entry", async () => {
    const key = randomUUID();
    const params = logParams({ key, rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1" });
    const [r1, r2] = await Promise.all([
      asMember(userB, (c) => c.query(logSql, params), { commit: true }),
      asMember(userB, (c) => c.query(logSql, params), { commit: true }),
    ]);
    expect(r1.rows[0].r.entryId).toBe(r2.rows[0].r.entryId);
    expect([r1.rows[0].r.replayed, r2.rows[0].r.replayed].sort()).toEqual([false, true]);
    const { rows } = await pool.query(
      `select count(*)::int as n, (select count(*)::int from public.diary_snapshots s where s.entry_id = $1) as snaps
         from public.diary_entries where owner_id = $2`,
      [r1.rows[0].r.entryId, userB],
    );
    expect(rows[0]).toEqual({ n: 1, snaps: 1 });
  });

  it("reusing a key with a different request is a 409 conflict", async () => {
    const key = randomUUID();
    await asMember(userB, (c) => c.query(logSql, logParams({ key, rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1" })), { commit: true });
    const err = await pgError(
      asMember(userB, (c) => c.query(logSql, logParams({ key, rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "2" }))),
    );
    expect(err).toMatchObject({ code: "PT409", message: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("F14: two edits with expectedVersion 1 -> one succeeds, the other gets 409", async () => {
    const { rows } = await asMember(
      userB,
      (c) => c.query(logSql, logParams({ rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1" })),
      { commit: true },
    );
    const entryId = rows[0].r.entryId;
    const edit = (m: string) =>
      asMember(userB, (c) => c.query("select public.update_diary_entry($1, 1, $2, $3, null) as r", [entryId, IDS.tofu.portion150g, m]), { commit: true });
    const results = await Promise.allSettled([edit("2"), edit("3")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as { code: string }).code).toBe("PT409");
  });

  it("delete is idempotent and removes the entry from day totals", async () => {
    const { rows } = await asMember(
      userB,
      (c) => c.query(logSql, logParams({ rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1", date: "2026-11-01" })),
      { commit: true },
    );
    const entryId = rows[0].r.entryId;
    const first = await asMember(userB, (c) => c.query("select public.delete_diary_entry($1, 1) as r", [entryId]), { commit: true });
    const again = await asMember(userB, (c) => c.query("select public.delete_diary_entry($1, 1) as r", [entryId]), { commit: true });
    expect(first.rows[0].r.alreadyDeleted).toBe(false);
    expect(again.rows[0].r.alreadyDeleted).toBe(true);
    const totals = await asMember(userB, (c) => c.query("select * from public.diary_day_totals('2026-11-01', '2026-11-01')"));
    expect(totals.rows).toHaveLength(0);
  });
});

describe("day totals", () => {
  it("F03 in SQL: known subtotal plus unknown count; unknown is never summed as zero", async () => {
    await asMember(userA, async (c) => {
      await c.query(logSql, logParams({ rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1", date: "2026-10-05" }));
      await c.query(logSql, logParams({ rev: IDS.mushroomToast.rev, portion: IDS.mushroomToast.portionPlate, multiplier: "1", date: "2026-10-05" }));
      const { rows } = await c.query(
        "select * from public.diary_day_totals('2026-10-05', '2026-10-05') where nutrient_code = 'protein_g'",
      );
      expect(rows[0].entry_count).toBe(2);
      expect(Number(rows[0].known_subtotal)).toBe(18);
      expect(rows[0].unknown_entries).toBe(1);
    });
  });

  it("rejects ranges over 31 days", async () => {
    const err = await pgError(asMember(userA, (c) => c.query("select * from public.diary_day_totals('2026-01-01', '2026-03-01')")));
    expect(err.code).toBe("PT422");
  });
});

describe("validation", () => {
  const cases: [string, LogArgs, string][] = [
    ["zero multiplier", { rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "0" }, "INVALID_AMOUNT"],
    ["multiplier above 100", { rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "101" }, "INVALID_AMOUNT"],
    ["negative grams", { rev: IDS.tofu.rev, grams: "-1" }, "INVALID_AMOUNT"],
    ["grams on a serving food with no sourced weight", { rev: IDS.bowl.rev, grams: "300" }, "UNSUPPORTED_MASS_CONVERSION"],
    ["portion from another food", { rev: IDS.tofu.rev, portion: IDS.bowl.portionServing, multiplier: "1" }, "INVALID_PORTION"],
    ["both portion and grams", { rev: IDS.tofu.rev, portion: IDS.tofu.portion150g, multiplier: "1", grams: "10" }, "CHOOSE_PORTION_OR_GRAMS"],
    ["invalid timezone", { rev: IDS.tofu.rev, grams: "10", tz: "Mars/Base" }, "INVALID_TIMEZONE"],
    ["consumed time on a different local date", { rev: IDS.tofu.rev, grams: "10", date: "2026-11-13", consumedAt: "2026-11-14T06:00:00Z" }, "DATE_DOES_NOT_MATCH_TIME"],
    ["unknown context", { rev: IDS.tofu.rev, grams: "10", context: "spaceship" }, "INVALID_CONTEXT"],
  ];
  for (const [name, args, message] of cases) {
    it(`rejects ${name}`, async () => {
      const err = await pgError(asMember(userA, (c) => c.query(logSql, logParams(args))));
      expect(err.message).toBe(message);
    });
  }

  it("guests cannot log food at all", async () => {
    const err = await pgError(asMember(null, (c) => c.query(logSql, logParams({ rev: IDS.tofu.rev, grams: "10" }))));
    expect(err.code).toBe("42501"); // permission denied for function
  });
});
