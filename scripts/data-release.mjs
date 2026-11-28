#!/usr/bin/env node
// Private data releases: how a food-data package reaches the owner's Mac without a Downloads-folder handoff.
// Owner decision L1, 24 Nov 2026 06:02 UTC: "private GitHub release assets" in the PRIVATE repository only.
//
//   node scripts/data-release.mjs check   <package.tar.gz>             read-only: every rule below, no upload
//   node scripts/data-release.mjs publish <package.tar.gz> --confirm   check, then create the private release
//   node scripts/data-release.mjs list                                 the data releases in the private repository
//   node scripts/data-release.mjs push-branch <package.tar.gz> --confirm   check, then add it to the private data branch
//   node scripts/data-release.mjs branch                               the packages on the private data branch
//   node scripts/data-release.mjs report                               retention and growth of the data branch
//
// Two ways to deliver, both checked the same way by `pnpm local:update`: private release assets (needs a session that
// may create releases, such as the owner's own Mac), or the private data branch `data-packages`: an unrelated branch
// that is never merged into main, holds only packages, and is never part of the public CI copy (that copy is built
// from main's files only).
//
// Rules, each one stopping the command:
//   - The repository is the private application repository: never the public CI copy, never a public repository.
//   - The archive's name is vfp-private-beta-data-v<N>-<YYYY-MM-DD>.tar.gz and its .sha256 file matches.
//   - Inside it, every file is on the allowlist (open-data catalog files, research drafts and checks, USDA files,
//     the read-only status tool, the instructions and the checksum lists) and matches SHA256SUMS.txt.
//   - No file holds anything that looks like a credential, a private key, a database backup, a personal email
//     address or a non-local database address.
//   - A release with the same name is never replaced: a changed package needs a new version number.
// The release carries three assets: the archive, its .sha256 and <name>.release.json (format, version, checksums,
// and the newest database change the package needs, so an older copy of the code can refuse it).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

export const PKG_RE = /^vfp-private-beta-data-v(\d+)-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
export const RELEASE_FORMAT = 1;
const PUBLIC_CI = /(^|\/)vfp-ci(\.git)?$/i;
const ALLOWED = [
  /^INSTRUCTIONS\.md$/,
  /^MANIFEST\.json$/,
  /^SHA256SUMS\.txt$/,
  /^catalog\/[a-z0-9.-]+\.csv$/,
  /^menus\/[a-z0-9.-]+\.json$/,
  /^usda\/FoodData_Central_[A-Za-z0-9_.-]+\.(zip|csv|json)$/,
  /^tools\/status\.mjs$/,
];
// Things that must never travel in a data package. Checked on every text file.
const FORBIDDEN = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed token (possibly an API key)"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/postgres(ql)?:\/\/[^\s"'@]+:[^\s"'@]+@(?!127\.0\.0\.1|localhost)[^\s"']+/, "a non-local database address with a password"],
  [/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S{20,}/, "a service key"],
  [/PGDMP/, "a database backup"],
];
const TEST_ROWS = /\b(?:Menu|Review|Batch|Demo) e2e\b[^"\\]*|"is_demo"\s*:\s*true|\bDemo Central Kitchen\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Addresses that may appear: placeholders and restaurants' own published contact addresses are not personal
// user records, but to stay safe only placeholder domains pass; anything else stops the check for a look.
const EMAIL_OK = /@(example\.(com|org|test)|local\.invalid|localhost)$/i;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const gh = (args) => spawnSync("gh", args, { encoding: "utf8" });
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The private repository (owner/name) from the origin remote, refusing the public CI copy and public repositories. */
export function privateRepo() {
  const url = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/);
  if (!m) throw new Error(`the origin remote is not a GitHub repository (${url || "none"}).`);
  const repo = m[1];
  if (PUBLIC_CI.test(repo)) throw new Error(`${repo} is the public CI copy; data releases never go there.`);
  const r = gh(["api", `repos/${repo}`, "--jq", ".private"]);
  if (r.status !== 0) throw new Error(`could not read ${repo} on GitHub: ${(r.stderr || "").trim().split("\n").at(-1)}`);
  if (r.stdout.trim() !== "true") throw new Error(`${repo} is not private; data releases go only to a private repository.`);
  return repo;
}

