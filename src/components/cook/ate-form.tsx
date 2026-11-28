"use client";
import { useActionState, useId, useState } from "react";
import { declineLogAction, logCookAction, type CookFormState } from "@/app/cook/actions";
import { formatServings } from "@/domain/recipes/quantity";
import { formatAmount } from "@/lib/format";
import { FieldError, MealAndDay } from "@/components/diary/form-bits";

type Props = {
  sessionId: string;
  idempotencyKey: string;
  date: string;
  mealSlot: string;
  left: number;
  proteinPerServing: number | null;
  kcalPerServing: number | null;
  additional: boolean;
  showNotNow: boolean;
};
const CHOICES = [0.5, 1, 1.5, 2];

/**
 * "How much did you eat?" Asked once, after cooking, with "Not now" always beside it.
 * Only pressing "Add to my diary" writes anything, and only the amount chosen here.
 */
export function AteForm({ sessionId, idempotencyKey, date, mealSlot, left, proteinPerServing, kcalPerServing, additional, showNotNow }: Props) {
  const [state, action, pending] = useActionState<CookFormState, FormData>(logCookAction, { status: "idle" });
  const uid = useId();
  const options = CHOICES.filter((c) => c <= left + 0.0001);
  const v = state.values ?? {};
  const [choice, setChoice] = useState(v.servingsChoice ?? (options.includes(1) ? "1" : "other"));
  const [other, setOther] = useState(v.servingsOther ?? "");
  const amount = choice === "other" ? Number(other) : Number(choice);
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <>
      <form action={action} className="stack" noValidate data-testid="ate-form">
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        {additional && <input type="hidden" name="additional" value="1" />}
        <fieldset aria-describedby={state.fields?.servings ? `${uid}-err` : undefined}>
          <legend>{additional ? "How much more did you eat?" : "How much did you eat?"}</legend>
          {options.map((c) => (
            <label key={c} className="check">
              <input type="radio" name="servingsChoice" value={String(c)} checked={choice === String(c)} onChange={() => setChoice(String(c))} />
              <span>{formatServings(c)}</span>
            </label>
          ))}
          <label className="check">
            <input type="radio" name="servingsChoice" value="other" checked={choice === "other"} onChange={() => setChoice("other")} />
            <span>A different amount</span>
          </label>
          {choice === "other" && (
            <div style={{ maxWidth: 220 }}>
              <label htmlFor={`${uid}-other`}>Servings</label>
              <input
                id={`${uid}-other`}
                name="servingsOther"
                type="number"
                inputMode="decimal"
                min={0.1}
                max={left}
                step="any"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                aria-describedby={state.fields?.servings ? `${uid}-err` : undefined}
              />
            </div>
          )}
          <FieldError id={`${uid}-err`} field="servings" message={state.fields?.servings} />
        </fieldset>
        <p className="s14" data-testid="ate-preview" aria-live="polite" style={{ margin: 0 }}>
          {valid
            ? proteinPerServing !== null
              ? `That is about ${formatAmount(proteinPerServing * amount)} g protein${kcalPerServing !== null ? ` and ${formatAmount(kcalPerServing * amount)} kcal` : ", calories not known"}, calculated from the ingredients you used.`
              : "Protein is not known for this recipe, so the entry will be saved without a protein figure. It is not counted as zero."
            : "Choose an amount to see what will be added."}
        </p>
        <MealAndDay mealSlot={v.mealSlot ?? mealSlot} date={v.date ?? date} errors={state.fields} />
        {state.status === "error" && !state.fields?.servings && (
          <p className="field-error" role="alert" data-testid="ate-error">
            {state.message}
          </p>
        )}
        <button className="btn primary big" type="submit" disabled={pending} data-testid="ate-submit">
          {pending ? "Adding…" : "Add to my diary"}
        </button>
      </form>
      {showNotNow && (
        <form action={declineLogAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <button className="btn big" type="submit" data-testid="not-now">
            Not now
          </button>
        </form>
      )}
    </>
  );
}
