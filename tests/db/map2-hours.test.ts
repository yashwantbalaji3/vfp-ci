import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createTestUser, deleteTestUsers, pool } from "../helpers/db";
import { IDS } from "../fixtures/ids";

// MAP-2 · structured opening hours and "Open now" (plans/2026-11-15-map-2-plan.md, tests H1-H8).
// Every test runs inside ONE transaction that is rolled back, so the shared catalog is never changed.
// Moments are fixed with an explicit time (`at`), never the test machine's clock.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ids: Record<string, string> = {};

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

const SOURCE = { publisher: "Demo place (invented)", sourceType: "operator_statement", observedOn: "2026-11-10", summary: "Invented statement for a test: the place gave its opening hours." };
const SRC = "00000000-0000-4000-8000-00000000b201";
const NY = (local: string) => `${local} America/New_York`;
const status = async (t: T, venue: string, at: string) => (await t.q("app.venue_hours_status($1, $2::timestamptz)", [venue, at])) as J;
const week = (days: number[], opens: string, closes: string, closesNextDay = false) => days.map((day) => ({ day, opens, closes, closesNextDay }));
/** Publishes hours directly (as the database owner) for edge cases; the editor path is tested in H7. */
const publish = (t: T, venue: string, hours: J) => t.q("app.publish_hours($1, $2::jsonb, $3, null, null, null)", [venue, JSON.stringify(hours), SRC]);
const ALL = [0, 1, 2, 3, 4, 5, 6];

beforeAll(async () => {
  for (const name of ["cur", "pub", "mem"]) ids[name] = await createTestUser(`map2-${name}`);
  await pool.query("insert into public.role_assignments (user_id, role) values ($1, 'curator'), ($2, 'publisher')", [ids.cur, ids.pub]);
});
afterAll(async () => {
  await deleteTestUsers(Object.values(ids));
  await pool.end();
});

describe("H1 status across a day", () => {
  it("lunch and dinner with a gap: closed before, open, closed between, open, closed after; closed all Monday", async () => {
    await tx(async (t) => {
      // Demo Harvard Tofu House (seed): 11:30-14:30 and 17:00-22:00, every day except Monday.
      const v = IDS.venueHarvard;
      expect(await status(t, v, NY("2026-11-17 11:29"))).toMatchObject({ state: "closed", opensAt: "2026-11-17T16:30:00+00:00" });
      expect(await status(t, v, NY("2026-11-17 11:30"))).toMatchObject({ state: "open", closesAt: "2026-11-17T19:30:00+00:00" });
      expect(await status(t, v, NY("2026-11-17 14:30"))).toMatchObject({ state: "closed", opensAt: "2026-11-17T22:00:00+00:00" });
      expect(await status(t, v, NY("2026-11-17 21:59"))).toMatchObject({ state: "open", closesAt: "2026-11-18T03:00:00+00:00" });
      expect(await status(t, v, NY("2026-11-17 22:00"))).toMatchObject({ state: "closed", opensAt: "2026-11-18T16:30:00+00:00" });
      // Sunday night: closed, and Monday has no periods, so the next opening is Tuesday.
      expect(await status(t, v, NY("2026-11-22 23:00"))).toMatchObject({ state: "closed", opensAt: "2026-11-24T16:30:00+00:00" });
    });
  });
});

describe("H2 periods past midnight and 24-hour days", () => {
  it("6 PM-2 AM is open at 1 AM the next day and closed at 2 AM; 24-hour days run together", async () => {
    await tx(async (t) => {
      // Demo Davis Noodle Bar (seed): 17:00-02:00 every day.
      const v = IDS.venueDavis;
      expect(await status(t, v, NY("2026-11-18 01:00"))).toMatchObject({ state: "open", closesAt: "2026-11-18T07:00:00+00:00" });
      expect(await status(t, v, NY("2026-11-18 02:00"))).toMatchObject({ state: "closed", opensAt: "2026-11-18T22:00:00+00:00" });
      await publish(t, v, { weekly: [...week([1], "17:00", "00:00", true), ...week([2, 3], "00:00", "00:00", true)] });
      // Monday 17:00 runs straight through Tuesday and Wednesday: it closes at the start of Thursday.
      expect(await status(t, v, NY("2026-11-16 23:00"))).toMatchObject({ state: "open", closesAt: "2026-11-19T05:00:00+00:00" });
      await publish(t, v, { weekly: week(ALL, "00:00", "00:00", true) });
      expect(await status(t, v, NY("2026-11-16 03:00"))).toMatchObject({ state: "open", open24h: true, closesAt: null });
    });
  });
});

