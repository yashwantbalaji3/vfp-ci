import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createTestUser, deleteTestUsers, pool } from "../helpers/db";
import { IDS, M4 } from "../fixtures/ids";

// R2 · Editor and corrections workflow (docs/14 "R2 evidence map").
// Every test runs inside ONE transaction that is rolled back, switching between
// people as it goes, so the shared local catalog is never left changed.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ids: Record<string, string> = {};
const h = (name: string) => `r2${name}_${ids[name].slice(0, 6)}`;

type T = {
  as: (who: string | null | "postgres") => Promise<void>;
  q: (sql: string, params?: unknown[]) => Promise<J>;
  rows: (sql: string, params?: unknown[]) => Promise<J[]>;
  err: (sql: string, params?: unknown[]) => Promise<{ code: string; message: string; detail?: string }>;
};

async function tx(fn: (t: T) => Promise<void>) {
  const c: PoolClient = await pool.connect();
  let n = 0;
  const t: T = {
    as: async (who) => {
      await c.query("reset role");
      if (who === "postgres") return;
      if (who === null) {
        await c.query("set local role anon");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      } else {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids[who] ?? who, role: "authenticated" })]);
      }
    },
    q: async (sql, params = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r,
    rows: async (sql, params = []) => (await c.query(sql, params)).rows,
    err: async (sql, params = []) => {
      const sp = `sp${++n}`;
      await c.query(`savepoint ${sp}`);
      try {
        await c.query(/^\s*(select|insert|update|delete|with)\b/i.test(sql) ? sql : `select ${sql}`, params);
      } catch (e) {
        await c.query(`rollback to savepoint ${sp}`);
        const x = e as { code?: string; message?: string; detail?: string };
        return { code: x.code ?? "", message: x.message ?? "", detail: x.detail };
      }
      throw new Error(`Expected to fail, but it succeeded: ${sql}`);
    },
  };
  try {
    await c.query("begin");
    await fn(t);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}

const SOURCE = { publisher: "Demo Central Kitchen (invented)", sourceType: "operator_statement", observedOn: "2026-11-10", summary: "Invented statement for a test: the kitchen says the recipe changed." };
const detail = (t: T, item: string) => t.q("public.food_detail($1, true, false)", [item]);
const elig = (t: T, rev: string, diet = "vegan", excl: string[] = []) => t.q("public.check_eligibility($1, $2, $3, false)", [rev, diet, excl]);
const searchIds = async (t: T, params: J) =>
  ((await t.q("public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50, ...params })])).items as J[]).map((i) => i.id ?? i.foodItemId);
const currentRev = async (t: T, item: string) => (await t.rows("select current_revision_id as r from public.food_items where id = $1", [item]))[0].r as string;

/** curator starts a change, records a source and a patch, and submits it. */
async function proposed(t: T, item: string, patch: J, opts: { correction?: string; summary?: string } = {}) {
  await t.as("cur");
  const { changeId } = await t.q("public.editor_start_change($1, $2)", [item, opts.correction ?? null]);
  await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: opts.summary ?? "Test change", source: SOURCE })]);
  await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify(patch)]);
  await t.q("public.editor_submit_change($1)", [changeId]);
  return changeId as string;
}
const approve = async (t: T, changeId: string, who = "pub") => {
  await t.as(who);
  return t.q("public.editor_review_change($1, 'approve', 'Checked against the source', true, true)", [changeId]);
};

beforeAll(async () => {
  for (const name of ["cur", "cur2", "pub", "both", "mod", "mem", "rep", "bad"]) {
    ids[name] = await createTestUser(`r2-${name}`);
    await pool.query("insert into public.profiles_public (user_id, handle, display_name) values ($1, $2, $3) on conflict (user_id) do update set handle = excluded.handle", [
      ids[name], h(name), name,
    ]);
  }
  const role = (name: string, r: string) => pool.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [ids[name], r]);
  await role("cur", "curator");
  await role("cur2", "curator");
  await role("pub", "publisher");
  await role("both", "curator");
  await role("both", "publisher");
  await role("mod", "moderator");
});
afterAll(async () => {
  await deleteTestUsers(Object.values(ids));
  await pool.end();
});

