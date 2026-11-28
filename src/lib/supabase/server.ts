import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { publicEnv } from "@/config/env";
import { withSecureFlag } from "./cookie-options";

/**
 * Per-request Supabase client acting AS THE SIGNED-IN MEMBER, so Row Level
 * Security stays active. Never use the secret/service key for member requests.
 */
export async function createSupabaseServerClient() {
  // Member data is always request-time: never prerendered, never shared.
  await connection();
  const env = publicEnv();
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, withSecureFlag(options)));
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}
