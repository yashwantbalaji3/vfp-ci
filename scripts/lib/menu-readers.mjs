// Menu readers (menu pipeline stage 2, docs/41). Pure functions over a saved page: no network,
// no database. They copy the restaurant's own words and numbers exactly; they never fill a gap.
//
// Readers carry a version ("name@n"). A new version re-reads old snapshots as a new run, so the
// history shows which reader produced which items.

export const READERS = { schema_org: "schema_org@2", bentobox: "bentobox@1", wpcafe: "wpcafe@1" };

/**
 * Site-specific readers. Empty: a site reader may be added only for a site whose terms (or a written
 * permission) allow automated reading and our use (docs/45). The Life Alive and sweetgreen readers
 * written on 17 Nov 2026 were removed because those sites' terms prohibit it. Every page gets schema_org.
 */
export const SITE_READERS = {};

/**
 * The readers that apply to a page on this host (bare and "www" names count as one site). With the
 * page, a template reader joins when the page is built with that template.
 * @param {string | null | undefined} host
 * @param {string | null} [html]
 */
export function readersFor(host, html = null) {
  const site = String(host ?? "").toLowerCase().replace(/^www\./, "");
  return ["schema_org", ...(html != null && isBentoBox(html) ? ["bentobox"] : []), ...(html != null && isWpCafe(html) ? ["wpcafe"] : []), ...(SITE_READERS[site] ? [SITE_READERS[site]] : [])];
}

/** The cleaned name used to match one dish across pages, locations and snapshots. */
export function matchKey(name) {
  return String(name ?? "")
    .replace(/[\u2122\u00ae\u00a9\u2120]|&trade;|&reg;|&copy;/g, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** "21 g", "21g", "500 calories", "1,200 mg" -> { amount, unit }; anything else -> null (unknown, never zero). */
export function parseAmount(v, defaultUnit = null) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? { amount: v, unit: defaultUnit } : null;
  const m = String(v).replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return { amount: Number(m[1]), unit: unit === "calories" || unit === "cal" || unit === "kcal" ? "kcal" : unit || defaultUnit };
}

/** A price as printed ("$12.50", "12.5", {price: "12.50"}) -> number, or null. */
export function parsePrice(v) {
  if (v == null) return null;
  const m = String(v).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

const decode = (s) => String(s ?? "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

/** Every JSON-LD block on a page, flattened (arrays and @graph). Broken blocks are skipped. */
export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html ?? "").matchAll(re)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (d) => {
      if (Array.isArray(d)) d.forEach(walk);
      else if (d && typeof d === "object") { out.push(d); if (d["@graph"]) walk(d["@graph"]); }
    };
    walk(data);
  }
  return out;
}

const types = (o) => [o?.["@type"]].flat().filter(Boolean).map(String);
const text = (v) => (v == null ? null : decode(Array.isArray(v) ? v.join(", ") : typeof v === "object" ? v.name ?? v["@value"] ?? null : String(v)).trim() || null);

// schema.org diet URLs -> the words a person would read. The page's own choice of diet is kept as the label.
const DIETS = { VeganDiet: "Vegan", VegetarianDiet: "Vegetarian", GlutenFreeDiet: "Gluten-free", HalalDiet: "Halal", KosherDiet: "Kosher", HinduDiet: "Hindu", LowLactoseDiet: "Low lactose" };

const NUTRIENTS = { proteinContent: ["protein_g", "g"], calories: ["energy_kcal", "kcal"], fatContent: ["fat_g", "g"], carbohydrateContent: ["carb_g", "g"], fiberContent: ["fiber_g", "g"], sodiumContent: ["sodium_mg", "mg"], sugarContent: ["sugar_g", "g"] };

function menuItem(o, section) {
  const name = text(o.name);
  if (!name || !/[\p{L}\p{N}]/u.test(name)) return null;
  const labels = [];
  const legend = {};
  for (const d of [o.suitableForDiet].flat().filter(Boolean)) {
    // A diet is a schema.org URL ("https://schema.org/VeganDiet") or an object naming it ({"name": "vegan"}).
    const raw = typeof d === "object" ? d.name ?? d["@id"] ?? null : d;
    if (raw == null || !String(raw).trim()) continue;
    const key = String(raw).trim().replace(/^https?:\/\/schema\.org\//, "");
    labels.push(key);
    if (DIETS[key]) legend[key] = DIETS[key];
  }
  const nutrition = {};
  const n = o.nutrition ?? {};
  for (const [field, [code, unit]] of Object.entries(NUTRIENTS)) {
    const a = parseAmount(n[field], unit);
    if (a) nutrition[code] = { ...a, per: "serving" };
  }
  const offer = [o.offers].flat()[0];
  return {
    name, section,
    description: text(o.description),
    labels, legend,
    ingredients: text(o.recipeIngredient ?? o.ingredients),
    allergens: null,
    price_usd: offer && (!offer.priceCurrency || offer.priceCurrency === "USD") ? parsePrice(offer.price) : null,
    serving: text(n.servingSize),
    serving_grams: (() => { const a = parseAmount(n.servingSize); return a && a.unit === "g" ? a.amount : null; })(),
    nutrition,
  };
}

/** Menu items from schema.org Menu / MenuSection / MenuItem objects on a page. */
export function readSchemaOrg(html) {
  const items = [];
  const seen = new Set();
  const visit = (o, section) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    const t = types(o);
    if (t.includes("MenuItem")) { const it = menuItem(o, section); if (it) items.push(it); }
    const sec = t.includes("MenuSection") ? text(o.name) ?? section : section;
    for (const k of ["hasMenu", "hasMenuSection", "hasMenuItem", "mainEntity", "itemListElement", "item"]) {
      for (const child of [o[k]].flat()) visit(child, sec);
    }
  };
  for (const o of extractJsonLd(html)) visit(o, null);
  return items;
}

