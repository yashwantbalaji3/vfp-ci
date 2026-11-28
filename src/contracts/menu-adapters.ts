/**
 * Menu adapters (owner directive 25 Nov 2026 04:01 UTC, section 3.1; docs/91). Pure functions that turn a structured
 * menu a restaurant itself controls into the same private draft shape the research batches produce
 * (the work/tierb batch draft files), so everything after this point (entry, automatic comparison, founder review,
 * tester checks) stays one path.
 *
 * None of these is connected to a network. Google Business Profile and Square need each restaurant's own
 * authorization, which counts as contacting them, so they run on test fixtures until the owner approves that.
 * schema.org markup is read only from a saved copy of a restaurant page on an approved host.
 *
 * Rules every adapter keeps:
 * - Facts only: name, price, the restaurant's own structured diet flags, listed ingredients, printed nutrition. Never
 *   descriptions, photos or layout.
 * - A diet claim only from the restaurant's own structured flag. Never from the dish name, the restaurant's name or
 *   branding, a photo or a guess. No flag means no diet fact (unknown), not "no".
 * - Nutrition not given is recorded as unknown with a reason, never zero.
 * - Everything is a draft: private, unverified, entered by the research account, reviewed by the founder.
 */

export type DraftFact = {
  checkedOn: string;
  dish: string;
  kind: "menu_item" | "price" | "dietary_status" | "listed_ingredients" | "published_nutrition" | "allergen_statement";
  subject?: string;
  value?: Record<string, unknown>;
  unknownReason?: string;
  source: string;
  confidence: "high" | "medium";
};
/** No "type": whether an item is a complete meal, a side or a drink is decided by a person, never by an adapter. */
export type DraftDish = { key: string; label: string; section?: string };
export type DraftSource = { key: string; kind: "owner_authorized_api" | "restaurant_site"; url: string; publisher: string; retrievedAt: string; termsNote: string };
export type DraftPlace = { label: string; dishes: DraftDish[]; facts: DraftFact[]; sources: DraftSource[] };

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";

function uniqueKey(used: Set<string>, label: string) {
  const base = slug(label);
  let k = base;
  for (let i = 2; used.has(k); i++) k = `${base}-${i}`;
  used.add(k);
  return k;
}

const usd = (cents: number) => (cents / 100).toFixed(2);
const DIETS = { VEGAN: "vegan", VEGETARIAN: "vegetarian" } as const;

type Ctx = { checkedOn: string; source: string };
function base(ctx: Ctx, dish: string, kind: DraftFact["kind"], rest: Partial<DraftFact>): DraftFact {
  return { checkedOn: ctx.checkedOn, dish, kind, source: ctx.source, confidence: "high", ...rest };
}

/** Records diet flags the restaurant set; claims it did not set stay absent (unknown). */
function dietFacts(ctx: Ctx, dish: string, flags: string[]): DraftFact[] {
  const claims = new Set(flags.map((f) => DIETS[f.toUpperCase() as keyof typeof DIETS]).filter(Boolean));
  return [...claims].map((claim) => base(ctx, dish, "dietary_status", { subject: claim, value: { claim, status: "yes" } }));
}

function proteinFact(ctx: Ctx, dish: string, p: { low?: number; high?: number } | null, missing: string): DraftFact {
  if (!p || (p.low == null && p.high == null)) return base(ctx, dish, "published_nutrition", { subject: "protein_g", unknownReason: missing });
  if (p.low != null && p.high != null && p.low < p.high)
    return base(ctx, dish, "published_nutrition", { subject: "protein_g", value: { nutrient: "protein_g", basis: "published_range", low: p.low, high: p.high, per: "serving" } });
  return base(ctx, dish, "published_nutrition", { subject: "protein_g", value: { nutrient: "protein_g", amount: p.low ?? p.high, per: "serving" } });
}

// ---------- Google Business Profile: accounts.locations.getFoodMenus (owner-authorized) ----------

type GbpMoney = { currencyCode?: string; units?: string; nanos?: number };
type GbpNutrient = { lowerAmount?: number; upperAmount?: number; unit?: string };
type GbpItem = {
  labels?: { displayName?: string }[];
  attributes?: {
    price?: GbpMoney;
    dietaryRestriction?: string[];
    allergen?: string[];
    ingredients?: { labels?: { displayName?: string }[] }[];
    nutritionFacts?: { protein?: GbpNutrient };
  };
};
export type GbpFoodMenus = { menus?: { labels?: { displayName?: string }[]; sections?: { labels?: { displayName?: string }[]; items?: GbpItem[] }[] }[] };

const gbpCents = (m?: GbpMoney) => (m && m.currencyCode === "USD" ? Number(m.units ?? 0) * 100 + Math.round((m.nanos ?? 0) / 1e7) : null);
function gbpProtein(n?: GbpNutrient) {
  if (!n || (n.unit && n.unit !== "GRAM")) return null;
  return { low: n.lowerAmount, high: n.upperAmount };
}

