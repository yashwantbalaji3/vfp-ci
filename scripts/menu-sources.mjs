// Menu pipeline, step 1 (docs/41): find each real place's official website and check whether we
// may read it. LOCAL ONLY. It reads robots.txt files and nothing else: no menu page is fetched,
// no fact is stored, nothing is published.
//
//   node scripts/menu-sources.mjs discover [--tier preview|all] [--allowlist file]   websites from the catalog's public records
//                                     (with an approved allowlist, also each listed chain's brand sites)
//   node scripts/menu-sources.mjs check [--limit 50] [--host h | --allowlist file] [--recheck-days 30]   robots.txt for unchecked sources
//   node scripts/menu-sources.mjs permission <host> --status permits|prohibits|unclear|unreadable --evidence "..." --reviewer "..." [--kind terms_review|written_permission|licence|api_terms] [--url u] [--uses "..."]
//   node scripts/menu-sources.mjs permissions-load scripts/menu-access-registry.json   reviewed registry entries
//   node scripts/menu-sources.mjs remove <host> --reason "..." --authority "..."   delete saved content we may not keep (audit kept)
//
// Automated reading needs BOTH an allowing robots.txt and a current "permits" entry (fail closed).
//   node scripts/menu-sources.mjs report [--out file.md]
//
// A site that cannot be reached, or whose robots.txt cannot be read, counts as not allowed and is
// simply skipped: one blocked site never stops the others.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { MAX_ROBOTS_BYTES, PIPELINE_USER_AGENT, decide, excludedBy, normaliseWebsite } from "./lib/robots.mjs";

/**
 * Record every catalog place's website as a menu source. Re-running adds only what is new.
 * @param {import("pg").ClientBase} client
 * @param {{ tier?: "preview" | "all" }} [options]
 */
export async function discover(client, { tier = "preview" } = {}) {
  const excluded = (await client.query("select host from menu_ingest.excluded_hosts")).rows.map((r) => r.host);
  const rows = (await client.query(`
    select distinct c.id candidate_id, r.website
      from catalog_import.place_candidates c
      join catalog_import.candidate_links l on l.candidate_id = c.id
      join catalog_import.source_records r on r.id = l.record_id
     where c.quality <> 'rejected' and r.present and coalesce(r.website, '') <> ''
       and ($1 = 'all' or c.preview_tier = 'preview')
     order by c.id, r.website`, [tier])).rows;
  const byHost = new Map();
  let unusable = 0;
  for (const r of rows) {
    const w = normaliseWebsite(r.website);
    if (!w) { unusable++; continue; }
    const h = byHost.get(w.host) ?? { host: w.host, urls: new Map(), places: new Map() };
    h.urls.set(w.url, (h.urls.get(w.url) ?? 0) + 1);
    if (!h.places.has(r.candidate_id)) h.places.set(r.candidate_id, w.url);
    byHost.set(w.host, h);
  }
  let newSources = 0, newLinks = 0, excludedCount = 0;
  for (const h of [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host))) {
    const scope = h.places.size > 1 ? "brand" : "location";
    const start = scope === "brand" ? `https://${h.host}/` : [...h.urls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const ex = excludedBy(h.host, excluded);
    if (ex) excludedCount++;
    const s = (await client.query(`
      insert into menu_ingest.sources (host, start_url, scope, excluded_by) values ($1, $2, $3, $4)
      on conflict (host) do update set last_seen = now(), excluded_by = excluded.excluded_by,
        scope = case when menu_ingest.sources.scope = 'brand' then 'brand' else excluded.scope end,
        start_url = case when excluded.scope = 'brand' then excluded.start_url else menu_ingest.sources.start_url end
      returning id, (xmax = 0) inserted`, [h.host, start, scope, ex])).rows[0];
    if (s.inserted) newSources++;
    for (const [candidate, website] of h.places) {
      const r = await client.query("insert into menu_ingest.source_places (source_id, candidate_id, website) values ($1, $2, $3) on conflict do nothing", [s.id, candidate, website]);
      newLinks += r.rowCount;
    }
  }
  return { websites: rows.length, unusable, hosts: byHost.size, excluded: excludedCount, newSources, newLinks };
}

/**
 * A chain's catalog places often name a location page ("locations.chipotle.com") while the menu lives
 * on the brand site ("chipotle.com"). For each chain on an approved allowlist, every listed site that
 * is not a source yet becomes a brand source tied to the same places as that chain's other sources.
 * Only hosts on the approved list are added, and only for chains with at least one catalog place.
 */
