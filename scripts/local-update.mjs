#!/usr/bin/env node
// One-command update of the owner's LOCAL copy: code, database changes and the private data package.
// Owner direction 24 Nov 2026 03:27 UTC (M1): "routine code and data updates should not require me to download and
// manually transfer new packages every time". LOCAL ONLY. It never resets, deletes, overwrites or publishes anything,
// never prints a secret, and stops at the first unexpected result.
//
//   pnpm local:update                 code + database changes + the newest approved data package, fetched
//                                     automatically from the private repository (data branch, else release assets),
//                                     else the newest package in ~/vfp-transfer or ~/Downloads
//   pnpm local:update --check         read-only: says what an update would do, changes nothing
//   pnpm local:update --release <tag> use that release of the private repository
//   pnpm local:update --package <file.tar.gz>   use this package file
//   pnpm local:update --no-fetch      do not look in the private repository (folders only)
//   pnpm local:update --database-url postgresql://postgres:postgres@127.0.0.1:<port>/postgres
//                                     REHEARSAL on an isolated copy (a restored backup in a throwaway container on
//                                     another port): every step (backup, database changes, package, counts) goes to
//                                     that copy only; the code is not touched and nothing is recorded as loaded.
//   pnpm local:update --no-code       leave the code as it is (data only)
//
// Steps, each one stopping the update on any surprise:
//   1. Safety: a local database only, no uncommitted changes to tracked files.
//   2. Code: fast-forward to the latest main (never a merge, rebase or reset); `pnpm install` only if the lockfile moved.
//   3. Backup: a full database backup in ~/vfp-backups, checked readable, with its SHA-256.
//   4. Counts before.
//   5. Database changes: applies pending migration files only if none contains a statement that removes data
//      outside a function body (DROP TABLE, DROP COLUMN, TRUNCATE, DELETE FROM, UPDATE ... SET). Otherwise it stops
//      and names the file, because removing data needs the owner's approval.
//   6. Data package: a fetched package must match its release manifest exactly (format, name, version, size,
//      checksum) and must not need a newer database change than this computer has; an older version than one already
//      loaded is never loaded. Then the checksum of every file inside, the idempotent loader (a dry run first), and a
//      read-only comparison that lists anything the package holds and the database lacks.
//   7. Counts after: personal data, switches and the published catalog must be identical, and no catalog or menu
//      figure may go down. Any other change is listed.
//   8. `pnpm local:doctor`, and a short report in ~/vfp-backups.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { branchPackages, downloadAsset, extractFromBranch, fetchDataBranch, listReleases, privateRepo, verifyAgainstManifest, verifyFolderAgainstManifest } from "./data-release.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);
const CHECK = has("--check");
const REHEARSAL = val("--database-url") ?? null;
const HOME = process.env.VFP_HOME ?? homedir();
const BACKUPS = join(HOME, "vfp-backups");
const TRANSFER = join(HOME, "vfp-transfer");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
const REPORT = join(BACKUPS, `${REHEARSAL ? "rehearsal" : "update"}-${STAMP}.txt`);
const PKG_RE = /^vfp-private-beta-data-v(\d+)-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;

