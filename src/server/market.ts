import "server-only";
import { cookies } from "next/headers";
import { marketFor, MARKETS, type MarketConfig } from "@/config/markets";
import { getCurrentMember } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The city a person chose (docs/83). For a visitor, a first-party cookie on this browser: it says which of the six
 * markets to show and nothing else, and is never sent anywhere. For a signed-in member, the choice is also saved with
 * their account (user_preferences.home_market, migration 20261124000500), private to them, so it follows them to
 * another browser; the account's choice wins when there is one. No choice means the default market (Boston). An
 * unknown value is ignored, never guessed from.
 */
export const MARKET_COOKIE = "market";

async function savedHomeMarket(): Promise<string | null> {
  if (!(await getCurrentMember())) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.from("user_preferences").select("home_market").maybeSingle();
    return (data?.home_market as string | null | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function readMarket(): Promise<MarketConfig> {
  const saved = await savedHomeMarket();
  if (saved && Object.hasOwn(MARKETS, saved)) return marketFor(saved);
  const store = await cookies();
  return marketFor(store.get(MARKET_COOKIE)?.value);
}

export async function writeMarket(slug: string): Promise<MarketConfig> {
  const m = marketFor(slug);
  const store = await cookies();
  store.set(MARKET_COOKIE, m.slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_APP_URL?.startsWith("http://localhost"),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  const member = await getCurrentMember();
  if (member) {
    const supabase = await createSupabaseServerClient();
    // The member's own row only (row rule). A member who has no preferences row yet keeps the choice on this
    // browser: creating the row here would read as "diet answered" and stop the one-time diet question.
    const { error } = await supabase.from("user_preferences").update({ home_market: m.slug }).eq("user_id", member.id);
    if (error) throw new Error("PREFERENCES_UNAVAILABLE");
  }
  return m;
}
