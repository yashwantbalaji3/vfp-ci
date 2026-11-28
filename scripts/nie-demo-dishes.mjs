// NIE N-5: add the ten SYNTHETIC demo dishes worked out by the nutrition engine to your LOCAL
// database, so you can see each kind of protein figure in the app (docs/24 N-5). Demo data only
// (is_demo = true, "Demo ..." names); nothing real is published and nothing leaves your computer.
//
//   node scripts/nie-demo-dishes.mjs --curator <email> --publisher <email>
//
// Needs the USDA SR Legacy 2018-04 release already imported (node scripts/usda-import.mjs) and two
// different local accounts: a curator enters each dish model and a publisher checks it.
// Running it again changes nothing.
import pg from "pg";
import { demoRelease, loadDemoDishes } from "./lib/nie-demo-dishes.mjs";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const id = async (email) => {
    if (!email) throw new Error("Use: --curator <email> --publisher <email>");
    const r = await client.query("select id from auth.users where lower(email) = lower($1)", [email]);
    if (!r.rows[0]) throw new Error(`No local account ${email}: sign in once with it first.`);
    return r.rows[0].id;
  };
  const curator = await id(flag("--curator"));
  const publisher = await id(flag("--publisher"));
  if (curator === publisher) throw new Error("The curator and the publisher must be two different accounts.");
  await client.query("begin");
  const releaseId = await demoRelease(client);
  const out = await loadDemoDishes(client, { curator, publisher, releaseId });
  await client.query("commit");
  for (const d of out) console.log(`${d.skipped ? "already there" : "added"}: ${d.name}${d.check?.needsReview ? " (protein figures disagree: listed on the editor desk)" : ""}`);
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`Nothing written: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
