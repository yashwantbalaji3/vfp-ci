import type { SupabaseClient } from "@supabase/supabase-js";
import { LEGAL_VERSION } from "@/content/legal";

/**
 * Adults-only invited beta (owner decision 2, 26 Nov 2026; migration 20261126000200). A signed-in member uses the app
 * only after confirming they are 18 or older and agreeing to the current Terms and Privacy version. Used by the
 * sign-in callback and the request proxy, so it takes the caller's own session client (never a privileged key).
 */
export type Eligibility = { adultConfirmedAt: string | null; legalVersion: string | null; legalAcceptedAt: string | null };

/** The cookie that remembers, for this browser, that this member already confirmed this version. */
export const ELIGIBILITY_COOKIE = "vfp_ok";
export const eligibilityCookieValue = (userId: string) => `${userId}.${LEGAL_VERSION}`;

/** Paths a signed-in member may open before confirming: the page itself, sign-in and sign-out, the policies, and deletion. */
const OPEN_BEFORE_CONFIRMING = /^\/(welcome|login|auth|privacy|terms|account\/delete|account\/deleted|health|api|slow-down)(\/|$)/;
export const needsNoConfirmation = (path: string) => OPEN_BEFORE_CONFIRMING.test(path);

export const isConfirmed = (e: Eligibility | null) => !!e?.adultConfirmedAt && e.legalVersion === LEGAL_VERSION;

/** null when the check could not run: callers then let the request through, and the next request asks again. */
export async function readEligibility(supabase: SupabaseClient): Promise<Eligibility | null> {
  const { data, error } = await supabase.rpc("my_beta_eligibility");
  if (error || !data) return null;
  return data as Eligibility;
}
