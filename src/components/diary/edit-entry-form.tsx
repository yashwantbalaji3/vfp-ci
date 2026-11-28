"use client";
import { useActionState, useId } from "react";
import Link from "next/link";
import { updateEntryAction, type FormState } from "@/app/diary/actions";
import type { DiaryEntry } from "@/contracts/diary";
import { FieldError, MealAndDay } from "./form-bits";

/** Change how much, which meal or which day. Saving keeps the earlier version in the entry's history (R-F06). */
export function EditEntryForm({ entry, date }: { entry: DiaryEntry; date: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateEntryAction, { status: "idle" });
  const uid = useId();
  const byGrams = entry.portion.kind === "grams";
  const cooked = entry.portion.kind === "cooked";
  const errors = state.fields;
  const slot = entry.mealSlot.trim().toLowerCase();
  return (
    <form action={action} className="stack" noValidate>
      <input type="hidden" name="entryId" value={entry.entryId} />
      <input type="hidden" name="expectedVersion" value={entry.version} />
      <input type="hidden" name="originalDate" value={date} />
      <input type="hidden" name="mode" value={byGrams ? "grams" : cooked ? "cooked" : "portion"} />
      {!byGrams && !cooked && <input type="hidden" name="portionId" value={entry.portion.portionId ?? ""} />}
      <div>
        <label htmlFor={`${uid}-e-amount`}>{byGrams ? "Weight in grams" : cooked ? "Servings you ate" : `How many (${entry.portion.label ?? "serving"})`}</label>
        <input id={`${uid}-e-amount`} name="quantity" type="number" inputMode="decimal" min={byGrams ? "1" : "0.1"} max={byGrams ? "5000" : "100"} step="any" defaultValue={state.values?.quantity ?? entry.quantity} required aria-describedby={errors?.quantity || errors?.grams ? `${uid}-e-amount-err` : undefined} />
        <FieldError id={`${uid}-e-amount-err`} field="quantity" message={errors?.quantity ?? errors?.grams} />
      </div>
      <MealAndDay mealSlot={state.values?.mealSlot ?? slot} date={state.values?.date ?? date} errors={errors} />
      <p role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "sr-only"} style={{ margin: 0 }}>
        {state.message ?? ""}
      </p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <Link className="link-btn" href={`/diary?date=${date}`}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
