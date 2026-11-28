import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pool } from "../helpers/db";

// SCALE-2: the faster social_feed (migration 20261116000500) must give exactly the same answers as
// the previous definition. The previous definition is read from the M5 migration file and created
// as a temporary function. Invented members and posts; ONE rolled-back transaction.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function previousDefinition() {
  const src = readFileSync("supabase/migrations/20261114000400_m5_social.sql", "utf8").split("\n");
  const start = src.findIndex((l) => l.startsWith("create function public.social_feed("));
  const end = src.findIndex((l, i) => i > start && l.startsWith("$$;"));
  return src.slice(start, end + 1).join("\n").replace("create function public.social_feed(", "create function pg_temp.social_feed_before(");
}

async function member(c: PoolClient, label: string, demo = false) {
  const id = randomUUID();
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, `scale2-${label}-${id.slice(0, 8)}@example.test`],
  );
  await c.query("insert into public.profiles_public (user_id, handle, display_name) values ($1, $2, $3) on conflict (user_id) do update set handle = excluded.handle", [id, `s2_${label}_${id.slice(0, 6)}`, label]);
  await c.query("insert into public.member_standing (user_id, first_public_approved_at, is_demo) values ($1, now(), $2) on conflict (user_id) do update set is_demo = excluded.is_demo", [id, demo]);
  return id;
}

describe("SCALE-2 social feed", () => {
  it("gives exactly the same answers as before for every feed, view, diet, page and limit", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(previousDefinition());
      const viewer = await member(c, "viewer");
      const authors = [await member(c, "a"), await member(c, "b"), await member(c, "c", true)];
      const blocked = await member(c, "d");
      for (const a of [...authors, blocked]) await c.query("insert into public.follows (follower_id, followed_id) values ($1, $2)", [viewer, a]);
      await c.query("insert into public.friendships (requester_id, recipient_id, state, accepted_at) values ($1, $2, 'accepted', now())", [viewer, authors[0]]);
      await c.query("insert into public.friendships (requester_id, recipient_id, state, accepted_at) values ($1, $2, 'accepted', now())", [authors[2], viewer]);
      await c.query("insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [viewer, blocked]).catch(() => undefined);
      // Every published dish, recipe and packaged food, and every venue: vegan, unsure, excluded and hidden targets.
      const foods = (await c.query("select id from public.food_items where kind in ('dish', 'recipe', 'packaged') order by id")).rows.map((r) => r.id as string);
      const venues = (await c.query("select id from public.venues order by id limit 6")).rows.map((r) => r.id as string);
      const audiences = ["public", "friends", "public", "private"];
      let n = 0;
      for (const target of [...foods.map((f) => ["food", f]), ...venues.map((v) => ["venue", v])]) {
        const author = [...authors, blocked][n % 4];
        await c.query(
          `insert into public.reviews (author_id, venue_id, food_item_id, rating, body, audience, publication_state, published_at)
           values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8))`,
          [author, target[0] === "venue" ? target[1] : null, target[0] === "food" ? target[1] : null, (n % 5) + 1, `post ${n}`, audiences[n % 4],
           audiences[n % 4] === "private" ? "draft" : n % 9 === 0 ? "pending" : n % 11 === 0 ? "removed" : "visible", n],
        );
        n++;
      }
      expect(n).toBeGreaterThan(20);
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer, role: "authenticated" })]);
      const run = async (fn: string, a: unknown[]) => (await c.query(`select ${fn}($1, $2, $3, $4, $5, $6, $7, $8) as j`, a)).rows[0].j as J;
      let compared = 0;
      const seen = { items: 0, unsure: 0, venue: 0 };
      for (const feed of ["following", "friends"]) for (const view of ["matches", "needs_confirmation"])
        for (const [diet, ex, cond] of [["none", [], false], ["vegan", [], false], ["vegetarian", ["egg"], true], ["none", ["egg", "dairy"], false], ["vegan", ["honey"], true]] as const)
          for (const limit of [1, 3, 50]) for (const demo of [true, false]) {
            let before: string | null = null;
            for (let page = 0; page < 3; page++) {
              const args = [feed, view, diet, ex, cond, before, limit, demo];
              const now = await run("public.social_feed", args);
              expect(now, JSON.stringify(args)).toEqual(await run("pg_temp.social_feed_before", args));
              compared++;
              seen.items = Math.max(seen.items, now.items.length);
              seen.unsure = Math.max(seen.unsure, now.needsConfirmationCount);
              if (now.items.some((i: J) => i.item?.target?.kind === "venue")) seen.venue++;
              before = now.nextBefore;
              if (!before) break;
            }
          }
      expect(compared).toBeGreaterThan(120);
      // The comparison is only meaningful if the feeds were not empty: many posts, unsure posts and places.
      expect(seen.items).toBeGreaterThan(10); // more than one page at limits 1 and 3
      expect(seen.unsure).toBeGreaterThan(0);
      expect(seen.venue).toBeGreaterThan(0);
      for (const bad of [["everyone", "matches"], ["following", "sideways"]]) {
        const msg = (f: string) => c.query("savepoint s").then(() => run(f, [...bad, "none", [], false, null, 20, true]).then(() => "ok", (e) => e.message)).finally(() => c.query("rollback to savepoint s"));
        expect(await msg("public.social_feed")).toBe(await msg("pg_temp.social_feed_before"));
      }
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
  });
});
