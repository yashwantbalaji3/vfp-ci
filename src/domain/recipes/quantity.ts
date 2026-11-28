/**
 * Words and numbers for recipes. Scaled amounts are shown the way a cook would
 * measure them (½ tsp, 1½ tbsp, 240 g), never as long decimals. The exact scaled
 * figure is always what the nutrition calculation uses; rounding is for display only.
 */
const FRACTIONS: [number, string][] = [
  [0, ""], [0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""],
];
const SPOKEN: Record<string, string> = { "⅛": "one eighth", "¼": "a quarter", "⅓": "a third", "½": "a half", "⅔": "two thirds", "¾": "three quarters" };

/** Units measured by weight or volume: shown as rounded whole numbers. */
const METRIC = new Set(["g", "ml", "kg", "l"]);
const PLURALS: Record<string, string> = { clove: "cloves", cloves: "cloves", piece: "pieces" };
const SIZE_WORDS = new Set(["small", "medium", "large"]);

function roundMetric(value: number): number {
  if (value >= 1000) return Math.round(value / 50) * 50;
  if (value >= 100) return Math.round(value / 5) * 5;
  if (value >= 10) return Math.round(value);
  return Math.round(value * 2) / 2;
}

/** 1.5 -> "1½", 0.33 -> "⅓", 2.02 -> "2". Amounts under an eighth are shown as "a pinch". */
export function kitchenFraction(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const whole = Math.floor(value + 1e-9);
  const rest = value - whole;
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(f[0] - rest) < Math.abs(best[0] - rest)) best = f;
  const w = best[0] === 1 ? whole + 1 : whole;
  const frac = best[0] === 1 ? "" : best[1];
  if (w === 0 && frac === "") return "a pinch of";
  return `${w > 0 ? w : ""}${frac}`;
}

/** "400 g", "1½ tbsp", "2 medium", "3 cloves". */
export function formatQuantity(quantity: number, unit: string): string {
  if (METRIC.has(unit)) return `${roundMetric(quantity)} ${unit}`;
  const amount = kitchenFraction(quantity);
  if (amount === "a pinch of") return unit === "tsp" || unit === "tbsp" ? "a pinch" : `a little`;
  const plural = quantity > 1.01 ? (PLURALS[unit] ?? unit) : unit === "cloves" && quantity <= 1.01 ? "clove" : unit;
  return `${amount} ${plural}`;
}

/** One ingredient line in words: "1 medium onion, finely chopped", "400 g extra-firm tofu". */
export function ingredientLine(i: { quantity: number; unit: string; name: string; prepNote?: string | null }): string {
  const name = displayName(i.name).toLowerCase();
  const q = formatQuantity(i.quantity, i.unit);
  const of = q === "a pinch" || q === "a little" ? " of" : "";
  const sized = SIZE_WORDS.has(i.unit) && i.quantity > 1.01 && !name.endsWith("s") ? `${name}s` : name;
  return `${q}${of} ${sized}${i.prepNote ? `, ${i.prepNote}` : ""}`;
}

/** For screen readers: "1½ tbsp" is read as "1 and a half tbsp". */
export function spokenQuantity(text: string): string {
  return text.replace(/(\d)?([⅛¼⅓½⅔¾])/g, (_m, d: string | undefined, f: string) => (d ? `${d} and ${SPOKEN[f]}` : SPOKEN[f]));
}

/** Demo items are stored with a "Demo " prefix; recipe screens show the plain name beside a clear demo label. */
export function displayName(name: string): string {
  const plain = name.replace(/^Demo\s+/i, "");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (minutes === 0) return "No cooking";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
export const totalMinutes = (prep: number | null, cook: number | null): number | null => (prep === null && cook === null ? null : (prep ?? 0) + (cook ?? 0));

export function formatServings(n: number): string {
  const text = Number.isInteger(n) ? String(n) : kitchenFraction(n) || String(Math.round(n * 100) / 100);
  return `${text} ${n <= 1 ? "serving" : "servings"}`;
}

/** 95 -> "1:35", 3600 -> "1:00:00". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
export function timerWords(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

const ALLERGEN_WORDS: Record<string, string> = { tree_nut: "tree nuts", peanut: "peanuts", egg: "egg", milk: "milk", soy: "soy", wheat: "wheat", sesame: "sesame", gluten: "gluten" };
export const allergenWord = (code: string) => ALLERGEN_WORDS[code] ?? code.replace(/_/g, " ");

/** Address parameters "swap_<group>=<line id>" to a swaps object, ignoring anything malformed. */
export function swapsFromParams(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (k.startsWith("swap_") && /^[a-z][a-z0-9_]{0,39}$/.test(k.slice(5)) && value && /^[0-9a-f-]{36}$/i.test(value)) out[k.slice(5)] = value;
  }
  return out;
}

export function recipeHref(id: string, o: { servings?: number; yieldServings?: number; swaps?: Record<string, string>; unsure?: boolean; plan?: string } = {}): string {
  const p = new URLSearchParams();
  if (o.servings !== undefined && o.servings !== o.yieldServings) p.set("servings", String(o.servings));
  for (const [g, line] of Object.entries(o.swaps ?? {})) p.set(`swap_${g}`, line);
  if (o.unsure) p.set("unsure", "1");
  if (o.plan) p.set("plan", o.plan);
  const qs = p.toString();
  return qs ? `/cook/${id}?${qs}` : `/cook/${id}`;
}

/** What a recipe is, in words, for someone with no personal filter. Unknown is never worded as suitable. */
export function suitabilityWords(s: { vegan: string; vegetarian: string }): { tone: "ok" | "ask" | "no"; text: string } {
  if (s.vegan === "eligible") return { tone: "ok", text: "Vegan · stated" };
  if (s.vegetarian === "eligible") return { tone: "ok", text: "Vegetarian · stated" };
  if (s.vegetarian === "excluded") return { tone: "no", text: "Not vegetarian" };
  return { tone: "ask", text: "Vegetarian not confirmed" };
}
