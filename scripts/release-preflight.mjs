#!/usr/bin/env node
// Release preflight (docs/74 section 4.5, docs/75 item 8). READ-ONLY: it changes nothing anywhere.
//
//   node scripts/release-preflight.mjs [--env-file path] [--database-url-from-env] [--stage meals]
//
// --stage meals is the invited beta's second step (docs/95): testers see the restaurant meals the founder reviewed
// and included. It allows only two settings that are otherwise refused: REAL_CATALOG_PREVIEW=true and the member
// beta switch on. In exchange it requires the reviewed-meals mode, at least one included meal, and every included
// meal still passing every check. Everything else is checked exactly as before. Use it only after the owner has
// approved turning the member beta on.
//
// Run it against the database and the environment a deployment would use, before every deploy. It checks that
// nothing private or unverified can become public: every publication switch off, the member beta off, invite-only
// on, no public listing, no demo row, no demo account with an elevated role, a rate-limit key registered, and the
// release flags in the environment off. It prints only names and counts, never a value of a secret.
// Exit code 0 = every check holds; 1 = at least one fails (the deploy must not go ahead); 2 = it could not run.
import { readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const envFile = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : null;
const stage = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : "launch";
if (!["launch", "meals"].includes(stage)) {
  console.error('Use --stage launch (the default) or --stage meals. Nothing checked.');
  process.exit(2);
}
const meals = stage === "meals";

/** Names and values from an env file, without exporting them into this process. */
function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const env = envFile ? readEnv(envFile) : process.env;
const dbUrl = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is not set (in the environment or the env file). Nothing checked.");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// 1. Environment: release flags off unless the owner approved each (they must be absent or exactly "false").
const OFF = ["PUBLIC_RELEASE_ENABLED", "SOCIAL_PUBLIC_ENABLED", "ALLOW_DEMO_CONTENT", "REAL_CATALOG_PREVIEW", "REAL_DISCOVERY", "MAP_ENABLED", "PARTNER_SUBMISSIONS"];
for (const n of OFF.filter((x) => !(meals && x === "REAL_CATALOG_PREVIEW"))) check(`env ${n} off`, env[n] === undefined || env[n] === "" || env[n] === "false", env[n] === "true" ? "set to true" : "off");
if (meals) check("env REAL_CATALOG_PREVIEW on (meals stage)", env.REAL_CATALOG_PREVIEW === "true", env.REAL_CATALOG_PREVIEW === "true" ? "on" : "off");
const TEST_ONLY = ["ALLOW_FAULT_TEST", "SIGNIN_LIMIT_SCALE", "MAP_STREET_FILE"];
for (const n of TEST_ONLY) check(`env ${n} unset (test only)`, !env[n], env[n] ? "set" : "unset");
const appUrl = env.NEXT_PUBLIC_APP_URL ?? "";
check("env NEXT_PUBLIC_APP_URL is a hosted https address", /^https:\/\//.test(appUrl) && !/localhost|127\.0\.0\.1/.test(appUrl), appUrl ? "set" : "unset");
for (const n of ["RATE_LIMIT_KEY", "RATE_LIMIT_SALT", "TRUSTED_ADDRESS_HEADER", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])
  check(`env ${n} present`, Boolean(env[n]), env[n] ? "present" : "missing");
const leaked = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE_ROLE|RATE_LIMIT|DATABASE/i.test(k));
check("no secret under a NEXT_PUBLIC_ name", leaked.length === 0, leaked.length ? leaked.join(", ") : "none");

// The privacy notice and terms (src/content/legal.ts) must be approved by the owner before anyone outside joins.
const legal = readFileSync(new URL("../src/content/legal.ts", import.meta.url), "utf8");
check("privacy notice and terms approved by the owner", /export const LEGAL_TEXT_APPROVED = true;/.test(legal), /LEGAL_TEXT_APPROVED = true;/.test(legal) ? "approved" : "draft");
check("no owner review notes left in the privacy notice or terms", !/^\s+review: \[/m.test(legal), `${(legal.match(/^\s+review: \[/gm) ?? []).length} sections with review notes`);
// The contact address is a setting of the hosting environment (owner decision 6; src/content/legal.ts), never a placeholder.
const contactEmail = (env.CONTACT_EMAIL ?? "").trim().toLowerCase();
check(
  "contact address set (CONTACT_EMAIL)",
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail) && !/@example\.|\.(test|invalid|local)$/.test(contactEmail),
  contactEmail ? "set" : "not set",
);

// 2. Database, read-only.
const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  await client.query("begin read only");
  const one = async (sql) => (await client.query(sql)).rows;
  const switches = await one("select name, enabled from app.platform_switches order by name");
  for (const s of switches) check(`db switch ${s.name} off`, s.enabled === false, String(s.enabled));
  // Checked by name, so a switch added later can never be missed: each must exist, and each is off (above).
  const expected = ["community_submissions", "pilot_publication", "real_catalog_entry", "real_place_listings", "social_public"];
  const names = switches.map((s) => s.name);
  check("db every known switch present", expected.every((n) => names.includes(n)), names.join(","));
  const beta = await one("select enabled from staging.member_beta_switch");
  if (meals) check("db member beta on (meals stage)", beta.length > 0 && beta.every((r) => r.enabled === true), beta.map((r) => r.enabled).join(",") || "no row");
  else check("db member beta off", beta.length === 0 || beta.every((r) => r.enabled === false), beta.map((r) => r.enabled).join(",") || "no row");
  // When the owner later turns the beta on for testers, it must show only meals the founder included (20261123000200).
  const mode = await one("select meal_mode from staging.member_beta_switch");
  check("db member beta shows only founder-reviewed meals", mode.length > 0 && mode.every((r) => r.meal_mode === "reviewed_meals"), mode.map((r) => r.meal_mode).join(",") || "no row");
  // Three review dimensions (20261125000300): an included meal counts only while every check passes, the founder's
  // source review included. A stale inclusion is harmless (the database ignores it), but it should be seen first.
  const stale = (
    await one(`select count(*)::int n from staging.dishes d
                where exists (select 1 from staging.tester_meal_decisions t where t.dish_id = d.id)
                  and (select t.decision from staging.tester_meal_decisions t where t.dish_id = d.id order by t.decided_at desc, t.id desc limit 1) = 'include'
                  and not staging.tester_meal_all_pass(staging.tester_meal_checks(d.id))`)
  )[0].n;
  check("db every meal included for testers still passes every check, source review included", stale === 0, `${stale} stale`);
  // Every enrolled restaurant must be linked to its preview listing, or its meals can never show (and testers see gaps).
  const unlinked = (
    await one(`select count(*)::int n from staging.member_beta_places b
                where not exists (select 1 from staging.live_catalog_links l join public.place_listings pl on pl.candidate_id = l.candidate_id
                                   where l.staging_place = b.place_id and pl.visibility = 'preview')`)
  )[0].n;
  check("db every enrolled restaurant is linked to a preview listing", unlinked === 0, `${unlinked} unlinked`);
  if (meals) {
    const included = (
      await one(`select count(*)::int n from staging.dishes d
                  where (select t.decision from staging.tester_meal_decisions t where t.dish_id = d.id order by t.decided_at desc, t.id desc limit 1) = 'include'
                    and staging.tester_meal_all_pass(staging.tester_meal_checks(d.id))`)
    )[0].n;
    check("db at least one meal reviewed and included for testers (meals stage)", included > 0, `${included}`);
  }
  const invite = await one("select enabled from app.invite_settings");
  check("db invite-only on", invite.length > 0 && invite.every((r) => r.enabled === true), invite.map((r) => r.enabled).join(",") || "no row");
  // The database guard enforces invite-only even where the auth hook is not available (Free plan; docs/98 section 4).
  const guard = await one("select count(*)::int n from pg_trigger where tgname = 'invites_guard_new_account' and not tgisinternal and tgenabled <> 'D'");
  check("db invite guard trigger present", guard[0]?.n === 1, `${guard[0]?.n ?? 0} trigger`);
  const pub = (await one("select count(*)::int n from public.place_listings where visibility = 'public'"))[0].n;
  check("db no public restaurant listing", pub === 0, `${pub}`);
  const demo = (await one("select count(*)::int n from public.food_items where is_demo"))[0].n;
  check("db no demo food", demo === 0, `${demo}`);
  // One account is allowed by name: the research account that enters the researched drafts (scripts/private-beta-load.mjs).
  // It is recognised only while it holds the curator role alone and can never sign in (no password, no sign-in
  // identity, banned for good). Any other role, or any way to sign in, and it counts like every other test account.
  const RESEARCH = "research-curator@local.invalid";
  const demoRoles = (
    await one(`select count(*)::int n from public.role_assignments r join auth.users u on u.id = r.user_id
                where (u.email like '%@example.test' or u.email like '%@example.com' or u.email like '%.invalid')
                  and not (u.email = '${RESEARCH}' and r.role = 'curator')`)
  )[0].n;
  check("db no test or demo account holds a role", demoRoles === 0, `${demoRoles}`);
  const research = await one(`select coalesce(u.encrypted_password, '') = '' as no_password, u.banned_until = 'infinity'::timestamptz as banned,
                                      not exists (select 1 from auth.identities i where i.user_id = u.id) as no_identity,
                                      exists (select 1 from public.role_assignments r where r.user_id = u.id and r.role = 'curator') as curator
                                 from auth.users u where u.email = '${RESEARCH}'`);
  if (research.length) {
    const r = research[0];
    check("db the research account holds only the curator role and cannot sign in", r.no_password && r.banned && r.no_identity,
      `${r.curator ? "curator" : "no role"}; ${r.no_password ? "no password" : "HAS A PASSWORD"}; ${r.banned ? "banned" : "NOT BANNED"}; ${r.no_identity ? "no sign-in identity" : "HAS A SIGN-IN IDENTITY"}`);
  }
  const keys = (await one("select count(*)::int n from app.server_keys where purpose = 'rate_limit'").catch(async () => one("select count(*)::int n from app.server_keys")))[0].n;
  check("db a rate-limit server key is registered", keys > 0, `${keys}`);
  await client.query("rollback");
} catch (e) {
  console.error(`Database check could not run: ${String(e.message ?? e).split("\n")[0]}`);
  await client.end().catch(() => {});
  process.exit(2);
}
await client.end();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.detail})`);
console.log(`Stage: ${stage}.`);
console.log(failed.length ? `\n${failed.length} check(s) failed: do not deploy.` : "\nEvery check holds.");
process.exit(failed.length ? 1 : 0);
