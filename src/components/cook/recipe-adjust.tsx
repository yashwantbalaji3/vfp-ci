"use client";
import { useId, useRef } from "react";
import Form from "next/form";
import Link from "next/link";
import type { RecipeIngredient } from "@/contracts/recipes";
import { displayName, formatQuantity, formatServings, recipeHref } from "@/domain/recipes/quantity";

type Props = {
  recipeId: string;
  servings: number;
  yieldServings: number;
  swaps: Record<string, string>;
  groups: RecipeIngredient[];
  showUnsure: boolean;
  planId?: string;
};
const GROUP_WORDS: Record<string, string> = { protein: "Protein", cream: "Cream", fat: "Cooking fat", milk: "Milk", sweetener: "Sweetener", yogurt: "Yogurt", noodles: "Noodles" };
const groupWord = (g: string) => GROUP_WORDS[g] ?? displayName(g.replace(/_/g, " "));

/**
 * Servings and approved swaps. Every change loads the recipe again from the server,
 * which recalculates the amounts, the nutrition and the dietary result together. Nothing
 * is worked out in the browser. Works without JavaScript through the "Update recipe" button.
 */
export function RecipeAdjust({ recipeId, servings, yieldServings, swaps, groups, showUnsure, planId }: Props) {
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const step = (n: number) => Math.min(100, Math.max(1, Math.round(n)));
  const base = { yieldServings, swaps, unsure: showUnsure, plan: planId };
  const hiddenUnsure = groups.reduce((n, g) => n + g.alternatives.filter((a) => a.status === "needs_confirmation" && !a.selected).length, 0);
  const hiddenExcluded = groups.reduce((n, g) => n + g.alternatives.filter((a) => a.status === "excluded" && !a.selected).length, 0);

  return (
    <Form action={`/cook/${recipeId}`} ref={form} scroll={false} className="adjust" data-testid="recipe-adjust">
      {planId && <input type="hidden" name="plan" value={planId} />}
      <div className="servings">
        <label htmlFor={`${uid}-servings`}>Servings</label>
        <div className="stepper">
          <Link
            className="btn"
            href={recipeHref(recipeId, { ...base, servings: step(servings - 1) })}
            scroll={false}
            aria-label={`Fewer servings: ${formatServings(step(servings - 1))}`}
            aria-disabled={servings <= 1 ? "true" : undefined}
            data-testid="servings-less"
          >
            −
          </Link>
          <input
            id={`${uid}-servings`}
            name="servings"
            type="number"
            inputMode="decimal"
            min={0.25}
            max={100}
            step="any"
            key={servings}
            defaultValue={servings}
            onBlur={(e) => {
              if (Number(e.currentTarget.value) !== servings) submit();
            }}
          />
          <Link
            className="btn"
            href={recipeHref(recipeId, { ...base, servings: step(servings + 1) })}
            scroll={false}
            aria-label={`More servings: ${formatServings(step(servings + 1))}`}
            aria-disabled={servings >= 100 ? "true" : undefined}
            data-testid="servings-more"
          >
            +
          </Link>
        </div>
        {servings !== yieldServings && (
          <p className="s13 muted" style={{ margin: "6px 0 0" }}>
            Written for {formatServings(yieldServings)}. Cooking times are not changed automatically, so check as you go.
          </p>
        )}
      </div>

      {groups.map((g) => {
        const options = g.alternatives.filter((a) => a.selected || a.status === "eligible" || a.status === "conditional" || (showUnsure && a.status === "needs_confirmation"));
        const chosen = g.alternatives.find((a) => a.selected);
        return (
          <div key={g.group} className="swap">
            <label htmlFor={`${uid}-${g.group}`}>{groupWord(g.group as string)}</label>
            <select id={`${uid}-${g.group}`} name={`swap_${g.group}`} key={chosen?.id} defaultValue={chosen?.id} onChange={submit}>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {displayName(a.name)} ({formatQuantity(a.quantity, a.unit)})
                  {a.isDefault ? " · as written" : ""}
                  {a.status === "needs_confirmation" ? " · needs confirmation" : a.status === "excluded" ? " · not suitable for your filter" : ""}
                </option>
              ))}
            </select>
            {chosen && !chosen.isDefault && chosen.note && (
              <p className="s13 muted" style={{ margin: "6px 0 0" }} data-testid="swap-note">
                {chosen.note}
              </p>
            )}
          </div>
        );
      })}

      {(hiddenUnsure > 0 || showUnsure) && (
        <label className="check">
          <input type="checkbox" name="unsure" value="1" defaultChecked={showUnsure} onChange={submit} />
          <span>
            Show swaps that need confirmation
            <span className="hint">Off by default. These are options we could not confirm for your dietary filter.</span>
          </span>
        </label>
      )}
      {hiddenExcluded > 0 && (
        <p className="s13 muted" style={{ margin: 0 }} data-testid="swaps-hidden">
          {hiddenExcluded} {hiddenExcluded === 1 ? "swap is" : "swaps are"} not offered because {hiddenExcluded === 1 ? "it contains" : "they contain"} something your dietary filter leaves out.
        </p>
      )}
      <button className="btn" type="submit">
        Update recipe
      </button>
    </Form>
  );
}