describe("who may use the editor (PH-02 tests 1 and 7)", () => {
  const calls: [string, unknown[]][] = [
    ["public.editor_desk()", []],
    ["public.editor_items(null)", []],
    ["public.editor_start_change($1, null)", [IDS.tofuStew.item]],
    ["public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "recipe", name: "Demo intruder" })]],
    ["public.editor_start_venue_change(null, null)", []],
    ["public.editor_flag_needs_review($1, 'because')", [IDS.tofuStew.item]],
    ["public.corrections_queue()", []],
    ["public.staff_alerts()", []],
    ["public.member_history('demo_maya')", []],
    ["public.set_member_suspension('demo_maya', true, 'because')", []],
  ];

  it("a guest, an ordinary member and a reporter are refused everywhere; tables answer nothing", async () => {
    await tx(async (t) => {
      for (const who of [null, "mem", "rep"] as const) {
        await t.as(who);
        for (const [sql, params] of calls) {
          const e = await t.err(sql, params);
          expect([who, sql, e.code], sql).toEqual([who, sql, who === null ? "42501" : "PT403"]);
        }
        for (const table of ["catalog_changes", "review_flags"]) {
          expect((await t.err(`select * from public.${table}`)).code).toBe("42501");
          expect((await t.err(`insert into public.${table} (id) values (gen_random_uuid())`)).code).toBe("42501");
        }
      }
    });
  });

  it("a moderator is not an editor, and an editor is not a moderator", async () => {
    await tx(async (t) => {
      await t.as("mod");
      expect((await t.err("public.editor_desk()")).code).toBe("PT403");
      expect((await t.err("public.corrections_queue()")).code).toBe("PT403");
      const modAlerts = await t.q("public.staff_alerts()");
      expect(modAlerts).toMatchObject({ isModerator: true, isEditor: false });
      expect(modAlerts.openCorrections).toBeUndefined();
      await t.as("cur");
      expect((await t.err("public.member_history('demo_maya')")).code).toBe("PT403");
      expect((await t.err("public.set_member_suspension('demo_maya', true, 'x reason')")).code).toBe("PT403");
      const curAlerts = await t.q("public.staff_alerts()");
      expect(curAlerts).toMatchObject({ isModerator: false, isEditor: true, canPublish: false });
      expect(curAlerts.openReports).toBeUndefined();
    });
  });

  it("even staff cannot write the change or flag tables directly, or move the published pointer", async () => {
    await tx(async (t) => {
      for (const who of ["cur", "pub", "both"]) {
        await t.as(who);
        expect((await t.err("insert into public.catalog_changes (kind, food_item_id, state) values ('food', $1, 'published')", [IDS.tofuStew.item])).code).toBe("42501");
        expect((await t.err("update public.review_flags set resolved_at = now()")).code).toBe("42501");
        // Since the R2 fix-up editors hold no direct write privilege on any catalog table: every edit goes through the checked functions.
        expect((await t.err("update public.food_items set current_revision_id = current_revision_id where id = $1", [IDS.tofuStew.item])).code).toBe("42501");
        expect((await t.err("update public.dietary_claims set outcome = 'compatible' where revision_id = $1", [IDS.tofuStew.rev])).code).toBe("42501");
        expect((await t.err("update public.nutrient_values set value = 99 where revision_id = $1", [IDS.tofuStew.rev])).code).toBe("42501");
      }
    });
  });
});

describe("accepting a correction changes nothing a visitor can see (D-CORR-1, R2 test 2, PH-02 tests 4 and 5)", () => {
  it("only a sourced revision, entered by one person and approved by another, changes the page; the audit trail shows both", async () => {
    await tx(async (t) => {
      const item = IDS.tofuStew.item;
      await t.as(null);
      const before = await detail(t, item);
      const eligBefore = await elig(t, IDS.tofuStew.rev);

      await t.as("rep");
      const correction = (await t.q("public.submit_correction($1, null, 'dietary', 'The stew now uses a fish stock base', 'Server told me on Tuesday')", [item])) as unknown as string;

      // Accepting records a decision. The page, the dietary answer and the published revision stay exactly as they were.
      await t.as("cur");
      await t.q("public.decide_correction($1, 'accepted', 'Plausible, needs checking with the kitchen')", [correction]);
      await t.as(null);
      expect(await detail(t, item)).toEqual(before);
      expect(await elig(t, IDS.tofuStew.rev)).toEqual(eligBefore);
      expect(await currentRev(t, item)).toBe(IDS.tofuStew.rev);

      // The editor starts a change from the correction. Saving and submitting it still changes nothing public.
      await t.as("cur");
      const desk = await t.q("public.editor_desk()");
      expect(desk.acceptedCorrections.map((c: J) => c.correctionId)).toContain(correction);
      const changeId = await proposed(
        t,
        item,
        { dietary: [{ diet: "vegan", outcome: "incompatible" }, { diet: "vegetarian", outcome: "incompatible" }], families: [{ family: "animal_stock", presence: "present", detail: "Fish stock base" }] },
        { correction, summary: "Kitchen confirmed a fish stock base" },
      );
      await t.as(null);
      expect(await detail(t, item)).toEqual(before);
      expect(await currentRev(t, item)).toBe(IDS.tofuStew.rev);

      // The author cannot approve. A curator who is not a publisher cannot approve. Ticking nothing cannot approve.
      await t.as("cur");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [changeId])).message).toBe("FORBIDDEN");
      await t.as("cur2");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [changeId])).message).toBe("FORBIDDEN");
      await t.as("pub");
      expect((await t.err("public.editor_review_change($1, 'approve', null, false, true)", [changeId])).message).toBe("CHECKS_REQUIRED");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, false)", [changeId])).message).toBe("CHECKS_REQUIRED");
      const view = await t.q("public.editor_change($1)", [changeId]);
      expect(view).toMatchObject({ state: "submitted", touchesEvidence: true, canReview: true, canEdit: false, fromCorrection: true });
      expect(view.source).toMatchObject({ publisher: SOURCE.publisher, rightsStatus: "unreviewed" });
      expect(view.correction.proposedValue).toBe("The stew now uses a fish stock base");
      // The reporter is never named to the editors.
      expect(JSON.stringify(view) + JSON.stringify(desk)).not.toContain(ids.rep);
      expect(JSON.stringify(view) + JSON.stringify(desk)).not.toContain("r2-rep");

      // The second person approves: now, and only now, the page changes.
      const done = await approve(t, changeId);
      expect(done.state).toBe("published");
      await t.as(null);
      const after = await detail(t, item);
      expect(after).not.toEqual(before);
      const newRev = await currentRev(t, item);
      expect(newRev).not.toBe(IDS.tofuStew.rev);
      expect((await elig(t, newRev)).status).toBe("excluded");
      expect(await searchIds(t, { diet: "vegan" })).not.toContain(item);

      // Audit: both people, each step, with times; the correction is linked to what was done about it.
      await t.as("postgres");
      const trail = await t.rows("select action, actor_id, occurred_at, reason from public.audit_events where entity_type = 'catalog_change' and entity_id = $1 order by action", [changeId]);
      expect(trail.map((a) => [a.action, a.actor_id])).toEqual([
        ["catalog_change.published", ids.pub],
        ["catalog_change.started", ids.cur],
        ["catalog_change.submitted", ids.cur],
      ]);
      expect(trail.every((a) => a.occurred_at instanceof Date)).toBe(true);
      const row = (await t.rows("select author_id, reviewer_id, reviewed_at, state from public.catalog_changes where id = $1", [changeId]))[0];
      expect(row).toMatchObject({ author_id: ids.cur, reviewer_id: ids.pub, state: "published" });
      expect((await t.rows("select applied_change_id from public.corrections where id = $1", [correction]))[0].applied_change_id).toBe(changeId);
      expect((await t.rows("select rights_status from public.source_records sr join public.catalog_changes c on c.source_record_id = sr.id where c.id = $1", [changeId]))[0].rights_status).toBe("cleared");
      // The old revision is still there, untouched, for anything that recorded it.
      expect((await t.rows("select published_at is not null as kept from public.food_revisions where id = $1", [IDS.tofuStew.rev]))[0].kept).toBe(true);
      // The trail cannot be rewritten.
      expect((await t.err("update public.audit_events set reason = 'x' where entity_id = $1", [changeId])).code).toBe("PT403");

      // The reporter sees their own correction and that it was acted on; nobody else's.
      await t.as("rep");
      const mine = await t.q("public.my_corrections()");
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ state: "accepted", applied: true });
      await t.as("mem");
      expect(await t.q("public.my_corrections()")).toEqual([]);
    });
  });

  it("rejecting or marking a duplicate records a reason and also changes nothing", async () => {
    await tx(async (t) => {
      await t.as(null);
      const before = await detail(t, IDS.dosa.item);
      await t.as("rep");
      const a = await t.q("public.submit_correction($1, null, 'price', 'It costs 11 dollars now', null)", [IDS.dosa.item]);
      const b = await t.q("public.submit_correction($1, null, 'price', 'Price went up to 11', null)", [IDS.dosa.item]);
      await t.as("cur");
      await t.q("public.decide_correction($1, 'rejected', 'No evidence given')", [a]);
      await t.q("public.decide_correction($1, 'duplicate', 'Same as an earlier report')", [b]);
      // A rejected correction cannot be turned into a change.
      expect((await t.err("public.editor_start_change($1, $2)", [IDS.dosa.item, a])).message).toBe("CORRECTION_NOT_ACCEPTED");
      await t.as(null);
      expect(await detail(t, IDS.dosa.item)).toEqual(before);
      await t.as("postgres");
      const trail = await t.rows("select action, reason from public.audit_events where entity_id = any($1::uuid[]) and action like 'correction.%' order by action", [[a, b]]);
      expect(trail).toEqual([
        { action: "correction.duplicate", reason: "Same as an earlier report" },
        { action: "correction.rejected", reason: "No evidence given" },
      ]);
    });
  });
});

