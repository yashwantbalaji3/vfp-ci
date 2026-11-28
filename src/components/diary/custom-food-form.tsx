"use client";
import { useActionState, useId } from "react";
import Link from "next/link";
import { logCustomFoodAction, type FormState } from "@/app/diary/actions";
import { FieldError, MealAndDay, WhereFrom } from "./form-bits";

/**
 * With `mealId` (Log this meal, docs/63), the entry is a real restaurant meal: the name is the dish and the
 * restaurant at logging time, the source figures are read again on the server, and only protein, calories and
 * the number of servings are taken from the form.
 */
type Props = { idempotencyKey: string; date: string; mealSlot: string; here: string; cancelHref: string; prefill?: Record<string, string>; note?: string; mealId?: string };

const num = { type: "number", inputMode: "decimal", min: "0", step: "any" } as const;

/**
 * Write down a food of your own (R-F03). Only the name is needed. Every nutrition
 * box may stay empty; an empty box is saved as "not known", never as zero.
 */
export function CustomFoodForm({ idempotencyKey, date, mealSlot, here, cancelHref, prefill, note, mealId }: Props) {
  const [state, action, pending] = useActionState<FormState, FormData>(logCustomFoodAction, { status: "idle" });
  const uid = useId();
  const errors = state.fields;
  const v = (name: string, fallback = "") => state.values?.[name] ?? prefill?.[name] ?? fallback;
  const more = Boolean(v("carbG") || v("fatG") || v("fiberG") || v("servingGrams") || v("servingLabel") || v("brand") || errors?.carbG || errors?.fatG || errors?.fiberG || errors?.servingGrams || errors?.servingLabel || errors?.brand);
  return (
    <form action={action} className="stack" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="here" value={here} />
      {mealId && <input type="hidden" name="mealId" value={mealId} />}
      {note && (
        <p className="callout" data-testid="custom-prefill-note" style={{ margin: 0 }}>
          {note}
        </p>
      )}
      <div>
        <label htmlFor={`${uid}-c-name`}>What was it?</label>
        <input id={`${uid}-c-name`} name="name" defaultValue={v("name")} type="text" maxLength={200} required autoComplete="off" placeholder="For example: lentil soup at Mum's" readOnly={Boolean(mealId)} aria-describedby={[errors?.name ? `${uid}-e-name` : "", mealId ? `${uid}-h-name` : ""].filter(Boolean).join(" ") || undefined} />
        {mealId && (
          <p className="s13 muted" id={`${uid}-h-name`} style={{ margin: "2px 0 0" }}>
            The dish and restaurant as they are named today, kept with the entry.
          </p>
        )}
        <FieldError id={`${uid}-e-name`} field="name" message={errors?.name} />
      </div>
      <div>
        <label htmlFor={`${uid}-c-qty`}>How many servings</label>
        <input id={`${uid}-c-qty`} name="quantity" {...num} min="0.1" max="100" defaultValue={v("quantity", "1")} required aria-describedby={errors?.quantity ? `${uid}-e-cqty` : undefined} />
        <FieldError id={`${uid}-e-cqty`} field="quantity" message={errors?.quantity} />
      </div>
      <fieldset>
        <legend>Nutrition for one serving, if you know it</legend>
        <p className="s14 muted" style={{ margin: "0 0 8px" }}>
          Leave a box empty if you don&rsquo;t know. Empty means &ldquo;not known&rdquo;, not zero.
        </p>
        <div className="field-grid">
          <div>
            <label htmlFor={`${uid}-c-protein`}>Protein (g)</label>
            <input id={`${uid}-c-protein`} name="proteinG" defaultValue={v("proteinG")} {...num} aria-describedby={errors?.proteinG ? `${uid}-e-protein` : undefined} />
            <FieldError id={`${uid}-e-protein`} field="proteinG" message={errors?.proteinG} />
          </div>
          <div>
            <label htmlFor={`${uid}-c-kcal`}>Calories (kcal)</label>
            <input id={`${uid}-c-kcal`} name="energyKcal" defaultValue={v("energyKcal")} {...num} aria-describedby={errors?.energyKcal ? `${uid}-e-kcal` : undefined} />
            <FieldError id={`${uid}-e-kcal`} field="energyKcal" message={errors?.energyKcal} />
          </div>
        </div>
      </fieldset>
      {!mealId && (
      <details className="sheet" open={more || undefined}>
        <summary>More details (optional)</summary>
        <div className="sheet-body stack">
          <div className="field-grid">
            <div>
              <label htmlFor={`${uid}-c-carb`}>Carbohydrate (g)</label>
              <input id={`${uid}-c-carb`} name="carbG" defaultValue={v("carbG")} {...num} />
              <FieldError id={`${uid}-e-carb`} field="carbG" message={errors?.carbG} />
            </div>
            <div>
              <label htmlFor={`${uid}-c-fat`}>Fat (g)</label>
              <input id={`${uid}-c-fat`} name="fatG" defaultValue={v("fatG")} {...num} />
              <FieldError id={`${uid}-e-fat`} field="fatG" message={errors?.fatG} />
            </div>
            <div>
              <label htmlFor={`${uid}-c-fiber`}>Fiber (g)</label>
              <input id={`${uid}-c-fiber`} name="fiberG" defaultValue={v("fiberG")} {...num} />
              <FieldError id={`${uid}-e-fiber`} field="fiberG" message={errors?.fiberG} />
            </div>
            <div>
              <label htmlFor={`${uid}-c-grams`}>Weight of one serving (g)</label>
              <input id={`${uid}-c-grams`} name="servingGrams" defaultValue={v("servingGrams")} {...num} />
              <FieldError id={`${uid}-e-sgrams`} field="servingGrams" message={errors?.servingGrams} />
            </div>
            <div>
              <label htmlFor={`${uid}-c-serving`}>What one serving is</label>
              <input id={`${uid}-c-serving`} name="servingLabel" defaultValue={v("servingLabel")} type="text" maxLength={80} placeholder="For example: 1 bowl, 1 bar" />
            </div>
            <div>
              <label htmlFor={`${uid}-c-brand`}>Brand</label>
              <input id={`${uid}-c-brand`} name="brand" defaultValue={v("brand")} type="text" maxLength={120} />
            </div>
          </div>
        </div>
      </details>
      )}
      <WhereFrom value={v("context", "home")} />
      <MealAndDay mealSlot={v("mealSlot", mealSlot)} date={v("date", date)} errors={errors} />
      <p role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "sr-only"} style={{ margin: 0 }}>
        {state.message ?? ""}
      </p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add to diary"}
        </button>
        <Link className="link-btn" href={cancelHref}>
          Cancel
        </Link>
      </div>
      <p className="s13 muted" style={{ margin: 0 }}>
        {mealId
          ? "It is saved as your own private entry, with where its figures came from. Only you can see it."
          : "It is saved as one of your own foods so you can log it again. Only you can see it."}
      </p>
    </form>
  );
}
