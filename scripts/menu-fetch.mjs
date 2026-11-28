// Menu pipeline stage 2 (docs/41): polite fetching of allowed menu pages, snapshots, and reading.
// LOCAL ONLY database. Nothing is verified or published.
//
//   node scripts/menu-fetch.mjs fetch [--allowlist scripts/menu-allowlist-phase1.json | --any-allowed] [--max-pages 20] [--delay 5]
//   node scripts/menu-fetch.mjs export --out <folder>        snapshots and their robots.txt decisions, for another computer
//   node scripts/menu-fetch.mjs import <folder>              snapshots made elsewhere (for example on the founder's Mac)
//   node scripts/menu-fetch.mjs read                         read every snapshot not yet read by the current readers
//   node scripts/menu-fetch.mjs status
//
// The same code runs in the cloud workspace (reviewed allowlist only) and on a computer with
// ordinary internet access (--any-allowed: every source whose robots.txt allows it). Either way:
// robots.txt is honoured for every page, one request at a time per site with a pause between
// requests, and a site stops at its first refusal or error while the others carry on.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PIPELINE_USER_AGENT, decide } from "./lib/robots.mjs";
import { READERS, findMenuLinks, matchKey, readWith, readersFor } from "./lib/menu-readers.mjs";

export const MAX_BYTES = 5 * 1024 * 1024;
const site = (h) => String(h).toLowerCase().replace(/^www\./, "");
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Hosts (www-free) a reviewed allowlist file permits, or null when the file is not approved. */
export function allowlistHosts(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.approved !== true) return null;
  return new Set(j.chains.flatMap((c) => c.hosts).map(site));
}

/** Fetch one page without following redirects to other sites. Never throws. */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = 20000, sameSite, maxRedirects = 5 } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    try {
      const res = await fetchImpl(current, { redirect: "manual", headers: { "user-agent": PIPELINE_USER_AGENT, accept: "text/html,application/json,application/pdf;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location"), current);
        if (!sameSite(next)) return { url: current, status: res.status, error: `Redirects to another site (${next.hostname}); not followed` };
        current = next.toString();
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return { url: current, status: res.status, error: "Page larger than 5 MB; not kept" };
      return { url: current, status: res.status, contentType: res.headers.get("content-type"), body: buf };
    } catch (e) {
      return { url: current, status: null, error: /** @type {Error} */ (e).message?.slice(0, 200) ?? "fetch failed" };
    }
  }
  return { url: current, status: null, error: "Too many redirects" };
}

async function saveSnapshot(client, { sourceId, accessCheckId, url, fetchedAt, via, status, contentType, body }) {
  const r = await client.query(`
    insert into menu_ingest.snapshots (source_id, access_check_id, url, fetched_at, fetched_via, http_status, content_type, sha256, bytes, body)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (url, sha256) do nothing returning id`,
    [sourceId, accessCheckId, url, fetchedAt, via, status, contentType?.slice(0, 200) ?? null, sha(body), body.length, body]);
  return r.rows[0]?.id ?? null;
}

/**
 * Fetch allowed pages: each source's start page, then the menu, nutrition, allergen and ingredient
 * pages it links to on the same site.
 * @param {import("pg").ClientBase} client
 * @param {{ hosts?: Set<string> | null, anyAllowed?: boolean, maxPages?: number, delaySeconds?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void }} options
 */
