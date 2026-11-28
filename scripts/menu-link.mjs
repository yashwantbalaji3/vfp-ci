// Tie researched restaurant profiles (pilot staging) to their real catalog places (docs/40).
// LOCAL, or a hosted beta database for loading commands only (scripts/lib/db-target.mjs). A link copies and publishes nothing; every staged fact stays private and unverified
// until the founder checks it on the review page.
//
//   node scripts/menu-link.mjs suggest [--out file.md]          staged profiles and the catalog places at the same address
//   node scripts/menu-link.mjs link-matches --as <email> [--confirm]   link each profile that has exactly one address match
//   node scripts/menu-link.mjs link-websites --as <email> [--confirm]  link each profile whose menu website the open data names for exactly one place
//   node scripts/menu-link.mjs link <profile id> <candidate id> --as <publisher email> --note "..."   the founder's own link
//   node scripts/menu-link.mjs unlink <profile id> --as <email> --note "..."
//   node scripts/menu-link.mjs status
//
// Without --confirm, link-matches is a dry run that changes nothing.
import { writeFileSync } from "node:fs";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

/** Address matches between staged profiles (latest address fact) and catalog candidates. */
export async function suggestions(client) {
  return (await client.query(`
    with addr as (
      select distinct on (f.place_id) f.place_id, f.value ->> 'street' street, f.value ->> 'postcode' postcode
        from staging.facts f
       where f.kind = 'address' and not f.is_unknown and f.status in ('submitted', 'verified')
       order by f.place_id, f.entered_at desc
    )
    select p.id profile_id, p.label, a.street, a.postcode, k.candidate_id linked_to,
           coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'street', c.street, 'postcode', c.postcode,
                                                          'quality', c.quality, 'tier', c.preview_tier) order by c.name)
                       from catalog_import.place_candidates c
                      where c.quality <> 'rejected'
                        and staging.address_key(c.street, c.postcode) = staging.address_key(a.street, a.postcode)), '[]'::jsonb) matches,
           coalesce((select jsonb_agg(c.id order by c.name)
                       from catalog_import.place_candidates c
                      where c.quality <> 'rejected'
                        and staging.address_key(c.street, c.postcode) = staging.address_key(a.street, a.postcode)
                        and staging.names_share_word(p.label, c.name)), '[]'::jsonb) same_name
      from staging.places p
      left join addr a on a.place_id = p.id
      left join staging.live_catalog_links k on k.staging_place = p.id
     order by p.label`)).rows;
}

/**
 * Links every unlinked profile that has exactly one catalog place at its address.
 * @param {import("pg").ClientBase} client
 * @param {{ actor: string, dryRun?: boolean, ownTransaction?: boolean }} options
 */
export async function linkMatches(client, { actor, dryRun = true, ownTransaction = true }) {
  await client.query(ownTransaction ? "begin" : "savepoint link_matches");
  try {
    const linked = [];
    const skipped = [];
    for (const s of await suggestions(client)) {
      if (s.linked_to) continue;
      if (!s.street) { skipped.push({ label: s.label, why: "no address fact" }); continue; }
      if (!s.matches.length) { skipped.push({ label: s.label, why: "no catalog place at this address" }); continue; }
      if (s.same_name.length !== 1) {
        skipped.push({ label: s.label, why: s.same_name.length ? `${s.same_name.length} catalog places with a matching name at this address` : `${s.matches.length} catalog ${s.matches.length === 1 ? "place" : "places"} at this address, none with a matching name` });
        continue;
      }
      const m = s.matches.find((x) => x.id === s.same_name[0]);
      await client.query("savepoint one_link");
      try {
        await client.query("select staging.link_catalog($1, $2, $3, 'address_match')", [actor, s.profile_id, m.id]);
        await client.query("release savepoint one_link");
        linked.push({ label: s.label, place: `${m.name}, ${m.street} ${m.postcode}` });
      } catch (e) {
        await client.query("rollback to savepoint one_link");
        const msg = /** @type {Error} */ (e).message;
        skipped.push({ label: s.label, why: msg === "PLACE_ALREADY_LINKED" ? "that catalog place is already linked to another profile" : msg });
      }
    }
    const keep = !dryRun;
    await client.query(ownTransaction ? (keep ? "commit" : "rollback") : keep ? "release savepoint link_matches" : "rollback to savepoint link_matches");
    return { dryRun, linked, skipped };
  } catch (e) {
    await client.query(ownTransaction ? "rollback" : "rollback to savepoint link_matches");
    throw e;
  }
}

/**
 * Links every unlinked, non-demo profile whose menu website (not a file host) the open place data
 * names for exactly one catalog place with a matching name (docs/59). The database checks it again.
 * @param {import("pg").ClientBase} client
 * @param {{ actor: string, dryRun?: boolean, ownTransaction?: boolean }} options
 */
