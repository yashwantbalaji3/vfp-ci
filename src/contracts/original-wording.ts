/**
 * The menu's own words around a drafted dish, from the founder's private copy of the saved page (owner directive
 * 27 Nov 2026 06:04 UTC, section 4). Pure, so it is unit-tested; src/server/evidence/originals.ts reads the files.
 *
 * Only short excerpts are ever shown, only to the founder, only on the founder's own computer, for checking facts.
 * Nothing here is stored, exported or published.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/** Readable text of a saved HTML page: scripts, styles and tags removed, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();
}

/** Lower case, accents removed, every run of non-letters one space: "Phở  Bún-Chay" → "pho bun chay". */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** One line of text: whitespace collapsed, and a printed leader of dots (". . . . 19") shortened to " … ". */
const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/(?:\s?\.){4,}\s?/g, " … ");

export type Excerpt = { before: string; match: string; after: string };

/** The folded text with, for each folded character, where it came from in the original (build once per page). */
export type FoldedText = { text: string; folded: string; at: number[] };
export function foldWithMap(text: string): FoldedText {
  let folded = "";
  const at: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]) || " ";
    for (const ch of f) {
      if (ch === " ") {
        if (lastSpace) continue;
        lastSpace = true;
      } else lastSpace = false;
      folded += ch;
      at.push(i);
    }
  }
  return { text, folded, at };
}

/**
 * Up to `max` places where the dish name appears in the text, each with a little of what comes before and the next
 * `afterChars` characters (where a menu prints the description, the price and any diet mark). Matching ignores case,
 * accents and punctuation. Overlapping hits are merged into the first.
 */
export function findExcerpts(source: string | FoldedText, dish: string, { max = 2, beforeChars = 60, afterChars = 320 } = {}): Excerpt[] {
  const want = fold(dish);
  if (want.length < 3) return [];
  const { text, folded, at } = typeof source === "string" ? foldWithMap(source) : source;
  const out: Excerpt[] = [];
  let from = 0;
  let lastEnd = -1;
  while (out.length < max) {
    const k = folded.indexOf(want, from);
    if (k < 0) break;
    from = k + want.length;
    const boundaryBefore = k === 0 || folded[k - 1] === " ";
    const boundaryAfter = k + want.length >= folded.length || folded[k + want.length] === " ";
    if (!boundaryBefore || !boundaryAfter) continue;
    const s = at[k];
    const e = at[k + want.length - 1] + 1;
    if (s < lastEnd) continue;
    const b = Math.max(0, s - beforeChars);
    const a = Math.min(text.length, e + afterChars);
    lastEnd = a;
    out.push({
      before: (b > 0 ? "…" : "") + tidy(text.slice(b, s)).trimStart(),
      match: tidy(text.slice(s, e)),
      after: tidy(text.slice(e, a)).trimEnd() + (a < text.length ? "…" : ""),
    });
  }
  return out;
}

/**
 * The ways a drafted name may be printed. A draft often joins the menu's two lines ("Bún Cà Ry Chay (Vegetable & Tofu
 * Vermicelli Curry Soup)") or two choices ("Gỏi Cuốn Chay hoặc Bún Chả Giò Chay"); the menu prints each part on its
 * own. Full name first, then the name outside the brackets, then what is inside them, each split at "or"/"hoặc"/"/".
 * The full name always counts; a part shorter than six letters is left out, since it would match too much.
 */
export function nameVariants(dish: string): string[] {
  const outside = dish.replace(/\([^)]*\)/g, " ").trim();
  const inside = [...dish.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const split = (s: string) => s.split(/\s+(?:or|hoặc)\s+|\s*\/\s*|,\s*/i).map((x) => x.trim());
  const parts = [outside, ...split(outside), ...inside, ...inside.flatMap(split)];
  const seen = new Set<string>([fold(dish)]);
  return [dish, ...parts.filter((v) => {
    const f = fold(v);
    if (f.replace(/[^a-z]/g, "").length < 6 || seen.has(f)) return false;
    seen.add(f);
    return true;
  })];
}

/** findExcerpts for a drafted dish name: the first of its printed forms (nameVariants) that the page contains. */
export function findDishExcerpts(source: string | FoldedText, dish: string, opts: Parameters<typeof findExcerpts>[2] = {}): Excerpt[] {
  const page = typeof source === "string" ? foldWithMap(source) : source;
  for (const v of nameVariants(dish)) {
    const hits = findExcerpts(page, v, opts);
    if (hits.length) return hits;
  }
  return [];
}

/** What the review card shows for one meal. */
export type OriginalWording =
  | { state: "no_folder" }
  | { state: "no_copy"; pages: { url: string; savedAt: string | null }[] }
  | { state: "pdf_without_text"; file: string; url: string }
  | { state: "not_found"; file: string; url: string; savedAt: string | null }
  | { state: "found"; file: string; url: string; savedAt: string | null; excerpts: Excerpt[] };
