import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import {
  hoursStatusesSchema,
  openNowLeftOutSchema,
  venueHoursSchema,
  type HoursStatus,
  type OpenNowLeftOut,
  type VenueHours,
} from "@/contracts/hours";

/**
 * MAP-2 opening hours, read through the database functions that decide them. A failure
 * here never hides a page or a result: the hours line is simply absent, and nothing is
 * ever shown as open unless the database said so.
 */
export async function getHoursStatuses(venueIds: string[]): Promise<Record<string, HoursStatus>> {
  const ids = [...new Set(venueIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return {};
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("venue_hours_statuses", { p_venue_ids: ids, p_include_demo: FLAGS.allowDemoContent });
    if (error) return {};
    const parsed = hoursStatusesSchema.safeParse(data);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function getVenueHours(venueId: string): Promise<VenueHours | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("venue_hours", { p_venue_id: venueId, p_include_demo: FLAGS.allowDemoContent });
    if (error) return null;
    const parsed = venueHoursSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** With "Open now" on: how many places were left out because their hours need confirmation. */
export async function getOpenNowLeftOut(p: Record<string, unknown>): Promise<OpenNowLeftOut | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("open_now_left_out", { p });
    if (error) return null;
    const parsed = openNowLeftOutSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