describe("H3 clock-change days in America/New_York", () => {
  it("opening times stay local on the spring and autumn change days, including a period across the change", async () => {
    await tx(async (t) => {
      const v = IDS.venueDavis;
      // These dates are months away; switch the expiry off here so only the clock change is tested.
      await t.rows("update app.freshness_rules set expire_days = null where subject = 'hours'");
      await publish(t, v, { weekly: [...week([0], "09:00", "17:00"), ...week([6], "22:00", "03:00", true)] });
      // Spring: Sunday 14 March 2027, clocks go from 2 AM to 3 AM (UTC-4 afterwards).
      expect(await status(t, v, "2027-03-14T12:59:00Z")).toMatchObject({ state: "closed", opensAt: "2027-03-14T13:00:00+00:00" });
      expect(await status(t, v, "2027-03-14T13:00:00Z")).toMatchObject({ state: "open", closesAt: "2027-03-14T21:00:00+00:00" });
      // Saturday 22:00 (UTC-5) to Sunday 03:00 (UTC-4): one hour shorter, closes at 07:00 UTC.
      expect(await status(t, v, "2027-03-14T06:30:00Z")).toMatchObject({ state: "open", closesAt: "2027-03-14T07:00:00+00:00" });
      // Autumn: Sunday 7 November 2027, clocks go from 2 AM back to 1 AM (UTC-5 afterwards).
      expect(await status(t, v, "2027-11-07T13:59:00Z")).toMatchObject({ state: "closed", opensAt: "2027-11-07T14:00:00+00:00" });
      expect(await status(t, v, "2027-11-07T14:00:00Z")).toMatchObject({ state: "open", closesAt: "2027-11-07T22:00:00+00:00" });
      expect(await status(t, v, "2027-11-07T07:30:00Z")).toMatchObject({ state: "open", closesAt: "2027-11-07T08:00:00+00:00" });
    });
  });
});

describe("H4 dated exceptions", () => {
  it("a holiday closure and special hours beat the weekly hours on their date only; a temporary closure says until when", async () => {
    await tx(async (t) => {
      // Demo Back Bay Garden Cafe (seed): 07:00-15:00 daily; closed 26 Nov; 07:00-12:00 on 24 Dec.
      const v = IDS.venueBackBay;
      expect(await status(t, v, NY("2026-11-26 10:00"))).toMatchObject({ state: "closed", opensAt: "2026-11-27T12:00:00+00:00" });
      expect(await status(t, v, NY("2026-11-25 10:00"))).toMatchObject({ state: "open" });
      expect(await status(t, v, NY("2026-11-27 10:00"))).toMatchObject({ state: "open" });
      expect(await status(t, v, NY("2026-12-24 11:00"))).toMatchObject({ state: "open", closesAt: "2026-12-24T17:00:00+00:00" });
      expect(await status(t, v, NY("2026-12-24 13:00"))).toMatchObject({ state: "closed" });
      await publish(t, v, { weekly: week(ALL, "07:00", "15:00"), exceptions: [{ startsOn: "2026-12-01", endsOn: "2026-12-10", kind: "temporary_closure", reason: "Renovation (demo)" }] });
      expect(await status(t, v, NY("2026-12-05 10:00"))).toMatchObject({ state: "temporarily_closed", until: "2026-12-10", note: "Renovation (demo)", opensAt: "2026-12-11T12:00:00+00:00" });
      expect(await status(t, v, NY("2026-12-11 10:00"))).toMatchObject({ state: "open" });
    });
  });

  it("a place marked temporarily closed is never open, whatever its hours", async () => {
    await tx(async (t) => {
      await t.rows("update public.venues set status = 'temporarily_closed' where id = $1", [IDS.venueCentral]);
      expect(await status(t, IDS.venueCentral, NY("2026-11-17 12:00"))).toMatchObject({ state: "temporarily_closed" });
    });
  });
});

