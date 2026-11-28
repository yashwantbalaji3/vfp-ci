import { DIARY_NUTRIENTS } from "@/contracts/diary";

/** Spreadsheet programs run cells that start with = + - @; a leading apostrophe makes them plain text. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value !== "number") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type ExportEntry = {
  date: string;
  mealSlot: string;
  context: string;
  name: string;
  quantity: number;
  massG: number | null;
  portion: { kind?: string; label?: string | null };
  nutrients: Record<string, { value: number | null; method?: string | null }>;
};

/** Diary entries as CSV. An empty cell means the value is not known; it is never written as 0. */
export function diaryCsv(entries: ExportEntry[]): string {
  const head = ["date", "meal", "where", "food", "amount", "portion", "weight_g", ...DIARY_NUTRIENTS.map((n) => n.code), "protein_source"];
  const rows = entries.map((e) =>
    [
      e.date,
      e.mealSlot,
      e.context,
      e.name,
      e.quantity,
      e.portion?.kind === "grams" ? "grams" : (e.portion?.label ?? ""),
      e.massG,
      ...DIARY_NUTRIENTS.map((n) => e.nutrients?.[n.code]?.value ?? null),
      e.nutrients?.protein_g?.method ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}