export async function fetchMenus(client, { hosts = null, anyAllowed = false, maxPages = 20, delaySeconds = 5, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  if (!anyAllowed && !hosts) throw new Error("No approved allowlist: pass an approved --allowlist file, or --any-allowed on a computer with ordinary internet access.");
  const sources = (await client.query(`
    select s.id, s.host, s.start_url, a.id check_id, a.robots_text, a.note
      from menu_ingest.source_status s
      join lateral (select * from menu_ingest.access_checks c where c.source_id = s.id order by c.checked_at desc, c.id desc limit 1) a on true
     where s.state = 'may_fetch' order by s.places desc, s.host`)).rows
    .filter((s) => anyAllowed || hosts.has(site(s.host)));
  const report = [];
  for (const s of sources) {
    const crawl = Number(/Crawl-delay (\d+(?:\.\d+)?)s/.exec(s.note ?? "")?.[1] ?? 0);
    const pause = Math.max(delaySeconds, crawl) * 1000;
    const sameSite = (u) => site(u.hostname) === site(s.host) && (anyAllowed || hosts.has(site(u.hostname)));
    const queue = [s.start_url];
    const done = new Set();
    const r = { host: s.host, fetched: 0, saved: 0, skipped: [], stopped: null };
    while (queue.length && r.fetched < maxPages) {
      const url = queue.shift();
      if (done.has(url)) continue;
      done.add(url);
      const u = new URL(url);
      const d = decide(s.robots_text ?? "", u.pathname + u.search);
      if (!d.allowed) { r.skipped.push(`${u.pathname}: ${d.rule}`); continue; }
      if (r.fetched > 0) await sleep(pause);
      const page = await fetchPage(url, { fetchImpl, sameSite });
      r.fetched++;
      if (page.error || !page.status || page.status >= 400) {
        r.stopped = page.error ?? `HTTP ${page.status}`;
        log(`  ${s.host}: stopped at ${url} (${r.stopped})`);
        break;
      }
      const id = await saveSnapshot(client, { sourceId: s.id, accessCheckId: s.check_id, url: page.url, fetchedAt: new Date(), via: "cloud", status: page.status, contentType: page.contentType, body: page.body });
      if (id) r.saved++;
      if (/html/i.test(page.contentType ?? "") && done.size === 1) {
        for (const l of findMenuLinks(page.body.toString("utf8"), page.url)) if (!done.has(l.url)) queue.push(l.url);
      }
    }
    report.push(r);
    log(`${s.host}: ${r.fetched} fetched, ${r.saved} new snapshots${r.skipped.length ? `, ${r.skipped.length} skipped by robots.txt` : ""}${r.stopped ? `, stopped: ${r.stopped}` : ""}`);
  }
  return report;
}

/** Write snapshots and the robots.txt decisions behind them to a folder another computer can import. */
export async function exportSnapshots(client, out) {
  mkdirSync(out, { recursive: true });
  const rows = (await client.query(`
    select n.*, s.host, a.robots_url, a.robots_text, a.robots_sha256, a.http_status robots_status, a.decision, a.checked_at
      from menu_ingest.snapshots n join menu_ingest.sources s on s.id = n.source_id join menu_ingest.access_checks a on a.id = n.access_check_id
     order by n.id`)).rows;
  const manifest = rows.map((r) => {
    writeFileSync(join(out, `${r.sha256}.bin`), r.body);
    return { host: r.host, url: r.url, fetchedAt: r.fetched_at, httpStatus: r.http_status, contentType: r.content_type, sha256: r.sha256, bytes: r.bytes,
      robots: { url: r.robots_url, text: r.robots_text, sha256: r.robots_sha256, httpStatus: r.robots_status, decision: r.decision, checkedAt: r.checked_at } };
  });
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: "vfp-menu-snapshots@1", exportedAt: new Date().toISOString(), snapshots: manifest }, null, 2));
  return manifest.length;
}

/**
 * Import snapshots made on another computer. Each is checked again here: the file must match its
 * fingerprint, its site must be a known, non-excluded source, the robots.txt it carries must
 * allow its path, and the source-access registry here must hold a current "permits" entry.
 * Anything else is refused and named.
 */
export async function importSnapshots(client, dir) {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (m.format !== "vfp-menu-snapshots@1") throw new Error("Not a menu snapshot folder");
  const result = { imported: 0, already: 0, refused: [] };
  for (const x of m.snapshots) {
    const body = readFileSync(join(dir, `${x.sha256}.bin`));
    const u = new URL(x.url);
    const refuse = (why) => result.refused.push({ url: x.url, why });
    if (sha(body) !== x.sha256) { refuse("file does not match its fingerprint"); continue; }
    const s = (await client.query("select id, excluded_by from menu_ingest.sources where host = $1", [site(u.hostname)])).rows[0];
    if (!s) { refuse("not a known catalog source"); continue; }
    if (s.excluded_by) { refuse(`excluded host (${s.excluded_by})`); continue; }
    if (x.robots?.decision !== "allowed" || !decide(x.robots.text ?? "", u.pathname + u.search).allowed) { refuse("robots.txt does not allow this page"); continue; }
    const st = (await client.query("select state, permission_status from menu_ingest.source_status where id = $1", [s.id])).rows[0];
    if (st.permission_status !== "permits") { refuse(`no current permission for automated reading (${st.permission_status ?? "terms not reviewed"})`); continue; }
    const check = (await client.query(`
      insert into menu_ingest.access_checks (source_id, checked_at, robots_url, http_status, robots_sha256, robots_text, user_agent, path_checked, decision, note)
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'allowed', 'From a local run, imported') returning id`,
      [s.id, x.robots.checkedAt, x.robots.url, x.robots.httpStatus, x.robots.sha256, x.robots.text, PIPELINE_USER_AGENT, (u.pathname + u.search).slice(0, 500)])).rows[0].id;
    const id = await saveSnapshot(client, { sourceId: s.id, accessCheckId: check, url: x.url, fetchedAt: x.fetchedAt, via: "local_import", status: x.httpStatus, contentType: x.contentType, body });
    if (id) result.imported++; else result.already++;
  }
  return result;
}