const LIVE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const url = REHEARSAL ?? process.env.DATABASE_URL ?? LIVE_URL;
const port = (url.match(/@[^:/]+:(\d+)\//) ?? [])[1];
// Every child step (loader, verify) reads DATABASE_URL, so in a rehearsal they reach only the copy.
process.env.DATABASE_URL = url;
const lines = [];
const say = (s = "") => {
  console.log(s);
  lines.push(s);
};
function stop(why, code = 1) {
  say(`\nSTOPPED: ${why}`);
  say("Nothing after this step was done. Earlier steps are listed above.");
  finish(code);
}
function finish(code) {
  if (!CHECK) {
    mkdirSync(BACKUPS, { recursive: true });
    writeFileSync(REPORT, lines.join("\n") + "\n");
    console.log(`\nReport: ${REPORT}`);
  }
  process.exit(code);
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const tryRun = (cmd, args) => {
  try {
    return run(cmd, args);
  } catch {
    return null;
  }
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ---------- 1. Safety ----------
say(`Local update, ${new Date().toISOString()}${CHECK ? " (check only: nothing will change)" : ""}${REHEARSAL ? ` REHEARSAL on the isolated copy at port ${port}` : ""}`);
if (!/@(127\.0\.0\.1|localhost):/.test(url)) stop("this runs only against a database on this computer.", 2);
if (REHEARSAL && (!port || port === "54322")) stop("a rehearsal needs the isolated copy's own port, not the live database's 54322.", 2);
const containers = (tryRun("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"]) ?? "").split("\n").map((l) => l.split("\t"));
const container = REHEARSAL
  ? containers.find(([, ports]) => new RegExp(`(127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}->5432`).test(ports ?? ""))?.[0]
  : containers.find(([n]) => n.startsWith("supabase_db_"))?.[0];
if (!container) stop(REHEARSAL ? `no running container serves port ${port}; start the isolated copy first.` : "the local database is not running. Start it with `pnpm exec supabase start`, then run this again.", 2);
if (REHEARSAL && container.startsWith("supabase_db_")) stop(`port ${port} is the live local stack (${container}), not an isolated copy.`, 2);
const tracked = (tryRun("git", ["status", "--porcelain", "--untracked-files=no"]) ?? "").split("\n").filter(Boolean);
if (tracked.length) stop(`${tracked.length} tracked file(s) have local changes. They are kept as they are; commit or put them aside first.`, 2);

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;

// The figures that must never change in an update, and the ones a package may change.
const PROTECTED = [
  ["accounts", "select count(*)::int n from auth.users"],
  ["diary entries", "select count(*)::int n from public.diary_entries"],
  ["goal versions", "select count(*)::int n from public.goal_versions"],
  ["reviews", "select count(*)::int n from public.reviews"],
  ["lists", "select count(*)::int n from public.food_lists"],
  ["list items", "select count(*)::int n from public.food_list_items"],
  ["saves", "select count(*)::int n from public.saves"],
  ["follows", "select count(*)::int n from public.follows"],
  ["founder saved meals", "select count(*)::int n from staging.preview_saves"],
  ["rankings", "select count(*)::int n from public.ranking_entries"],
  ["founder meal reviews", "select count(*)::int n from staging.preview_reviews"],
  ["founder list entries", "select count(*)::int n from staging.preview_list_entries"],
  ["founder meal plans", "select count(*)::int n from staging.preview_meal_plans"],
  ["fact confirmations", "select count(*)::int n from staging.fact_confirmations"],
  ["public listings", "select count(*)::int n from public.place_listings where visibility = 'public'"],
  ["switches on", "select count(*)::int n from app.platform_switches where enabled"],
  ["member beta on", "select count(*)::int n from staging.member_beta_switch where enabled"],
  ["beta in reviewed-meals mode", "select count(*)::int n from staging.member_beta_switch where meal_mode = 'reviewed_meals'"],
  ["invite-only on", "select count(*)::int n from app.invite_settings where enabled"],
  ["tester meal decisions", "select count(*)::int n from staging.tester_meal_decisions"],
];
const MAY_CHANGE = [
  ["menu places", "select count(*)::int n from staging.places"],
  ["menu dishes", "select count(*)::int n from staging.dishes"],
  ["menu facts", "select count(*)::int n from staging.facts"],
  ["automatic checks", "select count(*)::int n from staging.fact_machine_checks"],
  ["linked restaurants", "select count(*)::int n from staging.live_catalog_links"],
  ["private listings", "select count(*)::int n from public.place_listings"],
  ["real recipes", "select count(*)::int n from public.food_items where kind = 'recipe' and not is_demo"],
];
async function counts() {
  const out = {};
  for (const [name, sql] of [...PROTECTED, ...MAY_CHANGE]) {
    try {
      out[name] = (await q(sql))[0].n;
    } catch {
      out[name] = null; // a table this code version does not have yet
    }
  }
  return out;
}

// ---------- 2. Code ----------
say("\n1. Code");
const before = tryRun("git", ["rev-parse", "--short", "HEAD"]);
let lockMoved = false;
if (has("--no-code") || REHEARSAL) say(`  kept at ${before} (${REHEARSAL ? "rehearsal: the code is never changed" : "--no-code"})`);
else {
  if (tryRun("git", ["fetch", "--quiet", "origin", "main"]) === null) stop("could not reach GitHub to fetch main. Check the internet connection, then run this again.");
  const main = run("git", ["rev-parse", "--short", "FETCH_HEAD"]);
  const behind = Number(run("git", ["rev-list", "--count", "HEAD..FETCH_HEAD"]));
  const ahead = Number(run("git", ["rev-list", "--count", "FETCH_HEAD..HEAD"]));
  if (ahead > 0) stop(`this copy has ${ahead} commit(s) that main does not. They are kept; nothing was merged.`);
  if (behind === 0) say(`  already at main ${main}`);
  else if (CHECK) say(`  would fast-forward ${before} -> ${main} (${behind} commit(s))`);
  else {
    lockMoved = Boolean(tryRun("git", ["diff", "--name-only", "HEAD", "FETCH_HEAD", "--", "pnpm-lock.yaml"]));
    run("git", ["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
    say(`  fast-forwarded ${before} -> ${main} (${behind} commit(s))`);
    if (lockMoved) {
      run("pnpm", ["install", "--frozen-lockfile"], { stdio: ["ignore", "ignore", "pipe"] });
      say("  dependencies updated (pnpm install --frozen-lockfile)");
    }
    if (behind > 0) say("  The code changed: restart the app server so it serves the new code.");
  }
}

// ---------- 3. Backup ----------
let backupFile = null;
say("\n2. Backup");
if (CHECK) say(`  would back up the whole database into ${BACKUPS}`);
else {
  mkdirSync(BACKUPS, { recursive: true });
  const dump = join(BACKUPS, `${REHEARSAL ? "rehearsal-copy" : "before-update"}-${STAMP}.dump`);
  const r = spawnSync("docker", ["exec", container, "pg_dump", "-U", "postgres", "-Fc", "postgres"], { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !r.stdout?.length) stop("the backup did not complete, so nothing was changed.");
  writeFileSync(dump, r.stdout);
  const readable = spawnSync("docker", ["exec", "-i", container, "pg_restore", "-l"], { input: r.stdout, maxBuffer: 1 << 30 });
  if (readable.status !== 0) stop(`the backup ${dump} could not be read back, so nothing was changed.`);
  backupFile = dump;
  const mb = (statSync(dump).size / 1e6).toFixed(1);
  say(`  ${basename(dump)}, ${mb} MB, readable; SHA-256 ${sha256(dump).slice(0, 16)}…`);
}

// ---------- 4. Counts before ----------
const c0 = await counts();

// ---------- 5. Database changes ----------
say("\n3. Database changes");
const files = readdirSync("supabase/migrations").filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const applied = new Set((await q("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
const pending = files.filter((f) => !applied.has(f.split("_")[0]));
/** Statements that remove or rewrite rows, outside function bodies and comments (the rollback notes are comments). */
function removesData(sql) {
  const body = sql
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const kinds = [
    ["DROP TABLE", /\bdrop\s+table\b/i],
    ["DROP COLUMN", /\bdrop\s+column\b/i],
    ["DROP SCHEMA", /\bdrop\s+schema\b/i],
    ["TRUNCATE", /(^|;)\s*truncate\b/im],
    ["DELETE FROM", /(^|;|\))\s*delete\s+from\b/im],
    ["UPDATE ... SET", /(^|;|\))\s*update\s+[\w."]+\s+set\b/im],
  ];
  return kinds.filter(([, re]) => re.test(body)).map(([name]) => name);
}
if (!pending.length) say(`  none pending (${files.length} applied)`);
else {
  for (const f of pending) {
    const hits = removesData(readFileSync(join("supabase/migrations", f), "utf8"));
    if (hits.length) stop(`the database change ${f} contains ${hits.join(", ")} outside a function. Removing or rewriting data needs the owner's approval, so it was not applied.`);
    say(`  pending: ${f} (adds only)`);
  }
  if (CHECK) say(`  would apply ${pending.length}`);
  else {
    if (REHEARSAL) {
      // The copy is not the Supabase stack, so the CLI cannot reach it: each file runs in its own transaction and is
      // recorded the way the CLI records it.
      for (const f of pending) {
        const sql = readFileSync(join("supabase/migrations", f), "utf8");
        try {
          await client.query("begin");
          await client.query(sql);
          await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.split("_")[0], f.replace(/^\d+_|\.sql$/g, ""), [sql]]);
          await client.query("commit");
        } catch (e) {
          await client.query("rollback").catch(() => {});
          stop(`applying ${f} to the copy failed: ${e.message}`);
        }
      }
    } else {
      const r = spawnSync("pnpm", ["exec", "supabase", "migration", "up"], { encoding: "utf8" });
      if (r.status !== 0) stop(`applying the database changes failed: ${(r.stderr || r.stdout).split("\n").filter(Boolean).slice(-1)[0] ?? "no message"}`);
    }
    const now = new Set((await q("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
    const still = files.filter((f) => !now.has(f.split("_")[0]));
    if (still.length) stop(`${still.length} database change(s) still pending after applying: ${still.join(", ")}`);
    say(`  applied ${pending.length}; ${files.length} in all, none pending`);
  }
}

// ---------- 6. Data package ----------
say("\n4. Data package");
const LOG = join(BACKUPS, "loaded-packages.json");
const loaded = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
let archive = val("--package") ? resolve(val("--package")) : null;
let manifest = null;
let fetchedDir = null; // a package fetched from the data branch arrives as its folder of files, not an archive
const versionOf = (n) => Number((basename(n).match(PKG_RE) ?? [])[1] ?? 0);
const newestLoaded = Math.max(0, ...loaded.map((p) => versionOf(p.package)));
const appliedMigration = (await q("select max(version) v from supabase_migrations.schema_migrations"))[0]?.v ?? null;
const tag = val("--release");
if (tag && !/^data-v\d+-\d{4}-\d{2}-\d{2}$/.test(tag)) stop(`"${tag}" is not a data release name (data-v<N>-<date>).`, 2);
if (!archive && !has("--no-fetch")) {
  // The private repository: the data branch first, then release assets. Read-only until a newer package is found.
  try {
    const repo = privateRepo();
    let pick = null;
    if (!tag && fetchDataBranch()) {
      const p = branchPackages()[0];
      if (p) pick = { from: "the private data branch", name: p.package, version: p.version, folder: true, get: (dir) => extractFromBranch(p.package, dir) };
    }
    if (!pick) {
      const rels = listReleases(repo).filter((r) => !tag || r.tagName === tag);
      if (tag && !rels.length) stop(`release ${tag} is not in the private repository.`);
      const r = rels[0];
      const a = r?.assets.find((x) => PKG_RE.test(x.name));
      if (r && a)
        pick = {
          from: `release ${r.tagName}`,
          name: a.name,
          version: r.version,
          get: (dir) => {
            for (const n of [a.name, `${a.name}.sha256`, `${a.name}.release.json`]) {
              const asset = r.assets.find((x) => x.name === n);
              if (!asset) throw new Error(`${n} is missing from release ${r.tagName}.`);
              downloadAsset(repo, asset, join(dir, n));
            }
            return join(dir, a.name);
          },
        };
    }
    if (!pick) say("  the private repository has no data package yet; looking in folders");
    else if (pick.version < newestLoaded) say(`  newest package there is v${pick.version}, older than v${newestLoaded} already loaded; nothing to fetch`);
    else if (pick.version === newestLoaded && !tag) say(`  v${pick.version}, the newest in ${pick.from}, is already loaded here; nothing to fetch`);
    if (pick && (pick.version > newestLoaded || tag)) {
      const dir = join(TRANSFER, "incoming", pick.name.replace(/\.tar\.gz$/, ""));
      if (CHECK) say(`  would fetch ${pick.name} from ${pick.from} into ${dir}`);
      else if (pick.folder) {
        const got = pick.get(dir);
        fetchedDir = got.dir;
        manifest = got.manifest;
        say(`  fetched ${pick.name} from ${pick.from} (${got.files} files)`);
      } else {
        archive = pick.get(dir);
        say(`  fetched ${pick.name} from ${pick.from}`);
      }
      if (archive) manifest = JSON.parse(readFileSync(`${archive}.release.json`, "utf8"));
    }
  } catch (e) {
    say(`  could not use the private repository (${e.message}); looking in folders`);
  }
}
const fetchedNothing = !archive && !fetchedDir;
if (!archive && !tag && fetchedNothing) {
  // The newest package in the transfer folder or Downloads.
  const found = [TRANSFER, join(HOME, "Downloads")]
    .filter(existsSync)
    .flatMap((d) => readdirSync(d).filter((f) => PKG_RE.test(f)).map((f) => join(d, f)))
    .sort((a, b) => versionOf(b) - versionOf(a));
  archive = found[0] ?? null;
}
if (archive && existsSync(`${archive}.release.json`) && !manifest) manifest = JSON.parse(readFileSync(`${archive}.release.json`, "utf8"));
if (archive && versionOf(archive) < newestLoaded) {
  say(`  ${basename(archive)} is older than v${newestLoaded}, which is already loaded; it is not loaded again`);
  archive = null;
}
if (fetchedDir) {
  const problems = verifyFolderAgainstManifest(fetchedDir, manifest, appliedMigration);
  if (problems.length) stop(`${manifest.package} failed its release checks:\n  - ${problems.join("\n  - ")}`);
  say(`  release manifest: format, name, version ${manifest.version}, file list and checksums match; needs database change ${manifest.requiresMigration}, this computer has ${appliedMigration}`);
} else if (archive && manifest) {
  const problems = verifyAgainstManifest(archive, manifest, appliedMigration);
  if (problems.length) stop(`${basename(archive)} failed its release checks:\n  - ${problems.join("\n  - ")}`);
  say(`  release manifest: format, name, version ${manifest.version}, size and checksum match; needs database change ${manifest.requiresMigration}, this computer has ${appliedMigration}`);
} else if (archive) say("  no release manifest next to this package: checked by its checksums only");
function loadPackage(name, got) {
  const already = loaded.find((p) => p.sha256 === got);
    const sums = readFileSync(join(pkgDir, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean);
    const bad = sums.filter((l) => {
      const [h, f] = l.split(/\s+\*?/);
      return !existsSync(join(pkgDir, f)) || sha256(join(pkgDir, f)) !== h;
    });
    if (bad.length) stop(`${bad.length} file(s) inside the package do not match its list of checksums: ${bad.slice(0, 3).map((l) => l.split(/\s+/)[1]).join(", ")}`);
    say(`  ${sums.length} files inside: all checksums match`);
    const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
    const loader = ["scripts/private-beta-load.mjs", "load", join(pkgDir, "menus"), "--usda", join(pkgDir, "usda")];
    const dry = node([...loader, "--dry-run"]);
    if (dry.status !== 0) stop(`the loader's dry run failed: ${(dry.stderr || dry.stdout).split("\n").filter(Boolean).slice(-1)[0]}`);
    for (const l of dry.stdout.split("\n").filter((x) => /^Dry run|would/.test(x))) say(`  ${l}`);
    if (!CHECK) {
      const real = node(loader);
      if (real.status !== 0) stop(`the loader failed: ${(real.stderr || real.stdout).split("\n").filter(Boolean).slice(-1)[0]}`);
      for (const l of real.stdout.split("\n").filter((x) => /^(Added|Recorded|The researched|Done)/.test(x))) say(`  ${l}`);
    }
    const ver = node(["scripts/private-beta-load.mjs", "verify", join(pkgDir, "menus")]);
    for (const l of ver.stdout.split("\n").filter(Boolean)) say(`  ${l}`);
    if (!CHECK && ver.status !== 0) stop("the database lacks records the package holds (listed above). They were not removed or replaced; this needs a look.");
    if (!CHECK && !already && !REHEARSAL) {
      loaded.push({ package: name, sha256: got, loadedAt: new Date().toISOString(), code: tryRun("git", ["rev-parse", "--short", "HEAD"]) });
      writeFileSync(LOG, JSON.stringify(loaded, null, 1) + "\n");
    }
  }
let pkgDir = null;
if (fetchedDir) {
  pkgDir = fetchedDir;
  loadPackage(manifest.package, manifest.archive.sha256);
} else if (!archive) say(CHECK ? "  no package to load without fetching first (see above); data left as it is" : `  no new data package (looked in the private repository, ${TRANSFER} and ~/Downloads); data left as it is`);
else {
  const name = basename(archive);
  const sumFile = `${archive}.sha256`;
  if (!existsSync(sumFile)) stop(`${name} has no ${name}.sha256 next to it, so it cannot be checked.`);
  const want = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
  const got = sha256(archive);
  if (want !== got) stop(`${name} does not match its checksum (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…). It may be incomplete; download it again.`);
  say(`  ${name}: checksum matches`);
  pkgDir = join(TRANSFER, name.replace(/\.tar\.gz$/, ""));
  if (!existsSync(pkgDir)) {
    if (CHECK) say(`  would unpack into ${pkgDir}`);
    else {
      const tmp = `${pkgDir}.unpacking-${STAMP}`;
      mkdirSync(tmp, { recursive: true });
      run("tar", ["xzf", archive, "-C", tmp]);
      const inner = join(tmp, name.replace(/\.tar\.gz$/, ""));
      if (!existsSync(inner)) stop(`${name} does not contain the folder ${basename(pkgDir)}. Unpacked copy left in ${tmp} for a look.`);
      mkdirSync(TRANSFER, { recursive: true });
      renameSync(inner, pkgDir);
    }
  }
  if (existsSync(pkgDir)) loadPackage(name, got);
}

// ---------- 7. Counts after ----------
say("\n5. Counts");
const c1 = await counts();
let broken = 0;
for (const [name] of PROTECTED) {
  if (c0[name] === c1[name]) continue;
  // A table added by this update's database changes (absent before) is not a change of data.
  if (c0[name] === null && (c1[name] === 0 || name === "beta in reviewed-meals mode")) continue;
  broken += 1;
  say(`  DISCREPANCY  ${name}: ${c0[name]} -> ${c1[name]}`);
}
const unread = [...PROTECTED, ...MAY_CHANGE].filter(([n]) => c1[n] === null).map(([n]) => n);
if (unread.length) say(`  could not count: ${unread.join(", ")}`);
for (const [name] of MAY_CHANGE) {
  if (c0[name] === c1[name]) continue;
  if (c0[name] !== null && c1[name] !== null && c1[name] < c0[name]) {
    broken += 1;
    say(`  DISCREPANCY  ${name}: ${c0[name]} -> ${c1[name]} (an update only adds; nothing should go down)`);
  } else say(`  changed      ${name}: ${c0[name]} -> ${c1[name]}`);
}
say(`  unchanged    ${PROTECTED.filter(([n]) => c0[n] === c1[n]).map(([n]) => n).join(", ")}`);
await client.end();
if (broken) stop(`${broken} figure(s) changed in a way an update never should. The backup from step 2 holds the earlier state; restoring it is the owner's decision.`);

// ---------- 8. Doctor ----------
say("\n6. Local check");
if (REHEARSAL) say("  skipped: the local check looks at the live app, not the copy");
else {
  const doc = spawnSync(process.execPath, ["scripts/local-doctor.mjs"], { encoding: "utf8" });
  const fixes = doc.stdout.split("\n").filter((l) => l.includes("FIX"));
  say(fixes.length ? fixes.map((l) => `  ${l.trim()}`).join("\n") : "  every check OK");
}
if (!CHECK && backupFile && !REHEARSAL)
  say(`\nTo undo this update: code back to ${before} (\`git checkout ${before}\`), and the database from ${basename(backupFile)}. Restoring replaces the whole local database, so it is the owner's decision; the steps are in docs/82.`);
say(`\n${CHECK ? "Check finished: nothing was changed." : REHEARSAL ? `Rehearsal finished on the copy at port ${port}. The live database was not touched.` : "Update finished. Nothing was confirmed, verified, published or deleted."}`);
finish(0);
