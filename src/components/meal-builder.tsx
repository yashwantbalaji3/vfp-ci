import { DIET_SHORT, DIET_WORDS, type PreviewDiet } from "@/contracts/menu-preview";
import { PART_GROUPS, PART_GROUP_WORDS, combine, needWords, ruleWords, type Builder, type Part, type PartGroup, type Selection } from "@/contracts/meal-builder";
import type { MenuPlace } from "@/contracts/menu-review";
import { combinationFit, mealFit } from "@/contracts/meal-eligibility";
import { hasDietChoice, type DietChoice } from "@/domain/dietary/labels";
import { FitChip, day, fmt } from "./menu-preview";

/**
 * A build-your-own meal (docs/60): its parts with the restaurant's own per-item figures, and a total for the
 * parts the founder picks. The form works without JavaScript: picking and pressing "Show total" reloads the
 * page with the choice in its address, so a combination can be bookmarked and revisited.
 */
const TONE: Record<PreviewDiet, string> = { vegan_stated: "vegan", vegetarian_stated: "veg", unknown: "unknown", not_vegetarian: "meat" };
function Diet({ d, meat }: { d: PreviewDiet; meat: boolean }) {
  const diet = meat ? "not_vegetarian" : d;
  return (
    <span className={`dchip ${TONE[diet]}`} title={meat ? "Its name names meat" : DIET_WORDS[diet]}>
      {meat ? "Meat" : DIET_SHORT[diet]}
    </span>
  );
}

function Option({ p, group, checked, choice }: { p: Part; group: PartGroup; checked: boolean; choice: DietChoice }) {
  const name = group === "topping_sauce" ? "top" : group;
  return (
    <label className="opt" data-testid="builder-option" data-group={group}>
      <input type={group === "topping_sauce" ? "checkbox" : "radio"} name={name} value={p.dishId} defaultChecked={checked} />
      <span className="name">
        {p.label}
        {p.portion ? <span className="muted s13"> · {p.portion}</span> : null}
      </span>
      <Diet d={p.diet} meat={p.namesMeat} />
      {hasDietChoice(choice) && mealFit(p.evidence, choice).status !== "eligible" && <FitChip fit={mealFit(p.evidence, choice)} />}
      <span className="g">{p.printed.protein === null ? <span className="muted s13">no printed figure</span> : `${fmt(p.printed.protein)} g`}</span>
    </label>
  );
}

