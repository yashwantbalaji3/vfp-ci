import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asMember, createTestUser, deleteTestUsers, pgError, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

let member: string;
let publisher: string;
beforeAll(async () => {
  member = await createTestUser("goals");
  publisher = await createTestUser("publisher");
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher'), ($1, 'curator')", [publisher]);
});
afterAll(async () => {
  await deleteTestUsers([member, publisher]);
  await pool.end();
});

describe("goals (R-G01, R-G02)", () => {
  it("a new target applies from its date forward and never rewrites earlier days", async () => {
    await asMember(member, async (c) => {
      await c.query("select public.set_goal('protein_g_per_day', 80, '2026-11-01')");
      await c.query("select public.set_goal('protein_g_per_day', 100, '2026-11-12')");
      const { rows } = await c.query(
        "select target::int, effective_from::text, effective_to::text from public.goal_versions where owner_id = $1 order by effective_from",
        [member],
      );
      expect(rows).toEqual([
        { target: 80, effective_from: "2026-11-01", effective_to: "2026-11-12" },
        { target: 100, effective_from: "2026-11-12", effective_to: null },
      ]);
      // Disabling stores no active goal (not a zero target).
      await c.query("select public.set_goal('protein_g_per_day', null, '2026-11-20')");
      const after = await c.query("select count(*)::int as n from public.goal_versions where owner_id = $1 and effective_to is null", [member]);
      expect(after.rows[0].n).toBe(0);
    });
  });

  it("rejects out-of-range and non-integer cooking goals", async () => {
    expect((await pgError(asMember(member, (c) => c.query("select public.set_goal('protein_g_per_day', 0, '2026-11-01')")))).message).toBe("GOAL_OUT_OF_RANGE");
    expect((await pgError(asMember(member, (c) => c.query("select public.set_goal('protein_g_per_day', 1001, '2026-11-01')")))).message).toBe("GOAL_OUT_OF_RANGE");
    expect((await pgError(asMember(member, (c) => c.query("select public.set_goal('cook_sessions_per_week', 2.5, '2026-11-01')")))).message).toBe("GOAL_OUT_OF_RANGE");
  });

  it("overlapping goal ranges are impossible even for the database owner", async () => {
    const err = await pgError(
      pool.query(
        `insert into public.goal_versions (owner_id, metric, target, effective_from, effective_to)
         values ($1, 'protein_g_per_day', 50, '2026-01-01', null), ($1, 'protein_g_per_day', 60, '2026-02-01', null)`,
        [member],
      ),
    );
    expect(err.code).toBe("23P01");
  });
});

describe("custom foods (R-F03)", () => {
  it("creates a private food with unknown nutrients kept null, and logs it", async () => {
    await asMember(member, async (c) => {
      const { rows } = await c.query(
        `select public.create_custom_food('Grandma''s chickpea flatbread', null, 'serving', 1,
           '{"protein_g": 9, "energy_kcal": 210}'::jsonb, '[]'::jsonb, 'From my own recipe card') as r`,
      );
      const { revisionId, foodItemId } = rows[0].r;
      const nv = await c.query("select nutrient_code, value, method, missing_reason from public.nutrient_values where revision_id = $1 order by nutrient_code", [revisionId]);
      const fat = nv.rows.find((r) => r.nutrient_code === "fat_g");
      expect(fat).toMatchObject({ value: null, method: "user_entered", missing_reason: "not_provided" });
      const item = await c.query("select visibility, owner_id, kind from public.food_items where id = $1", [foodItemId]);
      expect(item.rows[0]).toEqual({ visibility: "private", owner_id: member, kind: "custom" });
      const portion = await c.query("select id from public.portions where revision_id = $1", [revisionId]);
      const log = await c.query(
        "select public.log_food_entry(gen_random_uuid(), $1, $2, 2, null, 'home', 'dinner', '2026-11-13', 'America/New_York') as r",
        [revisionId, portion.rows[0].id],
      );
      expect(log.rows[0].r.entryId).toBeTruthy();
      // The owner can never flip a custom food to public.
      // Members hold no write privilege on catalog items at all (since the R2 fix-up the refusal is outright) …
      await c.query("savepoint direct");
      expect((await pgError(c.query("update public.food_items set visibility = 'public' where id = $1", [foodItemId]))).code).toBe("42501");
      await c.query("rollback to savepoint direct");
      // … and the guard trigger stops even the database owner.
      await c.query("reset role");
      const err = await pgError(c.query("update public.food_items set visibility = 'public', owner_id = null where id = $1", [foodItemId]));
      expect(err.code).toBe("PT403");
    });
  });

  it("rejects impossible values (more than 100 g protein per 100 g) and unknown nutrient codes", async () => {
    const bad = await pgError(
      asMember(member, (c) => c.query(`select public.create_custom_food('X', null, 'mass', 100, '{"protein_g": 150}'::jsonb)`)),
    );
    expect(bad.message).toBe("INVALID_NUTRIENT_VALUE");
    const unknown = await pgError(
      asMember(member, (c) => c.query(`select public.create_custom_food('X', null, 'mass', 100, '{"vitamin_z": 1}'::jsonb)`)),
    );
    expect(unknown.message).toBe("UNKNOWN_NUTRIENT");
  });
});

