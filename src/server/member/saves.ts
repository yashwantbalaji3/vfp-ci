import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import { savesSchema, type DietPreference, type Saves } from "@/contracts/catalog";

/**
 * Saves are private rows owned by the member (R-D05). Every query runs as the
 * member, so Row Level Security decides what is visible; nothing here uses a
 * privileged key.
 */
export type SaveTarget = { foodItemId: string } | { venueId: string };
const column = (t: SaveTarget) => ("foodItemId" in t ? { food_item_id: t.foodItemId } : { venue_id: t.venueId });

export async function isSaved(target: SaveTarget): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("saves").select("id").match(column(target)).limit(1);
  return Boolean(data?.length);
}

/** Saves the item, or removes the save if it already exists. Returns the new state. */
export async function toggleSave(memberId: string, target: SaveTarget): Promise<"saved" | "removed" | "failed"> {
  const supabase = await createSupabaseServerClient();
  const existing = await supabase.from("saves").select("id").match(column(target)).limit(1);
  if (existing.error) return "failed";
  if (existing.data.length) {
    const { error } = await supabase.from("saves").delete().eq("id", existing.data[0].id);
    return error ? "failed" : "removed";
  }
  const { error } = await supabase.from("saves").insert({ owner_id: memberId, ...column(target) });
  // 23505 = already saved from another tab: the outcome the person wanted.
  return error && error.code !== "23505" ? "failed" : "saved";
}

/** The member's saved list, each food marked with how it stands against the dietary filter in force. */
export async function listSaves(diet: DietPreference): Promise<Saves> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_saves", {
    p_include_demo: FLAGS.allowDemoContent,
    p_diet: diet.diet,
    p_exclusions: diet.exclusions,
  });
  if (error) throw new Error("SAVES_UNAVAILABLE");
  return savesSchema.parse(data);
}
