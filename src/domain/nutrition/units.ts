import Decimal from "decimal.js";

/**
 * Exact unit definitions only (docs/07). "cup", "piece" and "bowl" are not
 * units: they need a defined portion mapping. A US fluid ounce is volume.
 */
const GRAMS_PER_UNIT: Record<string, string> = {
  g: "1",
  kg: "1000",
  mg: "0.001",
  oz: "28.349523125",
  lb: "453.59237",
};

const ML_PER_UNIT: Record<string, string> = {
  ml: "1",
  l: "1000",
  fl_oz: "29.5735295625",
};

export function toGrams(amount: Decimal.Value, unit: string): Decimal | null {
  const factor = GRAMS_PER_UNIT[unit.toLowerCase()];
  return factor === undefined ? null : new Decimal(amount).times(factor);
}

export function toMilliliters(amount: Decimal.Value, unit: string): Decimal | null {
  const factor = ML_PER_UNIT[unit.toLowerCase()];
  return factor === undefined ? null : new Decimal(amount).times(factor);
}

export function isMassUnit(unit: string): boolean {
  return unit.toLowerCase() in GRAMS_PER_UNIT;
}
