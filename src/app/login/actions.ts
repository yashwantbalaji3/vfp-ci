"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { publicEnv } from "@/config/env";
import { safeReturnPath } from "@/lib/format";
import { withinActionLimit } from "@/server/rate-limit";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const schema = z.object({ email: z.email().max(254) });

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Two limits (docs/14 PH-01): one per visitor address, one per email address, so neither
  // one visitor nor many visitors can flood a person's inbox. The answer does not depend on
  // whether an account exists.
  const requestHeaders = await headers();
  const allowed =
    (await withinActionLimit(requestHeaders, "signInAddress")) &&
    (await withinActionLimit(requestHeaders, "signInEmail", parsed.data.email.trim().toLowerCase()));
  if (!allowed) {
    return { status: "error", message: "Too many sign-in links have been requested. Please wait ten minutes and try again." };
  }

  // After signing in, return to the page the person came from (same site only).
  const next = safeReturnPath(formData.get("next") as string | null, "/account");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  // Generic response either way: never reveal whether an account exists. When invite-only is enforced by the database
  // guard (migration 20261126000100, for a plan without the auth hook), the auth server reports the refusal as
  // "Database error saving new user"; that is a refused invite, not an outage, so it gets the same generic answer.
  const refusedByInviteGuard = /database error saving new user/i.test(error?.message ?? "");
  if (error && error.status && error.status >= 500 && !refusedByInviteGuard) {
    return { status: "error", message: "We couldn't send the link right now. Please try again." };
  }
  return { status: "sent", message: "If that address can sign in, a link is on its way. Check your email." };
}