const TOTAL_WORDS: Record<"none" | "subtotal" | "meal_total" | "unknown", string> = {
  none: "Nothing picked yet",
  subtotal: "Selected-items subtotal",
  meal_total: "Calculated meal total",
  unknown: "Meal total unknown",
};
export function BuilderView({ b, selection, here, from, sources, choice }: { b: Builder; selection: Selection; here: string; from?: string; sources: MenuPlace["sources"]; choice: DietChoice }) {
  const c = combine(b, selection);
  const fit = combinationFit(c.chosen, choice);
  const isChecked = (g: PartGroup, id: string) => (g === "topping_sauce" ? selection.toppings.includes(id) : selection[g] === id);
  const known = c.chosen.length > 0 && c.total.protein !== null;
  // The figures come from the parts' own source (a nutrition sheet), which may differ from the menu page.
  const partSource = b.parts.find((p) => p.sourceId)?.sourceId;
  const src = sources.find((s) => s.sourceId === partSource)?.url ?? b.sourceUrl ?? null;
  return (
    <section className="builder" aria-labelledby="builder-h" data-testid="meal-builder">
      <h2 id="builder-h" className="h-sec" style={{ marginTop: 0 }}>
        Build your own
      </h2>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        Each figure is the restaurant&rsquo;s own, for the portion it serves in this meal. Pick {needWords(b, PART_GROUPS.filter((g) => b.groups[g].length > 0 && b.rules[g].min > 0))}, add
        toppings, then press &ldquo;Show total&rdquo;.
      </p>
      <div className="total" role="status" aria-live="polite" data-testid="builder-total" data-known={known ? "yes" : "no"} data-kind={c.totalKind}>
        <p className="s13" style={{ margin: "0 0 2px", fontWeight: 700 }} data-testid="builder-total-kind">
          {TOTAL_WORDS[c.totalKind]} <span className="dchip est">Added up by us, not printed by the restaurant</span>
        </p>
        {c.totalKind === "subtotal" && (
          <p className="s13" style={{ margin: "0 0 2px" }} data-testid="builder-missing">
            <strong>Not a whole meal yet:</strong> pick {needWords(b, c.needs)}.
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
          <span className="pro lg">
            <span className="v">{known ? fmt(c.total.protein!) : "?"}</span>
            <span className="u">g protein</span>
          </span>
          {known && c.total.kcal !== null && <span className="s14">{fmt(c.total.kcal)} kcal</span>}
          {c.chosen.length > 0 && <Diet d={c.diet} meat={false} />}
          {c.chosen.length > 0 && <FitChip fit={fit} />}
        </div>
        {c.chosen.length > 0 && hasDietChoice(choice) && fit.status !== "eligible" && (
          <ul className="s13" style={{ margin: "4px 0 0", paddingLeft: 18 }} data-testid="builder-fit-reasons">
            {fit.reasons.map((r) => (
              <li key={r}>{r}.</li>
            ))}
          </ul>
        )}
        <p className="s13" style={{ margin: "4px 0 0" }} data-testid="builder-words">
          {c.words}

        </p>
        {known && (c.total.carb !== null || c.total.fat !== null || c.total.fiber !== null) && (
          <p className="s13 muted" style={{ margin: "2px 0 0" }}>
            {[c.total.carb !== null && `${fmt(c.total.carb)} g carbs`, c.total.fat !== null && `${fmt(c.total.fat)} g fat`, c.total.fiber !== null && `${fmt(c.total.fiber)} g fiber`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {c.chosen.length > 0 && (
          <details className="fold" data-testid="builder-breakdown" style={{ marginTop: 6 }}>
            <summary>How it adds up ({c.chosen.length} {c.chosen.length === 1 ? "item" : "items"})</summary>
            <table className="glance">
              <thead>
                <tr>
                  <th scope="col">Item and portion</th>
                  <th scope="col">Printed protein</th>
                </tr>
              </thead>
              <tbody>
                {c.chosen.map((p) => (
                  <tr key={p.dishId}>
                    <td>
                      {p.label}
                      {p.portion ? `, ${p.portion}` : ""}
                    </td>
                    <td>{p.printed.protein === null ? "Not printed for this portion" : `${fmt(p.printed.protein)} g`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="s13 muted" style={{ margin: "4px 0 0" }}>
              Each figure is the restaurant&rsquo;s own for the portion it serves in this meal. We add them up; we never scale a figure to another portion.
            </p>
          </details>
        )}
      </div>
      <form method="get" action={here}>
        {from && <input type="hidden" name="from" value={from} />}
        {PART_GROUPS.map((g) => {
          const parts = b.groups[g];
          if (!parts.length) return null;
          const plant = parts.filter((p) => !p.namesMeat);
          const meat = parts.filter((p) => p.namesMeat);
          return (
            <fieldset key={g} data-testid={`builder-${g}`}>
              <legend>
                {PART_GROUP_WORDS[g].title} <span className="muted s13">({ruleWords(b.rules[g])})</span>
              </legend>
              {b.rules[g].min === 0 && b.rules[g].max === 1 && (
                <label className="opt" data-testid="builder-option-none" data-group={g}>
                  <input type="radio" name={g} value="" defaultChecked={!selection[g as "base" | "wrap"]} />
                  <span className="name">No {PART_GROUP_WORDS[g].title.toLowerCase()}</span>
                </label>
              )}
              {plant.map((p) => (
                <Option key={p.dishId} p={p} group={g} checked={isChecked(g, p.dishId)} choice={choice} />
              ))}
              {meat.length > 0 && (
                <details data-testid="builder-meat">
                  <summary className="s14" style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" }}>
                    {meat.length} meat {meat.length === 1 ? "choice" : "choices"} (not vegetarian)
                  </summary>
                  {meat.map((p) => (
                    <Option key={p.dishId} p={p} group={g} checked={isChecked(g, p.dishId)} choice={choice} />
                  ))}
                </details>
              )}
            </fieldset>
          );
        })}
        <button className="btn primary" type="submit" data-testid="builder-submit">
          Show total
        </button>
      </form>
      <p className="s13 muted">
        {src ? (
          <>
            From{" "}
            <a href={src} target="_blank" rel="noreferrer noopener">
              the restaurant&rsquo;s own nutrition information
            </a>
          </>
        ) : (
          "Source not recorded"
        )}
        {b.checkedOn ? `, read ${day(b.checkedOn)}` : ""}. Not yet checked by a person. A total is shown only when every chosen item has a printed protein
        figure; otherwise it stays unknown.
      </p>
    </section>
  );
}