export async function linkWebsites(client, { actor, dryRun = true, ownTransaction = true }) {
  const rows = (await client.query(`
    select p.id profile_id, p.label,
           coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'street', c.street, 'host', h.host) order by c.name)
                       from (select distinct staging.url_host(s.url) host from staging.source_pages s
                              where not s.is_demo and s.id in (select f.source_page_id from staging.facts f where f.place_id = p.id)) h
                       join catalog_import.place_candidates c on c.quality <> 'rejected' and h.host in (select staging.candidate_hosts(c.id))
                      where not staging.is_file_host(h.host)), '[]'::jsonb) sites,
           exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id where f.place_id = p.id and s.is_demo) demo
      from staging.places p
     where not exists (select 1 from staging.live_catalog_links k where k.staging_place = p.id)
     order by p.label`)).rows.filter((r) => !r.demo);
  await client.query(ownTransaction ? "begin" : "savepoint link_websites");
  const linked = [];
  const skipped = [];
  try {
    for (const r of rows) {
      if (!r.sites.length) { skipped.push({ label: r.label, why: "the open data names no catalog place with this menu website" }); continue; }
      if (r.sites.length > 1) { skipped.push({ label: r.label, why: `${r.sites.length} catalog places share this website (${r.sites.map((x) => x.street).join("; ")}); link by address or by the founder` }); continue; }
      const m = r.sites[0];
      await client.query("savepoint one_link");
      try {
        await client.query("select staging.link_catalog($1, $2, $3, 'website_match')", [actor, r.profile_id, m.id]);
        await client.query("release savepoint one_link");
        linked.push({ label: r.label, place: `${m.name}, ${m.street} (${m.host})` });
      } catch (e) {
        await client.query("rollback to savepoint one_link");
        skipped.push({ label: r.label, why: /** @type {Error} */ (e).message });
      }
    }
    await client.query(ownTransaction ? (dryRun ? "rollback" : "commit") : dryRun ? "rollback to savepoint link_websites" : "release savepoint link_websites");
    return { dryRun, linked, skipped };
  } catch (e) {
    await client.query(ownTransaction ? "rollback" : "rollback to savepoint link_websites");
    throw e;
  }
}

function sheet(rows) {
  const L = ["# Researched profiles and their real catalog places", "",
    "A link only says that a researched profile is that catalog place. It copies and publishes nothing; every researched fact stays private and unverified until you check it.", "",
    "Automatic links need the same house number, street name and ZIP code and a shared distinctive word in the name. \"Ready\" means exactly one such place.", "",
    "| Profile | Staged address | Linked | Catalog places at that address |", "| --- | --- | --- | --- |"];
  for (const r of rows) {
    const same = new Set(r.same_name);
    const m = r.matches.map((c) => `${same.has(c.id) ? "**" : ""}${c.name.replace(/\|/g, "/")}${same.has(c.id) ? "**" : ""} (${c.quality}${c.tier ? `, ${c.tier}` : ""})`).join("; ") || "none";
    const state = r.linked_to ? "yes" : r.same_name.length === 1 ? "ready" : "no";
    L.push(`| ${r.label} | ${r.street ? `${r.street} ${r.postcode}` : "no address fact"} | ${state} | ${m} |`);
  }
  return L.join("\n") + "\n";
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  // Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
  assertTarget(url, cmd, ["link-websites", "link-matches", "status"]);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const actorId = async (email) => {
    if (!email) throw new Error("--as <email> is required");
    const r = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
    if (!r.rows[0]) throw new Error(`No local account ${email}`);
    return r.rows[0].id;
  };
  try {
    if (cmd === "suggest") {
      const md = sheet(await suggestions(client));
      if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}`); } else process.stdout.write(md);
    } else if (cmd === "link-matches") {
      const r = await linkMatches(client, { actor: await actorId(flag("--as")), dryRun: !rest.includes("--confirm") });
      console.log(`${r.dryRun ? "Dry run (nothing changed)" : "Done"}: ${r.linked.length} linked, ${r.skipped.length} left for a person.`);
      for (const l of r.linked) console.log(`  linked  ${l.label} -> ${l.place}`);
      for (const s of r.skipped) console.log(`  skipped ${s.label}: ${s.why}`);
    } else if (cmd === "link-websites") {
      const r = await linkWebsites(client, { actor: await actorId(flag("--as")), dryRun: !rest.includes("--confirm") });
      console.log(`${r.dryRun ? "Dry run (nothing changed)" : "Done"}: ${r.linked.length} linked by website, ${r.skipped.length} left.`);
      for (const l of r.linked) console.log(`  linked  ${l.label} -> ${l.place}`);
      for (const s of r.skipped) console.log(`  skipped ${s.label}: ${s.why}`);
    } else if (cmd === "link") {
      const [profile, candidate] = rest;
      const id = (await client.query("select staging.link_catalog($1, $2, $3, 'person', $4) r", [await actorId(flag("--as")), profile, candidate, flag("--note") ?? null])).rows[0].r;
      console.log(`Linked (record ${id}).`);
    } else if (cmd === "unlink") {
      const id = (await client.query("select staging.unlink_catalog($1, $2, $3) r", [await actorId(flag("--as")), rest[0], flag("--note") ?? null])).rows[0].r;
      console.log(`Unlinked (record ${id}).`);
    } else if (cmd === "status") {
      const rows = await suggestions(client);
      const ready = rows.filter((r) => !r.linked_to && r.same_name.length === 1).length;
      console.log(`${rows.length} researched profiles; ${rows.filter((r) => r.linked_to).length} linked; ${ready} ready to link; ${rows.filter((r) => !r.linked_to).length - ready} need a person.`);
    } else {
      throw new Error("Use: suggest | link-matches --as <email> [--confirm] | link-websites --as <email> [--confirm] | link <profile> <candidate> --as <email> --note ... | unlink <profile> --as <email> --note ... | status");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