export async function seedAllowlistSources(client, allowlist) {
  if (allowlist?.approved !== true) throw new Error("That allowlist is not approved.");
  const site = (h) => String(h).toLowerCase().replace(/^www\./, "");
  const excluded = (await client.query("select host from menu_ingest.excluded_hosts")).rows.map((r) => r.host);
  const out = [];
  for (const c of allowlist.chains) {
    const sites = [...new Set(c.hosts.map(site))];
    const places = (await client.query(`select distinct p.candidate_id, p.website from menu_ingest.source_places p join menu_ingest.sources s on s.id = p.source_id
                                         where s.host = any($1) order by p.candidate_id`, [sites])).rows;
    if (!places.length) { out.push({ chain: c.chain, added: [], places: 0 }); continue; }
    const have = new Set((await client.query("select host from menu_ingest.sources where host = any($1)", [sites])).rows.map((r) => r.host));
    const added = [];
    for (const h of sites.filter((x) => !have.has(x) && !excludedBy(x, excluded))) {
      const id = (await client.query("insert into menu_ingest.sources (host, start_url, scope) values ($1, $2, 'brand') on conflict (host) do nothing returning id", [h, `https://${h}/`])).rows[0]?.id;
      if (!id) continue;
      for (const p of places) await client.query("insert into menu_ingest.source_places (source_id, candidate_id, website) values ($1, $2, $3) on conflict do nothing", [id, p.candidate_id, p.website]);
      added.push(h);
    }
    out.push({ chain: c.chain, added, places: places.length });
  }
  return out;
}

/** Fetch robots.txt with a time limit, a size limit and our user agent. Never throws. */
export async function fetchRobots(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": PIPELINE_USER_AGENT, accept: "text/plain,*/*;q=0.5" }, signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_ROBOTS_BYTES);
    return { status: res.status, text: buf.toString("utf8") };
  } catch (e) {
    return { status: null, text: null, error: /** @type {Error} */ (e).message?.slice(0, 200) ?? "fetch failed" };
  }
}

/**
 * Turn a robots.txt response into a decision (RFC 9309, read conservatively).
 * 2xx: follow the rules. 404/410 and other "not found" answers: no rules, allowed.
 * 401/403/429, 5xx and network failures: not allowed (unreachable).
 */
export function decisionFor(res, path) {
  if (res.status == null) return { decision: "unreachable", rule: null, note: `No answer: ${res.error ?? "network error"}`, crawlDelay: null };
  if (res.status >= 200 && res.status < 300) {
    const d = decide(res.text ?? "", path);
    return { decision: d.allowed ? "allowed" : "disallowed", rule: d.rule, note: d.crawlDelay != null ? `Crawl-delay ${d.crawlDelay}s` : null, crawlDelay: d.crawlDelay };
  }
  if ([401, 403, 429].includes(res.status) || res.status >= 500) return { decision: "unreachable", rule: null, note: `robots.txt answered ${res.status}`, crawlDelay: null };
  if (res.status >= 400) return { decision: "allowed", rule: null, note: `No robots.txt (${res.status}); no rules apply`, crawlDelay: null };
  return { decision: "unreachable", rule: null, note: `Unexpected answer ${res.status}`, crawlDelay: null };
}

/**
 * Check robots.txt for sources that have not been checked (or not recently). Each source is
 * independent: a failure is recorded as "unreachable" and the run goes on.
 * @param {import("pg").ClientBase} client
 * @param {{ limit?: number, hosts?: string[], recheckDays?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function checkAccess(client, { limit = 50, hosts, recheckDays = 30, fetchImpl = fetch } = {}) {
  const due = (await client.query(`
    select id, host, start_url from menu_ingest.source_status
     where excluded_by is null and ($1::text[] is null or host = any($1))
       and (checked_at is null or checked_at < now() - make_interval(days => $2))
     order by places desc, host limit $3`, [hosts ?? null, recheckDays, limit])).rows;
  const out = [];
  for (const s of due) {
    const u = new URL(s.start_url);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const path = (u.pathname || "/") + (u.search || "");
    const res = await fetchRobots(robotsUrl, { fetchImpl });
    const d = decisionFor(res, path);
    const sha = res.text != null ? createHash("sha256").update(res.text).digest("hex") : null;
    await client.query(`insert into menu_ingest.access_checks (source_id, robots_url, http_status, robots_sha256, robots_text, user_agent, path_checked, decision, rule, note)
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [s.id, robotsUrl, res.status, sha, res.status != null && res.status < 300 ? res.text : null, PIPELINE_USER_AGENT, path.slice(0, 500), d.decision, d.rule?.slice(0, 500) ?? null, d.note?.slice(0, 500) ?? null]);
    out.push({ host: s.host, decision: d.decision, rule: d.rule, note: d.note });
  }
  return out;
}

export const PERMISSION_KINDS = ["terms_review", "written_permission", "licence", "api_terms", "owner_decision"];
export const PERMISSION_STATUSES = ["permits", "prohibits", "unclear", "unreadable", "private_pilot"];

/**
 * Record one entry in the source-access registry: a reading of a site's terms of use, a written
 * permission, a licence or API terms. "permits" needs the permitted uses spelled out. The latest
 * entry for a source decides; anything but "permits" stops automated reading (fail closed).
 * @param {import("pg").ClientBase} client
 * @param {{ host: string, kind?: string, status: string, url?: string | null, evidence: string, uses?: string | null,
 *           reviewer: string, reviewedAt?: string | null, expiresAt?: string | null }} entry
 */
