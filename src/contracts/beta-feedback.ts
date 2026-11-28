import { z } from "zod";

/**
 * Tester feedback forms (migration 20261123000300; docs/80). Fixed choices and short text only. The forms never ask
 * about health, weight or allergies, and the founder sees answers by tester code, not by name or email.
 */
export const USED = [
  { v: "most_days", label: "Most days" },
  { v: "a_few_times", label: "A few times" },
  { v: "once", label: "Once" },
  { v: "not_at_all", label: "Not at all" },
] as const;
export const LABELS = [
  { v: "matched", label: "Yes, they matched" },
  { v: "one_or_more_wrong", label: "At least one was wrong" },
  { v: "did_not_check", label: "I didn't check" },
] as const;
export const SCALE = [1, 2, 3, 4, 5] as const;

const text = (max: number) => z.string().trim().max(max);
export const weekSchema = z.object({
  used: z.enum(["most_days", "a_few_times", "once", "not_at_all"]),
  labels: z.enum(["matched", "one_or_more_wrong", "did_not_check"]),
  trust: z.coerce.number().int().min(1).max(5),
  recommend: z.coerce.number().int().min(1).max(5),
  wrong: text(500).optional(),
  missing: text(500).optional(),
});
export const noteSchema = z.object({
  text: z.string().trim().min(3).max(500),
  page: z
    .string()
    .regex(/^\/[A-Za-z0-9/_?=&%.-]{0,200}$/)
    .optional(),
});

/** Drop empty optional text so the database stores only what was written. */
export function cleanWeek(w: z.infer<typeof weekSchema>) {
  const out: Record<string, unknown> = { used: w.used, labels: w.labels, trust: w.trust, recommend: w.recommend };
  if (w.wrong) out.wrong = w.wrong;
  if (w.missing) out.missing = w.missing;
  return out;
}

export const feedbackRowSchema = z.object({
  id: z.string().uuid(),
  form: z.enum(["week", "note"]),
  answers: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  tester: z.string().optional(),
});
export type FeedbackRow = z.infer<typeof feedbackRowSchema>;

/** The founder's summary: how many testers answered, average trust and recommend, and label mismatches. */
export function feedbackSummary(rows: FeedbackRow[]) {
  const weeks = rows.filter((r) => r.form === "week");
  const avg = (k: string) => (weeks.length ? Math.round((weeks.reduce((s, r) => s + Number(r.answers[k] ?? 0), 0) / weeks.length) * 10) / 10 : null);
  return {
    testers: new Set(rows.map((r) => r.tester)).size,
    weekAnswers: weeks.length,
    notes: rows.length - weeks.length,
    trust: avg("trust"),
    recommend: avg("recommend"),
    labelsWrong: weeks.filter((r) => r.answers.labels === "one_or_more_wrong").length,
  };
}
