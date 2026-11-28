// Owner decision L1 (24 Nov 2026): every rule a data package must pass before it is delivered or imported.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPackage, verifyAgainstManifest, verifyFolderAgainstManifest } from "../../scripts/data-release.mjs";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small package; `files` maps paths inside the package to their text. */
function pkg(files: Record<string, string>, opts: { version?: number; manifestVersion?: string; skipSum?: string; badArchiveSum?: boolean } = {}) {
  const v = opts.version ?? 7;
  const name = `vfp-private-beta-data-v${v}-2026-11-30`;
  const dir = mkdtempSync(join(tmpdir(), "vfp-pkg-test-"));
  made.push(dir);
  const root = join(dir, name);
  const all: Record<string, string> = { "MANIFEST.json": JSON.stringify({ version: opts.manifestVersion ?? `v${v}` }), ...files };
  for (const [f, text] of Object.entries(all)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const sums = Object.entries(all)
    .filter(([f]) => f !== opts.skipSum)
    .map(([f, text]) => `${sha(text)}  ${f}`)
    .join("\n");
  writeFileSync(join(root, "SHA256SUMS.txt"), sums + "\n");
  const archive = join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["czf", archive, "-C", dir, name]);
  writeFileSync(`${archive}.sha256`, `${opts.badArchiveSum ? "0".repeat(64) : sha(readFileSync(archive))}  ${name}.tar.gz\n`);
  return archive;
}

describe("data package checks before delivery", () => {
  it("passes a clean package and records version, checksum and the database change it needs", () => {
    const a = pkg({ "menus/drafts.json": '{"places":[]}', "catalog/open.csv": "id,name,email\n1,Cafe,info@cafe-example.net\n" });
    const m = checkPackage(a);
    expect(m.version).toBe(7);
    expect(m.archive.sha256).toBe(sha(readFileSync(a)));
    expect(m.requiresMigration).toMatch(/^\d{14}$/);
    expect(m.businessContactsInOpenData).toBe(1);
  });
  it("stops on a file outside the allowlist, such as a database backup or settings file", () => {
    expect(() => checkPackage(pkg({ "backup.dump": "x" }))).toThrow(/allowlist/);
    expect(() => checkPackage(pkg({ ".env.local": "x" }))).toThrow(/allowlist/);
  });
  it("stops when the archive or an inner file does not match its checksum list", () => {
    expect(() => checkPackage(pkg({ "menus/a.json": "{}" }, { badArchiveSum: true }))).toThrow(/does not match its \.sha256/);
    expect(() => checkPackage(pkg({ "menus/a.json": "{}" }, { skipSum: "menus/a.json" }))).toThrow(/missing from SHA256SUMS/);
  });
  it("stops on anything that looks like a credential, a backup or a personal address", () => {
    expect(() => checkPackage(pkg({ "menus/a.json": `{"k":"sk_live_${"a".repeat(24)}"}` }))).toThrow(/API key/);
    expect(() => checkPackage(pkg({ "menus/a.json": "-----BEGIN RSA PRIVATE KEY-----" }))).toThrow(/private key/);
    expect(() => checkPackage(pkg({ "menus/a.json": '{"by":"someone@gmail.com"}' }))).toThrow(/email address/);
    expect(() => checkPackage(pkg({ "menus/a.json": '{"by":"tester@example.test"}' }))).not.toThrow();
  });
  it("stops on rows from a test or demo place", () => {
    expect(() => checkPackage(pkg({ "menus/machine-checks.json": '{"checks":[{"key":"[\\"Menu e2e Automatic 13b26fee\\",\\"Soup\\"]"}]}' }))).toThrow(/test or demo place/);
    expect(() => checkPackage(pkg({ "menus/a.json": '{"is_demo": true}' }))).toThrow(/test or demo place/);
    // A checksum that happens to contain "e2e" is not a test row.
    expect(() => checkPackage(pkg({ "menus/a.json": '{"pageSha256":"0b3fb9d3ecec85a3ea29e2e736597cee"}' }))).not.toThrow();
  });
  it("stops when the inner manifest and the file name disagree on the version", () => {
    expect(() => checkPackage(pkg({}, { manifestVersion: "v6" }))).toThrow(/MANIFEST\.json says v6/);
  });
});

describe("data package checks before import", () => {
  it("accepts a package that matches its release manifest on a computer with the needed database change", () => {
    const a = pkg({ "menus/a.json": "{}" });
    const m = checkPackage(a);
    expect(verifyAgainstManifest(a, m, m.requiresMigration)).toEqual([]);
  });
  it("refuses an incompatible package: newer format, or a database change this computer lacks", () => {
    const a = pkg({ "menus/a.json": "{}" });
    const m = checkPackage(a);
    expect(verifyAgainstManifest(a, { ...m, format: 2 }, m.requiresMigration).join(" ")).toMatch(/format 2/);
    expect(verifyAgainstManifest(a, m, "20200101000000").join(" ")).toMatch(/needs database change/);
  });
  it("refuses a package that differs from its manifest in name, version, size or checksum", () => {
    const a = pkg({ "menus/a.json": "{}" });
    const m = checkPackage(a);
    expect(verifyAgainstManifest(a, { ...m, version: 8 }, m.requiresMigration).join(" ")).toMatch(/version 8/);
    expect(verifyAgainstManifest(a, { ...m, archive: { ...m.archive, sha256: "0".repeat(64) } }, m.requiresMigration).join(" ")).toMatch(/checksum/);
    expect(verifyAgainstManifest(a, { ...m, archive: { ...m.archive, bytes: 1 } }, m.requiresMigration).join(" ")).toMatch(/bytes/);
  });
});

describe("a package fetched from the data branch as a folder", () => {
  function folder() {
    const a = pkg({ "menus/a.json": '{"places":[]}' });
    const m = checkPackage(a);
    const dir = join(a, "..", "unpacked");
    mkdirSync(dir);
    execFileSync("tar", ["xzf", a, "-C", dir]);
    return { root: join(dir, m.package.replace(/\.tar\.gz$/, "")), m };
  }
  it("passes when its files match the list the manifest names", () => {
    const { root, m } = folder();
    expect(verifyFolderAgainstManifest(root, m, m.requiresMigration)).toEqual([]);
  });
  it("refuses an added file, a missing file or a changed list of checksums", () => {
    let f = folder();
    writeFileSync(join(f.root, "menus", "extra.json"), "{}");
    expect(verifyFolderAgainstManifest(f.root, f.m, f.m.requiresMigration).join(" ")).toMatch(/not on its list/);
    f = folder();
    rmSync(join(f.root, "menus", "a.json"));
    expect(verifyFolderAgainstManifest(f.root, f.m, f.m.requiresMigration).join(" ")).toMatch(/missing/);
    f = folder();
    writeFileSync(join(f.root, "SHA256SUMS.txt"), "0  menus/a.json\n");
    expect(verifyFolderAgainstManifest(f.root, f.m, f.m.requiresMigration).join(" ")).toMatch(/list of checksums differs/);
  });
});
