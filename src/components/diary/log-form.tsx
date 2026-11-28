"use client";
import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { logEntryAction, type FormState } from "@/app/diary/actions";
import type { LoggableFood } from "@/contracts/diary";
import { formatAmount } from "@/lib/format";
import { FieldError, MealAndDay, WhereFrom } from "./form-bits";

type Amount = { value: number; low: number | null; high: number | null; estimated: boolean };

/** Portion hint: an exact figure as it is; an estimate as "about", with its range. */
function proteinHint(a: Amount | null): string {
  if (a === null) return "protein not known";
  if (!a.estimated) return `${formatAmount(a.value)} g protein`;
  const range = a.low !== null && a.high !== null ? ` (estimate ${formatAmount(a.low)}–${formatAmount(a.high)} g)` : " (estimate)";
  return `about ${formatAmount(a.value)} g protein${range}`;
}

type Props = { food: LoggableFood; idempotencyKey: string; date: string; mealSlot: string; context: string; here: string; cancelHref: string };

/**
 * Portion picker for logging one food (R-F02). The preview only multiplies values
 * the source gives; when protein is not known for the food the preview says so,
 * and the entry can still be saved.
 */
export function LogForm({ food, idempotencyKey, date, mealSlot, context, here, cancelHref }: Props) {
  const [state, action, pending] = useActionState<FormState, FormData>(logEntryAction, { status: "idle" });
  const uid = useId();
  const first = food.portions[0]?.id ?? "grams";
  const [portionId, setPortionId] = useState(first);
  const [quantity, setQuantity] = useState("1");
  const [grams, setGrams] = useState("");
  const errors = state.fields;

  const portion = food.portions.find((p) => p.id === portionId);
  type Cell = LoggableFood["portions"][number]["nutrients"][string];
  /** The value, and an estimate's low and high ends, scaled by `factor`. Unknown stays null. */
  const scaled = (cell: Cell | undefined, factor: number): Amount | null =>
    cell && cell.value !== null && cell.value !== undefined && factor > 0
      ? {
          value: cell.value * factor,
          low: cell.lower !== null && cell.lower !== undefined ? cell.lower * factor : null,
          high: cell.upper !== null && cell.upper !== undefined ? cell.upper * factor : null,
          estimated: cell.method === "estimated",
        }
      : null;
  const preview = (code: string): Amount | null => {
    if (portionId === "grams") {
      const ref = food.portions.find((p) => p.grams && p.nutrients[code]?.value !== null && p.nutrients[code]?.value !== undefined);
      const g = Number(grams);
      return ref && ref.grams && g > 0 ? scaled(ref.nutrients[code], g / ref.grams) : null;
    }
    return scaled(portion?.nutrients[code], Number(quantity));
  };
  const protein = preview("protein_g");
  const kcal = preview("energy_kcal");

  return (
    <form action={action} className="stack" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="revisionId" value={food.revisionId} />
      <input type="hidden" name="foodItemId" value={food.foodItemId} />
      <input type="hidden" name="here" value={here} />

      <fieldset>
        <legend>How much did you have?</legend>
        {food.portions.map((p) => (
          <label key={p.id} className="check">
            <input type="radio" name="portionId" value={p.id} checked={portionId === p.id} onChange={() => setPortionId(p.id)} />
            <span>
              {p.label}
              <span className="hint">
                {[
                  p.grams !== null ? `${formatAmount(p.grams)} g` : null,
                  proteinHint(scaled(p.nutrients.protein_g, 1)),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </label>
        ))}
        {food.gramsSupported && (
          <label className="check">
            <input type="radio" name="portionId" value="grams" checked={portionId === "grams"} onChange={() => setPortionId("grams")} />
            <span>
              Enter a weight in grams
              <span className="hint">Use this if you weighed it.</span>
            </span>
          </label>
        )}
        {!food.gramsSupported && <p className="s14 muted" style={{ margin: 0 }}>There is no serving weight on file for this food, so it can&rsquo;t be logged in grams.</p>}
      </fieldset>

      {portionId === "grams" ? (
        <div>
          <label htmlFor={`${uid}-f-grams`}>Weight in grams</label>
          <input id={`${uid}-f-grams`} name="grams" type="number" inputMode="decimal" min="1" max="5000" step="any" value={grams} onChange={(e) => setGrams(e.target.value)} required aria-describedby={errors?.grams ? `${uid}-e-grams` : undefined} />
          <FieldError id={`${uid}-e-grams`} field="grams" message={errors?.grams} />
        </div>
      ) : (
        <div>
          <label htmlFor={`${uid}-f-qty`}>How many</label>
          <input id={`${uid}-f-qty`} name="quantity" type="number" inputMode="decimal" min="0.1" max="100" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required aria-describedby={errors?.quantity ? `${uid}-e-qty` : `${uid}-f-qty-hint`} />
          <p className="s14 muted" id={`${uid}-f-qty-hint`} style={{ margin: "4px 0 0" }}>
            For example 1, 0.5 or 2.
          </p>
          <FieldError id={`${uid}-e-qty`} field="quantity" message={errors?.quantity} />
        </div>
      )}

      <div className="panel" style={{ margin: 0 }} aria-live="polite" data-testid="log-preview">
        <div className="k s13 muted" style={{ fontWeight: 700 }}>
          This adds
        </div>
        {protein !== null ? (
          <>
            <span className="pro lg">
              {protein.estimated && <span className="per">about </span>}
              <span className="v">{formatAmount(protein.value)}</span> <span className="u">g protein</span>
              {protein.estimated && <span className="per"> estimated</span>}
            </span>
            {protein.estimated && (
              <p className="s14" style={{ margin: "4px 0 0" }} data-testid="log-preview-estimate">
                {protein.low !== null && protein.high !== null
                  ? `Estimate: between ${formatAmount(protein.low)} and ${formatAmount(protein.high)} g. `
                  : "Estimate. "}
                This is not a measured amount.
              </p>
            )}
          </>
        ) : (
          <span className="pro none">
            <span className="v">Protein not known for this amount</span>
          </span>
        )}
        <div className="s14 muted">{kcal !== null ? `${kcal.estimated ? "about " : ""}${formatAmount(kcal.value)} kcal${kcal.estimated ? " (estimated)" : ""}` : "Calories not known"}</div>
        {protein === null && <p className="s14" style={{ margin: "8px 0 0" }}>You can still log it. It will be listed without a protein value, not counted as zero.</p>}
      </div>

      <WhereFrom value={state.values?.context ?? context} />
      <MealAndDay mealSlot={state.values?.mealSlot ?? mealSlot} date={state.values?.date ?? date} errors={errors} />

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
    </form>
  );
}
