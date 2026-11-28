import Link from "next/link";
import { Fresh } from "@/components/freshness";
import type { DietPreference } from "@/contracts/catalog";
import { CUISINE_LABELS, type Cuisine, type RecipeCard as Card } from "@/contracts/recipes";
import { MEAL_LABELS, type MealSlot } from "@/contracts/diary";
import { displayName, formatMinutes, totalMinutes } from "@/domain/recipes/quantity";
import { formatAmount } from "@/lib/format";
import { FoodIllustration } from "@/components/food-illustration";
import { DietaryConfidence, EvidenceBadge } from "@/components/labels";

/** One recipe in the library: picture, name, time, protein with its evidence, dietary confidence. */
export function RecipeCard({ recipe, diet }: { recipe: Card; diet: DietPreference }) {
  const minutes = totalMinutes(recipe.prepMinutes, recipe.cookMinutes);
  const meta = [
    minutes !== null && minutes > 0 ? formatMinutes(minutes) : null,
    recipe.cuisine ? (CUISINE_LABELS[recipe.cuisine as Cuisine] ?? null) : null,
    recipe.mealTypes.map((m) => MEAL_LABELS[m as MealSlot] ?? m).join(" or ") || null,
  ].filter(Boolean);
  return (
    <li className="card" data-testid="recipe-card">
      <FoodIllustration name={recipe.name} />
      <div className="body">
        <h3>
          <Link href={`/cook/${recipe.foodItemId}`}>{displayName(recipe.name)}</Link>
        </h3>
        <p className="meta" style={{ margin: 0 }}>
          {meta.join(" · ")}
        </p>
        <div className="foot">
          {recipe.proteinG === null ? (
            <span className="pro none" data-testid="protein-figure">
              <span className="v">Protein not known</span>
            </span>
          ) : (
            <>
              <span className="pro" data-testid="protein-figure">
                <span className="v">{formatAmount(recipe.proteinG)}</span> <span className="u">g protein</span> <span className="per">per serving</span>
              </span>
              <EvidenceBadge method={recipe.proteinMethod} known />
            </>
          )}
        </div>
        <div className="foot">
          <DietaryConfidence eligibility={recipe.eligibility} choice={diet} />
          {recipe.isDemo && <span className="s13 muted">Demo recipe</span>}
          <Fresh food={recipe.foodItemId} />
        </div>
      </div>
    </li>
  );
}
