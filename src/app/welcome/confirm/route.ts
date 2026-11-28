import { NextResponse, type NextRequest } from "next/server";
import { LEGAL_VERSION } from "@/content/legal";
import { safeReturnPath } from "@/lib/format";
import { withSecureFlag } from "@/lib/supabase/cookie-options";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/server/auth/session";
import { ELIGIBILITY_COOKIE, eligibilityCookieValue } from "@/server/eligibility";

/**
 * "Before you start" (adults-only beta, migration 20261126000200): the member confirms they are 18 or older and
 * agrees to the Terms and Privacy version the page showed. A plain form post with a 303 redirect, so the member then
 * gets a full fresh page load of where they were going.
 */
export async function POST(request: NextRequest) {
  const back = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.url), { status: 303 });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  };
  // Same-site posts only (a page elsewhere cannot answer for the member).
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.nextUrl.host) return new NextResponse("Forbidden", { status: 403 });
  const form = await request.formData();
  const next = safeReturnPath(form.get("next") as string | null, "/today");
  const again = (e: string) => back(`/welcome?next=${encodeURIComponent(next)}&e=${e}`);
  const member = await getCurrentMember();
  if (!member) return back(`/login?next=${encodeURIComponent(next)}`);
  if (form.get("adult") !== "yes" || form.get("agree") !== "yes") return again("both");
  // The version agreed is the one the page showed, so a policy change between showing and sending asks again.
  const version = String(form.get("version") ?? "");
  if (version !== LEGAL_VERSION) return again("changed");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("confirm_beta_eligibility", { p_adult: true, p_version: version });
  if (error) return again("failed");
  const res = back(next);
  res.cookies.set(ELIGIBILITY_COOKIE, eligibilityCookieValue(member.id), withSecureFlag({ httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 365 }));
  return res;
}
