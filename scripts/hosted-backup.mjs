#!/usr/bin/env node
// Weekly backup of the hosted database, run by the owner on his Mac (docs/99 section 6). The Supabase Free plan makes
// no automatic backups, and the draft privacy notice promises "a copy once a week, each deleted after 4 weeks".
// This script is that routine. It only READS the hosted database.
//
//   node scripts/hosted-backup.mjs --env-file <hosted env file> [--out ~/vfp-backups/hosted] [--keep-days 28]
//
// 1. Refuses unless the address belongs to the project named by VFP_HOSTED_REF (scripts/lib/db-target.mjs), or is a
//    local database (for rehearsal). Never prints the address or its password.
// 2. On a Mac, refuses unless FileVault (disk encryption) is on, so backups are encrypted at rest.
// 3. Makes a full pg_dump (custom format) with the local Supabase database container's own pg_dump (same Postgres
//    major version as Supabase; nothing to install), checks that pg_restore can read it, and records its SHA-256.
// 4. Deletes this script's own backups older than --keep-days (default 28), and nothing else.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { classifyTarget } from "./lib/db-target.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
const envFile = flag("--env-file");
const env = envFile ? { ...process.env, ...readEnv(envFile) } : process.env;
const url = env.DATABASE_URL;
if (!url) throw new Error("No DATABASE_URL (give --env-file with the hosted settings). Nothing done.");
const target = classifyTarget(url, env);
if (target.kind === "refused") throw new Error(`Refused: ${target.reason}. Nothing done.`);

if (platform() === "darwin") {
  const fv = execFileSync("fdesetup", ["status"], { encoding: "utf8" });
  if (!/FileVault is On/.test(fv)) throw new Error("Refused: FileVault (disk encryption) is off, so a backup would not be encrypted. Turn it on in System Settings, Privacy & Security. Nothing done.");
} else if (target.kind === "hosted") {
  throw new Error("Refused: hosted backups are made only on the owner's Mac, where disk encryption is checked. Nothing done.");
}

const container = env.VFP_DB_CONTAINER ?? "supabase_db_vegetarian-food-platform";
const out = (flag("--out") ?? join(homedir(), "vfp-backups", "hosted")).replace(/^~(?=\/)/, homedir());
const keepDays = Number(flag("--keep-days") ?? 28);
if (!(keepDays >= 1 && keepDays <= 90)) throw new Error("--keep-days must be between 1 and 90.");
mkdirSync(out, { recursive: true, mode: 0o700 });

// Inside the container a local address is the container's own server on port 5432.
const inner = target.kind === "local" ? url.replace(/@(127\.0\.0\.1|localhost):\d+/, "@127.0.0.1:5432") : url;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const name = `hosted-${target.kind === "hosted" ? target.ref : "local"}-${stamp}.dump`;
const file = join(out, name);
const dump = execFileSync("docker", ["exec", "-e", "DB_URL", container, "sh", "-c", 'pg_dump --format=custom --no-owner --exclude-schema=cron "$DB_URL"'], {
  env: { ...process.env, DB_URL: inner },
  maxBuffer: 2 * 1024 * 1024 * 1024,
});
writeFileSync(file, dump, { mode: 0o600 });
const sha = createHash("sha256").update(dump).digest("hex");
// pg_restore needs a seekable file, so the check reads a temporary copy inside the container, then removes it.
const tmp = `/tmp/${name}`;
execFileSync("docker", ["cp", file, `${container}:${tmp}`]);
let entries;
try {
  entries = execFileSync("docker", ["exec", container, "pg_restore", "--list", tmp], { maxBuffer: 256 * 1024 * 1024 })
    .toString()
    .split("\n")
    .filter((l) => l && !l.startsWith(";")).length;
} finally {
  execFileSync("docker", ["exec", container, "rm", "-f", tmp]);
}
if (entries < 100) throw new Error(`The backup looks incomplete (${entries} entries). It was kept at ${file} for inspection.`);
writeFileSync(`${file}.sha256`, `${sha}  ${name}\n`, { mode: 0o600 });

// Remove only this script's own files older than the retention period.
const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
const removed = [];
for (const f of readdirSync(out)) {
  if (!/^hosted-[a-z0-9]+-\d{8}T\d{6}Z\.dump(\.sha256)?$/.test(f)) continue;
  if (statSync(join(out, f)).mtimeMs < cutoff) {
    rmSync(join(out, f));
    removed.push(f);
  }
}
console.log(JSON.stringify({ backup: file, bytes: dump.length, sha256: sha, entries, removedOlderThanDays: keepDays, removed }, null, 2));