/** Read every snapshot with each current reader that applies to its site and has not read it yet. */
export async function readSnapshots(client) {
  // Only sources whose access is still permitted are read (fail closed). Authorized exports have their own reader.
  const due = (await client.query(`select n.id, n.source_id, n.content_type, n.body, s.host from menu_ingest.snapshots n
                                     join menu_ingest.sources s on s.id = n.source_id
                                     join menu_ingest.source_status st on st.id = n.source_id and st.state in ('may_fetch', 'may_import')
                                    where n.fetched_via <> 'authorized_export' order by n.id`)).rows;
  const done = new Set((await client.query("select snapshot_id, reader from menu_ingest.read_runs")).rows.map((r) => `${r.snapshot_id} ${r.reader}`));
  let items = 0, runs = 0;
  const snapshots = new Set();
  for (const n of due) {
    const html = /html/i.test(n.content_type ?? "") ? n.body.toString("utf8") : "";
    // Template readers (BentoBox, WP Cafe) join when the page is built with that template.
    for (const name of readersFor(n.host, html || null)) {
      const reader = READERS[name];
      if (done.has(`${n.id} ${reader}`)) continue;
      snapshots.add(n.id); runs++;
      const found = html ? readWith(name, html) : [];
      const note = html ? (found.length ? null : `No menu items for ${reader} on this page`) : `Not read: ${n.content_type ?? "unknown type"} (reader not built yet)`;
      const run = (await client.query("insert into menu_ingest.read_runs (snapshot_id, reader, items, note) values ($1, $2, $3, $4) returning id", [n.id, reader, found.length, note])).rows[0].id;
      for (const it of found) {
        const key = matchKey(it.name);
        if (!key) continue;
        const itemSha = sha(JSON.stringify(it));
        await client.query(`
          insert into menu_ingest.items (read_run_id, source_id, name, description, section, labels, legend, ingredients, allergens, price_usd, serving, serving_grams, nutrition, match_key, item_sha256)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) on conflict do nothing`,
          [run, n.source_id, it.name.slice(0, 300), it.description?.slice(0, 2000) ?? null, it.section?.slice(0, 200) ?? null, it.labels, it.legend, it.ingredients?.slice(0, 4000) ?? null,
           it.allergens?.slice(0, 1000) ?? null, it.price_usd, it.serving?.slice(0, 200) ?? null, it.serving_grams, it.nutrition, key, itemSha]);
        items++;
      }
    }
  }
  return { snapshots: snapshots.size, runs, items };
}

export async function fetchStatus(client) {
  return (await client.query(`
    select s.host, count(distinct n.id)::int snapshots, count(distinct i.match_key)::int dishes,
           count(distinct i.match_key) filter (where i.nutrition ? 'protein_g')::int with_protein
      from menu_ingest.sources s join menu_ingest.snapshots n on n.source_id = s.id
      left join menu_ingest.items i on i.source_id = s.id
     group by s.host order by s.host`)).rows;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (cmd === "fetch") {
      const anyAllowed = rest.includes("--any-allowed");
      const hosts = anyAllowed ? null : allowlistHosts(flag("--allowlist") ?? "scripts/menu-allowlist-phase1.json");
      const r = await fetchMenus(client, { hosts, anyAllowed, maxPages: Number(flag("--max-pages") ?? 20), delaySeconds: Math.max(5, Number(flag("--delay") ?? 5)), log: (s) => console.log(s) });
      console.log(`Done: ${r.length} sites, ${r.reduce((a, x) => a + x.saved, 0)} new snapshots, ${r.filter((x) => x.stopped).length} stopped early.`);
    } else if (cmd === "export") {
      console.log(`Exported ${await exportSnapshots(client, flag("--out") ?? "work/menu-snapshots")} snapshots.`);
    } else if (cmd === "import") {
      const r = await importSnapshots(client, rest[0]);
      console.log(`Imported ${r.imported}, already had ${r.already}, refused ${r.refused.length}.`);
      for (const x of r.refused) console.log(`  refused ${x.url}: ${x.why}`);
    } else if (cmd === "read") {
      const r = await readSnapshots(client);
      console.log(`Read ${r.snapshots} snapshots (${r.runs} reader runs): ${r.items} menu items.`);
    } else if (cmd === "status") {
      console.table(await fetchStatus(client));
    } else {
      throw new Error("Use: fetch [--allowlist file | --any-allowed] [--max-pages n] [--delay s] | export --out dir | import dir | read | status");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
