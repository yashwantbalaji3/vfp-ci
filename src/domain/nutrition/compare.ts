import Decimal from "decimal.js";

/**
 * Protein per 100 kcal, only when both values are known on the same basis
 * and energy is positive (docs/07, R-P02).
 */
export function proteinPer100Kcal(
  protein: Decimal.Value | null,
  energyKcal: Decimal.Value | null,
): Decimal | null {
  if (protein === null || energyKcal === null) return null;
  const energy = new Decimal(energyKcal);
  if (energy.lte(0)) return null;
  return new Decimal(protein).times(100).div(energy);
}

/** Per-100-g comparison requires a mass basis or a sourced gram weight. */
export function per100g(
  value: Decimal.Value | null,
  basis: { kind: "mass" | "volume" | "serving"; amount: Decimal.Value },
  servingGrams: Decimal.Value | null,
): Decimal | null {
  if (value === null) return null;
  if (basis.kind === "mass") return new Decimal(value).times(100).div(basis.amount);
  if (basis.kind === "serving" && servingGrams !== null) {
    return new Decimal(value).times(100).div(new Decimal(servingGrams).times(basis.amount));
  }
  return null;
}
