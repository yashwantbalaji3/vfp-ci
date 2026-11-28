// Give a LOCAL account a staff role (curator or publisher) in the local database. LOCAL ONLY.
//   node scripts/grant-local-role.mjs <email> publisher
// The owner runs this once on their own computer to act as the pilot's reviewer (decision 23:52 UTC).
// Roles live in the protected public.role_assignments table, never in editable profile data.
import pg from "pg";

const [email, role] = process.argv.slice(2);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
if (!email || !["curator", "publisher"].includes(role)) throw new Error("Use: node scripts/grant-local-role.mjs <email> curator|publisher");
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const u = (await c.query("select id from auth.users where lower(email) = lower($1)", [email])).rows[0];
  if (!u) throw new Error(`No local account ${email}. Sign up in the local app first.`);
  const r = await c.query("insert into public.role_assignments (user_id, role) values ($1, $2) on conflict do nothing", [u.id, role]);
  console.log(r.rowCount ? `${email} now has the ${role} role in this local database.` : `${email} already had the ${role} role.`);
} finally {
  await c.end();
}
