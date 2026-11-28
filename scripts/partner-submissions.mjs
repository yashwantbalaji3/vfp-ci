// Restaurant submissions (owner direction 17 Nov 2026 23:55 UTC, point 2; docs/48). LOCAL ONLY.
// Turns a menu file a restaurant gives us (the docs/45 JSON/CSV export format) into the item rows that
// partner.submit_menu takes, and prints the private moderation queue for a moderator. It never
// submits on a restaurant's behalf, never verifies anything and never publishes.
//
//   node scripts/partner-submissions.mjs prepare <file.json|file.csv>      items JSON + file fingerprint, no database
//   node scripts/partner-submissions.mjs queue --moderator <email>          the moderator's queue (local database)
//
// Dietary labels: only a label that is exactly "vegan" or "vegetarian" (any case) becomes a dietary
// statement, kept in the restaurant's own words. Anything else ("vegan option", "plant-based",
// "V") is reported as unmapped for a person to read, because "vegan-friendly" never becomes "vegan".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";
import { partnerItemsFromText, toPartnerItems } from "./lib/partner-items.mjs";

export { toPartnerItems };

/** prepare: read a file the restaurant sent, ready for partner.submit_menu. */
export function prepareFile(file) {
  const body = readFileSync(file);
  const kind = /\.json$/i.test(file) ? "json" : /\.csv$/i.test(file) ? "csv" : null;
  if (!kind) throw new Error("Use a .json or .csv export");
  const { documentDate, items, unmapped } = partnerItemsFromText(body.toString("utf8"), kind);
  return { fileName: basename(file), fileSha256: createHash("sha256").update(body).digest("hex"), documentDate, items, unmapped };
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const flag = (name) => { const all = [arg, ...rest]; const i = all.indexOf(name); return i >= 0 ? all[i + 1] : undefined; };
  if (cmd === "prepare" && arg) {
    const r = prepareFile(arg);
    console.log(JSON.stringify(r, null, 2));
    console.error(`${r.items.length} items; ${r.unmapped.length} labels left for a person to read. Nothing was stored.`);
    return;
  }
  if (cmd === "queue" && flag("--moderator")) {
    const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const who = (await client.query("select id from auth.users where lower(email) = lower($1)", [flag("--moderator")])).rows[0];
      if (!who) throw new Error("No such account");
      const rows = (await client.query("select * from partner.moderation_queue($1)", [who.id])).rows;
      if (!rows.length) console.log("Nothing is waiting for review.");
      for (const r of rows) console.log(`${r.place_name} · ${r.name}${r.flags.length ? ` · check: ${r.flags.join(", ")}` : ""} · licence ${r.licence_version} · file ${r.file_sha256.slice(0, 12)}`);
    } finally {
      await client.end();
    }
    return;
  }
  throw new Error("Use: partner-submissions.mjs prepare <file> | queue --moderator <email>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
