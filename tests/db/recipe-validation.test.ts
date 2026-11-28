import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asMember, createTestUser, deleteTestUsers, pool } from "../helpers/db";

/**
 * Every real recipe, checked as a member would use it (owner direction 22 Nov 2026 06:25 UTC: "validate all 50
 * recipes, including nutrition provenance, dietary exclusions, substitutions, scaling, cooking mode and diary
 * integration"). Skips on a fresh test database without the real recipes. With RECIPE_REPORT set it also writes
 * one row per recipe to that file. Everything runs as a test member inside a rolled-back transaction.
 */
const TZ = "America/New_York";
const DAY = "2026-11-20";
const NUTRIENTS = ["energy_kcal", "protein_g", "carb_g", "fat_g", "fiber_g", "sodium_mg"];
type Nutrient = { value: number | null; method: string; missingReason: string | null; ingredientCount: number; missingIngredients: number };
type Alt = { id: string; name: string; status: string; selected: boolean; isDefault: boolean };
type Ingredient = { id: string; name: string; grams: number | null; quantity: number | null; group: string | null; included: boolean; optional: boolean; calculable: boolean; foodItemId: string | null; alternatives: Alt[] };
type Detail = {
  foodItemId: string;
  name: string;
  servings: number;
  yieldServings: number;
  scale: number;
  isDemo: boolean;
  steps: { ordinal: number; instruction: string }[];
  ingredients: Ingredient[];
  nutrients: Record<string, Nutrient>;
  suitability: { vegan: string; vegetarian: string };
  eligibility: { status: string; reasons: unknown[] };
  allergens: { contains: string[]; unconfirmed: string[] };
  source: { recipe: { sourceType: string; summary: string }; nutritionMethod: string; ingredientSources: { publisher: string; summary: string }[] };
  swapped: boolean;
};

let ids: string[] = [];
let member = "";
beforeAll(async () => {
  ids = (await pool.query("select id from public.food_items where kind = 'recipe' and not is_demo and status = 'published' order by id")).rows.map((r) => r.id);
  if (ids.length >= 50) member = await createTestUser("recipe-check");
});
afterAll(async () => {
  if (member) await deleteTestUsers([member]);
});

const detail = async (c: PoolClient, id: string, o: { servings?: number; swaps?: Record<string, string>; diet?: string; exclusions?: string[] } = {}) =>
  (
    await c.query("select public.recipe_detail($1, $2, $3, $4, $5, false, false) r", [
      id, o.servings ?? null, JSON.stringify(o.swaps ?? {}), o.diet ?? "none", o.exclusions ?? [],
    ])
  ).rows[0].r as Detail;

