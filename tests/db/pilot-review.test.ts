import type { PoolClient } from "pg";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { pool, clearTestHosts } from "../helpers/db";
import { createReviewServer, describeValue, loadQueue, renderPage } from "../../scripts/lib/pilot-review-lib.mjs";

// Founder review of staged facts (owner decision 23:52 UTC). Everything runs inside ONE rolled-back
// transaction, including the local review server, so no permanent staging row is left behind.
// Places and pages are invented test labels.

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
const one = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(`select ${sql} as r`, params)).rows[0].r;

async function user(c: PoolClient, roles: string[], label: string) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, email],
  );
  for (const r of roles) await c.query("insert into public.role_assignments (user_id, role) values ($1, $2)", [id, r]);
  return { id, email };
}

async function world(c: PoolClient) {
  await clearTestHosts(c);
  const researcher = await user(c, ["curator"], "researcher");
  const founder = await user(c, ["publisher"], "founder");
  const place = await one(c, "staging.add_place($1, 'Test <Cafe> & Co', 'harvard_square', 1::smallint)", [researcher.id]);
  const dish = await one(c, "staging.add_dish($1, $2, 'Lentil bowl <script>alert(1)</script>')", [researcher.id, place]);
  const own = await one(c, "staging.add_source_page($1, 'https://example.test/menu?a=1&b=2', 'restaurant_nutrition_guide', 'Test Cafe', now(), 'Facts only')", [researcher.id]);
  const evil = await one(c, "staging.add_source_page($1, 'https://example.test/\" onmouseover=\"x', 'news', 'Test News', now())", [researcher.id]);
  const today = (await c.query("select (now() at time zone 'America/New_York')::date::text as d")).rows[0].d as string;
  const submit = (p: J, by = researcher.id) => one(c, "staging.submit_fact($1, $2::jsonb)", [by, JSON.stringify({ placeId: place, sourcePageId: own, checkedOn: today, ...p })]);
  const protein = await submit({ dishId: dish, kind: "published_nutrition", value: { nutrient: "protein_g", amount: "44", per: "serving" } });
  const vegan = await submit({ dishId: dish, kind: "dietary_status", subject: "vegan", unknownReason: "The mark means 'vegetarian and vegan-friendly'" });
  const hours = await submit({ kind: "weekly_hours", value: { periods: [{ days: "Mon-Sat", open: "08:00", close: "22:00" }] }, sourcePageId: evil });
  return { researcher, founder, place, dish, protein, vegan, hours, today, submit };
}

afterAll(async () => {
  await pool.end();
});

describe("R1 the founder sees each fact with its evidence, grouped by place and dish", () => {
  it("queue groups place facts first, then dishes, with source, dates, who entered and the nutrition state", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const q = await loadQueue(c);
      const p = q.find((x: J) => x.id === w.place);
      expect(p.groups.map((g: J) => g.label)).toEqual(["The place itself", "Lentil bowl <script>alert(1)</script>"]);
      const facts = p.groups[1].facts;
      const prot = facts.find((f: J) => f.fact_id === w.protein);
      expect(prot).toMatchObject({ kind: "published_nutrition", nutrition_state: "restaurant_published", source_kind: "restaurant_nutrition_guide", entered_by_email: w.researcher.email, checked_on: expect.anything() });
      expect(describeValue(prot)).toBe("Protein 44 g per serving");
      expect(describeValue(facts.find((f: J) => f.fact_id === w.vegan))).toBe("Vegan: Unknown. The mark means 'vegetarian and vegan-friendly'");
      expect(describeValue(p.groups[0].facts[0])).toBe("Mon-Sat 08:00–22:00");
    });
  });

  it("the page escapes everything from the web, links only https sources, and shows the four nutrition states in words", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const html = renderPage(await loadQueue(c), { token: "t0k", reviewer: w.founder, flash: "<b>x</b>" });
      expect(html).not.toMatch(/<script>alert/);
      expect(html).toContain("Lentil bowl &lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("Test &lt;Cafe&gt; &amp; Co");
      expect(html).toContain('href="https://example.test/menu?a=1&amp;b=2"');
      expect(html).not.toContain('onmouseover="x'); // the unsafe URL is shown as text, never as a link attribute
      expect(html).toContain("Restaurant-published figure");
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).toContain("Restaurant&#39;s own nutrition guide");
      const waiting = Number(await one(c, "(select count(*) from staging.review_queue())"));
      expect((html.match(/<form /g) ?? []).length).toBe(waiting); // one form per fact (other staged rows may exist locally)
      expect(html).toContain("Nothing here is public; verifying a fact does not publish it.");
    });
  });

  it("a fact the reviewer entered shows no buttons, and the database still refuses it", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const both = await user(c, ["curator", "publisher"], "both");
      const mine = await w.submit({ kind: "operating_status", value: { status: "operating" } }, both.id);
      const html = renderPage(await loadQueue(c), { token: "t", reviewer: both, flash: null });
      const card = html.slice(html.indexOf(`data-fact="${mine}"`), html.indexOf("</article>", html.indexOf(`data-fact="${mine}"`)));
      expect(card).toContain("You entered this fact");
      expect(card).not.toContain("<form");
    });
  });
});

