"use client";
import { useActionState, useId } from "react";
import Link from "next/link";
import { updateOwnFoodAction, type FormState } from "@/app/diary/actions";
import type { OwnFood } from "@/contracts/diary";
import { FieldError } from "./form-bits";

const num = { type: "number", inputMode: "decimal", min: "0", step: "any" } as const;
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/**
 * Change a food of one's own (docs/56). The boxes start with what is saved now. An empty box is saved as
 * "not known", never as zero. Saving makes a new version; diary entries keep what they were logged with.
 */
export function OwnFoodForm({ food }: { food: OwnFood }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateOwnFoodAction, { status: "idle" });
  const uid = useId();
  const errors = state.fields;
  const n = food.nutrients ?? {};
  const v = (name: string, saved: string) => state.values?.[name] ?? saved;
  const field = (name: string, label: string, saved: string, extra: Record<string, unknown> = num) => (
    <div>
      <label htmlFor={`${uid}-${name}`}>{label}</label>
      <input id={`${uid}-${name}`} name={name} defaultValue={v(name, saved)} {...extra} aria-describedby={errors?.[name] ? `${uid}-e-${name}` : undefined} />
      <FieldError id={`${uid}-e-${name}`} field={name} message={errors?.[name]} />
    </div>
  );
  return (
    <form action={action} className="stack" noValidate data-testid="own-food-form">
      <input type="hidden" name="foodItemId" value={food.foodItemId} />
      <input type="hidden" name="expectedRevisionId" value={food.revisionId} />
      {field("name", "Name", food.name, { type: "text", maxLength: 200, required: true, autoComplete: "off" })}
      <fieldset>
        <legend>Nutrition for one serving</legend>
        <p className="s14 muted" style={{ margin: "0 0 8px" }}>
          Leave a box empty if you don&rsquo;t know. Empty means &ldquo;not known&rdquo;, not zero.
        </p>
        <div className="field-grid">
          {field("proteinG", "Protein (g)", str(n.protein_g))}
          {field("energyKcal", "Calories (kcal)", str(n.energy_kcal))}
          {field("carbG", "Carbohydrate (g)", str(n.carb_g))}
          {field("fatG", "Fat (g)", str(n.fat_g))}
          {field("fiberG", "Fiber (g)", str(n.fiber_g))}
        </div>
      </fieldset>
      <div className="field-grid">
        {field("servingLabel", "What one serving is", food.serving?.label ?? "", { type: "text", maxLength: 80, placeholder: "For example: 1 bowl, 1 bar" })}
        {field("servingGrams", "Weight of one serving (g)", str(food.serving?.grams))}
        {field("brand", "Brand", food.brand ?? "", { type: "text", maxLength: 120 })}
      </div>
      <p role="status" aria-live="polite" className={state.status === "error" ? "field-error" : "sr-only"} style={{ margin: 0 }}>
        {state.message ?? ""}
      </p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <Link className="link-btn" href="/diary/foods">
          Cancel
        </Link>
      </div>
    </form>
  );
}
