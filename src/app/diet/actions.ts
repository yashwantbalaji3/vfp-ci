"use server";
import { redirect } from "next/navigation";
import { dietPreferenceSchema } from "@/contracts/catalog";
import { INGREDIENT_FAMILIES } from "@/domain/dietary/families";
import { safeReturnPath } from "@/lib/format";
import { clearGuestDiet, readGuestDiet, writeDietPreference } from "@/server/catalog/diet";

/** Saves the visitor's own dietary filter choice. Anything not on the known lists is dropped. */
export async function saveDietPreference(formData: FormData) {
  const known = new Set<string>(INGREDIENT_FAMILIES);
  const parsed = dietPreferenceSchema.safeParse({
    diet: formData.get("diet") ?? "none",
    exclusions: formData.getAll("exclusions").filter((v): v is string => typeof v === "string" && known.has(v)),
    includeConditional: formData.get("includeConditional") === "on",
  });
  await writeDietPreference(parsed.success ? parsed.data : { diet: "none", exclusions: [], includeConditional: false });
  redirect(safeReturnPath(formData.get("return") as string | null));
}

/**
 * A member signed in on a browser that had a different signed-out filter. They
 * decide: use that one for the account, or keep the account's. Nothing is
 * replaced until they press one of the two buttons.
 */
export async function resolveGuestDietChoice(formData: FormData) {
  if (formData.get("use") === "browser") await writeDietPreference(await readGuestDiet());
  else await clearGuestDiet();
  redirect(safeReturnPath(formData.get("return") as string | null));
}
