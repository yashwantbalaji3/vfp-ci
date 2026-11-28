// Invite-only sign-up (migration 20261122000800, docs/72 section 5). Nothing is ever sent: adding an email does not
// email anyone. Runs against a local database, or against the hosted project named by VFP_HOSTED_REF when the address
// belongs to exactly that project (scripts/lib/db-target.mjs; docs/99 section 8). On a hosted project every change
// (add, revoke, on, off) is a dry run unless --confirm is given, and needs the owner's approval for that step.
//
//   node scripts/invites.mjs status
//   node scripts/invites.mjs add <email> --by "<who>" --adult [--note "..."]   (--adult: you confirm the person is 18 or older)
//   node scripts/invites.mjs revoke <email> --by "<who>"
//   node scripts/invites.mjs on|off --by "<who>" [--confirm]
// Hosted: DATABASE_URL and VFP_HOSTED_REF in the environment (never printed).
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const target = assertTarget(url, args[0], ["status", "add", "revoke", "on", "off"]);
const hosted = target.kind === "hosted";
// On a hosted project a change is applied only with --confirm; without it, say what would happen.
const dry = (what) => {
  if (hosted && !args.includes("--confirm")) {
    console.log(`Dry run on hosted project ${target.ref}: would ${what}. Nothing changed. Add --confirm to apply.`);
    return true;
  }
  return false;
};
const by = () => {
  const b = flag("--by");
  if (!b) throw new Error('Give --by "<who>"');
  return b;
};
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const [cmd, email] = args;
  if (cmd === "status") {
    const s = (await client.query("select enabled, changed_by, changed_at from app.invite_settings")).rows[0];
    const n = (await client.query("select count(*) filter (where revoked_at is null)::int live, count(*)::int total from app.invites")).rows[0];
    console.log(`Invite-only sign-up: ${s.enabled ? "ON" : "off"}. Invites: ${n.live} active (${n.total} recorded). Existing accounts always keep signing in.`);
  } else if (cmd === "add") {
    // The invited beta is adults only (owner decision 2, 26 Nov 2026; migration 20261126000200): an invite counts only
    // when the person adding it confirms the invitee is 18 or older.
    if (!args.includes("--adult")) throw new Error("The beta is for adults only. Add --adult to confirm this person is 18 or older. Nothing changed.");
    if (dry(`invite ${email.toLowerCase()}`)) process.exit(0);
    await client.query(
      "insert into app.invites (email, note, added_by, adult_confirmed) values (lower($1), $2, $3, true) on conflict (email) do update set revoked_at = null, note = excluded.note, adult_confirmed = true",
      [email, flag("--note") ?? null, by()],
    );
    console.log(`Invited ${email.toLowerCase()}. No email was sent; tell them yourself.`);
  } else if (cmd === "revoke") {
    if (dry(`revoke ${email.toLowerCase()}`)) process.exit(0);
    const r = await client.query("update app.invites set revoked_at = now() where email = lower($1) and revoked_at is null", [email]);
    console.log(r.rowCount ? `Revoked ${email.toLowerCase()} (stops a new sign-up; an existing account and its data are untouched).` : "No active invite for that email.");
  } else if (cmd === "on" || cmd === "off") {
    const who = by();
    if (!args.includes("--confirm")) console.log(`Dry run: would turn invite-only ${cmd}. Nothing changed.`);
    else {
      await client.query("update app.invite_settings set enabled = $1, changed_by = $2, changed_at = now()", [cmd === "on", who]);
      console.log(`Invite-only sign-up is now ${cmd === "on" ? "ON" : "off"}.`);
    }
  } else throw new Error("Use: status | add <email> --by ... --adult | revoke <email> --by ... | on|off --by ... --confirm");
} finally {
  await client.end();
}
