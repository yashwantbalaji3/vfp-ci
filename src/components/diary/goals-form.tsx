"use client";
import { useActionState, useId } from "react";
import { saveGoalsAction, type FormState } from "@/app/diary/actions";
import type { Goals } from "@/contracts/diary";
import { formatDay } from "@/lib/format";
import { FieldError } from "./form-bits";

/**
 * Both goals are optional and chosen by the member (R-G01). The form suggests no
 * numbers. Clearing a box removes that goal from today onward.
 */
export function GoalsForm({ goals }: { goals: Goals }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveGoalsAction, { status: "idle" });
  const uid = useId();
  const errors = state.fields;
  return (
    <form action={action} className="stack" noValidate>
      <div>
        <label htmlFor={`${uid}-g-protein`}>Protein per day (grams)</label>
        <input id={`${uid}-g-protein`} name="proteinPerDay" type="number" inputMode="decimal" min="1" max="400" step="any" defaultValue={state.values?.proteinPerDay ?? goals.proteinPerDay?.target ?? ""} aria-describedby={errors?.proteinPerDay ? `${uid}-e-gprotein` : `${uid}-h-gprotein`} />
        <p className="s14 muted" id={`${uid}-h-gprotein`} style={{ margin: "4px 0 0" }}>
          {goals.proteinPerDay ? `Your choice since ${formatDay(goals.proteinPerDay.effectiveFrom, "short")}. ` : "No goal set. "}
          Leave it empty for no goal.
        </p>
        <FieldError id={`${uid}-e-gprotein`} field="proteinPerDay" message={errors?.proteinPerDay} />
      </div>
      <div>
        <label htmlFor={`${uid}-g-home`}>Home-cooked meals per week</label>
        <input id={`${uid}-g-home`} name="homeMealsPerWeek" type="number" inputMode="numeric" min="1" max="21" step="1" defaultValue={state.values?.homeMealsPerWeek ?? goals.homeMealsPerWeek?.target ?? ""} aria-describedby={errors?.homeMealsPerWeek ? `${uid}-e-ghome` : `${uid}-h-ghome`} />
        <p className="s14 muted" id={`${uid}-h-ghome`} style={{ margin: "4px 0 0" }}>
          {goals.homeMealsPerWeek ? `Your choice since ${formatDay(goals.homeMealsPerWeek.effectiveFrom, "short")}. ` : "No goal set. "}
          A meal counts when you finish cooking a recipe here, or log something as home-cooked. The same meal is never counted twice.
        </p>
        <FieldError id={`${uid}-e-ghome`} field="homeMealsPerWeek" message={errors?.homeMealsPerWeek} />
      </div>
      <p role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "sr-only"} style={{ margin: 0 }}>
        {state.message ?? ""}
      </p>
      <div>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save goals"}
        </button>
      </div>
    </form>
  );
}