describe("H5 unchecked and out-of-date hours are never open", () => {
  it("no checked hours: needs confirmation; after 60 days: needs confirmation with the last check kept; the setting decides", async () => {
    await tx(async (t) => {
      expect(await status(t, IDS.venueAllston, NY("2026-11-17 12:00"))).toEqual({ state: "needs_confirmation", reason: "unchecked", timezone: "America/New_York" });
      const set = (await t.rows("select checked_at from public.venue_hours_sets where venue_id = $1 and state = 'published'", [IDS.venueCentral]))[0];
      const checked = new Date(set.checked_at).getTime();
      const day = 86_400_000;
      // Pick a moment the place is open by its weekly hours (noon, New York) just before and just after 60 days.
      const noonAfter = (ms: number) => {
        const d = new Date(ms);
        return NY(`${d.toISOString().slice(0, 10)} 12:00`);
      };
      const before = noonAfter(checked + 59 * day);
      const after = noonAfter(checked + 61 * day);
      expect(await status(t, IDS.venueCentral, before)).toMatchObject({ state: "open" });
      expect(await status(t, IDS.venueCentral, after)).toMatchObject({ state: "needs_confirmation", reason: "out_of_date" });
      expect((await status(t, IDS.venueCentral, after)).checkedAt).toBeTruthy();
      // Exactly at the threshold it is already out of date.
      const edge = (await t.rows("select (checked_at + interval '60 days')::text as e from public.venue_hours_sets where venue_id = $1 and state = 'published'", [IDS.venueCentral]))[0].e;
      expect(await status(t, IDS.venueCentral, edge)).toMatchObject({ state: "needs_confirmation", reason: "out_of_date" });
      // The threshold is a setting, not a constant.
      await t.rows("update app.freshness_rules set expire_days = 90 where subject = 'hours'");
      expect(await status(t, IDS.venueCentral, after)).toMatchObject({ state: "open" });
    });
  });

  it("Open now leaves out places whose hours need confirmation, and counts them exactly", async () => {
    await tx(async (t) => {
      const at = NY("2026-11-17 12:00"); // Tuesday noon: Central, Back Bay and Harvard open; Davis closed; Allston unchecked.
      const items = (await t.q("public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50, openNow: true, at })])).items as J[];
      const venues = new Set(items.map((i) => i.venue?.id));
      expect(items.every((i) => i.kind === "dish")).toBe(true);
      expect([...venues].sort()).toEqual([IDS.venueCentral, IDS.venueBackBay, IDS.venueHarvard].sort());
      const left = await t.q("public.open_now_left_out($1::jsonb)", [JSON.stringify({ includeDemo: true, at })]);
      expect(left).toEqual({ placesNeedConfirmation: 1, placesClosed: 1 });
      // Out of date: 90 days later nothing counts as open.
      const late = new Date(Date.now() + 90 * 86_400_000).toISOString();
      const none = (await t.q("public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50, openNow: true, at: late })])).items as J[];
      expect(none).toEqual([]);
    });
  });
});

describe("H6 List and Map agree with Open now, across dietary filters", () => {
  it("the same places for every diet, exclusion and view", async () => {
    await tx(async (t) => {
      for (const at of [NY("2026-11-17 12:00"), NY("2026-11-18 01:00"), NY("2026-11-16 09:00")]) {
        for (const [diet, exclusions] of [["none", []], ["vegetarian", ["egg"]], ["vegan", []], ["vegetarian", []]] as [string, string[]][]) {
          for (const view of ["matches", "needs_confirmation"]) {
            const p = { includeDemo: true, openNow: true, at, diet, exclusions, view };
            const list = (await t.q("public.search_catalog($1::jsonb)", [JSON.stringify({ ...p, limit: 50, kinds: ["dish"] })])).items as J[];
            const map = (await t.q("public.search_map($1::jsonb)", [JSON.stringify(p)])).places as J[];
            const listVenues = [...new Set(list.map((i) => i.venue.id))].sort();
            expect(map.map((pl) => pl.id).sort(), `${at} ${diet} ${exclusions} ${view}`).toEqual(listVenues);
            for (const pl of map) expect((await status(t, pl.id, at)).state).toBe("open");
            if (exclusions.includes("egg")) {
              for (const i of list) expect(i.eligibility.status).not.toBe("excluded");
            }
          }
        }
      }
    });
  });
});

describe("H5b Closes soon (MAP2-B): 30 minutes or less before the verified closing time", () => {
  it("follows ordinary, overnight, special-hours and clock-change closings, and never appears unless open", async () => {
    await tx(async (t) => {
      const soon = async (venue: string, at: string) => {
        const st = await status(t, venue, at);
        return st.state === "open" ? Boolean(st.closesSoon) : `not open (${st.state})`;
      };
      // 11 AM-10 PM: 31 minutes before is not soon; 30 minutes and less is; 10 PM is closed.
      await publish(t, IDS.venueCentral, { weekly: week(ALL, "11:00", "22:00"), exceptions: [{ startsOn: "2026-11-20", endsOn: "2026-11-20", kind: "special_hours", opens: "08:00", closes: "12:00" }, { startsOn: "2026-11-26", endsOn: "2026-11-26", kind: "closed", reason: "Holiday (test)" }] });
      expect(await soon(IDS.venueCentral, NY("2026-11-17 21:29"))).toBe(false);
      expect(await soon(IDS.venueCentral, NY("2026-11-17 21:30"))).toBe(true);
      expect(await soon(IDS.venueCentral, NY("2026-11-17 21:59"))).toBe(true);
      expect(await soon(IDS.venueCentral, NY("2026-11-17 22:00"))).toBe("not open (closed)");
      expect((await status(t, IDS.venueCentral, NY("2026-11-17 21:45"))).closesAt).toBe("2026-11-18T03:00:00+00:00");
      // Special hours close at noon that day, so "soon" comes at 11:30, not 9:30 PM; a holiday is simply closed.
      expect(await soon(IDS.venueCentral, NY("2026-11-20 11:29"))).toBe(false);
      expect(await soon(IDS.venueCentral, NY("2026-11-20 11:40"))).toBe(true);
      expect(await soon(IDS.venueCentral, NY("2026-11-26 21:45"))).toBe("not open (closed)");
      // 6 PM-2 AM: soon at 1:30 AM the next day.
      await publish(t, IDS.venueDavis, { weekly: week(ALL, "18:00", "02:00", true) });
      expect(await soon(IDS.venueDavis, NY("2026-11-18 01:29"))).toBe(false);
      expect(await soon(IDS.venueDavis, NY("2026-11-18 01:31"))).toBe(true);
      // Clock change (1 November 2026, 2 AM EDT becomes 1 AM EST): 1:45 AM happens twice. The first
      // time, 2 AM is 75 minutes away (not soon); the second time, 15 minutes away (soon).
      expect(await soon(IDS.venueDavis, "2026-11-01T05:45:00Z")).toBe(false);
      expect(await soon(IDS.venueDavis, "2026-11-01T06:45:00Z")).toBe(true);
      // Open 24 hours never closes soon.
      await publish(t, IDS.venueHarvard, { weekly: week(ALL, "00:00", "00:00", true) });
      expect(await soon(IDS.venueHarvard, NY("2026-11-17 23:50"))).toBe(false);
      // A temporary closure, unchecked or out-of-date hours: never open, so never "closes soon".
      await publish(t, IDS.venueBackBay, { weekly: week(ALL, "07:00", "15:00"), exceptions: [{ startsOn: "2026-11-17", endsOn: "2026-11-19", kind: "temporary_closure", reason: "Repairs (test)" }] });
      expect(await soon(IDS.venueBackBay, NY("2026-11-18 14:45"))).toBe("not open (temporarily_closed)");
      expect(await soon(IDS.venueAllston, NY("2026-11-18 14:45"))).toBe("not open (needs_confirmation)");
      expect(await soon(IDS.venueDavis, new Date(Date.now() + 90 * 86_400_000).toISOString())).toBe("not open (needs_confirmation)");
    });
  });
});

describe("H6b the fast Open now lookup agrees with the one status rule", () => {
  it("app.open_venue_ids returns exactly the places app.venue_hours_status calls open, at many moments, including edge cases", async () => {
    await tx(async (t) => {
      // Edge cases on the demo places: past midnight, 24 hours, a holiday, special hours, a temporary closure.
      await publish(t, IDS.venueCentral, { weekly: week(ALL, "18:00", "02:00", true) });
      await publish(t, IDS.venueHarvard, { weekly: week(ALL, "00:00", "00:00", true), exceptions: [{ startsOn: "2026-11-26", endsOn: "2026-11-26", kind: "closed", reason: "Holiday (test)" }] });
      await publish(t, IDS.venueDavis, { weekly: week([1, 2, 3, 4, 5], "11:00", "15:00"), exceptions: [{ startsOn: "2026-11-21", endsOn: "2026-11-21", kind: "special_hours", opens: "20:00", closes: "01:00", closesNextDay: true }, { startsOn: "2026-12-01", endsOn: "2026-12-05", kind: "temporary_closure", reason: "Renovation (test)" }] });
      const market = (await t.rows("select id from public.markets where slug = 'boston'"))[0].id;
      const moments: string[] = [];
      for (const day of ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-26", "2026-11-27", "2026-12-02", "2026-03-08", "2026-11-01"]) {
        for (const time of ["00:30", "01:59", "02:00", "10:59", "11:00", "14:59", "15:00", "18:00", "20:00", "23:59"]) moments.push(NY(`${day} ${time}`));
      }
      moments.push(new Date(Date.now() + 90 * 86_400_000).toISOString()); // everything out of date
      for (const at of moments) {
        const fast = ((await t.q("app.open_venue_ids($1::uuid, $2::timestamptz)", [market, at])) as string[]).sort();
        const rule = (await t.rows("select v.id from public.venues v where v.market_id = $1 and v.status = 'published' and app.venue_hours_status(v.id, $2::timestamptz) ->> 'state' = 'open' order by 1", [market, at])).map((r) => r.id as string).sort();
        expect(fast, at).toEqual(rule);
      }
    });
  });
});

describe("H7 hours change only through two people, with history", () => {
  it("an editor saves hours on a place change; the author cannot approve; a publisher approves; history keeps before and after", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_start_venue_change($1, null)", [IDS.venueAllston]);
      await t.q("public.editor_save_change($1, $2::jsonb)", [changeId, JSON.stringify({ summary: "Hours from the place", source: SOURCE })]);
      expect((await t.err("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: week([2], "14:00", "11:00") })])).message).toBe("CLOSES_BEFORE_OPENS");
      expect((await t.err("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: [] })])).message).toBe("HOURS_EMPTY");
      expect((await t.err("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: [...week([2], "11:00", "15:00"), ...week([2], "14:00", "18:00")] })])).message).toBe("PERIODS_OVERLAP");
      await t.q("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: week(ALL, "08:00", "20:00") })]);
      // Saving publishes nothing.
      await t.as("postgres");
      expect(await status(t, IDS.venueAllston, NY("2026-11-17 12:00"))).toMatchObject({ state: "needs_confirmation" });
      await t.as("cur");
      await t.q("public.editor_submit_change($1)", [changeId]);
      expect((await t.err("public.editor_review_change($1, 'approve', 'mine', true, true)", [changeId])).message).toBe("FORBIDDEN");
      await t.as("pub");
      await t.q("public.editor_review_change($1, 'approve', 'Checked with the place', true, true)", [changeId]);
      await t.as("postgres");
      expect(await status(t, IDS.venueAllston, NY("2026-11-17 12:00"))).toMatchObject({ state: "open" });
      const sets = await t.rows("select author_id, reviewer_id, change_id from public.venue_hours_sets where venue_id = $1", [IDS.venueAllston]);
      expect(sets).toEqual([{ author_id: ids.cur, reviewer_id: ids.pub, change_id: changeId }]);
      const rev = (await t.rows("select before_values, after_values from public.venue_revisions where change_id = $1", [changeId]))[0];
      expect(rev.before_values.structuredHours).toBeNull();
      expect(rev.after_values.structuredHours.weekly).toHaveLength(7);

      // A second change replaces the hours; the first set is kept as "replaced".
      await t.as("cur");
      const second = (await t.q("public.editor_start_venue_change($1, null)", [IDS.venueAllston])).changeId;
      await t.q("public.editor_save_change($1, $2::jsonb)", [second, JSON.stringify({ summary: "Shorter hours", source: SOURCE })]);
      await t.q("public.editor_save_hours($1, $2::jsonb)", [second, JSON.stringify({ weekly: week(ALL, "10:00", "18:00") })]);
      await t.q("public.editor_submit_change($1)", [second]);
      await t.as("pub");
      await t.q("public.editor_review_change($1, 'approve', 'Checked again', true, true)", [second]);
      await t.as("postgres");
      expect((await t.rows("select state from public.venue_hours_sets where venue_id = $1 order by published_at", [IDS.venueAllston])).map((r) => r.state)).toEqual(["replaced", "published"]);
      const rev2 = (await t.rows("select before_values, after_values from public.venue_revisions where change_id = $1", [second]))[0];
      expect(rev2.before_values.structuredHours.weekly[0]).toMatchObject({ opens: "08:00", closes: "20:00" });
      expect(rev2.after_values.structuredHours.weekly[0]).toMatchObject({ opens: "10:00", closes: "18:00" });
    });
  });

  it("only catalog editors can save hours, only the author's draft, and nothing changes hours outside the workflow", async () => {
    await tx(async (t) => {
      await t.as("cur");
      const { changeId } = await t.q("public.editor_start_venue_change($1, null)", [IDS.venueAllston]);
      await t.as("mem");
      expect((await t.err("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: week(ALL, "08:00", "20:00") })])).message).toBe("FORBIDDEN");
      await t.as(null);
      expect((await t.err("public.editor_save_hours($1, $2::jsonb)", [changeId, JSON.stringify({ weekly: week(ALL, "08:00", "20:00") })])).code).toBe("42501");
      await t.as("postgres");
      // Published hours are permanent: no edit, no delete, no extra rows.
      const set = (await t.rows("select id from public.venue_hours_sets where venue_id = $1 and state = 'published'", [IDS.venueCentral]))[0].id;
      expect((await t.err("update public.venue_hours_intervals set opens = '06:00' where set_id = $1", [set])).message).toBe("HOURS_ARE_PERMANENT");
      expect((await t.err("delete from public.venue_hours_intervals where set_id = $1", [set])).message).toBe("HOURS_ARE_PERMANENT");
      expect((await t.err("insert into public.venue_hours_intervals (set_id, day_of_week, opens, closes) values ($1, 1, '05:00', '06:00')", [set])).message).toBe("HOURS_ARE_PERMANENT");
      expect((await t.err("update public.venue_hours_sets set checked_at = now() where id = $1", [set])).message).toBe("HOURS_ARE_PERMANENT");
      expect((await t.err("delete from public.venue_hours_sets where id = $1", [set])).message).toBe("HOURS_ARE_PERMANENT");
    });
  });
});

describe("H8 readers see published hours only through the reading functions", () => {
  it("guests and members cannot read or write the hours tables; they can read a published place's hours, without who checked them", async () => {
    await tx(async (t) => {
      for (const who of [null, "mem"]) {
        await t.as(who);
        for (const table of ["venue_hours_sets", "venue_hours_intervals", "venue_hours_exceptions"]) {
          expect((await t.err(`select * from public.${table}`)).code).toBe("42501");
        }
        expect((await t.err("app.venue_hours_status($1, now())", [IDS.venueCentral])).code).toBe("42501");
        const h = await t.q("public.venue_hours($1, true)", [IDS.venueBackBay]);
        expect(h.hours.weekly).toHaveLength(7);
        expect(JSON.stringify(h)).not.toMatch(/author|reviewer|checkedBy/);
        expect(h.source).toBeTruthy();
        expect(h.freshness.state).toBe("current");
        expect((await t.err("public.venue_hours($1, false)", [IDS.venueBackBay])).message).toBe("VENUE_NOT_FOUND");
        const many = await t.q("public.venue_hours_statuses($1::uuid[], true)", [[IDS.venueAllston, IDS.venueCentral]]);
        expect(Object.keys(many).sort()).toEqual([IDS.venueAllston, IDS.venueCentral].sort());
      }
    });
  });
});
