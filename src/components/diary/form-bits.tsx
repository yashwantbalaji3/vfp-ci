import { useId } from "react";
import { CONTEXTS, CONTEXT_LABELS, MEAL_LABELS, MEAL_SLOTS } from "@/contracts/diary";

/** Shared, plain form fields for the diary forms. Every input has a visible label. */
export function FieldError({ id, field, message }: { id: string; field: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error s14" id={id} data-testid={`err-${field}`} style={{ margin: "4px 0 0" }}>
      {message}
    </p>
  );
}

export function MealAndDay({ mealSlot, date, errors }: { mealSlot: string; date: string; errors?: Record<string, string> }) {
  // Ids are generated so two forms kept in the page at once never share one.
  const uid = useId();
  return (
    <div className="field-grid">
      <div>
        <label htmlFor={`${uid}-meal`}>Meal</label>
        <select id={`${uid}-meal`} name="mealSlot" key={mealSlot} defaultValue={mealSlot} aria-describedby={errors?.mealSlot ? `${uid}-meal-err` : undefined}>
          {MEAL_SLOTS.map((s) => (
            <option key={s} value={s}>
              {MEAL_LABELS[s]}
            </option>
          ))}
        </select>
        <FieldError id={`${uid}-meal-err`} field="mealSlot" message={errors?.mealSlot} />
      </div>
      <div>
        <label htmlFor={`${uid}-date`}>Day</label>
        <input id={`${uid}-date`} name="date" type="date" defaultValue={date} required aria-describedby={errors?.date ? `${uid}-date-err` : undefined} />
        <FieldError id={`${uid}-date-err`} field="date" message={errors?.date} />
      </div>
    </div>
  );
}

export function WhereFrom({ value }: { value: string }) {
  return (
    <fieldset>
      <legend>Where was it from?</legend>
      {CONTEXTS.map((c) => (
        <label key={c} className="check">
          <input type="radio" name="context" value={c} defaultChecked={c === value} />
          <span>{CONTEXT_LABELS[c]}</span>
        </label>
      ))}
    </fieldset>
  );
}
