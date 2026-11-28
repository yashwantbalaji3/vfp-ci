import type { Diet, EligibilityStatus } from "./families";

/**
 * Words for dietary confidence (docs/19, owner decision 2026-11-13). Three tones,
 * always shown with an icon and text, never colour alone:
 *   ok  = stated compatible, ask = not confirmed, no = contains or incompatible.
 * "Unknown" is never worded as safe.
 */
export type ConfidenceTone = "ok" | "ask" | "no";
export type ConfidenceLabel = { tone: ConfidenceTone; text: string; detail?: string };

export const FAMILY_WORDS: Record<string, string> = {
  egg: "egg",
  dairy: "dairy",
  honey: "honey",
  gelatin: "gelatin",
  animal_stock: "animal stock",
  fish_sauce: "fish sauce",
  animal_rennet: "animal rennet",
};
export const familyWord = (code: string | null | undefined) => (code ? (FAMILY_WORDS[code] ?? code.replace(/_/g, " ")) : "an ingredient");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type DietChoice = { diet: Diet; exclusions: readonly string[]; includeConditional?: boolean };
export const hasDietChoice = (c: DietChoice) => c.diet !== "none" || c.exclusions.length > 0;

/** "Egg-free vegetarian", "Vegan, no honey", "No egg, no dairy", or "No dietary filter". */
export function describeDietChoice(c: DietChoice): string {
  if (!hasDietChoice(c)) return "No dietary filter";
  const ex = c.exclusions.map(familyWord);
  if (c.diet === "vegetarian" && c.exclusions.length === 1 && c.exclusions[0] === "egg") return "Egg-free vegetarian";
  if (c.diet === "none") return cap(ex.map((e) => `no ${e}`).join(", "));
  const base = c.diet === "vegan" ? "Vegan" : "Vegetarian";
  return ex.length ? `${base}, ${ex.map((e) => `no ${e}`).join(", ")}` : base;
}

type Reason = { code: string; family?: string | null; modifications?: string | null };

export function confidenceLabel(status: EligibilityStatus, reasons: readonly Reason[], choice: DietChoice): ConfidenceLabel {
  const dietWord = choice.diet === "vegan" ? "Vegan" : "Vegetarian";
  if (status === "eligible") {
    if (choice.exclusions.length) {
      return { tone: "ok", text: `${cap(choice.exclusions.map((e) => `no ${familyWord(e)}`).join(", "))} · stated` };
    }
    return { tone: "ok", text: `${dietWord} · stated` };
  }
  if (status === "conditional") {
    const mod = reasons.find((r) => r.code === "requires_modification")?.modifications ?? undefined;
    return { tone: "ask", text: "Only with a change", detail: mod };
  }
  if (status === "excluded") {
    const fam = reasons.find((r) => r.code === "contains_excluded_family" || r.code === "contains_family");
    if (fam) return { tone: "no", text: `Contains ${familyWord(fam.family)}` };
    return { tone: "no", text: `Not ${dietWord.toLowerCase()}` };
  }
  // An editor has marked the entry as needing review: its claims are not relied on until it is checked again.
  if (reasons.some((r) => r.code === "needs_review")) return { tone: "ask", text: "Being re-checked, not confirmed" };
  const unconfirmed = reasons.filter((r) => r.code === "unconfirmed_excluded_family");
  if (unconfirmed.length) {
    return { tone: "ask", text: `${cap(unconfirmed.map((r) => familyWord(r.family)).join(", "))} unconfirmed` };
  }
  const mod = reasons.find((r) => r.code === "requires_modification");
  if (mod) return { tone: "ask", text: "Only with a change", detail: mod.modifications ?? undefined };
  if (reasons.some((r) => r.code === "dietary_claim_expired")) return { tone: "ask", text: `${dietWord} check out of date` };
  if (reasons.some((r) => r.code === "dietary_claim_disputed")) return { tone: "ask", text: `${dietWord} status disputed` };
  return { tone: "ask", text: `${dietWord} not confirmed` };
}

/** Plain-language reason a group of results is hidden, with its count. */
export function hiddenReasonText(code: string, family: string | null, count: number): string {
  const n = `${count} ${count === 1 ? "item" : "items"}`;
  if (code === "contains_excluded_family" || code === "contains_family") return `${n} with ${familyWord(family)}`;
  if (code === "diet_incompatible") return `${n} marked as not suitable for this diet`;
  return `${n} not suitable`;
}

/** Presence of one ingredient family on a detail page. */
export function presenceLabel(presence: string, label: string): ConfidenceLabel {
  if (presence === "absent_by_statement") return { tone: "ok", text: `No ${label.toLowerCase()} · stated` };
  if (presence === "present") return { tone: "no", text: `Contains ${label.toLowerCase()}` };
  return { tone: "ask", text: `${label} not confirmed` };
}