describe("one person alone cannot change dietary or nutrition information (R2 test 3)", () => {
  it("a person holding both roles cannot approve their own entry, by any route", async () => {
    await tx(async (t) => {
      await t.as("both");
      const { changeId } = await t.q("public.editor_start_change($1, null)", [IDS.dosa.item]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Solo change", source: SOURCE })]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ nutrients: [{ code: "protein_g", value: 99, method: "published" }] })]);
      await t.q("public.editor_submit_change($1)", [changeId]);
      expect((await t.err("public.editor_review_change($1, 'approve', 'me again', true, true)", [changeId])).message).toBe("SECOND_PERSON_REQUIRED");
      const view = await t.q("public.editor_change($1)", [changeId]);
      expect(view.canReview).toBe(false);
      // The older publish function refuses too, with or without a submitted change.
      const draft = view.draft.revisionId;
      const version = (await t.rows("select version from public.food_items where id = $1", [IDS.dosa.item]))[0].version;
      expect((await t.err("public.publish_food_revision($1, $2)", [draft, version])).message).toBe("SECOND_PERSON_REQUIRED");
      // The table itself refuses a row in which the checker is the author.
      await t.as("postgres");
      expect((await t.err("update public.catalog_changes set reviewer_id = author_id where id = $1", [changeId])).code).toBe("23514");
      await t.as(null);
      expect(await currentRev(t, IDS.dosa.item)).toBe(IDS.dosa.rev);
    });
  });

  it("a draft that nobody submitted cannot be published by a publisher", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_start_change($1, null)", [IDS.dosa.item]);
      const draft = (await t.q("public.editor_change($1)", [changeId])).draft.revisionId;
      await t.as("pub");
      expect((await t.err("public.publish_food_revision($1, 2)", [draft])).message).toMatch(/SECOND_PERSON_REQUIRED|VERSION_CONFLICT/);
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [changeId])).message).toBe("WRONG_STATE");
      // Another editor cannot edit or submit someone else's draft.
      await t.as("cur2");
      expect((await t.err("public.editor_save_change($1, '{\"summary\":\"mine now\"}'::jsonb)", [changeId])).message).toBe("NOT_YOUR_DRAFT");
      expect((await t.err("public.editor_submit_change($1)", [changeId])).message).toBe("NOT_YOUR_DRAFT");
      expect((await t.err("public.editor_start_change($1, null)", [IDS.dosa.item])).message).toBe("CHANGE_ALREADY_OPEN");
    });
  });
});

describe("a change needs a source, and passes the publication checks", () => {
  it("statements cannot be saved without a source; a change cannot be submitted without a source and a summary", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_start_change($1, null)", [IDS.dosa.item]);
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ dietary: [{ diet: "vegan", outcome: "compatible" }] })])).message).toBe("SOURCE_REQUIRED");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ nutrients: [{ code: "protein_g", value: 12, method: "published" }] })])).message).toBe("SOURCE_REQUIRED");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ reconfirm: true })])).message).toBe("SOURCE_REQUIRED");
      expect((await t.err("public.editor_submit_change($1)", [changeId])).message).toBe("SUMMARY_REQUIRED");
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Renamed" })]);
      expect((await t.err("public.editor_submit_change($1)", [changeId])).message).toBe("SOURCE_REQUIRED");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ source: { publisher: "x" } })])).message).toBe("SOURCE_INCOMPLETE");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ source: { ...SOURCE, sourceType: "the internet" } })])).message).toBe("INVALID_PATCH");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ source: SOURCE, dietary: [{ diet: "vegan", outcome: "probably" }] })])).message).toBe("INVALID_PATCH");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ source: SOURCE, nutrients: [{ code: "protein_g", value: "lots", method: "published" }] })])).message).toBe("INVALID_PATCH");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ source: SOURCE, nutrients: [{ code: "protein_g", value: 5, method: "guess" }] })])).message).toBe("INVALID_PATCH");
    });
  });

  it("an unknown nutrition value stays unknown, never zero; a number carries its method and source", async () => {
    await tx(async (t) => {
      const changeId = await proposed(t, IDS.dosa.item, {
        nutrients: [
          { code: "protein_g", value: "", missingReason: "not_provided" },
          { code: "energy_kcal", value: 410, method: "published" },
        ],
      });
      await approve(t, changeId);
      await t.as("postgres");
      const rev = await currentRev(t, IDS.dosa.item);
      const nv = await t.rows("select nutrient_code, value, method, missing_reason, source_record_id is not null as sourced from public.nutrient_values where revision_id = $1 and nutrient_code in ('protein_g','energy_kcal') order by 1", [rev]);
      expect(nv).toEqual([
        { nutrient_code: "energy_kcal", value: "410", method: "published", missing_reason: null, sourced: true },
        { nutrient_code: "protein_g", value: null, method: "unknown", missing_reason: "not_provided", sourced: false },
      ]);
    });
  });

  it("a claim of 'suitable' beside a stated forbidden ingredient is refused at publication", async () => {
    await tx(async (t) => {
      const changeId = await proposed(t, IDS.dosa.item, {
        dietary: [{ diet: "vegan", outcome: "compatible" }],
        families: [{ family: "dairy", presence: "present", detail: "Ghee" }],
      });
      await t.as("pub");
      const e = await t.err("public.editor_review_change($1, 'approve', null, true, true)", [changeId]);
      expect(e.message).toBe("PUBLISH_GATE_FAILED");
      expect(e.detail).toContain("claim_contradicts_ingredients");
      expect((await t.q("public.editor_change($1)", [changeId])).gate).toContain("claim_contradicts_ingredients");
      // Refused means refused: nothing was published and the source was not marked as cleared.
      await t.as("postgres");
      expect(await currentRev(t, IDS.dosa.item)).toBe(IDS.dosa.rev);
      expect((await t.rows("select rights_status from public.source_records sr join public.catalog_changes c on c.source_record_id = sr.id where c.id = $1", [changeId]))[0].rights_status).toBe("unreviewed");
    });
  });

  it("a rejected or withdrawn change leaves no draft behind and frees the record for a new change", async () => {
    await tx(async (t) => {
      const first = await proposed(t, IDS.dosa.item, { name: "Demo dosa renamed" });
      await t.as("pub");
      expect((await t.err("public.editor_review_change($1, 'reject', null)", [first])).message).toBe("REASON_REQUIRED");
      await t.q("public.editor_review_change($1, 'reject', 'The source does not say this')", [first]);
      await t.as("cur");
      const seen = await t.q("public.editor_change($1)", [first]);
      expect(seen).toMatchObject({ state: "rejected", reviewNote: "The source does not say this" });
      expect(seen.draft.name).toBe("Demo dosa renamed"); // kept as a record of what was proposed
      const { changeId: second } = await t.q("public.editor_start_change($1, null)", [IDS.dosa.item]);
      await t.q("public.editor_withdraw_change($1)", [second]);
      await t.as("postgres");
      expect((await t.rows("select count(*)::int as n from public.food_revisions where food_item_id = $1", [IDS.dosa.item]))[0].n).toBe(1);
      expect(await currentRev(t, IDS.dosa.item)).toBe(IDS.dosa.rev);
    });
  });
});

