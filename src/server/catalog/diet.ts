import "server-only";
import { cookies } from "next/headers";
import { dietPreferenceSchema, NO_DIET_PREFERENCE, type DietPreference } from "@/contracts/catalog";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/server/auth/session";

/**
 * The dietary filter is a choice the person made (R-D08). A guest's choice lives
 * in a first-party cookie. A signed-in member's choice is saved to their account,
 * so it follows them to any browser, and the account always wins over a cookie:
 * a choice made while signed out never replaces a saved one without the member
 * saying so. A missing or malformed value means "no filter chosen", never a guess.
 */
export const DIET_COOKIE = "diet_pref";

export function parseDietPreference(raw: unknown): DietPreference {
  if (raw === null || raw === undefined || raw === "") return NO_DIET_PREFERENCE;
  try {
    const parsed = dietPreferenceSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (!parsed.success) return NO_DIET_PREFERENCE;
    return { ...parsed.data, exclusions: [...new Set(parsed.data.exclusions)].sort() };
  } catch {
    return NO_DIET_PREFERENCE;
  }
}

export const sameDiet = (a: DietPreference, b: DietPreference) =>
  a.diet === b.diet && a.includeConditional === b.includeConditional && a.exclusions.join() === b.exclusions.join();
const isChosen = (p: DietPreference) => p.diet !== "none" || p.exclusions.length > 0;

/** This browser's own (signed-out) choice. */
export async function readGuestDiet(): Promise<DietPreference> {
  const store = await cookies();
  return parseDietPreference(store.get(DIET_COOKIE)?.value);
}

/** The member's saved choice, or null when they have never saved one (or nobody is signed in). */
export async function readSavedDiet(): Promise<DietPreference | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_diet");
  if (error || !data) return null;
  return parseDietPreference(data);
}

export async function readDietPreference(): Promise<DietPreference> {
  const guest = await readGuestDiet();
  const member = await getCurrentMember();
  if (!member) return guest;
  return (await readSavedDiet()) ?? guest;
}

/**
 * For the settings page: the choice in force, plus this browser's signed-out
 * choice when it differs from the member's saved one and so needs a decision.
 */
export async function readDietState(): Promise<{ current: DietPreference; signedIn: boolean; pendingGuestChoice: DietPreference | null }> {
  const guest = await readGuestDiet();
  const member = await getCurrentMember();
  if (!member) return { current: guest, signedIn: false, pendingGuestChoice: null };
  const saved = await readSavedDiet();
  if (!saved) return { current: guest, signedIn: true, pendingGuestChoice: null };
  return { current: saved, signedIn: true, pendingGuestChoice: isChosen(guest) && !sameDiet(guest, saved) ? guest : null };
}

async function writeGuestDiet(pref: DietPreference) {
  const store = await cookies();
  store.set(DIET_COOKIE, JSON.stringify(pref), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_APP_URL?.startsWith("http://localhost"),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearGuestDiet() {
  const store = await cookies();
  store.delete(DIET_COOKIE);
}

async function saveToAccount(pref: DietPreference): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_my_diet", {
    p_diet: pref.diet,
    p_exclusions: pref.exclusions,
    p_include_conditional: pref.includeConditional,
  });
  return !error;
}

/** Saves the choice where it belongs: the account for a member, the cookie for a guest. */
export async function writeDietPreference(pref: DietPreference) {
  const member = await getCurrentMember();
  if (member && (await saveToAccount(pref))) {
    await clearGuestDiet();
    return;
  }
  await writeGuestDiet(pref);
}

/**
 * Right after sign-in. A member who has never saved a filter keeps the one they
 * chose as a guest, so results don't quietly widen. A member who HAS a saved
 * filter keeps it; a different guest choice is left in place and offered to them
 * on the filter page instead of being applied.
 */
export async function adoptGuestDietOnSignIn() {
  const guest = await readGuestDiet();
  if (!isChosen(guest)) return;
  const saved = await readSavedDiet();
  if (saved === null) {
    if (await saveToAccount(guest)) await clearGuestDiet();
  } else if (sameDiet(saved, guest)) {
    await clearGuestDiet();
  }
}
