// Comparison of drafted menu facts with the saved text of their source page (docs/58). Pure functions,
// no database and no network; scripts/menu-source-compare.mjs records the results.
/** Lower case, accents and punctuation folded, so "Chik’n" and "CHIK'N" compare equal. */
export function fold(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, " and ")
    .replace(/'/g, "")
    .replace(/[^a-z0-9.$]+/g, " ")
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ndash: "-", mdash: "-", eacute: "é", reg: "", trade: "" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e.toLowerCase()] ?? m));
/**
 * The page's own words: visible text plus structured menu data (JSON-LD) and the labels of dietary
 * icons (alt and aria-label), which is where many menus print "vegan". Scripts and styles are dropped.
 */
export function pageText(html) {
  const s = String(html ?? "");
  const ld = [...s.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const body = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*?\b(?:aria-label|alt|title)="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ");
  return fold(decode(`${body} ${ld.join(" ")}`));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w) => new RegExp(`(?:^| )${escape(w)}(?= |$)`, "g");
/** Where a name appears: the full label, then the label without a bracketed note such as "(side)". */
export function nameHits(text, label) {
  for (const name of [fold(label), fold(String(label).replace(/\s*\([^)]*\)/g, ""))]) {
    if (!name) continue;
    const hits = [...text.matchAll(wordRe(name))].map((m) => m.index);
    if (hits.length) return { name, hits };
  }
  return { name: fold(label), hits: [] };
}
const AFTER = 450;
/**
 * Where the other dishes on the same page start: a value counts for a dish only when it appears after
 * the dish's name and before the next dish begins, so a price or protein figure printed under the
 * following dish is never credited to this one (the dish-to-value check, owner direction 19 Nov 01:08 UTC).
 * Only an entry counts as a start: the other dish's name followed closely by its own drafted price, so a
 * side named like an ingredient ("Brown rice") inside a description never cuts the window. Names that
 * contain this dish's name, or that it contains, are left out ("Tofu bowl" and "Spicy tofu bowl").
 * @param {string} text  @param {string} label  @param {{ label: string, usd?: string | null }[]} others
 */
export function otherDishStarts(text, label, others) {
  const mine = fold(label);
  const starts = new Set();
  for (const o of others ?? []) {
    const f = fold(o.label);
    if (!o.usd || !f || f === mine || f.includes(mine) || mine.includes(f)) continue;
    const forms = priceForms(o.usd);
    for (const m of text.matchAll(wordRe(f))) {
      const w = text.slice(m.index, m.index + f.length + 1 + ENTRY_PRICE_WITHIN);
      if (forms.some((x) => has(w, x) || w.includes(`$${x}`))) starts.add(m.index);
    }
  }
  return [...starts].sort((a, b) => a - b);
}
const ENTRY_PRICE_WITHIN = 200;
const windows = (text, hits, name, starts = []) =>
  hits.map((i) => {
    const from = i + name.length;
    const next = starts.find((x) => x > from);
    const limit = from + 1 + AFTER;
    return { w: text.slice(i, Math.min(limit, next ?? Infinity)), cut: next !== undefined && next < limit, tail: text.slice(i, limit) };
  });
const has = (w, token) => wordRe(fold(token)).test(w);
/** An ingredient word, allowing a plain plural difference ("rice noodle" for "rice noodles"). */
const hasItem = (w, item) => {
  const f = fold(item);
  return [f, f.replace(/s$/, ""), `${f}s`, f.replace(/es$/, "")].some((x) => x && wordRe(x).test(w));
};
const priceForms = (usd) => {
  const n = Number(usd);
  const forms = [n.toFixed(2)];
  if (Number.isInteger(n)) forms.push(String(n));
  return forms;
};
const WHOLE_MENU_VEGAN = /\b(100 plant based|100 vegan|all american vegan menu|entirely plant based|fully vegan|all vegan|completely vegan|100 percent vegan)\b/;

/**
 * Compares one fact with the saved page text. Returns { result, detail }; the detail says what was
 * searched and where it was or was not found, in words a founder can check.
 */