/**
 * Links on a page that probably lead to a menu, nutrition, allergen or ingredient page on the same
 * site (bare and "www" names count as one site). Nothing else is followed.
 */
export function findMenuLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const site = base.hostname.replace(/^www\./, "");
  const out = new Map();
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const words = decode(m[4].replace(/<[^>]+>/g, " ")).trim();
    let u;
    try { u = new URL(decode(m[1] ?? m[2] ?? m[3]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== site) continue;
    u.hash = "";
    if (!/menu|nutrition|nutritional|allergen|ingredient/i.test(`${u.pathname} ${words}`)) continue;
    if (/\.(jpe?g|png|gif|webp|svg|mp4|zip)$/i.test(u.pathname)) continue;
    out.set(u.toString(), words.slice(0, 120));
  }
  return [...out.entries()].map(([url, words]) => ({ url, words }));
}

// ---------------------------------------------------------------------------
// Template readers. A template reader knows a website builder's menu layout, not a restaurant. It
// runs only on pages the access registry already lets us read; the template never grants access.
// ---------------------------------------------------------------------------

const strip = (h) => decode(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const classed = (h, cls) => [...String(h).matchAll(new RegExp(`<(p|div|h[1-6]|span)\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, "g"))].map((m) => m[2]);

/** True for a page built with BentoBox (its menu markup, not only the footer credit). */
export function isBentoBox(html) {
  const s = String(html ?? "");
  return /powered by BentoBox/i.test(s) && /class="menu-item__heading--name|menu-item__heading menu-item__heading--name/.test(s);
}

/**
 * Menu items from a BentoBox menu page. Keeps facts only: the dish name, its section, each printed
 * price with the size it is for, the restaurant's own dietary and allergen tags, and protein and
 * calories only where the page prints them. The dish description is never kept (it is the
 * restaurant's own writing); ingredients are left unknown for a person to draft from the source.
 */
export function readBentoBox(html) {
  const items = [];
  const parts = String(html ?? "").split(/<section\b[^>]*class="menu-section(?:\s[^"]*)?"[^>]*>/);
  for (const part of parts.slice(1)) {
    const section = strip((part.match(/<div class="menu-section__header">\s*<h2[^>]*>([\s\S]*?)<\/h2>/) ?? [])[1]) || null;
    for (const li of part.split(/<li class="menu-item\b[^"]*">/).slice(1)) {
      const body = li.split(/<\/li>/)[0];
      const name = strip(classed(body, "menu-item__heading--name")[0]);
      if (!name || !/[\p{L}\p{N}]/u.test(name)) continue;
      const tags = [...body.matchAll(/class="menu-item__dietary-info-[^"]*"[^>]*aria-label="([^"]+)"/g)].map((m) => decode(m[1]).trim().toLowerCase());
      // A size label can carry its own protein and fiber ("Small | 7g pro | 6g fiber"), and the calories
      // can follow the price ("$11.45 (240 cal.)"); both are read for that size only.
      const sized = [];
      const prices = classed(body, "menu-item__details--price").map((p) => {
        let label = strip((p.match(/<strong>(?!\s*<span)([\s\S]*?)<\/strong>/) ?? [])[1]) || null;
        const usd = parsePrice(strip(p.replace(/^[\s\S]*menu-item__currency[^>]*>\$<\/span>/, "")));
        const kcal = (label && /\((\d[\d,]*)\s*cal\.?\)/i.exec(label)) || /\((\d[\d,]*)\s*cal\.?\)/i.exec(strip(p));
        if (label) label = label.replace(/\s*\(\d[\d,]*\s*cal\.?\)/i, "").trim() || null;
        if (label && usd != null && /\|\s*\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*g\s+pro/i.test(label)) {
          sized.push(label);
          label = label.split("|")[0].trim() || null;
        }
        return { label, usd, kcal: kcal ? Number(kcal[1].replace(/,/g, "")) : null };
      }).filter((p) => p.usd != null);
      const addons = [...classed(body, "menu-item__details--addon").map(strip), ...sized];
      const allergenLine = addons.find((a) => /^allergens?\s*:/i.test(a));
      // "12g pro | 5g fiber", "14oz | 11g protein", "20-25g pro": a range stays a range (never one number).
      const amounts = (re) => addons.map((a) => re.exec(a)).filter(Boolean)
        .map((m) => ({ label: m[1]?.trim() || null, low: Number(m[2]), high: m[3] != null ? Number(m[3]) : Number(m[2]) }));
      const protein = amounts(/^(?:(.+?)\s*\|\s*)?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*g\s+pro(?:tein)?\b/i);
      const fiber = amounts(/(?:^(.+?)\s*\|\s*)?(?:\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*g\s+pro(?:tein)?\s*\|\s*)?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*g\s+fiber\b/i);
      const pick = (list) => (list.length === 1 ? list[0] : list.find((q) => q.label && q.label === prices[0]?.label)) ?? null;
      const nutrition = {};
      const p0 = pick(protein);
      const f0 = pick(fiber);
      if (p0 && p0.low === p0.high) nutrition.protein_g = { amount: p0.low, unit: "g", per: "serving" };
      if (f0 && f0.low === f0.high) nutrition.fiber_g = { amount: f0.low, unit: "g", per: "serving" };
      if (prices[0]?.kcal != null) nutrition.energy_kcal = { amount: prices[0].kcal, unit: "kcal", per: "serving" };
      const ranges = {};
      if (p0 && p0.low !== p0.high) ranges.protein_g = { low: p0.low, high: p0.high, unit: "g", per: "serving" };
      if (f0 && f0.low !== f0.high) ranges.fiber_g = { low: f0.low, high: f0.high, unit: "g", per: "serving" };
      items.push({
        name, section,
        description: null,
        labels: tags, legend: {},
        ingredients: null,
        allergens: allergenLine ? allergenLine.replace(/^allergens?\s*:\s*/i, "").split(/\s*,\s*/).filter(Boolean) : null,
        price_usd: prices[0]?.usd ?? null,
        serving: prices[0]?.label ?? null,
        serving_grams: null,
        nutrition,
        published_ranges: ranges,
        variants: prices.map((p) => {
          const q = protein.find((x) => x.label && x.label === p.label) ?? (protein.length === 1 && prices.length === 1 ? protein[0] : null);
          return { ...p, protein_g: q && q.low === q.high ? q.low : null };
        }),
      });
    }
  }
  return items;
}

/** True for a page using the WP Cafe food menu plugin for WordPress (tabbed menu). */
export function isWpCafe(html) {
  return /class="wpc-food-menu-item\b/.test(String(html ?? "")) && /class=["']wpc-tab-a\b/.test(String(html ?? ""));
}

/**
 * Menu items from a WP Cafe tabbed menu. The tab a dish sits under is its section (a tab named
 * "Vegetarian corner" is the restaurant's own grouping, kept as the section, never read as a diet
 * label here). Facts only: name, section and printed price. The description is never kept.
 */
export function readWpCafe(html) {
  const s = String(html ?? "");
  const tabs = {};
  for (const m of s.matchAll(/class=['"]wpc-tab-a[^'"]*['"][^>]*data-id=['"](tab_\d+)['"][^>]*>\s*<span>([\s\S]*?)<\/span>/g)) tabs[m[1]] = strip(m[2]);
  const items = [];
  const seen = new Set();
  const panes = s.split(/<div class=['"]wpc-tab(?:\s[^'"]*)?['"]\s+data-id=['"](tab_\d+)['"]/);
  for (let i = 1; i < panes.length; i += 2) {
    const section = tabs[panes[i]] ?? null;
    for (const block of panes[i + 1].split(/class="wpc-food-menu-item\b[^"]*"/).slice(1)) {
      const title = block.match(/<h3 class="wpc-post-title[^"]*">([\s\S]*?)<\/h3>/);
      if (!title) continue;
      const name = strip(title[1].replace(/<span class="wpc-menu-price">[\s\S]*$/, ""));
      if (!name || !/[\p{L}\p{N}]/u.test(name)) continue;
      const price = title[1].match(/woocommerce-Price-currencySymbol">[^<]*<\/span>\s*([\d,.]+)/);
      const key = `${section}|${matchKey(name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name, section, description: null, labels: [], legend: {}, ingredients: null, allergens: null,
        price_usd: price ? parsePrice(price[1]) : null, serving: null, serving_grams: null, nutrition: {} });
    }
  }
  return items;
}

/** Run one named reader over a page. */
export function readWith(reader, html) {
  if (reader === "schema_org") return readSchemaOrg(html);
  if (reader === "bentobox") return readBentoBox(html);
  if (reader === "wpcafe") return readWpCafe(html);
  throw new Error(`Unknown reader ${reader}`);
}
