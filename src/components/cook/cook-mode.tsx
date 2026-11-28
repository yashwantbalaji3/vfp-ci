"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { finishCookAction, saveCookProgressAction } from "@/app/cook/actions";
import { formatServings, ingredientLine, spokenQuantity, timerWords } from "@/domain/recipes/quantity";
import { StepTimer } from "./step-timer";

type Ingredient = { id: string; name: string; quantity: number; unit: string; prepNote: string | null; optional: boolean; swappedIn: boolean };
type Step = { ordinal: number; title: string | null; instruction: string; timerSeconds: number | null };
type Props = {
  sessionId: string;
  recipeId: string;
  name: string;
  servings: number;
  ingredients: Ingredient[];
  equipment: string[];
  steps: Step[];
  initialStep: number;
  initialChecked: string[];
};

/**
 * Cook mode: one step at a time in large type, with Back and Next always in the same
 * place, an ingredient checklist and optional timers. Step 0 is "Get ready". Every
 * move is saved to the member's session, so closing the page and coming back, on this
 * device or another, resumes at the same step with the same boxes ticked.
 * Finishing only records that the cooking happened. It never logs food.
 */
export function CookMode({ sessionId, recipeId, name, servings, ingredients, equipment, steps, initialStep, initialChecked }: Props) {
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 0), steps.length));
  const [checked, setChecked] = useState<string[]>(initialChecked);
  const [saveFailed, setSaveFailed] = useState(false);
  const [showIngredients, setShowIngredients] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const total = steps.length;
  const current = step > 0 ? steps[step - 1] : null;

  const save = useCallback(
    (nextStep: number, nextChecked: string[]) => {
      saveCookProgressAction({ sessionId, currentStep: nextStep, checkedIngredients: nextChecked })
        .then((r) => setSaveFailed(!r.ok))
        .catch(() => setSaveFailed(true));
    },
    [sessionId],
  );

  // After Back or Next, move focus to the step heading so keyboard and screen-reader users land on the new step.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [step]);

  const go = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), total);
    moved.current = true;
    setStep(clamped);
    setShowIngredients(false);
    save(clamped, checked);
    window.scrollTo({ top: 0 });
  };
  const toggle = (id: string) => {
    const next = checked.includes(id) ? checked.filter((c) => c !== id) : [...checked, id];
    setChecked(next);
    save(step, next);
  };

  const list = (
    <ul className="checklist" data-testid="ingredient-checklist">
      {ingredients.map((i) => {
        const line = ingredientLine(i);
        return (
          <li key={i.id}>
            <label className="check">
              <input type="checkbox" checked={checked.includes(i.id)} onChange={() => toggle(i.id)} />
              <span>
                <span aria-label={spokenQuantity(line)}>{line}</span>
                {i.optional && <span className="hint">Optional</span>}
                {i.swappedIn && <span className="hint">Your swap</span>}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="cookmode" data-testid="cook-mode" data-step={step}>
      <header className="cook-top">
        <Link className="link-btn" href={`/cook/${recipeId}`} data-testid="cook-exit">
          Exit<span className="sr-only"> cooking. Your place is saved.</span>
        </Link>
        <p className="cook-name">{name}</p>
        <p className="cook-count" data-testid="cook-progress">
          {step === 0 ? "Get ready" : `Step ${step} of ${total}`}
        </p>
      </header>
      <div
        className="cook-bar"
        role="progressbar"
        aria-label="Cooking progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={step}
        aria-valuetext={step === 0 ? "Getting ready" : `Step ${step} of ${total}`}
      >
        <span style={{ width: `${(step / Math.max(total, 1)) * 100}%` }} />
      </div>

      <main className="cook-body" id="main">
        {step === 0 ? (
          <>
            <h1 className="cook-h" tabIndex={-1} ref={heading} data-testid="cook-heading">
              Get everything ready
            </h1>
            <p className="muted" style={{ marginTop: 0 }}>
              For {formatServings(servings)}. Tick things off as you gather them. This is only a checklist: nothing is saved to your diary.
            </p>
            {list}
            <h2 className="h-sub">You will need</h2>
            <p style={{ marginTop: 0 }}>{equipment.length ? equipment.join(", ") : "No special equipment."}</p>
          </>
        ) : (
          current && (
            <>
              <h1 className="cook-h" tabIndex={-1} ref={heading} data-testid="cook-heading">
                <span className="sr-only">
                  Step {step} of {total}:{" "}
                </span>
                {current.title ?? `Step ${step}`}
              </h1>
              <p className="cook-text" data-testid="cook-instruction">
                {current.instruction}
              </p>
              {current.timerSeconds ? (
                <StepTimer key={`${sessionId}-${step}`} storageKey={`cook-timer:${sessionId}:${step}`} seconds={current.timerSeconds} />
              ) : null}
              {current.timerSeconds ? (
                <p className="s13 muted">Timers are a guide of about {timerWords(current.timerSeconds)}. Trust what you see and smell in the pan.</p>
              ) : null}
              <div className="cook-ing">
                <button type="button" className="btn" aria-expanded={showIngredients} onClick={() => setShowIngredients((v) => !v)} data-testid="toggle-ingredients">
                  {showIngredients ? "Hide ingredients" : `Ingredients (${checked.length} of ${ingredients.length} ticked)`}
                </button>
                {showIngredients && list}
              </div>
            </>
          )
        )}
        <p className="s13 cook-save" role="status" aria-live="polite" data-testid="cook-save-status">
          {saveFailed ? "We couldn't save your place just now. Keep cooking: we'll try again on your next step." : ""}
        </p>
      </main>

      <nav className="cook-nav" aria-label="Steps">
        <button type="button" className="btn" onClick={() => go(step - 1)} disabled={step === 0} data-testid="cook-back">
          Back
        </button>
        {step < total ? (
          <button type="button" className="btn primary" onClick={() => go(step + 1)} data-testid="cook-next">
            {step === 0 ? "Start step 1" : "Next step"}
          </button>
        ) : (
          <form action={finishCookAction}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <button type="submit" className="btn primary" data-testid="cook-finish">
              Finish cooking
            </button>
          </form>
        )}
      </nav>
    </div>
  );
}