/** The newest database change on the private repository's main branch: a package needs at least that one. */
export function newestMigration(ref = "origin/main") {
  const r = spawnSync("git", ["ls-tree", "--name-only", `${ref}:supabase/migrations`], { encoding: "utf8" });
  const names = r.status === 0 ? r.stdout.split("\n") : readdirSync("supabase/migrations");
  return names.filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort().at(-1)?.slice(0, 14) ?? null;
}

/** Every rule on the archive. Returns the release manifest; throws with a plain reason on the first failure. */
export function checkPackage(archive) {
  const name = basename(archive);
  const m = name.match(PKG_RE);
  if (!m) throw new Error(`${name} is not named vfp-private-beta-data-v<N>-<YYYY-MM-DD>.tar.gz.`);
  const sumFile = `${archive}.sha256`;
  if (!existsSync(sumFile)) throw new Error(`${name}.sha256 is missing next to the archive.`);
  const want = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
  const got = sha256(archive);
  if (want !== got) throw new Error(`${name} does not match its .sha256 file.`);
  const tmp = mkdtempSync(join(tmpdir(), "vfp-release-check-"));
  try {
    const t = spawnSync("tar", ["xzf", archive, "-C", tmp], { encoding: "utf8" });
    if (t.status !== 0) throw new Error(`${name} could not be unpacked: ${t.stderr.trim()}`);
    const top = readdirSync(tmp);
    const inner = name.replace(/\.tar\.gz$/, "");
    if (top.length !== 1 || top[0] !== inner) throw new Error(`${name} must hold exactly one folder, ${inner}.`);
    const root = join(tmp, inner);
    const files = walk(root).map((f) => relative(root, f));
    const extra = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
    if (extra.length) throw new Error(`files not on the allowlist: ${extra.slice(0, 5).join(", ")}`);
    const sums = readFileSync(join(root, "SHA256SUMS.txt"), "utf8").split("\n").filter(Boolean).map((l) => l.split(/\s+\*?/));
    const listed = new Set(sums.map(([, f]) => f));
    const unlisted = files.filter((f) => f !== "SHA256SUMS.txt" && !listed.has(f));
    if (unlisted.length) throw new Error(`files missing from SHA256SUMS.txt: ${unlisted.slice(0, 5).join(", ")}`);
    const bad = sums.filter(([h, f]) => !existsSync(join(root, f)) || sha256(join(root, f)) !== h).map(([, f]) => f);
    if (bad.length) throw new Error(`files that do not match SHA256SUMS.txt: ${bad.slice(0, 5).join(", ")}`);
    let businessEmails = 0;
    for (const f of files) {
      if (/\.zip$/.test(f)) continue; // USDA archives: public federal data, binary
      const text = readFileSync(join(root, f), "utf8");
      for (const [re, what] of FORBIDDEN) if (re.test(text)) throw new Error(`${f} holds what looks like ${what}.`);
      // Test or demo rows never travel in a data package (v5 held 6 automatic-check results for an e2e test place,
      // which the loader ignored; 24 Nov 2026). Research files name real places only.
      if (/^menus\//.test(f) && TEST_ROWS.test(text)) throw new Error(`${f} holds rows from a test or demo place (${text.match(TEST_ROWS)[0]}); export again without them.`);
      const emails = [...new Set(text.match(EMAIL) ?? [])].filter((e) => !EMAIL_OK.test(e));
      // catalog/ files are named open datasets of businesses (licences, map places); an address there is a business's
      // published contact, recorded with its source in MANIFEST.json. Anywhere else an address stops the check.
      if (emails.length && /^catalog\//.test(f)) businessEmails += emails.length;
      else if (emails.length) throw new Error(`${f} holds ${emails.length} email address(es) that are not placeholders; packages carry no personal records.`);
    }
    const inside = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8"));
    if (inside.version !== `v${m[1]}`) throw new Error(`MANIFEST.json says ${inside.version}, the file name says v${m[1]}.`);
    return {
      format: RELEASE_FORMAT,
      package: name,
      version: Number(m[1]),
      date: m[2],
      tag: `data-v${m[1]}-${m[2]}`,
      archive: { bytes: statSync(archive).size, sha256: got },
      files: sums.length,
      sums: sha256(join(root, "SHA256SUMS.txt")),
      businessContactsInOpenData: businessEmails,
      requiresMigration: newestMigration(),
      builtFrom: spawnSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).stdout.trim(),
      privacy: "Private release asset. No credentials, personal records or backups (checked by scripts/data-release.mjs).",
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}


export const DATA_BRANCH = "data-packages";
export const KEEP = 3; // package versions kept on the branch tip
export const GROWTH_WARN_MB = 500; // above this, propose moving packages to private object storage (docs/82)
const DATA_REF = "refs/vfp/data-packages";
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

/** Fetch the private data branch into a private ref. Returns false when the branch does not exist. */
export function fetchDataBranch() {
  const ls = git(["ls-remote", "--heads", "origin", DATA_BRANCH]);
  if (ls.status !== 0) throw new Error(`could not reach the private repository: ${ls.stderr.trim().split("\n").at(-1)}`);
  if (!ls.stdout.trim()) return false;
  const f = git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${DATA_BRANCH}:${DATA_REF}`]);
  if (f.status !== 0) throw new Error(`could not fetch the data branch: ${f.stderr.trim().split("\n").at(-1)}`);
  return true;
}

/** Release manifests on the fetched data branch, newest version first. */
export function branchPackages() {
  const ls = git(["ls-tree", "--name-only", DATA_REF, "packages/"]);
  if (ls.status !== 0) return [];
  return ls.stdout
    .split("\n")
    .filter((f) => f.endsWith(".release.json"))
    .map((f) => JSON.parse(git(["show", `${DATA_REF}:${f}`]).stdout))
    .sort((a, b) => b.version - a.version);
}

/**
 * Copy one package from the fetched data branch into `dir`. The branch keeps each package as its folder of files
 * (not one archive), so git stores a file that did not change between versions only once.
 */
export function extractFromBranch(pkg, dir) {
  const folder = pkg.replace(/\.tar\.gz$/, "");
  const manifest = JSON.parse(git(["show", `${DATA_REF}:packages/${pkg}.release.json`]).stdout);
  const tmp = `${dir}.incoming-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tar = spawnSync("sh", ["-c", `git archive ${DATA_REF} packages/${folder} | tar x -C "${tmp}"`], { encoding: "utf8" });
  if (tar.status !== 0 || !existsSync(join(tmp, "packages", folder))) throw new Error(`${folder} is missing on the data branch.`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".."), { recursive: true });
  spawnSync("mv", [join(tmp, "packages", folder), dir]);
  rmSync(tmp, { recursive: true, force: true });
  return { dir, manifest, files: walk(dir).length };
}

/** Every check on a package fetched as a folder. Returns plain problems (empty = pass). */
export function verifyFolderAgainstManifest(dir, man, appliedMigration) {
  const problems = [];
  if (man.format !== RELEASE_FORMAT) problems.push(`its manifest format ${man.format} is not one this code reads (${RELEASE_FORMAT}); update the code first.`);
  const m = String(man.package).match(PKG_RE);
  if (!m || Number(m[1]) !== man.version) problems.push(`the manifest's name and version disagree (${man.package}, ${man.version}).`);
  const sumsFile = join(dir, "SHA256SUMS.txt");
  if (!existsSync(sumsFile)) return [...problems, "SHA256SUMS.txt is missing."];
  if (sha256(sumsFile) !== man.sums) problems.push("its list of checksums differs from the one in its manifest.");
  const listed = new Set(readFileSync(sumsFile, "utf8").split("\n").filter(Boolean).map((l) => l.split(/\s+\*?/)[1]));
  const files = walk(dir).map((f) => relative(dir, f));
  const extra = files.filter((f) => f !== "SHA256SUMS.txt" && (!listed.has(f) || !ALLOWED.some((re) => re.test(f))));
  if (extra.length) problems.push(`files that are not on its list or not allowed: ${extra.slice(0, 5).join(", ")}`);
  const missing = [...listed].filter((f) => !files.includes(f));
  if (missing.length) problems.push(`files on its list that are missing: ${missing.slice(0, 5).join(", ")}`);
  if (man.files !== listed.size) problems.push(`the manifest counts ${man.files} files, the list has ${listed.size}.`);
  if (man.requiresMigration && (!appliedMigration || appliedMigration < man.requiresMigration))
    problems.push(`it needs database change ${man.requiresMigration}, and this computer has only up to ${appliedMigration ?? "none"}; update the code first.`);
  return problems;
}

/**
 * Every check on a downloaded package against its release manifest. Returns a list of plain problems (empty = pass).
 * `appliedMigration` is the newest database change already applied on this computer.
 */
export function verifyAgainstManifest(archive, man, appliedMigration) {
  const problems = [];
  const name = basename(archive);
  const m = name.match(PKG_RE);
  if (man.format !== RELEASE_FORMAT) problems.push(`its manifest format ${man.format} is not one this code reads (${RELEASE_FORMAT}); update the code first.`);
  if (man.package !== name) problems.push(`the manifest names ${man.package}, the file is ${name}.`);
  if (!m || Number(m[1]) !== man.version) problems.push(`the manifest says version ${man.version}, the file name says ${m ? m[1] : "none"}.`);
  const want = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0];
  const got = sha256(archive);
  if (got !== man.archive?.sha256 || got !== want) problems.push("the archive does not match the checksum in its manifest and .sha256 file.");
  if (statSync(archive).size !== man.archive?.bytes) problems.push(`the archive is ${statSync(archive).size} bytes; the manifest says ${man.archive?.bytes}.`);
  if (man.requiresMigration && (!appliedMigration || appliedMigration < man.requiresMigration))
    problems.push(`it needs database change ${man.requiresMigration}, and this computer has only up to ${appliedMigration ?? "none"}; update the code first.`);
  return problems;
}

/** Data releases in the private repository, newest version first (REST only). */
export function listReleases(repo) {
  const r = gh(["api", `repos/${repo}/releases?per_page=100`]);
  if (r.status !== 0) throw new Error(`could not list releases: ${(r.stderr || "").trim().split("\n").at(-1)}`);
  return JSON.parse(r.stdout)
    .filter((x) => !x.draft && /^data-v\d+-\d{4}-\d{2}-\d{2}$/.test(x.tag_name))
    .map((x) => ({ id: x.id, tagName: x.tag_name, publishedAt: x.published_at, version: Number(x.tag_name.match(/^data-v(\d+)/)[1]), assets: x.assets.map((a) => ({ id: a.id, name: a.name, size: a.size })) }))
    .sort((a, b) => b.version - a.version);
}

/** Download one release asset to a file (REST, works without GraphQL). */
export function downloadAsset(repo, asset, file) {
  const r = spawnSync("gh", ["api", `repos/${repo}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`could not download ${asset.name}: ${String(r.stderr).trim().split("\n").at(-1)}`);
  writeFileSync(file, r.stdout);
  if (statSync(file).size !== asset.size) throw new Error(`${asset.name} arrived incomplete (${statSync(file).size} of ${asset.size} bytes).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file] = process.argv.slice(2);
  const fail = (msg) => {
    console.error(`STOPPED: ${msg}`);
    process.exit(1);
  };
  try {
    if (cmd === "list") {
      const repo = privateRepo();
      const all = listReleases(repo);
      console.log(all.length ? all.map((x) => `${x.tagName}  ${x.publishedAt}`).join("\n") : `No data releases in ${repo}.`);
    } else if (cmd === "check" || cmd === "publish") {
      if (!file) fail("name the package archive.");
      const man = checkPackage(file);
      console.log(`${man.package}: name, checksum, ${man.files} files, allowlist and content checks pass. Needs database change ${man.requiresMigration} or later.`);
      if (cmd === "check") process.exit(0);
      if (!process.argv.includes("--confirm")) fail("publishing needs --confirm.");
      const repo = privateRepo();
      if (spawnSync("git", ["merge-base", "--is-ancestor", man.builtFrom, "origin/main"]).status !== 0)
        fail("build from a commit that is already on the private repository's main branch.");
      if (listReleases(repo).some((x) => x.tagName === man.tag) || gh(["api", `repos/${repo}/git/ref/tags/${man.tag}`]).status === 0)
        fail(`${man.tag} already exists; a changed package needs a new version number.`);
      const manFile = join(tmpdir(), `${man.package}.release.json`);
      writeFileSync(manFile, JSON.stringify(man, null, 1) + "\n");
      const notes = `Private food-data package ${man.package} (version ${man.version}). Loaded on the owner's local copy by \`pnpm local:update\`, which checks it against ${man.package}.release.json before importing. Not for publication.`;
      const rel = gh(["api", "-X", "POST", `repos/${repo}/releases`, "-f", `tag_name=${man.tag}`, "-f", `target_commitish=${man.builtFrom}`, "-f", `name=Data package v${man.version} (${man.date})`, "-f", `body=${notes}`, "-F", "draft=true"]);
      if (rel.status !== 0) fail(`the release was not created: ${(rel.stderr || "").trim().split("\n").at(-1)}`);
      const id = JSON.parse(rel.stdout).id;
      // Uploaded as a draft first, so a half-uploaded release is never offered to the Mac.
      for (const [f, type] of [[file, "application/gzip"], [`${file}.sha256`, "text/plain"], [manFile, "application/json"]]) {
        const up = gh(["api", "-X", "POST", `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(basename(f))}`, "-H", `Content-Type: ${type}`, "--input", f]);
        if (up.status !== 0) fail(`uploading ${basename(f)} failed; the release stays a draft: ${(up.stderr || "").trim().split("\n").at(-1)}`);
      }
      const done = gh(["api", "-X", "PATCH", `repos/${repo}/releases/${id}`, "-F", "draft=false"]);
      if (done.status !== 0) fail(`the release stays a draft: ${(done.stderr || "").trim().split("\n").at(-1)}`);
      console.log(`Created private release ${man.tag} in ${repo} with 3 assets. Nothing was published outside the private repository.`);
    } else if (cmd === "branch") {
      privateRepo();
      if (!fetchDataBranch()) console.log(`No ${DATA_BRANCH} branch yet.`);
      else for (const p of branchPackages()) console.log(`v${p.version}  ${p.package}  ${p.archive.sha256.slice(0, 12)}  needs ${p.requiresMigration}`);
    } else if (cmd === "report") {
      privateRepo();
      if (!fetchDataBranch()) {
        console.log(`No ${DATA_BRANCH} branch yet.`);
        process.exit(0);
      }
      const objs = spawnSync("sh", ["-c", `git rev-list --objects ${DATA_REF} | cut -d' ' -f1 | git cat-file --batch-check='%(objecttype) %(objectsize) %(objectsize:disk)'`], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n").filter((l) => l.startsWith("blob"));
      const raw = objs.reduce((n, l) => n + Number(l.split(" ")[1]), 0);
      const disk = objs.reduce((n, l) => n + Number(l.split(" ")[2]), 0);
      const commits = Number(git(["rev-list", "--count", DATA_REF]).stdout.trim());
      const pk = branchPackages();
      console.log(`Data branch: ${commits} commit(s); ${pk.length} package(s) on the tip (keeps ${KEEP}): ${pk.map((p) => `v${p.version}`).join(", ")}`);
      console.log(`Stored once each: ${objs.length} distinct files, ${(raw / 1e6).toFixed(1)} MB (${(disk / 1e6).toFixed(1)} MB compressed in git)`);
      console.log(disk / 1e6 > GROWTH_WARN_MB ? `ABOVE ${GROWTH_WARN_MB} MB: time to move packages to private object storage (docs/82).` : `Below the ${GROWTH_WARN_MB} MB review point.`);
    } else if (cmd === "push-branch") {
      if (!file) throw new Error("name the package archive.");
      const man = checkPackage(file);
      console.log(`${man.package}: name, checksum, ${man.files} files, allowlist and content checks pass. Needs database change ${man.requiresMigration} or later.`);
      if (!process.argv.includes("--confirm")) throw new Error("adding to the data branch needs --confirm.");
      privateRepo();
      if (spawnSync("git", ["merge-base", "--is-ancestor", man.builtFrom, "origin/main"]).status !== 0)
        throw new Error("build from a commit that is already on the private repository's main branch.");
      const exists = fetchDataBranch();
      const same = exists ? branchPackages() : [];
      const twin = same.find((p) => p.version === man.version);
      // The same version may be stored again only to move it to the unpacked layout, with identical content.
      const relayout = twin && twin.archive.sha256 === man.archive.sha256 && !twin.sums;
      if (twin && !relayout) throw new Error(`version ${man.version} is already on the data branch; a changed package needs a new version number.`);
      const dup = same.find((p) => p.sums && p.sums === man.sums && p.version !== man.version);
      if (dup) throw new Error(`its contents are identical to v${dup.version}; nothing new to deliver.`);
      const wt = mkdtempSync(join(tmpdir(), "vfp-data-branch-"));
      try {
        const add = exists ? git(["worktree", "add", "--detach", wt, DATA_REF]) : git(["worktree", "add", "--detach", wt, "HEAD"]);
        if (add.status !== 0) throw new Error(`could not prepare the data branch: ${add.stderr.trim()}`);
        const inWt = (args) => git(args, { cwd: wt });
        if (!exists) {
          inWt(["checkout", "--quiet", "--orphan", "vfp-data-tmp"]);
          inWt(["rm", "-rf", "--quiet", "."]);
          writeFileSync(join(wt, "README.md"), "# Private data packages\n\nNever merged into main and never copied to the public CI repository. Each package is read by `pnpm local:update`, which checks it against its `.release.json` before importing. See scripts/data-release.mjs on main.\n");
        }
        mkdirSync(join(wt, "packages"), { recursive: true });
        // Unpacked, so a file that did not change since the last version is stored once (git keeps one copy per
        // distinct content). Archives from the first layout are taken off the tip; history keeps them.
        for (const f of readdirSync(join(wt, "packages")).filter((f) => /\.tar\.gz(\.sha256)?$/.test(f))) inWt(["rm", "--quiet", join("packages", f)]);
        const t = spawnSync("tar", ["xzf", file, "-C", join(wt, "packages")], { encoding: "utf8" });
        if (t.status !== 0) throw new Error(`could not unpack: ${t.stderr.trim()}`);
        writeFileSync(join(wt, "packages", `${man.package}.release.json`), JSON.stringify(man, null, 1) + "\n");
        // Retention: the tip keeps the newest KEEP versions; older ones stay reachable in the branch history.
        const kept = readdirSync(join(wt, "packages")).filter((f) => f.endsWith(".release.json")).map((f) => f.replace(/\.tar\.gz\.release\.json$/, "")).sort((a, b) => Number(b.match(/-v(\d+)-/)[1]) - Number(a.match(/-v(\d+)-/)[1]));
        for (const old of kept.slice(KEEP)) inWt(["rm", "-r", "--quiet", join("packages", old), join("packages", `${old}.tar.gz.release.json`)]);
        inWt(["add", "-A"]);
        const c = inWt(["-c", "user.name=VFP data packages", "-c", "user.email=data-packages@local.invalid", "commit", "--quiet", "-m", `Data package v${man.version} (${man.date})${relayout ? ", stored unpacked" : ""}`]);
        if (c.status !== 0) throw new Error(`could not record the package: ${c.stderr.trim()}`);
        const p = inWt(["push", "--quiet", "origin", `HEAD:refs/heads/${DATA_BRANCH}`]);
        if (p.status !== 0) throw new Error(`the push was refused: ${p.stderr.trim().split("\n").at(-1)}`);
      } finally {
        git(["worktree", "remove", "--force", wt]);
        git(["branch", "-D", "vfp-data-tmp"]);
      }
      console.log(`Added ${man.package} to the private ${DATA_BRANCH} branch. It is never merged into main and never reaches the public CI copy.`);
    } else {
      fail("use: check <archive> | publish <archive> --confirm | list | push-branch <archive> --confirm | branch | report");
    }
  } catch (e) {
    fail(e.message);
  }
}