export function compareFact(text, fact, starts = []) {
  if (fact.unknown) return { result: "not_checked", detail: "Nothing to compare: the value was recorded as unknown." };
  const { name, hits } = nameHits(text, fact.dish);
  if (!hits.length) {
    return fact.kind === "menu_item"
      ? { result: "not_found", detail: `The dish name "${fact.dish}" was not found on the saved page.` }
      : { result: "not_checked", detail: `The dish name "${fact.dish}" was not found on the saved page, so its values were not compared.` };
  }
  const all = windows(text, hits, name, starts);
  const ws = all.map((x) => x.w);
  const near = (pred) => ws.some(pred);
  // Found only past the start of the next dish: the value probably belongs to that dish.
  const pastNext = (pred) => all.some((x) => x.cut && !pred(x.w) && pred(x.tail));
  const before = starts.length ? ", before the next dish starts" : "";
  const miss = (pred, words) =>
    pastNext(pred)
      ? { result: "not_found", detail: `${words} It appears only after the next dish begins, so it may belong to that dish.` }
      : { result: "not_found", detail: words };
  const v = fact.value ?? {};
  switch (fact.kind) {
    case "menu_item":
      return { result: "found", detail: `The dish name was found ${hits.length === 1 ? "once" : `${hits.length} times`} on the saved page.` };
    case "price": {
      const forms = priceForms(v.usd);
      const pred = (w) => forms.some((f) => has(w, f) || has(w, `$${f}`) || w.includes(`$${f}`));
      return near(pred)
        ? { result: "found", detail: `$${v.usd} appears shortly after the dish name${before}.` }
        : miss(pred, `$${v.usd} does not appear shortly after the dish name.`);
    }
    case "listed_ingredients": {
      const items = (v.items ?? []).map(String);
      const best = ws.map((w) => items.filter((i) => !hasItem(w, i))).sort((a, b) => a.length - b.length)[0] ?? items;
      return best.length === 0
        ? { result: "found", detail: `All ${items.length} listed ingredients appear shortly after the dish name.` }
        : { result: "not_found", detail: `Not found shortly after the dish name: ${best.slice(0, 6).join(", ")}.` };
    }
    case "allergen_statement": {
      const items = (v.allergens ?? []).map(String);
      const best = ws.map((w) => items.filter((i) => !hasItem(w, i))).sort((a, b) => a.length - b.length)[0] ?? items;
      return best.length === 0
        ? { result: "found", detail: `All ${items.length} allergens appear shortly after the dish name.` }
        : { result: "not_found", detail: `Not found shortly after the dish name: ${best.join(", ")}. The page may show allergens as symbols or a table.` };
    }
    case "dietary_status": {
      const claim = String(v.claim ?? fact.subject ?? "");
      if (v.status !== "yes") return { result: "not_checked", detail: `A "${v.status}" status is not compared automatically.` };
      if (near((w) => has(w, claim))) return { result: "found", detail: `The word "${claim}" appears shortly after the dish name.` };
      if (fact.section && fold(fact.section).includes(claim) && wordRe(fold(fact.section)).test(text))
        return { result: "found", detail: `The dish's section heading "${fact.section}" says ${claim}.` };
      const whole = claim === "vegan" || claim === "vegetarian" ? WHOLE_MENU_VEGAN.exec(text) : null;
      if (whole) return { result: "found", detail: `A statement covering the whole menu ("${whole[1]}") says it is all vegan; the word is not next to the dish.` };
      return { result: "not_found", detail: `The word "${claim}" is not next to the dish name, in its section heading, or in a statement about the whole menu.` };
    }
    case "published_nutrition": {
      const nums = v.amount != null ? [String(v.amount)] : [v.low, v.high].filter((x) => x != null).map(String);
      if (!nums.length) return { result: "not_checked", detail: "No number to compare." };
      // A number may be printed with its unit attached ("7g pro", "240cal", "640mg").
      const num = (w, n) => new RegExp(`(?:^| |\\$)${escape(n)}(?:g|mg|kcal|cal)?(?= |$)`).test(w);
      const pred = (w) => nums.every((n) => num(w, n));
      const what = nums.length === 1 ? nums[0] : `${nums[0]} to ${nums[1]}`;
      return near(pred)
        ? { result: "found", detail: `${what} (${fact.subject}) appears shortly after the dish name${before}.` }
        : miss(pred, `${what} (${fact.subject}) does not appear shortly after the dish name.`);
    }
    default:
      return { result: "not_checked", detail: `A ${fact.kind.replace(/_/g, " ")} fact is not compared automatically.` };
  }
}
