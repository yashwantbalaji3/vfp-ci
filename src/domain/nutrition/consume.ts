import Decimal from "decimal.js";
import type { Basis, MissingReason, NutrientCode, NutrientValue, Portion } from "./types";
import { toGrams } from "./units";

/**
 * Pure mirror of the database's app.compute_consumption() (docs/07 formulas).
 * The database is authoritative for stored snapshots; this module powers
 * previews and is tested against the same golden fixtures.
 */
export type ConsumptionInput =
  | { kind: "portion"; portion: Portion; multiplier: Decimal.Value }
  | { kind: "grams"; grams: Decimal.Value };

export type ConsumedNutrient = {
  value: Decimal | null;
  method: NutrientValue["method"];
  missingReason: MissingReason | null;
};

export type ConsumptionResult = {
  /** Consumed amount divided by the basis amount; null when no defensible conversion exists. */
  factor: Decimal | null;
  resolvedMassG: Decimal | null;
  nutrients: Partial<Record<NutrientCode, ConsumedNutrient>>;
};

export class ConversionError extends Error {
  constructor(public readonly code: "INVALID_AMOUNT" | "UNSUPPORTED_MASS_CONVERSION") {
    super(code);
    this.name = "ConversionError";
  }
}

const MAX_MULTIPLIER = new Decimal(100);
const MAX_GRAMS = new Decimal(100000);

function servingWeightGrams(servingPortions: Portion[]): Decimal | null {
  const weighted = servingPortions.find((p) => p.unit === "serving" && p.grams !== null);
  return weighted ? new Decimal(weighted.grams!).div(weighted.amount) : null;
}

export function consume(
  basis: Basis,
  nutrients: Partial<Record<NutrientCode, NutrientValue>>,
  input: ConsumptionInput,
  servingPortions: Portion[] = [],
): ConsumptionResult {
  const basisAmount = new Decimal(basis.amount);
  let factor: Decimal | null = null;
  let mass: Decimal | null = null;

  if (input.kind === "grams") {
    const grams = new Decimal(input.grams);
    if (!grams.isFinite() || grams.lte(0) || grams.gt(MAX_GRAMS)) throw new ConversionError("INVALID_AMOUNT");
    mass = grams;
    if (basis.kind === "mass") {
      factor = grams.div(basisAmount);
    } else if (basis.kind === "serving") {
      const perServing = servingWeightGrams(servingPortions);
      if (!perServing) throw new ConversionError("UNSUPPORTED_MASS_CONVERSION");
      factor = grams.div(perServing).div(basisAmount);
    } else {
      throw new ConversionError("UNSUPPORTED_MASS_CONVERSION");
    }
  } else {
    const multiplier = new Decimal(input.multiplier);
    if (!multiplier.isFinite() || multiplier.lte(0) || multiplier.gt(MAX_MULTIPLIER)) {
      throw new ConversionError("INVALID_AMOUNT");
    }
    const p = input.portion;
    const portionGrams = p.grams !== null ? new Decimal(p.grams) : toGrams(p.amount, p.unit);
    mass = portionGrams ? portionGrams.times(multiplier) : null;
    if (basis.kind === "mass") {
      factor = mass ? mass.div(basisAmount) : null;
    } else if (basis.kind === "serving") {
      if (p.unit === "serving") {
        factor = new Decimal(p.amount).times(multiplier).div(basisAmount);
      } else {
        const perServing = servingWeightGrams(servingPortions);
        factor = mass && perServing ? mass.div(perServing).div(basisAmount) : null;
      }
    } else {
      // Volume basis needs a volume portion; handled by the database adapter.
      factor = null;
    }
    if (mass && mass.gt(MAX_GRAMS)) throw new ConversionError("INVALID_AMOUNT");
  }

  const out: ConsumptionResult["nutrients"] = {};
  for (const [code, nv] of Object.entries(nutrients) as [NutrientCode, NutrientValue][]) {
    if (nv.value === null) {
      out[code] = { value: null, method: nv.method, missingReason: nv.missingReason };
    } else if (factor === null) {
      out[code] = { value: null, method: nv.method, missingReason: "unavailable_conversion" };
    } else {
      out[code] = { value: new Decimal(nv.value).times(factor), method: nv.method, missingReason: null };
    }
  }
  return { factor, resolvedMassG: mass, nutrients: out };
}