export function fromGoogleFoodMenus(input: GbpFoodMenus, o: { placeLabel: string; locationName: string; retrievedAt: string }): DraftPlace {
  const ctx = { checkedOn: o.retrievedAt.slice(0, 10), source: "gbp" };
  const used = new Set<string>();
  const dishes: DraftDish[] = [];
  const facts: DraftFact[] = [];
  for (const menu of input.menus ?? [])
    for (const section of menu.sections ?? [])
      for (const item of section.items ?? []) {
        const label = item.labels?.[0]?.displayName?.trim();
        if (!label) continue;
        const key = uniqueKey(used, label);
        dishes.push({ key, label, section: section.labels?.[0]?.displayName });
        const a = item.attributes ?? {};
        facts.push(base(ctx, key, "menu_item", { value: { listed: true } }));
        const cents = gbpCents(a.price);
        facts.push(cents == null ? base(ctx, key, "price", { unknownReason: "No US dollar price on the owner's menu" }) : base(ctx, key, "price", { value: { usd: usd(cents) } }));
        facts.push(...dietFacts(ctx, key, a.dietaryRestriction ?? []));
        const ingredients = (a.ingredients ?? []).map((i) => i.labels?.[0]?.displayName?.trim()).filter((x): x is string => !!x);
        if (ingredients.length) facts.push(base(ctx, key, "listed_ingredients", { value: { items: ingredients } }));
        if (a.allergen?.length) facts.push(base(ctx, key, "allergen_statement", { value: { statement: "contains", allergens: a.allergen.map((x) => x.toLowerCase()) } }));
        facts.push(proteinFact(ctx, key, gbpProtein(a.nutritionFacts?.protein), "The owner's menu gives no protein in grams"));
      }
  return {
    label: o.placeLabel,
    dishes,
    facts,
    sources: [{ key: "gbp", kind: "owner_authorized_api", url: `https://mybusiness.googleapis.com/v4/${o.locationName}/foodMenus`, publisher: o.placeLabel, retrievedAt: o.retrievedAt, termsNote: "Read with the restaurant's own authorization. Facts only; private; unverified." }],
  };
}

// ---------- Square Catalog: ListCatalog / SearchCatalogObjects, type ITEM (merchant-authorized, ITEMS_READ) ----------

type SquareItem = {
  type: string;
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    variations?: { item_variation_data?: { name?: string; price_money?: { amount?: number; currency?: string } } }[];
    food_and_beverage_details?: {
      dietary_preferences?: { type?: string; standard_name?: string }[];
      ingredients?: { type?: string; standard_name?: string; custom_name?: string }[];
    };
  };
};
export type SquareCatalog = { objects?: SquareItem[] };

export function fromSquareCatalog(input: SquareCatalog, o: { placeLabel: string; merchantId: string; retrievedAt: string }): DraftPlace {
  const ctx = { checkedOn: o.retrievedAt.slice(0, 10), source: "square" };
  const used = new Set<string>();
  const dishes: DraftDish[] = [];
  const facts: DraftFact[] = [];
  for (const obj of input.objects ?? []) {
    if (obj.type !== "ITEM" || obj.is_deleted) continue;
    const label = obj.item_data?.name?.trim();
    if (!label) continue;
    const key = uniqueKey(used, label);
    dishes.push({ key, label });
    facts.push(base(ctx, key, "menu_item", { value: { listed: true } }));
    // One price only when every variation in US dollars agrees; otherwise the price depends on the size chosen.
    const prices = [...new Set((obj.item_data?.variations ?? []).map((v) => v.item_variation_data?.price_money).filter((m) => m?.currency === "USD" && typeof m.amount === "number").map((m) => m!.amount!))];
    facts.push(prices.length === 1 ? base(ctx, key, "price", { value: { usd: usd(prices[0]) } }) : base(ctx, key, "price", { unknownReason: prices.length ? "Price depends on the size chosen" : "No US dollar price in the catalog" }));
    const fb = obj.item_data?.food_and_beverage_details;
    facts.push(...dietFacts(ctx, key, (fb?.dietary_preferences ?? []).filter((d) => d.type === "STANDARD").map((d) => d.standard_name ?? "")));
    const ing = (fb?.ingredients ?? []).map((i) => (i.type === "STANDARD" ? i.standard_name?.toLowerCase().replace(/_/g, " ") : i.custom_name)?.trim()).filter((x): x is string => !!x);
    // Square's ingredient list is mostly allergens (dairy, egg, gluten...): recorded as the owner's "contains" list.
    if (ing.length) facts.push(base(ctx, key, "allergen_statement", { value: { statement: "contains", allergens: ing } }));
    facts.push(proteinFact(ctx, key, null, "Square catalogs carry no protein value"));
  }
  return {
    label: o.placeLabel,
    dishes,
    facts,
    sources: [{ key: "square", kind: "owner_authorized_api", url: `https://connect.squareup.com/v2/catalog/list?merchant=${encodeURIComponent(o.merchantId)}`, publisher: o.placeLabel, retrievedAt: o.retrievedAt, termsNote: "Read with the merchant's own authorization (ITEMS_READ). Facts only; private; unverified." }],
  };
}

