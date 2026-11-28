import "server-only";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { findDishExcerpts, foldWithMap, htmlToText, type FoldedText, type OriginalWording } from "@/contracts/original-wording";
import { rpc } from "@/server/social";

/**
 * The founder's private copies of the saved menu pages (owner directive 27 Nov 2026 06:04 UTC, section 4).
 *
 * VFP_EVIDENCE_DIR names a folder on the founder's own computer holding the exact files that were saved when each
 * menu was read (for example the evidence package's `originals/` and `text-extracts/` folders). A file is used only
 * when its SHA-256 equals the hash the automatic comparison recorded, so the words shown are from the very page the
 * draft was checked against. Nothing is copied into the database, logged, exported or published; only short
 * excerpts are shown, and only on founder-only pages (the database refuses anyone else the page hashes).
 */
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 400;

type Entry = { file: string; kind: "html" | "pdf" | "other"; text: FoldedText | null };
let memo: { key: string; byHash: Map<string, Entry> } | null = null;

function walk(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, depth + 1));
    else if (st.isFile() && st.size <= MAX_FILE) out.push(p);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function load(dir: string): Map<string, Entry> {
  const files = walk(dir);
  const key = files.map((f) => `${f}:${statSync(f).size}:${statSync(f).mtimeMs}`).join("|");
  if (memo?.key === key) return memo.byHash;
  // A PDF's words come from a plain-text copy made from it ("<name>.reading-order.txt" or "<name>.txt").
  const texts = new Map<string, string>();
  for (const f of files) if (extname(f).toLowerCase() === ".txt") texts.set(basename(f).replace(/(\.reading-order)?\.txt$/i, ""), f);
  const byHash = new Map<string, Entry>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (ext === ".txt") continue;
    const bytes = readFileSync(f);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const kind = ext === ".pdf" ? "pdf" : ext === ".html" || ext === ".htm" ? "html" : "other";
    const side = texts.get(basename(f, extname(f)));
    const text = kind === "html" ? htmlToText(bytes.toString("utf8")) : side ? readFileSync(side, "utf8") : kind === "other" ? bytes.toString("utf8") : null;
    byHash.set(sha, { file: basename(f), kind, text: text === null ? null : foldWithMap(text) });
  }
  memo = { key, byHash };
  return byHash;
}

const pagesSchema = z.array(z.object({ dishId: z.string().uuid(), url: z.string(), sha256: z.string(), savedAt: z.string().nullable() }));

/** The menu's own words for each meal, by dish id. Founder only (the database refuses the page hashes otherwise). */
export async function getOriginalWording(meals: { dishId: string; label: string }[]): Promise<Map<string, OriginalWording>> {
  const out = new Map<string, OriginalWording>();
  if (!meals.length) return out;
  const dir = process.env.VFP_EVIDENCE_DIR?.trim();
  let files: Map<string, Entry> | null = null;
  if (dir) {
    try {
      files = load(dir);
    } catch {
      files = null;
    }
  }
  if (!files) {
    for (const m of meals) out.set(m.dishId, { state: "no_folder" });
    return out;
  }
  const pages = await rpc("founder_dish_pages", { p_dishes: meals.map((m) => m.dishId) }, pagesSchema).catch(() => []);
  for (const m of meals) {
    const mine = pages.filter((p) => p.dishId === m.dishId);
    const hit = mine.map((p) => ({ p, e: files!.get(p.sha256) })).find((x) => x.e);
    if (!hit?.e) {
      out.set(m.dishId, { state: "no_copy", pages: mine.map((p) => ({ url: p.url, savedAt: p.savedAt })) });
      continue;
    }
    const { p, e } = hit;
    if (e.text === null) {
      out.set(m.dishId, { state: "pdf_without_text", file: e.file, url: p.url });
      continue;
    }
    const excerpts = findDishExcerpts(e.text, m.label);
    out.set(m.dishId, excerpts.length ? { state: "found", file: e.file, url: p.url, savedAt: p.savedAt, excerpts } : { state: "not_found", file: e.file, url: p.url, savedAt: p.savedAt });
  }
  return out;
}