describe("needs review (J5, R2 test 4)", () => {
  it("a flagged dish leaves every dietary filter at once and returns only after a checked revision", async () => {
    await tx(async (t) => {
      const item = IDS.tempehBowl.item;
      await t.as(null);
      expect((await elig(t, IDS.tempehBowl.rev)).status).toBe("eligible");
      expect(await searchIds(t, { diet: "vegan" })).toContain(item);
      const allBefore = await searchIds(t, {});

      await t.as("cur");
      expect((await t.err("public.editor_flag_needs_review($1, '')", [item])).message).toBe("REASON_REQUIRED");
      await t.q("public.editor_flag_needs_review($1, 'Two sources disagree about the sauce')", [item]);
      expect((await t.err("public.editor_flag_needs_review($1, 'again')", [item])).message).toBe("ALREADY_FLAGGED");

      await t.as(null);
      const flagged = await elig(t, IDS.tempehBowl.rev);
      expect(flagged.status).toBe("needs_confirmation");
      expect(flagged.reasons.map((r: J) => r.code)).toContain("needs_review");
      expect((await elig(t, IDS.tempehBowl.rev, "vegetarian")).status).toBe("needs_confirmation");
      expect((await elig(t, IDS.tempehBowl.rev, "none", ["egg"])).status).toBe("needs_confirmation");
      expect(await searchIds(t, { diet: "vegan" })).not.toContain(item);
      expect(await searchIds(t, { diet: "vegetarian" })).not.toContain(item);
      // With no dietary filter the dish is still listed, marked as under review.
      expect(await searchIds(t, {})).toEqual(allBefore);
      expect((await t.q("public.freshness_marks($1, '{}', true)", [[item]])).foods[item].underReview).toBe(true);

      // Starting a change is not enough. Submitting is not enough.
      const changeId = await proposed(t, item, { reconfirm: true }, { summary: "Kitchen confirmed the sauce is soy based" });
      await t.as(null);
      expect(await searchIds(t, { diet: "vegan" })).not.toContain(item);
      await approve(t, changeId);
      await t.as(null);
      const rev = await currentRev(t, item);
      expect((await elig(t, rev)).status).toBe("eligible");
      expect(await searchIds(t, { diet: "vegan" })).toContain(item);
      expect((await t.q("public.freshness_marks($1, '{}', true)", [[item]])).foods[item].underReview).toBe(false);
      await t.as("cur");
      expect((await t.q("public.editor_desk()")).flags).toEqual([]);
    });
  });
});