describe("R2 the local review page records decisions through the database rules", () => {
  async function serve(c: PoolClient, reviewer: { id: string; email: string }) {
    const token = "secret-token";
    const server = createReviewServer({ db: c, reviewer, token, nested: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: string, host = `127.0.0.1:${port}`) =>
      new Promise<{ status: number; location?: string; text: string; headers: J }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, text, headers: res.headers }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    return { server, call, token };
  }

  it("verify and reject work with the page's token; the history records the founder as reviewer", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const s = await serve(c, w.founder);
      try {
        const page = await s.call("GET", "/");
        expect(page.status).toBe(200);
        expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
        const waiting = Number(await one(c, "(select count(*) from staging.review_queue())"));
        expect(page.text).toContain(`${waiting} facts waiting`);
        const ok = await s.call("POST", "/decide", `token=${s.token}&fact=${w.protein}&decision=verify&note=Matches+the+PDF`);
        expect(ok.status).toBe(303);
        expect(decodeURIComponent(ok.location!)).toContain("Fact verified.");
        const no = await s.call("POST", "/decide", `token=${s.token}&fact=${w.hours}&decision=reject&note=Source+is+not+the+restaurant`);
        expect(decodeURIComponent(no.location!)).toContain("Fact rejected.");
        const rows = (await c.query("select id, status, reviewer_id, review_note from staging.facts where id = any($1::uuid[])", [[w.protein, w.hours]])).rows;
        expect(rows.find((r) => r.id === w.protein)).toMatchObject({ status: "verified", reviewer_id: w.founder.id, review_note: "Matches the PDF" });
        expect(rows.find((r) => r.id === w.hours)).toMatchObject({ status: "rejected", reviewer_id: w.founder.id });
        const ev = (await c.query("select action, actor_id from staging.events where fact_id = $1 order by id", [w.protein])).rows;
        expect(ev).toEqual([{ action: "submit_fact", actor_id: w.researcher.id }, { action: "verify_fact", actor_id: w.founder.id }]);
        expect((await s.call("GET", "/")).text).toContain(`${waiting - 2} fact${waiting - 2 === 1 ? "" : "s"} waiting`);
        // Reviewing the same fact twice is refused, with a plain message.
        const again = await s.call("POST", "/decide", `token=${s.token}&fact=${w.protein}&decision=reject`);
        expect(decodeURIComponent(again.location!)).toContain("already reviewed");
      } finally {
        s.server.close();
      }
    });
  });

  it("refuses a wrong token, a foreign Host header, an unknown decision, and the researcher reviewing their own fact", async () => {
    await tx(async (c) => {
      const w = await world(c);
      const s = await serve(c, w.founder);
      try {
        expect((await s.call("POST", "/decide", `token=wrong&fact=${w.protein}&decision=verify`)).status).toBe(403);
        expect((await s.call("GET", "/", undefined, "evil.example")).status).toBe(403);
        expect((await s.call("POST", "/decide", `token=${s.token}&fact=${w.protein}&decision=approve-all`)).status).toBe(400);
      } finally {
        s.server.close();
      }
      // A researcher who also holds the publisher role still cannot check their own entry.
      await c.query("insert into public.role_assignments (user_id, role) values ($1, 'publisher')", [w.researcher.id]);
      const r = await serve(c, w.researcher);
      try {
        const res = await r.call("POST", "/decide", `token=${r.token}&fact=${w.protein}&decision=verify`);
        expect(decodeURIComponent(res.location!)).toContain("You entered this fact");
      } finally {
        r.server.close();
      }
      expect((await c.query("select status from staging.facts where id = $1", [w.protein])).rows[0].status).toBe("submitted");
    });
  });

  it("the review queue is closed to visitors and members", async () => {
    await tx(async (c) => {
      for (const role of ["anon", "authenticated"]) {
        expect(await one(c, "has_function_privilege($1, 'staging.review_queue()', 'execute')", [role])).toBe(false);
      }
    });
  });
});

describe("R3 verifying through the review page never publishes anything", () => {
  it("public search, map, filters, catalog counts and nutrition rows are identical after the founder verifies every fact", async () => {
    await tx(async (c) => {
      const snapshot = async () => {
        const r: J = {};
        r.search = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50 })]);
        r.searchVegan = await one(c, "public.search_catalog($1::jsonb)", [JSON.stringify({ includeDemo: true, limit: 50, diet: "vegan" })]);
        r.map = await one(c, "public.search_map($1::jsonb)", [JSON.stringify({ includeDemo: true })]);
        r.filters = await one(c, "public.catalog_filter_options('boston', true)");
        r.counts = (await c.query(`select (select count(*) from public.venues)::int v, (select count(*) from public.food_items)::int f,
            (select count(*) from public.food_revisions)::int fr, (select count(*) from public.nutrient_values)::int nv,
            (select count(*) from public.dietary_claims)::int dc, (select count(*) from public.sources)::int s,
            (select count(*) from public.source_records)::int sr`)).rows[0];
        return JSON.stringify(r);
      };
      const w = await world(c);
      const before = await snapshot();
      const token = "t";
      const server = createReviewServer({ db: c, reviewer: w.founder, token, nested: true });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as AddressInfo).port;
      const post = (body: string) =>
        new Promise<number>((resolve, reject) => {
          const req = request({ host: "127.0.0.1", port, method: "POST", path: "/decide", headers: { host: `127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          });
          req.on("error", reject);
          req.end(body);
        });
      try {
        for (const f of [w.protein, w.vegan, w.hours]) expect(await post(`token=${token}&fact=${f}&decision=verify`)).toBe(303);
      } finally {
        server.close();
      }
      expect((await c.query("select count(*)::int n from staging.facts where id = any($1::uuid[]) and status = 'verified'", [[w.protein, w.vegan, w.hours]])).rows[0].n).toBe(3);
      expect(await snapshot()).toBe(before);
      // A verified "unknown" vegan fact still does not pass a strict filter, even in staging.
      expect(await one(c, "staging.passes_strict_filter($1, 'vegan')", [w.dish])).toBe(false);
    });
  });
});
