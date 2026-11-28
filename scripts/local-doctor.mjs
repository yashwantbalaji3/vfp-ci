// Local setup check for the Vegetarian Food Platform. LOCAL ONLY.
//
//   pnpm local:doctor                       read-only: reports what is wrong and how to fix it
//   pnpm local:doctor --register-local-key  also registers the LOCAL development rate-limit key
//                                           in the LOCAL database (adds one row; deletes nothing)
//   pnpm local:doctor --add-missing-demo    also adds the synthetic demo rows (and that key) that an
//                                           older LOCAL database is missing, from supabase/demo-topup.sql.
//                                           Adds rows only, in one transaction; deletes and overwrites nothing
//
// It never prints a secret or a setting's value: only names, yes/no answers, counts and versions.
// It refuses to touch any database that is not on this computer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import pg from "pg";

const LOCAL_KEY = "local-development-only-rate-limit-key-0000"; // public: also in supabase/seed.sql
const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "RATE_LIMIT_SALT",
  "RATE_LIMIT_KEY",
  "TRUSTED_ADDRESS_HEADER",
  "MAP_ENABLED",
  "ALLOW_DEMO_CONTENT",
];
const fixKey = process.argv.includes("--register-local-key");
const addDemo = process.argv.includes("--add-missing-demo");
let problems = 0;
const ok = (msg) => console.log(`  OK    ${msg}`);
const bad = (msg, fix) => {
  problems++;
  console.log(`  FIX   ${msg}${fix ? `\n        -> ${fix}` : ""}`);
};
const info = (msg) => console.log(`  INFO  ${msg}`);
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