describe("earlier diary entries keep their numbers (R2 test 5)", () => {
  it("a published correction to nutrition does not move what a member already logged", async () => {
    await tx(async (t) => {
      await t.as("mem");
      await t.q("public.log_food_entry(gen_random_uuid(), $1, $2, 1, null, 'restaurant', 'lunch', '2026-11-10', 'America/New_York')", [IDS.bowl.rev, IDS.bowl.portionServing]);
      const before = await t.q("public.diary_day('2026-11-10')");
      const proteinBefore = JSON.stringify(before).match(/"protein_g":\s*\{[^}]*\}|"protein[^,]*,/g);

      const changeId = await proposed(t, IDS.bowl.item, { nutrients: [{ code: "protein_g", value: 1, method: "published" }, { code: "energy_kcal", value: 1, method: "published" }] });
      await approve(t, changeId);

      await t.as("mem");
      const after = await t.q("public.diary_day('2026-11-10')");
      expect(after).toEqual(before);
      expect(JSON.stringify(after).match(/"protein_g":\s*\{[^}]*\}|"protein[^,]*,/g)).toEqual(proteinBefore);
      // The catalog itself did change.
      await t.as("postgres");
      const rev = await currentRev(t, IDS.bowl.item);
      expect(rev).not.toBe(IDS.bowl.rev);
      expect((await t.rows("select value from public.nutrient_values where revision_id = $1 and nutrient_code = 'protein_g'", [rev]))[0].value).toBe("1");
    });
  });
});

describe("out-of-date records (R2 test 6)", () => {
  it("a dish or place older than the agreed age is marked; a fresh check clears the mark", async () => {
    await tx(async (t) => {
      const item = IDS.dosa.item;
      const venue = IDS.venueAllston;
      await t.as(null);
      let marks = await t.q("public.freshness_marks($1, $2, true)", [[item], [venue]]);
      expect(marks.foods[item].state).toBe("current");
      expect(marks.venues[venue].state).toBe("current");

      // Move the clock: the published revision is immutable, so the test ages it with the guards off.
      await t.as("postgres");
      await t.rows("set local session_replication_role = replica");
      await t.rows("update public.food_revisions set published_at = now() - interval '45 days' where id = $1", [IDS.dosa.rev]);
      await t.rows("update public.venues set reviewed_at = now() - interval '45 days' where id = $1", [venue]);
      await t.rows("set local session_replication_role = origin");
      await t.as(null);
      marks = await t.q("public.freshness_marks($1, $2, true)", [[item], [venue]]);
      expect(marks.foods[item].state).toBe("due");
      expect(marks.venues[venue].state).toBe("due");

      await t.as("postgres");
      await t.rows("set local session_replication_role = replica");
      await t.rows("update public.food_revisions set published_at = now() - interval '61 days' where id = $1", [IDS.dosa.rev]);
      await t.rows("update public.venues set reviewed_at = now() - interval '61 days' where id = $1", [venue]);
      await t.rows("set local session_replication_role = origin");
      await t.as("mem");
      marks = await t.q("public.freshness_marks($1, $2, true)", [[item], [venue]]);
      expect(marks.foods[item].state).toBe("out_of_date");
      expect(marks.venues[venue].state).toBe("out_of_date");
      await t.as("cur");
      const desk = await t.q("public.editor_desk()");
      expect(desk.outOfDate.map((o: J) => o.foodItemId ?? o.venueId)).toEqual(expect.arrayContaining([item, venue]));

      // A checked revision, and a checked place record, are fresh again.
      const changeId = await proposed(t, item, { reconfirm: true }, { summary: "Menu checked again" });
      await approve(t, changeId);
      await t.as("cur");
      const v = await t.q("public.editor_start_venue_change($1, null)", [venue]);
      const current = (await t.q("public.editor_change($1)", [v.changeId])).payload;
      await t.q("public.editor_save_change($1, $2::jsonb)", [v.changeId, JSON.stringify({ summary: "Place checked again", source: SOURCE, venue: { ...current, hours: "Invented hours: 8 to 3 daily" } })]);
      await t.q("public.editor_submit_change($1)", [v.changeId]);
      await approve(t, v.changeId);
      await t.as(null);
      marks = await t.q("public.freshness_marks($1, $2, true)", [[item], [venue]]);
      expect(marks.foods[item].state).toBe("current");
      expect(marks.venues[venue].state).toBe("current");
    });
  });

  it("marks answer only for published public records, and demo records only where demo content is on", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "dish", name: "Demo unpublished dish", venueId: IDS.venueCentral })]);
      const draftItem = (await t.q("public.editor_change($1)", [changeId])).target.foodItemId;
      await t.as(null);
      const marks = await t.q("public.freshness_marks($1, '{}', true)", [[draftItem, IDS.dosa.item]]);
      expect(Object.keys(marks.foods)).toEqual([IDS.dosa.item]);
      expect((await t.q("public.freshness_marks($1, $2, false)", [[IDS.dosa.item], [IDS.venueCentral]]))).toEqual({ foods: {}, venues: {} });
    });
  });
});

