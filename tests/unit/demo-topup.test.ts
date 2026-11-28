import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * supabase/demo-topup.sql brings an older LOCAL database up to the current demo data without a
 * reset (docs/22 section 3). These checks keep it in step with supabase/seed.sql and make sure
 * it can only ever add rows.
 */
const sql = readFileSync("supabase/demo-topup.sql", "utf8");
const statements = sql.split("\n").filter((l) => !l.startsWith("--") && !l.startsWith("INSERT INTO pg_temp."));

describe("demo top-up file", () => {
  it("was generated from the current seed.sql (run scripts/make-demo-topup.mjs after changing the seed)", () => {
    const seed = createHash("sha256").update(readFileSync("supabase/seed.sql")).digest("hex");
    expect(sql).toContain(`-- seed.sql sha256: ${seed}`);
  });

  it("runs in one transaction", () => {
    expect(statements.filter((l) => l === "begin;")).toHaveLength(1);
    expect(statements.at(-2)).toBe("commit;");
  });

  it("never deletes, truncates or drops anything", () => {
    expect(sql).not.toMatch(/\b(delete\s+from|truncate|drop\s+(table|schema|function|database)|alter\s+table|disable\s+trigger)\b/i);
  });

  it("changes existing rows only where documented: the rows it just added, and the local demo switch", () => {
    const updates = statements.filter((l) => /^\s*update\b/i.test(l) || /execute format\('update/i.test(l));
    expect(updates).toHaveLength(5);
    expect(updates.some((l) => l.includes("update pg_temp.%I"))).toBe(true); // staged copies only
    expect(updates.filter((l) => /^update public\.food_(revisions|items) f .* in \(select id from new_(revisions|items)\);$/.test(l))).toHaveLength(2);
    // Opening hours it just added are sealed once their rows are in, as app.publish_hours does.
    expect(updates.filter((l) => l === "update public.venue_hours_sets set sealed = true where id in (select id from new_hour_sets);")).toHaveLength(1);
    expect(updates.filter((l) => l.startsWith("update app.platform_switches set enabled = true, updated_at = now() where name = 'social_public'"))).toHaveLength(1);
  });

  it("every write to a real table is an insert that skips rows already there", () => {
    const writes = statements.filter((l) => /insert into (public|app|auth)\./i.test(l));
    expect(writes.length).toBe(37);
    for (const w of writes) expect(w).toMatch(/on conflict (\([a-z_, ]+\) )?do nothing returning 1\)/);
  });

  it("contains only synthetic demo content", () => {
    const venues = sql.split("\n").filter((l) => l.startsWith("INSERT INTO pg_temp.ref_public_venues "));
    expect(venues.length).toBeGreaterThan(0);
    for (const v of venues) expect(v).toMatch(/'Demo /);
    for (const u of sql.split("\n").filter((l) => l.startsWith("INSERT INTO pg_temp.ref_auth_users "))) expect(u).toContain("@example.invalid");
  });
});
