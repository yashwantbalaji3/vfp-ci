// Research source clearance (owner direction 17 Nov 2026 22:37 UTC; docs/46).
//
//   node scripts/research-sources.mjs audit <entries.json>... [--registry file] [--out audit.md] [--json audit.json]
//       One row per source of every researched place: address, how it was collected, terms status,
//       permitted uses, facts and protein figures resting on it. Files only.
//   node scripts/research-sources.mjs clean <entries.json>... --log removal.json [--registry file]
//       Targeted cleanup: removes sources, facts and emptied dishes from PROHIBITED hosts only, rewriting
//       each file in place; pending (unclear, unreadable, unreviewed) content is kept and held. The log
//       keeps counts, hosts and fingerprints, never the removed content.
//   node scripts/research-sources.mjs db-load [--registry file]     (LOCAL database) registry -> staging.source_access
//   node scripts/research-sources.mjs db-held                        (LOCAL database) facts held, by place and host
//   node scripts/research-sources.mjs db-remove <host> --reason "..." --authority "..."   (LOCAL; prohibited hosts only)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { accessState, auditSources, cleanEntry, registryIndex } from "./lib/source-access.mjs";
import { assertTarget } from "./lib/db-target.mjs";

export const DEFAULT_REGISTRY = new URL("./menu-access-registry.json", import.meta.url);
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function auditMarkdown(rows, generatedOn) {
  const by = (k) => rows.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] ?? 0) + 1 }), {});
  const sum = (state, k) => rows.filter((r) => r.state === state).reduce((n, r) => n + r[k], 0);
  const places = (state) => new Set(rows.filter((r) => r.state === state && r.known > 0).map((r) => r.place)).size;
  const L = [`# Research source audit (${generatedOn})`, "",
    "Every source behind the researched restaurant profiles, with how it was collected and what its terms allow. A fact counts only when its source is **cleared** (the terms or a written permission allow our use). Pending and prohibited facts are held out of readiness counts, founder review and publication. These are Claude's readings of the terms, not legal advice.", "",
    "| State | Sources | Facts | Known facts | Protein figures | Places with known facts |", "| --- | --- | --- | --- | --- | --- |",
    ...["cleared", "pending", "prohibited"].map((s) => `| ${s} | ${by("state")[s] ?? 0} | ${sum(s, "facts")} | ${sum(s, "known")} | ${sum(s, "protein")} | ${places(s)} |`), "",
    "| Place | Host | Kind | Collected | Terms | State | Facts | Protein |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.place} | ${r.host} | ${r.kind} | ${r.retrievedAt?.slice(0, 10) ?? ""}, ${r.method} | ${r.termsStatus}${r.termsUrl ? ` ([terms](${r.termsUrl}))` : ""} | ${r.state} | ${r.facts} | ${r.protein} |`)];
  return L.join("\n") + "\n";
}

async function db(fn) {
  const { default: pg } = await import("pg");
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  // Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
  assertTarget(url, process.argv[2], ["db-load"]);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Load registry entries into staging.source_access; an identical entry is never repeated. */
export async function loadStagingAccess(client, registry) {
  let recorded = 0;
  for (const r of registry.reviews ?? []) {
    for (const host of [...new Set((r.hosts ?? []).map((h) => String(h).toLowerCase().replace(/^www\./, "")))]) {
      // Any identical entry already recorded, not only the latest: a host with a later owner decision used to get
      // its earlier terms reading recorded again on every load (24 Nov 2026).
      if (r.reviewedAt) {
        const same = await client.query("select 1 from staging.source_access where host = $1 and kind = $2 and status = $3 and evidence = $4 and reviewed_at = $5 limit 1", [host, r.kind, r.status, r.evidence, r.reviewedAt]);
        if (same.rowCount) continue;
      }
      await client.query(`insert into staging.source_access (host, kind, status, document_url, evidence, permitted_uses, reviewer, reviewed_at, expires_at)
                          values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)`,
        [host, r.kind, r.status, r.url ?? null, r.evidence, r.uses ?? null, r.reviewer, r.reviewedAt ?? null, r.expiresAt ?? null]);
      recorded++;
    }
  }
  return recorded;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const VALUED = ["--registry", "--out", "--json", "--log", "--reason", "--authority"];
  const flag = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  const files = rest.filter((a, i) => !a.startsWith("--") && !VALUED.includes(rest[i - 1]));
  const registry = JSON.parse(readFileSync(flag("--registry") ?? DEFAULT_REGISTRY, "utf8"));
  const index = registryIndex(registry);
  if (cmd === "audit") {
    const rows = auditSources(files.map((f) => ({ file: basename(f), entry: JSON.parse(readFileSync(f, "utf8")) })), index);
    const md = auditMarkdown(rows, new Date().toISOString().slice(0, 10));
    if (flag("--json")) writeFileSync(flag("--json"), JSON.stringify(rows, null, 2) + "\n");
    if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}: ${rows.length} sources.`); } else process.stdout.write(md);
  } else if (cmd === "clean") {
    if (!flag("--log")) throw new Error("--log <removal.json> is required");
    const log = { removedAt: new Date().toISOString(), authority: "Owner direction 17 Nov 2026 22:06 and 22:37 UTC (targeted cleanup of prohibited content, audit trail)", files: [] };
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const { entry, removed, noteSha256 } = cleanEntry(JSON.parse(text), index, sha);
      if (!removed.length) continue;
      const out = JSON.stringify(entry, null, 2) + "\n";
      writeFileSync(f, out);
      log.files.push({ file: basename(f), beforeSha256: sha(text), afterSha256: sha(out), replacedNoteSha256: noteSha256, removed });
    }
    writeFileSync(flag("--log"), JSON.stringify(log, null, 2) + "\n");
    const n = log.files.flatMap((x) => x.removed);
    console.log(`Cleaned ${log.files.length} files: ${n.reduce((a, r) => a + r.facts, 0)} facts (${n.reduce((a, r) => a + r.protein, 0)} protein figures) from ${new Set(n.flatMap((r) => r.hosts)).size} prohibited hosts. Log: ${flag("--log")}`);
  } else if (cmd === "db-load") {
    console.log(`Recorded ${await db((c) => loadStagingAccess(c, registry))} entries in staging.source_access.`);
  } else if (cmd === "db-held") {
    const rows = await db(async (c) => (await c.query("select * from staging.held_sources()")).rows);
    for (const r of rows) console.log(`${r.state.padEnd(10)} ${r.host.padEnd(36)} ${String(r.facts).padStart(4)} facts ${String(r.protein_facts).padStart(3)} protein  ${r.place_label}`);
    console.log(`${rows.reduce((n, r) => n + Number(r.facts), 0)} facts held.`);
  } else if (cmd === "db-remove") {
    if (!files[0] || !flag("--reason") || !flag("--authority")) throw new Error("Use: db-remove <host> --reason \"...\" --authority \"...\"");
    if (accessState(`https://${files[0]}/`, index) !== "prohibited") throw new Error(`${files[0]} is not prohibited in the registry; held content is not deleted.`);
    const r = await db(async (c) => {
      const id = (await c.query("select staging.remove_source_content($1, $2, $3) id", [files[0], flag("--reason"), flag("--authority")])).rows[0].id;
      return (await c.query("select facts, source_pages from staging.removals where id = $1", [id])).rows[0];
    });
    console.log(`Removed ${r.facts} facts and ${r.source_pages} source pages from ${files[0]} (audit kept).`);
  } else {
    throw new Error("Use: audit | clean | db-load | db-held | db-remove (see the header of this file)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