describe("entering new records", () => {
  it("a new dish is invisible until a second person publishes it, and is marked as demo data", async () => {
    await tx(async (t) => {
      await t.as("cur");
      expect((await t.err("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "dish", name: "No place" })])).message).toBe("VENUE_NOT_FOUND");
      expect((await t.err("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "dish", venueId: IDS.venueCentral })])).message).toBe("NAME_REQUIRED");
      const { changeId } = await t.q("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "dish", name: "Demo R2 jackfruit taco", venueId: IDS.venueCentral, description: "Invented dish for a test." })]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "New dish on the invented menu", source: SOURCE })]);
      // It can be logged as one stated serving; no serving weight is invented.
      await t.as("postgres");
      expect(await t.rows("select p.label, p.grams from public.portions p join public.catalog_changes ch on ch.draft_revision_id = p.revision_id where ch.id = $1", [changeId])).toEqual([{ label: "1 serving", grams: null }]);
      await t.as("cur");
      await t.q("public.editor_save_change($1, $2::jsonb)", [
        changeId,
        JSON.stringify({
          dietary: [{ diet: "vegan", outcome: "compatible" }],
          families: [{ family: "egg", presence: "absent_by_statement" }, { family: "dairy", presence: "absent_by_statement" }],
          nutrients: [{ code: "protein_g", value: 14, method: "published" }, { code: "energy_kcal", value: "" }],
          dish: { menuSection: "Tacos", priceCents: 950, servingDescription: "Two tacos" },
        }),
      ]);
      const item = (await t.q("public.editor_change($1)", [changeId])).target.foodItemId as string;
      await t.q("public.editor_submit_change($1)", [changeId]);
      await t.as(null);
      expect((await t.err("public.food_detail($1, true, false)", [item])).code).toBe("PT404");
      expect(await searchIds(t, { q: "jackfruit" })).not.toContain(item);
      expect(await t.rows("select 1 from public.dish_prices where dish_id = $1", [item])).toEqual([]);

      await approve(t, changeId);
      await t.as(null);
      const d = await detail(t, item);
      expect(d.name).toBe("Demo R2 jackfruit taco");
      expect(d.isDemo).toBe(true);
      expect(await searchIds(t, { q: "jackfruit", diet: "vegan" })).toContain(item);
      // Demo records stay out of anything that does not ask for demo content.
      expect((await t.err("public.food_detail($1, false, false)", [item])).code).toBe("PT404");
      await t.as("postgres");
      expect((await t.rows("select amount_minor from public.dish_prices where dish_id = $1", [item]))[0].amount_minor).toBe(950);
      expect((await t.rows("select s.is_demo from public.catalog_changes c join public.source_records sr on sr.id = c.source_record_id join public.sources s on s.id = sr.source_id where c.id = $1", [changeId]))[0].is_demo).toBe(true);
    });
  });

  it("a new place is held apart until checked, then appears with its source; it is marked as demo data", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_start_venue_change(null, null)");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ venue: { name: "" } })])).message).toBe("NAME_REQUIRED");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ venue: { name: "X", lat: 123 } })])).message).toBe("INVALID_PATCH");
      await t.q("public.editor_save_change($1, $2::jsonb)", [
        changeId,
        JSON.stringify({ summary: "New invented place", source: SOURCE, venue: { name: "Demo R2 Corner Canteen", neighborhood: "Inman Square", locality: "Cambridge", region: "MA", venueType: "cafe", lat: 42.3737, lon: -71.1006, hours: "Invented hours: 9 to 5" } }),
      ]);
      await t.q("public.editor_submit_change($1)", [changeId]);
      await t.as("postgres");
      expect(await t.rows("select 1 from public.venues where name = 'Demo R2 Corner Canteen'")).toEqual([]);
      const done = await approve(t, changeId);
      await t.as(null);
      const v = await t.q("public.venue_detail($1, true)", [done.venueId]);
      expect(v).toMatchObject({ name: "Demo R2 Corner Canteen", venueType: "cafe", isDemo: true, status: "published" });
      expect(v.facts.map((f: J) => f.field)).toContain("hours");
      expect((await t.err("public.venue_detail($1, false)", [done.venueId])).code).toBe("PT404");
    });
  });

  it("a new recipe needs ingredients, steps and a trial cook before it can be published", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "recipe", name: "Demo R2 lentil toast", description: "Invented recipe for a test." })]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "New original recipe", source: { ...SOURCE, sourceType: "original_recipe", publisher: "Demo test kitchen (invented)" } })]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ recipe: { yieldServings: 2, prepMinutes: 5, cookMinutes: 10 } })]);
      await t.q("public.editor_submit_change($1)", [changeId]);
      await t.as("pub");
      const e = await t.err("public.editor_review_change($1, 'approve', null, true, true)", [changeId]);
      expect(e.message).toBe("PUBLISH_GATE_FAILED");
      expect(e.detail).toContain("recipe_not_reviewed");
      expect(e.detail).toContain("recipe_incomplete");
      await t.q("public.editor_review_change($1, 'reject', 'No ingredients, steps or trial cook yet')", [changeId]);

      await t.as("cur");
      const ingredients = (await t.q("public.editor_items(null)")).ingredients as J[];
      expect(ingredients.length).toBeGreaterThan(10);
      const again = (await t.q("public.editor_new_food($1::jsonb)", [JSON.stringify({ kind: "recipe", name: "Demo R2 lentil toast" })])).changeId;
      await t.q("public.editor_save_change($1, $2::jsonb)", [again, JSON.stringify({ summary: "New original recipe", source: { ...SOURCE, sourceType: "original_recipe" } })]);
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [again, JSON.stringify({ recipe: { ingredients: [{ foodItemId: IDS.dosa.item, quantity: 1, unit: "g", grams: 1 }] } })])).message).toBe("INGREDIENT_NOT_FOUND");
      await t.q("public.editor_save_change($1, $2::jsonb)", [
        again,
        JSON.stringify({
          recipe: {
            yieldServings: 2, prepMinutes: 5, cookMinutes: 10, trialCookedOn: "2026-11-12",
            ingredients: [{ foodItemId: ingredients[0].foodItemId, quantity: 100, unit: "g", grams: 100 }, { foodItemId: ingredients[1].foodItemId, quantity: 50, unit: "g", grams: 50 }],
            steps: [{ instruction: "Warm the first ingredient." }, { instruction: "Stir in the second and serve." }],
          },
        }),
      ]);
      await t.q("public.editor_submit_change($1)", [again]);
      const done = await approve(t, again);
      await t.as(null);
      const r = await t.q("public.recipe_detail($1, null, '{}', 'none', '{}', false, true)", [done.foodItemId]);
      expect(JSON.stringify(r)).toContain("Demo R2 lentil toast");
      expect(JSON.stringify(r)).toContain("Stir in the second and serve.");
    });
  });

  it("revising a recipe keeps its ingredients and steps unless they are changed", async () => {
    await tx(async (t) => {
      const item = M4.recipe(M4.chana);
      await t.as("postgres");
      const before = (await t.rows("select count(*)::int as n from public.recipe_ingredients where recipe_revision_id = $1", [M4.rev(M4.chana)]))[0].n;
      // The seeded demo recipes were never trial cooked, so the publication check refuses a revision until one is recorded.
      const first = await proposed(t, item, { description: "Invented recipe, description corrected." });
      expect((await t.q("public.editor_change($1)", [first])).touchesEvidence).toBe(false);
      await t.as("pub");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [first])).detail).toContain("recipe_not_reviewed");
      await t.q("public.editor_review_change($1, 'reject', 'No trial cook recorded')", [first]);
      const changeId = await proposed(t, item, { description: "Invented recipe, description corrected.", recipe: { trialCookedOn: "2026-11-12" } });
      await approve(t, changeId);
      await t.as("postgres");
      const rev = await currentRev(t, item);
      expect((await t.rows("select count(*)::int as n from public.recipe_ingredients where recipe_revision_id = $1", [rev]))[0].n).toBe(before);
      await t.as(null);
      expect(JSON.stringify(await t.q("public.recipe_detail($1, null, '{}', 'none', '{}', false, true)", [item]))).toContain("description corrected");
    });
  });
});

