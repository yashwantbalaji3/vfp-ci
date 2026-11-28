"use client";
import { useActionState } from "react";
import { submitCorrectionAction, type CorrectionState } from "@/app/actions/member";

const FOOD_FIELDS = [
  ["dietary", "Vegetarian or vegan status"],
  ["egg", "Egg"],
  ["dairy", "Dairy"],
  ["ingredients", "Ingredients"],
  ["allergen", "Allergens or cross-contact"],
  ["nutrition", "Nutrition numbers"],
  ["portion", "Portion size"],
  ["price", "Price"],
  ["name", "Name"],
  ["other", "Something else"],
] as const;
const VENUE_FIELDS = [
  ["hours", "Opening hours"],
  ["closed", "This place has closed"],
  ["name", "Name or address"],
  ["other", "Something else"],
] as const;

/** Field-level correction with optional evidence (R-D06). Sending it changes nothing publicly until a person reviews it. */
export function CorrectionForm({ foodItemId, venueId }: { foodItemId?: string; venueId?: string }) {
  const [state, action, pending] = useActionState<CorrectionState, FormData>(submitCorrectionAction, { status: "idle" });
  const fields = foodItemId ? FOOD_FIELDS : VENUE_FIELDS;
  if (state.status === "sent") {
    return (
      <p className="callout calm" role="status">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="stack" aria-label="Report a problem with this page">
      {foodItemId && <input type="hidden" name="foodItemId" value={foodItemId} />}
      {venueId && <input type="hidden" name="venueId" value={venueId} />}
      <div>
        <label htmlFor="corr-field">What is wrong?</label>
        <select id="corr-field" name="field" defaultValue={fields[0][0]}>
          {fields.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="corr-value">What should it say?</label>
        <textarea id="corr-value" name="proposedValue" required minLength={3} maxLength={1000} aria-describedby="corr-status" />
      </div>
      <div>
        <label htmlFor="corr-evidence">How do you know? (optional)</label>
        <input id="corr-evidence" name="evidenceNote" type="text" maxLength={1000} placeholder="For example: the menu on 12 Nov, or staff told me" />
      </div>
      <p id="corr-status" role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "muted s14"} style={{ margin: 0 }}>
        {state.message ?? "A person reviews every correction. Nothing changes automatically."}
      </p>
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send correction"}
      </button>
    </form>
  );
}
