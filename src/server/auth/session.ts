import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type CurrentMember = { id: string; email: string | null };

/**
 * Verified identity for server code. Uses getClaims(), which validates the JWT,
 * as Supabase recommends; getSession() is never trusted on the server.
 */
export async function getCurrentMember(): Promise<CurrentMember | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const claims = data.claims as { sub: string; email?: string };
  return { id: claims.sub, email: claims.email ?? null };
}