describe("suspension and member history (R2 test 7)", () => {
  it("a suspended member cannot post; their public content is hidden and leaves the averages; reinstating restores it", async () => {
    await tx(async (t) => {
      await t.as("postgres");
      await t.rows("insert into public.member_standing (user_id, first_public_approved_at) values ($1, now()) on conflict (user_id) do update set first_public_approved_at = now()", [ids.bad]);
      await t.as("bad");
      const r = await t.q("public.save_review('venue', $1, 1, 'Invented one-star review for a test', null, null, true)", [IDS.venueBackBay]);
      await t.q("public.set_review_audience($1, 'public')", [r.reviewId]);
      const summary = async () => {
        const all = await t.q("public.target_reviews('venue', $1, true)", [IDS.venueBackBay]);
        return { count: all.summary.count, average: all.summary.average, bodies: (all.reviews as J[]).map((x) => x.body) };
      };
      await t.as(null);
      const withReview = await summary();
      expect(withReview.bodies).toContain("Invented one-star review for a test");

      await t.as("mod");
      expect((await t.err("public.set_member_suspension($1, true, null)", [h("bad")])).message).toBe("REASON_REQUIRED");
      expect((await t.err("public.set_member_suspension($1, true, 'x reason')", [h("mod")])).message).toBe("OWN_ACCOUNT");
      expect((await t.err("public.set_member_suspension($1, true, 'x reason')", [h("cur")])).message).toBe("STAFF_ACCOUNT");
      await t.q("public.set_member_suspension($1, true, 'Repeated abusive reviews')", [h("bad")]);
      expect((await t.err("public.set_member_suspension($1, true, 'again')", [h("bad")])).message).toBe("WRONG_STATE");

      // Hidden, and out of the averages.
      for (const viewer of [null, "mem"] as const) {
        await t.as(viewer);
        const s = await summary();
        expect(s.bodies).not.toContain("Invented one-star review for a test");
        expect(s.count).toBe(withReview.count - 1);
        expect((await t.err("public.profile_view($1, 'matches', 'none', '{}', false, true)", [h("bad")])).code).toBe("PT404");
      }

      // Cannot post, follow, list or report.
      await t.as("bad");
      for (const sql of [
        "public.save_review('venue', '" + IDS.venueCentral + "', 5, 'Another', null, null, true)",
        "public.set_review_audience('" + r.reviewId + "', 'friends')",
        "public.save_list(null, 'Invented list', null)",
        "public.follow_user('demo_maya', true)",
        "public.publish_ranking()",
      ]) {
        expect([sql, (await t.err(sql)).message]).toEqual([sql, "ACCOUNT_SUSPENDED"]);
      }

      // The moderator's view: counts and decisions only.
      await t.as("mod");
      const hist = await t.q("public.member_history($1)", [h("bad")]);
      expect(hist).toMatchObject({ handle: h("bad"), suspendedReason: "Repeated abusive reviews", isStaff: false });
      expect(hist.suspendedAt).toBeTruthy();
      expect(hist.events.map((e: J) => e.action)).toEqual(["moderation.suspend"]);
      expect(hist.events[0].by).toBe("@" + h("mod"));
      expect(Object.keys(hist).sort()).toEqual(["counts", "displayName", "events", "firstPublicApprovedAt", "handle", "isDemo", "isStaff", "profileHiddenAt", "suspendedAt", "suspendedReason"]);
      expect(JSON.stringify(hist)).not.toMatch(/example\.test|diary|goal|protein/i);
      expect((await t.q("public.staff_alerts()")).suspendedMembers).toBeGreaterThanOrEqual(1);

      await t.q("public.set_member_suspension($1, false, 'Appeal accepted')", [h("bad")]);
      await t.as(null);
      expect(await summary()).toEqual(withReview);
      await t.as("bad");
      await t.q("public.save_list(null, 'Invented list', null)");
    });
  });
});

describe("staff alerts", () => {
  it("count what is waiting, per role, and never count a person's own submission as theirs to check", async () => {
    await tx(async (t) => {
      await t.as("pub");
      const base = await t.q("public.staff_alerts()");
      const changeId = await proposed(t, IDS.dosa.item, { name: "Demo dosa (alert test)" });
      await t.as("cur");
      const mine = await t.q("public.staff_alerts()");
      expect(mine.awaitingCheck).toBe(base.awaitingCheck);
      await t.as("pub");
      const theirs = await t.q("public.staff_alerts()");
      expect(theirs.awaitingCheck).toBe(base.awaitingCheck + 1);
      expect(theirs.canPublish).toBe(true);
      const desk = await t.q("public.editor_desk()");
      expect(desk.practiceMode).toBe(true);
      expect(desk.awaitingCheck.find((c: J) => c.changeId === changeId)).toMatchObject({ canReview: true, author: "@" + h("cur") });
    });
  });
});