describe("publication gate (R-O01)", () => {
  async function draftRevision(c: import("pg").PoolClient, rightsStatus: "cleared" | "unreviewed") {
    const item = randomUUID();
    const rev = randomUUID();
    const record = randomUUID();
    await c.query("reset role");
    await c.query(
      `insert into public.source_records (id, source_id, observed_at, rights_status) values ($1, '00000000-0000-4000-8000-00000000b101', now(), $2)`,
      [record, rightsStatus],
    );
    await c.query("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'ingredient', 'public', 'draft', true)", [item]);
    await c.query(
      "insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit) values ($1, $2, 1, 'Demo gate test food', 'mass', 100, 'g')",
      [rev, item],
    );
    await c.query("insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id) values ($1, 'protein_g', 5, 'published', $2)", [rev, record]);
    // Since R2 nothing is published on one person's word: the revision must have been
    // entered and submitted by someone other than the publisher (tests/db/r2-editor.test.ts).
    await c.query(
      "insert into public.catalog_changes (kind, is_new, food_item_id, draft_revision_id, state, author_id, submitted_at) values ('food', true, $1, $2, 'submitted', $3, now())",
      [item, rev, member],
    );
    await c.query("set local role authenticated");
    return { item, rev };
  }

  it("blocks publication when cited rights are not cleared; publishes and audits when they are", async () => {
    await asMember(publisher, async (c) => {
      const blocked = await draftRevision(c, "unreviewed");
      const err = await pgError(c.query("select public.publish_food_revision($1, 1)", [blocked.rev]));
      expect(err.message).toBe("PUBLISH_GATE_FAILED");
    });
    await asMember(publisher, async (c) => {
      const ok = await draftRevision(c, "cleared");
      const { rows } = await c.query("select public.publish_food_revision($1, 1, 'gate test') as r", [ok.rev]);
      expect(rows[0].r.itemVersion).toBe(2);
      const audit = await c.query("select action from public.audit_events where entity_id = $1", [ok.rev]);
      expect(audit.rows).toEqual([]); // publishers are not admins: they cannot read the audit log
      await c.query("reset role");
      const auditAsOwner = await c.query("select action, actor_id from public.audit_events where entity_id = $1", [ok.rev]);
      expect(auditAsOwner.rows).toEqual([{ action: "publish_food_revision", actor_id: publisher }]);
      // Published evidence is frozen.
      await c.query("savepoint frozen");
      const frozen = await pgError(c.query("update public.nutrient_values set value = 6 where revision_id = $1", [ok.rev]));
      expect(frozen.code).toBe("PT403");
      await c.query("rollback to savepoint frozen");
      const audErr = await pgError(c.query("delete from public.audit_events where entity_id = $1", [ok.rev]));
      expect(audErr.code).toBe("PT403");
    });
  });

  it("ordinary members cannot publish, edit the catalog or grant themselves roles", async () => {
    await asMember(member, async (c) => {
      expect((await pgError(c.query("select public.publish_food_revision($1, 1)", [IDS.tofu.rev]))).message).toBe("FORBIDDEN");
    });
    await asMember(member, async (c) => {
      const err = await pgError(c.query("insert into public.food_items (kind, visibility, status) values ('ingredient', 'public', 'draft')"));
      expect(err.code).toBe("42501");
    });
    await asMember(member, async (c) => {
      const err = await pgError(c.query("insert into public.role_assignments (user_id, role) values ($1, 'admin')", [member]));
      expect(err.code).toBe("42501");
    });
  });
});