// ---------- schema.org Menu / MenuItem JSON-LD in a saved restaurant page (approved host only) ----------

type Ld = Record<string, unknown>;
const asArray = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const typeOf = (n: Ld) => asArray(n["@type"] as string | string[]).map(String);

/** Every JSON-LD block in a saved HTML page, parsed; a block that does not parse is skipped. */
export function jsonLdBlocks(html: string): Ld[] {
  const out: Ld[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1]);
      for (const x of asArray(v)) out.push(...asArray((x as Ld)["@graph"] as Ld[]), x as Ld);
    } catch {
      /* not JSON: skipped */
    }
  }
  return out;
}

function gramsOf(v: unknown): number | null {
  const m = typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(g|grams?)\s*$/i.exec(v) : null;
  return m ? Number(m[1]) : null;
}

export function fromSchemaOrgMenu(html: string, o: { placeLabel: string; url: string; retrievedAt: string }): DraftPlace {
  const ctx = { checkedOn: o.retrievedAt.slice(0, 10), source: "site" };
  const used = new Set<string>();
  const dishes: DraftDish[] = [];
  const facts: DraftFact[] = [];
  const walk = (n: Ld, section?: string) => {
    const types = typeOf(n);
    if (types.includes("MenuItem")) {
      const label = typeof n.name === "string" ? n.name.trim() : "";
      if (!label) return;
      const key = uniqueKey(used, label);
      dishes.push({ key, label, section });
      facts.push(base(ctx, key, "menu_item", { value: { listed: true } }));
      const offer = asArray(n.offers as Ld | Ld[])[0];
      const price = offer && (offer.priceCurrency ?? "USD") === "USD" ? Number(offer.price) : NaN;
      facts.push(Number.isFinite(price) ? base(ctx, key, "price", { value: { usd: price.toFixed(2) } }) : base(ctx, key, "price", { unknownReason: "No US dollar price in the page's menu data" }));
      const diets = asArray(n.suitableForDiet as string | string[]).map((d) => String(d).replace(/^https?:\/\/schema\.org\//, ""));
      facts.push(...dietFacts(ctx, key, diets.map((d) => (d === "VeganDiet" ? "VEGAN" : d === "VegetarianDiet" ? "VEGETARIAN" : ""))));
      const g = gramsOf((n.nutrition as Ld | undefined)?.proteinContent);
      facts.push(proteinFact(ctx, key, g == null ? null : { low: g, high: g }, "The page's menu data gives no protein in grams"));
      return;
    }
    const name = typeof n.name === "string" ? n.name : section;
    for (const k of ["hasMenu", "hasMenuSection", "hasMenuItem"]) for (const c of asArray(n[k] as Ld | Ld[])) if (c && typeof c === "object") walk(c, types.includes("MenuSection") ? name : section);
  };
  for (const b of jsonLdBlocks(html)) walk(b);
  return {
    label: o.placeLabel,
    dishes,
    facts,
    sources: [{ key: "site", kind: "restaurant_site", url: o.url, publisher: o.placeLabel, retrievedAt: o.retrievedAt, termsNote: "Structured menu data in the restaurant's own page, on an approved host after robots and terms checks. Facts only; private; unverified." }],
  };
}

// ---------- Change detection between two drafts of the same menu ----------

export type MenuChange = { added: string[]; removed: string[]; changed: { dish: string; kinds: string[] }[] };

const factKey = (f: DraftFact) => `${f.kind}|${f.subject ?? ""}`;
const factVal = (f: DraftFact) => JSON.stringify(f.value ?? null) + (f.unknownReason ? "|unknown" : "");

/**
 * What changed between an earlier and a newer draft, by dish label. A changed diet or ingredient fact means the
 * founder's earlier check and any staff confirmation no longer cover that dish (the database already marks a
 * confirmation "menu changed" when the dish's facts change).
 */
export function menuChanges(before: DraftPlace, after: DraftPlace): MenuChange {
  const byLabel = (p: DraftPlace) => new Map(p.dishes.map((d) => [d.label.toLowerCase(), d.key]));
  const a = byLabel(before);
  const b = byLabel(after);
  const factsOf = (p: DraftPlace, key: string) => new Map(p.facts.filter((f) => f.dish === key).map((f) => [factKey(f), factVal(f)]));
  const changed: MenuChange["changed"] = [];
  for (const [label, keyB] of b) {
    const keyA = a.get(label);
    if (!keyA) continue;
    const fa = factsOf(before, keyA);
    const fb = factsOf(after, keyB);
    const kinds = [...new Set([...fa.keys(), ...fb.keys()])].filter((k) => fa.get(k) !== fb.get(k)).sort();
    if (kinds.length) changed.push({ dish: after.dishes.find((d) => d.key === keyB)!.label, kinds });
  }
  return {
    added: after.dishes.filter((d) => !a.has(d.label.toLowerCase())).map((d) => d.label),
    removed: before.dishes.filter((d) => !b.has(d.label.toLowerCase())).map((d) => d.label),
    changed,
  };
}