describe("place history and closed direct writes (R2 fix-up, owner instruction 2026-11-15)", () => {
  /** A curator proposes a place change with a source; returns the change id. */
  async function placeChange(t: T, venue: string, edit: J, who = "cur") {
    await t.as(who);
    const { changeId } = await t.q("public.editor_start_venue_change($1, null)", [venue]);
    const current = (await t.q("public.editor_change($1)", [changeId])).payload;
    await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Place details checked", source: SOURCE, venue: { ...current, ...edit } })]);
    return changeId as string;
  }

  it("a published place change keeps the values before and after, who entered and checked it, the source and the time", async () => {
    await tx(async (t) => {
      const venue = IDS.venueDavis;
      await t.as("postgres");
      const was = (await t.rows("select name, street, extensions.st_y(location::extensions.geometry) as lat from public.venues where id = $1", [venue]))[0];
      // The change starts from what is published now, including the pin.
      const first = await placeChange(t, venue, { name: "Demo Davis Noodle House", street: "9 Invented Way", lat: 42.3967, lon: -71.1223, hours: "Invented hours: 11 to 9" });
      expect((await t.q("public.editor_change($1)", [first])).payload).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
      await t.q("public.editor_submit_change($1)", [first]);
      await approve(t, first);
      const second = await placeChange(t, venue, { hours: "Invented hours: 11 to 10" }, "cur2");
      await t.q("public.editor_submit_change($1)", [second]);
      await approve(t, second, "both");

      await t.as("cur");
      const all = await t.q("public.venue_history($1)", [venue]);
      expect(all.current).toMatchObject({ name: "Demo Davis Noodle House", hours: "Invented hours: 11 to 10" });
      const history = all.revisions;
      expect(history.map((r: J) => r.revisionNo)).toEqual([2, 1]);
      const [r2, r1] = history;
      expect(r1.before).toMatchObject({ name: was.name, street: was.street, hours: null });
      expect(r1.before.lat).toBeCloseTo(was.lat, 5);
      expect(r1.after).toMatchObject({ name: "Demo Davis Noodle House", street: "9 Invented Way", lat: 42.3967, lon: -71.1223, hours: "Invented hours: 11 to 9" });
      expect(r1).toMatchObject({ changeId: first, author: `@${h("cur")}`, reviewer: `@${h("pub")}`, source: { publisher: SOURCE.publisher, summary: SOURCE.summary, rightsStatus: "cleared" } });
      expect(r1.submittedAt).toBeTruthy();
      expect(r1.publishedAt).toBeTruthy();
      expect(r2.before.hours).toBe("Invented hours: 11 to 9");
      expect(r2.after.hours).toBe("Invented hours: 11 to 10");
      expect(r2).toMatchObject({ author: `@${h("cur2")}`, reviewer: `@${h("both")}` });
      // The public page shows only the latest checked hours; the older fact stays stored as evidence.
      await t.as(null);
      const page = await t.q("public.venue_detail($1, true)", [venue]);
      expect(page.facts.filter((f: J) => f.field === "hours").map((f: J) => f.value.text)).toEqual(["Invented hours: 11 to 10"]);
      await t.as("postgres");
      expect((await t.rows("select count(*)::int as n from public.venue_facts where venue_id = $1 and field = 'hours'", [venue]))[0].n).toBe(2);
    });
  });

  it("place history cannot be changed or deleted, not even by the database owner; a decided change is frozen", async () => {
    await tx(async (t) => {
      const venue = IDS.venueBackBay;
      const changeId = await placeChange(t, venue, { name: "Demo Back Bay Bowl Bar" });
      await t.q("public.editor_submit_change($1)", [changeId]);
      await approve(t, changeId);
      await t.as("postgres");
      const rev = (await t.rows("select id from public.venue_revisions where change_id = $1", [changeId]))[0].id;
      for (const sql of [
        "update public.venue_revisions set after_values = '{}'::jsonb where id = $1",
        "update public.venue_revisions set before_values = null where id = $1",
        "update public.venue_revisions set published_at = now() - interval '1 year' where id = $1",
        "update public.venue_revisions set reviewer_id = (select user_id from public.role_assignments where role = 'curator' limit 1) where id = $1",
        "delete from public.venue_revisions where id = $1",
      ]) {
        expect([sql, (await t.err(sql, [rev])).message]).toEqual([sql, "HISTORY_IS_PERMANENT"]);
      }
      for (const sql of [
        "update public.catalog_changes set summary = 'rewritten' where id = $1",
        "update public.catalog_changes set state = 'draft' where id = $1",
        "update public.catalog_changes set payload = '{}'::jsonb where id = $1",
        "update public.catalog_changes set reviewed_at = now() - interval '1 day' where id = $1",
        "delete from public.catalog_changes where id = $1",
      ]) {
        expect([sql, (await t.err(sql, [changeId])).message]).toEqual([sql, "HISTORY_IS_PERMANENT"]);
      }
      // Nobody signed in can even read the history table directly; editors read it through the checked function.
      for (const who of ["cur", "pub", "mod", "mem", null]) {
        await t.as(who);
        expect((await t.err("select * from public.venue_revisions")).code).toBe("42501");
      }
      for (const who of ["mod", "mem", null]) {
        await t.as(who);
        expect((await t.err("public.venue_history($1)", [venue])).code).toMatch(/PT403|PT401|42501/);
      }
    });
  });

  it("deleting an editor's account keeps the place history, without the person's id", async () => {
    const author = await createTestUser("r2-leaver");
    try {
      await pool.query("insert into public.profiles_public (user_id, handle, display_name) values ($1, $2, 'leaver')", [author, `r2leaver_${author.slice(0, 6)}`]);
      await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'curator')", [author]);
      let changeId = "";
      await tx(async (t) => {
        changeId = await placeChange(t, IDS.venueHarvard, { street: "1 Invented Yard" }, author);
        await t.q("public.editor_submit_change($1)", [changeId]);
        await approve(t, changeId);
        await t.as("postgres");
        await t.rows("delete from auth.users where id = $1", [author]);
        const row = (await t.rows("select author_id, reviewer_id, after_values ->> 'street' as street from public.venue_revisions where change_id = $1", [changeId]))[0];
        expect(row).toEqual({ author_id: null, reviewer_id: ids.pub, street: "1 Invented Yard" });
      });
    } finally {
      await deleteTestUsers([author]);
    }
  });

  it("a place change that nobody submitted, or that one person checks alone, is never published", async () => {
    await tx(async (t) => {
      const venue = IDS.venueAllston;
      const draft = await placeChange(t, venue, { name: "Demo Unsubmitted Name" }, "both");
      await t.as("pub");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [draft])).message).toBe("WRONG_STATE");
      await t.as("both");
      await t.q("public.editor_submit_change($1)", [draft]);
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [draft])).message).toBe("SECOND_PERSON_REQUIRED");
      await t.as("cur");
      expect((await t.err("public.editor_review_change($1, 'approve', null, true, true)", [draft])).message).toBe("FORBIDDEN");
      await t.as("pub");
      expect((await t.err("public.editor_review_change($1, 'approve', null, false, true)", [draft])).message).toBe("CHECKS_REQUIRED");
      await t.as("postgres");
      expect((await t.rows("select name from public.venues where id = $1", [venue]))[0].name).not.toBe("Demo Unsubmitted Name");
      expect(await t.rows("select 1 from public.venue_revisions where venue_id = $1", [venue])).toEqual([]);
    });
  });

  it("no one signed in can write catalog tables directly, so one person cannot bypass the check", async () => {
    await tx(async (t) => {
      const venue = IDS.venueCentral;
      await t.as("postgres");
      const rec = (await t.rows("select id from public.source_records limit 1"))[0].id;
      const attempts: string[] = [
        `insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at) values ('${venue}', 'hours', '{"text":"x"}', '${rec}', now())`,
        `update public.venue_facts set typed_value = '{"text":"x"}'`,
        `delete from public.venue_facts`,
        `update public.venues set name = 'x' where id = '${venue}'`,
        `insert into public.venues (market_id, slug, name, timezone, venue_type, status) select market_id, 'x-r2', 'x', timezone, 'cafe', 'draft' from public.venues limit 1`,
        `update public.dishes set venue_id = '${venue}' where food_item_id = '${IDS.dosa.item}'`,
        `insert into public.dish_prices (dish_id, amount_minor, checked_at, source_record_id) values ('${IDS.dosa.item}', 1, now(), '${rec}')`,
        `update public.source_records set rights_status = 'cleared'`,
        `update public.sources set publisher = 'x'`,
        `update public.corrections set state = 'accepted'`,
        `insert into public.food_revisions (food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit) values ('${IDS.dosa.item}', 99, 'x', 'serving', 1, 'serving')`,
        `update public.portions set label = 'x'`,
        `delete from public.dietary_claims`,
      ];
      for (const who of ["cur", "pub", "both"]) {
        await t.as(who);
        for (const sql of attempts) {
          expect([who, sql, (await t.err(sql)).code]).toEqual([who, sql, "42501"]);
        }
      }
    });
  });

  it("a curator cannot change someone else's submitted change, and the checker publishes exactly what was submitted", async () => {
    await tx(async (t) => {
      const changeId = await proposed(t, IDS.tofuStew.item, { reconfirm: true }, { summary: "Submitted for checking" });
      await t.as("cur2");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Changed by someone else" })])).code).toMatch(/PT403|PT409/);
      await t.as("cur");
      expect((await t.err("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Changed after sending" })])).code).toMatch(/PT403|PT409/);
      await approve(t, changeId);
      await t.as("postgres");
      expect((await t.rows("select summary from public.catalog_changes where id = $1", [changeId]))[0].summary).toBe("Submitted for checking");
    });
  });
});
