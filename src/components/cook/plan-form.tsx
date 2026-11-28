"use client";
import { useActionState, useId } from "react";
import { planRecipeAction, type CookFormState } from "@/app/cook/actions";
import { MEAL_LABELS, MEAL_SLOTS } from "@/contracts/diary";
import { FieldError } from "@/components/diary/form-bits";

/** Put a recipe on a day of the week plan. A plan is an intention: it is never counted as cooked or eaten. */
export function PlanForm({ foodItemId, servings, today, here, mealSlot }: { foodItemId: string; servings: number; today: string; here: string; mealSlot?: string }) {
  const [state, action, pending] = useActionState<CookFormState, FormData>(planRecipeAction, { status: "idle" });
  const uid = useId();
  const v = state.values ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <input type="hidden" name="foodItemId" value={foodItemId} />
      <input type="hidden" name="servings" value={servings} />
      <input type="hidden" name="here" value={here} />
      <div className="field-grid">
        <div>
          <label htmlFor={`${uid}-date`}>Day</label>
          <input id={`${uid}-date`} name="date" type="date" defaultValue={v.date ?? today} min={today} required aria-describedby={state.fields?.date ? `${uid}-date-err` : undefined} />
          <FieldError id={`${uid}-date-err`} field="date" message={state.fields?.date} />
        </div>
        <div>
          <label htmlFor={`${uid}-meal`}>Meal (optional)</label>
          <select id={`${uid}-meal`} name="mealSlot" defaultValue={v.mealSlot ?? mealSlot ?? ""}>
            <option value="">Any time</option>
            {MEAL_SLOTS.map((s) => (
              <option key={s} value={s}>
                {MEAL_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {state.status === "error" && !state.fields?.date && (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      )}
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add to week plan"}
      </button>
      <p className="s13 muted" style={{ margin: 0 }}>
        Private to you. A planned recipe is not counted in your diary or goals.
      </p>
    </form>
  );
}
