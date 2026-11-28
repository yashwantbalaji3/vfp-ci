// Founder review page for staged pilot facts. LOCAL ONLY: listens on 127.0.0.1 and talks to the
// local database. Nothing here publishes anything.
//
//   node scripts/pilot-review.mjs --as <your publisher email> [--port 4100] [--batch "Place A|Place B"]
//
// Open http://127.0.0.1:4100 and verify or reject each fact. The database refuses a decision by the
// person who entered the fact, or by anyone without the publisher role, and keeps every decision in
// the permanent staging history.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createReviewServer } from "./lib/pilot-review-lib.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const email = flag("--as");
const port = Number(flag("--port") ?? 4100);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
if (!email) throw new Error("Use: node scripts/pilot-review.mjs --as <your publisher email>");

const pool = new pg.Pool({ connectionString: url, max: 2 });
const who = (await pool.query("select u.id, u.email, exists (select 1 from public.role_assignments r where r.user_id = u.id and r.role = 'publisher') as publisher from auth.users u where lower(u.email) = lower($1)", [email])).rows[0];
if (!who) throw new Error(`No local account ${email}`);
if (!who.publisher) throw new Error(`${email} does not have the publisher role in this local database.`);
const reviewer = { id: who.id, email: who.email };
const token = randomBytes(24).toString("hex"); // required on every decision; changes each time the tool starts

const batch = flag("--batch") ? flag("--batch").split("|").map((n) => n.trim()).filter(Boolean) : null;
const server = createReviewServer({ db: pool, reviewer, token, batch });
server.listen(port, "127.0.0.1", () => console.log(`Pilot review for ${reviewer.email}: http://127.0.0.1:${port}`));