describe("the real recipes", () => {
  it("every one of the 50 works end to end: provenance, diet, swaps, scaling, cooking and the diary", async () => {
    if (ids.length < 50) return; // fresh test database: nothing to check
    const report: Record<string, unknown>[] = [];
    await asMember(member, async (c) => {
      for (const id of ids) {
        const r = await detail(c, id);
        const row: Record<string, unknown> = { id, name: r.name, problems: [] as string[] };
        const problem = (p: string) => (row.problems as string[]).push(p);

        // Written for this project, not demo, with steps a person can follow.
        if (r.isDemo) problem("marked demo");
        if (r.source.recipe.sourceType !== "original_recipe") problem(`source type ${r.source.recipe.sourceType}`);
        if (r.steps.length < 2) problem("fewer than 2 steps");
        if (r.steps.some((s) => !s.instruction?.trim())) problem("an empty step");
        if (!r.ingredients.some((i) => i.included)) problem("no ingredients");

        // Nutrition provenance: summed from USDA ingredients; unknown is null with a reason, never zero.
        if (r.source.nutritionMethod !== "ingredient_sum") problem(`nutrition method ${r.source.nutritionMethod}`);
        if (!r.source.ingredientSources.some((s) => s.publisher === "USDA FoodData Central")) problem("no USDA source named");
        for (const k of NUTRIENTS) {
          const n = r.nutrients[k];
          if (!n) problem(`no ${k}`);
          else if (n.value === null && !n.missingReason) problem(`${k} unknown without a reason`);
          else if (n.value !== null && n.missingIngredients > 0) problem(`${k} shown although ${n.missingIngredients} ingredients are missing`);
        }
        for (const i of r.ingredients.filter((x) => x.included && !x.optional)) if (!i.foodItemId) problem(`ingredient ${i.name} has no food`);
        row.protein = r.nutrients.protein_g?.value;
        row.proteinKnown = r.nutrients.protein_g?.value !== null;

        // Diet: a recipe stated vegan never fails the vegan check as written; the stated diet and a vegan member agree.
        row.vegan = r.suitability.vegan;
        row.vegetarian = r.suitability.vegetarian;
        // Vegetarian as written, or held for a stated label check (cheese rennet, tortilla lard), never "not vegetarian".
        const asVeg = await detail(c, id, { diet: "vegetarian" });
        const held = asVeg.eligibility.reasons as { code: string; modifications?: string }[];
        if (r.suitability.vegetarian === "needs_confirmation") {
          if (!held.length || held.some((h) => h.code !== "requires_modification" || !h.modifications)) problem("vegetarian held without a stated label check");
          row.vegetarianCheck = held.map((h) => h.modifications).join(" ");
        } else if (r.suitability.vegetarian !== "eligible") problem(`vegetarian ${r.suitability.vegetarian}`);
        const asVegan = await detail(c, id, { diet: "vegan" });
        if ((asVegan.eligibility.status === "eligible") !== (r.suitability.vegan === "eligible")) problem("vegan member check disagrees with the vegan statement");
        // An exclusion of what the recipe contains always removes it.
        const families = ((r as unknown as { families: string[] }).families ?? []).map((f) => f.toLowerCase());
        row.families = families;
        for (const fam of families.map((f) => (f === "eggs" ? "egg" : f))) {
          if (["egg", "dairy"].includes(fam)) {
            const ex = await detail(c, id, { diet: "vegetarian", exclusions: [fam] });
            if (ex.eligibility.status === "eligible") problem(`eligible for someone leaving out ${fam}, though it contains it`);
          }
        }

        // Swaps: each listed alternative recalculates, and its diet check is never more hopeful than the ingredient.
        const groups = r.ingredients.filter((i) => i.group && i.alternatives.length > 1);
        row.swapGroups = groups.length;
        for (const g of groups) {
          for (const alt of g.alternatives.filter((a) => !a.isDefault)) {
            const s = await detail(c, id, { swaps: { [g.group!]: alt.id } });
            if (!s.swapped) problem(`swap ${g.group} -> ${alt.name} not applied`);
            const p = s.nutrients.protein_g;
            if (p.value === 0) problem(`swap ${alt.name} gives zero protein`);
            if (p.value === null && !p.missingReason) problem(`swap ${alt.name} unknown without a reason`);
          }
        }

        // Scaling: twice the servings doubles each ingredient's weight and keeps the per-serving numbers.
        const double = await detail(c, id, { servings: r.yieldServings * 2 });
        if (Math.abs(double.scale - 2) > 1e-9) problem(`scale ${double.scale} for twice the servings`);
        for (const i of r.ingredients) {
          const j = double.ingredients.find((x) => x.id === i.id);
          if (i.grams !== null && j && Math.abs(Number(j.grams) - 2 * Number(i.grams)) > 0.01) problem(`${i.name} does not double`);
        }
        for (const k of NUTRIENTS) {
          const a = r.nutrients[k]?.value;
          const b = double.nutrients[k]?.value;
          if (a !== null && b !== null && Math.abs(Number(a) - Number(b)) > 0.01) problem(`${k} per serving changes when doubled`);
        }

        // Cooking mode to the diary: start, step through, finish, log one serving.
        const s = (
          await c.query("select public.start_cook_session($1, $2, null, '{}', $3, $4, null, false) r", [randomUUID(), id, DAY, TZ])
        ).rows[0].r as { sessionId: string };
        for (const step of r.steps) await c.query("select public.save_cook_progress($1, $2, '{}')", [s.sessionId, step.ordinal]);
        await c.query("select public.complete_cook_session($1, $2, $3)", [s.sessionId, DAY, TZ]);
        const log = (
          await c.query("select public.log_cook_session($1, $2, 1, 'dinner', $3, $4, false) r", [randomUUID(), s.sessionId, DAY, TZ])
        ).rows[0].r as { entryId: string };
        const day = (await c.query("select public.diary_day($1) r", [DAY])).rows[0].r as { entries: { entryId: string; name?: string; nutrients?: Record<string, { value: number | null }> }[] };
        const entry = day.entries.find((e) => e.entryId === log.entryId);
        if (!entry) problem("logged serving not in the diary");
        else {
          const got = (entry as unknown as { nutrients?: Record<string, { value: number | null } | number | null> }).nutrients?.protein_g;
          const gotValue = typeof got === "object" && got !== null ? got.value : got;
          const want = r.nutrients.protein_g.value;
          if (want === null ? gotValue !== null && gotValue !== undefined : Math.abs(Number(gotValue) - Number(want)) > 0.05)
            problem(`diary protein ${gotValue} vs recipe ${want}`);
        }
        row.cookedAndLogged = !!entry;
        report.push(row);
      }
    });
    if (process.env.RECIPE_REPORT) writeFileSync(process.env.RECIPE_REPORT, JSON.stringify({ at: new Date().toISOString(), recipes: report }, null, 2));
    const bad = report.filter((r) => (r.problems as string[]).length);
    expect(bad.map((r) => `${r.name}: ${(r.problems as string[]).join("; ")}`)).toEqual([]);
    expect(report).toHaveLength(ids.length);
  }, 300_000);
});