console.log("\n1. Code version");
const branch = run("git", ["branch", "--show-current"]);
const head = run("git", ["log", "-1", "--format=%h %s"]);
const mainRef = run("git", ["rev-parse", "--verify", "--quiet", "origin/main"]);
info(`branch: ${branch || "(none)"}; commit: ${head}`);
const dirty = (run("git", ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
if (dirty) info(`${dirty} changed or new file(s) in the working folder (kept as they are)`);
if (mainRef) {
  const behind = Number(run("git", ["rev-list", "--count", "HEAD..origin/main"]) ?? "0");
  if (behind > 0) bad(`${behind} commit(s) behind the last fetched main`, "git fetch origin && git switch main && git pull --ff-only");
  else ok("includes the last fetched main (run `git fetch origin` first to compare with GitHub)");
}

console.log("\n2. Tools");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} is too old`, "install Node.js 22 LTS (https://nodejs.org)");
const pnpmV = run("pnpm", ["--version"]);
if (pnpmV) ok(`pnpm ${pnpmV}`);
else bad("pnpm not found", "corepack enable")
if (!existsSync("node_modules/.modules.yaml")) bad("libraries not installed", "pnpm install --frozen-lockfile");
else if (statSync("pnpm-lock.yaml").mtimeMs > statSync("node_modules/.modules.yaml").mtimeMs)
  bad("libraries older than pnpm-lock.yaml", "pnpm install --frozen-lockfile");
else ok("libraries installed and up to date with pnpm-lock.yaml");

console.log("\n3. Docker and the local database");
const containers = run("docker", ["ps", "--format", "{{.Names}}\t{{.Status}}"]);
if (containers === null) bad("Docker is not running", "open Docker Desktop and wait until it says it is running");
else {
  const ours = containers.split("\n").filter((l) => /supabase_.*vegetarian-food-platform/.test(l));
  if (ours.length) ok(`${ours.length} local Supabase containers running`);
  else bad("the local Supabase stack is not running", "pnpm exec supabase start")
  const unhealthy = ours.filter((l) => /unhealthy|Restarting/i.test(l));
  if (unhealthy.length) bad(`${unhealthy.length} container(s) unhealthy: ${unhealthy.map((l) => l.split("\t")[0]).join(", ")}`, "pnpm exec supabase stop && pnpm exec supabase start");
}

console.log("\n4. Settings (.env.local; names only, values never shown)");
const env = {};
if (!existsSync(".env.local")) bad(".env.local is missing", "node scripts/write-local-env.mjs (with the local stack running)");
else {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) bad(`missing: ${missing.join(", ")}`, "node scripts/write-local-env.mjs (keeps your RATE_LIMIT_SALT)");
  else ok("all required settings present")
  if (env.RATE_LIMIT_KEY && env.RATE_LIMIT_KEY.length < 32) bad("RATE_LIMIT_KEY is too short", "node scripts/write-local-env.mjs");
  if (env.MAP_STREET_FILE) {
    if (existsSync(env.MAP_STREET_FILE)) ok(`street map file found (${env.MAP_STREET_FILE})`);
    else bad(`street map file not found: ${env.MAP_STREET_FILE}`, "see docs/21 section 7; the map falls back to a plain background meanwhile")
    if (!/local-maps\/boston\.pmtiles$/.test(env.MAP_STREET_FILE)) info("using the small invented test map, not the Boston file (docs/21 section 7 to add it)");
  } else info("no street map file set: the map uses its plain background");
}

console.log("\n5. Database contents");
const dbUrl = env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(dbUrl)) {
  bad("DATABASE_URL does not point at this computer; the doctor only checks a local database");
} else {
  const db = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 4000 });
  try {
    await db.connect();
    ok("local database reachable");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]).sort();
    const applied = new Set((await db.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));
    const pending = files.filter((v) => !applied.has(v));
    if (pending.length)
      bad(`${pending.length} database change(s) not applied: ${pending.join(", ")}`, "pnpm exec supabase migration up   (adds the missing changes; keeps your data)");
    else ok(`all ${files.length} database changes applied`);
    const fn = await db.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'rate_limit_hit' and p.pronargs = 4");
    if (fn.rows[0].n === 1) ok("request-counter function present");
    else bad("request-counter function missing or old", "pnpm exec supabase migration up")
    if (env.RATE_LIMIT_KEY) {
      const known = await db
        .query("select exists (select 1 from app.server_keys where purpose = 'rate_limit' and digest = sha256(convert_to($1, 'UTF8'))) as yes", [env.RATE_LIMIT_KEY])
        .catch(() => ({ rows: [{ yes: null }] }));
      if (known.rows[0].yes === true) ok("the database recognises this app's request-counter key");
      else if (fixKey && env.RATE_LIMIT_KEY === LOCAL_KEY) {
        // A plain insert: unlike app.register_server_key, it never removes an older key.
        const digest = createHash("sha256").update(LOCAL_KEY, "utf8").digest();
        await db.query("insert into app.server_keys (purpose, digest) values ('rate_limit', $1) on conflict do nothing", [digest]);
        ok("registered the LOCAL development request-counter key (one row added, nothing deleted)");
      } else if (addDemo && env.RATE_LIMIT_KEY === LOCAL_KEY) {
        info("the request-counter key is not registered yet; --add-missing-demo adds it below");
      } else
        bad(
          "the database does not recognise this app's request-counter key, so every searching page shows a refusal",
          env.RATE_LIMIT_KEY === LOCAL_KEY ? "pnpm local:doctor --register-local-key" : "node scripts/write-local-env.mjs, then pnpm local:doctor --register-local-key",
        );
    }
    const demo = await db.query("select count(*)::int n, count(*) filter (where slug like 'map-demo-%')::int m from public.venues").catch(() => null);
    if (demo) {
      if (demo.rows[0].n) ok(`${demo.rows[0].n} places in the catalog (${demo.rows[0].m} map demo places; add them with pnpm map:demo)`);
      else bad("no places in the catalog", "the demo data comes from supabase/seed.sql; ask before resetting the database")
    }
    // Demo content from later milestones (recipes from M4, social demo people from M5). A database
    // made before those milestones and only brought up to date with `migration up` lacks them.
    if (addDemo) {
      // Adds only missing rows; one transaction, so a failure changes nothing (docs/22 section 3).
      try {
        const results = [].concat(await db.query(readFileSync("supabase/demo-topup.sql", "utf8")));
        const report = results.filter((r) => r.command === "SELECT" && r.fields.some((f) => f.name === "rows added"));
        const total = results.filter((r) => r.command === "SELECT" && r.fields.some((f) => f.name === "total rows added"));
        for (const row of report.at(-1)?.rows ?? []) info(`added ${row["rows added"]} row(s) to ${row.table}`);
        ok(`demo top-up finished: ${total.at(-1)?.rows[0]["total rows added"] ?? 0} row(s) added; nothing deleted, existing rows unchanged apart from the local demo social switch`);
        const now = await db.query("select exists (select 1 from app.server_keys where purpose = 'rate_limit' and digest = sha256(convert_to($1, 'UTF8'))) as yes", [env.RATE_LIMIT_KEY ?? ""]);
        if (now.rows[0].yes) ok("the database now recognises this app's request-counter key");
        else bad("the database still does not recognise this app's request-counter key", "node scripts/write-local-env.mjs, then pnpm local:doctor --register-local-key");
      } catch (e) {
        await db.query("rollback").catch(() => {});
        bad(`demo top-up stopped and changed nothing (${e.code ?? e.name})`, "run the doctor again and send its output");
      }
    }
    const later = await db
      .query("select (select count(*)::int from public.food_items where kind = 'recipe') as recipes, (select count(*)::int from public.profiles_public where handle = 'demo_maya') as social")
      .catch(() => null);
    if (later) {
      const { recipes, social } = later.rows[0];
      if (recipes >= 10 && social === 1) ok(`demo content from the latest milestones present (${recipes} recipes, social demo people)`);
      else
        bad(
            `demo content looks older than the code (${recipes} recipes, social demo people ${social ? "present" : "missing"}), so some tabs look empty`,
            "pnpm local:doctor --add-missing-demo   (adds the missing demo rows; deletes nothing)",
          );
    }
  } catch (e) {
    bad(`local database not reachable (${e.code ?? e.name})`, "pnpm exec supabase start");
  } finally {
    await db.end().catch(() => {});
  }
}

console.log("\n6. App on port 3000");
const listeners = run("lsof", ["-nP", "-iTCP:3000", "-sTCP:LISTEN"]);
if (listeners === null) info("nothing listening on port 3000 (or lsof is unavailable)");
else {
  const procs = listeners.split("\n").slice(1);
  info(`${procs.length} process(es) listening: ${procs.map((l) => l.split(/\s+/).slice(0, 2).join(" pid ")).join(", ")}`);
  if (procs.length > 1) bad("more than one server on port 3000", "stop the extra one (Ctrl+C in its terminal)");
}
try {
  const res = await fetch("http://localhost:3000/discover", { redirect: "manual", signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  if (body.includes('data-testid="limit-unavailable"')) bad("Discover refuses to search: the request counter could not be checked", "see the FIX lines above");
  else if (body.includes('data-testid="too-many-requests"')) bad("Discover says too many requests", "wait one minute; if it persists, run the doctor again and send its output");
  else if (res.ok) ok(`Discover answered ${res.status}`);
  else bad(`Discover answered ${res.status}`);
} catch {
  info("could not reach http://localhost:3000 (start the app with pnpm dev, or pnpm build && pnpm start)");
}

console.log(problems ? `\n${problems} thing(s) to fix. Run again after fixing.\n` : "\nEverything checked looks right.\n");
process.exitCode = problems ? 1 : 0;