export async function recordPermission(client, { host, kind = "terms_review", status, url = null, evidence, uses = null, reviewer, reviewedAt = null, expiresAt = null }) {
  if (!PERMISSION_KINDS.includes(kind)) throw new Error(`--kind must be one of ${PERMISSION_KINDS.join(", ")}`);
  if (!PERMISSION_STATUSES.includes(status)) throw new Error(`--status must be one of ${PERMISSION_STATUSES.join(", ")}`);
  if (url && !/^https?:\/\//.test(url)) throw new Error("--url must be a web address");
  if (!evidence || evidence.trim().length < 3) throw new Error("--evidence is required (the quoted clause, or the permission's reference)");
  if (status === "permits" && !uses) throw new Error("--uses is required when the status is permits");
  if (!reviewer) throw new Error("--reviewer is required");
  const s = (await client.query("select id from menu_ingest.sources where host = $1", [host])).rows[0];
  if (!s) throw new Error(`No source ${host}`);
  const r = await client.query(`insert into menu_ingest.access_permissions (source_id, kind, status, document_url, evidence, permitted_uses, reviewer, reviewed_at, expires_at)
                                values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9) returning id`,
    [s.id, kind, status, url, evidence.slice(0, 2000), uses?.slice(0, 1000) ?? null, reviewer.slice(0, 200), reviewedAt, expiresAt]);
  return r.rows[0].id;
}

/** Load a reviewed registry file ({ reviews: [{ hosts, kind, status, url, evidence, uses, reviewer, reviewedAt }] }). Unknown hosts are skipped. */
export async function loadPermissions(client, file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const out = { recorded: 0, skipped: [] };
  const site = (h) => String(h).toLowerCase().replace(/^www\./, "");
  for (const r of j.reviews ?? []) {
    for (const host of [...new Set((r.hosts ?? []).map(site))]) {
      const known = (await client.query("select 1 from menu_ingest.sources where host = $1", [host])).rows.length;
      if (!known) { out.skipped.push(host); continue; }
      const latest = (await client.query(`select x.kind, x.status, x.evidence, x.reviewed_at from menu_ingest.access_permissions x join menu_ingest.sources s on s.id = x.source_id
                                          where s.host = $1 order by x.reviewed_at desc, x.id desc limit 1`, [host])).rows[0];
      if (latest && latest.kind === r.kind && latest.status === r.status && latest.evidence === r.evidence && +new Date(latest.reviewed_at) === +new Date(r.reviewedAt)) continue;
      await recordPermission(client, { host, kind: r.kind, status: r.status, url: r.url ?? null, evidence: r.evidence, uses: r.uses ?? null, reviewer: r.reviewer, reviewedAt: r.reviewedAt ?? null, expiresAt: r.expiresAt ?? null });
      out.recorded++;
    }
  }
  return out;
}

/** Remove one source's saved pages, reads and items (for content we may not keep). Audit counts stay. */
export async function removeSourceContent(client, { host, reason, authority }) {
  if (!reason || !authority) throw new Error("--reason and --authority are required");
  const s = (await client.query("select id from menu_ingest.sources where host = $1", [host])).rows[0];
  if (!s) throw new Error(`No source ${host}`);
  const id = (await client.query("select menu_ingest.remove_source_content($1, $2, $3) id", [s.id, reason, authority])).rows[0].id;
  return (await client.query("select snapshots, read_runs, items from menu_ingest.removals where id = $1", [id])).rows[0];
}

/** Counts by state, with the places each state covers. */
export async function summary(client) {
  const rows = (await client.query(`
    select state, count(*)::int sources, coalesce(sum(places), 0)::int places from menu_ingest.source_status group by state order by state`)).rows;
  const placesWithSite = (await client.query("select count(distinct candidate_id)::int n from menu_ingest.source_places")).rows[0].n;
  return { states: rows, placesWithSite };
}

async function reportMarkdown(client) {
  const s = await summary(client);
  const blocked = (await client.query("select host, places, decision, rule, coalesce(permission_evidence, note) note from menu_ingest.source_status where state in ('blocked', 'terms_block', 'terms_unclear') order by places desc, host limit 200")).rows;
  const excluded = (await client.query("select excluded_by, count(*)::int hosts, sum(places)::int places from menu_ingest.source_status where state = 'excluded' group by 1 order by 3 desc")).rows;
  const L = ["# Menu sources: where each real place's menu lives, and whether we may read it", "",
    "Robots.txt is checked before anything else is read. Unreachable or unclear sites count as not allowed. Nothing here is a menu fact, and nothing is published.", "",
    `Catalog places with a website: ${s.placesWithSite}`, "", "| State | Websites | Places |", "| --- | --- | --- |",
    ...s.states.map((r) => `| ${r.state} | ${r.sources} | ${r.places} |`), "",
    "## Excluded hosts (not the restaurant's own page)", "", "| Host | Websites | Places |", "| --- | --- | --- |",
    ...excluded.map((r) => `| ${r.excluded_by} | ${r.hosts} | ${r.places} |`), "",
    "## Not allowed or unreachable", "", "| Host | Places | Why |", "| --- | --- | --- |",
    ...blocked.map((r) => `| ${r.host} | ${r.places} | ${(r.rule ?? r.note ?? r.decision).replace(/\|/g, "/")} |`)];
  return L.join("\n") + "\n";
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (cmd === "discover") {
      console.log(JSON.stringify(await discover(client, { tier: flag("--tier") === "all" ? "all" : "preview" })));
      // --allowlist <approved file>: also add each listed chain's brand sites, tied to that chain's places.
      if (flag("--allowlist")) {
        for (const r of await seedAllowlistSources(client, JSON.parse(readFileSync(flag("--allowlist"), "utf8")))) {
          if (r.added.length) console.log(`  ${r.chain}: added ${r.added.join(", ")} (${r.places} places)`);
          else if (!r.places) console.log(`  ${r.chain}: no catalog place names this chain's sites`);
        }
      }
    } else if (cmd === "check") {
      // --allowlist <approved file>: check only the sources on a reviewed allowlist (the cloud workspace reaches nothing else).
      let hosts = flag("--host") ? [flag("--host")] : undefined;
      if (flag("--allowlist")) {
        const j = JSON.parse(readFileSync(flag("--allowlist"), "utf8"));
        if (j.approved !== true) throw new Error("That allowlist is not approved.");
        hosts = [...new Set(j.chains.flatMap((c) => c.hosts).map((h) => h.replace(/^www\./, "")))];
      }
      const r = await checkAccess(client, { limit: Number(flag("--limit") ?? 50), hosts, recheckDays: Number(flag("--recheck-days") ?? 30) });
      const by = r.reduce((m, x) => ({ ...m, [x.decision]: (m[x.decision] ?? 0) + 1 }), {});
      console.log(`Checked ${r.length} websites: ${JSON.stringify(by)}`);
      for (const x of r.filter((x) => x.decision !== "allowed")) console.log(`  ${x.decision} ${x.host}: ${x.rule ?? x.note ?? ""}`);
    } else if (cmd === "permission") {
      const id = await recordPermission(client, { host: rest[0], kind: flag("--kind") ?? "terms_review", status: flag("--status"), url: flag("--url") ?? null,
        evidence: flag("--evidence"), uses: flag("--uses") ?? null, reviewer: flag("--reviewer"), expiresAt: flag("--expires") ?? null });
      console.log(`Recorded (permission ${id}).`);
    } else if (cmd === "permissions-load") {
      const r = await loadPermissions(client, rest[0]);
      console.log(`Recorded ${r.recorded}; not a known source here: ${r.skipped.join(", ") || "none"}`);
    } else if (cmd === "remove") {
      const r = await removeSourceContent(client, { host: rest[0], reason: flag("--reason"), authority: flag("--authority") });
      console.log(`Removed ${r.snapshots} snapshots, ${r.read_runs} reads, ${r.items} items (audit kept).`);
    } else if (cmd === "report") {
      const md = await reportMarkdown(client);
      if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}`); } else process.stdout.write(md);
    } else {
      throw new Error(`Use: discover [--tier preview|all] [--allowlist file] | check [--limit n] [--host h] | permission <host> --status s --evidence "..." --reviewer r [--kind k --url u --uses "..."] | permissions-load <file> | remove <host> --reason r --authority a | report [--out file]`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
